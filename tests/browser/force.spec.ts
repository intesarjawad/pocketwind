import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'vite';
import { CELL_TYPE_MASK, CellType, NO_Q, type VoxelGrid } from '../../src/geometry/voxel-grid';
import { dispatch2D } from '../../src/gpu/dispatch';
import type { ForceSample, SolverParams } from '../../src/lbm/gpu-solver';
import { DIRECTIONS } from '../../src/lbm/lattice';
import type { Layout } from '../../src/lbm/layout';
import { CpuSolver } from '../../src/lbm/reference/cpu-solver';

declare const gpuSolverModule: typeof import('../../src/lbm/gpu-solver');

const F32_EPSILON = 2 ** -23;
const RELATIVE_TOLERANCE = 1e-4;
const params: SolverParams = { tau0: 0.8, uIn: 0.06, les: false };
let solverCode = '';

test.beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../src/lbm/gpu-solver.ts', import.meta.url)),
        name: 'gpuSolverModule',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || !('output' in output)) throw new Error('Expected one solver bundle.');
  const entry = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Solver bundle has no entry chunk.');
  solverCode = entry.code;
});

function gridFromKinds(layout: Layout, kinds: Uint32Array): VoxelGrid {
  const { nx, ny, nz } = layout;
  const cells = nx * ny * nz;
  const geometry = new Uint32Array(2 * cells);
  geometry.set(kinds);
  geometry.fill(NO_Q, cells);
  const boundary: number[] = [];
  let solidCells = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    if (kinds[cell] === CellType.SOLID) solidCells += 1;
    if (kinds[cell] !== CellType.FLUID) continue;
    const x = cell % nx;
    const y = Math.floor(cell / nx) % ny;
    const z = Math.floor(cell / (nx * ny));
    let mask = 0;
    for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
      const source = ((x - cx + nx) % nx) + nx * (((y - cy + ny) % ny) + ny * ((z - cz + nz) % nz));
      const kind = (kinds[source] ?? 0) & CELL_TYPE_MASK;
      if (kind >= CellType.SOLID && kind <= CellType.FLOOR) mask |= 1 << (3 + i);
    }
    geometry[cell] = mask;
    if (mask !== 0) boundary.push(cell);
  }
  return {
    ...layout,
    geometry,
    boundaryCells: Uint32Array.from(boundary),
    solidCells,
    frontalCells: 0,
    blockage: 0,
    watertight: true,
    missedLinks: 0,
  };
}

function blobGrid(): VoxelGrid {
  const layout = { nx: 32, ny: 32, nz: 32 };
  const kinds = new Uint32Array(32 ** 3);
  let seed = 0x4a3b2c1d;
  for (let cell = 0; cell < kinds.length; cell += 1) {
    const x = cell % 32;
    const y = Math.floor(cell / 32) % 32;
    const z = Math.floor(cell / (32 * 32));
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (Math.hypot(x - 15.5, y - 15.5, z - 15.5) <= 5 + (seed / 2 ** 32) * 2)
      kinds[cell] = CellType.SOLID;
    if (x < 2 || x >= 30) kinds[cell] = CellType.EQ;
  }
  kinds[15 + 32 * (15 + 32 * 15)] = CellType.SUPPORT;
  kinds[16 + 32 * (15 + 32 * 15)] = CellType.FLOOR;
  return gridFromKinds(layout, kinds);
}

type PopulationPatch = { direction: number; cell: number; value: number };

async function gpuForces(
  page: Page,
  grid: VoxelGrid,
  checkpoints: number[],
  solverParams = params,
  patches: PopulationPatch[] = [],
) {
  await page.goto('./');
  await page.addScriptTag({ content: solverCode });
  return page.evaluate(
    async ({ grid, checkpoints, params, patches }) => {
      if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for force comparison.');
      const device = await adapter.requestDevice();
      const uncapturedErrors: string[] = [];
      device.addEventListener('uncapturederror', (event) =>
        uncapturedErrors.push(event.error.message),
      );
      const allocated: { destroy(): void }[] = [];
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      try {
        const gpuGrid = {
          ...grid,
          geometry: Uint32Array.from(grid.geometry),
          boundaryCells: Uint32Array.from(grid.boundaryCells),
        };
        const solver = await gpuSolverModule.GpuSolver.create(device, grid, gpuGrid, params);
        if ('kind' in solver) throw new Error(`Solver allocation failed: ${solver.message}`);
        allocated.push(solver);
        const cells = grid.nx * grid.ny * grid.nz;
        patches.forEach(({ direction, cell, value }) => {
          const group = direction < 7 ? 0 : direction < 13 ? 1 : 2;
          const localDirection = direction - (group === 0 ? 0 : group === 1 ? 7 : 13);
          device.queue.writeBuffer(
            solver.populationBuffers[group],
            4 * (localDirection * cells + cell),
            new Float32Array([value]),
          );
        });
        const noSample = await solver.readForce();
        const snapshots: ForceSample[] = [];
        const busy: boolean[] = [];
        const record = async (step: number) => {
          const encoder = device.createCommandEncoder();
          solver.step(encoder, step - solver.stepCount, false);
          solver.encodeForce(encoder);
          // An unread sample also reserves the slot before mapping begins.
          solver.encodeForce(encoder);
          device.queue.submit([encoder.finish()]);
          const pending = solver.readForce();
          const duplicate = solver.readForce();
          const skipped = device.createCommandEncoder();
          solver.step(skipped, 1, false);
          solver.encodeForce(skipped);
          device.queue.submit([skipped.finish()]);
          busy.push((await duplicate) === 'busy');
          const sample = await pending;
          if (sample === 'busy') throw new Error('Encoded force was unavailable.');
          snapshots.push(sample);
        };
        for (const step of checkpoints) await record(step);
        const resetEncoder = device.createCommandEncoder();
        solver.reset(resetEncoder);
        solver.encodeForce(resetEncoder);
        device.queue.submit([resetEncoder.finish()]);
        const reset = await solver.readForce();
        const allocationError = await device.popErrorScope();
        const validationError = await device.popErrorScope();
        return {
          noSample,
          snapshots,
          busy,
          reset,
          allocationError: allocationError?.message ?? null,
          validationError: validationError?.message ?? null,
          uncapturedErrors,
        };
      } finally {
        for (const resource of allocated) resource.destroy();
        device.destroy();
      }
    },
    {
      grid: {
        ...grid,
        geometry: Array.from(grid.geometry),
        boundaryCells: Array.from(grid.boundaryCells),
      },
      checkpoints,
      params: solverParams,
      patches,
    },
  );
}

