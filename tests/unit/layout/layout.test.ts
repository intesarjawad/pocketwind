import { describe, expect, it } from 'vitest';
import { bytesForLayout, populationBufferBytes, TIERS } from '../../../src/lbm/layout';

const memoryTable = [
  {
    tier: 'S',
    grid: [128, 64, 64],
    cells: 524288,
    particles: 16384,
    f32: 92274688,
    f16: 52428800,
    displayed: [92, 52],
  },
  {
    tier: 'M',
    grid: [192, 96, 96],
    cells: 1769472,
    particles: 65536,
    f32: 311427072,
    f16: 176947200,
    displayed: [311, 177],
  },
  {
    tier: 'L',
    grid: [256, 128, 128],
    cells: 4194304,
    particles: 65536,
    f32: 738197504,
    f16: 419430400,
    displayed: [738, 419],
  },
  {
    tier: 'XL',
    grid: [384, 192, 192],
    cells: 14155776,
    particles: 65536,
    f32: 2491416576,
    f16: 1415577600,
    displayed: [2.49, 1.42],
  },
] as const;

describe('solver layout', () => {
  it.each(memoryTable)('reproduces the $tier grid and memory table', (row) => {
    const layout = TIERS[row.tier];
    expect([layout.nx, layout.ny, layout.nz]).toEqual(row.grid);
    expect(layout.nx * layout.ny * layout.nz).toBe(row.cells);
    expect(layout.nx % 64).toBe(0);
    expect(layout.particles).toBe(row.particles);
    expect(bytesForLayout(layout, 'f32')).toBe(row.f32);
    expect(bytesForLayout(layout, 'f16')).toBe(row.f16);
    const divisor = row.tier === 'XL' ? 1e9 : 1e6;
    const digits = row.tier === 'XL' ? 2 : 0;
    expect(Number((row.f32 / divisor).toFixed(digits))).toBe(row.displayed[0]);
    expect(Number((row.f16 / divisor).toFixed(digits))).toBe(row.displayed[1]);
  });

  it('includes two population buffers, geometry and macros for arbitrary layouts', () => {
    const layout = { nx: 7, ny: 3, nz: 2 };
    expect(bytesForLayout(layout, 'f32')).toBe(42 * 176);
    expect(bytesForLayout(layout, 'f16')).toBe(42 * 100);
  });

  it('pads an odd count of f16 populations to a four-byte binding', () => {
    expect(populationBufferBytes(1, 7, 'f32')).toBe(28);
    expect(populationBufferBytes(1, 7, 'f16')).toBe(16);
    expect(populationBufferBytes(3, 6, 'f16')).toBe(36);
    expect(populationBufferBytes(3, 6, 'f32')).toBe(72);
  });

  for (const axis of ['nx', 'ny', 'nz'] as const) {
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid ${axis} %s`,
      (size) => {
        expect(() => bytesForLayout({ nx: 2, ny: 2, nz: 2, [axis]: size }, 'f32')).toThrow(
          RangeError,
        );
      },
    );
  }

  it('rejects byte counts that cannot be represented exactly', () => {
    expect(() => bytesForLayout({ nx: Number.MAX_SAFE_INTEGER, ny: 2, nz: 2 }, 'f16')).toThrow(
      RangeError,
    );
  });
});
