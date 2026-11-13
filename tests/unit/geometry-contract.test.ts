import { describe, expect, it } from 'vitest';
import { CellType, NO_Q, type VoxelGrid } from '../../src/geometry/voxel-grid';
import { validateGeometry } from '../../src/lbm/geometry-contract';

const layout = { nx: 3, ny: 1, nz: 1 };
// With singleton periodic y/z axes, five pulls in each x direction hit the wall.
const positiveXMask = [1, 7, 9, 13, 15].reduce((mask, i) => mask | (1 << (3 + i)), 0);
const negativeXMask = [2, 8, 10, 14, 16].reduce((mask, i) => mask | (1 << (3 + i)), 0);

function wallGrid(kind: number, withFractions = false): VoxelGrid {
  const geometry = new Uint32Array(withFractions ? 16 : 6);
  geometry.set([kind, positiveXMask, negativeXMask, NO_Q, NO_Q, NO_Q]);
  if (withFractions) {
    geometry.set([0, 5], 4);
    new Float32Array(geometry.buffer, 6 * 4).fill(0.5);
  }
  return {
    ...layout,
    geometry,
    boundaryCells: new Uint32Array([1, 2]),
    solidCells: 1,
    frontalCells: 1,
    blockage: 1,
    watertight: true,
    missedLinks: 0,
  };
}

describe('GPU geometry layout', () => {
  it.each([CellType.SOLID, CellType.SUPPORT, CellType.FLOOR])(
    'accepts complete periodic pull masks for wall kind %s with or without packed q',
    (kind) => {
      expect(() => validateGeometry(layout, wallGrid(kind))).not.toThrow();
      expect(() => validateGeometry(layout, wallGrid(kind, true))).not.toThrow();
    },
  );

  it.each([0, 4, 6, NO_Q])('rejects an inconsistent q offset %s', (offset) => {
    const grid = wallGrid(CellType.SOLID, true);
    grid.geometry[5] = offset;
    expect(() => validateGeometry(layout, grid)).toThrow(/geometry/i);
  });

  it.each([-1, 1])('rejects packed fraction storage with length error %s', (change) => {
    const grid = wallGrid(CellType.SOLID, true);
    const geometry = new Uint32Array(grid.geometry.length + change);
    geometry.set(grid.geometry.subarray(0, geometry.length));
    expect(() => validateGeometry(layout, { ...grid, geometry })).toThrow(/geometry length/i);
  });

  it('rejects an extra mask bit on a wall cell', () => {
    const grid = wallGrid(CellType.SOLID);
    grid.geometry[0] = CellType.SOLID | positiveXMask;
    expect(() => validateGeometry(layout, grid)).toThrow(/wall mask/i);
  });

  it('rejects a missing link across the periodic boundary', () => {
    const grid = wallGrid(CellType.SOLID);
    grid.geometry[2] = negativeXMask ^ (1 << (3 + 2));
    expect(() => validateGeometry(layout, grid)).toThrow(/wall mask/i);
  });

  it('rejects dimensions that differ from the solver', () => {
    expect(() => validateGeometry(layout, { ...wallGrid(CellType.SOLID), nx: 4 })).toThrow(
      /geometry/i,
    );
  });
});
