import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { presetMesh } from '../../src/geometry/presets';
import { CELL_TYPE_MASK, CellType } from '../../src/geometry/voxel-grid';

declare global {
  interface Window {
    perfProbe: {
      parse: Record<number, { sentAt: number; doneAt?: number }>;
      particles: { device: GPUDevice; buffer: GPUBuffer; count: number; at: number } | null;
      flags: { cells: Uint32Array; at: number } | null;
    };
  }
}

declare const GPUBufferUsage: { readonly MAP_READ: number; readonly COPY_DST: number };
declare const GPUMapMode: { readonly READ: number };

// Timing budgets are measured on the Apple GPU in Chromium with the window in front.
const PARSE_BUDGET_MS = 2000;
const FIRST_FRAME_BUDGET_MS = 3000;
const PARSE_TRIANGLES = 1_000_000;
const FIRST_FRAME_TRIANGLES = 500_000;
// Particles inside the body's bounding box must stay rare once the flow has reached the body.
const INSIDE_BOX_LIMIT = 0.01;
// The flow has reached the body when this share of particles is past its upstream face.
const REACHED_SHARE = 0.1;

const SOUP_SEED = 20_261_107;
const SOUP_BOX_MM = [1000, 400, 300] as const;
const SOUP_HALF_EDGE_MM = 25;

const STL_HEADER_BYTES = 80;
const STL_RECORD_BYTES = 50;
const STL_NORMAL_BYTES = 12;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random small triangles with every vertex inside the box. */
function soupPositions(triangleCount: number): Float32Array {
  const random = mulberry32(SOUP_SEED);
  const positions = new Float32Array(triangleCount * 9);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const centre = SOUP_BOX_MM.map((extent) => random() * extent);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const extent = SOUP_BOX_MM[axis] ?? 0;
        const value = (centre[axis] ?? 0) + (random() * 2 - 1) * SOUP_HALF_EDGE_MM;
        positions[triangle * 9 + vertex * 3 + axis] = Math.min(extent, Math.max(0, value));
      }
    }
  }
  return positions;
}

/** Binary STL with zero normals and attribute bytes. */
function binaryStl(positions: Float32Array): Buffer {
  const count = positions.length / 9;
  const bytes = Buffer.alloc(STL_HEADER_BYTES + 4 + STL_RECORD_BYTES * count);
  bytes.writeUInt32LE(count, STL_HEADER_BYTES);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const start = STL_HEADER_BYTES + 4 + triangle * STL_RECORD_BYTES + STL_NORMAL_BYTES;
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      bytes.writeFloatLE(positions[triangle * 9 + coordinate] ?? 0, start + coordinate * 4);
    }
  }
  return bytes;
}

function writeStl(path: string, positions: Float32Array): string {
  writeFileSync(path, binaryStl(positions));
  return path;
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mac-gpu', 'The budgets are set for the mac-gpu project.');
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.addInitScript(() => {
    const now = (): number => performance.timeOrigin + performance.now();
    const probe: Window['perfProbe'] = { parse: {}, particles: null, flags: null };
    window.perfProbe = probe;

    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent) => {
          const reply = event.data;
          if (reply?.type !== 'done' || reply.operation !== 'parse') return;
          const entry = probe.parse[reply.id];
          if (entry) entry.doneAt = performance.now();
        });
      }

      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ): void {
        const request = message as { type?: string; id?: number };
        if (request.type === 'parse' && typeof request.id === 'number') {
          probe.parse[request.id] = { sentAt: performance.now() };
        }
        super.postMessage(message, options as Transferable[]);
      }
    };

    if (typeof GPUDevice === 'undefined') return;
    const createBuffer = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (descriptor) {
      const buffer = createBuffer.call(this, descriptor);
      if (descriptor.label === 'Particle pos and prev') {
        probe.particles = { device: this, buffer, count: descriptor.size / 32, at: now() };
      }
      return buffer;
    };
    const writeBuffer = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buffer, offset, data, ...rest) {
      if (buffer.label === 'Particle cell flags' && ArrayBuffer.isView(data)) {
        const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        probe.flags = { cells: new Uint32Array(bytes as ArrayBuffer), at: now() };
      }
      return writeBuffer.call(this, buffer, offset, data as BufferSource, ...rest);
    };
  });
});

type FrameCheck = {
  /** Milliseconds from the file being set to the first passing frame, or null on timeout. */
  elapsedMs: number | null;
  last: { reached: number; inside: number } | null;
};

/** Open the orbit view, wait for its first scene, then hand it a model file. */
async function dropModel(page: Page, file: string): Promise<number> {
  // Particles live in the orbit view; the default plate draws smoke threads instead.
  await page.goto('./#/?cam=rearquarter');
  await expect(page.locator('#tunnel')).toHaveAttribute('data-scene-state', 'running');
  const since = Date.now();
  await page.locator('#dropzone input[type="file"]').setInputFiles(file);
  return since;
}

/**
 * Read the particle buffer on every animation frame after `since` and report the first frame
 * where the flow has reached the body and, when a limit is given, few particles are inside the
 * solid cells' bounding box.
 */
