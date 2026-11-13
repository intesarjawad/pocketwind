import { CellType, NO_Q, type VoxelGrid } from '../geometry/voxel-grid';
import { dispatch2D } from '../gpu/dispatch';
import { type AllocationFailure, GpuSolver } from '../lbm/gpu-solver';
import { type Precision, TIERS } from '../lbm/layout';
import copyShader from '../lbm/shaders/copy_bandwidth.wgsl?raw';
import { NU_MIN_LU, U_LU } from '../lbm/units';
import type { AdapterInfo } from '../validation/runner';
import { REPOSITORY_URL } from './panel';
import { ROUTE_TITLES, readRoute, routeHash } from './routes';
import { acquireSolverSlot } from './solver-slot';

type Tier = keyof typeof TIERS;

export type TierResult = { mlups: number; msPerStep: number; rooflinePct: number };
export type TimingMethod = 'timestamp-query' | 'submitted-work-done';

export type BenchReport = {
  copyGBps: number;
  perTier: Partial<Record<Tier, TierResult>>;
  /** Tiers that could not be measured, with the reason. */
  skipped?: Partial<Record<Tier, string>>;
  adapter: Omit<AdapterInfo, 'features'>;
  features: readonly string[];
  userAgent: string;
  timing: TimingMethod;
  steps: number;
};

declare global {
  interface Window {
    __pwt?: BenchReport;
  }
}

declare const GPUBufferUsage: {
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
  readonly STORAGE: number;
  readonly QUERY_RESOLVE: number;
};
declare const GPUMapMode: { readonly READ: number };

/** Bytes read and written per cell per step: 19 populations twice, plus the cell flags. */
export const BYTES_PER_CELL_STEP: Record<Precision, number> = { f32: 156, f16: 80 };

export const DEFAULT_BENCH_TIERS: readonly Tier[] = ['S', 'M', 'L'];
export const DEFAULT_BENCH_STEPS = 500;
/** The copy kernel reads one buffer of this size and writes another. */
export const COPY_BUFFER_BYTES = 128 * 1024 * 1024;
export const COPY_PASSES = 40;
const WARMUP_STEPS = 5;
const COPY_WORKGROUP_SIZE = 256;
const NS_PER_MS = 1e6;
const TIMESTAMP_QUERIES = 2;
const TIMESTAMP_BYTES = TIMESTAMP_QUERIES * BigUint64Array.BYTES_PER_ELEMENT;

function isTier(value: string): value is Tier {
  return Object.hasOwn(TIERS, value);
}

