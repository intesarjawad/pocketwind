import type { ModelParseError, ParsedModel } from './model';
import type { Mesh } from './stl';
import type { Layout, VoxelGrid } from './voxel-grid';

export type Request =
  | { type: 'parse'; id: number; bytes: ArrayBuffer; fileName: string; maxTriangles?: number }
  | {
      type: 'voxelize';
      id: number;
      body: Mesh;
      supports: Mesh | null;
      layout: Layout;
      opts: { floor: boolean };
    };

export type Reply =
  | { type: 'progress'; id: number; operation: Request['type']; fraction: number }
  | ({ type: 'done'; id: number; operation: 'parse' } & Pick<
      ParsedModel,
      'mesh' | 'format' | 'unitMm'
    >)
  | { type: 'done'; id: number; operation: 'voxelize'; grid: VoxelGrid }
  | {
      type: 'error';
      id: number;
      operation: Request['type'];
      error: ModelParseError | { kind: 'operation-failed' | 'no-solid-cells'; message: string };
    };

function uniqueBuffers(buffers: ArrayBufferLike[]): ArrayBuffer[] {
  const transferable = new Set<ArrayBuffer>();
  for (const buffer of buffers) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError('Geometry messages require transferable ArrayBuffers.');
    }
    transferable.add(buffer);
  }
  return [...transferable];
}

/** Transfer ownership of request buffers; their views become detached after posting. */
export function requestTransferables(request: Request): ArrayBuffer[] {
  if (request.type === 'parse') return [request.bytes];
  return uniqueBuffers([
    request.body.positions.buffer,
    ...(request.supports ? [request.supports.positions.buffer] : []),
  ]);
}

/** Transfer result storage directly, including every packed grid buffer. */
export function replyTransferables(reply: Reply): ArrayBuffer[] {
  if (reply.type !== 'done') return [];
  if (reply.operation === 'parse') return uniqueBuffers([reply.mesh.positions.buffer]);
  return uniqueBuffers([reply.grid.geometry.buffer, reply.grid.boundaryCells.buffer]);
}
