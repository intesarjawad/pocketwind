import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/copy-lint.sh', import.meta.url).pathname;

let root = '';

function put(path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function run(): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SCRIPT], {
    env: { ...process.env, COPY_LINT_ROOT: root },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('copy lint', () => {
  it('passes plain copy in every scanned location', () => {
    put('README.md', '# Pocketwind\n\nA wind tunnel in the browser.\n');
    put('docs/guide.md', 'Drag is reported as Cd.\n');
    put('src/app/label.ts', "export const label = 'Drag coefficient';\n");
    put('.github/ISSUE_TEMPLATE/bug.md', 'Describe the problem.\n');
    put('docs/media/caption.txt', 'The flow around a cube.\n');
    expect(run()).toMatchObject({ status: 0, stderr: '' });
  });

  it('fails on an email address in the README', () => {
    put('README.md', 'Write to someone@example.com for help.\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('README.md:1:');
  });

  it.each([
    ['docs/a.md'],
    ['src/app/nested/b.ts'],
    ['.github/ISSUE_TEMPLATE/c.yml'],
    ['docs/media/d.txt'],
  ])('fails on an email address in %s', (path) => {
    put(path, 'ok\nWrite to someone@example.com.\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:2:`);
  });

  it('reports every email address in one fixture and ignores unscanned files', () => {
    put('docs/all.md', ['a@b.io', 'someone@example.com'].join('\n'));
    put('tests/ignored.md', 'a@b.io\n');
    put('src/app/ignored.js', 'a@b.io\n');
    const { status, stderr } = run();
    expect(status).toBe(1);
    for (const line of [1, 2]) {
      expect(stderr).toContain(`docs/all.md:${line}:`);
    }
    expect(stderr).not.toContain('tests/ignored.md');
    expect(stderr).not.toContain('ignored.js');
  });
});
