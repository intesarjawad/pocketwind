import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import type { Walls } from '../../src/app/settings';
import { CELL_TYPE_MASK, CellType, NO_Q, type VoxelGrid } from '../../src/geometry/voxel-grid';
import { DIRECTIONS, WEIGHTS } from '../../src/lbm/lattice';
import { CpuSolver } from '../../src/lbm/reference/cpu-solver';

declare const gpuSolverModule: typeof import('../../src/lbm/gpu-solver');
declare const GPUBufferUsage: { readonly COPY_DST: number; readonly MAP_READ: number };
declare const GPUMapMode: { readonly READ: number };

const layout = { nx: 32, ny: 32, nz: 32 };
const cells = layout.nx * layout.ny * layout.nz;
const params = { tau0: 0.8, uIn: 0.06, les: false };
const tolerance = 1e-5;
const f16Tolerance = 2e-3;
const checkpoints = [0, 1, 10, 50, 100];

async function solverBundle(): Promise<string> {
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
  return entry.code;
}

/** The f16 prelude stores populations multiplied by this factor to keep small values out of the subnormal range. */
const f16PopulationScale = 32768;

/** Decode the half-precision storage the f16 prelude writes. */
function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

// Seeded link fractions span short and long links, including the halfway value.
function linkFractions(geometry: Uint32Array, initialSeed: number): Uint32Array {
  let seed = initialSeed;
  const fractions: number[] = [];
  for (let cell = 0; cell < cells; cell += 1) {
    const flag = geometry[cell] ?? 0;
    if ((flag & CELL_TYPE_MASK) !== CellType.FLUID || flag >>> 3 === 0) continue;
    geometry[cells + cell] = fractions.length;
    for (let i = 1; i < DIRECTIONS.length; i += 1) {
      if ((flag & (1 << (3 + i))) === 0) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      fractions.push(fractions.length % 7 === 0 ? 0.5 : 0.05 + 0.95 * (seed / 2 ** 32));
    }
  }
  const packed = new Uint32Array(geometry.length + fractions.length);
  packed.set(geometry);
  new Float32Array(packed.buffer, geometry.byteLength).set(fractions);
  return packed;
}

function blobGrid(walls: Walls): VoxelGrid {
  const geometry = new Uint32Array(cells * 2);
  geometry.fill(NO_Q, cells);
  let seed = 0x4a3b2c1d;
  let solidCells = 0;
  const projection = new Set<number>();
  for (let cell = 0; cell < cells; cell += 1) {
    const x = cell % layout.nx;
    const y = Math.floor(cell / layout.nx) % layout.ny;
    const z = Math.floor(cell / (layout.nx * layout.ny));
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const radius = 5 + (seed / 2 ** 32) * 2;
    if (Math.hypot(x - 15.5, y - 15.5, z - 15.5) <= radius) {
      geometry[cell] = CellType.SOLID;
      solidCells += 1;
      projection.add(y + layout.ny * z);
    }
    if (x < 2 || x >= layout.nx - 2) {
      geometry[cell] = CellType.EQ;
    }
  }
  geometry[15 + layout.nx * (15 + layout.ny * 15)] = CellType.SUPPORT;
  geometry[16 + layout.nx * (15 + layout.ny * 15)] = CellType.FLOOR;
  const boundaryCells: number[] = [];
  for (let cell = 0; cell < cells; cell += 1) {
    if (geometry[cell] !== CellType.FLUID) continue;
    const mask = pullWallMask(geometry, cell);
    geometry[cell] = mask;
    if (mask !== 0) boundaryCells.push(cell);
  }
  return {
    ...layout,
    geometry: walls === 'bouzidi' ? linkFractions(geometry, 0x1b873593) : geometry,
    boundaryCells: Uint32Array.from(boundaryCells),
    solidCells,
    frontalCells: projection.size,
    blockage: projection.size / (layout.ny * layout.nz),
    watertight: true,
    missedLinks: 0,
  };
}

