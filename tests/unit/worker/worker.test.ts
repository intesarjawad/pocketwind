import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_PATH, modelArchive } from '../../../scripts/make-3mf-fixtures';
import { CellType } from '../../../src/geometry/voxel-grid';
import { dispatchMessage, handleMessage } from '../../../src/geometry/worker';
import {
  type Reply,
  type Request,
  replyTransferables,
  requestTransferables,
} from '../../../src/geometry/worker-protocol';
import { box } from '../voxelize/fixtures';

function parseRequest(name = 'stl/cube-binary.stl'): Extract<Request, { type: 'parse' }> {
  const bytes = Uint8Array.from(
    readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)),
  ).buffer;
  return { type: 'parse', id: 17, bytes, fileName: name };
}

function voxelRequest(): Extract<Request, { type: 'voxelize' }> {
  return {
    type: 'voxelize',
    id: 18,
    body: box([3.2, 3.2, 3.2], [5.2, 5.2, 5.2]),
    supports: null,
    layout: { nx: 10, ny: 10, nz: 10 },
    opts: { floor: false },
  };
}

async function runTransferred(request: Request): Promise<Reply[]> {
  const incoming = structuredClone(request, { transfer: requestTransferables(request) });
  const replies: Reply[] = [];
  await dispatchMessage(incoming, (reply, transfer) => {
    const received = structuredClone(reply, { transfer });
    for (const buffer of transfer) expect(buffer.byteLength).toBe(0);
    replies.push(received);
  });
  return replies;
}

