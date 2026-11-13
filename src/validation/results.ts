import type { Operator, Tier } from '../app/settings';
import { type GridConvergence, gridConvergence } from '../forces/convergence';
import { defaultOperator } from '../lbm/params';
import {
  type CaseGroup,
  type CaseSpec,
  type CaseVariant,
  type ValidationFactors,
  type ValidationGroup,
  validationGroupOf,
} from './cases';
import type { AdapterInfo, ValidationRow } from './runner';
import type { VerificationRow } from './verification';

export const RESULTS_SCHEMA_VERSION = 1;

export type Machine = {
  adapter: Omit<AdapterInfo, 'features'>;
  features: readonly string[];
  limits: Readonly<Record<string, number>>;
  userAgent: string;
};

export type ConvergenceRow = GridConvergence & {
  case: string;
  group: 'convergence';
  operator: Operator;
  tiers: readonly Tier[];
  commit: string;
  date: string;
};

export type GridCheckRow = {
  case: string;
  kind: 'band' | 'no-band';
  re?: number;
  rows?: readonly { tier: string; lengthCells: number; cd: number | null }[];
  gciPct?: number;
  extrapolatedCd?: number;
  reason?: string;
  commit: string;
  date: string;
};

/** A case the run could not or did not run; `group` says which `--only` name owns it. */
export type SkippedCase = {
  case: string;
  group: ValidationGroup;
  tier?: Tier;
  operator?: Operator;
  variant?: CaseVariant;
  reason: string;
};

export type ValidationResults = {
  schemaVersion: typeof RESULTS_SCHEMA_VERSION;
  commit: string;
  date: string;
  machine: Machine;
  factors: ValidationFactors;
  verification: VerificationRow[];
  laminar: ValidationRow[];
  validation: ValidationRow[];
  confinement: ValidationRow[];
  convergence: ConvergenceRow[];
  sensitivity: ValidationRow[];
  gridCheck: GridCheckRow[];
  crossDevice: ValidationRow[];
  skipped: SkippedCase[];
};

export type RowSection = 'laminar' | 'validation' | 'confinement' | 'sensitivity';
export const ROW_SECTIONS: readonly RowSection[] = [
  'laminar',
  'validation',
  'confinement',
  'sensitivity',
];

/** The machine of a run that used no browser. */
export const NO_MACHINE: Machine = {
  adapter: {
    vendor: 'unknown',
    architecture: 'unknown',
    device: 'none',
    description: 'no browser run',
  },
  features: [],
  limits: {},
  userAgent: 'none',
};

export type Stamp = { commit: string; date: string };

export type RunOutput = {
  groups: ReadonlySet<ValidationGroup>;
  tiers: readonly Tier[];
  factors: ValidationFactors;
  /** Null when the run drove no browser, which keeps the previous machine. */
  machine: Machine | null;
  stamp: Stamp;
  verification: VerificationRow[];
  rows: ValidationRow[];
  /** Ids of every case the run list contained, whether or not it produced a row. */
  plannedIds: ReadonlySet<string>;
  gridCheck: GridCheckRow[];
  skipped: SkippedCase[];
  crossDevice: ValidationRow[];
};

export function sectionOf(group: CaseGroup): RowSection {
  if (group === 'shape-class' || group === 'smoke') return 'validation';
  return group;
}

export function rowsOf(results: ValidationResults): ValidationRow[] {
  return ROW_SECTIONS.flatMap((section) => results[section]);
}

/** The skip entry for a case that failed, named the way the schema check looks cases up. */
export function skipForCase(spec: CaseSpec, reason: string): SkippedCase {
  return {
    case: spec.group === 'sensitivity' ? `sensitivity-${spec.sensitivity}` : spec.case,
    group: validationGroupOf(spec.group),
    tier: spec.tier,
    operator: spec.operator,
    ...(spec.variant === null ? {} : { variant: spec.variant }),
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ARRAY_SECTIONS = [
  'verification',
  'laminar',
  'validation',
  'confinement',
  'convergence',
  'sensitivity',
  'gridCheck',
  'crossDevice',
  'skipped',
] as const;

/** Read a results file; one in another layout is treated as absent so a run starts clean. */
export function parseResults(text: string): ValidationResults | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.schemaVersion !== RESULTS_SCHEMA_VERSION) return null;
  if (typeof data.commit !== 'string' || !isRecord(data.machine) || !isRecord(data.factors)) {
    return null;
  }
  if (!ARRAY_SECTIONS.every((name) => Array.isArray(data[name]))) return null;
  return data as ValidationResults;
}

