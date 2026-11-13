import { describe, expect, it } from 'vitest';
import { type VerificationResults, verificationRows } from '../../../src/validation/verification';

const STAMP = { commit: 'abc1234', date: '2026-11-06T00:00:00.000Z' };

function taylorGreen(n: 16 | 32 | 64, steps: number, error: number, decayRate: number | null) {
  return { n, steps, amplitude: 0.001, error, decayRate, expectedDecayRate: 0.0077 };
}

function poiseuille(tau0: number, maxSpeedErrorPct: number, forceX = 0) {
  return {
    tau0,
    operator: 'trt' as const,
    steps: 100,
    maxChange: 1e-13,
    maxSpeed: 0.1,
    maxSpeedErrorPct,
    profileErrorPct: 0.2,
    profile: [],
    centeredProfile: [],
    analyticProfile: [],
    force: [1, 0, 0] as [number, number, number],
    expectedForce: [1, 0, 0] as const,
    forceError: [forceX, 0, 0],
  };
}

function results(): VerificationResults {
  return {
    passed: true,
    taylorGreen: {
      cases: [
        taylorGreen(16, 50, 0.0024, null),
        taylorGreen(32, 200, 0.0006, 0.0077),
        taylorGreen(64, 800, 0.00015, null),
      ],
      observedOrder: [1.99, 2.0],
      decayRelativeError: 0.0002,
    },
    poiseuille: [poiseuille(0.6, -0.3), poiseuille(3, 0.9)],
    bgk: { ...poiseuille(3, 13.5), operator: 'trt' as const },
  } as VerificationResults;
}

describe('verification rows', () => {
  it('gives one row per analytic case, with the observed order against the next coarser grid', () => {
    const rows = verificationRows(results(), STAMP);
    expect(rows.map((row) => row.case)).toEqual([
      'taylor-green-16',
      'taylor-green-32',
      'taylor-green-64',
      'poiseuille-tau0-0.6',
      'poiseuille-tau0-3',
      'poiseuille-bgk-tau0-3',
    ]);
    expect(rows.map((row) => row.observedOrder)).toEqual([null, 1.99, 2.0, null, null, null]);
    expect(rows.map((row) => row.decayRelativeError)).toEqual([
      null,
      0.0002,
      null,
      null,
      null,
      null,
    ]);
    expect(rows[3]).toMatchObject({
      kind: 'poiseuille',
      tau0: 0.6,
      errorPct: -0.3,
      profileErrorPct: 0.2,
      forceError: [0, 0, 0],
      ...STAMP,
    });
    expect(rows[0]).toMatchObject({ kind: 'taylor-green', error: 0.0024, errorPct: null });
  });

  it('passes inside the thresholds and marks BGK as passing only by its offset', () => {
    expect(verificationRows(results(), STAMP).map((row) => row.pass)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('fails a row outside its threshold', () => {
    const bad = results();
    bad.taylorGreen.observedOrder = [1.99, 1.5];
    bad.poiseuille = [poiseuille(0.6, 2), poiseuille(3, 0.9, 1e-6)];
    bad.bgk = poiseuille(3, 1);
    expect(verificationRows(bad, STAMP).map((row) => row.pass)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