describe('geometry worker', () => {
  it('parses binary and ASCII meshes and preserves the request ID', async () => {
    for (const name of ['stl/cube-binary.stl', 'stl/cube-ascii-crlf.stl']) {
      const reply = await handleMessage(parseRequest(name));
      expect(reply).toMatchObject({
        type: 'done',
        id: 17,
        operation: 'parse',
        format: 'stl',
        unitMm: null,
      });
      if (reply.type !== 'done' || reply.operation !== 'parse') throw new Error('Parse failed');
      expect(reply.mesh.triangleCount).toBe(12);
      expect(reply.mesh.positions).toHaveLength(108);
      expect(new Set(reply.mesh.positions)).toEqual(new Set([0, 1]));
    }
  });

  for (const [name, format, unitMm, maximum] of [
    ['obj/quad-cube.obj', 'obj', null, 300],
    ['3mf/stored.3mf', '3mf', 1, 300],
    ['3mf/single-object.3mf', '3mf', 1, 300],
    ['3mf/inch.3mf', '3mf', 25.4, 7620],
  ] as const) {
    it(`transfers ${name} with format and units`, async () => {
      const request = { ...parseRequest(name), fileName: 'misnamed.step' };
      const replies = await runTransferred(request);
      expect(request.bytes.byteLength).toBe(0);
      expect(replies).toMatchObject([
        { type: 'progress', id: 17, operation: 'parse', fraction: 0 },
        { type: 'progress', id: 17, operation: 'parse', fraction: 1 },
        { type: 'done', id: 17, operation: 'parse', format, unitMm, mesh: { triangleCount: 12 } },
      ]);
      const done = replies[2];
      if (done?.type !== 'done' || done.operation !== 'parse') throw new Error('Parse failed');
      expect(done.mesh.positions).toHaveLength(108);
      expect(new Set(done.mesh.positions)).toEqual(new Set([0, maximum]));
    });
  }

  for (const [name, kind] of [
    ['3mf/unsupported-method.3mf', 'zip-unsupported'],
    ['3mf/missing-model.3mf', 'no-model-part'],
  ]) {
    it(`preserves ${kind} without completion progress or buffers`, async () => {
      const replies = await runTransferred(parseRequest(name));
      expect(replies).toMatchObject([
        { type: 'progress', id: 17, operation: 'parse', fraction: 0 },
        {
          type: 'error',
          id: 17,
          operation: 'parse',
          error: { kind, byteOffset: expect.any(Number), message: expect.any(String) },
        },
      ]);
      for (const reply of replies) expect(replyTransferables(reply)).toEqual([]);
    });
  }

  it('preserves XML error part details', async () => {
    const replies = await runTransferred({
      type: 'parse',
      id: 17,
      fileName: 'invalid.3mf',
      bytes: modelArchive('<model><resources></model>'),
    });
    expect(replies).toMatchObject([
      { type: 'progress', fraction: 0 },
      {
        type: 'error',
        id: 17,
        operation: 'parse',
        error: {
          kind: 'bad-xml',
          part: MODEL_PATH,
          byteOffset: expect.any(Number),
          message: expect.any(String),
        },
      },
    ]);
  });

  it('uses the filename to return CAD export hints', async () => {
    const reply = await handleMessage({
      type: 'parse',
      id: 17,
      fileName: 'part.STEP',
      bytes: new TextEncoder().encode('ISO-10303-21;').buffer,
    });
    expect(reply).toMatchObject({
      type: 'error',
      id: 17,
      operation: 'parse',
      error: { kind: 'unsupported-cad', byteOffset: 0, message: expect.stringContaining('Export') },
    });
  });

  for (const name of ['obj/quad-cube.obj', '3mf/single-object.3mf']) {
    it(`honors triangle limits for ${name}`, async () => {
      expect(await handleMessage({ ...parseRequest(name), maxTriangles: 11 })).toMatchObject({
        type: 'error',
        id: 17,
        operation: 'parse',
        error: { kind: 'too-many-triangles' },
      });
    });
  }

  it('preserves parse error kinds and byte offsets', async () => {
    expect(await handleMessage(parseRequest('stl/truncated.stl'))).toMatchObject({
      type: 'error',
      id: 17,
      operation: 'parse',
      error: { kind: 'truncated', message: expect.any(String), byteOffset: expect.any(Number) },
    });
    expect(await handleMessage({ ...parseRequest(), maxTriangles: 11 })).toMatchObject({
      type: 'error',
      error: { kind: 'too-many-triangles', byteOffset: 80 },
    });
  });

  it('returns voxel counts, packed geometry and boundary links', async () => {
    const reply = await handleMessage(voxelRequest());
    expect(reply).toMatchObject({
      type: 'done',
      id: 18,
      operation: 'voxelize',
      grid: { nx: 10, ny: 10, nz: 10, solidCells: 8, frontalCells: 4, watertight: true },
    });
    if (reply.type !== 'done' || reply.operation !== 'voxelize') throw new Error('Voxelize failed');
    expect(reply.grid.geometry.length).toBeGreaterThanOrEqual(1000);
    expect(reply.grid.boundaryCells.length).toBeGreaterThan(0);
    expect(reply.grid.geometry[4 + 10 * (4 + 10 * 4)]).toBe(CellType.SOLID);
  });

  it('passes supports and floor options to voxelization', async () => {
    const request = voxelRequest();
    request.supports = box([6.2, 3.2, 3.2], [7.2, 5.2, 5.2]);
    request.opts.floor = true;
    const reply = await handleMessage(request);
    if (reply.type !== 'done' || reply.operation !== 'voxelize') throw new Error('Voxelize failed');
    expect(reply.grid.geometry[7 + 10 * (4 + 10 * 4)]).toBe(CellType.SUPPORT);
    expect(reply.grid.geometry[4 + 10 * 4]).toBe(CellType.FLOOR);
    expect(reply.grid.frontalCells).toBe(4);
  });

  it('reports a subcell plate as an actionable error', async () => {
    const request = voxelRequest();
    request.body = box([3.2, 3.2, 3.2], [3.5, 5.2, 5.2]);
    expect(await handleMessage(request)).toEqual({
      type: 'error',
      id: 18,
      operation: 'voxelize',
      error: { kind: 'no-solid-cells', message: 'no solid cells at this size' },
    });
  });

  it('converts thrown validation failures into correlated errors', async () => {
    expect(await handleMessage({ ...parseRequest(), maxTriangles: -1 })).toMatchObject({
      type: 'error',
      id: 17,
      operation: 'parse',
      error: { kind: 'operation-failed' },
    });
    expect(
      await handleMessage({ ...voxelRequest(), layout: { nx: 1, ny: 10, nz: 10 } }),
    ).toMatchObject({
      type: 'error',
      id: 18,
      operation: 'voxelize',
      error: {
        kind: 'operation-failed',
        message: 'Grid dimensions must be integers of at least two cells.',
      },
    });
  });

  it('transfers parse input and output and emits ordered progress', async () => {
    const request = parseRequest();
    const replies = await runTransferred(request);
    expect(request.bytes.byteLength).toBe(0);
    expect(replies).toMatchObject([
      { type: 'progress', id: 17, operation: 'parse', fraction: 0 },
      { type: 'progress', id: 17, operation: 'parse', fraction: 1 },
      { type: 'done', id: 17, operation: 'parse', mesh: { triangleCount: 12 } },
    ]);
    const done = replies[2];
    if (done?.type !== 'done' || done.operation !== 'parse') throw new Error('Parse failed');
    expect(done.mesh.positions).toHaveLength(108);
  });

  it('transfers body, supports and both output grid buffers', async () => {
    const request = voxelRequest();
    request.supports = box([6.2, 3.2, 3.2], [7.2, 5.2, 5.2]);
    const replies = await runTransferred(request);
    expect(request.body.positions.byteLength).toBe(0);
    expect(request.supports.positions.byteLength).toBe(0);
    const done = replies[2];
    if (done?.type !== 'done' || done.operation !== 'voxelize') throw new Error('Voxelize failed');
    expect(done.grid.solidCells).toBe(8);
    expect(done.grid.boundaryCells.length).toBeGreaterThan(0);
    expect(replyTransferables(done)).toHaveLength(2);
  });

  it('deduplicates aliased mesh buffers without making copies', async () => {
    const request = voxelRequest();
    request.supports = request.body;
    expect(requestTransferables(request)).toEqual([request.body.positions.buffer]);
    expect(requestTransferables(request)[0]).toBe(request.body.positions.buffer);
    expect((await runTransferred(request))[2]).toHaveProperty('type', 'done');
  });

  it('rejects shared storage rather than copying it for transfer', () => {
    const request = voxelRequest();
    request.body.positions = new Float32Array(new SharedArrayBuffer(108 * 4));
    expect(() => requestTransferables(request)).toThrow('transferable ArrayBuffers');
  });

  it('sends errors without buffers or a completion progress event', async () => {
    const replies = await runTransferred(parseRequest('stl/truncated.stl'));
    expect(replies).toMatchObject([
      { type: 'progress', fraction: 0 },
      { type: 'error', operation: 'parse', error: { kind: 'truncated' } },
    ]);
    for (const reply of replies) expect(replyTransferables(reply)).toEqual([]);
  });
});
