import type { ConvergenceRow, GridCheckRow, ValidationResults } from './results';
import { rowsOf } from './results';
import type { VerificationRow } from './verification';

export const VALIDATION_START = '<!-- validation:start -->';
export const VALIDATION_END = '<!-- validation:end -->';
// An empty cell in the generated tables.
const BLANK = 'n/a';

// The page shows no per-run history, and keeping each row's samples made the file megabytes.
export function validationJson(results: ValidationResults): string {
  return `${JSON.stringify(results, (key, value) => (key === 'forceHistory' ? undefined : value), 2)}\n`;
}

function cell(value: string | number | null): string {
  if (value === null) return BLANK;
  return String(value).replaceAll('|', '&#124;').replaceAll(/\r?\n/g, ' ');
}

function decimal(value: number | null, digits: number): string {
  return value === null ? BLANK : value.toFixed(digits);
}

function caseTable(results: ValidationResults): string[] {
  const rows = rowsOf(results).map((row) =>
    [
      row.case,
      row.group,
      row.tier,
      `${row.grid.nx}×${row.grid.ny}×${row.grid.nz}`,
      row.cells,
      row.operator,
      row.walls,
      row.storage,
      row.variant ?? row.sensitivity ?? BLANK,
      decimal(row.cd, 4),
      decimal(row.cdVoxel, 4),
      row.referenceCd === null ? BLANK : decimal(row.referenceCd, 4),
      decimal(row.errorPct, 1),
      decimal(row.relStdPct, 2),
      decimal(row.driftPct, 2),
      decimal(row.msPerStep, 2),
      row.isDefault ? 'yes' : 'no',
      row.pass ? 'pass' : `fail: ${row.reasons.join('; ') || 'unknown'}`,
    ].map(cell),
  );
  if (rows.length === 0) return ['No browser cases have been run yet.'];
  return [
    '| Case | Group | Tier | Grid | Cells | Operator | Walls | Storage | Variant | Cd | Cd voxel | Reference Cd | Error % | relStd % | Drift % | ms/step | Default | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((values) => `| ${values.join(' | ')} |`),
  ];
}

function verificationResult(row: VerificationRow): string {
  if (row.kind === 'poiseuille-bgk') return row.pass ? 'expected offset' : 'unexpected';
  return row.pass ? 'pass' : 'fail';
}

export function verificationError(row: VerificationRow): string {
  if (row.error !== null) return row.error.toExponential(3);
  if (row.errorPct === null) return BLANK;
  return `${row.errorPct.toFixed(row.kind === 'poiseuille-bgk' ? 2 : 3)}%`;
}

function verificationTable(rows: readonly VerificationRow[]): string[] {
  if (rows.length === 0) return ['No analytic verification was run.'];
  const orders = rows.flatMap((row) => row.observedOrder ?? []);
  const decay = rows.find((row) => row.decayRelativeError !== null)?.decayRelativeError ?? null;
  return [
    `Taylor-Green observed order: ${orders.map((order) => order.toFixed(3)).join(', ') || BLANK}; decay error ${decay === null ? BLANK : `${(100 * decay).toFixed(2)}%`}.`,
    '',
    '| Case | Steps | Error | Result |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${cell(row.label)} | ${row.steps} | ${verificationError(row)} | ${verificationResult(row)} |`,
    ),
  ];
}

function convergenceLine(row: ConvergenceRow): string {
  const label = `${row.case}, ${row.operator}, tiers ${row.tiers.join(', ')}`;
  if (row.kind !== 'monotone') return `- ${label}: not estimated, ${row.kind}.`;
  return `- ${label}: monotone, observed order ${row.order.toFixed(3)}, extrapolated Cd ${row.extrapolated.toFixed(4)}, fine-grid GCI ${row.gciFinePct.toFixed(2)}%.`;
}

function gridCheckTable(rows: readonly GridCheckRow[]): string[] {
  if (rows.length === 0) return ['No grid checks have been run yet.'];
  return [
    '| Preset | Effective Re (fixed) | Result | GCI % | Extrapolated Cd | Reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${[
          row.case,
          decimal(row.re ?? null, 1),
          row.kind,
          decimal(row.gciPct ?? null, 2),
          decimal(row.extrapolatedCd ?? null, 4),
          row.reason ?? BLANK,
        ]
          .map(cell)
          .join(' | ')} |`,
    ),
  ];
}

export function renderValidationMarkdown(results: ValidationResults): string {
  const { adapter } = results.machine;
  const rows = rowsOf(results);
  const passed = rows.filter((row) => row.pass).length;
  const verification =
    results.verification.length === 0
      ? 'absent'
      : results.verification.every((row) => row.pass)
        ? 'passed'
        : 'failed';
  // A file merged from several runs records "mixed"; each row keeps the commit it ran at.
  const commits = [
    ...new Set(
      results.commit === 'mixed'
        ? [...results.verification, ...rows].map((row) => row.commit)
        : [results.commit],
    ),
  ].sort();
  const lines = [
    `Measured ${results.date} at commit${commits.length === 1 ? '' : 's'} ${commits.join(' and ')}.`,
    `Adapter: ${adapter.vendor} ${adapter.architecture} (${adapter.description}); user agent: ${results.machine.userAgent}.`,
    `Factors: operators ${results.factors.operator.join(', ')}; walls ${results.factors.walls.join(', ')}; storage ${results.factors.storage.join(', ')}.`,
    '',
    `Cases: ${rows.length} run: ${passed} pass, ${rows.length - passed} fail; ${results.skipped.length} skipped. Analytic verification ${verification}.`,
    '',
    '### Analytic verification',
    '',
    ...verificationTable(results.verification),
    '',
    '### Grid convergence',
    '',
    ...(results.convergence.length === 0
      ? ['No default-operator rows at M, L and XL.']
      : results.convergence.map(convergenceLine)),
    '',
    '### Cases',
    '',
    ...caseTable(results),
    '',
    '### Grid check',
    '',
    ...gridCheckTable(results.gridCheck),
    '',
    '### Skipped',
    '',
    ...(results.skipped.length === 0
      ? ['No case was skipped.']
      : results.skipped.map(
          (skip) => `- ${skip.case}${skip.tier ? ` at ${skip.tier}` : ''}: ${skip.reason}`,
        )),
    '',
    '### Cross-device',
    '',
    results.crossDevice.length === 0
      ? 'No cross-device rows yet.'
      : `${results.crossDevice.length} rows from other adapters, each with the commit and date it was measured on.`,
  ];
  return lines.join('\n');
}

/** Replace the generated block and leave the surrounding notes untouched. */
export function replaceMarkedBlock(
  document: string,
  body: string,
  start: string = VALIDATION_START,
  end: string = VALIDATION_END,
): string {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error('Validation table markers are missing or out of order.');
  }
  return `${document.slice(0, startIndex + start.length)}\n${body.trim()}\n${document.slice(endIndex)}`;
}
