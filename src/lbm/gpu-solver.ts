/// <reference types="vite/client" />
import type { Operator, Walls } from '../app/settings';
import { CELL_TYPE_MASK, CellType, type VoxelGrid } from '../geometry/voxel-grid';
import { validateGeometry } from './geometry-contract';
import { type ForceSample, GpuForce } from './gpu-force';
import { AllocationFailure, checkedGpuOperation, validateDispatch } from './gpu-resources';
import { bytesForLayout, type Layout, type Precision, populationBufferBytes } from './layout';
import { assembleShader } from './shader-source';
import collisionReg from './shaders/collide-reg.wgsl?raw';
import collisionTrt from './shaders/collide-trt.wgsl?raw';
import common from './shaders/common.wgsl?raw';
import force from './shaders/force.wgsl?raw';
import init from './shaders/init.wgsl?raw';
import preludeF16 from './shaders/prelude-f16.wgsl?raw';
import prelude from './shaders/prelude-f32.wgsl?raw';
import streamCollide from './shaders/stream_collide.wgsl?raw';
import walls from './shaders/walls.wgsl?raw';

export type SolverParams = {
  tau0: number;
  uIn: number;
  les: boolean;
  operator?: Operator;
  /** Halfway bounce-back unless `bouzidi`; interpolation needs packed link fractions. */
  walls?: Walls;
  /** Population storage width; f32 unless the caller resolved an f16 request. */
  precision?: Precision;
  /** Steps to reach the full inlet speed; zero starts the run at full speed. */
  rampSteps?: number;
};
export { FORCE_EVERY_STEPS, type ForceSample } from './gpu-force';
export { AllocationFailure } from './gpu-resources';

type PopulationBuffers = readonly [GPUBuffer, GPUBuffer, GPUBuffer];
type StateBuffers = readonly [PopulationBuffers, PopulationBuffers];
type StepBindings = readonly [GPUBindGroup, GPUBindGroup];
type SolverDevice = Pick<
  GPUDevice,
  | 'pushErrorScope'
  | 'popErrorScope'
  | 'createBuffer'
  | 'createBindGroupLayout'
  | 'createPipelineLayout'
  | 'createShaderModule'
  | 'createComputePipeline'
  | 'createBindGroup'
  | 'createCommandEncoder'
> & {
  readonly limits: Pick<GPUSupportedLimits, 'maxComputeWorkgroupsPerDimension'>;
  readonly features: { has(feature: string): boolean };
  readonly queue: Pick<GPUQueue, 'writeBuffer' | 'submit'>;
};

const UNIFORM_BYTES = 48;
const WORKGROUP_SIZE = 64;
const SMAGORINSKY_CS = 0.1;
const TRT_LAMBDA = 3 / 16;
const DIRECTION_GROUPS = [7, 6, 6] as const;
const sources = {
  prelude,
  preludeF16,
  common,
  walls,
  collisionTrt,
  collisionReg,
  init,
  streamCollide,
  force,
};

declare const GPUBufferUsage: {
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly STORAGE: number;
  readonly UNIFORM: number;
};
declare const GPUShaderStage: { readonly COMPUTE: number };

/** Pack the f32 solver uniform; the regularized collision ignores the TRT lambda. */
export function packSolverParams(
  layout: Layout,
  params: SolverParams,
  writeMacro: boolean,
  step = 0,
): ArrayBuffer {
  bytesForLayout(layout, 'f32');
  const cells = layout.nx * layout.ny * layout.nz;
  if (cells * DIRECTION_GROUPS[0] > 0xffffffff) {
    throw new RangeError('Population buffers exceed u32 shader indexing.');
  }
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError('Solver step must be a non-negative safe integer.');
  }
  const tau0 = Math.fround(params.tau0);
  const uIn = Math.fround(params.uIn);
  const nu = Math.fround((tau0 - 0.5) / 3);
  const shaderTau = Math.fround(Math.fround(3 * nu) + 0.5);
  if (
    !Number.isFinite(tau0) ||
    !Number.isFinite(shaderTau) ||
    shaderTau <= 0.5 ||
    !Number.isFinite(uIn)
  ) {
    throw new RangeError('Relaxation time must exceed 0.5 and inlet speed must be finite.');
  }
  const data = new ArrayBuffer(UNIFORM_BYTES);
  new Uint32Array(data).set([layout.nx, layout.ny, layout.nz, cells]);
  new Float32Array(data, 16, 4).set([uIn, nu, 18 * Math.SQRT2 * SMAGORINSKY_CS ** 2, TRT_LAMBDA]);
  new Uint32Array(data, 32).set([
    Number(params.les),
    Number(params.walls === 'bouzidi'),
    Number(writeMacro),
    step,
  ]);
  return data;
}

