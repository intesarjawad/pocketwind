import { expect, test } from '@playwright/test';
import { bundleRenderer, openFixture } from './render-fixture';

declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly COPY_DST: number;
  readonly COPY_SRC: number;
  readonly UNIFORM: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };
declare const renderModule: typeof import('./render-entry');

let rendererCode = '';
test.beforeAll(async () => {
  rendererCode = await bundleRenderer();
});

test('particle interpolation, displacement cap and prev coordinates use the macro velocity channels', async ({
  page,
}) => {
  await openFixture(page, rendererCode);
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available for particles.');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const resources: { destroy(): void }[] = [];
    try {
      const grid = { nx: 16, ny: 16, nz: 16, geometry: new Uint32Array(4096) };
      const macro = device.createBuffer({
        size: 4096 * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const frame = device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const staging = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      resources.push(macro, frame, staging);
      const particles = await renderModule.createParticles(device, 'rgba8unorm', frame, {
        grid,
        bodyBounds: { min: [6, 4, 4], max: [10, 10, 10] },
        macroBuffer: macro,
        count: 1,
        seed: 7,
      });
      resources.push(particles);
      const macros = new Float32Array(4096 * 4);
      for (let cell = 0; cell < 4096; cell += 1)
        macros.set(
          [
            2,
            (cell % 16) * 0.01,
            (Math.floor(cell / 16) % 16) * 0.02,
            Math.floor(cell / 256) * 0.03,
          ],
          cell * 4,
        );
      device.queue.writeBuffer(macro, 0, macros);
      const record = async (steps: number, age = 10, x = 4.25, generation = 0) => {
        device.queue.writeBuffer(
          particles.buffer,
          0,
          new Float32Array([x, 5.5, 6.75, age, x, 5.5, 6.75, generation]),
        );
        const encoder = device.createCommandEncoder();
        particles.update(encoder, steps);
        encoder.copyBufferToBuffer(particles.buffer, 0, staging, 0, 32);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(staging.getMappedRange()));
        staging.unmap();
        return values;
      };
      const interpolated = await record(2);
      for (let cell = 0; cell < 4096; cell += 1) macros.set([20, 3, 4, 0], cell * 4);
      device.queue.writeBuffer(macro, 0, macros);
      const capped = await record(9);
      const stationary = await record(0);
      const ageLimit = await record(0, 3999);
      const expired = await record(0, 4000);
      const outlet = await record(0, 10, 14);
      const nextGeneration = await record(0, 4000, 4.25, 1);
      return {
        interpolated,
        capped,
        stationary,
        ageLimit,
        expired,
        outlet,
        nextGeneration,
        validation: (await device.popErrorScope())?.message ?? null,
        errors,
      };
    } finally {
      for (const resource of resources) resource.destroy();
      device.destroy();
    }
  });
  for (const [index, expected] of [4.335, 5.72, 7.155, 11, 4.25, 5.5, 6.75, 0].entries())
    expect(result.interpolated[index]).toBeCloseTo(expected, 5);
  for (const [index, expected] of [4.85, 6.3, 6.75, 11, 4.25, 5.5, 6.75, 0].entries())
    expect(result.capped[index]).toBeCloseTo(expected, 5);
  expect(result.stationary).toEqual([4.25, 5.5, 6.75, 11, 4.25, 5.5, 6.75, 0]);
  expect(result.ageLimit).toEqual([4.25, 5.5, 6.75, 4000, 4.25, 5.5, 6.75, 0]);
  for (const respawn of [result.expired, result.outlet, result.nextGeneration]) {
    expect(respawn[0]).toBe(2);
    expect(respawn[3]).toBe(0);
    expect(respawn.slice(4, 7)).toEqual(respawn.slice(0, 3));
    for (const coordinate of respawn.slice(1, 3)) {
      expect(coordinate).toBeGreaterThanOrEqual(3.1);
      expect(coordinate).toBeLessThanOrEqual(10.9);
    }
  }
  expect(result.expired).toEqual(result.outlet);
  expect(result.expired[7]).toBe(1);
  expect(result.nextGeneration[7]).toBe(2);
  expect(result.nextGeneration.slice(1, 3)).not.toEqual(result.expired.slice(1, 3));
  expect(result.validation).toBeNull();
  expect(result.errors).toEqual([]);
});

