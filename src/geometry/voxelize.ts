import type { Mesh } from './stl';
import { CELL_TYPE_MASK, CellType, type Layout, type VoxelGrid } from './voxel-grid';
import { buildWallLinks } from './wall-links';

const { FLUID, SOLID, SUPPORT, FLOOR, EQ } = CellType;
const TYPE_MASK = CELL_TYPE_MASK;

type Point = readonly [number, number, number];
const PROJECTIONS = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
] as const;

function pointAt(mesh: Mesh, offset: number): Point {
  return [
    mesh.positions[offset] ?? 0,
    mesh.positions[offset + 1] ?? 0,
    mesh.positions[offset + 2] ?? 0,
  ];
}

function edge(a: Point, b: Point, u: number, v: number): number {
  return (b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0]);
}

function ownsEdge(value: number, a: Point, b: Point): boolean {
  // Half-open edges count a shared diagonal once and cancel tangent contacts.
  return value > 0 || (value === 0 && (b[1] < a[1] || (b[1] === a[1] && b[0] > a[0])));
}

function rasterizeTriangle(
  a: Point,
  second: Point,
  third: Point,
  nu: number,
  nv: number,
  columns: number[][],
): void {
  const signedArea = edge(a, second, third[0], third[1]);
  if (signedArea === 0) return;
  const b = signedArea > 0 ? second : third;
  const c = signedArea > 0 ? third : second;
  const area = Math.abs(signedArea);
  const minU = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0])));
  const maxU = Math.min(nu - 1, Math.floor(Math.max(a[0], b[0], c[0])));
  const minV = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1])));
  const maxV = Math.min(nv - 1, Math.floor(Math.max(a[1], b[1], c[1])));
  for (let v = minV; v <= maxV; v += 1) {
    for (let u = minU; u <= maxU; u += 1) {
      const wa = edge(b, c, u, v);
      const wb = edge(c, a, u, v);
      const wc = edge(a, b, u, v);
      if (ownsEdge(wa, b, c) && ownsEdge(wb, c, a) && ownsEdge(wc, a, b)) {
        const hits = columns[u + nu * v];
        hits?.push((wa * a[2] + wb * b[2] + wc * c[2]) / area);
      }
    }
  }
}

function fillColumns(
  columns: number[][],
  nu: number,
  depth: number,
  strides: Point,
  votes: Uint8Array,
): boolean {
  let watertight = true;
  for (let column = 0; column < columns.length; column += 1) {
    const hits = columns[column];
    if (!hits || hits.length === 0) continue;
    hits.sort((a, b) => a - b);
    if (hits.length % 2 !== 0) watertight = false;
    const base = (column % nu) * strides[0] + Math.floor(column / nu) * strides[1];
    for (let pair = 0; pair + 1 < hits.length; pair += 2) {
      const start = Math.max(0, Math.ceil(hits[pair] ?? 0));
      const end = Math.min(depth, Math.ceil(hits[pair + 1] ?? 0));
      for (let coordinate = start; coordinate < end; coordinate += 1) {
        const cell = base + coordinate * strides[2];
        votes[cell] = (votes[cell] ?? 0) + 1;
      }
    }
  }
  return watertight;
}

function voteMesh(mesh: Mesh, layout: Layout, flags: Uint32Array, type: number): boolean {
  const sizes: Point = [layout.nx, layout.ny, layout.nz];
  const strides: Point = [1, layout.nx, layout.nx * layout.ny];
  const votes = new Uint8Array(flags.length);
  let watertight = true;
  for (const [u, v, axis] of PROJECTIONS) {
    const columns: number[][] = Array.from({ length: sizes[u] * sizes[v] }, () => []);
    for (let offset = 0; offset < mesh.positions.length; offset += 9) {
      const a = pointAt(mesh, offset);
      const b = pointAt(mesh, offset + 3);
      const c = pointAt(mesh, offset + 6);
      rasterizeTriangle(
        [a[u], a[v], a[axis]],
        [b[u], b[v], b[axis]],
        [c[u], c[v], c[axis]],
        sizes[u],
        sizes[v],
        columns,
      );
    }
    const closed = fillColumns(
      columns,
      sizes[u],
      sizes[axis],
      [strides[u], strides[v], strides[axis]],
      votes,
    );
    watertight = closed && watertight;
  }
  for (let cell = 0; cell < flags.length; cell += 1) {
    if ((votes[cell] ?? 0) >= 2 && flags[cell] === FLUID) flags[cell] = type;
  }
  return watertight;
}

function applyBoundaries(flags: Uint32Array, { nx, ny, nz }: Layout, floor: boolean): void {
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const row = nx * (y + ny * z);
      flags[row] = EQ;
      flags[row + nx - 1] = EQ;
    }
  }
  if (floor) {
    flags.fill(FLOOR, 0, nx * ny);
    flags.fill(EQ, nx * ny * (nz - 1));
  }
}

function countCells(flags: Uint32Array, { nx, ny, nz }: Layout) {
  const bodyProjection = new Uint8Array(ny * nz);
  const wallProjection = new Uint8Array(ny * nz);
  let solidCells = 0;
  for (let cell = 0; cell < flags.length; cell += 1) {
    const type = (flags[cell] ?? 0) & TYPE_MASK;
    if (type === SOLID) {
      solidCells += 1;
      bodyProjection[Math.floor(cell / nx)] = 1;
    }
    if (type === SOLID || type === SUPPORT) wallProjection[Math.floor(cell / nx)] = 1;
  }
  return {
    solidCells,
    frontalCells: bodyProjection.reduce((sum, value) => sum + value, 0),
    blockage: wallProjection.reduce((sum, value) => sum + value, 0) / (ny * nz),
  };
}

function validateMesh(mesh: Mesh): void {
  if (
    !Number.isSafeInteger(mesh.triangleCount) ||
    mesh.triangleCount < 0 ||
    mesh.positions.length !== mesh.triangleCount * 9
  ) {
    throw new RangeError('Mesh positions must match a non-negative triangle count.');
  }
  if (!mesh.positions.every(Number.isFinite))
    throw new RangeError('Mesh coordinates must be finite.');
}

/**
 * Voxelize placed lattice-space meshes using a majority of three parity projections.
 * `linkFractions: false` skips the per-link ray casts that only interpolated walls read.
 */
export function voxelize(
  body: Mesh,
  supports: Mesh | null,
  layout: Layout,
  opts: { floor: boolean; linkFractions?: boolean },
): VoxelGrid {
  for (const size of [layout.nx, layout.ny, layout.nz]) {
    if (!Number.isSafeInteger(size) || size < 2) {
      throw new RangeError('Grid dimensions must be integers of at least two cells.');
    }
  }
  validateMesh(body);
  if (supports) validateMesh(supports);
  const flags = new Uint32Array(layout.nx * layout.ny * layout.nz);
  const bodyClosed = voteMesh(body, layout, flags, SOLID);
  const supportsClosed = supports ? voteMesh(supports, layout, flags, SUPPORT) : true;
  applyBoundaries(flags, layout, opts.floor);
  const counts = countCells(flags, layout);
  const walls = buildWallLinks(
    flags,
    body,
    supports,
    layout,
    opts.floor,
    opts.linkFractions ?? true,
  );
  return { ...layout, ...walls, ...counts, watertight: bodyClosed && supportsClosed };
}
