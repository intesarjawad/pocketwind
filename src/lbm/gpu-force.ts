import { CELL_TYPE_MASK, CellType, type VoxelGrid } from '../geometry/voxel-grid';
import { dispatch2D } from '../gpu/dispatch';
import { checkedGpuOperation } from './gpu-resources';
import type { Precision } from './layout';
import { FORCE_EVERY_STEPS } from './params';
import type { ShaderSources } from './shader-source';
import { assembleShader } from './shader-source';
import reduce from './shaders/reduce.wgsl?raw';

export { FORCE_EVERY_STEPS };
export type ForceSample = { step: number; fx: number; fy: number; fz: number };
type ForceState = { kind: 'idle' } | { kind: 'encoded' | 'mapping'; step: number };
type Populations = readonly [GPUBuffer, GPUBuffer, GPUBuffer];
type ForceDevice = Pick<
  GPUDevice,
  | 'pushErrorScope'
  | 'popErrorScope'
  | 'createBuffer'
  | 'createShaderModule'
  | 'createComputePipeline'
  | 'createBindGroup'
> & {
  readonly limits: Pick<GPUSupportedLimits, 'maxComputeWorkgroupsPerDimension'>;
  readonly queue: Pick<GPUQueue, 'writeBuffer'>;
};
const VECTOR_BYTES = 16;
const WORKGROUP_SIZE = 64;
// The default minStorageBufferOffsetAlignment; each state writes its own range of partials.
const OFFSET_ALIGNMENT = 256;

declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly UNIFORM: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };

/**
 * Each sample averages the momentum exchange of both ping-pong states, the two latest steps,
 * so a period-two oscillation near the walls cannot alias into the sampled drag. One reserved
 * staging slot prevents copies racing an encoded sample or a pending map.
 */
export class GpuForce {
  private state: ForceState = { kind: 'idle' };
  private destroyed = false;

  private constructor(
    private readonly dispatchSize: readonly [number, number],
    private readonly pipeline: GPUComputePipeline,
    private readonly bindings: readonly [GPUBindGroup, GPUBindGroup],
    private readonly reduction: GPUComputePipeline,
    private readonly reduceBindings: GPUBindGroup,
    private readonly result: GPUBuffer,
    private readonly staging: GPUBuffer,
  ) {}

  /** All buffers join the solver's allocation list, including on partial construction failure. */
  static async create(
    device: ForceDevice,
    grid: VoxelGrid,
    states: readonly [Populations, Populations],
    geometry: GPUBuffer,
    solverParams: ArrayBuffer,
    sources: ShaderSources,
    precision: Precision,
    buffers: GPUBuffer[],
  ): Promise<GpuForce> {
    const dispatchSize = dispatch2D(
      grid.boundaryCells.length,
      WORKGROUP_SIZE,
      device.limits.maxComputeWorkgroupsPerDimension,
    );
    const cells = grid.nx * grid.ny * grid.nz;
    for (const cell of grid.boundaryCells) {
      const flag = grid.geometry[cell] ?? 0;
      if (cell >= cells || (flag & CELL_TYPE_MASK) !== CellType.FLUID || flag >>> 4 === 0) {
        throw new RangeError('Boundary cells must index fluid cells with wall links.');
      }
    }
    const allocate = <Value>(operation: () => Value) => checkedGpuOperation(device, operation);
    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) =>
      allocate(() => {
        const value = device.createBuffer({ label, size, usage });
        buffers.push(value);
        return value;
      });
    const uniform = await buffer(
      'force grid',
      solverParams.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const count = await buffer(
      'force boundary count',
      VECTOR_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const boundary = await buffer(
      'force boundary cells',
      Math.max(4, grid.boundaryCells.byteLength),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const partialBytes =
      Math.ceil((dispatchSize[0] * dispatchSize[1] * VECTOR_BYTES) / OFFSET_ALIGNMENT) *
      OFFSET_ALIGNMENT;
    // Padding between the two ranges is never written and stays zero for the reduction.
    const partials = await buffer('force partials', 2 * partialBytes, GPUBufferUsage.STORAGE);
    const result = await buffer(
      'force result',
      VECTOR_BYTES,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const staging = await buffer(
      'force readback',
      VECTOR_BYTES,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    await allocate(() => {
      device.queue.writeBuffer(uniform, 0, solverParams);
      device.queue.writeBuffer(count, 0, new Uint32Array([grid.boundaryCells.length, 0, 0, 0]));
      if (grid.boundaryCells.length > 0) device.queue.writeBuffer(boundary, 0, grid.boundaryCells);
    });
    const pipeline = async (label: string, code: string) => {
      const module = await allocate(() => device.createShaderModule({ code }));
      return allocate(() =>
        device.createComputePipeline({
          label,
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        }),
      );
    };
    const forcePipeline = await pipeline(
      'body force',
      assembleShader('force', sources, 'trt', precision),
    );
    const reduction = await pipeline('force reduction', reduce);
    const bind = (populations: Populations, range: number) =>
      allocate(() =>
        device.createBindGroup({
          layout: forcePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            ...populations.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
            { binding: 7, resource: { buffer: geometry } },
            { binding: 9, resource: { buffer: boundary } },
            {
              binding: 10,
              resource: { buffer: partials, offset: range * partialBytes, size: partialBytes },
            },
            { binding: 11, resource: { buffer: count } },
          ],
        }),
      );
    const bindings = [await bind(states[0], 0), await bind(states[1], 1)] as const;
    const reduceBindings = await allocate(() =>
      device.createBindGroup({
        layout: reduction.getBindGroupLayout(0),
        entries: [partials, result].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }),
    );
    return new GpuForce(
      dispatchSize,
      forcePipeline,
      bindings,
      reduction,
      reduceBindings,
      result,
      staging,
    );
  }

  /** The caller chooses cadence; an occupied staging slot skips this sample entirely. */
  encode(encoder: GPUCommandEncoder, step: number): void {
    if (this.state.kind !== 'idle') return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    for (const binding of this.bindings) {
      pass.setBindGroup(0, binding);
      pass.dispatchWorkgroups(...this.dispatchSize);
    }
    pass.setPipeline(this.reduction);
    pass.setBindGroup(0, this.reduceBindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this.result, 0, this.staging, 0, VECTOR_BYTES);
    this.state = { kind: 'encoded', step };
  }

  /** Call after submission. No sample or a pending map returns busy without starting another map. */
  async read(): Promise<ForceSample | 'busy'> {
    if (this.destroyed) throw new Error('The solver has been destroyed.');
    if (this.state.kind !== 'encoded') return 'busy';
    const { step } = this.state;
    this.state = { kind: 'mapping', step };
    try {
      await this.staging.mapAsync(GPUMapMode.READ);
      const [fx = NaN, fy = NaN, fz = NaN] = new Float32Array(this.staging.getMappedRange());
      return { step, fx, fy, fz };
    } finally {
      this.staging.unmap();
      this.state = { kind: 'idle' };
    }
  }

  /** Discard an unread sample; an in-flight read retains its original step stamp. */
  reset(): void {
    if (this.state.kind === 'encoded') this.state = { kind: 'idle' };
  }

  /** Storage is released by the solver; destroying a buffer rejects any pending map. */
  destroy(): void {
    this.destroyed = true;
  }
}
