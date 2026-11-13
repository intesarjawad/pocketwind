import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/numerics-hash.sh', import.meta.url).pathname;
// SHA-256 of the three bytes "abc", from FIPS 180-4.
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

let root = '';

function put(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function hash(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', [SCRIPT], {
    env: { ...process.env, NUMERICS_ROOT: root },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'numerics-hash-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('numerics hash', () => {
  it('hashes a manifest of file digests and paths', () => {
    put('src/lbm/shaders/a.wgsl', 'abc');
    put('src/lbm/params.ts', 'abc');
    const expected = sha256(`${ABC}  src/lbm/params.ts\n${ABC}  src/lbm/shaders/a.wgsl\n`);
    expect(hash()).toEqual({ status: 0, stdout: `${expected}\n`, stderr: '' });
  });

  it('changes when a source changes or moves', () => {
    put('src/lbm/shaders/a.wgsl', 'abc');
    const before = hash().stdout;
    put('src/lbm/shaders/a.wgsl', 'abd');
    const edited = hash().stdout;
    expect(edited).not.toBe(before);
    rmSync(join(root, 'src/lbm/shaders/a.wgsl'));
    put('src/lbm/shaders/b.wgsl', 'abd');
    expect(hash().stdout).not.toBe(edited);
  });

  it('ignores files that do not decide the numbers', () => {
    put('src/lbm/shaders/a.wgsl', 'abc');
    const before = hash().stdout;

    put('src/app/panel.ts', 'unrelated');
    expect(hash().stdout).toBe(before);
  });

  it.each([
    'src/geometry/voxelize.ts',
    'src/forces/drag-stats.ts',
    'src/lbm/gpu-solver.ts',
    'src/gpu/scopes.ts',
    'src/app/run.ts',
    'src/app/store.ts',
    'src/app/run-plan.ts',
    'src/app/solver-slot.ts',
    'src/validation/cases.ts',
  ])('changes when result-affecting source %s changes', (path) => {
    put('src/lbm/shaders/a.wgsl', 'abc');
    const before = hash().stdout;
    put(path, 'changed');
    expect(hash().stdout).not.toBe(before);
  });

  it('fails when there are no solver sources', () => {
    const result = hash();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no solver sources');
  });
});