function pullWallMask(geometry: Uint32Array, cell: number): number {
  const x = cell % layout.nx;
  const y = Math.floor(cell / layout.nx) % layout.ny;
  const z = Math.floor(cell / (layout.nx * layout.ny));
  let mask = 0;
  for (const [direction, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const source =
      ((x - cx + layout.nx) % layout.nx) +
      layout.nx *
        (((y - cy + layout.ny) % layout.ny) + layout.ny * ((z - cz + layout.nz) % layout.nz));
    const kind = (geometry[source] ?? 0) & CELL_TYPE_MASK;
    if (kind >= CellType.SOLID && kind <= CellType.FLOOR) mask |= 1 << (3 + direction);
  }
  return mask;
}

// Packed readback avoids Playwright validating one protocol object per numeric value.
function unpackSnapshots(
  data: string,
  steps: readonly number[],
  cells: number,
  precision: 'f32' | 'f16',
) {
  const packed = Buffer.from(data, 'base64');
  const bytes = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
  const macroBytes = cells * 4 * Float32Array.BYTES_PER_ELEMENT;
  const populationBytes = cells * 19 * (precision === 'f16' ? 2 : 4);
  const snapshotBytes = macroBytes + populationBytes;
  return {
    snapshots: steps.map((step, index) => {
      const base = index * snapshotBytes;
      return {
        step,
        macro: Array.from(new Float32Array(bytes, base, cells * 4)),
        populations:
          precision === 'f16'
            ? Array.from(new Uint16Array(bytes, base + macroBytes, cells * 19))
            : Array.from(new Float32Array(bytes, base + macroBytes, cells * 19)),
      };
    }),
    unchangedMacro: Array.from(new Float32Array(bytes, steps.length * snapshotBytes)),
  };
}

type ErrorPeak = { index: number; cpu: number; gpu: number; magnitude: number; scale: number };

function errorPeak(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  start = 0,
  stride = 1,
): ErrorPeak {
  if (actual.length !== expected.length) throw new Error('Readback length differs from reference.');
  let peak: ErrorPeak = { index: start, cpu: 0, gpu: 0, magnitude: 0, scale: 0 };
  for (let index = start; index < expected.length; index += stride) {
    const cpu = expected[index] ?? NaN;
    const gpu = actual[index] ?? NaN;
    const magnitude = Number.isFinite(cpu) && Number.isFinite(gpu) ? Math.abs(gpu - cpu) : Infinity;
    peak.scale = Math.max(peak.scale, Math.abs(cpu));
    if (magnitude > peak.magnitude) peak = { index, cpu, gpu, magnitude, scale: peak.scale };
  }
  return peak;
}

// A reference peak below f32 resolution of unit density is zero to the GPU, so f64 rounding
// noise in a uniform field must not become the scale.
const F32_EPSILON = 2 ** -23;

function normalizedError(peak: ErrorPeak): number {
  return peak.magnitude / Math.max(peak.scale, F32_EPSILON);
}

function assertRestingWalls(
  snapshots: readonly { step: number; macro: number[]; populations: number[] }[],
  grid: VoxelGrid,
): void {
  for (const snapshot of snapshots) {
    let invalidMacro: { cell: number; values: number[] } | undefined;
    let largestPopulation = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const kind = (grid.geometry[cell] ?? 0) & CELL_TYPE_MASK;
      if (kind < CellType.SOLID || kind > CellType.FLOOR) continue;
      const values = snapshot.macro.slice(4 * cell, 4 * cell + 4);
      if (values.some((value, component) => value !== (component === 0 ? 1 : 0))) {
        invalidMacro = { cell, values };
      }
      for (let i = 0; i < 19; i += 1) {
        largestPopulation = Math.max(
          largestPopulation,
          Math.abs(snapshot.populations[i * cells + cell] ?? NaN),
        );
      }
    }
    expect(invalidMacro, `wall macros at step ${snapshot.step}`).toBeUndefined();
    // A GPU may store negative zero, which is still the rest state.
    expect(largestPopulation, `wall populations at step ${snapshot.step}`).toBe(0);
  }
}

function assertPeak(
  field: string,
  peak: ErrorPeak,
  cell: number,
  growth: string,
  direction?: number,
  limit = tolerance,
): void {
  const coordinates = [
    cell % layout.nx,
    Math.floor(cell / layout.nx) % layout.ny,
    Math.floor(cell / (layout.nx * layout.ny)),
  ];
  expect(
    normalizedError(peak),
    `${JSON.stringify({
      field,
      cell,
      coordinates,
      direction,
      ...peak,
      cpu: String(peak.cpu),
      gpu: String(peak.gpu),
      magnitude: String(peak.magnitude),
      normalizedError: String(normalizedError(peak)),
    })}\n${growth}`,
  ).toBeLessThan(limit);
}

