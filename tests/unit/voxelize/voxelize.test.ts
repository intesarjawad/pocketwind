import { describe, expect, it } from 'vitest';
import { CellType } from '../../../src/geometry/voxel-grid';
import { voxelize } from '../../../src/geometry/voxelize';
import { box, sphere } from './fixtures';

const layout = { nx: 64, ny: 64, nz: 64 };
const index = (x: number, y: number, z: number) => x + layout.nx * (y + layout.ny * z);

describe('voxelization', () => {
  it('supports a deliberately empty tunnel while retaining floor and inlet boundaries', () => {
    for (const floor of [false, true]) {
      const grid = voxelize({ positions: new Float32Array(), triangleCount: 0 }, null, layout, {
        floor,
        linkFractions: false,
      });
      expect(grid.solidCells).toBe(0);
      expect(grid.frontalCells).toBe(0);
      expect(grid.boundaryCells.length).toBe(0);
      expect(grid.geometry.some((flag) => (flag & 7) === CellType.EQ)).toBe(true);
      expect(grid.geometry.some((flag) => (flag & 7) === CellType.FLOOR)).toBe(floor);
    }
    expect(() =>
      voxelize({ positions: new Float32Array(), triangleCount: -1 }, null, layout, {
        floor: false,
      }),
    ).toThrow(RangeError);
  });

  it('matches sphere volume and projected area at radius 20', () => {
    const grid = voxelize(sphere([32, 32, 32], 20), null, layout, { floor: false });
    expect(grid.watertight).toBe(true);
    expect(Math.abs(grid.solidCells / ((4 / 3) * Math.PI * 20 ** 3) - 1)).toBeLessThan(0.02);
    expect(Math.abs(grid.frontalCells / (Math.PI * 20 ** 2) - 1)).toBeLessThan(0.03);
    expect(grid.blockage).toBe(grid.frontalCells / (layout.ny * layout.nz));
  });

  it('uses a majority vote when one cube face is missing', () => {
    const closed = voxelize(box([20.2, 20.2, 20.2], [40.2, 40.2, 40.2]), null, layout, {
      floor: false,
    });
    const open = voxelize(box([20.2, 20.2, 20.2], [40.2, 40.2, 40.2], true), null, layout, {
      floor: false,
    });
    expect(closed.watertight).toBe(true);
    expect(closed.solidCells).toBe(8000);
    expect(open.watertight).toBe(false);
    expect(Math.abs(open.solidCells / closed.solidCells - 1)).toBeLessThan(0.05);
    expect(open.missedLinks).toBeGreaterThan(0);
  });

  it('does not inflate a plate thinner than one cell', () => {
    const grid = voxelize(box([20.2, 20.2, 20.2], [20.5, 40.2, 40.2]), null, layout, {
      floor: false,
    });
    expect(grid.solidCells).toBe(0);
    expect(grid.frontalCells).toBe(0);
    expect(grid.boundaryCells).toHaveLength(0);
    expect(grid.watertight).toBe(true);
  });

  it('keeps body precedence, excludes supports from frontal area and includes them in blockage', () => {
    const grid = voxelize(
      box([20.2, 20.2, 20.2], [24.2, 24.2, 24.2]),
      box([22.2, 22.2, 18.2], [26.2, 26.2, 22.2]),
      layout,
      { floor: false },
    );
    expect(grid.solidCells).toBe(64);
    expect(grid.frontalCells).toBe(16);
    expect(grid.blockage).toBe(28 / (64 * 64));
    expect((grid.geometry[index(23, 23, 21)] ?? 0) & 7).toBe(CellType.SOLID);
    expect((grid.geometry[index(25, 25, 19)] ?? 0) & 7).toBe(CellType.SUPPORT);
  });

  it('applies equilibrium faces and floor precedence at corners', () => {
    const mesh = box([20.2, 20.2, 20.2], [24.2, 24.2, 24.2]);
    const grid = voxelize(mesh, null, layout, { floor: true });
    expect(grid.geometry[index(0, 4, 0)]).toBe(CellType.FLOOR);
    expect(grid.geometry[index(63, 4, 0)]).toBe(CellType.FLOOR);
    expect(grid.geometry[index(0, 4, 4)]).toBe(CellType.EQ);
    expect(grid.geometry[index(63, 4, 4)]).toBe(CellType.EQ);
    expect(grid.geometry[index(4, 4, 63)]).toBe(CellType.EQ);
    const periodic = voxelize(mesh, null, layout, { floor: false });
    expect(periodic.geometry[index(4, 4, 0)]).toBe(CellType.FLUID);
    expect(periodic.geometry[index(4, 4, 63)]).toBe(CellType.FLUID);
  });
});

describe('parity edge ownership and input validation', () => {
  it('counts shared facet diagonals once regardless of winding', () => {
    const mesh = box([20, 20, 20], [24, 24, 24]);
    const reversed = { ...mesh, positions: mesh.positions.slice() };
    for (let offset = 0; offset < mesh.positions.length; offset += 9) {
      reversed.positions.set(mesh.positions.subarray(offset + 6, offset + 9), offset + 3);
      reversed.positions.set(mesh.positions.subarray(offset + 3, offset + 6), offset + 6);
    }
    const forward = voxelize(mesh, null, layout, { floor: false });
    const backward = voxelize(reversed, null, layout, { floor: false });
    expect(forward.solidCells).toBe(64);
    expect(forward.watertight).toBe(true);
    expect(backward.geometry).toEqual(forward.geometry);
    expect(backward.watertight).toBe(true);
  });

  it('marks an open support mesh as non-watertight', () => {
    const grid = voxelize(
      box([20, 20, 20], [24, 24, 24]),
      box([30.2, 30.2, 30.2], [34.2, 34.2, 34.2], true),
      layout,
      { floor: false },
    );
    expect(grid.watertight).toBe(false);
  });

  it('rejects invalid dimensions, incomplete triangles and non-finite coordinates', () => {
    const mesh = box([20, 20, 20], [24, 24, 24]);
    for (const nx of [0, 1, 2.5, Number.NaN, Infinity]) {
      expect(() => voxelize(mesh, null, { ...layout, nx }, { floor: false })).toThrow(RangeError);
    }
    expect(() => voxelize({ ...mesh, triangleCount: 1 }, null, layout, { floor: false })).toThrow(
      RangeError,
    );
    const invalid = { ...mesh, positions: mesh.positions.slice() };
    invalid.positions[0] = Number.NaN;
    expect(() => voxelize(mesh, invalid, layout, { floor: false })).toThrow(RangeError);
  });
});
