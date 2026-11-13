import { describe, expect, it, vi } from 'vitest';
import { AllocationFailure } from '../../src/lbm/gpu-solver';
import type { TIERS } from '../../src/lbm/layout';
import { allocateWithStepDown, decideTier, predictTimeTo2TS } from '../../src/lbm/tier-probe';

// At U_LU = 0.05, M needs 7,680 steps and L needs 10,240 steps to reach 2T.
const mBoundaryFromS = 60_000 / (7680 * (192 / 128) ** 3);
// Exact rational avoids rounding the cubed 4/3 ratio before forming the boundary.
const lBoundaryFromM = 20250 / 8192;

describe('tier decision', () => {
  it('scales step time by cells and answer time by flow-through length', () => {
    expect(predictTimeTo2TS({ tier: 'S', msPerStep: 1 }, 'L')).toBe(81.92);
    expect(predictTimeTo2TS({ tier: 'M', msPerStep: 1 }, 'M')).toBe(7.68);
  });

  it('keeps S even when S itself exceeds the budget', () => {
    expect(decideTier({ tier: 'S', msPerStep: 100 })).toEqual({
      kind: 'selected',
      tier: 'S',
      predictedTimeTo2TS: 512,
    });
  });

  it('does not request M above its predicted budget', () => {
    expect(decideTier({ tier: 'S', msPerStep: mBoundaryFromS * (1 + 1e-10) })).toMatchObject({
      kind: 'selected',
      tier: 'S',
    });
  });

  it.each([1, 1 - 1e-10])('requests M at or below the inclusive boundary (%s)', (factor) => {
    expect(decideTier({ tier: 'S', msPerStep: mBoundaryFromS * factor })).toEqual({
      kind: 'measure-m',
    });
  });

  it.each([1, 1 - 1e-10])('selects L at or below the inclusive boundary (%s)', (factor) => {
    expect(decideTier({ tier: 'M', msPerStep: lBoundaryFromM * factor })).toMatchObject({
      kind: 'selected',
      tier: 'L',
    });
  });

  it('selects M when L is just over budget', () => {
    expect(decideTier({ tier: 'M', msPerStep: lBoundaryFromM * (1 + 1e-10) })).toMatchObject({
      kind: 'selected',
      tier: 'M',
    });
  });

  it('returns to S if measured M is slower than predicted', () => {
    expect(decideTier({ tier: 'M', msPerStep: 60_000 / 7680 + 0.001 })).toMatchObject({
      kind: 'selected',
      tier: 'S',
    });
  });

  it.each([1, 1 - 1e-10])('keeps measured M at or below its own boundary (%s)', (factor) => {
    expect(decideTier({ tier: 'M', msPerStep: (60_000 / 7680) * factor })).toMatchObject({
      kind: 'selected',
      tier: 'M',
    });
  });

  it('never selects XL even with negligible measured step time', () => {
    expect(decideTier({ tier: 'M', msPerStep: 0.000001 })).toMatchObject({
      kind: 'selected',
      tier: 'L',
    });
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid step time %s', (msPerStep) => {
    expect(() => decideTier({ tier: 'S', msPerStep })).toThrow(RangeError);
  });
});

describe('allocation step-down', () => {
  it('returns a successful first allocation without a fallback message', async () => {
    const value = {};
    const create = vi.fn(async () => value);
    expect(await allocateWithStepDown('L', create)).toEqual({
      status: 'ok',
      tier: 'L',
      value,
      message: null,
    });
    expect(create.mock.calls).toHaveLength(1);
  });

  it.each([
    ['XL', 'L'],
    ['L', 'M'],
    ['M', 'S'],
  ] as const)('retries %s once at %s and names the running tier', async (tier, lower) => {
    const value = {};
    const create = vi.fn(async (requested: keyof typeof TIERS) =>
      requested === tier ? new AllocationFailure('No GPU memory') : value,
    );
    const result = await allocateWithStepDown(tier, create);
    expect(create.mock.calls).toEqual([[tier], [lower]]);
    expect(result).toMatchObject({ status: 'ok', tier: lower, value });
    expect(result.message?.what).toContain(`Running tier ${lower}`);
    expect(result.message?.next).toContain('Close other GPU-heavy tabs');
  });

  it('stops after M also fails and never claims that M ran', async () => {
    const failure = new AllocationFailure('No GPU memory');
    const create = vi.fn(async () => failure);
    const result = await allocateWithStepDown('L', create);
    expect(create.mock.calls).toEqual([['L'], ['M']]);
    expect(result).toMatchObject({ status: 'error', tier: 'M', error: failure });
    expect(result.message?.what).toContain('tier M');
    expect(result.message?.what).not.toContain('Running');
  });

  it('does not retry below S', async () => {
    const create = vi.fn(async () => new AllocationFailure('No GPU memory'));
    expect(await allocateWithStepDown('S', create)).toMatchObject({ status: 'error', tier: 'S' });
    expect(create.mock.calls).toEqual([['S']]);
  });

  it('propagates unrelated failures without retrying', async () => {
    const error = new Error('Device lost');
    const create = vi.fn(async () => {
      throw error;
    });
    await expect(allocateWithStepDown('L', create)).rejects.toBe(error);
    expect(create.mock.calls).toEqual([['L']]);
  });
});
