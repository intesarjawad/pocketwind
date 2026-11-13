import { describe, expect, it } from 'vitest';
import type { CompareRow } from '../../../src/app/compare';
import {
  bandOnSecondRow,
  GRID_CHECK_L_LIMIT_S,
  type GridCheckRequest,
  type GridCheckRunner,
  gridBandText,
  gridCheckAvailability,
  gridCheckLengthCells,
  gridCheckSteps,
  meanOfLast,
  NO_BAND_TEXTS,
  predictLRunSeconds,
  runFlowThroughsFromHash,
  runGridCheck,
} from '../../../src/app/grid-check';
import type { ForceHistoryPoint } from '../../../src/io/run-file';

const NX = { S: 128, M: 192, L: 256 } as const;
const CURRENT = { lengthCells: 128, nx: 128 };

/** Cd = 1 + (1000 / cells)^2: second order in the cell size with limit 1. */
const quadraticCd = (lengthCells: number) => 1 + (1000 / lengthCells) ** 2;

/** A transient far above the settled value, then settled points inside the averaged half. */
function settledHistory(request: GridCheckRequest, cd: number): ForceHistoryPoint[] {
  const total = Math.ceil(0.5 * (NX[request.tier] / 0.05));
  return [
    [8, 100],
    [total - 16, cd],
    [total, cd],
  ];
}

function fakeRunner(log: string[], cdOf = quadraticCd): GridCheckRunner {
  let alive = 0;
  return async (request) => {
    alive += 1;
    log.push(`start ${request.tier} ${request.lengthCells} alive=${alive}`);
    request.onHistory(settledHistory(request, cdOf(request.lengthCells)));
    return {
      nx: NX[request.tier],
      dispose() {
        alive -= 1;
        log.push(`dispose ${request.tier}`);
      },
    };
  };
}

describe('grid check plan', () => {
  it('keeps the body share of the domain on every tier', () => {
    expect(gridCheckLengthCells({ lengthCells: 64, nx: 128 }, 'S')).toBe(64);
    expect(gridCheckLengthCells({ lengthCells: 64, nx: 128 }, 'M')).toBe(96);
    expect(gridCheckLengthCells({ lengthCells: 64, nx: 128 }, 'L')).toBe(128);
    // 51 / 128 of 192 cells is 76.5, which rounds up.
    expect(gridCheckLengthCells({ lengthCells: 51, nx: 128 }, 'M')).toBe(77);
    expect(gridCheckLengthCells({ lengthCells: 51, nx: 128 }, 'L')).toBe(102);
  });

  it('refuses a run without a body length', () => {
    expect(() => gridCheckLengthCells({ lengthCells: 0, nx: 128 }, 'S')).toThrow(RangeError);
  });

  it('counts four flow-throughs and averages the newest two', () => {
    expect(gridCheckSteps('S', 4)).toEqual({ totalSteps: 10240, averageSteps: 5120 });
    expect(gridCheckSteps('L', 0.5)).toEqual({ totalSteps: 2560, averageSteps: 1280 });
    expect(() => gridCheckSteps('S', 0)).toThrow(RangeError);
  });

  it('reads the run length from the hash and ignores bad values', () => {
    expect(runFlowThroughsFromHash('#/?gcT=0.5')).toBe(0.5);
    expect(runFlowThroughsFromHash('#/')).toBe(4);
    expect(runFlowThroughsFromHash('#/?gcT=0')).toBe(4);
    expect(runFlowThroughsFromHash('#/?gcT=abc')).toBe(4);
  });
});

describe('grid check availability', () => {
  it('scales the 2T prediction of tier L to the run length', () => {
    // 1 ms per step on S predicts 81.92 s to 2T on L, so 4T takes twice that.
    expect(predictLRunSeconds({ tier: 'S', msPerStep: 1 }, 4)).toBeCloseTo(163.84, 10);
    expect(predictLRunSeconds({ tier: 'S', msPerStep: 1 }, 0.5)).toBeCloseTo(20.48, 10);
  });

  it('is ready while L stays inside the limit and off past it', () => {
    expect(gridCheckAvailability({ tier: 'S', msPerStep: 3.6 }, 's-m-l')).toEqual({
      kind: 'ready',
    });
    const off = gridCheckAvailability({ tier: 'S', msPerStep: 3.7 }, 's-m-l');
    expect(off.kind).toBe('disabled');
    if (off.kind === 'disabled') {
      expect(off.reason).toContain(`above ${GRID_CHECK_L_LIMIT_S} s`);
      expect(off.reason).toContain('about 606 s');
    }
  });

  it('is off on a GPU limited to tier S', () => {
    expect(gridCheckAvailability({ tier: 'S', msPerStep: 0.1 }, 's-only').kind).toBe('disabled');
  });
});

