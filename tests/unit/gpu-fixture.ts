import { vi } from 'vitest';

export function gpuFixture() {
  vi.stubGlobal('GPUBufferUsage', {
    COPY_SRC: 4,
    COPY_DST: 8,
    MAP_READ: 1,
    UNIFORM: 64,
    STORAGE: 128,
  });
  vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
  const buffers: GPUBuffer[] = [];
  const scopes: GPUErrorFilter[] = [];
  const pass = {
    label: '',
    setPipeline: vi.fn<GPUComputePassEncoder['setPipeline']>(),
    setBindGroup: vi.fn<GPUComputePassEncoder['setBindGroup']>(),
    dispatchWorkgroups: vi.fn<GPUComputePassEncoder['dispatchWorkgroups']>(),
    dispatchWorkgroupsIndirect: vi.fn<GPUComputePassEncoder['dispatchWorkgroupsIndirect']>(),
    end: vi.fn<GPUComputePassEncoder['end']>(),
    insertDebugMarker: vi.fn(),
    popDebugGroup: vi.fn(),
    pushDebugGroup: vi.fn(),
  };
  const encoder = {
    label: '',
    beginComputePass: vi.fn<GPUCommandEncoder['beginComputePass']>().mockReturnValue(pass),
    beginRenderPass: vi.fn<GPUCommandEncoder['beginRenderPass']>(),
    clearBuffer: vi.fn<GPUCommandEncoder['clearBuffer']>(),
    copyBufferToBuffer: vi.fn<(...args: unknown[]) => void>(),
    copyBufferToTexture: vi.fn<(...args: unknown[]) => void>(),
    copyTextureToBuffer: vi.fn<(...args: unknown[]) => void>(),
    copyTextureToTexture: vi.fn<(...args: unknown[]) => void>(),
    resolveQuerySet: vi.fn<GPUCommandEncoder['resolveQuerySet']>(),
    finish: vi.fn<GPUCommandEncoder['finish']>().mockReturnValue({ label: '' }),
    insertDebugMarker: vi.fn(),
    popDebugGroup: vi.fn(),
    pushDebugGroup: vi.fn(),
  };
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    features: new Set<string>(),
    pushErrorScope: vi.fn<GPUDevice['pushErrorScope']>().mockImplementation((filter) => {
      scopes.push(filter);
    }),
    popErrorScope: vi.fn<GPUDevice['popErrorScope']>().mockImplementation(async () => {
      scopes.pop();
      return null;
    }),
    createBuffer: vi.fn<GPUDevice['createBuffer']>().mockImplementation((descriptor) => {
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
    createBindGroupLayout: vi
      .fn<GPUDevice['createBindGroupLayout']>()
      .mockReturnValue({ label: '' }),
    createPipelineLayout: vi.fn<GPUDevice['createPipelineLayout']>().mockReturnValue({ label: '' }),
    createShaderModule: vi.fn<GPUDevice['createShaderModule']>().mockReturnValue({
      label: '',
      getCompilationInfo: vi.fn<GPUShaderModule['getCompilationInfo']>(),
    }),
    createComputePipeline: vi.fn<GPUDevice['createComputePipeline']>().mockReturnValue({
      label: '',
      getBindGroupLayout: vi
        .fn<GPUComputePipeline['getBindGroupLayout']>()
        .mockReturnValue({ label: '' }),
    }),
    createBindGroup: vi.fn<GPUDevice['createBindGroup']>().mockReturnValue({ label: '' }),
    createCommandEncoder: vi.fn<GPUDevice['createCommandEncoder']>().mockReturnValue(encoder),
    queue: {
      writeBuffer: vi.fn<GPUQueue['writeBuffer']>(),
      submit: vi.fn<GPUQueue['submit']>(),
      onSubmittedWorkDone: vi.fn<GPUQueue['onSubmittedWorkDone']>(),
    },
  };
  return { device, buffers, scopes, pass, encoder };
}
