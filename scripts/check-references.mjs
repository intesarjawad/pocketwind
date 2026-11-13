import { readFileSync } from 'node:fs';

// Fails unless every reference value in the docs/validation.md case table cites a DOI or a
// page or table number, and every row marked "none" says in its Source why it has none.

const DOI = /\b10\.\d{4,9}\/\S+/;
const PAGE_OR_TABLE = /\b(?:pp?\.\s?|pages?\s|tables?\s)\d/i;
const NO_REFERENCE_REASON = /^none;\s*\S/;

/** @param {string} line */
function cells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** @param {string} markdown */
function caseTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => {
    const header = cells(line);
    return header.includes('Reference') && header.includes('Source');
  });
  if (start === -1) throw new Error('no table has Reference and Source columns');
  const header = cells(lines[start] ?? '');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(cells(line));
  }
  if (rows.length === 0) throw new Error('the Reference and Source table has no rows');
  return { header, rows };
}

/** @param {string[]} header @param {string[]} row */
function rowProblem(header, row) {
  const name = (row[0] ?? '').replaceAll('`', '');
  const empty = header.find((_column, index) => !row[index]);
  if (empty !== undefined) return `${name} has an empty ${empty} cell`;
  const reference = row[header.indexOf('Reference')] ?? '';
  const source = row[header.indexOf('Source')] ?? '';
  if (reference === 'none') {
    return NO_REFERENCE_REASON.test(source)
      ? null
      : `${name} has no reference; its Source must read "none; <reason>"`;
  }
  if (DOI.test(source) || PAGE_OR_TABLE.test(source)) return null;
  return `${name} cites "${reference}" but its Source lacks a DOI or a page or table number`;
}

const path = process.argv[2] ?? 'docs/validation.md';
try {
  const { header, rows } = caseTable(readFileSync(path, 'utf8'));
  const problems = rows.map((row) => rowProblem(header, row)).filter((problem) => problem !== null);
  if (problems.length > 0) throw new Error(problems.join('\n  '));
  process.stdout.write(`References: ${rows.length} rows checked in ${path}.\n`);
} catch (error) {
  process.stderr.write(
    `References (${path}): ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