describe('mean of the newest steps', () => {
  it('averages only the points inside the window', () => {
    const history: ForceHistoryPoint[] = [
      [100, 50],
      [700, 2],
      [1000, 4],
    ];
    expect(meanOfLast(history, 400)).toBe(3);
    expect(meanOfLast([], 400)).toBeNull();
    expect(meanOfLast([[8, Number.NaN]], 400)).toBeNull();
  });
});

describe('running the grid check', () => {
  it('runs S, M and L one at a time, then restores the previous run', async () => {
    const log: string[] = [];
    let restored = 0;
    const result = await runGridCheck({
      current: CURRENT,
      runFlowThroughs: 0.5,
      runner: fakeRunner(log),
      restore: async () => {
        restored += 1;
        log.push('restore');
      },
      signal: new AbortController().signal,
    });
    expect(log).toEqual([
      'start S 128 alive=1',
      'dispose S',
      'start M 192 alive=1',
      'dispose M',
      'start L 256 alive=1',
      'dispose L',
      'restore',
    ]);
    expect(restored).toBe(1);
    if (result.kind !== 'done') throw new Error('Expected a finished check');
    expect(result.rows.map((row) => row.lengthCells)).toEqual([128, 192, 256]);
    expect(result.rows.map((row) => row.cd)).toEqual([128, 192, 256].map(quadraticCd));
    if (result.band.kind !== 'band') throw new Error(`Expected a band, got ${result.band.reason}`);
    expect(result.band.extrapolatedCd).toBeCloseTo(1, 6);
    expect(result.band.gciPct).toBeGreaterThan(0);
  });

  it('gives the no-band wording when the three runs alternate', async () => {
    const cds = [3, 4, 3.5];
    let index = 0;
    const result = await runGridCheck({
      current: CURRENT,
      runFlowThroughs: 0.5,
      runner: fakeRunner([], () => cds[index++] ?? 0),
      restore: async () => {},
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      kind: 'done',
      band: { kind: 'no-band', reason: 'oscillatory' },
    });
  });

  it('cancels between runs, disposes the live one and restores', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const runner: GridCheckRunner = async (request) => {
      log.push(`start ${request.tier}`);
      if (request.tier === 'M') queueMicrotask(() => controller.abort());
      else request.onHistory(settledHistory(request, 2));
      return { nx: NX[request.tier], dispose: () => log.push(`dispose ${request.tier}`) };
    };
    const result = await runGridCheck({
      current: CURRENT,
      runFlowThroughs: 0.5,
      runner,
      restore: async () => {
        log.push('restore');
      },
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(log).toEqual(['start S', 'dispose S', 'start M', 'dispose M', 'restore']);
  });

  it('treats a runner that throws after an abort as cancelled', async () => {
    const controller = new AbortController();
    const result = await runGridCheck({
      current: CURRENT,
      runner: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
      restore: async () => {},
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('refuses a run that stepped down to another grid, and still restores', async () => {
    let restored = false;
    let disposed = false;
    const runner: GridCheckRunner = async () => ({
      nx: 128,
      dispose() {
        disposed = true;
      },
    });
    await expect(
      runGridCheck({
        current: CURRENT,
        runner: async (request) =>
          request.tier === 'S' ? fakeRunner([])(request) : runner(request),
        restore: async () => {
          restored = true;
        },
        signal: new AbortController().signal,
        runFlowThroughs: 0.5,
      }),
    ).rejects.toThrow('another grid');
    expect(disposed).toBe(true);
    expect(restored).toBe(true);
  });
});

describe('grid band wording', () => {
  it('states the band and the extrapolated value', () => {
    expect(gridBandText({ kind: 'band', gciPct: 2.345, extrapolatedCd: 0.3012 })).toBe(
      'grid band ±2.3% (extrapolated Cd 0.301)',
    );
  });

  it('uses a distinct wording for each reason there is no band', () => {
    const texts = (['oscillatory', 'divergent', 'insufficient'] as const).map((reason) =>
      gridBandText({ kind: 'no-band', reason }),
    );
    expect(texts).toEqual(Object.values(NO_BAND_TEXTS));
    expect(new Set(texts).size).toBe(3);
  });
});

describe('compare mode', () => {
  const steady = { kind: 'steady', relStdPct: 0.5, driftPct: 0.2 } as const;
  const row = (label: string, cdaM2: number): CompareRow => ({
    label,
    cd: cdaM2 * 10,
    cdaM2,
    status: steady,
    semPct: 1,
  });

  it('puts the band on row 2 and leaves row 1 and the verdict as they were', () => {
    const state = {
      first: row('Sphere', 1),
      second: row('Cube', 1.02),
      outcome: { kind: 'unresolved', deltaPct: 2, bandPct: 2.8 } as const,
    };
    const band = { kind: 'band', gciPct: 3.1, extrapolatedCd: 0.5 } as const;
    const banded = bandOnSecondRow(state, band);
    expect(banded.first).toBe(state.first);
    expect(banded.outcome).toBe(state.outcome);
    expect(banded.second).toEqual({ ...state.second, gridBand: band });
    expect(state.second).not.toHaveProperty('gridBand');
  });
});
