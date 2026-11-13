import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/checksums.sh', import.meta.url).pathname;
// SHA-256 of the three bytes "abc" and of the empty file, from FIPS 180-4.
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let dir = '';

function run(...args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SCRIPT, ...args], {
    env: { ...process.env, GEOMETRY_DIR: dir },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checksums-'));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('geometry checksums', () => {
  it('lists each STL by sorted name with its SHA-256', () => {
    writeFileSync(join(dir, 'b.stl'), '');
    writeFileSync(join(dir, 'a.stl'), 'abc');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(run().status).toBe(0);
    expect(readFileSync(join(dir, 'CHECKSUMS.txt'), 'utf8')).toBe(
      `${ABC}  a.stl\n${EMPTY}  b.stl\n`,
    );
  });

  it('writes the same file when run twice', () => {
    writeFileSync(join(dir, 'a.stl'), 'abc');
    run();
    const first = readFileSync(join(dir, 'CHECKSUMS.txt'), 'utf8');
    run();
    expect(readFileSync(join(dir, 'CHECKSUMS.txt'), 'utf8')).toBe(first);
  });

  it('verifies matching files', () => {
    writeFileSync(join(dir, 'a.stl'), 'abc');
    run();
    expect(run('--verify').status).toBe(0);
  });

  it('fails when a file changes, appears or disappears', () => {
    writeFileSync(join(dir, 'a.stl'), 'abc');
    run();
    writeFileSync(join(dir, 'a.stl'), 'abd');
    expect(run('--verify').status).toBe(1);
    writeFileSync(join(dir, 'a.stl'), 'abc');
    writeFileSync(join(dir, 'extra.stl'), '');
    expect(run('--verify').status).toBe(1);
    rmSync(join(dir, 'extra.stl'));
    rmSync(join(dir, 'a.stl'));
    expect(run('--verify').status).toBe(1);
  });

  it('fails verification without a checksum file and rejects unknown options', () => {
    expect(run('--verify')).toMatchObject({ status: 1 });
    expect(run('--bogus').status).toBe(2);
  });
});
