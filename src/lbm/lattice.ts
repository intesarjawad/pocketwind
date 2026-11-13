// Adjacent opposite pairs match the direction bits in voxelized wall masks.
export const DIRECTIONS = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, -1],
  [1, -1, 0],
  [-1, 1, 0],
  [1, 0, -1],
  [-1, 0, 1],
  [0, 1, -1],
  [0, -1, 1],
] as const;

export const WEIGHTS = [
  1 / 3,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
] as const;

/** Return the D3Q19 index whose velocity is reversed. */
export function opp(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= DIRECTIONS.length) {
    throw new RangeError('Direction index must be an integer from 0 to 18.');
  }
  return i === 0 ? 0 : i % 2 === 1 ? i + 1 : i - 1;
}