function assertDiagnostics(result: Awaited<ReturnType<typeof gpuForces>>): void {
  expect(result.allocationError).toBeNull();
  expect(result.validationError).toBeNull();
  expect(result.uncapturedErrors).toEqual([]);
  expect(result.noSample).toBe('busy');
  expect(result.busy.every(Boolean)).toBe(true);
}

function assertForce(actual: ForceSample, expected: readonly number[], step: number): void {
  expect(actual.step).toBe(step);
  // Use one vector scale, floored at f32 resolution, rather than dividing by a near-zero component.
  const scale = Math.max(F32_EPSILON, ...expected.map(Math.abs));
  const values = [actual.fx, actual.fy, actual.fz];
  const error = Math.max(...values.map((value, i) => Math.abs(value - (expected[i] ?? NaN))));
  expect(error / scale, JSON.stringify({ actual, expected, scale, error })).toBeLessThan(
    RELATIVE_TOLERANCE,
  );
}

test('GPU body force agrees with the CPU reference on a seeded 32³ blob', async ({ page }) => {
  test.setTimeout(180_000);
  const grid = blobGrid();
  const cpu = new CpuSolver({
    layout: grid,
    tau0: params.tau0,
    les: params.les,
    flags: grid.geometry.subarray(0, 32 ** 3),
    equilibriumState: { rho: 1, velocity: [params.uIn, 0, 0] },
  });
  const checkpoints = [0, 1, 8, 16, 50, 100];
  let cpuStep = 0;
  const expected = checkpoints.map((step) => {
    while (cpuStep < step) {
      cpu.step();
      cpuStep += 1;
    }
    return cpu.momentumExchange();
  });
  const result = await gpuForces(page, grid, checkpoints);
  assertDiagnostics(result);
  expect(result.snapshots).toHaveLength(checkpoints.length);
  for (const [i, sample] of result.snapshots.entries()) {
    const reference = expected[i];
    const step = checkpoints[i];
    if (!reference || step === undefined) throw new Error('Missing force checkpoint.');
    assertForce(sample, reference, step);
  }
  expect(result.snapshots.at(-1)?.fx).toBeGreaterThan(0);
  if (result.reset === 'busy' || !expected[0]) throw new Error('Missing reset sample.');
  assertForce(result.reset, expected[0], 0);
});

test('70,000 synthetic boundary entries cover 2D rows, padded groups and the final reduction tail', async ({
  page,
}) => {
  const layout = { nx: 5, ny: 5, nz: 5 };
  const kinds = new Uint32Array(125);
  kinds[62] = CellType.SOLID; // (2, 2, 2)
  kinds[36] = CellType.SUPPORT; // Below (1, 2, 2)
  kinds[56] = CellType.FLOOR; // Beside (1, 2, 2)
  const grid = gridFromKinds(layout, kinds);
  // Repetition isolates dispatch indexing from geometry size. The last entry has a distinct axis.
  grid.boundaryCells = new Uint32Array(70000).fill(61);
  grid.boundaryCells[69999] = 57; // (2, 1, 2)
  expect(dispatch2D(70000, 64)).toEqual([256, 5]);
  const result = await gpuForces(page, grid, [0], { ...params, uIn: 0 }, [
    { direction: 1, cell: 61, value: 0.01 },
    { direction: 3, cell: 57, value: 0.02 },
    { direction: 4, cell: 61, value: 0.5 },
    { direction: 6, cell: 61, value: 0.25 },
  ]);
  assertDiagnostics(result);
  const actual = result.snapshots[0];
  if (!actual) throw new Error('Missing synthetic force sample.');
  // 2 g*_j per halfway link, averaged with the other state at rest; the rest weights carry the
  // reference pressure and are left out. Support and floor links contribute nothing.
  const expected = [69999 * 0.01, 0.02];
  for (const [i, value] of [actual.fx, actual.fy].entries()) {
    expect(
      Math.abs(value - (expected[i] ?? NaN)) / Math.max(F32_EPSILON, Math.abs(expected[i] ?? NaN)),
    ).toBeLessThan(RELATIVE_TOLERANCE);
  }
  // Negative zero is also a zero force.
  expect(Math.abs(actual.fz)).toBe(0);
});

test('an empty boundary produces zero force before stepping and after reset', async ({ page }) => {
  const grid = gridFromKinds({ nx: 4, ny: 4, nz: 4 }, new Uint32Array(64));
  const result = await gpuForces(page, grid, [0, 8]);
  assertDiagnostics(result);
  if (result.reset === 'busy') throw new Error('Missing reset sample.');
  for (const sample of [...result.snapshots, result.reset]) {
    expect([sample.fx, sample.fy, sample.fz].map(Math.abs)).toEqual([0, 0, 0]);
  }
});
