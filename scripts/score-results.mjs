import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Reference drag coefficients by case, as listed in docs/validation.md. A case
 * with a null value is known but has nothing to compare against.
 * @type {ReadonlyMap<string, number | null>}
 */
const REFERENCES = new Map([
  ['ahmed-25', 0.285],
  ['ahmed-35', null],
  ['sphere-re-100', 1.09],
  ['cube', null],
  ['sphere', null],
]);
const SCORED_SECTIONS = ['laminar', 'validation'];

/**
 * @typedef {object} Entry
 * @property {string} case
 * @property {number} cd
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} row
 * @param {string} where
 * @returns {Entry | string}
 */
function readEntry(row, where) {
  if (!isRecord(row)) return `${where} is not an object.`;
  if (typeof row.case !== 'string' || row.case === '') return `${where} has no case name.`;
  if (typeof row.cd !== 'number' || !Number.isFinite(row.cd)) {
    return `${where} (${row.case}) has no finite cd.`;
  }
  return { case: row.case, cd: row.cd };
}

/**
 * Read the rows to score from either file format.
 * @param {unknown} parsed
 * @returns {{ entries: Entry[], errors: string[] }}
 */
function readRows(parsed) {
  if (!isRecord(parsed)) return { entries: [], errors: ['the file must be a JSON object.'] };
  /** @type {unknown[]} */
  let rows;
  if (Array.isArray(parsed.rows)) {
    if (typeof parsed.solver !== 'string' || parsed.solver === '') {
      return { entries: [], errors: ['solver must name the solver and its version.'] };
    }
    rows = parsed.rows;
  } else if (parsed.schemaVersion !== undefined) {
    rows = SCORED_SECTIONS.flatMap((name) => {
      const section = parsed[name];
      return Array.isArray(section) ? section.filter((row) => row?.isDefault === true) : [];
    });
  } else {
    return {
      entries: [],
      errors: ['the file is neither a results.json nor a foreign results file.'],
    };
  }
  const entries = [];
  const errors = [];
  for (const [index, row] of rows.entries()) {
    const entry = readEntry(row, `row ${index}`);
    if (typeof entry === 'string') errors.push(entry);
    else entries.push(entry);
  }
  return { entries, errors };
}

/**
 * Pair each row with the reference of its case; a row whose case has no
 * entry in the reference table is unmatched.
 * @param {readonly Entry[]} entries
 * @returns {{ matched: { case: string, cd: number, reference: number | null, errorPct: number | null }[], unmatched: Entry[] }}
 */
function matchRows(entries) {
  const matched = [];
  const unmatched = [];
  for (const entry of entries) {
    const reference = REFERENCES.get(entry.case);
    if (reference === undefined) {
      unmatched.push(entry);
      continue;
    }
    const errorPct = reference === null ? null : ((entry.cd - reference) / reference) * 100;
    matched.push({ case: entry.case, cd: entry.cd, reference, errorPct });
  }
  return { matched, unmatched };
}

/**
 * @param {number | null} value
 * @param {number} digits
 * @returns {string}
 */
function format(value, digits) {
  return value === null ? '-' : value.toFixed(digits);
}

/**
 * @param {string[]} argv
 */
function run(argv) {
  const path = argv[0];
  if (path === undefined || argv.length !== 1) {
    process.stderr.write('Usage: score-results <results.json | foreign-results.json>\n');
    process.exitCode = 2;
    return;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `score-results: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const { entries, errors } = readRows(parsed);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`score-results: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const { matched, unmatched } = matchRows(entries);
  for (const row of matched) {
    process.stdout.write(
      `${row.case}, ${format(row.cd, 4)}, ${row.reference ?? '-'}, ${format(row.errorPct, 2)}\n`,
    );
  }
  for (const row of unmatched) process.stderr.write(`score-results: unknown case ${row.case}.\n`);
  process.stdout.write(`unmatched: ${unmatched.length}\n`);
}

run(process.argv.slice(2));