/** Check what `window.__pwt.gridCheck` held and stamp it as one row for its preset. */
export function readGridCheck(presetId: string, value: unknown, stamp: Stamp): GridCheckRow {
  if (isRecord(value) && typeof value.error === 'string') throw new Error(value.error);
  if (!isRecord(value) || (value.kind !== 'band' && value.kind !== 'no-band')) {
    throw new RangeError('The grid check has no band or no-band result.');
  }
  const row: GridCheckRow = { case: presetId, kind: value.kind, ...stamp };
  for (const name of ['gciPct', 'extrapolatedCd', 're'] as const) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== 'number' || !Number.isFinite(field)) {
      throw new RangeError(`The grid check ${name} must be a finite number.`);
    }
    row[name] = field;
  }
  if (value.rows !== undefined) {
    if (
      !Array.isArray(value.rows) ||
      !value.rows.every(
        (entry: unknown) =>
          isRecord(entry) &&
          typeof entry.tier === 'string' &&
          typeof entry.lengthCells === 'number' &&
          Number.isFinite(entry.lengthCells) &&
          entry.lengthCells > 0 &&
          (entry.cd === null || (typeof entry.cd === 'number' && Number.isFinite(entry.cd))),
      )
    ) {
      throw new RangeError(
        'The grid check rows must contain finite lengths and drag coefficients.',
      );
    }
    row.rows = value.rows;
  }
  if (typeof value.reason === 'string') row.reason = value.reason;
  if (row.kind === 'band' && (row.gciPct === undefined || row.extrapolatedCd === undefined)) {
    throw new RangeError('A band result needs gciPct and extrapolatedCd.');
  }
  if (row.kind === 'no-band' && row.reason === undefined) {
    throw new RangeError('A no-band result needs a reason.');
  }
  return row;
}

function convergenceFor(
  rows: readonly ValidationRow[],
  tiers: readonly Tier[],
  match: (row: ValidationRow) => boolean,
): GridConvergence | null {
  const samples = tiers.flatMap((tier) => {
    const row = rows.find((candidate) => candidate.tier === tier && match(candidate));
    return row ? [{ h: 1 / row.grid.nx, value: row.cd }] : [];
  });
  return samples.length === tiers.length ? gridConvergence(samples) : null;
}

const AHMED_CONVERGENCE_TIERS: readonly Tier[] = ['M', 'L', 'XL'];
const LAMINAR_CONVERGENCE_TIERS: readonly Tier[] = ['S', 'M', 'L'];

type Series = {
  case: string;
  operator: Operator;
  tiers: readonly Tier[];
  match: (row: ValidationRow) => boolean;
};

/**
 * Grid convergence of the default Ahmed rows over M, L and XL, and of the
 * laminar sphere over S, M and L for each operator. A series missing a tier is
 * recorded as skipped rather than estimated from two grids.
 */
