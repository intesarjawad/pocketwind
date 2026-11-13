import { MESSAGES } from '../app/messages';
import { checkedGpuOperation, validateDispatch } from './gpu-resources';
import type { GpuSolver } from './gpu-solver';
import shader from './shaders/nan_guard.wgsl?raw';

export const NAN_GUARD_INTERVAL = 200;
const WORKGROUP_SIZE = 64;
// Two-dimensional dispatch keeps the larger grids below the per-axis workgroup limit.
const WORKGROUPS_PER_ROW = 256;
const MACRO_BYTES_PER_CELL = 4 * Float32Array.BYTES_PER_ELEMENT;
const FLAG_BYTES = Uint32Array.BYTES_PER_ELEMENT;
declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };
export type Instability = { step: number; what: string; next: string };
type GuardedSolver = Pick<
  GpuSolver,
  'step' | 'stepCount' | 'macroBuffer' | 'reset' | 'injectNaNForRunner'
>;
type GuardDevice = Pick<
  GPUDevice,
  | 'pushErrorScope'
  | 'popErrorScope'
  | 'createBuffer'
  | 'createComputePipeline'
  | 'createShaderModule'
  | 'createBindGroup'
  | 'createCommandEncoder'
> & {
  readonly limits: Pick<GPUSupportedLimits, 'maxComputeWorkgroupsPerDimension'>;
  readonly queue: Pick<GPUQueue, 'submit' | 'onSubmittedWorkDone'>;
};

/** Physical density bounds match the GPU check, including both endpoints. */
export function isUnstableDensity(rho: number): boolean {
  return !Number.isFinite(rho) || rho < 0.5 || rho > 1.5;
}

/** Cover the macro buffer without exceeding the baseline workgroup count per axis. */
export function nanGuardDispatchSize(
  cells: number,
  maxWorkgroups = 65535,
): readonly [number, number] {
  if (!Number.isSafeInteger(cells) || cells <= 0) {
    throw new RangeError('Density guard cell count must be a positive safe integer.');
  }
  const workgroups = Math.ceil(cells / WORKGROUP_SIZE);
  const columns = Math.min(workgroups, WORKGROUPS_PER_ROW, maxWorkgroups);
  const dispatch = [columns, Math.ceil(workgroups / columns)] as const;
  validateDispatch(dispatch, maxWorkgroups);
  return dispatch;
}

/** Publish the message after equilibrium has replaced the unstable state. */
export async function resetUnstableRun(
  step: number,
  reset: () => Promise<void>,
  events: EventTarget,
): Promise<Instability> {
  await reset();
  const message = {
    step,
    what: MESSAGES['run-unstable'].what.replace('step N', `step ${step}`),
    next: MESSAGES['run-unstable'].next,
  };
  events.dispatchEvent(new CustomEvent<Instability>('unstable', { detail: message }));
  return message;
}

/**
 * Await advance before presenting macros. Guard readback is a four-byte fence every
 * 200 steps. A failed checkpoint resets the state before returning to consumers.
 * Injection follows the check and submission at its step; step 400 is caught at 600.
 */
export class NanGuard extends EventTarget {
  private advancing = false;
  private destroyed = false;

  private constructor(
    private readonly device: GuardDevice,
    private readonly solver: GuardedSolver,
    private readonly flag: GPUBuffer,
    private readonly readback: GPUBuffer,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindings: GPUBindGroup,
    private readonly dispatchSize: readonly [number, number],
    private readonly runnerParameters: URLSearchParams,
  ) {
    super();
  }

  /** Await GPU error scopes before exposing the guard; failed construction releases all storage. */
  static async create(
    device: GuardDevice,
    solver: GuardedSolver,
    runnerParameters = new URLSearchParams(),
  ): Promise<NanGuard> {
    const dispatchSize = nanGuardDispatchSize(
      solver.macroBuffer.size / MACRO_BYTES_PER_CELL,
      device.limits.maxComputeWorkgroupsPerDimension,
    );
    const buffers: GPUBuffer[] = [];
    try {
      return await checkedGpuOperation(device, () => {
        const flag = device.createBuffer({
          label: 'instability flag',
          size: FLAG_BYTES,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        buffers.push(flag);
        const readback = device.createBuffer({
          label: 'instability readback',
          size: FLAG_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        buffers.push(readback);
        const pipeline = device.createComputePipeline({
          label: 'density guard',
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
        });
        const bindings = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [solver.macroBuffer, flag].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        });
        return new NanGuard(
          device,
          solver,
          flag,
          readback,
          pipeline,
          bindings,
          dispatchSize,
          runnerParameters,
        );
      });
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }

  /** Stops the batch on instability; the event is emitted only after reset finishes. */
  async advance(count: number): Promise<Instability | undefined> {
    if (this.destroyed) throw new Error('The density guard has been destroyed.');
    if (this.advancing) throw new Error('Await the previous advance before stepping again.');
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(this.solver.stepCount + count)
    ) {
      throw new RangeError('Step count must be a non-negative safe integer.');
    }
    this.advancing = true;
    try {
      let remaining = count;
      while (remaining > 0) {
        const untilCheck = NAN_GUARD_INTERVAL - (this.solver.stepCount % NAN_GUARD_INTERVAL);
        const injectionStep = Number(this.runnerParameters.get('inject_nan'));
        const untilInjection =
          Number.isSafeInteger(injectionStep) && injectionStep > this.solver.stepCount
            ? injectionStep - this.solver.stepCount
            : Infinity;
        const steps = Math.min(remaining, untilCheck, untilInjection);
        const encoder = this.device.createCommandEncoder();
        this.solver.step(encoder, steps, true);
        remaining -= steps;
        const check = this.solver.stepCount % NAN_GUARD_INTERVAL === 0;
        if (check) this.encodeCheck(encoder);
        this.device.queue.submit([encoder.finish()]);
        if (check && (await this.readFlag())) {
          return await resetUnstableRun(
            this.solver.stepCount,
            async () => {
              const reset = this.device.createCommandEncoder();
              this.solver.reset(reset);
              this.device.queue.submit([reset.finish()]);
              await this.device.queue.onSubmittedWorkDone();
            },
            this,
          );
        }
        this.solver.injectNaNForRunner(this.runnerParameters);
      }
      return undefined;
    } finally {
      this.advancing = false;
    }
  }

  private encodeCheck(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.flag);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindings);
    pass.dispatchWorkgroups(...this.dispatchSize);
    pass.end();
    encoder.copyBufferToBuffer(this.flag, 0, this.readback, 0, FLAG_BYTES);
  }

  private async readFlag(): Promise<boolean> {
    await this.readback.mapAsync(GPUMapMode.READ);
    try {
      return new Uint32Array(this.readback.getMappedRange())[0] !== 0;
    } finally {
      this.readback.unmap();
    }
  }

  /** Await advance and submit pending work before releasing storage. */
  destroy(): void {
    if (this.advancing) throw new Error('Await advance before destroying the density guard.');
    if (this.destroyed) return;
    this.flag.destroy();
    this.readback.destroy();
    this.destroyed = true;
  }
}
