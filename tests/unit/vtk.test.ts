import { describe, expect, it } from 'vitest';
import { writeVtk } from '../../src/io/vtk';

const NX = 8;
const NY = 8;
const NZ = 8;
const CELLS = NX * NY * NZ;
const CELL_SIZE_M = 0.002;

function field() {
  const rho = new Float32Array(CELLS);
  const velocity = new Float32Array(CELLS * 3);
  for (let cell = 0; cell < CELLS; cell += 1) {
    rho[cell] = cell + 0.5;
    velocity[cell * 3] = cell;
    velocity[cell * 3 + 1] = -cell;
    velocity[cell * 3 + 2] = cell * 0.25;
  }
  return { nx: NX, ny: NY, nz: NZ, cellSizeM: CELL_SIZE_M, rho, velocity };
}

function find(bytes: Uint8Array, text: string): number {
  const needle = new TextEncoder().encode(text);
  for (let start = 0; start + needle.length <= bytes.length; start += 1) {
    let match = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[start + index] !== needle[index]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return -1;
}

describe('VTK field writer', () => {
  const bytes = writeVtk(field());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rhoStart = find(bytes, 'LOOKUP_TABLE default\n') + 'LOOKUP_TABLE default\n'.length;
  const velocityHeader = 'VECTORS velocity float\n';
  const velocityStart = rhoStart + CELLS * 4 + 1 + velocityHeader.length;

  it('writes the legacy header lines', () => {
    const header = new TextDecoder().decode(bytes.slice(0, rhoStart));
    expect(header.split('\n')).toEqual([
      '# vtk DataFile Version 3.0',
      'PocketWind field',
      'BINARY',
      'DATASET STRUCTURED_POINTS',
      'DIMENSIONS 8 8 8',
      'ORIGIN 0 0 0',
      'SPACING 0.002 0.002 0.002',
      'POINT_DATA 512',
      'SCALARS rho float 1',
      'LOOKUP_TABLE default',
      '',
    ]);
  });

  it('writes the first 100 densities as big-endian float32', () => {
    for (let cell = 0; cell < 100; cell += 1) {
      expect(view.getFloat32(rhoStart + cell * 4, false)).toBe(cell + 0.5);
    }
  });

  it('writes the first 100 velocity vectors as big-endian float32', () => {
    expect(bytes[rhoStart + CELLS * 4]).toBe(0x0a);
    expect(new TextDecoder().decode(bytes.slice(rhoStart + CELLS * 4 + 1, velocityStart))).toBe(
      velocityHeader,
    );
    for (let cell = 0; cell < 100; cell += 1) {
      const offset = velocityStart + cell * 12;
      expect(view.getFloat32(offset, false)).toBe(cell);
      expect(view.getFloat32(offset + 4, false)).toBe(-cell);
      expect(view.getFloat32(offset + 8, false)).toBe(cell * 0.25);
    }
  });

  it('ends after the velocity block with a single newline', () => {
    expect(bytes).toHaveLength(velocityStart + CELLS * 12 + 1);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
  });

  it('rejects arrays that do not match the dimensions', () => {
    const valid = field();
    expect(() => writeVtk({ ...valid, rho: new Float32Array(CELLS - 1) })).toThrow(RangeError);
    expect(() => writeVtk({ ...valid, velocity: new Float32Array(CELLS * 3 - 1) })).toThrow(
      RangeError,
    );
  });

  it('rejects dimensions and spacing that cannot describe a grid', () => {
    const valid = field();
    expect(() => writeVtk({ ...valid, nx: 0 })).toThrow(RangeError);
    expect(() => writeVtk({ ...valid, nz: 2.5 })).toThrow(RangeError);
    expect(() => writeVtk({ ...valid, cellSizeM: 0 })).toThrow(RangeError);
  });
});
