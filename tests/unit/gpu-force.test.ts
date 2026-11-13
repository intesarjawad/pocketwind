import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_Q, type VoxelGrid } from '../../src/geometry/voxel-grid';
import { AllocationFailure, FORCE_EVERY_STEPS, GpuSolver } from '../../src/lbm/gpu-solver';
import { gpuFixture } from './gpu-fixture';

const layout = { nx: 3, ny: 1, nz: 1 };
const grid: VoxelGrid = {
  ...layout,
  geometry: new Uint32Array([0, 0, 0, NO_Q, NO_Q, NO_Q]),
  boundaryCells: new Uint32Array(),
  solidCells: 0,
  frontalCells: 0,
  blockage: 0,
  watertight: true,
  missedLinks: 0,
};
const params = { tau0: 0.8, uIn: 0.04, les: false };

async function fixture() {
  const gpu = gpuFixture();
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  gpu.device.createBindGroup.mockImplementation(() => ({
    label: String(gpu.device.createBindGroup.mock.calls.length),
  }));
  const solver = await GpuSolver.create(gpu.device, layout, grid, params);
  if (solver instanceof AllocationFailure) throw solver;
  const staging = gpu.buffers.find((buffer) => buffer.label === 'force readback');
  if (!staging) throw new Error('Missing force staging buffer.');
  vi.mocked(staging.getMappedRange).mockReturnValue(new Float32Array([1.25, -0.5, 0, 0]).buffer);
  return { ...gpu, solver, staging };
}

