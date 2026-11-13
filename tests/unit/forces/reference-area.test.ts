import { describe, expect, it } from 'vitest';
import { frontalAreaM2, referenceAreaCells } from '../../../src/forces/reference-area';

describe('frontal reference area', () => {
  it('scales the projected cell count by the square of the cell size', () => {
    expect(frontalAreaM2(100, 0.005)).toBe(0.0025);
    expect(frontalAreaM2(0, 0.005)).toBe(0);
  });

  it('converts a preset area from square millimetres and keeps a voxel count', () => {
    expect(referenceAreaCells(112_000, 0, 10)).toBe(1120);
    expect(referenceAreaCells(undefined, 100, 0.005)).toBe(100);
  });

  for (const value of [-1, 1.5, NaN, Infinity]) {
    it(`rejects an invalid cell count: ${value}`, () => {
      expect(() => frontalAreaM2(value, 0.005)).toThrow(RangeError);
      expect(() => referenceAreaCells(undefined, value, 10)).toThrow(RangeError);
    });
  }

  for (const value of [0, -0.005, NaN, Infinity]) {
    it(`rejects an invalid cell size: ${value}`, () => {
      expect(() => frontalAreaM2(100, value)).toThrow(RangeError);
      expect(() => referenceAreaCells(112_000, 0, value)).toThrow(RangeError);
    });
  }

  for (const value of [0, -1, NaN, Infinity]) {
    it(`rejects an invalid preset area: ${value}`, () => {
      expect(() => referenceAreaCells(value, 0, 10)).toThrow(RangeError);
    });
  }
});