test('a scene renders 300 moving-flow frames with zero particles in non-fluid cells', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openFixture(page, rendererCode);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available for containment.');
    const device = await adapter.requestDevice();
    const gpuErrors: string[] = [];
    device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const grid = { nx: 32, ny: 16, nz: 16, geometry: new Uint32Array(8192) };
    function insideBody(x: number, y: number, z: number): boolean {
      return x >= 8 && x <= 18 && y >= 6 && y <= 10 && z >= 3 && z <= 9;
    }
    function cellKind(x: number, y: number, z: number): number {
      if (z === 0) return 3;
      if (x === 0 || x === 31 || z === 15) return 4;
      // A blocked inlet strip exercises rejection and the verified fallback.
      if (x === 2 && y === 5) return 1;
      if (x === 10 && y === 6 && z > 0 && z < 3) return 2;
      return Number(insideBody(x, y, z));
    }
    for (let cell = 0; cell < 8192; cell += 1) {
      grid.geometry[cell] =
        cellKind(cell % 32, Math.floor(cell / 32) % 16, Math.floor(cell / 512)) | (1 << 8);
    }
    const macros = new Float32Array(8192 * 4);
    for (let cell = 0; cell < 8192; cell += 1) macros.set([1, 0.2, 0.04, 0.01], cell * 4);
    const macro = device.createBuffer({
      size: macros.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(macro, 0, macros);
    const canvas = document.createElement('canvas');
    canvas.id = 'render-fixture';
    document.body.append(canvas);
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let frames = 0;
    let complete: () => void = () => {};
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const scene = await renderModule.createScene(canvas, device, 'rearquarter', {
      body: {
        label: 'Containment body',
        mesh: { triangleCount: 1, positions: new Float32Array([8, 6, 3, 8, 10, 3, 8, 6, 9]) },
      },
      flow: {
        grid,
        bodyBounds: { min: [8, 5, 3], max: [19, 11, 10] },
        macroBuffer: macro,
        count: 1024,
        seed: 0x12345678,
        advance: () => {
          frames += 1;
          if (frames === 300) {
            canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
            complete();
          }
          return 4;
        },
      },
      gridSpacing: 4,
    });
    const buffer = scene.particleBuffer;
    if (!buffer) throw new Error('The scene has no particle buffer.');
    const staging = device.createBuffer({
      size: 1024 * 32,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      // Include outlet, body, support, floor, equilibrium and expired records.
      device.queue.writeBuffer(
        buffer,
        0,
        new Float32Array([
          30, 7, 7, 0, 30, 7, 7, 0, 12, 7, 7, 0, 12, 7, 7, 0, 10, 6, 1, 0, 10, 6, 1, 0, 4, 7, 0, 0,
          4, 7, 0, 0, 4, 7, 15, 0, 4, 7, 15, 0, 2, 7, 7, 4000, 2, 7, 7, 0,
        ]),
      );
      await completed;
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, 1024 * 32);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange());
      const records = Array.from({ length: 1024 }, (_, id) => {
        const x = data[id * 8] ?? NaN;
        const y = data[id * 8 + 1] ?? NaN;
        const z = data[id * 8 + 2] ?? NaN;
        const cell = Math.round(x) + 32 * (Math.round(y) + 16 * Math.round(z));
        return {
          outside:
            ![x, y, z].every(Number.isFinite) ||
            x < 0 ||
            x >= 30 ||
            y < 0 ||
            y >= 15 ||
            z < 0 ||
            z >= 15,
          nonFluid: ((grid.geometry[cell] ?? 7) & 7) !== 0,
          moved: x > 2.01,
          respawned: (data[id * 8 + 7] ?? 0) > 0,
        };
      });
      staging.unmap();
      await device.queue.onSubmittedWorkDone();
      return {
        frames,
        nonFluid: records.filter((record) => record.nonFluid).length,
        outside: records.filter((record) => record.outside).length,
        moved: records.filter((record) => record.moved).length,
        respawned: records.filter((record) => record.respawned).length,
        state: canvas.dataset.sceneState,
        label: canvas.getAttribute('aria-label'),
        allocation: (await device.popErrorScope())?.message ?? null,
        validation: (await device.popErrorScope())?.message ?? null,
        gpuErrors,
      };
    } finally {
      staging.destroy();
      scene.dispose();
      macro.destroy();
      device.destroy();
    }
  });
  expect(result.frames).toBe(300);
  expect(result.nonFluid).toBe(0);
  expect(result.outside).toBe(0);
  expect(result.moved).toBeGreaterThan(0);
  expect(result.respawned).toBe(1024);
  expect(result.state).toBe('paused');
  expect(result.label).toContain('Containment body, flow particles');
  expect(result.allocation).toBeNull();
  expect(result.validation).toBeNull();
  expect(result.gpuErrors).toEqual([]);
  expect(errors).toEqual([]);
});