// The LES row carries the wall function on every cell beside the blob.
const configurations = [
  { operator: 'trt', les: false, walls: 'bb' },
  { operator: 'trt', les: false, walls: 'bouzidi' },
  { operator: 'reg', les: true, walls: 'bb' },
] as const;

for (const { operator, les, walls } of configurations) {
  test(`f32 ${operator.toUpperCase()}${les ? ' with LES' : ''} and ${walls} walls matches the CPU reference from initialization through 100 steps on a seeded 32³ solid blob`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const code = await solverBundle();
    const grid = blobGrid(walls);
    const cpu = new CpuSolver({
      layout,
      tau0: params.tau0,
      operator,
      les,
      walls,
      flags: walls === 'bouzidi' ? grid.geometry : grid.geometry.subarray(0, cells),
      equilibriumState: { rho: 1, velocity: [params.uIn, 0, 0] },
    });
    let cpuSteps = 0;
    const expected = checkpoints.map((step) => {
      while (cpuSteps < step) {
        cpu.step();
        cpuSteps += 1;
      }
      const macro = new Float64Array(cells * 4);
      for (let cell = 0; cell < cells; cell += 1) {
        const state = cpu.macroscopic(cell);
        macro.set([state.rho - 1, ...state.velocity], cell * 4);
      }
      return { step, macro, populations: cpu.populations.slice() };
    });

    await page.goto('./');
    await page.addScriptTag({ content: code });
    const result = await page.evaluate(
      async ({ layout, grid, params, checkpoints }) => {
        if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter is available for solver comparison.');
        const device = await adapter.requestDevice();
        const uncapturedErrors: string[] = [];
        device.addEventListener('uncapturederror', (event) =>
          uncapturedErrors.push(event.error.message),
        );
        const gpuGrid = {
          ...grid,
          geometry: Uint32Array.from(grid.geometry),
          boundaryCells: Uint32Array.from(grid.boundaryCells),
        };
        const allocated: { destroy(): void }[] = [];
        device.pushErrorScope('validation');
        device.pushErrorScope('out-of-memory');
        try {
          const createSolver = async () => {
            const solver = await gpuSolverModule.GpuSolver.create(device, layout, gpuGrid, params);
            if ('kind' in solver) throw new Error(`Solver allocation failed: ${solver.message}`);
            allocated.push(solver);
            return solver;
          };
          const solver = await createSolver();
          const diagnosticSolver = await createSolver();
          const cellCount = layout.nx * layout.ny * layout.nz;
          const macroBytes = cellCount * 4 * Float32Array.BYTES_PER_ELEMENT;
          const populationBytes = cellCount * 19 * Float32Array.BYTES_PER_ELEMENT;
          const snapshotBytes = macroBytes + populationBytes;
          const preservedOffset = checkpoints.length * snapshotBytes;
          const readback = device.createBuffer({
            size: preservedOffset + macroBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          allocated.push(readback);
          const encoder = device.createCommandEncoder();
          const record = (state: import('../../src/lbm/gpu-solver').GpuSolver, index: number) => {
            const offset = index * snapshotBytes;
            encoder.copyBufferToBuffer(state.macroBuffer, 0, readback, offset, macroBytes);
            let populationOffset = offset + macroBytes;
            for (const population of state.populationBuffers) {
              encoder.copyBufferToBuffer(
                population,
                0,
                readback,
                populationOffset,
                population.size,
              );
              populationOffset += population.size;
            }
          };
          solver.step(encoder, 0, true);
          record(solver, 0);
          solver.step(encoder, 1, true);
          record(solver, 1);
          solver.step(encoder, 98, false);
          encoder.copyBufferToBuffer(solver.macroBuffer, 0, readback, preservedOffset, macroBytes);
          solver.step(encoder, 1, true);
          record(solver, checkpoints.length - 1);
          // A separate trajectory keeps the 98-step macro-preservation check intact.
          checkpoints.slice(2, -1).forEach((step, index) => {
            diagnosticSolver.step(encoder, step - diagnosticSolver.stepCount, true);
            record(diagnosticSolver, index + 2);
          });
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(readback.getMappedRange());
          const chunks: string[] = [];
          // Keep spread arguments below browser engine limits.
          const chunkBytes = 32 * 1024;
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes)));
          }
          const data = btoa(chunks.join(''));
          readback.unmap();
          const allocationError = await device.popErrorScope();
          const validationError = await device.popErrorScope();
          return {
            data,
            steps: solver.stepCount,
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
        layout,
        grid: {
          ...grid,
          geometry: Array.from(grid.geometry),
          boundaryCells: Array.from(grid.boundaryCells),
        },
        params: { ...params, operator, les, walls },
        checkpoints,
      },
    );

    expect(result.allocationError).toBeNull();
    expect(result.validationError).toBeNull();
    expect(result.uncapturedErrors).toEqual([]);
    expect(result.steps).toBe(100);
    const { snapshots, unchangedMacro } = unpackSnapshots(result.data, checkpoints, cells, 'f32');
    const comparisons = snapshots.map((snapshot, index) => {
      const reference = expected[index];
      if (reference?.step !== snapshot.step) throw new Error('Comparison checkpoints differ.');
      const shiftedMacro = snapshot.macro.map((value, index) =>
        index % 4 === 0 ? value - 1 : value,
      );
      const velocityPeaks = [1, 2, 3].map((component) =>
        errorPeak(shiftedMacro, reference.macro, component, 4),
      );
      const velocity = velocityPeaks.reduce((worst, peak) =>
        peak.magnitude > worst.magnitude ? peak : worst,
      );
      velocity.scale = Math.max(...velocityPeaks.map((peak) => peak.scale));
      return {
        step: snapshot.step,
        g: errorPeak(snapshot.populations, reference.populations),
        density: errorPeak(shiftedMacro, reference.macro, 0, 4),
        velocity,
      };
    });
    const growth = `normalized errors: ${comparisons
      .map(
        ({ step, g, density, velocity }) =>
          `${step}:g=${normalizedError(g).toExponential(3)},rho-1=${normalizedError(density).toExponential(3)},u=${normalizedError(velocity).toExponential(3)}`,
      )
      .join('; ')}`;
    const first = snapshots[1];
    if (!first) throw new Error('Missing step-one solver snapshot.');
    const preserved = errorPeak(unchangedMacro, first.macro);
    expect(
      preserved.magnitude,
      `${JSON.stringify({
        field: ['rho', 'ux', 'uy', 'uz'][preserved.index % 4],
        cell: Math.floor(preserved.index / 4),
        ...preserved,
        magnitude: String(preserved.magnitude),
      })}\n${growth}`,
    ).toBe(0);
    for (const comparison of comparisons) {
      const { step, g, density, velocity } = comparison;
      const context = `step ${step}\n${growth}`;
      assertPeak('g', g, g.index % cells, context, Math.floor(g.index / cells));
      assertPeak('rho - 1', density, Math.floor(density.index / 4), context);
      assertPeak(
        ['rho', 'ux', 'uy', 'uz'][velocity.index % 4] ?? 'u',
        velocity,
        Math.floor(velocity.index / 4),
        context,
      );
    }
    assertRestingWalls(snapshots, grid);
    expect(grid.boundaryCells.length).toBeGreaterThan(0);
    expect(grid.geometry.some((flag) => (flag & CELL_TYPE_MASK) === CellType.SOLID)).toBe(true);
  });
}

