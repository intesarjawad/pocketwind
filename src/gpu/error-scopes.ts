export type ScopedResult<Value> =
  | { status: 'ok'; value: Value }
  | { status: 'error'; error: GPUError };

/** Capture GPU errors while balancing the scope even if allocation throws. */
export async function withErrorScope<Value>(
  device: Pick<GPUDevice, 'pushErrorScope' | 'popErrorScope'>,
  filter: GPUErrorFilter,
  operation: () => Value,
): Promise<ScopedResult<Value>> {
  device.pushErrorScope(filter);
  let value: Value;
  let error: GPUError | null;
  try {
    value = operation();
  } finally {
    error = await device.popErrorScope();
  }
  return error ? { status: 'error', error } : { status: 'ok', value };
}
