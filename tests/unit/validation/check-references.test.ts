import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/check-references.mjs';
const HEADER = ['| Case | Geometry file | Reference | Source |', '| --- | --- | --- | --- |'];

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pocketwind-references-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function check(rows: string[], lines = HEADER) {
  const path = join(dir, 'validation.md');
  writeFileSync(path, ['# Validation', '', ...lines, ...rows, '', 'Text after.'].join('\n'));
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
}

function row(reference: string, source: string, name = 'case-a') {
  return `| \`${name}\` | \`a.stl\` | ${reference} | ${source} |`;
}

describe('check-references', () => {
  it.each([
    ['a page range', 'Schiller and Naumann (1935), Z. Ver. Dtsch. Ing. 77, pp. 318–320'],
    ['a single page', 'Ahmed, Ramm and Faltin (1984), SAE 840300, p. 12'],
    ['a page word', 'Hoerner (1965), Fluid-Dynamic Drag, page 3-12'],
    ['a table number', 'Meile et al. (2011), CFD Letters 3(1), Table 2'],
    ['a DOI', 'Roos and Willmarth (1971), AIAA J. 9(2), doi:10.2514/3.6164'],
  ])('accepts a reference value cited with %s', (_label, source) => {
    const result = check([row('Cd 0.285', source)]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 rows');
  });

  it.each([
    ['no locator', 'Ahmed, Ramm and Faltin (1984), SAE 840300'],
    [
      'a page that was not recorded',
      'Ahmed, Ramm and Faltin (1984), SAE 840300; page not recorded',
    ],
    ['a volume and colon', 'Commun. Comput. Phys. 3:427'],
    ['a bare report number', 'NACA Report 1234'],
  ])('rejects a reference value cited with %s', (_label, source) => {
    const result = check([row('Cd 0.285', source, 'ahmed-25')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ahmed-25');
    expect(result.stderr).toContain('DOI or a page or table number');
  });

  it('accepts a row without a reference when the source says why', () => {
    const result = check([row('none', 'none; raw drag only')]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([['none'], ['none;'], ['raw drag only']])(
    'rejects a row without a reference whose source is %s',
    (source) => {
      const result = check([row('none', source, 'cube')]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cube');
      expect(result.stderr).toContain('none; <reason>');
    },
  );

  it('rejects a reference that is missing rather than marked none', () => {
    const result = check([row('none recorded', 'none; the case is skipped', 'ahmed-35')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ahmed-35');
  });

  it('rejects an empty cell', () => {
    const result = check([row('', 'p. 4', 'blank')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('blank has an empty Reference');
  });

  it('reports every failing row, not only the first', () => {
    const result = check([
      row('Cd 1', 'no locator', 'first'),
      row('Cd 1', 'p. 2', 'good'),
      row('none', 'none', 'second'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('first');
    expect(result.stderr).toContain('second');
    expect(result.stderr).not.toContain('good');
  });

  it('fails when no table has Reference and Source columns', () => {
    const result = check([], ['| Case | Reference | Basis |', '| --- | --- | --- |']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Reference and Source');
  });

  it('fails when the table has no rows', () => {
    const result = check([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no rows');
  });

  it('fails with the path when the file cannot be read', () => {
    const missing = join(dir, 'missing.md');
    const result = spawnSync(process.execPath, [SCRIPT, missing], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
  });
});
