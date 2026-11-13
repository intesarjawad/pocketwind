import { parseModel } from './model';
import { voxelize } from './voxelize';
import { type Reply, type Request, replyTransferables } from './worker-protocol';

/** Parse or voxelize one request without worker globals or message side effects. */
export async function handleMessage(
  message: Request,
): Promise<Exclude<Reply, { type: 'progress' }>> {
  const { id, type: operation } = message;
  try {
    switch (message.type) {
      case 'parse': {
        const result = await parseModel(message.bytes, message.fileName, message.maxTriangles);
        return 'kind' in result
          ? { type: 'error', id, operation, error: result }
          : {
              type: 'done',
              id,
              operation: 'parse',
              mesh: result.mesh,
              format: result.format,
              unitMm: result.unitMm,
            };
      }
      case 'voxelize': {
        const grid = voxelize(message.body, message.supports, message.layout, message.opts);
        if (grid.solidCells === 0) {
          return {
            type: 'error',
            id,
            operation,
            error: { kind: 'no-solid-cells', message: 'no solid cells at this size' },
          };
        }
        return { type: 'done', id, operation: 'voxelize', grid };
      }
    }
  } catch (error) {
    return {
      type: 'error',
      id,
      operation,
      error: {
        kind: 'operation-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Emit coarse operation progress and transfer the terminal result without cloning buffers. */
export async function dispatchMessage(
  message: Request,
  postReply: (reply: Reply, transfer: ArrayBuffer[]) => void,
): Promise<void> {
  const progress = { type: 'progress', id: message.id, operation: message.type } as const;
  postReply({ ...progress, fraction: 0 }, []);
  const reply = await handleMessage(message);
  if (reply.type === 'done') postReply({ ...progress, fraction: 1 }, []);
  postReply(reply, replyTransferables(reply));
}

// importScripts distinguishes a worker scope from Window, including module workers.
if (typeof self !== 'undefined' && 'importScripts' in self) {
  self.addEventListener('message', async (event: MessageEvent<Request>) => {
    await dispatchMessage(event.data, (reply, transfer) => self.postMessage(reply, { transfer }));
  });
}