export function convergenceRows(
  rows: readonly ValidationRow[],
  operators: readonly Operator[],
  stamp: Stamp,
): { rows: ConvergenceRow[]; skipped: SkippedCase[] } {
  const series: Series[] = [
    {
      case: 'ahmed-25',
      operator: defaultOperator(true),
      tiers: AHMED_CONVERGENCE_TIERS,
      match: (row) => row.case === 'ahmed-25' && row.group === 'validation' && row.isDefault,
    },
    ...operators.map(
      (operator): Series => ({
        case: 'sphere-re-100',
        operator,
        tiers: LAMINAR_CONVERGENCE_TIERS,
        match: (row) =>
          row.case === 'sphere-re-100' && row.group === 'laminar' && row.operator === operator,
      }),
    ),
  ];
  const out: ConvergenceRow[] = [];
  const skipped: SkippedCase[] = [];
  for (const entry of series) {
    const result = convergenceFor(rows, entry.tiers, entry.match);
    if (result === null) {
      skipped.push({
        case: entry.case,
        group: 'convergence',
        operator: entry.operator,
        reason: `Needs rows at ${entry.tiers.join(', ')}.`,
      });
    } else {
      out.push({
        ...result,
        case: entry.case,
        group: 'convergence',
        operator: entry.operator,
        tiers: entry.tiers,
        ...stamp,
      });
    }
  }
  return { rows: out, skipped };
}

/** The commit every row shares, or "mixed"; cross-device rows keep their own and do not count. */
export function sharedCommit(
  results: Pick<ValidationResults, (typeof ARRAY_SECTIONS)[number]>,
  fallback: string,
): string {
  const commits = new Set(
    [
      ...results.verification,
      ...results.laminar,
      ...results.validation,
      ...results.confinement,
      ...results.convergence,
      ...results.sensitivity,
      ...results.gridCheck,
    ].map((row) => row.commit),
  );
  if (commits.size === 0) return fallback;
  return commits.size === 1 ? ([...commits][0] ?? fallback) : 'mixed';
}

/**
 * A partial run replaces the rows of the groups it ran, either because the run
 * list contained their case or because they sit at a tier the run covered.
 */
function replaced(row: ValidationRow, run: RunOutput): boolean {
  return (
    run.groups.has(validationGroupOf(row.group)) &&
    (run.plannedIds.has(row.id) || run.tiers.includes(row.tier))
  );
}

function keptSkips(previous: readonly SkippedCase[], run: RunOutput): SkippedCase[] {
  return previous.filter(
    (skip) =>
      !(run.groups.has(skip.group) && (skip.tier === undefined || run.tiers.includes(skip.tier))),
  );
}

const CONVERGENCE_INPUTS: readonly ValidationGroup[] = ['validation', 'laminar', 'convergence'];

export function mergeResults(
  previous: ValidationResults | null,
  run: RunOutput,
): ValidationResults {
  const section = (name: RowSection): ValidationRow[] => [
    ...(previous?.[name] ?? []).filter((row) => !replaced(row, run)),
    ...run.rows.filter((row) => sectionOf(row.group) === name),
  ];
  const laminar = section('laminar');
  const validation = section('validation');
  const refresh = CONVERGENCE_INPUTS.some((name) => run.groups.has(name));
  const derived = refresh
    ? convergenceRows([...laminar, ...validation], run.factors.operator, run.stamp)
    : null;
  const skipped = [
    ...keptSkips(previous?.skipped ?? [], run).filter(
      (skip) => !(refresh && skip.group === 'convergence'),
    ),
    ...run.skipped,
    ...(derived?.skipped ?? []),
  ];

  const merged: ValidationResults = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    commit: run.stamp.commit,
    date: run.stamp.date,
    machine: run.machine ?? previous?.machine ?? NO_MACHINE,
    factors: run.factors,
    verification: run.groups.has('verification')
      ? run.verification
      : (previous?.verification ?? []),
    laminar,
    validation,
    confinement: section('confinement'),
    convergence: derived?.rows ?? previous?.convergence ?? [],
    sensitivity: section('sensitivity'),
    gridCheck: run.groups.has('grid-check') ? run.gridCheck : (previous?.gridCheck ?? []),
    crossDevice: run.crossDevice,
    skipped,
  };
  return { ...merged, commit: sharedCommit(merged, run.stamp.commit) };
}

/**
 * Rows of cross-device files, each a results document of its own. They keep the
 * commit and date they were measured on.
 */
export function foldCrossDevice(documents: readonly ValidationResults[]): ValidationRow[] {
  return documents.flatMap((document) => rowsOf(document));
}
