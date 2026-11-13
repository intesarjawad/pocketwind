import { describe, expect, it } from 'vitest';
import {
  countDeflected,
  MIN_DEFLECTED_PARTICLES,
  particlesDeflected,
} from '../../../src/render/deflection';

/** Each record is position, age, previous position and generation. */
function records(steps: readonly (readonly [number, number, number])[]): Float32Array {
  const data = new Float32Array(steps.length * 8);
  steps.forEach(([dx, dy, dz], id) => {
    data.set([10 + dx, 5 + dy, 5 + dz, 1, 10, 5, 5, 0], id * 8);
  });
  return data;
}

describe('particle deflection', () => {
  it('leaves a free stream alone', () => {
    const data = records([
      [0.4, 0, 0],
      [0.4, 0.01, -0.02],
      [0.4, 0.039, 0],
    ]);
    expect(countDeflected(data, 3)).toBe(0);
  });

  it('counts a step that turns toward either cross-stream axis', () => {
    const data = records([
      [0.4, 0.05, 0],
      [0.4, 0, -0.05],
      [0.4, 0.03, 0.03],
      [0, 0.2, 0],
    ]);
    expect(countDeflected(data, 4)).toBe(4);
  });

  it('ignores respawned and stationary records and non-finite positions', () => {
    const data = records([
      [0, 0, 0],
      [0, 0.0005, 0],
      [Number.NaN, 0.3, 0],
    ]);
    expect(countDeflected(data, 3)).toBe(0);
  });

  it('reads only the first count records', () => {
    const data = records([
      [0.4, 0, 0],
      [0.4, 0.3, 0],
    ]);
    expect(countDeflected(data, 1)).toBe(0);
  });

  it('needs a few particles before it calls the frame smoky', () => {
    const bent = Array.from({ length: MIN_DEFLECTED_PARTICLES }, () => [0.4, 0.2, 0] as const);
    expect(particlesDeflected(records(bent), bent.length)).toBe(true);
    expect(particlesDeflected(records(bent.slice(1)), bent.length - 1)).toBe(false);
  });
});
