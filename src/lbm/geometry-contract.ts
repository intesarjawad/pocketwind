import { CELL_TYPE_MASK, CellType, NO_Q, type VoxelGrid } from '../geometry/voxel-grid';
import { DIRECTIONS } from './lattice';
import type { Layout } from './layout';

const isWall = (kind: number): boolean => kind >= CellType.SOLID && kind <= CellType.FLOOR;

function fractionCount(grid: VoxelGrid, cell: number, mask: number, fractions: number): number {
  const offset = grid.geometry[grid.nx * grid.ny * grid.nz + cell];
  if (offset === NO_Q) return 0;
  if (mask === 0 || offset !== fractions) {
    throw new RangeError(`Invalid geometry q offset at cell ${cell}.`);
  }
  let count = 0;
  for (let i = 1; i < DIRECTIONS.length; i += 1) {
    if ((mask & (1 << (3 + i))) !== 0) count += 1;
  }
  return count;
}

function pullMask(grid: VoxelGrid, cell: number): number {
  const { nx, ny, nz, geometry } = grid;
  const x = cell % nx;
  const y = Math.floor(cell / nx) % ny;
  const z = Math.floor(cell / (nx * ny));
  let mask = 0;
  for (let i = 1; i < DIRECTIONS.length; i += 1) {
    const [cx, cy, cz] = DIRECTIONS[i] ?? DIRECTIONS[0];
    const source = ((x - cx + nx) % nx) + nx * (((y - cy + ny) % ny) + ny * ((z - cz + nz) % nz));
    if (isWall((geometry[source] ?? 0) & CELL_TYPE_MASK)) mask |= 1 << (3 + i);
  }
  return mask;
}

/**
 * Geometry contains cell flags, cell q offsets, then packed f32 link fractions.
 * Halfway walls also accept NO_Q offsets without fractions. Masks describe the
 * kernel's wrapped pull neighbors, including periodic wall images.
 */
export function validateGeometry(layout: Layout, grid: VoxelGrid): void {
  const cells = layout.nx * layout.ny * layout.nz;
  const { geometry } = grid;
  if (
    grid.nx !== layout.nx ||
    grid.ny !== layout.ny ||
    grid.nz !== layout.nz ||
    geometry.length < 2 * cells
  ) {
    throw new RangeError('Geometry must match the solver layout and contain flags and q offsets.');
  }
  let fractions = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    const flag = geometry[cell] ?? 0;
    const kind = flag & CELL_TYPE_MASK;
    if (kind > CellType.EQ) throw new RangeError(`Unknown geometry cell kind at cell ${cell}.`);
    const expectedMask = kind === CellType.FLUID ? pullMask(grid, cell) : 0;
    if (flag !== (kind | expectedMask)) {
      throw new RangeError(`Inconsistent wall mask at cell ${cell}.`);
    }
    fractions += fractionCount(grid, cell, expectedMask, fractions);
  }
  if (geometry.length !== 2 * cells + fractions) {
    throw new RangeError(
      'Geometry length must match its cell planes and packed wall-link fractions.',
    );
  }
}
