import { type GridBand, gridBand } from '../forces/grid-band';
import type { TierPolicy } from '../gpu/device';
import type { ForceHistoryPoint } from '../io/run-file';
import { TIERS } from '../lbm/layout';
import { predictTimeTo2TS } from '../lbm/tier-probe';
import { flowThroughSteps } from '../validation/cases';
import type { CompareOutcome, CompareRow } from './compare';
import type { ComparePanelState } from './compare-panel';

export type GridCheckTier = 'S' | 'M' | 'L';

/** Coarse to fine, so the last run is the one the band is judged against. */
export const GRID_CHECK_TIERS: readonly GridCheckTier[] = ['S', 'M', 'L'];
/** Each run covers this many flow-throughs unless `gcT` says otherwise; the newest half is averaged. */
export const GRID_CHECK_FLOW_THROUGHS = 4;
/** The finest run is the slow one, so a prediction above this keeps the check from starting. */
export const GRID_CHECK_L_LIMIT_S = 600;

export const NO_BAND_TEXTS = {
  oscillatory: 'no grid band: the drag coefficient does not move steadily with grid size',
  divergent: 'no grid band: the drag coefficient changes more on finer grids',
  insufficient: 'no grid band: the three runs did not give a usable drag coefficient each',
} as const;

export type GridCheckRow = {
  readonly tier: GridCheckTier;
  readonly lengthCells: number;
  readonly cd: number | null;
};

export type GridCheckResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'done'; readonly rows: readonly GridCheckRow[]; readonly band: GridBand };

/** One run the check asks for. The runner must solve exactly this tier with the body this long. */
export type GridCheckRequest = {
  readonly tier: GridCheckTier;
  readonly lengthCells: number;
  readonly signal: AbortSignal;
  readonly onHistory: (history: readonly ForceHistoryPoint[]) => void;
};

/** `nx` lets the check refuse a run that stepped down to another tier. */
export type GridCheckRunHandle = { readonly nx: number; readonly dispose: () => void };

export type GridCheckRunner = (request: GridCheckRequest) => Promise<GridCheckRunHandle | null>;

export type GridCheckOptions = {
  /** The run being checked: body length in cells over the streamwise cells of its tier. */
  readonly current: { readonly lengthCells: number; readonly nx: number };
  readonly runFlowThroughs?: number;
  readonly runner: GridCheckRunner;
  /** Bring back the run that was live before the check, whatever the outcome. */
  readonly restore: () => Promise<void>;
  readonly signal: AbortSignal;
};

/** The run length from the `gcT` hash parameter; anything but a positive number keeps the default. */
export function runFlowThroughsFromHash(hash: string): number {
  const query = hash.split('?')[1];
  if (query === undefined) return GRID_CHECK_FLOW_THROUGHS;
  const value = Number(new URLSearchParams(query).get('gcT'));
  return Number.isFinite(value) && value > 0 ? value : GRID_CHECK_FLOW_THROUGHS;
}

/** Keep the body's share of the domain the same on every grid, so only the cell size changes. */
export function gridCheckLengthCells(current: GridCheckOptions['current'], tier: GridCheckTier) {
  if (!(current.lengthCells > 0) || !(current.nx > 0)) {
    throw new RangeError('The run being checked needs a positive body length and grid length.');
  }
  return Math.max(1, Math.round((current.lengthCells / current.nx) * TIERS[tier].nx));
}

/** Total steps of a run, and how many at its end are averaged (the newest half). */
export function gridCheckSteps(
  tier: GridCheckTier,
  runFlowThroughs: number,
): { totalSteps: number; averageSteps: number } {
  if (!Number.isFinite(runFlowThroughs) || runFlowThroughs <= 0) {
    throw new RangeError('The run length must be a positive number of flow-throughs.');
  }
  const flowThrough = flowThroughSteps(TIERS[tier].nx);
  return {
    totalSteps: Math.ceil(runFlowThroughs * flowThrough),
    averageSteps: Math.ceil((runFlowThroughs / 2) * flowThrough),
  };
}

/** Seconds the L run is predicted to take, scaled from the 2T prediction of a measured S or M probe. */
export function predictLRunSeconds(
  measured: { tier: 'S' | 'M'; msPerStep: number },
  runFlowThroughs: number,
): number {
  return (predictTimeTo2TS(measured, 'L') * runFlowThroughs) / 2;
}

export type GridCheckAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'disabled'; readonly reason: string };

