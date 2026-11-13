import { describe, expect, it } from 'vitest';
import { figureGrade, figureVerdict } from '../../../src/app/figure-grade';
import { exposurePath, formatRe, plateTitle } from '../../../src/app/plate-caption';
import type { DragSummary } from '../../../src/forces/drag-stats';

const steady = (semPct: number | null): DragSummary => ({
  cd: 1.88,
  status: { kind: 'steady', relStdPct: 0.4, driftPct: 0.1 },
  samples: 400,
  semPct,
});

describe('figure grade', () => {
  it('is eroded before any value and while settling', () => {
    expect(figureGrade({ ...steady(0.1), cd: null })).toBe('Redaction 10');
    expect(
      figureGrade({ cd: 2.1, status: { kind: 'settling', etaS: null }, samples: 20, semPct: 0.1 }),
    ).toBe('Redaction 10');
  });
  it('reaches the clean cut only when sampling and grid bands together fall under 0.25%', () => {
    expect(figureGrade(steady(0.001))).toBe('Redaction 10');
    expect(figureGrade(steady(0.001), 0.1)).toBe('Redaction');
    expect(figureGrade(steady(0.2), 0.2)).toBe('Redaction 10');
    expect(figureGrade(steady(0.1), 3)).toBe('Redaction 10');
  });
  it('falls back to the fluctuation when no batch band exists', () => {
    expect(figureGrade(steady(null))).toBe('Redaction 10');
  });
});

describe('figure verdict', () => {
  it('names the state, the band and the grid check', () => {
    expect(figureVerdict(steady(0.004))).toBe('steady, sampling band under 1%, grid check not run');
    expect(figureVerdict(steady(0.83), 2.4)).toBe(
      'steady, sampling band under 1%, grid band ±2.4%',
    );
    expect(figureVerdict(steady(2.6))).toBe('steady, sampling band ±3%, grid check not run');
  });
  it('marks a withheld figure as the last reported value', () => {
    const withheld = { ...steady(null), cd: null };
    expect(figureVerdict(withheld)).toBe('waiting for enough independent samples to report drag');
    expect(figureVerdict(withheld, null, 'instantaneous')).toBe(
      'instantaneous drag, waiting for enough independent samples to report a band',
    );
    expect(figureVerdict(withheld, null, 'last reported')).toBe(
      'steady, last reported value, too few independent samples for a band',
    );
  });
});

describe('plate caption helpers', () => {
  it('lifts the exposure line across a gap such as the body', () => {
    const points = [
      [10, 100],
      [10, 90],
      [11, 80],
      [60, 20],
      [61, 10],
    ] as const;
    expect(exposurePath(points)).toBe('M10.0 100.0 L10.0 90.0 L11.0 80.0 M60.0 20.0 L61.0 10.0');
    expect(exposurePath([])).toBe('');
  });
  it('writes Reynolds numbers in words at plate scale', () => {
    expect(formatRe(480)).toBe('480');
    expect(formatRe(267_000)).toBe('267 thousand');
    expect(formatRe(2_784_000)).toBe('2.8 million');
  });
});

it('uses the current diameter in a sphere title', () => {
  expect(plateTitle('sphere', 'Sphere', 200)).toEqual(['Sphere,', '200 mm']);
});
