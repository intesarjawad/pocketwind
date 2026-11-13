import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllocationFailure } from '../../src/lbm/gpu-solver';
import { TIERS } from '../../src/lbm/layout';
import {
  isUnstableDensity,
  NanGuard,
  nanGuardDispatchSize,
  resetUnstableRun,
} from '../../src/lbm/nan-guard';
import { gpuFixture } from './gpu-fixture';

describe('density guard', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cell count %s',
    (cells) => {
      expect(() => nanGuardDispatchSize(cells)).toThrow(RangeError);
    },
  );
  it.each(Object.entries(TIERS))('covers tier %s within baseline dispatch limits', (_, layout) => {
    const cells = layout.nx * layout.ny * layout.nz;
    const [x, y] = nanGuardDispatchSize(cells);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeLessThanOrEqual(65535);
    expect(y).toBeLessThanOrEqual(65535);
    expect(x * y * 64).toBeGreaterThanOrEqual(cells);
    expect(x * y * 64 - cells).toBeLessThan(x * 64);
  });

  it.each([0.5, 1, 1.5])('accepts physical density %s', (rho) => {
    expect(isUnstableDensity(rho)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 0.5 - 2 ** -25, 1.5 + 2 ** -23, 0, -1])(
    'rejects non-finite or out-of-range density %s',
    (rho) => {
      expect(isUnstableDensity(rho)).toBe(true);
    },
  );

  it('waits for equilibrium before emitting the step and both message parts', async () => {
    const events = new EventTarget();
    const received: unknown[] = [];
    events.addEventListener('unstable', (event) => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected instability details.');
      received.push(event.detail);
    });
    const completion = Promise.withResolvers<void>();
    const reset = vi.fn(() => completion.promise);
    const recovering = resetUnstableRun(600, reset, events);
    expect(reset).toHaveBeenCalledExactlyOnceWith();
    expect(received).toEqual([]);
    completion.resolve();
    const message = await recovering;
    expect(message).toEqual({
      step: 600,
      what: 'The run went unstable at step 600 and was reset',
      next: 'Lower the speed, or choose a higher tier under Advanced',
    });
    expect(received).toEqual([message]);
  });

  it('propagates reset failures without announcing a completed reset', async () => {
    const events = new EventTarget();
    const listener = vi.fn();
    events.addEventListener('unstable', listener);
    const error = new Error('Device lost');
    await expect(resetUnstableRun(600, () => Promise.reject(error), events)).rejects.toBe(error);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('density guard construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture(cells = 65) {
    const gpu = gpuFixture();
    const solver = {
      step: vi.fn(),
      stepCount: 0,
      reset: vi.fn(),
      injectNaNForRunner: vi.fn(),
      macroBuffer: gpu.device.createBuffer({ size: cells * 16, usage: 128 }),
    };
    return { ...gpu, solver };
  }

  it.each([2, 3])('cleans up after allocation %s throws', async (failAt) => {
    const { device, solver, buffers, scopes } = fixture();
    const allocate = device.createBuffer.getMockImplementation();
    if (!allocate) throw new Error('Missing buffer allocation fixture.');
    const error = new Error('Allocation rejected');
    device.createBuffer.mockImplementation((descriptor) => {
      if (buffers.length + 1 === failAt) throw error;
      return allocate(descriptor);
    });
    await expect(NanGuard.create(device, solver)).rejects.toBe(error);
    for (const buffer of buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(solver.macroBuffer.destroy).not.toHaveBeenCalled();
    expect(scopes).toEqual([]);
  });

  it.each(['validation', 'out-of-memory'] as const)(
    'captures asynchronous %s errors and cleans up',
    async (filter) => {
      const { device, solver, buffers, scopes } = fixture();
      device.popErrorScope.mockImplementation(async () =>
        scopes.pop() === filter ? { message: 'Guard creation failed' } : null,
      );
      const pending = NanGuard.create(device, solver);
      if (filter === 'out-of-memory')
        await expect(pending).rejects.toBeInstanceOf(AllocationFailure);
      else await expect(pending).rejects.toThrow(/validation.*Guard creation failed/);
      expect(buffers).toHaveLength(3);
      for (const buffer of buffers.slice(1))
        expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(solver.macroBuffer.destroy).not.toHaveBeenCalled();
      expect(scopes).toEqual([]);
    },
  );

  it('cleans up when pipeline construction throws', async () => {
    const { device, solver, buffers, scopes } = fixture();
    device.createComputePipeline.mockImplementation(() => {
      throw new Error('Pipeline rejected');
    });
    await expect(NanGuard.create(device, solver)).rejects.toThrow('Pipeline rejected');
    for (const buffer of buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(scopes).toEqual([]);
  });

  it('rejects an oversized dispatch before allocating or encoding', async () => {
    const { device, solver, pass } = fixture(257);
    device.limits.maxComputeWorkgroupsPerDimension = 2;
    await expect(NanGuard.create(device, solver)).rejects.toThrow(/dispatch.*limit/i);
    expect(device.createBuffer).toHaveBeenCalledTimes(1);
    expect(pass.dispatchWorkgroups).not.toHaveBeenCalled();
  });

  it('tiles a valid check within device limits and destroys its own buffers once', async () => {
    const { device, solver, buffers, pass, encoder } = fixture(256);
    device.limits.maxComputeWorkgroupsPerDimension = 2;
    const guard = await NanGuard.create(device, solver);
    const readback = buffers[2];
    if (!readback) throw new Error('Missing guard readback.');
    vi.mocked(readback.getMappedRange).mockReturnValue(new ArrayBuffer(4));
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    solver.step.mockImplementation((_encoder: GPUCommandEncoder, count: number) => {
      solver.stepCount += count;
    });
    await guard.advance(200);
    expect(pass.dispatchWorkgroups).toHaveBeenCalledExactlyOnceWith(2, 2);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalled();
    expect(solver.stepCount).toBe(200);
    guard.destroy();
    guard.destroy();
    for (const buffer of buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(solver.macroBuffer.destroy).not.toHaveBeenCalled();
  });
});