type StorageProbeInput = {
  layout: typeof layout;
  grid: Omit<VoxelGrid, 'geometry' | 'boundaryCells'> & {
    geometry: number[];
    boundaryCells: number[];
  };
  params: typeof params & { walls: 'bb'; precision: 'f32' | 'f16' };
  checkpoints: number[];
};

async function storageSnapshots({ layout, grid, params, checkpoints }: StorageProbeInput) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter?.features.has('shader-f16'))
    throw new Error('The adapter lost shader-f16 between checks.');
  const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
  const uncapturedErrors: string[] = [];
  device.addEventListener('uncapturederror', (event) => uncapturedErrors.push(event.error.message));
  const gpuGrid = {
    ...grid,
    geometry: Uint32Array.from(grid.geometry),
    boundaryCells: Uint32Array.from(grid.boundaryCells),
  };
  const allocated: { destroy(): void }[] = [];
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  try {
    const solver = await gpuSolverModule.GpuSolver.create(device, layout, gpuGrid, params);
    if ('kind' in solver) throw new Error(`Solver allocation failed: ${solver.message}`);
    allocated.push(solver);
    const cellCount = layout.nx * layout.ny * layout.nz;
    const macroBytes = cellCount * 4 * Float32Array.BYTES_PER_ELEMENT;
    const populationBytes = solver.populationBuffers.reduce(
      (total, buffer) => total + buffer.size,
      0,
    );
    const readback = device.createBuffer({
      size: checkpoints.length * (macroBytes + populationBytes),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    allocated.push(readback);
    const encoder = device.createCommandEncoder();
    const snapshotBytes = macroBytes + populationBytes;
    checkpoints.forEach((step, index) => {
      solver.step(encoder, step - solver.stepCount, true);
      const base = index * snapshotBytes;
      encoder.copyBufferToBuffer(solver.macroBuffer, 0, readback, base, macroBytes);
      let offset = base + macroBytes;
      for (const population of solver.populationBuffers) {
        encoder.copyBufferToBuffer(population, 0, readback, offset, population.size);
        offset += population.size;
      }
    });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0);
    readback.unmap();
    const chunks: string[] = [];
    const view = new Uint8Array(bytes);
    const chunkBytes = 32 * 1024;
    for (let offset = 0; offset < view.length; offset += chunkBytes) {
      chunks.push(String.fromCharCode(...view.subarray(offset, offset + chunkBytes)));
    }
    const data = btoa(chunks.join(''));
    const allocationError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
    return {
      data,
      populationBytes,
      steps: solver.stepCount,
      allocationError: allocationError?.message ?? null,
      validationError: validationError?.message ?? null,
      uncapturedErrors,
    };
  } finally {
    for (const resource of allocated) resource.destroy();
    device.destroy();
  }
}

