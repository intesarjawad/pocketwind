import { type ScopedResult, withErrorScope } from '../gpu/error-scopes';

export class AllocationFailure extends Error {
  readonly kind = 'allocation-failure';
}

type ScopedDevice = Pick<GPUDevice, 'pushErrorScope' | 'popErrorScope'>;

/** Validation failures are programming errors; only memory exhaustion permits a smaller allocation. */
export async function checkedGpuOperation<Value>(
  device: ScopedDevice,
  operation: () => Value,
): Promise<Value> {
  device.pushErrorScope('out-of-memory');
  let result: ScopedResult<Value>;
  let memoryError: GPUError | null;
  try {
    result = await withErrorScope(device, 'validation', operation);
  } finally {
    memoryError = await device.popErrorScope();
  }
  if (memoryError) throw new AllocationFailure(memoryError.message);
  if (result.status === 'error') {
    throw new Error(`GPU validation failed: ${result.error.message}`);
  }
  return result.value;
}

/** Check every axis before beginning a compute pass. */
export function validateDispatch(counts: readonly number[], limit: number): void {
  if (counts.some((count) => count > limit)) {
    throw new RangeError(
      `Compute dispatch ${counts.join(' × ')} exceeds device limit ${limit} per axis.`,
    );
  }
}
