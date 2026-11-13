// Bounded rows keep linear kernels on the same 2D path across device limits.
// At 64 threads per group, a row covers 16,384 items.
const WORKGROUPS_PER_ROW = 256;

/** Cover a linear item count; shaders flatten workgroup_id using num_workgroups.x. */
export function dispatch2D(
  items: number,
  workgroupSize: number,
  maxWorkgroups = 65535,
): readonly [number, number] {
  if (
    !Number.isSafeInteger(items) ||
    items < 0 ||
    items > 0xffffffff ||
    !Number.isSafeInteger(workgroupSize) ||
    workgroupSize <= 0 ||
    !Number.isSafeInteger(maxWorkgroups) ||
    maxWorkgroups <= 0
  ) {
    throw new RangeError('Dispatch needs a u32 item count and positive integer sizes.');
  }
  const groups = Math.max(1, Math.ceil(items / workgroupSize));
  const columns = Math.min(groups, WORKGROUPS_PER_ROW, maxWorkgroups);
  const rows = Math.ceil(groups / columns);
  if (rows > maxWorkgroups || columns * rows * workgroupSize > 2 ** 32) {
    throw new RangeError('Compute dispatch exceeds the device limit or u32 indexing.');
  }
  return [columns, rows];
}