for (const precision of ['f32', 'f16'] as const) {
  test(`f16 storage comparison (${precision}): TRT with bb walls stays within 2e-3 after 100 steps`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto('./#/validate');
    const advertised = await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter();
      return adapter?.features.has('shader-f16') ?? false;
    });
    if (!advertised) {
      test.skip(true, 'shader-f16 is unavailable.');
      return;
    }
    const code = await solverBundle();
    const grid = blobGrid('bb');
    const cpu = new CpuSolver({
      layout,
      tau0: params.tau0,
      les: params.les,
      walls: 'bb',
      flags: grid.geometry.subarray(0, cells),
      equilibriumState: { rho: 1, velocity: [params.uIn, 0, 0] },
    });
    let cpuSteps = 0;
    const expected = checkpoints.map((step) => {
      while (cpuSteps < step) {
        cpu.step();
        cpuSteps += 1;
      }
      const macro = new Float64Array(cells * 4);
      for (let cell = 0; cell < cells; cell += 1) {
        const state = cpu.macroscopic(cell);
        macro.set([state.rho - 1, ...state.velocity], cell * 4);
      }
      return { step, macro, populations: cpu.populations.slice() };
    });

    await page.addScriptTag({ content: code });
    const result = await page.evaluate(storageSnapshots, {
      layout,
      grid: {
        ...grid,
        geometry: Array.from(grid.geometry),
        boundaryCells: Array.from(grid.boundaryCells),
      },
      params: { ...params, walls: 'bb' as const, precision },
      checkpoints,
    });

    expect(result.allocationError).toBeNull();
    expect(result.validationError).toBeNull();
    expect(result.uncapturedErrors).toEqual([]);
    expect(result.steps).toBe(100);
    expect(result.populationBytes).toBe(cells * 19 * (precision === 'f16' ? 2 : 4));
    const { snapshots } = unpackSnapshots(result.data, checkpoints, cells, precision);
    const comparisons = snapshots.map((snapshot, index) => {
      const reference = expected[index];
      if (!reference) throw new Error('Missing CPU checkpoint.');
      const shiftedMacro = snapshot.macro.map((value, index) =>
        index % 4 === 0 ? value - 1 : value,
      );
      const populations = Float64Array.from(snapshot.populations, (value) =>
        precision === 'f16' ? halfToNumber(value) / f16PopulationScale : value,
      );
      const velocityPeaks = [1, 2, 3].map((component) =>
        errorPeak(shiftedMacro, reference.macro, component, 4),
      );
      const velocity = velocityPeaks.reduce((worst, peak) =>
        peak.magnitude > worst.magnitude ? peak : worst,
      );
      velocity.scale = Math.max(...velocityPeaks.map((peak) => peak.scale));
      const g = errorPeak(populations, reference.populations);
      const density = errorPeak(shiftedMacro, reference.macro, 0, 4);
      const massError =
        populations.reduce((sum, value, i) => sum + value - (reference.populations[i] ?? NaN), 0) /
        cells;
      return {
        step: snapshot.step,
        g,
        density,
        velocity,
        massError,
        macro: snapshot.macro,
        populations: Array.from(populations),
      };
    });
    const measurements = comparisons.map(({ step, g, density, velocity, massError }) => ({
      step,
      g: normalizedError(g),
      density: normalizedError(density),
      velocity: normalizedError(velocity),
      massError,
    }));
    writeFileSync(
      testInfo.outputPath('storage-drift.json'),
      JSON.stringify({ precision, measurements }, null, 2),
    );
    await testInfo.attach('storage-drift', {
      path: testInfo.outputPath('storage-drift.json'),
      contentType: 'application/json',
    });
    const growth = JSON.stringify(measurements);
    const final = comparisons.at(-1);
    if (!final) throw new Error('Missing final checkpoint.');
    const { g, density, velocity } = final;
    assertPeak('g', g, g.index % cells, growth, Math.floor(g.index / cells), f16Tolerance);
    assertPeak('rho - 1', density, Math.floor(density.index / 4), growth, undefined, f16Tolerance);
    assertPeak('u', velocity, Math.floor(velocity.index / 4), growth, undefined, f16Tolerance);
    assertRestingWalls(comparisons, grid);
  });
}

