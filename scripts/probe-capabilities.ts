import type { AdapterProbe } from './probe-report';

/** Runs in the page through Playwright, so all runtime inputs come from navigator. */
export async function probeCapabilities(): Promise<
  Omit<AdapterProbe, 'engine' | 'browserVersion'>
> {
  const userAgent = navigator.userAgent;
  const empty = { userAgent, features: [], limits: {} };
  if (!('gpu' in navigator)) return { ...empty, status: 'missing-api' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ...empty, status: 'no-adapter' };
  const limits: Record<string, number> = {};
  for (const name in adapter.limits) {
    const value: unknown = Reflect.get(adapter.limits, name);
    if (typeof value === 'number') limits[name] = value;
  }
  const features = [...adapter.features].sort();
  const capabilities = { userAgent, features, limits };
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('shader-f16')
    ? ['shader-f16']
    : [];
  try {
    const device = await adapter.requestDevice({ requiredFeatures });
    device.destroy();
    return { ...capabilities, status: 'available' };
  } catch {
    return { ...capabilities, status: 'device-rejected' };
  }
}