export function gridCheckAvailability(
  measured: { tier: 'S' | 'M'; msPerStep: number },
  tierPolicy: TierPolicy,
  runFlowThroughs: number = GRID_CHECK_FLOW_THROUGHS,
): GridCheckAvailability {
  if (tierPolicy === 's-only') {
    return {
      kind: 'disabled',
      reason: 'Check grid needs tiers M and L, and this GPU runs tier S only.',
    };
  }
  const seconds = predictLRunSeconds(measured, runFlowThroughs);
  if (seconds > GRID_CHECK_L_LIMIT_S) {
    return {
      kind: 'disabled',
      reason: `Check grid is off: the tier L run is predicted at about ${Math.round(seconds)} s, above ${GRID_CHECK_L_LIMIT_S} s.`,
    };
  }
  return { kind: 'ready' };
}

/** Mean Cd over the newest `averageSteps` of a history, or null when it holds nothing finite. */
export function meanOfLast(
  history: readonly ForceHistoryPoint[],
  averageSteps: number,
): number | null {
  const last = history[history.length - 1];
  if (last === undefined) return null;
  const window = history.filter(([step]) => step > last[0] - averageSteps);
  const mean = window.reduce((sum, [, cd]) => sum + cd, 0) / window.length;
  return Number.isFinite(mean) ? mean : null;
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Run one tier to its step count; null means the check was cancelled meanwhile. */
async function measureTier(
  options: GridCheckOptions,
  tier: GridCheckTier,
  lengthCells: number,
  runFlowThroughs: number,
): Promise<number | null | 'cancelled'> {
  const { totalSteps, averageSteps } = gridCheckSteps(tier, runFlowThroughs);
  const { signal } = options;
  let latest: readonly ForceHistoryPoint[] = [];
  let reachedEnd: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    reachedEnd = resolve;
  });
  let handle: GridCheckRunHandle | null;
  try {
    handle = await options.runner({
      tier,
      lengthCells,
      signal,
      onHistory(history) {
        latest = history;
        if ((history[history.length - 1]?.[0] ?? 0) >= totalSteps) reachedEnd();
      },
    });
  } catch (error) {
    if (signal.aborted) return 'cancelled';
    throw error;
  }
  if (handle === null) return 'cancelled';
  try {
    if (handle.nx !== TIERS[tier].nx) {
      throw new Error(`The grid check asked for tier ${tier} and the run used another grid.`);
    }
    await Promise.race([finished, aborted(signal)]);
    return signal.aborted ? 'cancelled' : meanOfLast(latest, averageSteps);
  } finally {
    handle.dispose();
  }
}

/**
 * Run S, M and L one after another, each disposed before the next starts so
 * the single-solver rule holds, then read the band off the three means. The
 * previous run is restored on every exit; a cancel returns before any band.
 */
export async function runGridCheck(options: GridCheckOptions): Promise<GridCheckResult> {
  const runFlowThroughs = options.runFlowThroughs ?? GRID_CHECK_FLOW_THROUGHS;
  const rows: GridCheckRow[] = [];
  try {
    for (const tier of GRID_CHECK_TIERS) {
      if (options.signal.aborted) return { kind: 'cancelled' };
      const lengthCells = gridCheckLengthCells(options.current, tier);
      const cd = await measureTier(options, tier, lengthCells, runFlowThroughs);
      if (cd === 'cancelled') return { kind: 'cancelled' };
      rows.push({ tier, lengthCells, cd });
    }
  } finally {
    await options.restore();
  }
  const measured = rows.flatMap((row) =>
    row.cd === null ? [] : [{ h: 1 / row.lengthCells, cd: row.cd }],
  );
  return { kind: 'done', rows, band: gridBand(measured) };
}

export function gridBandText(band: GridBand): string {
  if (band.kind === 'no-band') return NO_BAND_TEXTS[band.reason];
  return `grid band ±${band.gciPct.toFixed(1)}% (extrapolated Cd ${band.extrapolatedCd.toFixed(3)})`;
}

export type BandedCompareRow = CompareRow & { readonly gridBand: GridBand };

/**
 * In compare mode only run 2 is rerun. The band belongs to its row; the frozen
 * first row and the verdict are passed through as they were, because the verdict
 * speaks of sampling, not of grid size.
 */
export function bandOnSecondRow(
  state: ComparePanelState,
  band: GridBand,
): { first: CompareRow; second: BandedCompareRow; outcome: CompareOutcome } {
  return {
    first: state.first,
    second: { ...state.second, gridBand: band },
    outcome: state.outcome,
  };
}
