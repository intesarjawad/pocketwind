import { U_LU } from '../lbm/units';
import { type Field, writeVtk } from './vtk';

export type LatticeField = {
  nx: number;
  ny: number;
  nz: number;
  /** Edge length of one cell in metres. */
  cellSizeM: number;
  /** Inlet speed in metres per second; it fixes the lattice-to-physical velocity scale. */
  speedMps: number;
  /** Density in lattice units, where the free stream is one. */
  rho: Float32Array;
  /** Interleaved x, y, z velocity per cell in lattice units. */
  velocity: Float32Array;
};

/**
 * Scale lattice velocity to metres per second. The lattice inlet speed U_LU
 * stands for the physical inlet speed, so the ratio is speedMps / U_LU.
 */
export function latticeToField(input: LatticeField): Field {
  const { speedMps, velocity, ...rest } = input;
  if (!Number.isFinite(speedMps) || speedMps <= 0) {
    throw new RangeError('speedMps must be a positive finite number.');
  }
  const scale = speedMps / U_LU;
  return { ...rest, velocity: velocity.map((value) => value * scale) };
}

/** The legacy VTK bytes for a solved field, with velocity in metres per second. */
export function fieldVtkBytes(input: LatticeField): Uint8Array {
  return writeVtk(latticeToField(input));
}

/** Path separators and reserved characters would split or reject the download name. */
export function fieldFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return `${safe === '' ? 'untitled' : safe}-field.vtk`;
}
