import { describe, expect, it } from 'vitest';
import {
  batchLength,
  createDragStats,
  semPct,
  TOO_FEW_INDEPENDENT_SAMPLES,
  tauInt,
} from '../../../src/forces/drag-stats';

const FLOW_THROUGH = 100;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function naiveSemPct(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return (100 * Math.sqrt(variance / values.length)) / Math.abs(mean);
}

function constantSeries(fx: number, lastStep: number): ReturnType<typeof createDragStats> {
  const stats = createDragStats(400);
  for (let step = 0; step <= lastStep; step += 10) stats.push(step, fx);
  return stats;
}

describe('drag statistics', () => {
  it('reports a constant force as steady with no fluctuation or drift', () => {
    const summary = constantSeries(12, 2400).summary(null);
    expect(summary.status).toEqual({ kind: 'steady', relStdPct: 0, driftPct: 0 });
    expect(summary.cd).toBe(12);
    expect(summary.samples).toBe(40);
    expect(summary.semPct).toBe(0);
  });

  it('reports a ten-percent sine as unsteady', () => {
    const stats = createDragStats(FLOW_THROUGH);
    for (let step = 0; step <= 1000; step += 1) {
      stats.push(step, 10 + Math.sin((2 * Math.PI * step) / 200));
    }
    const summary = stats.summary(null);
    expect(summary.status.kind).toBe('unsteady');
  });

  it('reports settling during a ramp and steady once the window is constant', () => {
    const stats = createDragStats(FLOW_THROUGH);
    for (let step = 0; step <= 100; step += 10) stats.push(step, step / 20);
    expect(stats.summary(null).status).toEqual({ kind: 'settling', etaS: null });
    expect(stats.summary(50).status).toEqual({ kind: 'settling', etaS: 2 });
    for (let step = 110; step <= 1200; step += 10) stats.push(step, 10);
    expect(stats.summary(null).status.kind).toBe('steady');
  });

  it('reports a one-and-a-half-percent drift across the window as unsteady', () => {
    const stats = createDragStats(800);
    for (let step = 0; step <= 1600; step += 10) {
      stats.push(step, 10 * (1 + 0.0000375 * (step - 800)));
    }
    const summary = stats.summary(null);
    expect(summary.status.kind).toBe('unsteady');
    if (summary.status.kind === 'unsteady') {
      expect(summary.status.driftPct).toBeGreaterThan(1);
      expect(summary.status.relStdPct).toBeLessThan(1);
    }
  });

  it('recovers the same mean from sparse samples as from dense ones', () => {
    const dense = createDragStats(1000);
    const sparse = createDragStats(1000);
    for (let step = 0; step <= 3150; step += 1) {
      dense.push(step, 10 + Math.sin((2 * Math.PI * step) / 50));
    }
    for (let step = 0; step <= 3150; step += 50) {
      sparse.push(step, 10 + Math.sin((2 * Math.PI * step) / 50));
    }
    const denseCd = dense.summary(null).cd ?? NaN;
    const sparseCd = sparse.summary(null).cd ?? NaN;
    expect(Math.abs(denseCd - sparseCd)).toBeLessThan(1e-12);
  });

  it('estimates white-noise standard error from batch means', () => {
    const random = mulberry32(42);
    const values = Array.from({ length: 512 }, () => 1 + 0.02 * standardNormal(random));
    const expected = 2 / Math.sqrt(512);
    const estimate = semPct(values);
    expect(estimate).not.toBeNull();
    expect(Math.abs((estimate ?? NaN) / expected - 1)).toBeLessThan(0.25);
  });

  it('inflates the standard error for autocorrelated samples', () => {
    const random = mulberry32(7);
    const innovation = 0.02 * Math.sqrt(1 - 0.9 * 0.9);
    let state = 0;
    for (let i = 0; i < 200; i++) state = 0.9 * state + innovation * standardNormal(random);
    const values: number[] = [];
    for (let i = 0; i < 512; i++) {
      state = 0.9 * state + innovation * standardNormal(random);
      values.push(1 + state);
    }
    const estimate = semPct(values) ?? NaN;
    expect(estimate).toBeGreaterThanOrEqual(2 * naiveSemPct(values));
  });

  it('withholds Cd when a sine fills the window with too few independent samples', () => {
    const stats = createDragStats(250);
    for (let step = 0; step <= 2000; step += 1) {
      stats.push(step, Math.sin((2 * Math.PI * step) / 1000));
    }
    const summary = stats.summary(null);
    expect(summary.cd).toBeNull();
    expect(summary.semPct).toBeNull();
    expect(summary.reason).toBe(TOO_FEW_INDEPENDENT_SAMPLES);
  });

  it('batches a sine over at least a third of its period', () => {
    const period = 2000;
    const values = Array.from({ length: 10241 }, (_, step) =>
      Math.sin((2 * Math.PI * step) / period),
    );
    expect(batchLength(values)).toBeGreaterThanOrEqual(0.3 * period);
  });

  it('counts one sample interval of integral time for white noise', () => {
    const values = [1, -1, 1, -1, 1, -1, 1, -1];
    expect(tauInt(values, 8)).toBe(8);
  });

  it('rejects invalid configuration and out-of-order samples', () => {
    expect(() => createDragStats(0)).toThrow(RangeError);
    expect(() => createDragStats(FLOW_THROUGH, Number.NaN)).toThrow(RangeError);
    expect(() => tauInt([1, 2, 3], 0)).toThrow(RangeError);
    const stats = createDragStats(FLOW_THROUGH);
    stats.push(10, 1);
    expect(() => stats.push(10, 2)).toThrow(RangeError);
    expect(() => stats.push(11, Number.NaN)).toThrow(RangeError);
  });
});
