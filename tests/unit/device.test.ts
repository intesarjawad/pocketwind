import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRID_LIMITS, detectGpu, XL_LIMITS, xlAvailability } from '../../src/gpu/device';

function gpuFixture() {
  const device = { destroy: vi.fn() };
  const adapter = {
    features: new Set<string>(),
    limits: { ...DEFAULT_GRID_LIMITS },
    requestDevice: vi
      .fn<(descriptor: GPUDeviceDescriptor) => Promise<typeof device>>()
      .mockResolvedValue(device),
  };
  const gpu = {
    requestAdapter: vi.fn<() => Promise<typeof adapter | null>>().mockResolvedValue(adapter),
  };
  return { gpu, adapter, device };
}

describe('WebGPU feature detection', () => {
  it('supports browsers without a WebGPU API', async () => {
    expect(await detectGpu(undefined)).toEqual({ status: 'unsupported', reason: 'webgpu-missing' });
  });

  it('reports an absent or rejected adapter without throwing', async () => {
    const { gpu } = gpuFixture();
    gpu.requestAdapter.mockResolvedValueOnce(null);
    expect(await detectGpu(gpu)).toEqual({ status: 'unsupported', reason: 'adapter-unavailable' });
    gpu.requestAdapter.mockRejectedValueOnce(new Error('GPU blocked'));
    expect(await detectGpu(gpu)).toEqual({ status: 'unsupported', reason: 'adapter-unavailable' });
  });

  it('reports device creation failure', async () => {
    const { gpu, adapter } = gpuFixture();
    adapter.requestDevice.mockRejectedValueOnce(new Error('GPU unavailable'));
    expect(await detectGpu(gpu)).toEqual({ status: 'unsupported', reason: 'device-unavailable' });
  });

  it('uses default limits and requests f16 only when advertised', async () => {
    const { gpu, adapter, device } = gpuFixture();
    expect(await detectGpu(gpu)).toEqual({
      status: 'supported',
      device,
      features: [],
      tierPolicy: 's-m-l',
      xl: { available: false, reason: 'maxStorageBufferBindingSize' },
    });
    expect(adapter.requestDevice).toHaveBeenLastCalledWith({ requiredFeatures: [] });
    adapter.features.add('shader-f16');
    adapter.features.add('timestamp-query');
    expect(await detectGpu(gpu)).toEqual({
      status: 'supported',
      device,
      features: ['shader-f16', 'timestamp-query'],
      tierPolicy: 's-m-l',
      xl: { available: false, reason: 'maxStorageBufferBindingSize' },
    });
    expect(adapter.requestDevice).toHaveBeenLastCalledWith({ requiredFeatures: ['shader-f16'] });
  });

  it.each([
    'maxStorageBufferBindingSize',
    'maxBufferSize',
    'maxStorageBuffersPerShaderStage',
  ] as const)('restricts grids to S below the %s assumption', async (limit) => {
    const { gpu, adapter } = gpuFixture();
    adapter.limits[limit] -= 1;
    expect(await detectGpu(gpu)).toMatchObject({ status: 'supported', tierPolicy: 's-only' });
    expect(adapter.requestDevice).toHaveBeenCalledWith({ requiredFeatures: [] });
  });

  it('asks for XL limits only when XL is wanted and the adapter allows them', async () => {
    const { gpu, adapter } = gpuFixture();
    adapter.limits.maxStorageBufferBindingSize = 2147483644;
    adapter.limits.maxBufferSize = 2147483644;
    expect(await detectGpu(gpu)).toMatchObject({
      tierPolicy: 's-m-l',
      xl: { available: true },
    });
    expect(adapter.requestDevice).toHaveBeenLastCalledWith({ requiredFeatures: [] });
    expect(await detectGpu(gpu, { xl: true })).toMatchObject({
      tierPolicy: 's-m-l-xl',
      xl: { available: true },
    });
    expect(adapter.requestDevice).toHaveBeenLastCalledWith({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: 396361728,
        maxBufferSize: 396361728,
        maxStorageBuffersPerShaderStage: 8,
      },
    });
  });

  it('makes XL unavailable with a reason on an adapter with default limits', async () => {
    const { gpu, adapter } = gpuFixture();
    expect(await detectGpu(gpu, { xl: true })).toMatchObject({
      status: 'supported',
      tierPolicy: 's-m-l',
      xl: { available: false, reason: 'maxStorageBufferBindingSize' },
    });
    expect(adapter.requestDevice).toHaveBeenLastCalledWith({ requiredFeatures: [] });
  });
});

describe('XL availability', () => {
  it('requires 7 f32 directions of the 384 x 192 x 192 grid in one binding', () => {
    expect(XL_LIMITS.maxStorageBufferBindingSize).toBe(7 * 4 * 14155776);
    expect(XL_LIMITS.maxBufferSize).toBe(396361728);
  });

  it('names the first limit that falls short', () => {
    const roomy = {
      maxStorageBufferBindingSize: 396361728,
      maxBufferSize: 396361728,
      maxStorageBuffersPerShaderStage: 8,
    };
    expect(xlAvailability(roomy)).toEqual({ available: true });
    expect(xlAvailability({ ...roomy, maxStorageBufferBindingSize: 396361727 })).toEqual({
      available: false,
      reason: 'maxStorageBufferBindingSize',
    });
    expect(xlAvailability({ ...roomy, maxBufferSize: 396361727 })).toEqual({
      available: false,
      reason: 'maxBufferSize',
    });
    expect(xlAvailability({ ...roomy, maxStorageBuffersPerShaderStage: 7 })).toEqual({
      available: false,
      reason: 'maxStorageBuffersPerShaderStage',
    });
  });
});