/** `#/bench?tiers=S,M,L&steps=500`; unknown tiers and bad step counts fall back to the defaults. */
export function parseBenchParams(hash: string): { tiers: readonly Tier[]; steps: number } {
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const requested = (params.get('tiers') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(isTier);
  const tiers = [...new Set(requested)];
  const steps = Number(params.get('steps'));
  return {
    tiers: tiers.length > 0 ? tiers : DEFAULT_BENCH_TIERS,
    steps: Number.isSafeInteger(steps) && steps > 0 ? steps : DEFAULT_BENCH_STEPS,
  };
}

/** Gigabytes per second for `passes` copies that each read and write `bufferBytes`. */
export function copyBandwidthGBps(bufferBytes: number, passes: number, ms: number): number {
  return (2 * bufferBytes * passes) / (ms * 1e6);
}

/** Million lattice updates per second at the memory-bandwidth limit. */
export function rooflineMlups(copyGBps: number, precision: Precision): number {
  return (copyGBps * 1e9) / BYTES_PER_CELL_STEP[precision] / 1e6;
}

export function measuredMlups(cells: number, steps: number, ms: number): number {
  return (cells * steps) / (ms * 1e3);
}

export function tierResult(
  cells: number,
  steps: number,
  ms: number,
  copyGBps: number,
  precision: Precision = 'f32',
): TierResult {
  const mlups = measuredMlups(cells, steps, ms);
  return {
    mlups,
    msPerStep: ms / steps,
    rooflinePct: (100 * mlups) / rooflineMlups(copyGBps, precision),
  };
}

export function reportJson(report: BenchReport): string {
  return JSON.stringify(report, null, 2);
}

/** A prefilled new-issue address; the report travels as the form's `report` field. */
export function issueUrl(report: BenchReport): string {
  const { vendor, architecture, description } = report.adapter;
  const name = [vendor, architecture, description].filter((part) => part !== '').join(' ');
  const params = new URLSearchParams({
    template: 'bench-report.yml',
    title: `Bench: ${name === '' ? 'unnamed adapter' : name}`,
    report: reportJson(report),
  });
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`;
}

type TimestampEncoder = Pick<GPUCommandEncoder, 'beginComputePass'>;

/**
 * Wrap an encoder so the first of `passes` compute passes records a start time
 * and the last records an end time. The solver encodes one pass per step and
 * never sees the query set.
 */
export function timestampEncoder<Encoder extends TimestampEncoder>(
  encoder: Encoder,
  querySet: GPUQuerySet,
  passes: number,
): Encoder {
  let begun = 0;
  return new Proxy(encoder, {
    get(target, property) {
      if (property === 'beginComputePass') {
        return (descriptor: GPUComputePassDescriptor = {}) => {
          begun += 1;
          const timestampWrites: GPUComputePassTimestampWrites = {
            querySet,
            ...(begun === 1 ? { beginningOfPassWriteIndex: 0 } : {}),
            ...(begun === passes ? { endOfPassWriteIndex: 1 } : {}),
          };
          const timed = begun === 1 || begun === passes;
          return target.beginComputePass(timed ? { ...descriptor, timestampWrites } : descriptor);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

type Timer = {
  readonly method: TimingMethod;
  /** Encode `passes` compute passes and return the milliseconds they took. */
  time(passes: number, encode: (encoder: GPUCommandEncoder) => void): Promise<number>;
};

function createTimer(device: GPUDevice): Timer {
  const useTimestamps = device.features.has('timestamp-query');
  return {
    method: useTimestamps ? 'timestamp-query' : 'submitted-work-done',
    async time(passes, encode) {
      await device.queue.onSubmittedWorkDone();
      const encoder = device.createCommandEncoder();
      if (!useTimestamps) {
        encode(encoder);
        const started = performance.now();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        return performance.now() - started;
      }
      const querySet = device.createQuerySet({ type: 'timestamp', count: TIMESTAMP_QUERIES });
      const resolved = device.createBuffer({
        size: TIMESTAMP_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: TIMESTAMP_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        encode(timestampEncoder(encoder, querySet, passes));
        encoder.resolveQuerySet(querySet, 0, TIMESTAMP_QUERIES, resolved, 0);
        encoder.copyBufferToBuffer(resolved, 0, readback, 0, TIMESTAMP_BYTES);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const [begin = 0n, end = 0n] = new BigUint64Array(readback.getMappedRange().slice(0));
        readback.unmap();
        const ms = Number(end - begin) / NS_PER_MS;
        if (!(ms > 0)) throw new Error('The adapter returned no usable timestamps.');
        return ms;
      } finally {
        querySet.destroy();
        resolved.destroy();
        readback.destroy();
      }
    },
  };
}

async function measureCopyBandwidth(device: GPUDevice, timer: Timer): Promise<number> {
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const input = device.createBuffer({ size: COPY_BUFFER_BYTES, usage });
  const output = device.createBuffer({ size: COPY_BUFFER_BYTES, usage });
  try {
    const module = device.createShaderModule({ code: copyShader });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const [columns, rows] = dispatch2D(
      COPY_BUFFER_BYTES / 16,
      COPY_WORKGROUP_SIZE,
      device.limits.maxComputeWorkgroupsPerDimension,
    );
    const encodePasses = (passes: number) => (encoder: GPUCommandEncoder) => {
      for (let i = 0; i < passes; i += 1) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(columns, rows);
        pass.end();
      }
    };
    await timer.time(1, encodePasses(1));
    const ms = await timer.time(COPY_PASSES, encodePasses(COPY_PASSES));
    return copyBandwidthGBps(COPY_BUFFER_BYTES, COPY_PASSES, ms);
  } finally {
    input.destroy();
    output.destroy();
  }
}

/** A tunnel with no body: every cell is fluid, so only solver throughput is measured. */
function emptyGrid(layout: { nx: number; ny: number; nz: number }): VoxelGrid {
  const cells = layout.nx * layout.ny * layout.nz;
  const geometry = new Uint32Array(2 * cells);
  geometry.fill(CellType.FLUID, 0, cells);
  geometry.fill(NO_Q, cells);
  return {
    ...layout,
    geometry,
    boundaryCells: new Uint32Array(),
    solidCells: 0,
    frontalCells: 0,
    blockage: 0,
    watertight: true,
    missedLinks: 0,
  };
}

async function measureTier(
  device: GPUDevice,
  timer: Timer,
  tier: Tier,
  steps: number,
  copyGBps: number,
  signal: AbortSignal,
): Promise<TierResult | AllocationFailure> {
  const layout = TIERS[tier];
  const release = await acquireSolverSlot(signal);
  let solver: GpuSolver | AllocationFailure | undefined;
  try {
    solver = await GpuSolver.create(device, layout, emptyGrid(layout), {
      tau0: NU_MIN_LU * 3 + 0.5,
      uIn: U_LU,
      les: true,
    });
    if (!(solver instanceof GpuSolver)) return solver;
    const stepper = solver;
    await timer.time(WARMUP_STEPS, (encoder) => stepper.step(encoder, WARMUP_STEPS, false));
    const ms = await timer.time(steps, (encoder) => stepper.step(encoder, steps, false));
    return tierResult(layout.nx * layout.ny * layout.nz, steps, ms, copyGBps);
  } finally {
    if (solver instanceof GpuSolver) solver.destroy();
    release();
  }
}

type BenchOptions = {
  readonly tiers: readonly Tier[];
  readonly steps: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (message: string) => void;
};

export async function runBench(
  gpu: GPU,
  userAgent: string,
  options: BenchOptions,
): Promise<BenchReport | null> {
  const adapter = await gpu.requestAdapter();
  if (adapter === null) return null;
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query')
    ? ['timestamp-query']
    : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  try {
    const timer = createTimer(device);
    options.onProgress?.('Measuring copy bandwidth.');
    const copyGBps = await measureCopyBandwidth(device, timer);
    const perTier: BenchReport['perTier'] = {};
    const skipped: NonNullable<BenchReport['skipped']> = {};
    for (const tier of options.tiers) {
      options.signal.throwIfAborted();
      options.onProgress?.(`Measuring tier ${tier}.`);
      const result = await measureTier(
        device,
        timer,
        tier,
        options.steps,
        copyGBps,
        options.signal,
      );
      if ('mlups' in result) perTier[tier] = result;
      else skipped[tier] = result.message;
    }
    const { vendor, architecture, device: name, description } = adapter.info;
    return {
      copyGBps,
      perTier,
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      adapter: { vendor, architecture, device: name, description },
      features: [...adapter.features].sort(),
      userAgent,
      timing: timer.method,
      steps: options.steps,
    };
  } finally {
    device.destroy();
  }
}

function shell(root: HTMLElement): {
  status: HTMLElement;
  output: HTMLPreElement;
  results: HTMLElement;
  actions: HTMLElement;
} {
  const section = document.createElement('section');
  const title = document.createElement('h1');
  title.textContent = ROUTE_TITLES.bench;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Not yet measured.';
  const output = document.createElement('pre');
  output.setAttribute('aria-label', 'Benchmark report');
  output.hidden = true;
  const results = document.createElement('div');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Raw JSON';
  details.append(summary, output);
  const actions = document.createElement('p');
  actions.hidden = true;
  const tunnel = document.createElement('a');
  tunnel.href = routeHash('', readRoute().settings);
  tunnel.textContent = 'Open the tunnel';
  section.append(title, status, results, details, actions, tunnel);
  root.replaceChildren(section);
  return { status, output, results, actions };
}

function showReport(
  report: BenchReport,
  ui: { status: HTMLElement; output: HTMLPreElement; results: HTMLElement; actions: HTMLElement },
): void {
  const json = reportJson(report);
  const copyRate = document.createElement('p');
  copyRate.textContent = `Copy bandwidth: ${report.copyGBps.toFixed(1)} GB/s`;
  const list = document.createElement('ul');
  for (const [tier, result] of Object.entries(report.perTier)) {
    const item = document.createElement('li');
    item.textContent = `Tier ${tier}: ${result.mlups.toFixed(1)} MLUPS, ${result.msPerStep.toFixed(2)} ms/step, ${result.rooflinePct.toFixed(1)}% of bandwidth limit`;
    list.append(item);
  }
  for (const [tier, reason] of Object.entries(report.skipped ?? {})) {
    const item = document.createElement('li');
    item.textContent = `Tier ${tier}: ${reason}`;
    list.append(item);
  }
  ui.results.replaceChildren(copyRate, list);
  ui.output.textContent = json;
  ui.output.hidden = false;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(json);
      ui.status.textContent = 'Report copied.';
    } catch {
      ui.status.textContent = 'The report could not be copied. Select it and copy it by hand.';
    }
  });
  const add = document.createElement('a');
  add.href = issueUrl(report);
  add.target = '_blank';
  add.rel = 'noopener noreferrer';
  add.textContent = 'Add my GPU';
  ui.actions.replaceChildren(copy, ' ', add);
  ui.actions.hidden = false;
  ui.status.textContent = 'Measured.';
}

/** Measure this adapter and show the report; `window.__pwt` holds it once it exists. */
export async function renderBenchRoute(root: HTMLElement, signal: AbortSignal): Promise<void> {
  Reflect.deleteProperty(window, '__pwt');
  const ui = shell(root);
  if (!('gpu' in navigator)) {
    ui.status.setAttribute('role', 'alert');
    ui.status.textContent = 'WebGPU is unavailable, so nothing was measured.';
    return;
  }
  const { tiers, steps } = parseBenchParams(location.hash);
  try {
    const report = await runBench(navigator.gpu, navigator.userAgent, {
      tiers,
      steps,
      signal,
      onProgress: (message) => {
        if (!signal.aborted) ui.status.textContent = message;
      },
    });
    if (signal.aborted) return;
    if (report === null) {
      ui.status.setAttribute('role', 'alert');
      ui.status.textContent = 'No WebGPU adapter is available, so nothing was measured.';
      return;
    }
    window.__pwt = report;
    showReport(report, ui);
  } catch (error) {
    if (signal.aborted) return;
    ui.status.setAttribute('role', 'alert');
    ui.status.textContent = `The benchmark could not finish. ${error instanceof Error ? error.message : String(error)}`;
  }
}
