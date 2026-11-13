import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellType, NO_Q, type VoxelGrid } from '../../src/geometry/voxel-grid';
import { AllocationFailure, GpuSolver, packSolverParams } from '../../src/lbm/gpu-solver';
import { gpuFixture } from './gpu-fixture';

const layout = { nx: 32, ny: 16, nz: 8 };
const params = { tau0: 0.8, uIn: 0.04, les: false };

describe('GPU solver uniforms', () => {
  it('packs the twelve WGSL scalars with their integer and float representations', () => {
    const data = packSolverParams(layout, params, true);
    const integers = new Uint32Array(data);
    const floats = new Float32Array(data);
    expect(data.byteLength).toBe(48);
    expect([...integers.slice(0, 4)]).toEqual([32, 16, 8, 4096]);
    expect(floats[4]).toBe(Math.fround(0.04));
    expect(floats[5]).toBe(Math.fround(0.1));
    expect(floats[6]).toBe(Math.fround(18 * Math.SQRT2 * 0.1 ** 2));
    expect(floats[7]).toBe(3 / 16);
    expect([...integers.slice(8)]).toEqual([0, 0, 1, 0]);
  });

  it('keeps macro output and LES independent', () => {
    const data = packSolverParams(layout, { ...params, les: true }, false);
    expect([...new Uint32Array(data).slice(8)]).toEqual([1, 0, 0, 0]);
  });

  it.each([
    ['bb', 0],
    ['bouzidi', 1],
  ] as const)('packs %s walls as mode %s', (walls, mode) => {
    const data = packSolverParams(layout, { ...params, walls }, false);
    expect([...new Uint32Array(data).slice(8)]).toEqual([0, mode, 0, 0]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid grid dimension %s', (nx) => {
    expect(() => packSolverParams({ ...layout, nx }, params, false)).toThrow(RangeError);
  });

  it.each([0.5, 0, NaN, Infinity, 1e100, 0.5 + Number.EPSILON, 0.5 + 2 ** -26])(
    'rejects invalid relaxation time %s',
    (tau0) => {
      expect(() => packSolverParams(layout, { ...params, tau0 }, false)).toThrow(RangeError);
    },
  );

  it.each([1e100, -1e100, Infinity, -Infinity])('rejects speeds that overflow f32: %s', (uIn) => {
    expect(() => packSolverParams(layout, { ...params, uIn }, false)).toThrow(RangeError);
  });

  it('accepts the first f32 relaxation time above one half', () => {
    const data = packSolverParams(layout, { ...params, tau0: 0.5 + 2 ** -24 }, false);
    const nu = new Float32Array(data)[5] ?? NaN;
    expect(Math.fround(Math.fround(3 * nu) + 0.5)).toBe(0.5 + 2 ** -24);
  });

  it('rejects non-finite speeds and population indices outside u32', () => {
    expect(() => packSolverParams(layout, { ...params, uIn: NaN }, false)).toThrow(RangeError);
    expect(() => packSolverParams({ nx: 65536, ny: 65536, nz: 1 }, params, false)).toThrow(
      RangeError,
    );
  });
});

function failingDevice(failAt: number, synchronousError?: Error) {
  vi.stubGlobal('GPUBufferUsage', { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
  const buffers: GPUBuffer[] = [];
  let attempts = 0;
  const scopes: GPUErrorFilter[] = [];
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    features: new Set<string>(),
    pushErrorScope: vi.fn<GPUDevice['pushErrorScope']>().mockImplementation((filter) => {
      scopes.push(filter);
    }),
    popErrorScope: vi
      .fn<GPUDevice['popErrorScope']>()
      .mockImplementation(async () =>
        scopes.pop() === 'out-of-memory' && attempts === failAt
          ? { message: 'Allocation failed' }
          : null,
      ),
    createBuffer: vi.fn<GPUDevice['createBuffer']>().mockImplementation((descriptor) => {
      attempts += 1;
      if (attempts === failAt && synchronousError) throw synchronousError;
      const buffer: GPUBuffer = {
        label: descriptor.label ?? '',
        size: descriptor.size,
        usage: descriptor.usage,
        mapState: 'unmapped',
        destroy: vi.fn(),
        unmap: vi.fn(),
        mapAsync: vi.fn<GPUBuffer['mapAsync']>(),
        getMappedRange: vi.fn<GPUBuffer['getMappedRange']>(),
      };
      buffers.push(buffer);
      return buffer;
    }),
    queue: { writeBuffer: vi.fn<GPUQueue['writeBuffer']>(), submit: vi.fn<GPUQueue['submit']>() },
    createBindGroupLayout: vi.fn<GPUDevice['createBindGroupLayout']>(),
    createPipelineLayout: vi.fn<GPUDevice['createPipelineLayout']>(),
    createShaderModule: vi.fn<GPUDevice['createShaderModule']>(),
    createComputePipeline: vi.fn<GPUDevice['createComputePipeline']>(),
    createBindGroup: vi.fn<GPUDevice['createBindGroup']>(),
    createCommandEncoder: vi.fn<GPUDevice['createCommandEncoder']>(),
  };
  return { device, buffers };
}

describe('GPU solver allocation failures', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cells = layout.nx * layout.ny * layout.nz;
  const geometry = new Uint32Array(2 * cells);
  geometry.fill(NO_Q, cells);
  const grid: VoxelGrid = {
    ...layout,
    geometry,
    boundaryCells: new Uint32Array(),
    solidCells: 0,
    frontalCells: 0,
    blockage: 0,
    watertight: true,
    missedLinks: 0,
  };

  it.each([1, 8])(
    'stops at OOM allocation %s and destroys every allocated buffer',
    async (failAt) => {
      const { device, buffers } = failingDevice(failAt);
      const result = await GpuSolver.create(device, layout, grid, params);
      expect(result).toBeInstanceOf(AllocationFailure);
      if (!(result instanceof AllocationFailure))
        throw new Error('Expected an allocation failure.');
      expect(result.message).toBe('Allocation failed');
      expect(device.createBuffer).toHaveBeenCalledTimes(failAt);
      const operations = failAt + Number(failAt > 7);
      expect(device.pushErrorScope.mock.calls).toEqual(
        Array.from({ length: operations }, () => [['out-of-memory'], ['validation']]).flat(),
      );
      expect(device.popErrorScope).toHaveBeenCalledTimes(2 * operations);
      expect(device.queue.submit).not.toHaveBeenCalled();
      for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('balances the error scope and cleans up on a synchronous allocation exception', async () => {
    const error = new RangeError('Allocation size rejected');
    const { device, buffers } = failingDevice(4, error);
    await expect(GpuSolver.create(device, layout, grid, params)).rejects.toBe(error);
    expect(device.popErrorScope).toHaveBeenCalledTimes(8);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([cells, 2 * cells - 1, 2 * cells + 1])(
    'rejects malformed geometry length %s before allocation',
    async (length) => {
      const { device } = failingDevice(1);
      await expect(
        GpuSolver.create(device, layout, { ...grid, geometry: new Uint32Array(length) }, params),
      ).rejects.toThrow(/geometry/i);
      expect(device.createBuffer).not.toHaveBeenCalled();
    },
  );

  it.each([5, 6, 7, 1 << 3, 1 << 22, 1 << 4])(
    'rejects unknown kinds or inconsistent wall flags %s',
    async (flag) => {
      const { device } = failingDevice(1);
      const invalid = geometry.slice();
      invalid[0] = flag;
      await expect(
        GpuSolver.create(device, layout, { ...grid, geometry: invalid }, params),
      ).rejects.toThrow(/geometry|wall|kind/i);
      expect(device.createBuffer).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing pull mask beside a wall', async () => {
    const { device } = failingDevice(1);
    const invalid = geometry.slice();
    invalid[1] = CellType.SOLID;
    await expect(
      GpuSolver.create(device, layout, { ...grid, geometry: invalid }, params),
    ).rejects.toThrow(/wall/i);
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it.each([
    { nx: 65, ny: 1, nz: 1 },
    { nx: 1, ny: 2, nz: 1 },
    { nx: 1, ny: 1, nz: 2 },
  ])('rejects dispatch axes beyond the device limit: %o', async (large) => {
    const { device } = failingDevice(1);
    device.limits.maxComputeWorkgroupsPerDimension = 1;
    const cellCount = large.nx * large.ny * large.nz;
    const geometry = new Uint32Array(2 * cellCount);
    geometry.fill(NO_Q, cellCount);
    await expect(
      GpuSolver.create(device, large, { ...grid, ...large, geometry }, params),
    ).rejects.toThrow(/dispatch.*limit/i);
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it('captures validation failures and cleans up instead of reporting allocation success', async () => {
    const { device, buffers } = failingDevice(0);
    const scopes: GPUErrorFilter[] = [];
    device.pushErrorScope.mockImplementation((filter) => {
      scopes.push(filter);
    });
    device.popErrorScope.mockImplementation(async () =>
      scopes.pop() === 'validation' ? { message: 'Storage binding exceeds device limit' } : null,
    );
    await expect(GpuSolver.create(device, layout, grid, params)).rejects.toThrow(
      /validation.*Storage binding/i,
    );
    expect(scopes).toEqual([]);
    expect(device.queue.submit).not.toHaveBeenCalled();
    expect(buffers).toHaveLength(1);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('GPU solver construction and reset', () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it('initializes and resets both population states before stepping', async () => {
    const { device, pass, encoder, buffers } = gpuFixture();
    const solver = await GpuSolver.create(device, layout, grid, params);
    if (solver instanceof AllocationFailure) throw solver;
    expect(pass.dispatchWorkgroups.mock.calls).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const initialized = pass.setBindGroup.mock.calls.map((call) => call[1]);
    solver.step(encoder, 1, true);
    solver.reset(encoder);
    expect(pass.setBindGroup.mock.calls.slice(-2).map((call) => call[1])).toEqual(initialized);
    expect(solver.stepCount).toBe(0);
    expect(device.queue.submit).toHaveBeenCalledOnce();
    solver.destroy();
    solver.destroy();
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it('stores f16 populations in aligned half-width buffers from the f16 prelude', async () => {
    const { device, buffers } = gpuFixture();
    device.features.add('shader-f16');
    const solver = await GpuSolver.create(device, layout, grid, { ...params, precision: 'f16' });
    if (solver instanceof AllocationFailure) throw solver;
    const size = (label: string): number | undefined =>
      buffers.find((buffer) => buffer.label === label)?.size;
    expect(size('populations A 0..6')).toBe(44);
    expect(size('populations A 7..12')).toBe(36);
    expect(size('populations B 13..18')).toBe(36);
    const code = device.createShaderModule.mock.calls[0]?.[0]?.code ?? '';
    expect(code).toContain('enable f16;');
    expect(code).toContain('alias pop = f16;');
    solver.destroy();
  });

  it('refuses f16 storage when the adapter does not advertise shader-f16', async () => {
    const { device } = gpuFixture();
    await expect(
      GpuSolver.create(device, layout, grid, { ...params, precision: 'f16' }),
    ).rejects.toThrow(/shader-f16/);
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it.each([
    'createBindGroupLayout',
    'createShaderModule',
    'createComputePipeline',
    'createBindGroup',
    'createCommandEncoder',
  ] as const)('cleans up after %s throws', async (operation) => {
    const { device, buffers, scopes } = gpuFixture();
    const error = new Error('Construction rejected');
    device[operation].mockImplementation(() => {
      throw error;
    });
    await expect(GpuSolver.create(device, layout, grid, params)).rejects.toBe(error);
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(scopes).toEqual([]);
    expect(device.queue.submit).not.toHaveBeenCalled();
  });

  it.each(['validation', 'out-of-memory'] as const)(
    'cleans up when pipeline construction reports %s',
    async (filter) => {
      const { device, buffers, scopes } = gpuFixture();
      const pipeline = device.createComputePipeline.getMockImplementation();
      if (!pipeline) throw new Error('Missing pipeline fixture.');
      let failed = false;
      device.createComputePipeline.mockImplementation((descriptor) => {
        failed = true;
        return pipeline(descriptor);
      });
      device.popErrorScope.mockImplementation(async () =>
        scopes.pop() === filter && failed ? { message: 'Pipeline failed' } : null,
      );
      const pending = GpuSolver.create(device, layout, grid, params);
      if (filter === 'validation')
        await expect(pending).rejects.toThrow(/validation.*Pipeline failed/);
      else expect(await pending).toBeInstanceOf(AllocationFailure);
      for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(scopes).toEqual([]);
      expect(device.queue.submit).not.toHaveBeenCalled();
    },
  );

  it('cleans up after an initialization dispatch validation failure', async () => {
    const { device, buffers, scopes, pass } = gpuFixture();
    let failed = false;
    pass.dispatchWorkgroups.mockImplementation(() => {
      failed = true;
    });
    device.popErrorScope.mockImplementation(async () =>
      scopes.pop() === 'validation' && failed ? { message: 'Initialization rejected' } : null,
    );
    await expect(GpuSolver.create(device, layout, grid, params)).rejects.toThrow(
      /validation.*Initialization rejected/,
    );
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(scopes).toEqual([]);
    expect(device.queue.submit).not.toHaveBeenCalled();
  });
});
