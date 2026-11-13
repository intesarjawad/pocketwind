import { dispatch2D } from '../gpu/dispatch';
import { DEPTH_FORMAT } from './frame';
import type { DomainBounds } from './lines-pipeline';
import {
  PARTICLE_PARAMS_BYTES,
  type ParticleGrid,
  packParticleParams,
  particleSeeds,
} from './particle-layout';
import frameShader from './shaders/frame.wgsl?raw';
import drawShader from './shaders/particles_draw.wgsl?raw';
import updateShader from './shaders/particles_update.wgsl?raw';

declare const GPUBufferUsage: {
  readonly STORAGE: number;
  readonly COPY_DST: number;
  readonly COPY_SRC: number;
  readonly UNIFORM: number;
};

export interface ParticleOptions {
  readonly grid: ParticleGrid;
  readonly bodyBounds: DomainBounds;
  readonly macroBuffer: GPUBuffer;
  readonly count: number;
  readonly seed: number;
}

/** Borrow the macro field and copy immutable flags; all other buffers belong to this renderer. */
export async function createParticles(
  device: GPUDevice,
  format: GPUTextureFormat,
  frame: GPUBuffer,
  options: ParticleOptions,
) {
  const { grid, count, seed, macroBuffer } = options;
  const { data, region, fallback } = particleSeeds(grid, options.bodyBounds, count, seed);
  const dispatch = dispatch2D(count, 64, device.limits.maxComputeWorkgroupsPerDimension);
  const updateModule = device.createShaderModule({
    label: 'Particle advection',
    code: updateShader,
  });
  const drawModule = device.createShaderModule({
    label: 'Particle streaks',
    code: `${frameShader}\n${drawShader}`,
  });
  const compute = await device.createComputePipelineAsync({
    label: 'Particle advection',
    layout: 'auto',
    compute: { module: updateModule, entryPoint: 'main' },
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'Particle streaks',
    layout: 'auto',
    vertex: { module: drawModule, entryPoint: 'vertex' },
    fragment: {
      module: drawModule,
      entryPoint: 'fragment',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'line-list' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
  });
  const buffers: GPUBuffer[] = [];
  try {
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = device.createBuffer({ label, size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const buffer = allocate(
      'Particle pos and prev',
      data.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    device.queue.writeBuffer(buffer, 0, data);
    const flags = grid.geometry.subarray(0, grid.nx * grid.ny * grid.nz);
    const geometry = allocate(
      'Particle cell flags',
      flags.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(geometry, 0, flags);
    const params = allocate(
      'Particle parameters',
      PARTICLE_PARAMS_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const updateGroup = device.createBindGroup({
      layout: compute.getBindGroupLayout(0),
      entries: [params, buffer, macroBuffer, geometry].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const drawGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: frame } },
        { binding: 1, resource: { buffer } },
      ],
    });
    return {
      buffer,
      update(encoder: GPUCommandEncoder, steps: number): void {
        device.queue.writeBuffer(
          params,
          0,
          packParticleParams(grid, count, seed, steps, region, fallback),
        );
        const pass = encoder.beginComputePass({ label: 'Particle advection' });
        pass.setPipeline(compute);
        pass.setBindGroup(0, updateGroup);
        pass.dispatchWorkgroups(...dispatch);
        pass.end();
      },
      draw(pass: GPURenderPassEncoder): void {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, drawGroup);
        pass.draw(count * 2);
      },
      destroy(): void {
        for (const buffer of buffers) buffer.destroy();
      },
    };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw error;
  }
}
