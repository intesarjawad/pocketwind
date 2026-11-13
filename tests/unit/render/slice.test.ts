import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLOR_MAPS,
  COLOR_STOPS,
  colorAt,
  cpValue,
  legendGradient,
  legendTicks,
  speedValue,
} from '../../../src/render/colormap';
import {
  packSliceParams,
  SLICE_PARAMS_BYTES,
  sliceKeyAction,
} from '../../../src/render/slice-pipeline';

const grid = { nx: 32, ny: 20, nz: 16 };

describe('slice fields', () => {
  it('scales speed by the inlet speed of 0.05', () => {
    expect(speedValue(0.03, 0.04, 0)).toBeCloseTo(1, 12);
    expect(speedValue(0, 0, -0.1)).toBeCloseTo(2, 12);
    expect(speedValue(0, 0, 0)).toBe(0);
  });
  it('turns density into Cp with p = rho / 3 and dynamic pressure 0.00125', () => {
    expect(cpValue(1)).toBe(0);
    expect(cpValue(1.00375)).toBeCloseTo(1, 12);
    expect(cpValue(1.00125)).toBeCloseTo(1 / 3, 12);
    expect(cpValue(0.99625)).toBeCloseTo(-1, 12);
  });
});

describe('colour maps', () => {
  it('gives each map the stop count the shader declares', () => {
    const shader = readFileSync(
      new URL('../../../src/render/shaders/slice.wgsl', import.meta.url),
      'utf8',
    );
    expect(shader).toContain(`array<vec4f, ${COLOR_STOPS}>`);
    expect(COLOR_MAPS.speed.stops).toHaveLength(COLOR_STOPS);
    expect(COLOR_MAPS.cp.stops).toHaveLength(COLOR_STOPS);
  });
  it('centres the diverging map on zero at its neutral grey', () => {
    expect(COLOR_MAPS.cp.low).toBe(-COLOR_MAPS.cp.high);
    expect(colorAt('cp', 0)).toEqual([247 / 255, 247 / 255, 247 / 255, 1]);
  });
  it('interpolates between neighbouring stops and clamps outside the range', () => {
    const [r, g, b, a] = colorAt('speed', 0.125);
    expect(r).toBeCloseTo(69.5 / 255, 12);
    expect(g).toBeCloseTo(22.5 / 255, 12);
    expect(b).toBeCloseTo(103 / 255, 12);
    expect(a).toBe(1);
    expect(colorAt('speed', -5)).toEqual([0x44 / 255, 0x01 / 255, 0x54 / 255, 1]);
    expect(colorAt('speed', 9)).toEqual([0xfd / 255, 0xe7 / 255, 0x25 / 255, 1]);
  });
  it('labels the legend with numeric ticks at their fractional positions', () => {
    expect(legendTicks('cp')).toEqual([
      { offset: 0, label: '\u22121.5' },
      { offset: 0.25, label: '\u22120.75' },
      { offset: 0.5, label: '0' },
      { offset: 0.75, label: '0.75' },
      { offset: 1, label: '1.5' },
    ]);
    expect(legendTicks('speed').map((tick) => tick.label)).toEqual(['0', '0.5', '1', '1.5', '2']);
    expect(legendGradient('speed')).toBe(
      'linear-gradient(to right, #440154, #472c7a, #3b518b, #2c718e, #21908d, #27ad81, #5cc863, #aadc32, #fde725)',
    );
  });
});

describe('slice uniforms', () => {
  it('packs dimensions, plane and field as integers and the map as vec4 stops', () => {
    const buffer = packSliceParams(grid, 10, 'cp');
    expect(buffer.byteLength).toBe(SLICE_PARAMS_BYTES);
    expect(SLICE_PARAMS_BYTES).toBe(176);
    expect(Array.from(new Uint32Array(buffer).slice(0, 5))).toEqual([32, 20, 16, 10, 1]);
    const floats = new Float32Array(buffer);
    expect(Array.from(floats.slice(5, 8))).toEqual([Math.fround(0.05), -1.5, 1.5]);
    expect(Array.from(floats.slice(8, 12))).toEqual(
      [0x21 / 255, 0x66 / 255, 0xac / 255, 1].map(Math.fround),
    );
    expect(Array.from(floats.slice(40, 44))).toEqual(
      [0xb2 / 255, 0x18 / 255, 0x2b / 255, 1].map(Math.fround),
    );
    expect(new Uint32Array(packSliceParams(grid, 0, 'speed'))[4]).toBe(0);
  });
  it('rejects planes outside the grid and degenerate grids', () => {
    for (const plane of [-1, 20, 1.5, NaN])
      expect(() => packSliceParams(grid, plane, 'speed')).toThrow(RangeError);
    expect(() => packSliceParams({ nx: 32, ny: 1, nz: 16 }, 0, 'speed')).toThrow(RangeError);
  });
});

describe('slice keys', () => {
  const key = { code: 'KeyS', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  it('toggles on S and switches the field on Shift+S', () => {
    expect(sliceKeyAction(key)).toBe('toggle');
    expect(sliceKeyAction({ ...key, shiftKey: true })).toBe('switch');
  });
  it('ignores other keys and browser shortcuts', () => {
    expect(sliceKeyAction({ ...key, code: 'KeyR' })).toBeUndefined();
    expect(sliceKeyAction({ ...key, ctrlKey: true })).toBeUndefined();
    expect(sliceKeyAction({ ...key, metaKey: true, shiftKey: true })).toBeUndefined();
    expect(sliceKeyAction({ ...key, altKey: true })).toBeUndefined();
  });
});
