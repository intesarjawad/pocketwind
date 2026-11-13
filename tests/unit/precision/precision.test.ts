import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS, WEIGHTS } from '../../../src/lbm/lattice';
import { resolveStorage } from '../../../src/lbm/precision';

// The strongest scale budget still leaves quiet-flow deviations in f16's normal range.
const POP_SCALE = 32768;
const RELATIVE_TOLERANCE = 1e-3;
const QUIET_FLOW = [0.004, 0, 0] as const;
const F16_MIN_NORMAL = 2 ** -14;

function shiftedEquilibrium(velocity: readonly [number, number, number]): number[] {
  const speedSquared = velocity[0] ** 2 + velocity[1] ** 2 + velocity[2] ** 2;
  return WEIGHTS.map((weight, index) => {
    const [cx = 0, cy = 0, cz = 0] = DIRECTIONS[index] ?? [];
    const cu = cx * velocity[0] + cy * velocity[1] + cz * velocity[2];
    return weight * (3 * cu + 4.5 * cu * cu - 1.5 * speedSquared);
  });
}

function relativeError(stored: number, exact: number): number {
  return Math.abs(stored - exact) / Math.abs(exact);
}

function store(value: number, scale: number): number {
  return Math.f16round(value * scale) / scale;
}

describe('population storage precision', () => {
  it('keeps every quiet-flow population within 1e-3 when stored with the 2^15 scale', () => {
    const exact = shiftedEquilibrium(QUIET_FLOW);
    for (const value of exact) {
      expect(relativeError(store(value, POP_SCALE), value)).toBeLessThan(RELATIVE_TOLERANCE);
    }
  });

  it('loses more than 1e-3 without the scale because quiet deviations land in f16 subnormals', () => {
    const exact = shiftedEquilibrium(QUIET_FLOW);
    const smallest = Math.min(...exact.map((value) => Math.abs(value)));
    expect(smallest).toBeLessThan(F16_MIN_NORMAL);
    const worst = Math.max(...exact.map((value) => relativeError(store(value, 1), value)));
    expect(worst).toBeGreaterThan(RELATIVE_TOLERANCE);
  });

  it('keeps the shader preludes on the same scale the storage path assumes', () => {
    const read = (name: string): string =>
      readFileSync(new URL(`../../../src/lbm/shaders/${name}`, import.meta.url), 'utf8');
    expect(read('prelude-f32.wgsl')).toContain('const POP_SCALE: f32 = 1.0;');
    expect(read('prelude-f16.wgsl')).toContain('enable f16;');
    expect(read('prelude-f16.wgsl')).toContain('alias pop = f16;');
    expect(read('prelude-f16.wgsl')).toContain(`const POP_SCALE: f32 = ${POP_SCALE}.0;`);
  });
});

describe('automatic storage choice', () => {
  const advertised = new Set(['shader-f16']);

  it('selects float16 when the adapter advertises it after the measured drag gate', () => {
    expect(resolveStorage('auto', new Set())).toBe('f32');
    expect(resolveStorage('auto', advertised)).toBe('f16');
  });

  it('honors explicit float32 and falls back when float16 is unavailable', () => {
    expect(resolveStorage('f16', advertised)).toBe('f16');
    expect(resolveStorage('f16', new Set())).toBe('f32');
    expect(resolveStorage('f32', advertised)).toBe('f32');
  });
});
