import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

declare const gpuSolverModule: typeof import('../../src/lbm/gpu-solver');
declare const nanGuardModule: typeof import('../../src/lbm/nan-guard');
declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };

let solverBundle: string;
let guardBundle: string;

async function bundleModule(path: string, name: string): Promise<string> {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: { entry: fileURLToPath(new URL(path, import.meta.url)), name, formats: ['iife'] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || !('output' in output)) throw new Error('Expected one module bundle.');
  const entry = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Module bundle has no entry chunk.');
  return entry.code;
}

test.beforeAll(async () => {
  [solverBundle, guardBundle] = await Promise.all([
    bundleModule('../../src/lbm/gpu-solver.ts', 'gpuSolverModule'),
    bundleModule('../../src/lbm/nan-guard.ts', 'nanGuardModule'),
  ]);
});

for (const parameters of ['inject_nan=400', '', 'nan=400', 'inject_nan=NaN']) {
  test(`density guard resets only an injected run: ${parameters || 'no injection'}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto(`./#/?${parameters}`);
    await page.addScriptTag({ content: solverBundle });
    await page.addScriptTag({ content: guardBundle });
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for the density guard.');
      const device = await adapter.requestDevice();
      const errors: string[] = [];
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      const layout = { nx: 32, ny: 32, nz: 32 };
      const cells = layout.nx * layout.ny * layout.nz;
      const geometry = new Uint32Array(cells * 2);
      geometry.fill(0xffffffff, cells);
      geometry[0] = 4; // The first cell is equilibrium boundary, not fluid.
      const grid = {
        ...layout,
        geometry,
        boundaryCells: new Uint32Array(),
        solidCells: 0,
        frontalCells: 0,
        blockage: 0,
        watertight: true,
        missedLinks: 0,
      };
      const solver = await gpuSolverModule.GpuSolver.create(device, layout, grid, {
        tau0: 0.8,
        uIn: 0.04,
        les: false,
      });
      if ('kind' in solver) throw new Error(`Solver allocation failed: ${solver.message}`);
      const guard = await nanGuardModule.NanGuard.create(
        device,
        solver,
        new URLSearchParams(location.hash.split('?')[1]),
      );
      const notice = document.createElement('p');
      notice.id = 'guard-message';
      notice.setAttribute('role', 'status');
      document.querySelector('#app')?.append(notice);
      const events: { step: number; what: string; next: string }[] = [];
      guard.addEventListener('unstable', (event) => {
        if (!(event instanceof CustomEvent)) throw new Error('Expected instability details.');
        const message: import('../../src/lbm/nan-guard').Instability = event.detail;
        events.push(message);
        notice.textContent = `${message.what}. ${message.next}.`;
      });
      const readback = device.createBuffer({
        size: solver.macroBuffer.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const early = await guard.advance(400);
        const earlyEvents = events.length;
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(solver.populationBuffers[0], 0, readback, 0, 8);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const injected = new Float32Array(readback.getMappedRange());
        const boundaryFinite = Number.isFinite(injected[0]);
        const fluidNaN = Number.isNaN(injected[1]);
        readback.unmap();
        // An oversized batch must stop at detection rather than continue the diverged run.
        const message = await guard.advance(600);
        const afterCheck = solver.stepCount;
        const snapshot = device.createCommandEncoder();
        snapshot.copyBufferToBuffer(solver.macroBuffer, 0, readback, 0, solver.macroBuffer.size);
        device.queue.submit([snapshot.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const macros = new Float32Array(readback.getMappedRange());
        const finite = macros.every(Number.isFinite);
        const equilibriumMacro = [1, Math.fround(0.04), 0, 0];
        const equilibrium = macros.every((value, index) => value === equilibriumMacro[index % 4]);
        readback.unmap();
        const resumed = await guard.advance(200);
        return {
          early,
          earlyEvents,
          boundaryFinite,
          fluidNaN,
          message,
          afterCheck,
          finite,
          equilibrium,
          resumed,
          events,
          resumedStep: solver.stepCount,
          allocationError: (await device.popErrorScope())?.message ?? null,
          validationError: (await device.popErrorScope())?.message ?? null,
          errors,
        };
      } finally {
        guard.destroy();
        solver.destroy();
        readback.destroy();
        device.destroy();
      }
    });
    expect(result.errors).toEqual([]);
    expect(result.allocationError).toBeNull();
    expect(result.validationError).toBeNull();
    expect(result.early).toBeUndefined();
    expect(result.earlyEvents).toBe(0);
    expect(result.boundaryFinite).toBe(true);
    expect(result.finite).toBe(true);
    expect(result.resumed).toBeUndefined();
    const notice = page.locator('#guard-message');
    if (parameters === 'inject_nan=400') {
      expect(result.fluidNaN).toBe(true);
      expect(result.message?.step).toBe(600);
      expect(result.events).toEqual([result.message]);
      expect(result.afterCheck).toBe(0);
      expect(result.equilibrium).toBe(true);
      expect(result.resumedStep).toBe(200);
      await expect(notice).toHaveText(
        'The run went unstable at step 600 and was reset. Lower the speed, or choose a higher tier under Advanced.',
      );
    } else {
      expect(result.fluidNaN).toBe(false);
      expect(result.message).toBeUndefined();
      expect(result.events).toEqual([]);
      expect(result.afterCheck).toBe(1000);
      expect(result.resumedStep).toBe(1200);
      await expect(notice).toBeEmpty();
    }
  });
}

test('GPU density rule accepts endpoints and flags both signs of NaN and infinity', async ({
  page,
}) => {
  const code = readFileSync(
    new URL('../../src/lbm/shaders/nan_guard.wgsl', import.meta.url),
    'utf8',
  );
  await page.goto('./');
  const result = await page.evaluate(async (code) => {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available for the density guard.');
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const compilation = await module.getCompilationInfo();
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    // A partial second row exercises flattening, padding and aggregation at the final cell.
    const macroData = new Uint32Array(65 * 4);
    for (let cell = 0; cell < 65; cell += 1) macroData[cell * 4] = 0x3f800000;
    const macros = device.createBuffer({
      size: macroData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const flag = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const bits = [
      0x3f000000, 0x3fc00000, 0x3effffff, 0x3fc00001, 0x7fc00000, 0xffc00000, 0x7f800000,
      0xff800000,
    ];
    const readback = device.createBuffer({
      size: bits.length * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [macros, flag].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    try {
      for (const [index, rho] of bits.entries()) {
        macroData[64 * 4] = rho;
        device.queue.writeBuffer(macros, 0, macroData);
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(flag);
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1, 2);
        pass.end();
        encoder.copyBufferToBuffer(flag, 0, readback, index * 4, 4);
        device.queue.submit([encoder.finish()]);
      }
      await readback.mapAsync(GPUMapMode.READ);
      const flags = Array.from(new Uint32Array(readback.getMappedRange()));
      readback.unmap();
      return {
        flags,
        errors,
        compilationErrors: compilation.messages
          .filter((message) => message.type === 'error')
          .map((message) => message.message),
        validationError: (await device.popErrorScope())?.message ?? null,
      };
    } finally {
      for (const buffer of [macros, flag, readback]) buffer.destroy();
      device.destroy();
    }
  }, code);
  expect(result.flags).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
  expect(result.compilationErrors).toEqual([]);
  expect(result.validationError).toBeNull();
  expect(result.errors).toEqual([]);
});
