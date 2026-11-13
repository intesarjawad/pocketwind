import type { DragStatus } from '../forces/drag-stats';
import type { TierPolicy } from '../gpu/device';
import { tierOfGrid } from '../io/result-card';
import { isRunFileRefusal, parseRunFile, type RunFile, type RunFileSource } from '../io/run-file';
import { flowThroughSteps } from '../validation/cases';
import { MESSAGES, type MessageId } from './messages';
import { presetById } from './params';
import type { ReferenceAreaSource } from './readout';
import type { Settings } from './settings';

/** Run 2 may take this many flow-throughs to produce an uncertainty before the panel gives up. */
export const RUN_2_LIMIT_FLOW_THROUGHS = 6;
/** The difference must clear this many standard errors before a run is called lower. */
export const BAND_SIGMAS = 2;

export const NO_DIFFERENCE_TEXT = 'no difference this grid can resolve';
export const TOO_FEW_SAMPLES_TEXT =
  'too few independent samples to compare; run longer or use a higher tier';
/** Grid effects live on the validation route; the band here covers sampling only. */
export const GRID_EFFECTS_HREF = '#/validate';

export type CompareRow = {
  readonly label: string;
  readonly cd: number | null;
  readonly cdaM2: number | null;
  readonly status: DragStatus;
  readonly semPct: number | null;
};

export type CompareProgress = {
  /** Newest step of run 2. */
  readonly step: number;
  /** Step after which a missing uncertainty is reported instead of waited for. */
  readonly limitSteps: number;
};

export type CompareOutcome =
  | { readonly kind: 'running' }
  | { readonly kind: 'too-few' }
  | { readonly kind: 'unresolved'; readonly deltaPct: number; readonly bandPct: number }
  | {
      readonly kind: 'resolved';
      readonly deltaPct: number;
      readonly bandPct: number;
      readonly lowerDrag: 'first' | 'second';
    };

export type CompareBuild = {
  readonly numericsHash: string;
  readonly tierPolicy: TierPolicy;
};

export type ComparisonRefusal = {
  readonly messageId: MessageId;
  readonly text: string;
};

/** Percent change of the second run's CdA against the first. */
export function deltaForcePct(cda1: number, cda2: number): number {
  if (!Number.isFinite(cda1) || !Number.isFinite(cda2) || cda1 <= 0) {
    throw new RangeError('CdA must be finite, and the first run must be positive.');
  }
  return (100 * (cda2 - cda1)) / cda1;
}

/** Combine absolute standard errors, then express two SEMs relative to run 1. */
export function bandPct(
  semPct1: number,
  semPct2: number,
  cda1: number = 1,
  cda2: number = 1,
): number {
  if (!Number.isFinite(semPct1) || !Number.isFinite(semPct2) || semPct1 < 0 || semPct2 < 0) {
    throw new RangeError('Standard errors must be finite and not negative.');
  }
  deltaForcePct(cda1, cda2);
  return (BAND_SIGMAS * Math.hypot(cda1 * semPct1, cda2 * semPct2)) / cda1;
}

export function run2LimitSteps(nx: number): number {
  return RUN_2_LIMIT_FLOW_THROUGHS * flowThroughSteps(nx);
}

type Measured = { cdaM2: number; semPct: number };

function measured(row: CompareRow, positive: boolean): Measured | null {
  const { cdaM2, semPct } = row;
  if (cdaM2 === null || semPct === null || !Number.isFinite(semPct)) return null;
  if (positive && !(cdaM2 > 0)) return null;
  return { cdaM2, semPct };
}

/**
 * Judge run 2 against the frozen run 1. A winner is named only when the change
 * clears the band; a missing uncertainty waits for run 2 until its step limit.
 */
