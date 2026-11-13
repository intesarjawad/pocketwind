import { describe, expect, it, vi } from 'vitest';
import { withErrorScope } from '../../src/gpu/error-scopes';

describe('GPU error scopes', () => {
  it('returns the allocation when the scope has no error', async () => {
    const device = {
      pushErrorScope: vi.fn<GPUDevice['pushErrorScope']>(),
      popErrorScope: vi.fn<GPUDevice['popErrorScope']>().mockResolvedValue(null),
    };
    const allocation = { size: 1024 };
    expect(await withErrorScope(device, 'out-of-memory', () => allocation)).toEqual({
      status: 'ok',
      value: allocation,
    });
    expect(device.pushErrorScope).toHaveBeenCalledWith('out-of-memory');
    expect(device.popErrorScope).toHaveBeenCalledExactlyOnceWith();
  });

  it('returns an asynchronous GPU error', async () => {
    const error = { message: 'Allocation failed' };
    const device = {
      pushErrorScope: vi.fn<GPUDevice['pushErrorScope']>(),
      popErrorScope: vi.fn<GPUDevice['popErrorScope']>().mockResolvedValue(error),
    };
    expect(await withErrorScope(device, 'out-of-memory', () => ({ size: 1024 }))).toEqual({
      status: 'error',
      error,
    });
  });

  it('pops the scope and preserves synchronous exceptions', async () => {
    const device = {
      pushErrorScope: vi.fn<GPUDevice['pushErrorScope']>(),
      popErrorScope: vi.fn<GPUDevice['popErrorScope']>().mockResolvedValue(null),
    };
    const error = new Error('Invalid descriptor');
    await expect(
      withErrorScope(device, 'validation', () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(device.popErrorScope).toHaveBeenCalledExactlyOnceWith();
  });
});
