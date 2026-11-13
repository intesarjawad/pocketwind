import { describe, expect, it } from 'vitest';
import { CellType } from '../../../src/geometry/voxel-grid';
import {
  dyePorts,
  fitPlate,
  PORTS,
  packSmokeParams,
  plateToCss,
  RAKE_X,
  RING_SLOTS,
  rakeSpan,
  SMOKE_PARAMS_BYTES,
  secondsPerStep,
  smokeFront,
  THREADS,
} from '../../../src/render/plate-layout';

const grid = { nx: 192, ny: 96, nz: 96 };
const body = { min: [48, 31, 6], max: [143, 65, 31] } as const;

describe('plate fit', () => {
  it('shows the whole tunnel length on a desktop plate above the caption', () => {
    const frame = fitPlate({ width: 1440, height: 900 }, grid, body);
    expect(frame.compact).toBe(false);
    expect(plateToCss(frame, RAKE_X, 0)[0]).toBeCloseTo(0, 6);
    expect(plateToCss(frame, grid.nx - 2, 0)[0]).toBeCloseTo(1440, 6);
    expect(frame.groundY).toBeCloseTo(900 - 306, 6);
    expect(plateToCss(frame, 0, frame.zTop)[1]).toBeGreaterThanOrEqual(120 - 1e-6);
  });
  it('crops a phone plate to the nose of the body and the gap under it', () => {
    const frame = fitPlate({ width: 390, height: 844 }, grid, body);
    expect(frame.compact).toBe(true);
    expect(plateToCss(frame, body.min[0] - 0.3 * 95, 0)[0]).toBeCloseTo(0, 6);
    const nose = plateToCss(frame, body.min[0], 0)[0];
    expect(nose).toBeGreaterThan(0);
    expect(nose).toBeLessThan(390 / 2);
    expect(plateToCss(frame, body.max[0], 0)[0]).toBeGreaterThan(390);
    expect(plateToCss(frame, 0, frame.zTop)[1]).toBeGreaterThanOrEqual(172 - 1e-6);
  });
  it('fits the whole body in a phone and an embed frame', () => {
    for (const [view, mode] of [
      [{ width: 390, height: 844 }, 'complete'],
      [{ width: 640, height: 223 }, 'embed'],
    ] as const) {
      const frame = fitPlate(view, grid, body, mode);
      expect(plateToCss(frame, body.min[0], 0)[0]).toBeGreaterThanOrEqual(0);
      expect(plateToCss(frame, body.max[0], 0)[0]).toBeLessThanOrEqual(view.width);
      expect(plateToCss(frame, body.max[0], body.max[2])[1]).toBeGreaterThanOrEqual(0);
    }
  });
  it('keeps the rake between the floor and the top of the plate', () => {
    const frame = fitPlate({ width: 1440, height: 900 }, grid, body);
    const [low, high] = rakeSpan(frame, grid);
    expect(low).toBeGreaterThan(1);
    expect(high).toBeLessThanOrEqual(frame.zTop - 2);
    expect(high).toBeLessThanOrEqual(grid.nz - 2);
  });
  it('rejects an empty view', () => {
    expect(() => fitPlate({ width: 0, height: 900 }, grid, body)).toThrow(RangeError);
  });
});

