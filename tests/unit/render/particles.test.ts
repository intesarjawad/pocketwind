import { describe, expect, it } from 'vitest';
import {
  packParticleParams,
  particleHash,
  particleNeedsReseed,
  particleSeeds,
  seedRegion,
} from '../../../src/render/particle-layout';

const layout = { nx: 32, ny: 20, nz: 20 };
const bounds = { min: [8, 5, 5], max: [20, 15, 15] } as const;

it('enlarges the full cross-section by 30 percent and clips to interior cells', () => {
  expect(seedRegion(bounds, layout)).toEqual([3.5, 3.5, 16.5, 16.5]);
  expect(seedRegion({ min: [8, 0, 0], max: [20, 20, 20] }, layout)).toEqual([1, 1, 18, 18]);
  expect(() => seedRegion(bounds, { nx: 4, ny: 20, nz: 20 })).toThrow(RangeError);
  expect(() => seedRegion({ min: [0, 8, 8], max: [1, 7, 8] }, layout)).toThrow(RangeError);
  expect(() => seedRegion({ min: [0, 30, 30], max: [1, 40, 40] }, layout)).toThrow(RangeError);
});

describe('particle reseeding', () => {
  it('keeps fluid nodes with wall-link bits and accepts the inclusive age limit', () => {
    expect(particleNeedsReseed([2, 10, 10], 4000, layout, 1 << 4)).toBe(false);
    expect(particleNeedsReseed([29.99, 10, 10], 0, layout, 0)).toBe(false);
  });
  it('rejects the outlet, old particles, each non-fluid kind and domain escapes', () => {
    expect(particleNeedsReseed([30, 10, 10], 0, layout, 0)).toBe(true);
    expect(particleNeedsReseed([2, 10, 10], 4001, layout, 0)).toBe(true);
    for (const kind of [1, 2, 3, 4])
      expect(particleNeedsReseed([2, 10, 10], 1, layout, kind | (1 << 5))).toBe(true);
    for (const position of [
      [-1, 2, 2],
      [2, -1, 2],
      [2, 19, 2],
      [2, 2, -1],
      [2, 2, 19],
      [NaN, 2, 2],
    ] as const)
      expect(particleNeedsReseed(position, 0, layout, 0)).toBe(true);
  });
});

it('uses a stable unsigned seed hash', () => {
  expect(particleHash(0)).toBe(0);
  expect(particleHash(1)).toBe(1753845952);
  expect(particleHash(2)).toBe(3507691905);
  expect(particleHash(0xffffffff)).toBe(1734902346);
});

it('packs pos and prev as vec4s and seeds only fluid inlet nodes', () => {
  const grid = { ...layout, geometry: new Uint32Array(32 * 20 * 20).fill(1) };
  grid.geometry[2 + 32 * (4 + 20 * 4)] = 1 << 4;
  grid.geometry[2 + 32 * (5 + 20 * 4)] = 0;
  const seeded = particleSeeds(grid, bounds, 4, 0);
  expect(seeded.fallback).toEqual([2, 4, 4]);
  expect(seeded.data.byteLength).toBe(128);
  expect(Array.from(seeded.data)).toEqual([
    2, 4, 4, 0, 2, 4, 4, 0, 2, 4, 4, 0, 2, 4, 4, 0, 2, 5, 4, 0, 2, 5, 4, 0, 2, 5, 4, 0, 2, 5, 4, 0,
  ]);
  expect(particleSeeds(grid, bounds, 4, 0).data).toEqual(seeded.data);
  expect(particleSeeds(grid, bounds, 4, 1).data).not.toEqual(seeded.data);
});

it('rejects an empty inlet, missing flags and invalid counts or seeds', () => {
  expect(() =>
    particleSeeds({ ...layout, geometry: new Uint32Array(12800).fill(1) }, bounds, 1, 1),
  ).toThrow(/no fluid inlet/);
  expect(() => particleSeeds({ ...layout, geometry: new Uint32Array(0) }, bounds, 1, 1)).toThrow(
    RangeError,
  );
  const grid = { ...layout, geometry: new Uint32Array(12800) };
  for (const count of [0, 1.5, 65537])
    expect(() => particleSeeds(grid, bounds, count, 1)).toThrow(RangeError);
  for (const seed of [-1, 1.5, 2 ** 32])
    expect(() => particleSeeds(grid, bounds, 1, seed)).toThrow(RangeError);
});

it('packs particle uniforms without reinterpreting integer dimensions as floats', () => {
  const buffer = packParticleParams(
    layout,
    1024,
    0x12345678,
    4.5,
    [3.5, 3.5, 16.5, 16.5],
    [2, 4, 5],
  );
  expect(buffer.byteLength).toBe(64);
  expect(Array.from(new Uint32Array(buffer).slice(0, 5))).toEqual([32, 20, 20, 1024, 0x12345678]);
  expect(Array.from(new Float32Array(buffer).slice(5))).toEqual([
    4.5, 0, 0, 3.5, 3.5, 16.5, 16.5, 4, 5, 0, 0,
  ]);
  for (const steps of [-1, NaN, Infinity, Number.MAX_VALUE])
    expect(() => packParticleParams(layout, 1, 1, steps, [1, 1, 2, 2], [2, 1, 1])).toThrow(
      RangeError,
    );
});

it('seeds a sub-cell cross-section without requiring a lattice node inside it', () => {
  const seeded = particleSeeds(
    { ...layout, geometry: new Uint32Array(12800) },
    { min: [8, 5.1, 6.1], max: [9, 5.2, 6.2] },
    1,
    0,
  );
  expect(seeded.data[0]).toBe(2);
  expect(seeded.data[1]).toBeCloseTo(5.085, 5);
  expect(seeded.data[2]).toBeCloseTo(6.085, 5);
  expect(seeded.data.slice(4, 7)).toEqual(seeded.data.slice(0, 3));
});

it('rejects a seed region whose float32 coordinates round into a blocked neighbour', () => {
  const grid = { ...layout, geometry: new Uint32Array(12800).fill(1) };
  grid.geometry[2 + 32 * (5 + 20 * 6)] = 0;
  expect(() =>
    particleSeeds(grid, { min: [8, 5.49999999, 6.1], max: [9, 5.5, 6.2] }, 1, 0),
  ).toThrow(/no fluid inlet/);
});
