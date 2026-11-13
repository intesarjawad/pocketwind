import { describe, expect, it } from 'vitest';
import {
  cdPerLatticeForce,
  NU_AIR,
  NU_MIN_LU,
  physicalToLattice,
  U_LU,
} from '../../../src/lbm/units';

describe('physical to lattice units', () => {
  it('uses the prescribed air viscosity and inlet speed', () => {
    expect(NU_AIR).toBe(1.5e-5);
    expect(U_LU).toBe(0.05);
    expect(NU_MIN_LU).toBe(1e-2);
  });

  it('converts physical reference length in metres to nominal Reynolds number', () => {
    const result = physicalToLattice({ speedMps: 40, refLengthM: 1.044, refLengthCells: 102.4 });
    expect(result.re).toBeCloseTo(2784000, 8);
    expect(result.viscosityLu).toBe(NU_MIN_LU);
  });

  it('preserves Reynolds similarity when refining the reference length in cells', () => {
    // Re 33, so both viscosities sit above the floor.
    const physical = { speedMps: 5, refLengthM: 0.0001 };
    const coarse = physicalToLattice({ ...physical, refLengthCells: 20 });
    const fine = physicalToLattice({ ...physical, refLengthCells: 40 });
    expect(fine.re).toBe(coarse.re);
    expect(fine.viscosityLu).toBeCloseTo(2 * coarse.viscosityLu, 15);
  });

  it('accepts a direct Reynolds number for verification cases', () => {
    const result = physicalToLattice({ re: 100, refLengthCells: 20 });
    expect(result).toEqual({ re: 100, viscosityLu: 0.01 });
  });

  it.each([500000, 1000000, 1e12])(
    'floors viscosity at high Reynolds number %s without changing nominal Re',
    (re) => {
      expect(physicalToLattice({ re, refLengthCells: 10 })).toEqual({ re, viscosityLu: NU_MIN_LU });
    },
  );

  it('floors physical inputs while preserving nominal Reynolds number', () => {
    const result = physicalToLattice({ speedMps: 60, refLengthM: 1.044, refLengthCells: 10 });
    expect(result.re).toBeCloseTo(4176000, 8);
    expect(result.viscosityLu).toBe(NU_MIN_LU);
  });

  for (const value of [0, -1, NaN, Infinity]) {
    it(`rejects nonpositive or nonfinite scale inputs: ${value}`, () => {
      expect(() => physicalToLattice({ re: value, refLengthCells: 20 })).toThrow(RangeError);
      expect(() => physicalToLattice({ re: 100, refLengthCells: value })).toThrow(RangeError);
      expect(() =>
        physicalToLattice({ speedMps: value, refLengthM: 1, refLengthCells: 20 }),
      ).toThrow(RangeError);
      expect(() =>
        physicalToLattice({ speedMps: 40, refLengthM: value, refLengthCells: 20 }),
      ).toThrow(RangeError);
    });
  }

  it('rejects unrepresentable derived scales', () => {
    expect(() =>
      physicalToLattice({ speedMps: Number.MAX_VALUE, refLengthM: 2, refLengthCells: 20 }),
    ).toThrow(RangeError);
    expect(() => physicalToLattice({ re: Number.MIN_VALUE, refLengthCells: 20 })).toThrow(
      RangeError,
    );
  });
});

describe('cdPerLatticeForce', () => {
  it('turns the lattice dynamic pressure on the frontal cells into Cd 1', () => {
    const frontalCells = 432;
    const force = 0.5 * U_LU * U_LU * frontalCells;
    expect(force * cdPerLatticeForce(frontalCells)).toBeCloseTo(1, 12);
  });

  it('rejects a body with no frontal cells', () => {
    expect(() => cdPerLatticeForce(0)).toThrow(RangeError);
  });
});
