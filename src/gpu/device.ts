import { TIERS } from '../lbm/layout';

export type UnsupportedReason = 'webgpu-missing' | 'adapter-unavailable' | 'device-unavailable';

export type AdapterLimits = Pick<
  GPUSupportedLimits,
  'maxStorageBufferBindingSize' | 'maxBufferSize' | 'maxStorageBuffersPerShaderStage'
>;

// S/M/L use WebGPU defaults without requiredLimits.
export const DEFAULT_GRID_LIMITS: AdapterLimits = {
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBuffersPerShaderStage: 8,
};

// The largest population group holds 7 directions of f32 per cell.
const XL_GROUP_BYTES = 7 * Float32Array.BYTES_PER_ELEMENT * TIERS.XL.nx * TIERS.XL.ny * TIERS.XL.nz;

// Tier XL is the only tier that asks the device for more than the defaults.
export const XL_LIMITS: AdapterLimits = {
  maxStorageBufferBindingSize: XL_GROUP_BYTES,
  maxBufferSize: XL_GROUP_BYTES,
  maxStorageBuffersPerShaderStage: DEFAULT_GRID_LIMITS.maxStorageBuffersPerShaderStage,
};

export type TierPolicy = 's-only' | 's-m-l' | 's-m-l-xl';

/** Whether the adapter allows tier XL, and the first limit it falls short on when not. */
export type XlAvailability =
  | { available: true }
  | { available: false; reason: keyof AdapterLimits };

export function xlAvailability(limits: AdapterLimits): XlAvailability {
  for (const name of Object.keys(XL_LIMITS) as (keyof AdapterLimits)[]) {
    if (limits[name] < XL_LIMITS[name]) return { available: false, reason: name };
  }
  return { available: true };
}

interface AdapterAccess<Device> {
  readonly limits: AdapterLimits;
  readonly features: ReadonlySet<string>;
  requestDevice(descriptor: GPUDeviceDescriptor): Promise<Device>;
}

interface GpuAccess<Device> {
  requestAdapter(): Promise<AdapterAccess<Device> | null>;
}

export type GpuSupport<Device> =
  | { status: 'unsupported'; reason: UnsupportedReason }
  | {
      status: 'supported';
      device: Device;
      features: readonly string[];
      tierPolicy: TierPolicy;
      xl: XlAvailability;
    };

/** `xl` raises the device limits for tier XL, and only when the adapter allows them. */
export async function detectGpu<Device>(
  gpu: GpuAccess<Device> | undefined,
  options: { xl?: boolean } = {},
): Promise<GpuSupport<Device>> {
  if (!gpu) return { status: 'unsupported', reason: 'webgpu-missing' };

  let adapter: AdapterAccess<Device> | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    return { status: 'unsupported', reason: 'adapter-unavailable' };
  }
  if (!adapter) return { status: 'unsupported', reason: 'adapter-unavailable' };

  const features = [...adapter.features].sort();
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('shader-f16')
    ? ['shader-f16']
    : [];
  const xl = xlAvailability(adapter.limits);
  const raiseLimits = options.xl === true && xl.available;
  let device: Device;
  try {
    device = await adapter.requestDevice({
      requiredFeatures,
      ...(raiseLimits ? { requiredLimits: { ...XL_LIMITS } } : {}),
    });
  } catch {
    return { status: 'unsupported', reason: 'device-unavailable' };
  }

  const limits = adapter.limits;
  const largerGridsAvailable =
    limits.maxStorageBufferBindingSize >= DEFAULT_GRID_LIMITS.maxStorageBufferBindingSize &&
    limits.maxBufferSize >= DEFAULT_GRID_LIMITS.maxBufferSize &&
    limits.maxStorageBuffersPerShaderStage >= DEFAULT_GRID_LIMITS.maxStorageBuffersPerShaderStage;

  return {
    status: 'supported',
    device,
    features,
    tierPolicy: !largerGridsAvailable ? 's-only' : raiseLimits ? 's-m-l-xl' : 's-m-l',
    xl,
  };
}
