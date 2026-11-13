import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/check-build-ids.mjs');
const COMMIT = 'abc1234';

let root = '';
let dist = '';
let solverRoot = '';
let numericsHash = '';

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function check(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, dist], {
    env: { ...process.env, VITE_COMMIT: COMMIT, NUMERICS_ROOT: solverRoot, ...env },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-build-ids-'));
  dist = join(root, 'dist');
  solverRoot = join(root, 'solver');
  put(join(solverRoot, 'src/lbm/shaders/stream_collide.wgsl'), 'fn main() {}');
  const hash = spawnSync('sh', ['scripts/numerics-hash.sh'], {
    env: { ...process.env, NUMERICS_ROOT: solverRoot },
    encoding: 'utf8',
  });
  numericsHash = hash.stdout.trim();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('build id check', () => {
  it('passes when the bundle carries both ids', () => {
    put(join(dist, 'assets/index-a1.js'), `const c="${COMMIT}";`);
    put(join(dist, 'assets/worker-b2.js'), `const h="${numericsHash}";`);
    const result = check();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(COMMIT);
    expect(result.stdout).toContain(numericsHash);
  });

  it('rejects a development build', () => {
    put(join(dist, 'assets/index-a1.js'), 'const c="dev",h="dev";');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`source commit ${COMMIT}`);
    expect(result.stderr).toContain(`numerics hash ${numericsHash}`);
  });

  it('names the one id that is missing', () => {
    put(join(dist, 'assets/index-a1.js'), `const c="${COMMIT}",h="dev";`);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('numerics hash');
    expect(result.stderr).not.toContain('source commit');
  });

  it('accepts an id only as a whole quoted string', () => {
    put(join(dist, 'assets/index-a1.js'), `const c="${COMMIT}9",h="${numericsHash}";`);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source commit');
  });

  it('ignores files that are not JavaScript bundles', () => {
    put(join(dist, 'assets/index-a1.js'), 'const c="dev";');
    put(join(dist, 'assets/ids.txt'), `"${COMMIT}" "${numericsHash}"`);
    put(join(dist, 'index.js'), `"${COMMIT}" "${numericsHash}"`);
    expect(check().status).toBe(1);
  });

  it('fails when the source commit cannot be read', () => {
    put(join(dist, 'assets/index-a1.js'), '"unknown"');
    const result = check({ VITE_COMMIT: '', GIT_DIR: join(root, 'no-repository') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source commit');
  });

  it('fails with the hash script error when no solver sources exist', () => {
    put(join(dist, 'assets/index-a1.js'), `"${COMMIT}"`);
    mkdirSync(join(root, 'empty'));
    const result = check({ NUMERICS_ROOT: join(root, 'empty') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no solver sources');
  });

  it('fails with an actionable message when the bundle is missing', () => {
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dist, 'assets'));
    expect(result.stderr).toContain('npm run build');
  });
});
