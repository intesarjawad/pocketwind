import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from '../../scripts/probe-capabilities';

afterEach(() => vi.unstubAllGlobals());

function probeFixture() {
  const device = { destroy: vi.fn() };
  const limits = { maxStorageBuffersPerShaderStage: 8 };
  Object.setPrototypeOf(limits, { maxBufferSize: 256 * 1024 * 1024, label: 'not a limit' });
  const adapter = {
    features: new Set(['timestamp-query', 'shader-f16']),
    limits,
    requestDevice: vi
      .fn<(descriptor: GPUDeviceDescriptor) => Promise<typeof device>>()
      .mockResolvedValue(device),
  };
  const gpu = {
    requestAdapter: vi.fn<() => Promise<typeof adapter | null>>().mockResolvedValue(adapter),
  };
  vi.stubGlobal('navigator', { userAgent: 'test-agent', gpu });
  return { adapter, device, gpu };
}

describe('adapter capability collection', () => {
  it('records absent WebGPU without a device request', async () => {
    vi.stubGlobal('navigator', { userAgent: 'test-agent' });
    expect(await probeCapabilities()).toEqual({
      status: 'missing-api',
      userAgent: 'test-agent',
      features: [],
      limits: {},
    });
  });

  it('records an absent adapter', async () => {
    const { gpu, adapter } = probeFixture();
    gpu.requestAdapter.mockResolvedValueOnce(null);
    expect(await probeCapabilities()).toMatchObject({ status: 'no-adapter' });
    expect(adapter.requestDevice).not.toHaveBeenCalled();
  });

  it('collects inherited numeric limits and features, then releases the device', async () => {
    const { adapter, device } = probeFixture();
    expect(await probeCapabilities()).toEqual({
      status: 'available',
      userAgent: 'test-agent',
      features: ['shader-f16', 'timestamp-query'],
      limits: { maxBufferSize: 268435456, maxStorageBuffersPerShaderStage: 8 },
    });
    expect(adapter.requestDevice).toHaveBeenCalledExactlyOnceWith({
      requiredFeatures: ['shader-f16'],
    });
    expect(device.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it('records capabilities without requesting an unavailable f16 feature', async () => {
    const { adapter } = probeFixture();
    adapter.features.delete('shader-f16');
    expect(await probeCapabilities()).toMatchObject({
      status: 'available',
      features: ['timestamp-query'],
    });
    expect(adapter.requestDevice).toHaveBeenCalledExactlyOnceWith({ requiredFeatures: [] });
  });

  it('preserves features and limits when device creation rejects', async () => {
    const { adapter, device } = probeFixture();
    adapter.requestDevice.mockRejectedValueOnce(new Error('GPU unavailable'));
    expect(await probeCapabilities()).toMatchObject({
      status: 'device-rejected',
      features: ['shader-f16', 'timestamp-query'],
      limits: { maxBufferSize: 268435456 },
    });
    expect(device.destroy).not.toHaveBeenCalled();
  });
});
