import type { Mesh } from '../geometry/stl';
import { DEPTH_FORMAT } from './frame';
import frameShader from './shaders/frame.wgsl?raw';
import meshShader from './shaders/mesh.wgsl?raw';

declare const GPUBufferUsage: { readonly VERTEX: number; readonly COPY_DST: number };
export const MESH_VERTEX_BYTES = 24;

/** Duplicate face normals per vertex so adjacent triangles never smooth together. */
export function meshVertices(mesh: Mesh): Float32Array<ArrayBuffer> {
  if (
    !Number.isSafeInteger(mesh.triangleCount) ||
    mesh.triangleCount < 1 ||
    mesh.positions.length !== mesh.triangleCount * 9 ||
    !mesh.positions.every(Number.isFinite)
  ) {
    throw new RangeError('Mesh positions must contain complete finite triangles.');
  }
  const data = new Float32Array(mesh.triangleCount * 18);
  for (let offset = 0; offset < mesh.positions.length; offset += 9) {
    const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] =
      mesh.positions.subarray(offset, offset + 9);
    const normal = [
      (by - ay) * (cz - az) - (bz - az) * (cy - ay),
      (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
    ];
    const length = Math.hypot(...normal);
    // Degenerate faces rasterize no area; a finite zero normal keeps uploads valid.
    const unit = normal.map((value) => (length === 0 ? 0 : value / length));
    data.set([ax, ay, az, ...unit, bx, by, bz, ...unit, cx, cy, cz, ...unit], offset * 2);
  }
  return data;
}

export async function createMeshPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  frame: GPUBuffer,
  mesh: Mesh,
) {
  const data = meshVertices(mesh);
  const module = device.createShaderModule({
    label: 'Body',
    code: `${frameShader}\n${meshShader}`,
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: 'Flat body',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [
        {
          arrayStride: MESH_VERTEX_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });
  const buffer = device.createBuffer({
    label: 'Body vertices',
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
      pass.draw(data.length / 6);
    },
    destroy(): void {
      buffer.destroy();
    },
  };
}