/** Fraction of the inlet speed at a step; a zero ramp length means full speed immediately. */
export function rampFactor(step: number, rampSteps: number): number {
  if (!Number.isFinite(rampSteps) || rampSteps <= 0) return 1;
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.min(1, step / rampSteps);
}

type RampState = {
  readonly layout: Layout;
  readonly params: SolverParams;
  readonly steps: number;
  /** One uniform per macro variant, shared with the two stepping bind groups. */
  readonly uniforms: readonly [GPUBuffer, GPUBuffer];
  readonly device: Pick<SolverDevice, 'createCommandEncoder'>;
};

/** Pull-stream/collide driver with f32 arithmetic and f32 or f16 population storage. */
export class GpuSolver {
  private current: 0 | 1 = 0;
  private steps = 0;
  private destroyed = false;
  private injectedNaN = false;
  private rampSettled = false;

  private constructor(
    private readonly dispatchSize: readonly [number, number, number],
    private readonly states: StateBuffers,
    readonly macroBuffer: GPUBuffer,
    private readonly pipeline: GPUComputePipeline,
    private readonly withoutMacro: StepBindings,
    private readonly withMacro: StepBindings,
    private readonly buffers: readonly GPUBuffer[],
    private readonly initPipeline: GPUComputePipeline,
    private readonly queue: SolverDevice['queue'],
    private readonly fluidCell: number,
    private readonly force: GpuForce,
    private readonly ramp: RampState,
  ) {}

