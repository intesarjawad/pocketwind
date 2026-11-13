import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';

// Run from the repository root: node bench/precision-hash.mjs.
// The old prelude needs the current shader's store signature; its cast still uses native rounding.
const baseline =
  execFileSync('git', ['show', '8fbc698:src/lbm/shaders/prelude-f16.wgsl'], { encoding: 'utf8' }) +
  '\nfn encode_population(value: f32, i: u32, n: u32) -> pop { return pop(value); }\n';
const bundles = {};
for (const mode of ['current', 'pre-hash']) {
  let baselineLoads = 0;
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'baseline-f16',
        enforce: 'pre',
        load(id) {
          if (mode === 'pre-hash' && id.endsWith('/prelude-f16.wgsl?raw')) {
            baselineLoads++;
            return `export default ${JSON.stringify(baseline)}`;
          }
        },
      },
    ],
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: process.cwd() + '/src/lbm/gpu-solver.ts',
        name: 'gpuSolverModule',
        formats: ['iife'],
      },
    },
  });
  if (mode === 'pre-hash' && baselineLoads !== 1)
    throw new Error('Baseline prelude was not substituted exactly once');
  const output = Array.isArray(result) ? result[0] : result;
  bundles[mode] = output.output.find((x) => x.type === 'chunk' && x.isEntry).code;
}
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: false });
const rows = [];
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0] + '#/validate');
  await page.bringToFront();
  // Alternate order over three repeats; one precision and one GPU submission at a time.
  for (let repeat = 0; repeat < 3; repeat++) {
    const modes =
      repeat % 2 === 0 ? ['f32', 'f16', 'pre-hash-f16'] : ['pre-hash-f16', 'f16', 'f32'];
    for (const mode of modes) {
      await page.addScriptTag({
        content: bundles[mode === 'pre-hash-f16' ? 'pre-hash' : 'current'],
      });
      const loadStart = loadavg(),
        started = Date.now();
      const measured = await page.evaluate(
        async ({ precision }) => {
          const adapter = await navigator.gpu.requestAdapter();
          if (!adapter?.features.has('shader-f16') || !adapter.features.has('timestamp-query'))
            throw new Error('Benchmark requires shader-f16 and timestamp-query');
          const device = await adapter.requestDevice({
            requiredFeatures: ['shader-f16', 'timestamp-query'],
          });
          const errors = [];
          device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
          const measurements = [];
          try {
            for (const [tier, nx, ny, nz] of [
              ['S', 128, 64, 64],
              ['M', 192, 96, 96],
              ['L', 256, 128, 128],
            ]) {
              const cells = nx * ny * nz,
                geometry = new Uint32Array(cells * 2);
              geometry.fill(0xffffffff, cells);
              const grid = {
                nx,
                ny,
                nz,
                geometry,
                boundaryCells: new Uint32Array(),
                solidCells: 0,
                frontalCells: 0,
                blockage: 0,
                watertight: true,
                missedLinks: 0,
              };
              const solver = await gpuSolverModule.GpuSolver.create(device, { nx, ny, nz }, grid, {
                tau0: 0.53,
                uIn: 0.05,
                les: true,
                precision,
              });
              if ('kind' in solver) throw new Error(solver.message);
              const query = device.createQuerySet({ type: 'timestamp', count: 2 });
              const resolved = device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              });
              const readback = device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              });
              try {
                const warm = device.createCommandEncoder();
                solver.step(warm, 5, false);
                device.queue.submit([warm.finish()]);
                await device.queue.onSubmittedWorkDone();
                const encoder = device.createCommandEncoder();
                let count = 0;
                const timed = new Proxy(encoder, {
                  get(target, property) {
                    if (property === 'beginComputePass')
                      return (descriptor) => {
                        count++;
                        return target.beginComputePass(
                          count === 1 || count === 500
                            ? {
                                ...descriptor,
                                timestampWrites: {
                                  querySet: query,
                                  ...(count === 1 ? { beginningOfPassWriteIndex: 0 } : {}),
                                  ...(count === 500 ? { endOfPassWriteIndex: 1 } : {}),
                                },
                              }
                            : descriptor,
                        );
                      };
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                });
                solver.step(timed, 500, false);
                if (count !== 500) throw new Error('Expected 500 timed solver passes');
                encoder.resolveQuerySet(query, 0, 2, resolved, 0);
                encoder.copyBufferToBuffer(resolved, 0, readback, 0, 16);
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                const [begin, end] = new BigUint64Array(readback.getMappedRange());
                const ms = Number(end - begin) / 1e6;
                readback.unmap();
                if (!(ms > 0)) throw new Error('Invalid timestamp interval');
                measurements.push({ tier, steps: 500, ms, mlups: (cells * 500) / (ms * 1000) });
              } finally {
                solver.destroy();
                query.destroy();
                resolved.destroy();
                readback.destroy();
              }
            }
            await device.queue.onSubmittedWorkDone();
            if (errors.length) throw new Error(errors.join('\n'));
            return {
              measurements,
              adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
              userAgent: navigator.userAgent,
            };
          } finally {
            device.destroy();
          }
        },
        { precision: mode === 'f32' ? 'f32' : 'f16' },
      );
      const row = {
        repeat,
        mode,
        loadStart,
        loadEnd: loadavg(),
        elapsedMs: Date.now() - started,
        ...measured,
      };
      rows.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
      writeFileSync('bench/precision-hash-results.local', JSON.stringify(rows, null, 2));
    }
  }
} finally {
  await browser.close();
  await server.close();
}
