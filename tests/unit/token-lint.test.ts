import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/token-lint.mjs');
let stylesDirectory: string;

beforeEach(() => {
  stylesDirectory = mkdtempSync(join(tmpdir(), 'pocketwind-token-lint-'));
});

afterEach(() => {
  rmSync(stylesDirectory, { recursive: true, force: true });
});

function lintStyles() {
  return spawnSync(process.execPath, [script, stylesDirectory], { encoding: 'utf8' });
}

describe('token lint', () => {
  it('accepts a scaffold with no CSS', () => {
    expect(lintStyles().status).toBe(0);
  });

  it('rejects raw colors and font sizes with file and line diagnostics', () => {
    const path = join(stylesDirectory, 'readout.css');
    writeFileSync(path, readFileSync('tests/fixtures/token-lint/bad.css'));
    const result = lintStyles();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:2: color`);
    expect(result.stderr).toContain(`${path}:3: font-size`);
  });

  it('accepts tokens, allowed keywords and shorthand keyword combinations', () => {
    writeFileSync(
      join(stylesDirectory, 'readout.css'),
      readFileSync('tests/fixtures/token-lint/good.css'),
    );
    expect(lintStyles().status).toBe(0);
  });

  it('allows raw definitions in tokens.css', () => {
    writeFileSync(
      join(stylesDirectory, 'tokens.css'),
      ':root { --text: #fff; --text-readout: 18px; color: #fff; }',
    );
    expect(lintStyles().status).toBe(0);
  });

  it('checks multiline and final declarations inside nested rules', () => {
    const path = join(stylesDirectory, 'readout.css');
    writeFileSync(path, '@media screen {\n.readout {\nfont-size:\n18px\n}\n}');
    const result = lintStyles();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:3: font-size`);
  });

  it('ignores comments and quoted declaration-like content', () => {
    writeFileSync(
      join(stylesDirectory, 'readout.css'),
      '/* color: #fff; */\n.readout::before { content: "padding: 20px;"; color: var(--text); }',
    );
    expect(lintStyles().status).toBe(0);
  });

  it('fails with an actionable message when the directory does not exist', () => {
    const path = join(stylesDirectory, 'missing');
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
  });
});
