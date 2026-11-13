import type { Layout } from '../geometry/voxel-grid';
import { DIRECTIONS } from './lattice';

export type { Layout } from '../geometry/voxel-grid';
export type Precision = 'f32' | 'f16';

export const TIERS = {
  S: { nx: 128, ny: 64, nz: 64, particles: 16384 },
  M: { nx: 192, ny: 96, nz: 96, particles: 65536 },
  L: { nx: 256, ny: 128, nz: 128, particles: 65536 },
  XL: { nx: 384, ny: 192, nz: 192, particles: 65536 },
} as const;

// Geometry stores flags and q offsets; macros store density and three velocities.
const GEOMETRY_BYTES_PER_CELL = 2 * Uint32Array.BYTES_PER_ELEMENT;
const MACRO_BYTES_PER_CELL = 4 * Float32Array.BYTES_PER_ELEMENT;
const POPULATION_BUFFERS = 2;
const POPULATION_BYTES = { f32: 4, f16: 2 } as const;

/** A storage binding covers a whole buffer, whose byte size must be a multiple of four. */
export function populationBufferBytes(
  cells: number,
  directions: number,
  precision: Precision,
): number {
  return Math.ceil((cells * directions * POPULATION_BYTES[precision]) / 4) * 4;
}

/** Count population, geometry and macro bytes, excluding mesh-dependent q links and particles. */
export function bytesForLayout(layout: Layout, precision: Precision): number {
  for (const size of [layout.nx, layout.ny, layout.nz]) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new RangeError('Grid dimensions must be positive safe integers.');
    }
  }
  const bytesPerCell =
    POPULATION_BUFFERS * DIRECTIONS.length * POPULATION_BYTES[precision] +
    GEOMETRY_BYTES_PER_CELL +
    MACRO_BYTES_PER_CELL;
  const bytes = layout.nx * layout.ny * layout.nz * bytesPerCell;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError('Layout byte count exceeds the safe integer range.');
  }
  return bytes;
}
