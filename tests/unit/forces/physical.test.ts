import { describe, expect, it } from 'vitest';
import {
  AIR_DENSITY,
  cdaM2,
  cdPerNewton,
  dragForceFromCda,
  dragForceN,
  dynamicPressurePa,
  RHO_AIR,
} from '../../../src/forces/physical';

describe('physical drag units', () => {
  it('uses standard-air density', () => {
    expect(RHO_AIR).toBe(1.204);
    expect(AIR_DENSITY).toBe(RHO_AIR);
  });

  it('converts Cd, reference area and speed to newtons', () => {
    expect(dragForceN(0.3, 0.112, 40)).toBeCloseTo(0.5 * 1.204 * 1600 * 0.0336, 12);
  });

  it('forms the drag area before applying dynamic pressure', () => {
    const dragArea = cdaM2(0.3, 0.112);
    expect(dragArea).toBeCloseTo(0.0336, 12);
    expect(dragForceN(0.3, 0.112, 40)).toBeCloseTo(dragForceFromCda(dragArea, 40), 12);
  });

  it('reports dynamic pressure and the reciprocal force scale independently', () => {
    expect(dynamicPressurePa(40)).toBeCloseTo(0.5 * 1.204 * 1600, 12);
    expect(dragForceN(0.3, 0.112, 40) * cdPerNewton(0.112, 40)).toBeCloseTo(0.3, 12);
  });

  it('accepts zero drag and an explicit density', () => {
    expect(dragForceN(0, 0.112, 40)).toBe(0);
    expect(dragForceN(0.3, 0.112, 40, 1.225)).toBeCloseTo(0.5 * 1.225 * 1600 * 0.0336, 12);
  });

  for (const value of [-1, NaN, Infinity]) {
    it(`rejects an invalid drag coefficient: ${value}`, () => {
      expect(() => dragForceN(value, 0.112, 40)).toThrow(RangeError);
      expect(() => cdaM2(value, 0.112)).toThrow(RangeError);
    });
  }

  for (const value of [0, -1, NaN, Infinity]) {
    it(`rejects invalid area and speed inputs: ${value}`, () => {
      expect(() => dragForceN(0.3, value, 40)).toThrow(RangeError);
      expect(() => dragForceN(0.3, 0.112, value)).toThrow(RangeError);
      expect(() => cdaM2(0.3, value)).toThrow(RangeError);
      expect(() => cdPerNewton(value, 40)).toThrow(RangeError);
      expect(() => dynamicPressurePa(value)).toThrow(RangeError);
    });
  }

  for (const value of [-1, NaN, Infinity]) {
    it(`rejects an invalid drag area: ${value}`, () => {
      expect(() => dragForceFromCda(value, 40)).toThrow(RangeError);
    });
  }
});