function firstFrameWithFlowPast(
  page: Page,
  since: number,
  insideLimit: number | null,
): Promise<FrameCheck> {
  return page.evaluate(
    async ({ since, budgetMs, solid, mask, reachedShare, insideLimit }) => {
      const now = (): number => performance.timeOrigin + performance.now();
      const probe = window.perfProbe;
      let box: { min: number[]; max: number[]; at: number } | null = null;
      let staging: { buffer: GPUBuffer; size: number } | null = null;
      let last: FrameCheck['last'] = null;

      function boundsOf(flags: { cells: Uint32Array; at: number }, dims: number[]) {
        const [nx = 0, ny = 0] = dims;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let cell = 0; cell < flags.cells.length; cell += 1) {
          if (((flags.cells[cell] ?? 0) & mask) !== solid) continue;
          const point = [cell % nx, Math.floor(cell / nx) % ny, Math.floor(cell / (nx * ny))];
          for (let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis] ?? 0, point[axis] ?? 0);
            max[axis] = Math.max(max[axis] ?? 0, point[axis] ?? 0);
          }
        }
        return { min, max, at: flags.at };
      }

      async function readParticles(particles: NonNullable<typeof probe.particles>) {
        const bytes = particles.count * 32;
        if (!staging || staging.size !== bytes) {
          staging = {
            size: bytes,
            buffer: particles.device.createBuffer({
              size: bytes,
              usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            }),
          };
        }
        const encoder = particles.device.createCommandEncoder();
        encoder.copyBufferToBuffer(particles.buffer, 0, staging.buffer, 0, bytes);
        particles.device.queue.submit([encoder.finish()]);
        await staging.buffer.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(staging.buffer.getMappedRange().slice(0));
        staging.buffer.unmap();
        return values;
      }

      function shares(values: Float32Array, bounds: { min: number[]; max: number[] }) {
        const { min, max } = bounds;
        const count = values.length / 8;
        let reached = 0;
        let inside = 0;
        for (let id = 0; id < count; id += 1) {
          const position = [values[id * 8], values[id * 8 + 1], values[id * 8 + 2]];
          if ((position[0] ?? NaN) > (min[0] ?? Infinity)) reached += 1;
          const within = position.every(
            (value, axis) =>
              (value ?? NaN) >= (min[axis] ?? Infinity) &&
              (value ?? NaN) <= (max[axis] ?? -Infinity),
          );
          if (within) inside += 1;
        }
        return { reached: reached / count, inside: inside / count };
      }

      while (now() - since < budgetMs * 2) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const { particles, flags } = probe;
        if (!particles || !flags || particles.at < since || flags.at < since) continue;
        if (box?.at !== flags.at) {
          // Every tier is nx:ny:nz = 2:1:1, so the grid dimensions follow from the cell count.
          const ny = Math.round(Math.cbrt(flags.cells.length / 2));
          box = boundsOf(flags, [2 * ny, ny, ny]);
        }
        if (box.min[0] === Infinity) continue;
        try {
          const values = await readParticles(particles);
          const sampledAt = now();
          last = shares(values, box);
          if (last.reached >= reachedShare && (insideLimit === null || last.inside < insideLimit)) {
            return { elapsedMs: sampledAt - since, last };
          }
        } catch {
          // A restart destroys the buffers mid-read; the next frame samples the new run.
          staging = null;
        }
      }
      return { elapsedMs: null, last };
    },
    {
      since,
      budgetMs: FIRST_FRAME_BUDGET_MS,
      solid: CellType.SOLID,
      mask: CELL_TYPE_MASK,
      reachedShare: REACHED_SHARE,
      insideLimit,
    },
  );
}

test(
  'a 1 M-triangle STL parses in the worker within the budget',
  { tag: '@perf' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const file = writeStl(testInfo.outputPath('soup-1m.stl'), soupPositions(PARSE_TRIANGLES));
    await dropModel(page, file);
    await page.waitForFunction(() =>
      Object.values(window.perfProbe.parse).some((entry) => entry.doneAt !== undefined),
    );
    const timings = await page.evaluate(() => Object.values(window.perfProbe.parse));
    expect(timings).toHaveLength(1);
    const [timing] = timings;
    const parseMs = (timing?.doneAt ?? Infinity) - (timing?.sentAt ?? 0);
    expect(parseMs).toBeLessThan(PARSE_BUDGET_MS);
  },
);

test(
  'a 500 k-triangle STL reaches a first frame of moving particles within the budget',
  { tag: '@perf' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const file = writeStl(
      testInfo.outputPath('soup-500k.stl'),
      soupPositions(FIRST_FRAME_TRIANGLES),
    );
    const since = await dropModel(page, file);
    const result = await firstFrameWithFlowPast(page, since, null);
    await testInfo.attach('first-frame-timing', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.elapsedMs, `last sample ${JSON.stringify(result.last)}`).not.toBeNull();
    expect(result.elapsedMs ?? Infinity).toBeLessThan(FIRST_FRAME_BUDGET_MS);
  },
);

test(
  'the Ahmed STL drops in and particles flow around the body within the budget',
  { tag: ['@perf', '@demo'] },
  async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const mesh = presetMesh('ahmed-25');
    if (mesh === null) throw new Error('The Ahmed preset mesh is missing.');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const file = writeStl(testInfo.outputPath('ahmed-25.stl'), mesh.positions);
    const since = await dropModel(page, file);
    const result = await firstFrameWithFlowPast(page, since, INSIDE_BOX_LIMIT);
    expect(result.elapsedMs, `last sample ${JSON.stringify(result.last)}`).not.toBeNull();
    expect(result.elapsedMs ?? Infinity).toBeLessThan(FIRST_FRAME_BUDGET_MS);
    expect(errors).toEqual([]);
  },
);
