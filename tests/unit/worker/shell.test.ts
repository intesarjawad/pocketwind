import { expect, it, vi } from 'vitest';
import type { Reply, Request } from '../../../src/geometry/worker-protocol';

it('registers the message listener and transfers replies through the worker scope', async () => {
  const listeners: Array<(event: { data: Request }) => Promise<void>> = [];
  const replies: Reply[] = [];
  const scope = {
    importScripts() {},
    addEventListener(type: string, listener: (event: { data: Request }) => Promise<void>) {
      expect(type).toBe('message');
      listeners.push(listener);
    },
    postMessage(reply: Reply, options: { transfer: ArrayBuffer[] }) {
      replies.push(structuredClone(reply, options));
      for (const buffer of options.transfer) expect(buffer.byteLength).toBe(0);
    },
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  try {
    await import('../../../src/geometry/worker');
    expect(listeners).toHaveLength(1);
    const listener = listeners[0];
    if (!listener) throw new Error('Missing message listener');
    const bytes = new TextEncoder().encode(
      'solid triangle\nfacet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet\nendsolid triangle',
    ).buffer;
    await listener({ data: { type: 'parse', id: 23, bytes, fileName: 'triangle.stl' } });
    expect(replies).toMatchObject([
      { type: 'progress', id: 23, operation: 'parse', fraction: 0 },
      { type: 'progress', id: 23, operation: 'parse', fraction: 1 },
      {
        type: 'done',
        id: 23,
        operation: 'parse',
        format: 'stl',
        unitMm: null,
        mesh: { triangleCount: 1 },
      },
    ]);
    const done = replies[2];
    if (done?.type !== 'done' || done.operation !== 'parse') throw new Error('Parse failed');
    expect(Array.from(done.mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