export function compareOutcome(
  first: CompareRow,
  second: CompareRow,
  progress: CompareProgress,
): CompareOutcome {
  const a = measured(first, true);
  const b = measured(second, false);
  if (a === null || b === null) {
    return progress.step >= progress.limitSteps ? { kind: 'too-few' } : { kind: 'running' };
  }
  const delta = deltaForcePct(a.cdaM2, b.cdaM2);
  const band = bandPct(a.semPct, b.semPct, a.cdaM2, b.cdaM2);
  if (Math.abs(delta) <= band) return { kind: 'unresolved', deltaPct: delta, bandPct: band };
  return {
    kind: 'resolved',
    deltaPct: delta,
    bandPct: band,
    lowerDrag: delta < 0 ? 'second' : 'first',
  };
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

export function outcomeText(outcome: CompareOutcome): string {
  if (outcome.kind === 'running') {
    return 'Run 2 is running. The comparison appears once both runs have an uncertainty estimate.';
  }
  if (outcome.kind === 'too-few') return `Comparison: ${TOO_FEW_SAMPLES_TEXT}.`;
  const figures = `ΔF% ${signed(outcome.deltaPct)} (band ±${outcome.bandPct.toFixed(1)}%)`;
  if (outcome.kind === 'unresolved') return `${figures}: ${NO_DIFFERENCE_TEXT}.`;
  const [lower, higher] = outcome.lowerDrag === 'second' ? [2, 1] : [1, 2];
  return `${figures}: run ${lower} has lower drag than run ${higher}.`;
}

export function rowOfRun(run: RunFile, label: string): CompareRow {
  return {
    label,
    cd: run.cd,
    cdaM2: run.cdaM2,
    status: run.status,
    semPct: run.semPct,
  };
}

/** The reference-area rule a run at these settings will use: a preset's stated area, else projected cells. */
export function referenceAreaRuleOf(settings: Settings): ReferenceAreaSource {
  return presetById(settings.presetId) ? 'preset' : 'frontal';
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

function refuse(messageId: MessageId, values: Record<string, string>): ComparisonRefusal {
  const message = MESSAGES[messageId];
  return {
    messageId,
    text: `${fill(message.what, values)} ${fill(message.next, values)}`,
  };
}

/**
 * Refuse a saved run before run 2 starts when its drag cannot be set beside the
 * current one. Solver numerics are checked first: when they differ, matching
 * settings would not make the numbers comparable. A different commit alone
 * (styles, copy, dependencies) is accepted.
 */
export function compareRefusal(
  saved: RunFile,
  current: Settings,
  build: CompareBuild,
  grid?: RunFile['grid'],
): ComparisonRefusal | null {
  if (saved.numericsHash !== build.numericsHash) {
    return refuse('compare-version-mismatch', {});
  }
  if (
    grid !== undefined &&
    (saved.grid.nx !== grid.nx || saved.grid.ny !== grid.ny || saved.grid.nz !== grid.nz)
  ) {
    return refuse('compare-grid-mismatch', {
      saved: `${saved.grid.nx}×${saved.grid.ny}×${saved.grid.nz}`,
      current: `${grid.nx}×${grid.ny}×${grid.nz}`,
    });
  }
  const savedTier = tierOfGrid(saved.grid) ?? 'custom';
  if (
    saved.speedMps !== current.speedMps ||
    saved.referenceAreaRule !== referenceAreaRuleOf(current)
  ) {
    return refuse('compare-setting-mismatch', {
      tier: savedTier,
      speed: String(saved.speedMps),
      rule: saved.referenceAreaRule === 'preset' ? 'preset' : 'frontal cells',
    });
  }
  return null;
}

/** Read a saved run and decide whether it may become the frozen run 1. */
export function prepareComparison(
  source: RunFileSource,
  current: Settings,
  build: CompareBuild,
): { run: RunFile } | ComparisonRefusal {
  const parsed = parseRunFile(source);
  if (isRunFileRefusal(parsed)) return refuse(parsed.messageId, {});
  return compareRefusal(parsed, current, build) ?? { run: parsed };
}
