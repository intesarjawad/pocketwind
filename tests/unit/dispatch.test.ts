import { describe, expect, it } from 'vitest';
import { dispatch2D } from '../../src/gpu/dispatch';

describe('linear 2D dispatch', () => {
  it.each([
    [0, [1, 1]],
    [1, [1, 1]],
    [64, [1, 1]],
    [65, [2, 1]],
    [16384, [256, 1]],
    [16385, [256, 2]],
    [70000, [256, 5]],
    [65536 * 64, [256, 256]],
  ] as const)('covers %s items including empty and padded groups', (count, expected) => {
    expect(dispatch2D(count, 64)).toEqual(expected);
  });

  it('honors smaller device limits and rejects grids that cannot fit', () => {
    expect(dispatch2D(65, 64, 2)).toEqual([2, 1]);
    expect(dispatch2D(256, 64, 2)).toEqual([2, 2]);
    expect(() => dispatch2D(257, 64, 2)).toThrow(/limit/);
  });

  it.each([-1, 0.5, NaN, Infinity, 2 ** 32])('rejects invalid counts: %s', (count) => {
    expect(() => dispatch2D(count, 64)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid sizes or limits: %s', (size) => {
    expect(() => dispatch2D(1, size)).toThrow(RangeError);
    expect(() => dispatch2D(1, 64, size)).toThrow(RangeError);
  });
});
