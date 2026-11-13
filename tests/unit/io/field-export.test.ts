import { describe, expect, it } from 'vitest';
import { fieldFileName, fieldVtkBytes, latticeToField } from '../../../src/io/field-export';

const N = 8;
const CELLS = N * N * N;
const HEADER =
  '# vtk DataFile Version 3.0\nPocketWind field\nBINARY\nDATASET STRUCTURED_POINTS\n' +
  'DIMENSIONS 8 8 8\nORIGIN 0 0 0\nSPACING 0.004 0.004 0.004\nPOINT_DATA 512\n' +
  'SCALARS rho float 1\nLOOKUP_TABLE default\n';

function input() {
  const rho = new Float32Array(CELLS);
  const velocity = new Float32Array(CELLS * 3);
  for (let cell = 0; cell < CELLS; cell += 1) {
    rho[cell] = 1 + cell / 1024;
    velocity[cell * 3] = 0.05;
    velocity[cell * 3 + 1] = 0.025;
    velocity[cell * 3 + 2] = -0.0125;
  }
  return { nx: N, ny: N, nz: N, cellSizeM: 0.004, speedMps: 20, rho, velocity };
}

describe('field export', () => {
  it('scales lattice velocity so the inlet speed maps to the physical speed', () => {
    const field = latticeToField(input());
    // 20 m/s at a lattice speed of 0.05 is 400 m/s per lattice unit.
    expect(Array.from(field.velocity.slice(0, 3))).toEqual([20, 10, -5]);
    expect(field.rho).toEqual(input().rho);
  });

  it('does not change the lattice arrays it was given', () => {
    const source = input();
    latticeToField(source);
    expect(source.velocity[0]).toBe(Math.fround(0.05));
  });

  it('writes a file whose header, size and first 100 values read back', () => {
    const bytes = fieldVtkBytes(input());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(new TextDecoder().decode(bytes.slice(0, HEADER.length))).toBe(HEADER);
    const rhoStart = HEADER.length;
    const velocityStart = rhoStart + CELLS * 4 + 1 + 'VECTORS velocity float\n'.length;
    for (let cell = 0; cell < 100; cell += 1) {
      expect(view.getFloat32(rhoStart + cell * 4, false)).toBe(1 + cell / 1024);
      expect(view.getFloat32(velocityStart + cell * 12, false)).toBe(20);
      expect(view.getFloat32(velocityStart + cell * 12 + 4, false)).toBe(10);
      expect(view.getFloat32(velocityStart + cell * 12 + 8, false)).toBe(-5);
    }
    expect(bytes).toHaveLength(velocityStart + CELLS * 12 + 1);
  });

  it('rejects a speed that cannot scale the field', () => {
    expect(() => latticeToField({ ...input(), speedMps: 0 })).toThrow(RangeError);
    expect(() => latticeToField({ ...input(), speedMps: Number.NaN })).toThrow(RangeError);
  });

  it('names the download after the run and removes reserved characters', () => {
    expect(fieldFileName('Ahmed 25')).toBe('Ahmed 25-field.vtk');
    expect(fieldFileName('a/b:c')).toBe('a-b-c-field.vtk');
    expect(fieldFileName('  ')).toBe('untitled-field.vtk');
  });
});
