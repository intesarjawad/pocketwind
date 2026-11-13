import { describe, expect, it } from 'vitest';
import {
  clampSpeedMps,
  DEFAULT_SETTINGS,
  DEFAULT_SPEED_MPS,
  MAX_SPEED_MPS,
  MIN_SPEED_MPS,
} from '../../src/app/params';
import { buildCases } from '../../src/validation/cases';

describe('speed parameters', () => {
  it('defaults inside the slider range', () => {
    expect(MIN_SPEED_MPS).toBe(5);
    expect(MAX_SPEED_MPS).toBe(60);
    expect(DEFAULT_SPEED_MPS).toBe(40);
    expect(DEFAULT_SPEED_MPS).toBeGreaterThanOrEqual(MIN_SPEED_MPS);
    expect(DEFAULT_SPEED_MPS).toBeLessThanOrEqual(MAX_SPEED_MPS);
    expect(DEFAULT_SETTINGS.speedMps).toBe(DEFAULT_SPEED_MPS);
  });

  it('runs the Ahmed validation cases at the default speed', () => {
    const cases = buildCases().filter(
      (row) => row.group === 'validation' && row.shape === 'ahmed-25',
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const row of cases) expect(row.speedMps).toBe(DEFAULT_SPEED_MPS);
  });

  it('clamps the v hash parameter into the slider range', () => {
    expect(clampSpeedMps(MIN_SPEED_MPS - 10)).toBe(MIN_SPEED_MPS);
    expect(clampSpeedMps(MAX_SPEED_MPS + 10)).toBe(MAX_SPEED_MPS);
    expect(clampSpeedMps(22)).toBe(22);
    expect(clampSpeedMps(Number.NaN)).toBe(DEFAULT_SPEED_MPS);
  });
});
