import type { Mesh } from './stl';
import type { Layout } from './voxel-grid';

type Point = readonly [number, number, number];
export type TriangleBins = {
  mesh: Mesh;
  bounds: Float32Array;
  bins: (number[] | undefined)[];
  nx: number;
  ny: number;
  nz: number;
};

const BIN_SIZE_CELLS = 4;
const INTERSECTION_EPSILON = 1e-9;

function triangleExtent(p: Float32Array, offset: number, axis: number): readonly [number, number] {
  const a = p[offset + axis] ?? 0;
  const b = p[offset + axis + 3] ?? 0;
  const c = p[offset + axis + 6] ?? 0;
  return [Math.min(a, b, c), Math.max(a, b, c)];
}

/** Index triangle bounding boxes in four-cell bins for short wall-link rays. */
export function binTriangles(mesh: Mesh, layout: Layout): TriangleBins {
  const nx = Math.ceil(layout.nx / BIN_SIZE_CELLS);
  const ny = Math.ceil(layout.ny / BIN_SIZE_CELLS);
  const nz = Math.ceil(layout.nz / BIN_SIZE_CELLS);
  const bins: TriangleBins['bins'] = new Array(nx * ny * nz);
  const bounds = new Float32Array(mesh.triangleCount * 6);
  for (let offset = 0; offset < mesh.positions.length; offset += 9) {
    const [x0, x1] = triangleExtent(mesh.positions, offset, 0);
    const [y0, y1] = triangleExtent(mesh.positions, offset, 1);
    const [z0, z1] = triangleExtent(mesh.positions, offset, 2);
    bounds.set([x0, y0, z0, x1, y1, z1], (offset / 9) * 6);
    const minX = Math.floor(x0 / BIN_SIZE_CELLS);
    const maxX = Math.floor(x1 / BIN_SIZE_CELLS);
    const minY = Math.floor(y0 / BIN_SIZE_CELLS);
    const maxY = Math.floor(y1 / BIN_SIZE_CELLS);
    const minZ = Math.floor(z0 / BIN_SIZE_CELLS);
    const maxZ = Math.floor(z1 / BIN_SIZE_CELLS);
    for (let z = Math.max(0, minZ); z <= Math.min(nz - 1, maxZ); z += 1) {
      for (let y = Math.max(0, minY); y <= Math.min(ny - 1, maxY); y += 1) {
        for (let x = Math.max(0, minX); x <= Math.min(nx - 1, maxX); x += 1) {
          const index = x + nx * (y + ny * z);
          const bin = bins[index] ?? [];
          bin.push(offset);
          bins[index] = bin;
        }
      }
    }
  }
  return { mesh, bounds, bins, nx, ny, nz };
}

function pointAt(p: Float32Array, offset: number): Point {
  return [p[offset] ?? 0, p[offset + 1] ?? 0, p[offset + 2] ?? 0];
}

function intersection(
  p: Float32Array,
  offset: number,
  origin: Point,
  direction: Point,
): number | null {
  const [ax, ay, az] = pointAt(p, offset);
  const [bx, by, bz] = pointAt(p, offset + 3);
  const [cx, cy, cz] = pointAt(p, offset + 6);
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const [dx, dy, dz] = direction;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < Number.EPSILON) return null;
  const tx = origin[0] - ax;
  const ty = origin[1] - ay;
  const tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) / determinant;
  if (u < -INTERSECTION_EPSILON || u > 1 + INTERSECTION_EPSILON) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) / determinant;
  if (v < -INTERSECTION_EPSILON || u + v > 1 + INTERSECTION_EPSILON) return null;
  // An unnormalised lattice direction makes t the fraction of the whole link.
  const t = (e2x * qx + e2y * qy + e2z * qz) / determinant;
  return t >= -INTERSECTION_EPSILON && t <= 1 + INTERSECTION_EPSILON ? t : null;
}

type LinkBounds = readonly [number, number, number, number, number, number];

function overlaps(bounds: Float32Array, triangleOffset: number, ray: LinkBounds): boolean {
  const base = (triangleOffset / 9) * 6;
  return (
    (bounds[base] ?? Infinity) <= ray[3] &&
    (bounds[base + 3] ?? -Infinity) >= ray[0] &&
    (bounds[base + 1] ?? Infinity) <= ray[4] &&
    (bounds[base + 4] ?? -Infinity) >= ray[1] &&
    (bounds[base + 2] ?? Infinity) <= ray[5] &&
    (bounds[base + 5] ?? -Infinity) >= ray[2]
  );
}

function nearestInBin(
  index: TriangleBins,
  offsets: number[],
  origin: Point,
  direction: Point,
  bounds: LinkBounds,
): number {
  let nearest = Infinity;
  for (const offset of offsets) {
    if (!overlaps(index.bounds, offset, bounds)) continue;
    nearest = Math.min(
      nearest,
      intersection(index.mesh.positions, offset, origin, direction) ?? Infinity,
    );
  }
  return nearest;
}

function rayBinExtent(origin: number, direction: number): readonly [number, number] {
  return [
    Math.floor(Math.min(origin, origin + direction) / BIN_SIZE_CELLS),
    Math.floor(Math.max(origin, origin + direction) / BIN_SIZE_CELLS),
  ];
}

/** Return the nearest triangle intersection as a fraction of a lattice link. */
export function nearestLinkHit(
  index: TriangleBins,
  origin: Point,
  direction: Point,
): number | null {
  const [minX, maxX] = rayBinExtent(origin[0], direction[0]);
  const [minY, maxY] = rayBinExtent(origin[1], direction[1]);
  const [minZ, maxZ] = rayBinExtent(origin[2], direction[2]);
  const bounds: LinkBounds = [
    Math.min(origin[0], origin[0] + direction[0]),
    Math.min(origin[1], origin[1] + direction[1]),
    Math.min(origin[2], origin[2] + direction[2]),
    Math.max(origin[0], origin[0] + direction[0]),
    Math.max(origin[1], origin[1] + direction[1]),
    Math.max(origin[2], origin[2] + direction[2]),
  ];
  let nearest = Infinity;
  for (let z = Math.max(0, minZ); z <= Math.min(index.nz - 1, maxZ); z += 1) {
    for (let y = Math.max(0, minY); y <= Math.min(index.ny - 1, maxY); y += 1) {
      for (let x = Math.max(0, minX); x <= Math.min(index.nx - 1, maxX); x += 1) {
        const bin = index.bins[x + index.nx * (y + index.ny * z)];
        if (bin) nearest = Math.min(nearest, nearestInBin(index, bin, origin, direction, bounds));
      }
    }
  }
  return nearest === Infinity ? null : nearest;
}