  /** Initialize both population states; wall populations and macros always hold rest. */
  static async create(
    device: SolverDevice,
    layout: Layout,
    grid: VoxelGrid,
    params: SolverParams,
  ): Promise<GpuSolver | AllocationFailure> {
    const rampSteps = params.rampSteps ?? 0;
    if (!Number.isSafeInteger(rampSteps) || rampSteps < 0) {
      throw new RangeError('Ramp steps must be a non-negative safe integer.');
    }
    const precision = params.precision ?? 'f32';
    if (precision === 'f16' && !device.features.has('shader-f16')) {
      throw new RangeError('f16 population storage needs the shader-f16 feature.');
    }
    // A ramp starts from rest, so the initialization uniform carries no inlet speed.
    const start = rampSteps > 0 ? { ...params, uIn: 0 } : params;
    const uniforms = [
      packSolverParams(layout, start, false),
      packSolverParams(layout, start, true),
    ] as const;
    const cells = layout.nx * layout.ny * layout.nz;
    validateGeometry(layout, grid);
    const dispatchSize = [Math.ceil(layout.nx / WORKGROUP_SIZE), layout.ny, layout.nz] as const;
    validateDispatch(dispatchSize, device.limits.maxComputeWorkgroupsPerDimension);
    const buffers: GPUBuffer[] = [];
    const allocate = <Value>(operation: () => Value): Promise<Value> =>
      checkedGpuOperation(device, operation);
    try {
      const buffer = (
        label: string,
        size: number,
        usage: GPUBufferUsageFlags,
      ): Promise<GPUBuffer> =>
        allocate(() => {
          const buffer = device.createBuffer({ label, size, usage });
          buffers.push(buffer);
          return buffer;
        });
      const populationState = async (label: string): Promise<PopulationBuffers> => {
        const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
        return [
          await buffer(
            `${label} 0..6`,
            populationBufferBytes(cells, DIRECTION_GROUPS[0], precision),
            usage,
          ),
          await buffer(
            `${label} 7..12`,
            populationBufferBytes(cells, DIRECTION_GROUPS[1], precision),
            usage,
          ),
          await buffer(
            `${label} 13..18`,
            populationBufferBytes(cells, DIRECTION_GROUPS[2], precision),
            usage,
          ),
        ];
      };
      const states: StateBuffers = [
        await populationState('populations A'),
        await populationState('populations B'),
      ];
      const geometry = await buffer(
        'geometry',
        grid.geometry.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      await allocate(() => device.queue.writeBuffer(geometry, 0, grid.geometry));
      const macro = await buffer(
        'macros',
        cells * 16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const entries: GPUBindGroupLayoutEntry[] = Array.from({ length: 9 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type:
            binding === 0
              ? 'uniform'
              : binding <= 3 || binding === 7
                ? 'read-only-storage'
                : 'storage',
          ...(binding === 0 ? { minBindingSize: UNIFORM_BYTES } : {}),
        },
      }));
      const bindLayout = await allocate(() => device.createBindGroupLayout({ entries }));
      const pipelineLayout = await allocate(() =>
        device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
      );
      const pipeline = async (kernel: 'init' | 'streamCollide') => {
        const module = await allocate(() =>
          device.createShaderModule({
            code: assembleShader(kernel, sources, params.operator, precision),
          }),
        );
        return allocate(() =>
          device.createComputePipeline({
            label: kernel,
            layout: pipelineLayout,
            compute: {
              module,
              entryPoint: 'main',
            },
          }),
        );
      };
      const bindings = async (
        data: ArrayBuffer,
      ): Promise<{ groups: StepBindings; uniform: GPUBuffer }> => {
        const uniform = await buffer(
          'solver parameters',
          UNIFORM_BYTES,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );
        await allocate(() => device.queue.writeBuffer(uniform, 0, data));
        const bind = (input: PopulationBuffers, output: PopulationBuffers) =>
          allocate(() =>
            device.createBindGroup({
              layout: bindLayout,
              entries: [uniform, ...input, ...output, geometry, macro].map((buffer, binding) => ({
                binding,
                resource: { buffer },
              })),
            }),
          );
        return {
          groups: [await bind(states[0], states[1]), await bind(states[1], states[0])],
          uniform,
        };
      };
      // Immutable parameter buffers keep batched dispatches from sharing a later queue write.
      const withoutMacro = await bindings(uniforms[0]);
      const withMacro = await bindings(uniforms[1]);
      const initPipeline = await pipeline('init');
      const force = await GpuForce.create(
        device,
        grid,
        states,
        geometry,
        uniforms[0],
        sources,
        precision,
        buffers,
      );
      const solver = new GpuSolver(
        dispatchSize,
        states,
        macro,
        await pipeline('streamCollide'),
        withoutMacro.groups,
        withMacro.groups,
        buffers,
        initPipeline,
        device.queue,
        grid.geometry
          .subarray(0, cells)
          .findIndex((flag) => (flag & CELL_TYPE_MASK) === CellType.FLUID),
        force,
        {
          layout,
          params,
          steps: rampSteps,
          uniforms: [withoutMacro.uniform, withMacro.uniform],
          device,
        },
      );
      const encoder = await allocate(() => device.createCommandEncoder());
      await allocate(() => solver.reset(encoder));
      const commands = await allocate(() => encoder.finish());
      await allocate(() => device.queue.submit([commands]));
      return solver;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      if (error instanceof AllocationFailure) return error;
      throw error;
    }
  }

  /** Latest encoded post-collision state, split into direction groups 0..6, 7..12 and 13..18. */
  get populationBuffers(): PopulationBuffers {
    return this.states[this.current];
  }

  get stepCount(): number {
    return this.steps;
  }

  /** Restore equilibrium and macros before another frame can use an unstable state. */
  reset(encoder: GPUCommandEncoder): void {
    if (this.destroyed) throw new Error('The solver has been destroyed.');
    this.dispatch(encoder, this.initPipeline, this.withMacro[0]);
    this.dispatch(encoder, this.initPipeline, this.withMacro[1]);
    this.current = 0;
    this.steps = 0;
    this.rampSettled = false;
    this.force.reset();
  }

