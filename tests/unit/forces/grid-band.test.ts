import { describe, expect, it } from 'vitest';
import { gridBand } from '../../../src/forces/grid-band';

describe('grid band', () => {
  it('turns a monotone sequence into a band and its limit', () => {
    // Cd = 1 + 0.5 h^2 sampled at h = 1, 2, 4: order 2, limit 1, GCI = 1.25 * (0.5 / 1.5) * 100 / 3.
    const band = gridBand([
      { h: 4, cd: 9 },
      { h: 1, cd: 1.5 },
      { h: 2, cd: 3 },
    ]);
    if (band.kind !== 'band') throw new Error(`Expected a band, got ${band.reason}`);
    expect(band.extrapolatedCd).toBeCloseTo(1, 9);
    expect(band.gciPct).toBeCloseTo(125 / 3, 9);
  });

  it('gives no band when the values alternate', () => {
    expect(
      gridBand([
        { h: 1, cd: 1 },
        { h: 2, cd: 2 },
        { h: 3, cd: 1 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'oscillatory' });
  });

  it('gives no band when the change grows toward the fine grid', () => {
    expect(
      gridBand([
        { h: 1, cd: 1 },
        { h: 2, cd: 3 },
        { h: 3, cd: 4 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'divergent' });
  });

  it('gives no band for fewer than three rows or identical rows', () => {
    expect(
      gridBand([
        { h: 1, cd: 1.5 },
        { h: 2, cd: 3 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'insufficient' });
    expect(
      gridBand([
        { h: 1, cd: 2 },
        { h: 2, cd: 2 },
        { h: 4, cd: 2 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'insufficient' });
  });

  it('refuses a row that is not a measurement', () => {
    expect(
      gridBand([
        { h: 1, cd: Number.NaN },
        { h: 2, cd: 3 },
        { h: 4, cd: 9 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'insufficient' });
    expect(
      gridBand([
        { h: 0, cd: 1 },
        { h: 2, cd: 3 },
        { h: 4, cd: 9 },
      ]),
    ).toEqual({ kind: 'no-band', reason: 'insufficient' });
  });
});
