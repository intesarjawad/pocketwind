# Browser support

Detection checks the WebGPU API, adapter and device creation. A failure shows its
reason and a browser-specific next step. The tunnel canvas is hidden on that page
and on `#/validate`. Validation can be read without WebGPU; saved results and their limits are shown there.

The browser guidance in `src/app/messages.ts` describes platform-specific
recovery paths. Chromium on Linux directs users to `chrome://gpu` or
`edge://gpu` and includes the Intel and NVIDIA driver requirements. Firefox on Linux
and Android directs users to a supported Chromium browser. Apple devices direct
users to Safari and an operating system update. Other desktop browsers direct
users to Chrome or Edge and their GPU diagnostics.

Adapter limits below the default buffer and storage-binding assumptions in
`src/gpu/device.ts` restrict the tier policy to S. Device creation requests
`shader-f16` only when the adapter advertises it. Tier XL is the only tier that
asks for raised limits (`maxStorageBufferBindingSize` and `maxBufferSize` of 396361728
bytes), and only when the adapter reports at least that much. On an adapter below
it, XL is unavailable: the page names the limit that falls short and runs a smaller tier.

## Adapter measurements

The following adapter snapshot was collected on 2026-11-05. Feature availability
and reported limits describe these devices, not solver accuracy or performance.

<!-- adapter-probe:start -->
Measured: 2026-11-05T15:53:38.653Z

| Engine | Browser version | Status | Features | Limits | User agent |
| --- | --- | --- | --- | --- | --- |
| chromium | 156.0.8078.4 | available | bgra8unorm-storage, clip-distances, core-features-and-limits, depth-clip-control, depth32float-stencil8, dual-source-blending, float32-blendable, float32-filterable, indirect-first-instance, primitive-index, rg11b10ufloat-renderable, shader-f16, subgroup-size-control, subgroups, texture-component-swizzle, texture-compression-astc, texture-compression-astc-sliced-3d, texture-compression-bc, texture-compression-bc-sliced-3d, texture-compression-etc2, texture-formats-tier1, texture-formats-tier2, timestamp-query | maxBindGroups: 4<br>maxBindGroupsPlusVertexBuffers: 24<br>maxBindingsPerBindGroup: 1000<br>maxBufferSize: 4294967292<br>maxColorAttachmentBytesPerSample: 128<br>maxColorAttachments: 8<br>maxComputeInvocationsPerWorkgroup: 1024<br>maxComputeWorkgroupSizeX: 1024<br>maxComputeWorkgroupSizeY: 1024<br>maxComputeWorkgroupSizeZ: 64<br>maxComputeWorkgroupsPerDimension: 65535<br>maxComputeWorkgroupStorageSize: 32768<br>maxDynamicStorageBuffersPerPipelineLayout: 8<br>maxDynamicUniformBuffersPerPipelineLayout: 10<br>maxImmediateSize: 64<br>maxInterStageShaderVariables: 28<br>maxSampledTexturesPerShaderStage: 48<br>maxSamplersPerShaderStage: 16<br>maxStorageBufferBindingSize: 4294967292<br>maxStorageBuffersInFragmentStage: 10<br>maxStorageBuffersInVertexStage: 10<br>maxStorageBuffersPerShaderStage: 10<br>maxStorageTexturesInFragmentStage: 8<br>maxStorageTexturesInVertexStage: 8<br>maxStorageTexturesPerShaderStage: 8<br>maxTextureArrayLayers: 2048<br>maxTextureDimension1D: 16384<br>maxTextureDimension2D: 16384<br>maxTextureDimension3D: 2048<br>maxUniformBufferBindingSize: 65536<br>maxUniformBuffersPerShaderStage: 12<br>maxVertexAttributes: 30<br>maxVertexBufferArrayStride: 2048<br>maxVertexBuffers: 8<br>minStorageBufferOffsetAlignment: 256<br>minUniformBufferOffsetAlignment: 256 | Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 |
| webkit | 27.2 | available | bgra8unorm-storage, clip-distances, core-features-and-limits, depth-clip-control, depth32float-stencil8, float16-renderable, float32-blendable, float32-filterable, float32-renderable, indirect-first-instance, primitive-index, rg11b10ufloat-renderable, shader-f16, subgroups, texture-compression-astc, texture-compression-astc-sliced-3d, texture-compression-bc, texture-compression-bc-sliced-3d, texture-compression-etc2, texture-formats-tier1, texture-formats-tier2, timestamp-query | maxBindGroups: 11<br>maxBindGroupsPlusVertexBuffers: 30<br>maxBindingsPerBindGroup: 65535<br>maxBufferSize: 2147483644<br>maxColorAttachmentBytesPerSample: 64<br>maxColorAttachments: 8<br>maxComputeInvocationsPerWorkgroup: 1024<br>maxComputeWorkgroupSizeX: 1024<br>maxComputeWorkgroupSizeY: 1024<br>maxComputeWorkgroupSizeZ: 1024<br>maxComputeWorkgroupsPerDimension: 65535<br>maxComputeWorkgroupStorageSize: 32768<br>maxDynamicStorageBuffersPerPipelineLayout: 65535<br>maxDynamicUniformBuffersPerPipelineLayout: 44<br>maxInterStageShaderVariables: 31<br>maxSampledTexturesPerShaderStage: 44<br>maxSamplersPerShaderStage: 22<br>maxStorageBufferBindingSize: 2147483644<br>maxStorageBuffersInFragmentStage: 44<br>maxStorageBuffersInVertexStage: 44<br>maxStorageBuffersPerShaderStage: 44<br>maxStorageTexturesInFragmentStage: 44<br>maxStorageTexturesInVertexStage: 44<br>maxStorageTexturesPerShaderStage: 44<br>maxTextureArrayLayers: 2048<br>maxTextureDimension1D: 16384<br>maxTextureDimension2D: 16384<br>maxTextureDimension3D: 2048<br>maxUniformBufferBindingSize: 2147483644<br>maxUniformBuffersPerShaderStage: 44<br>maxVertexAttributes: 30<br>maxVertexBufferArrayStride: 65532<br>maxVertexBuffers: 12<br>minStorageBufferOffsetAlignment: 32<br>minUniformBufferOffsetAlignment: 32 | Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15 |
<!-- adapter-probe:end -->

## Rendered behavior

The unsupported page presents a reason and an actionable next step, hides the
tunnel canvas and leaves validation readable without requesting a GPU. It uses
native semantic HTML.

## Embedded frames

`#/?<params>&embed=1` shows the canvas, the one-line readout and an "Open full
tunnel" link (same hash without `embed`, new tab, `rel="noopener"`), and no panel.
The panel's "Embed" button copies the matching `<iframe>`; it is disabled for a
dropped model because the file stays in the tab.

A frame that gets no WebGPU adapter shows the short form of the unsupported page,
the reason and the same link, so the frame is never blank.

Not yet measured: whether `navigator.gpu.requestAdapter()` succeeds inside a
cross-origin iframe in Chrome and Safari, including on iPad. `tests/browser/embed.spec.ts`
loads the preview inside a host page in the `mac-gpu` and `webkit-gpu` projects;
record its outcome and the iPad result here once they have been run.
