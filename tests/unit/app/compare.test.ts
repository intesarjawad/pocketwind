import { describe, expect, it } from 'vitest';
import {
  bandPct,
  type CompareRow,
  compareOutcome,
  deltaForcePct,
  NO_DIFFERENCE_TEXT,
  outcomeText,
  run2LimitSteps,
  TOO_FEW_SAMPLES_TEXT,
} from '../../../src/app/compare';

const STEADY = { kind: 'steady', relStdPct: 0.5, driftPct: 0.2 } as const;

function row(cdaM2: number | null, semPct: number | null): CompareRow {
  return { label: 'body', cd: cdaM2 === null ? null : cdaM2 * 10, cdaM2, status: STEADY, semPct };
}

const LIMIT = { step: 100, limitSteps: 1000 };
const PAST_LIMIT = { step: 1000, limitSteps: 1000 };

describe('change in drag force', () => {
  it('is the percent change of CdA from the first run', () => {
    expect(deltaForcePct(0.04, 0.03)).toBeCloseTo(-25, 10);
    expect(deltaForcePct(2, 2.5)).toBe(25);
    expect(deltaForcePct(0.5, 0.5)).toBe(0);
  });

  it('refuses a first run with no positive drag area', () => {
    expect(() => deltaForcePct(0, 1)).toThrow(RangeError);
    expect(() => deltaForcePct(Number.NaN, 1)).toThrow(RangeError);
  });
});

describe('sampling band', () => {
  it('is two standard errors of the difference', () => {
    expect(bandPct(1.5, 2)).toBe(5);
    expect(bandPct(0.3, 0.4)).toBeCloseTo(1, 12);
    expect(bandPct(0, 0)).toBe(0);
  });

  it('refuses a standard error that is negative or not finite', () => {
    expect(() => bandPct(-1, 1)).toThrow(RangeError);
    expect(() => bandPct(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('comparison outcome', () => {
  it('combines absolute SEMs before expressing the band against run 1', () => {
    const outcome = compareOutcome(row(1, 0), row(1.1, 4.8), LIMIT);
    expect(outcome.kind).toBe('unresolved');
    if (!('bandPct' in outcome)) throw new Error('Expected a measured comparison.');
    expect(outcome.bandPct).toBeCloseTo(10.56, 12);
  });

  it('says no difference and names no winner inside the band', () => {
    const outcome = compareOutcome(row(100, 1.5), row(102, 2), LIMIT);
    expect(outcome).toEqual({
      kind: 'unresolved',
      deltaPct: 2,
      bandPct: expect.closeTo(5.064227483, 8),
    });
    const text = outcomeText(outcome);
    expect(text).toBe('ΔF% +2.0 (band ±5.1%): no difference this grid can resolve.');
    expect(text).toContain(NO_DIFFERENCE_TEXT);
    expect(text).not.toContain('lower drag');
  });

  it('treats a change exactly on the band as inside it', () => {
    const outcome = compareOutcome(row(2, 12.5), row(2.5, 0), LIMIT);
    expect(outcome).toEqual({ kind: 'unresolved', deltaPct: 25, bandPct: 25 });
  });

  it('names the run with lower drag once the change clears the band', () => {
    const lower = compareOutcome(row(1, 1), row(0.8, 1), LIMIT);
    expect(lower.kind).toBe('resolved');
    expect(outcomeText(lower)).toBe('ΔF% -20.0 (band ±2.6%): run 2 has lower drag than run 1.');
    const higher = compareOutcome(row(0.5, 1), row(0.6, 1), LIMIT);
    expect(outcomeText(higher)).toBe('ΔF% +20.0 (band ±3.1%): run 1 has lower drag than run 2.');
  });

  it('waits for run 2 while either standard error is missing', () => {
    expect(compareOutcome(row(1, null), row(1, 1), LIMIT)).toEqual({ kind: 'running' });
    expect(compareOutcome(row(1, 1), row(null, null), LIMIT)).toEqual({ kind: 'running' });
  });

  it('gives up at the step limit and names no winner', () => {
    for (const [first, second] of [
      [row(1, null), row(1, 1)],
      [row(1, 1), row(1, null)],
      [row(1, null), row(1, null)],
    ] as const) {
      const outcome = compareOutcome(first, second, PAST_LIMIT);
      expect(outcome).toEqual({ kind: 'too-few' });
      expect(outcomeText(outcome)).toBe(`Comparison: ${TOO_FEW_SAMPLES_TEXT}.`);
    }
    expect(TOO_FEW_SAMPLES_TEXT).toBe(
      'too few independent samples to compare; run longer or use a higher tier',
    );
  });

  it('uses the verdict as soon as both standard errors exist, even past the limit', () => {
    expect(compareOutcome(row(1, 1), row(1, 1), PAST_LIMIT).kind).toBe('unresolved');
  });

  it('cannot divide by a first run with no drag area', () => {
    expect(compareOutcome(row(0, 1), row(1, 1), LIMIT)).toEqual({ kind: 'running' });
    expect(compareOutcome(row(0, 1), row(1, 1), PAST_LIMIT)).toEqual({ kind: 'too-few' });
  });
});

describe('run 2 step limit', () => {
  it('is six flow-throughs of the grid length', () => {
    // 128 cells at 0.05 lattice units per step is 2560 steps per flow-through.
    expect(run2LimitSteps(128)).toBe(6 * 2560);
  });
});
