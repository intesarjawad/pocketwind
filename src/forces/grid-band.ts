import { gridConvergence } from './convergence';

export type GridBandRow = { h: number; cd: number };

export type GridBand =
  | { kind: 'band'; gciPct: number; extrapolatedCd: number }
  | { kind: 'no-band'; reason: 'oscillatory' | 'divergent' | 'insufficient' };

/**
 * Turn three drag coefficients from refined grids into a grid-sampling band.
 * A band is offered only for a monotone sequence; any other shape or a row that
 * cannot be a measurement says why no band exists instead of inventing one.
 */
export function gridBand(rows: readonly GridBandRow[]): GridBand {
  const usable = rows.every(
    (row) => Number.isFinite(row.cd) && row.h > 0 && Number.isFinite(row.h),
  );
  if (!usable) return { kind: 'no-band', reason: 'insufficient' };
  const result = gridConvergence(rows.map(({ h, cd }) => ({ h, value: cd })));
  if (result.kind !== 'monotone') return { kind: 'no-band', reason: result.kind };
  return { kind: 'band', gciPct: result.gciFinePct, extrapolatedCd: result.extrapolated };
}
