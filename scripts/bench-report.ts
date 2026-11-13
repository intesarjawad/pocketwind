import type { BenchReport, TierResult, TimingMethod } from '../src/app/bench-page';
import { TIERS } from '../src/lbm/layout';
import { ENGINE_NAMES, type EngineName } from './cold-start-report';

type Tier = keyof typeof TIERS;

/** Performance budget: a tier L step in f32 reaches at least this share of the copy roofline. */
export const TIER_L_ROOFLINE_BUDGET_PCT = 60;
const TIMING_METHODS: readonly TimingMethod[] = ['timestamp-query', 'submitted-work-done'];

export type BenchRow = {
  readonly engine: EngineName;
  readonly browserVersion: string;
  readonly commit: string;
  readonly date: string;
  readonly report: BenchReport;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isTier(name: string): name is Tier {
  return Object.hasOwn(TIERS, name);
}

function invalid(field: string): Error {
  return new Error(`The benchmark report has no valid ${field}. Reload #/bench and run again.`);
}

function tierEntries<Value>(
  value: unknown,
  field: string,
  read: (entry: unknown, path: string) => Value,
): Partial<Record<Tier, Value>> {
  if (!isRecord(value)) throw invalid(field);
  const entries: Partial<Record<Tier, Value>> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isTier(name)) throw new Error(`Unknown tier ${name} in ${field}.`);
    entries[name] = read(entry, `${field}.${name}`);
  }
  return entries;
}

function readTierResult(value: unknown, path: string): TierResult {
  if (
    !isRecord(value) ||
    !isPositive(value.mlups) ||
    !isPositive(value.msPerStep) ||
    !isPositive(value.rooflinePct)
  ) {
    throw invalid(path);
  }
  return { mlups: value.mlups, msPerStep: value.msPerStep, rooflinePct: value.rooflinePct };
}

function readSkipReason(value: unknown, path: string): string {
  if (typeof value !== 'string') throw invalid(path);
  return value;
}

/** Check what the page published on `window.__pwt` before it is written to the results file. */
export function readBenchReport(value: unknown): BenchReport {
  if (!isRecord(value)) throw new Error('The page published no benchmark report.');
  const { copyGBps, adapter, features, userAgent, timing, steps } = value;
  if (!isPositive(copyGBps)) throw invalid('copyGBps');
  const perTier = tierEntries(value.perTier, 'perTier', readTierResult);
  const skipped =
    value.skipped === undefined ? undefined : tierEntries(value.skipped, 'skipped', readSkipReason);
  if (
    !isRecord(adapter) ||
    typeof adapter.vendor !== 'string' ||
    typeof adapter.architecture !== 'string' ||
    typeof adapter.device !== 'string' ||
    typeof adapter.description !== 'string'
  ) {
    throw invalid('adapter');
  }
  if (!Array.isArray(features) || !features.every((name) => typeof name === 'string')) {
    throw invalid('features');
  }
  if (typeof userAgent !== 'string') throw invalid('userAgent');
  const method = TIMING_METHODS.find((name) => name === timing);
  if (method === undefined) throw invalid('timing');
  if (!isPositive(steps) || !Number.isSafeInteger(steps)) throw invalid('steps');
  return {
    copyGBps,
    perTier,
    ...(skipped === undefined ? {} : { skipped }),
    adapter: {
      vendor: adapter.vendor,
      architecture: adapter.architecture,
      device: adapter.device,
      description: adapter.description,
    },
    features,
    userAgent,
    timing: method,
    steps,
  };
}

/** Read an existing results file, refusing rows this script would not have written. */
export function readBenchRows(value: unknown, source: string): BenchRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} is not a list of rows. Move it aside and run again.`);
  }
  return value.map((row, index) => {
    const engine = isRecord(row) ? ENGINE_NAMES.find((name) => name === row.engine) : undefined;
    if (
      !isRecord(row) ||
      engine === undefined ||
      typeof row.browserVersion !== 'string' ||
      typeof row.commit !== 'string' ||
      typeof row.date !== 'string'
    ) {
      throw new Error(`Row ${index} of ${source} is malformed. Move the file aside and run again.`);
    }
    return {
      engine,
      browserVersion: row.browserVersion,
      commit: row.commit,
      date: row.date,
      report: readBenchReport(row.report),
    };
  });
}

export function budgetFailures(report: BenchReport): string[] {
  const failures: string[] = [];
  for (const [tier, result] of Object.entries(report.perTier)) {
    if (result.rooflinePct > 100) {
      failures.push(
        `Tier ${tier} reached ${result.rooflinePct.toFixed(1)}% of the copy roofline, which no memory-bound step can; check the timing.`,
      );
    }
  }
  const large = report.perTier.L;
  if (large === undefined) {
    const reason = report.skipped?.L;
    failures.push(
      reason === undefined
        ? 'Tier L was not measured, so its budget could not be checked.'
        : `Tier L was not measured: ${reason}`,
    );
  } else if (large.rooflinePct < TIER_L_ROOFLINE_BUDGET_PCT) {
    failures.push(
      `Tier L reached ${large.rooflinePct.toFixed(1)}% of the copy roofline, under the ${TIER_L_ROOFLINE_BUDGET_PCT}% budget.`,
    );
  }
  return failures;
}

function adapterName(row: BenchRow): string {
  const { vendor, architecture, device, description } = row.report.adapter;
  return [vendor, architecture, device, description].join(' ');
}

/** A new measurement replaces the row for the same engine and adapter; other rows stay. */
export function mergeRows(
  existing: readonly BenchRow[],
  measured: readonly BenchRow[],
): BenchRow[] {
  const key = (row: BenchRow): string => `${row.engine} ${adapterName(row)}`;
  const replaced = new Set(measured.map(key));
  const kept = existing.filter((row) => !replaced.has(key(row)));
  return [...kept, ...measured].sort(
    (a, b) =>
      ENGINE_NAMES.indexOf(a.engine) - ENGINE_NAMES.indexOf(b.engine) ||
      adapterName(a).localeCompare(adapterName(b)),
  );
}
