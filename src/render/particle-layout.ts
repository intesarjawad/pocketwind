import type { Layout } from '../geometry/voxel-grid';
import { CELL_TYPE_MASK, CellType } from '../geometry/voxel-grid';
import type { Point3 } from './camera';
import type { DomainBounds } from './lines-pipeline';

export const PARTICLE_BYTES = 32;
export const PARTICLE_PARAMS_BYTES = 64;
export const MAX_AGE_FRAMES = 4000;
const MAX_PARTICLES = 65536;
export type ParticleGrid = Layout & { readonly geometry: Uint32Array };
export type SeedRegion = readonly [number, number, number, number];

/** Enlarge the full cross-section width and height by 30%, clipped to interior cells. */
export function seedRegion(bounds: DomainBounds, layout: Layout): SeedRegion {
  const extentY = bounds.max[1] - bounds.min[1];
  const extentZ = bounds.max[2] - bounds.min[2];
  const region: SeedRegion = [
    Math.max(1, bounds.min[1] - extentY * 0.15),
    Math.max(1, bounds.min[2] - extentZ * 0.15),
    Math.min(layout.ny - 2, bounds.max[1] + extentY * 0.15),
    Math.min(layout.nz - 2, bounds.max[2] + extentZ * 0.15),
  ];
  if (
    ![layout.nx, layout.ny, layout.nz].every((v) => Number.isSafeInteger(v) && v >= 5) ||
    ![...bounds.min, ...bounds.max].every(Number.isFinite) ||
    extentY <= 0 ||
    extentZ <= 0 ||
    region[0] >= region[2] ||
    region[1] >= region[3]
  ) {
    throw new RangeError(
      'Particle seeds need a positive cross-section inside a grid of at least five cells per axis.',
    );
  }
  return region;
}

/** Positions use lattice nodes as cell centres, matching the macro field. */
export function particleNeedsReseed(
  position: Point3,
  age: number,
  layout: Layout,
  flag: number,
): boolean {
  return (
    !position.every(Number.isFinite) ||
    position[0] < 0 ||
    position[0] >= layout.nx - 2 ||
    position[1] < 0 ||
    position[1] >= layout.ny - 1 ||
    position[2] < 0 ||
    position[2] >= layout.nz - 1 ||
    age > MAX_AGE_FRAMES ||
    (flag & CELL_TYPE_MASK) !== CellType.FLUID
  );
}

export function particleHash(value: number): number {
  let result = value >>> 0;
  result = Math.imul(result ^ (result >>> 16), 0x7feb352d) >>> 0;
  result = Math.imul(result ^ (result >>> 15), 0x846ca68b) >>> 0;
  return (result ^ (result >>> 16)) >>> 0;
}

/** Initial records and the fallback both use fluid inlet nodes; prev equals pos. */
export function particleSeeds(
  grid: ParticleGrid,
  bounds: DomainBounds,
  count: number,
  seed: number,
) {
  const region = seedRegion(bounds, grid);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_PARTICLES ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    grid.geometry.length < grid.nx * grid.ny * grid.nz
  ) {
    throw new RangeError('Particle count, seed or geometry buffer is invalid.');
  }
  const inlet: Point3[] = [];
  for (let z = Math.round(region[1]); z <= Math.round(region[3]); z += 1) {
    for (let y = Math.round(region[0]); y <= Math.round(region[2]); y += 1) {
      const point: Point3 = [
        2,
        Math.fround(Math.max(region[0], Math.min(y, region[2]))),
        Math.fround(Math.max(region[1], Math.min(z, region[3]))),
      ];
      if (
        !particleNeedsReseed(
          point,
          0,
          grid,
          grid.geometry[2 + grid.nx * (Math.round(point[1]) + grid.ny * Math.round(point[2]))] ??
            CellType.SOLID,
        )
      )
        inlet.push(point);
    }
  }
  const fallback = inlet[0];
  if (!fallback) throw new RangeError('The particle seed region has no fluid inlet cells.');
  const data = new Float32Array((count * PARTICLE_BYTES) / 4);
  for (let id = 0; id < count; id += 1) {
    const point = inlet[particleHash((id + seed) >>> 0) % inlet.length] ?? fallback;
    data.set([...point, 0, ...point, 0], id * 8);
  }
  return { data, region, fallback };
}

export function packParticleParams(
  grid: Layout,
  count: number,
  seed: number,
  steps: number,
  region: SeedRegion,
  fallback: Point3,
): ArrayBuffer {
  if (!Number.isFinite(Math.fround(steps)) || steps < 0)
    throw new RangeError('Particle advection needs non-negative finite solver steps.');
  const buffer = new ArrayBuffer(PARTICLE_PARAMS_BYTES);
  new Uint32Array(buffer).set([grid.nx, grid.ny, grid.nz, count, seed]);
  new Float32Array(buffer).set([steps, 0, 0, ...region, fallback[1], fallback[2], 0, 0], 5);
  return buffer;
}
