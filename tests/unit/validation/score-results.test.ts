import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AHMED_25_REFERENCE_CD, SPHERE_RE_100_REFERENCE_CD } from '../../../src/validation/cases';

const SCRIPT = 'scripts/score-results.mjs';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pocketwind-score-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function score(document: unknown) {
  const path = join(dir, 'results.json');
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
  return scoreFile(path);
}

function scoreFile(path: string) {
  const result = spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
  return {
    status: result.status,
    lines: result.stdout.split('\n').filter((line) => line !== ''),
    stderr: result.stderr,
  };
}

describe('score-results', () => {
  it('scores the foreign fixture and reports the unknown case', () => {
    const result = scoreFile('tests/fixtures/foreign-results.json');

    expect(result.status).toBe(0);
    expect(result.lines).toEqual([
      'ahmed-25, 0.3000, 0.285, 5.26',
      'sphere-re-100, 1.0000, 1.09, -8.26',
      'cube, 1.0500, -, -',
      'unmatched: 1',
    ]);
    expect(result.stderr).toContain('cylinder-re-100');
  });

  it('keeps the table in step with the reference values the cases use', () => {
    const result = score({
      solver: 'fixture 1',
      rows: [
        { case: 'ahmed-25', cd: 0.2850001 },
        { case: 'sphere-re-100', cd: 1.09 },
      ],
    });

    expect(AHMED_25_REFERENCE_CD).toBe(0.285);
    expect(SPHERE_RE_100_REFERENCE_CD).toBe(1.09);
    expect(result.lines).toEqual([
      'ahmed-25, 0.2850, 0.285, 0.00',
      'sphere-re-100, 1.0900, 1.09, 0.00',
      'unmatched: 0',
    ]);
  });

  it('reads only default rows of the laminar and validation sections', () => {
    const result = score({
      schemaVersion: 1,
      laminar: [
        { case: 'sphere-re-100', tier: 'M', operator: 'trt', cd: 1.2, isDefault: true },
        { case: 'sphere-re-100', tier: 'M', operator: 'reg', cd: 9, isDefault: false },
      ],
      validation: [
        { case: 'ahmed-25', tier: 'L', cd: 0.57, isDefault: true },
        { case: 'ahmed-25', tier: 'L', cd: 7, isDefault: false },
        { case: 'cube', tier: 'S', cd: 1.1, isDefault: true },
        { case: 'sphere', tier: 'S', cd: 0.5, isDefault: true },
      ],
      confinement: [{ case: 'cube-confinement', cd: 1, isDefault: true }],
      sensitivity: [{ case: 'ahmed-25', cd: 8, isDefault: false }],
    });

    expect(result.status).toBe(0);
    expect(result.lines).toEqual([
      'sphere-re-100, 1.2000, 1.09, 10.09',
      'ahmed-25, 0.5700, 0.285, 100.00',
      'cube, 1.1000, -, -',
      'sphere, 0.5000, -, -',
      'unmatched: 0',
    ]);
  });

  it('prints only the unmatched line for a file with no rows to score', () => {
    const result = score({ schemaVersion: 1, laminar: [], validation: [] });

    expect(result.status).toBe(0);
    expect(result.lines).toEqual(['unmatched: 0']);
  });

  it.each([
    ['a foreign file without a solver name', { rows: [{ case: 'cube', cd: 1 }] }],
    ['a row without a case', { solver: 's 1', rows: [{ cd: 1 }] }],
    ['a row with a non-numeric cd', { solver: 's 1', rows: [{ case: 'cube', cd: '1' }] }],
    ['a row that is not an object', { solver: 's 1', rows: [3] }],
    ['a file in neither format', { cases: [] }],
    ['a JSON array', []],
  ])('rejects %s', (_name, document) => {
    const result = score(document);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([]);
    expect(result.stderr).toContain('score-results:');
  });

  it('rejects a file that is not JSON', () => {
    const result = score('{');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read');
  });

  it('prints usage without a file', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });
});