  /** Call after submission; queue writes cannot be interleaved with an unsubmitted encoder. */
  injectNaNForRunner(parameters: URLSearchParams): void {
    const step = Number(parameters.get('inject_nan'));
    if (
      this.destroyed ||
      this.injectedNaN ||
      this.fluidCell < 0 ||
      !Number.isSafeInteger(step) ||
      step <= 0 ||
      this.steps !== step
    )
      return;
    this.queue.writeBuffer(
      this.populationBuffers[0],
      this.fluidCell * Float32Array.BYTES_PER_ELEMENT,
      new Uint32Array([0x7fc00000]),
    );
    this.injectedNaN = true;
  }

  /** Encode consecutive steps. Submit encoders in order before reading their results. */
  step(encoder: GPUCommandEncoder, count: number, writeMacroOnLast: boolean): void {
    if (this.destroyed) throw new Error('The solver has been destroyed.');
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(this.steps + count)) {
      throw new RangeError('Step count must be a non-negative safe integer.');
    }
    for (let i = 0; i < count; i += 1) {
      const writeMacro = writeMacroOnLast && i === count - 1;
      if (this.ramp.steps > 0 && this.steps < this.ramp.steps) {
        this.rampedStep(writeMacro);
      } else {
        this.settleRamp();
        const bindings = writeMacro ? this.withMacro : this.withoutMacro;
        this.dispatch(encoder, this.pipeline, bindings[this.current]);
      }
      this.current = this.current === 0 ? 1 : 0;
      this.steps += 1;
    }
  }

  /**
   * A batched encoder can only see one uniform value, so each ramped step is
   * written and submitted on its own; queue order keeps it after its predecessor.
   */
  private rampedStep(writeMacro: boolean): void {
    const step = this.steps + 1;
    const speed = this.ramp.params.uIn * rampFactor(step, this.ramp.steps);
    const uniform = writeMacro ? this.ramp.uniforms[1] : this.ramp.uniforms[0];
    this.queue.writeBuffer(
      uniform,
      0,
      packSolverParams(this.ramp.layout, { ...this.ramp.params, uIn: speed }, writeMacro, step),
    );
    const encoder = this.ramp.device.createCommandEncoder();
    const bindings = writeMacro ? this.withMacro : this.withoutMacro;
    this.dispatch(encoder, this.pipeline, bindings[this.current]);
    this.queue.submit([encoder.finish()]);
  }

  /** Once the ramp ends, restore the full speed the batched bind groups keep using. */
  private settleRamp(): void {
    if (this.ramp.steps === 0 || this.rampSettled) return;
    this.rampSettled = true;
    this.queue.writeBuffer(
      this.ramp.uniforms[0],
      0,
      packSolverParams(this.ramp.layout, this.ramp.params, false, this.steps),
    );
    this.queue.writeBuffer(
      this.ramp.uniforms[1],
      0,
      packSolverParams(this.ramp.layout, this.ramp.params, true, this.steps),
    );
  }

  private dispatch(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindings: GPUBindGroup,
  ): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(...this.dispatchSize);
    pass.end();
  }

  /**
   * Sample the mean of the two latest encoded states. Call every FORCE_EVERY_STEPS; occupied
   * readback skips it.
   */
  encodeForce(encoder: GPUCommandEncoder): void {
    if (this.destroyed) throw new Error('The solver has been destroyed.');
    this.force.encode(encoder, this.steps);
  }

  /** Submit the force encoder first. Returns busy when no unread sample is available. */
  readForce(): Promise<ForceSample | 'busy'> {
    return this.force.read();
  }

  /** Release GPU storage. Pending command buffers must be submitted before destruction. */
  destroy(): void {
    if (this.destroyed) return;
    this.force.destroy();
    for (const buffer of this.buffers) buffer.destroy();
    this.destroyed = true;
  }
}