describe('smoke parameters', () => {
  it('packs grid, plane, ring state, rake and steps', () => {
    const buffer = packSmokeParams({
      grid,
      plane: 48,
      release: 7,
      releasing: true,
      steps: 8,
      rake: [1.5, 40],
    });
    expect(buffer.byteLength).toBe(SMOKE_PARAMS_BYTES);
    expect([...new Uint32Array(buffer, 0, 8)]).toEqual([
      192,
      96,
      96,
      48,
      THREADS,
      RING_SLOTS,
      7,
      1,
    ]);
    expect([...new Float32Array(buffer, 32, 4)]).toEqual([RAKE_X, 1.5, 40, 8]);
  });
  it('refuses a plane outside the grid and a release index f32 cannot hold', () => {
    const base = { grid, plane: 48, release: 0, releasing: false, steps: 8, rake: [1, 2] as const };
    expect(() => packSmokeParams({ ...base, plane: 96 })).toThrow(RangeError);
    expect(() => packSmokeParams({ ...base, release: 2 ** 24 })).toThrow(RangeError);
  });
  it('converts lattice steps to physical time at the inlet speed', () => {
    // 1044 mm over 96 cells at 40 m/s with the lattice inlet at 0.05.
    expect(secondsPerStep(1.044 / 96, 40, 0.05)).toBeCloseTo(1.359375e-5, 12);
    expect(() => secondsPerStep(0, 40, 0.05)).toThrow(RangeError);
  });
});

describe('smoke front', () => {
  it('keeps the first live puff of each thread and drops dead or later ones', () => {
    const records = new Float32Array([
      ...[40.5, 3, 0, 0.9],
      ...[12, 7, 0, 0],
      ...[30, 9, 1024, 1],
      ...[55.25, 11, 0, 0.03],
    ]);
    expect(smokeFront(records)).toEqual([
      [40.5, 3],
      [55.25, 11],
    ]);
  });
});

describe('dye ports', () => {
  it('sits behind the base, off the edges of the body, and skips heights without one', () => {
    const grid = { nx: 20, ny: 3, nz: 12 };
    const flags = new Uint32Array(grid.nx * grid.ny * grid.nz);
    const plane = 1;
    // A body whose rear face steps forward with height, like a slant.
    for (let z = 2; z <= 9; z += 1) {
      for (let x = 4; x <= 14 - Math.max(0, z - 6); x += 1) {
        flags[x + grid.nx * (plane + grid.ny * z)] = CellType.SOLID;
      }
    }
    const ports = dyePorts(flags, grid, plane, [2, 14]);
    expect(ports).toHaveLength(PORTS * 2);
    expect(Array.from(ports.subarray(0, 2))).toEqual([15, 4]);
    expect(Array.from(ports.subarray(2, 4))).toEqual([13, 8]);
    // A height above the body has nothing to release from.
    expect(Array.from(ports.subarray(4, 6))).toEqual([-1, -1]);
    // Above the rear of the roof, behind the top of the base, and under the nose.
    expect(Array.from(ports.subarray(6, 8))).toEqual([11, 10]);
    expect(Array.from(ports.subarray(8, 10))).toEqual([15, 7]);
    expect(Array.from(ports.subarray(10, 12))).toEqual([4, 1]);
  });
  it('finds where a smooth body separates rather than its highest cell', () => {
    const grid = { nx: 40, ny: 3, nz: 20 };
    const flags = new Uint32Array(grid.nx * grid.ny * grid.nz);
    const plane = 1;
    for (let z = 0; z < grid.nz; z += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        if (((x - 18) / 12) ** 2 + ((z - 9) / 5) ** 2 <= 1) {
          flags[x + grid.nx * (plane + grid.ny * z)] = CellType.SOLID;
        }
      }
    }
    const ports = dyePorts(flags, grid, plane, [4, 14]);
    const [x = 0, z = 0] = ports.subarray(6, 8);
    // Behind the crest at x = 18, on the rear of the upper surface, just off the wall.
    expect(x).toBeGreaterThan(22);
    expect(x).toBeLessThan(30);
    expect(flags[x + grid.nx * (plane + grid.ny * (z - 1))]).toBe(CellType.SOLID);
    // And its mirror on the lower surface, rather than mid-belly under the keel.
    const [lowX = 0, lowZ = 0] = ports.subarray(10, 12);
    expect(lowX).toBeGreaterThan(22);
    expect(lowX).toBeLessThan(30);
    expect(flags[lowX + grid.nx * (plane + grid.ny * (lowZ + 1))]).toBe(CellType.SOLID);
  });
});
