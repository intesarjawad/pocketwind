import type { Mesh } from './stl';
import { binTriangles, nearestLinkHit, type TriangleBins } from './triangle-bins';
import { CELL_TYPE_MASK, CellType, type Layout, NO_Q } from './voxel-grid';

const { FLUID, SOLID, SUPPORT, FLOOR } = CellType;
const TYPE_MASK = CELL_TYPE_MASK;
const intersectLink = nearestLinkHit;

// Opposite directions are consecutive pairs, starting at index one.
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
const MIN_Q = 1e-3;
const MID_LINK_Q = 0.5;

type Point = readonly [number, number, number];

function neighbour(x: number, y: number, z: number, layout: Layout, floor: boolean): number | null {
  const { nx, ny, nz } = layout;
  if (x < 0 || x >= nx || (floor && (z < 0 || z >= nz))) return null;
  return x + nx * (((y + ny) % ny) + ny * ((z + nz) % nz));
}

function isWall(type: number): boolean {
  return type >= SOLID && type <= FLOOR;
}

function markWalls(flags: Uint32Array, layout: Layout, floor: boolean): Uint8Array {
  const { nx, ny } = layout;
  const bodyBoundary = new Uint8Array(flags.length);
  for (let wall = 0; wall < flags.length; wall += 1) {
    const type = (flags[wall] ?? 0) & TYPE_MASK;
    if (!isWall(type)) continue;
    const x = wall % nx;
    const y = Math.floor(wall / nx) % ny;
    const z = Math.floor(wall / (nx * ny));
    for (const [i, direction] of DIRECTIONS.entries()) {
      const fluid = neighbour(x + direction[0], y + direction[1], z + direction[2], layout, floor);
      if (fluid === null || ((flags[fluid] ?? 0) & TYPE_MASK) !== FLUID) continue;
      flags[fluid] = (flags[fluid] ?? 0) | (1 << (3 + i));
      if (type === SOLID) bodyBoundary[fluid] = 1;
    }
  }
  return bodyBoundary;
}

function linkFraction(
  flags: Uint32Array,
  cell: number,
  direction: Point,
  layout: Layout,
  floor: boolean,
  bodyBins: TriangleBins | null,
  supportBins: TriangleBins | null,
): number | null {
  if (bodyBins === null) return MID_LINK_Q;
  const x = cell % layout.nx;
  const y = Math.floor(cell / layout.nx) % layout.ny;
  const z = Math.floor(cell / (layout.nx * layout.ny));
  const [dx, dy, dz] = direction;
  const wall = neighbour(x - dx, y - dy, z - dz, layout, floor);
  if (wall === null) throw new RangeError('Wall link leaves the grid.');
  const type = (flags[wall] ?? 0) & TYPE_MASK;
  if (type === FLOOR) return MID_LINK_Q;
  const bins = type === SUPPORT ? supportBins : bodyBins;
  if (!bins) throw new RangeError('Support wall links require a support mesh.');
  // Translate the fluid image next to the wrapped wall for periodic links.
  const origin: Point = [
    (wall % layout.nx) + dx,
    (Math.floor(wall / layout.nx) % layout.ny) + dy,
    Math.floor(wall / (layout.nx * layout.ny)) + dz,
  ];
  return intersectLink(bins, origin, [-dx, -dy, -dz]);
}

/**
 * Pack pull wall masks, per-link q fractions, and the body force boundary list.
 * Without `measureFractions` every link keeps the halfway fraction and none counts as missed:
 * bounce-back never reads them, and a dense mesh makes the ray casts the slowest step.
 */
export function buildWallLinks(
  flags: Uint32Array,
  body: Mesh,
  supports: Mesh | null,
  layout: Layout,
  floor: boolean,
  measureFractions = true,
) {
  const bodyBoundary = markWalls(flags, layout, floor);
  const bodyBins = measureFractions ? binTriangles(body, layout) : null;
  const supportBins = supports ? binTriangles(supports, layout) : null;
  const bases = new Uint32Array(flags.length).fill(NO_Q);
  const fractions: number[] = [];
  const boundaryCells: number[] = [];
  let missedLinks = 0;
  for (let cell = 0; cell < flags.length; cell += 1) {
    const flag = flags[cell] ?? 0;
    if (flag >>> 3 === 0) continue;
    bases[cell] = fractions.length;
    if (bodyBoundary[cell]) boundaryCells.push(cell);
    for (const [i, direction] of DIRECTIONS.entries()) {
      if ((flag & (1 << (3 + i))) === 0) continue;
      const hit = linkFraction(flags, cell, direction, layout, floor, bodyBins, supportBins);
      missedLinks += Number(hit === null);
      fractions.push(Math.max(MIN_Q, Math.min(1, hit ?? MID_LINK_Q)));
    }
  }
  const geometry = new Uint32Array(flags.length * 2 + fractions.length);
  geometry.set(flags);
  geometry.set(bases, flags.length);
  new Float32Array(geometry.buffer, flags.length * 8).set(fractions);
  return { geometry, boundaryCells: Uint32Array.from(boundaryCells), missedLinks };
}