describe('GPU force readback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not map before encoding or read the same sample twice', async () => {
    const { solver, staging, encoder, device } = await fixture();
    expect(await solver.readForce()).toBe('busy');
    expect(staging.mapAsync).not.toHaveBeenCalled();
    solver.encodeForce(encoder);
    device.queue.submit([encoder.finish()]);
    expect(await solver.readForce()).toEqual({ step: 0, fx: 1.25, fy: -0.5, fz: 0 });
    expect(staging.unmap).toHaveBeenCalledOnce();
    expect(await solver.readForce()).toBe('busy');
    expect(staging.mapAsync).toHaveBeenCalledOnce();
    solver.destroy();
  });

  it('sums both ping-pong states into separate partial ranges and keeps the encoded step', async () => {
    const { solver, encoder, device, pass, buffers } = await fixture();
    const forceBindings = device.createBindGroup.mock.calls.filter(([descriptor]) =>
      descriptor.entries.some((entry) => entry.binding === 9),
    );
    expect(forceBindings).toHaveLength(2);
    const partials = buffers.find((buffer) => buffer.label === 'force partials');
    if (!partials) throw new Error('Missing force partials.');
    const ranges = forceBindings.map(([descriptor], state) => {
      const populations = device.createBuffer.mock.results
        .slice(state * 3, state * 3 + 3)
        .map((result) => result.value);
      expect(
        descriptor.entries
          .filter((entry) => entry.binding >= 1 && entry.binding <= 3)
          .map((entry) => entry.resource),
      ).toEqual(populations.map((buffer) => ({ buffer })));
      return descriptor.entries.find((entry) => entry.binding === 10)?.resource;
    });
    // One workgroup's partial rounds up to the 256-byte storage offset alignment.
    expect(ranges).toEqual([
      { buffer: partials, offset: 0, size: 256 },
      { buffer: partials, offset: 256, size: 256 },
    ]);
    const bound = forceBindings.map(([descriptor]) => {
      const index = device.createBindGroup.mock.calls.findIndex(([call]) => call === descriptor);
      return device.createBindGroup.mock.results[index]?.value;
    });
    for (const step of [1, 8, 9]) {
      solver.step(encoder, step - solver.stepCount, false);
      pass.setBindGroup.mockClear();
      solver.encodeForce(encoder);
      expect(pass.setBindGroup.mock.calls.slice(0, 2).map((call) => call[1])).toEqual(bound);
      solver.step(encoder, 1, false);
      device.queue.submit([encoder.finish()]);
      expect(await solver.readForce()).toEqual({ step, fx: 1.25, fy: -0.5, fz: 0 });
    }
    expect(FORCE_EVERY_STEPS).toBe(8);
    solver.destroy();
  });

  it('skips copies for unread samples and during mapping, then reuses the slot', async () => {
    const { solver, staging, encoder, device, pass } = await fixture();
    let completeMap: () => void = () => {
      throw new Error('Map was not started.');
    };
    vi.mocked(staging.mapAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeMap = resolve;
        }),
    );
    solver.step(encoder, 8, false);
    solver.encodeForce(encoder);
    const dispatches = pass.dispatchWorkgroups.mock.calls.length;
    solver.step(encoder, 0, false);
    solver.encodeForce(encoder);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledOnce();
    device.queue.submit([encoder.finish()]);
    const pending = solver.readForce();
    expect(await solver.readForce()).toBe('busy');
    solver.encodeForce(encoder);
    expect(pass.dispatchWorkgroups).toHaveBeenCalledTimes(dispatches);
    expect(staging.mapAsync).toHaveBeenCalledExactlyOnceWith(1);
    expect(staging.unmap).not.toHaveBeenCalled();
    completeMap();
    expect(await pending).toEqual({ step: 8, fx: 1.25, fy: -0.5, fz: 0 });
    solver.step(encoder, 8, false);
    solver.encodeForce(encoder);
    device.queue.submit([encoder.finish()]);
    expect(await solver.readForce()).toEqual({ step: 16, fx: 1.25, fy: -0.5, fz: 0 });
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledTimes(2);
    solver.destroy();
  });

  it('releases the slot after a rejected map or range access', async () => {
    const { solver, staging, encoder } = await fixture();
    const error = new Error('Device lost');
    vi.mocked(staging.mapAsync).mockRejectedValueOnce(error);
    solver.encodeForce(encoder);
    await expect(solver.readForce()).rejects.toBe(error);
    vi.mocked(staging.getMappedRange).mockImplementationOnce(() => {
      throw error;
    });
    solver.encodeForce(encoder);
    await expect(solver.readForce()).rejects.toBe(error);
    solver.encodeForce(encoder);
    expect(await solver.readForce()).toEqual({ step: 0, fx: 1.25, fy: -0.5, fz: 0 });
    expect(staging.unmap).toHaveBeenCalledTimes(3);
    solver.destroy();
  });

  it('discards unread samples on reset and rejects use after destruction', async () => {
    const { solver, encoder } = await fixture();
    solver.encodeForce(encoder);
    solver.reset(encoder);
    expect(await solver.readForce()).toBe('busy');
    solver.encodeForce(encoder);
    expect(await solver.readForce()).toMatchObject({ step: 0 });
    solver.destroy();
    expect(() => solver.encodeForce(encoder)).toThrow(/destroyed/);
    await expect(solver.readForce()).rejects.toThrow(/destroyed/);
  });

  it('preserves an in-flight sample across reset without reusing mapped storage', async () => {
    const { solver, staging, encoder } = await fixture();
    let completeMap: () => void = () => {
      throw new Error('Map was not started.');
    };
    vi.mocked(staging.mapAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeMap = resolve;
        }),
    );
    solver.step(encoder, 8, false);
    solver.encodeForce(encoder);
    const pending = solver.readForce();
    solver.reset(encoder);
    solver.encodeForce(encoder);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledOnce();
    completeMap();
    expect(await pending).toMatchObject({ step: 8 });
    solver.encodeForce(encoder);
    expect(await solver.readForce()).toMatchObject({ step: 0 });
    solver.destroy();
  });

  it.each([0, 3, 0xffffffff])(
    'rejects a boundary entry without valid fluid wall links: %s',
    async (cell) => {
      const { device, buffers } = gpuFixture();
      await expect(
        GpuSolver.create(
          device,
          layout,
          { ...grid, boundaryCells: new Uint32Array([cell]) },
          params,
        ),
      ).rejects.toThrow(/Boundary cells/);
      for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(device.queue.submit).not.toHaveBeenCalled();
    },
  );

  it('cleans up every buffer if force storage runs out of memory', async () => {
    const { device, buffers, scopes } = gpuFixture();
    const createBuffer = device.createBuffer.getMockImplementation();
    if (!createBuffer) throw new Error('Missing buffer fixture.');
    let failed = false;
    device.createBuffer.mockImplementation((descriptor) => {
      failed = descriptor.label === 'force partials';
      return createBuffer(descriptor);
    });
    device.popErrorScope.mockImplementation(async () =>
      scopes.pop() === 'out-of-memory' && failed ? { message: 'Force allocation failed' } : null,
    );
    expect(await GpuSolver.create(device, layout, grid, params)).toBeInstanceOf(AllocationFailure);
    expect(device.queue.submit).not.toHaveBeenCalled();
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(scopes).toEqual([]);
  });
});
