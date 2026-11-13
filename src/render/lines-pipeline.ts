import type { Point3 } from './camera';
import { DEPTH_FORMAT } from './frame';
import frameShader from './shaders/frame.wgsl?raw';
import lineShader from './shaders/lines.wgsl?raw';

const MAX_FLOOR_LINES = 65536;

declare const GPUBufferUsage: { readonly VERTEX: number; readonly COPY_DST: number };
export interface DomainBounds {
  readonly min: Point3;
  readonly max: Point3;
}

/** Twelve box edges followed by interior floor lines at an explicit cell spacing. */
export function lineVertices(bounds: DomainBounds, spacing: number): Float32Array<ArrayBuffer> {
  const { min, max } = bounds;
  if (
    !min.every(Number.isFinite) ||
    !max.every(Number.isFinite) ||
    max.some((v, axis) => v <= (min[axis] ?? v)) ||
    !Number.isFinite(spacing) ||
    spacing <= 0
  ) {
    throw new RangeError('Domain bounds and grid spacing must be finite and positive.');
  }
  const corners = Array.from(
    { length: 8 },
    (_, i): Point3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]],
  );
  const data: number[] = [];
  for (const [index, corner] of corners.entries()) {
    for (const bit of [1, 2, 4]) {
      const other = corners[index | bit];
      if (!(index & bit) && other) data.push(...corner, ...other);
    }
  }
  const columns = Math.ceil((max[0] - min[0]) / spacing);
  const rows = Math.ceil((max[1] - min[1]) / spacing);
  // Bound custom spacing before allocating or iterating over the floor grid.
  if (columns + rows > MAX_FLOOR_LINES)
    throw new RangeError('The floor grid exceeds 65,536 lines.');
  for (let column = 1; column < columns; column += 1) {
    const x = min[0] + column * spacing;
    data.push(x, min[1], min[2], x, max[1], min[2]);
  }
  for (let row = 1; row < rows; row += 1) {
    const y = min[1] + row * spacing;
    data.push(min[0], y, min[2], max[0], y, min[2]);
  }
  return new Float32Array(data);
}

export async function createLinesPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  frame: GPUBuffer,
  bounds: DomainBounds,
  spacing: number,
) {
  const data = lineVertices(bounds, spacing);
  const module = device.createShaderModule({
    label: 'Domain lines',
    code: `${frameShader}\n${lineShader}`,
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'Domain and floor grid',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      ],
    },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    primitive: { topology: 'line-list' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
  });
  const buffer = device.createBuffer({
    label: 'Domain and grid vertices',
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frame } }],
  });
  return {
    draw(pass: GPURenderPassEncoder): void {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, buffer);
      pass.draw(data.length / 3);
    },
    destroy(): void {
      buffer.destroy();
    },
  };
}