for (const uIn of [0.004, params.uIn]) {
  test(`f16 storage limits mass drift in a periodic uniform flow at u=${uIn} through 100 steps`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto('./#/validate');
    const advertised = await page.evaluate(
      async () => (await navigator.gpu?.requestAdapter())?.features.has('shader-f16') ?? false,
    );
    test.skip(!advertised, 'shader-f16 is unavailable.');
    await page.addScriptTag({ content: await solverBundle() });
    const periodicLayout = layout;
    const periodicCells = cells;
    const geometry = new Uint32Array(periodicCells * 2);
    geometry.fill(NO_Q, periodicCells);
    const result = await page.evaluate(storageSnapshots, {
      layout: periodicLayout,
      grid: {
        ...periodicLayout,
        geometry: Array.from(geometry),
        boundaryCells: [],
        solidCells: 0,
        frontalCells: 0,
        blockage: 0,
        watertight: true,
        missedLinks: 0,
      },
      params: { ...params, uIn, walls: 'bb' as const, precision: 'f16' as const },
      // Intermediate checkpoints are already measured by the open-boundary comparison.
      checkpoints: [0, 100],
    });
    expect(result.validationError).toBeNull();
    expect(result.allocationError).toBeNull();
    expect(result.uncapturedErrors).toEqual([]);
    const { snapshots } = unpackSnapshots(result.data, [0, 100], periodicCells, 'f16');
    const initial = snapshots[0];
    if (!initial) throw new Error('Missing initialization checkpoint.');
    const exact = WEIGHTS.map((weight, i) => {
      const cu = (DIRECTIONS[i]?.[0] ?? NaN) * uIn;
      return weight * (3 * cu + 4.5 * cu * cu - 1.5 * uIn * uIn);
    });
    let worstRelativeError = 0;
    initial.populations.forEach((bits, index) => {
      const expected = exact[Math.floor(index / periodicCells)] ?? NaN;
      const actual = halfToNumber(bits) / f16PopulationScale;
      worstRelativeError = Math.max(worstRelativeError, Math.abs((actual - expected) / expected));
    });
    expect(worstRelativeError, 'f16 per-population storage error').toBeLessThan(1e-3);
    const mass = snapshots.map(({ step, populations }) => ({
      step,
      meanDensityDeviation:
        populations.reduce((sum, bits) => sum + halfToNumber(bits) / f16PopulationScale, 0) /
        periodicCells,
    }));
    writeFileSync(testInfo.outputPath('periodic-mass.json'), JSON.stringify(mass, null, 2));
    await testInfo.attach('periodic-mass', {
      path: testInfo.outputPath('periodic-mass.json'),
      contentType: 'application/json',
    });
    for (const { step, meanDensityDeviation } of mass) {
      expect(Math.abs(meanDensityDeviation), `mass drift at step ${step}`).toBeLessThan(2e-6);
    }
  });
}

test('automatic storage starts a scene and describes its float16 preference in Advanced', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.locator('#tunnel')).toHaveAttribute('data-scene-state', 'running');
  await page.getByText('Advanced', { exact: true }).click();
  const storage = page.getByRole('combobox', { name: 'Storage', exact: true });
  await expect(storage).toHaveValue('auto');
  await expect(storage.locator('option:checked')).toHaveText('Auto (float16 if supported)');
});
