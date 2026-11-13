import type { DragSummary } from '../forces/drag-stats';

/**
 * Redaction's grades, from the clean cut to the most eroded print that still reads as
 * worn type at figure size; from 20 up the curves break into square pixels.
 */
export const GRADES = ['Redaction', 'Redaction 10'] as const;
export type Grade = (typeof GRADES)[number];

/**
 * The drag figure is as eroded as it is uncertain. Sampling and grid bands add in
 * quadrature; without a grid band the figure never reaches the clean cut, because
 * the grid error is unknown rather than zero.
 */
export function figureGrade(summary: DragSummary, gridBandPct?: number | null): Grade {
  if (summary.cd === null || summary.status.kind === 'settling') return 'Redaction 10';
  const sampling = summary.semPct ?? summary.status.relStdPct;
  const gridKnown = gridBandPct !== undefined && gridBandPct !== null && gridBandPct >= 0;
  const band = Math.hypot(sampling, gridKnown ? gridBandPct : 0);
  if (!Number.isFinite(band) || band >= 0.25 || !gridKnown) return 'Redaction 10';
  return 'Redaction';
}

/** What the figure shows while the statistics withhold a reported value. */
export type Withheld = 'nothing' | 'instantaneous' | 'last reported';

/**
 * The words under the figure: how settled it is, its sampling band and the grid check.
 * A figure the statistics withhold is either the latest instantaneous sample or the
 * last reported value, and says which.
 */
export function figureVerdict(
  summary: DragSummary,
  gridBandPct?: number | null,
  withheld: Withheld = 'nothing',
): string {
  if (summary.cd === null) {
    if (withheld === 'last reported') {
      return `${summary.status.kind}, last reported value, too few independent samples for a band`;
    }
    return withheld === 'instantaneous'
      ? 'instantaneous drag, waiting for enough independent samples to report a band'
      : 'waiting for enough independent samples to report drag';
  }
  const grid =
    gridBandPct === undefined || gridBandPct === null
      ? 'grid check not run'
      : `grid band ±${gridBandPct.toFixed(1)}%`;
  if (summary.status.kind === 'settling') return `settling, no band yet, ${grid}`;
  return `${summary.status.kind}, ${samplingText(summary)}, ${grid}`;
}

/** The sampling band when the statistics have one, else the raw fluctuation, in one wording. */
export function samplingText(summary: DragSummary): string {
  if (summary.status.kind === 'settling') return 'no band yet';
  // Sampling noise is quoted only as far as it matters beside the model's own error.
  const sem = summary.semPct;
  const percent = (value: number) => (value < 1 ? 'under 1%' : `±${Math.round(value)}%`);
  return sem === undefined || sem === null
    ? `fluctuation ${percent(summary.status.relStdPct)}`
    : `sampling band ${percent(sem)}`;
}
