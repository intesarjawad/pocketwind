import { describe, expect, it } from 'vitest';
import { DIRECTIONS as WALL_DIRECTIONS } from '../../../src/geometry/wall-links';
import { DIRECTIONS, opp, WEIGHTS } from '../../../src/lbm/lattice';

const AXES = [0, 1, 2] as const;
const AXIS_PAIRS = AXES.flatMap((a) => AXES.map((b) => [a, b] as const));

describe('D3Q19 lattice', () => {
  it('uses the same direction indices as voxelized wall masks', () => {
    expect(DIRECTIONS).toHaveLength(19);
    expect(DIRECTIONS).toEqual(WALL_DIRECTIONS);
    expect(new Set(DIRECTIONS.map((direction) => direction.join(','))).size).toBe(19);
  });

  it('pairs every velocity with its opposite and leaves rest fixed', () => {
    expect(opp(0)).toBe(0);
    DIRECTIONS.forEach((direction, i) => {
      expect(opp(i)).toBe(i === 0 ? 0 : i % 2 === 1 ? i + 1 : i - 1);
      expect(opp(opp(i))).toBe(i);
      expect(DIRECTIONS[opp(i)]).toEqual(
        direction.map((component) => (component === 0 ? 0 : -component)),
      );
      expect(WEIGHTS[opp(i)]).toBe(WEIGHTS[i]);
    });
  });

  it('normalizes rest, axial and diagonal weights', () => {
    expect(WEIGHTS).toHaveLength(19);
    expect(WEIGHTS[0]).toBe(1 / 3);
    expect(WEIGHTS.slice(1, 7)).toEqual(Array(6).fill(1 / 18));
    expect(WEIGHTS.slice(7)).toEqual(Array(12).fill(1 / 36));
    expect(WEIGHTS.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 15);
  });

  it('has zero momentum and isotropic second moments', () => {
    for (const a of AXES) {
      const momentum = DIRECTIONS.reduce((sum, c, i) => sum + (WEIGHTS[i] ?? NaN) * c[a], 0);
      expect(momentum).toBeCloseTo(0, 15);
      for (const b of AXES) {
        const second = DIRECTIONS.reduce((sum, c, i) => sum + (WEIGHTS[i] ?? NaN) * c[a] * c[b], 0);
        expect(second).toBeCloseTo(a === b ? 1 / 3 : 0, 15);
      }
    }
  });

  it.each(AXIS_PAIRS)('has isotropic fourth moments for axes %s, %s', (a, b) => {
    for (const [d, e] of AXIS_PAIRS) {
      const fourth = DIRECTIONS.reduce(
        (sum, c, i) => sum + (WEIGHTS[i] ?? NaN) * c[a] * c[b] * c[d] * c[e],
        0,
      );
      const expected =
        (Number(a === b && d === e) + Number(a === d && b === e) + Number(a === e && b === d)) / 9;
      expect(fourth).toBeCloseTo(expected, 15);
    }
  });

  it.each([-1, 19, 1.5, NaN, Infinity])('rejects invalid direction index %s', (i) => {
    expect(() => opp(i)).toThrow(RangeError);
  });
});
