import { describe, expect, it } from 'vitest';
import { adapterSlug, needsBrowser, parseArguments } from '../../scripts/validate';

const ALL_GROUPS = [
  'smoke',
  'verification',
  'laminar',
  'validation',
  'shape-classes',
  'confinement',
  'convergence',
  'sensitivity',
  'grid-check',
];

describe('validate arguments', () => {
  it('runs every group on every tier by default', () => {
    const options = parseArguments([]);
    expect([...options.groups].sort()).toEqual([...ALL_GROUPS].sort());
    expect(options.tiers).toEqual(['S', 'M', 'L', 'XL']);
    expect(options.remote).toBeNull();
    expect(options.crossDevice).toBe(false);
    expect(options.resume).toBe(false);
  });

  it('reads every flag once', () => {
    const options = parseArguments([
      '--only=smoke,laminar',
      '--tiers=S,L',
      '--remote=https://example.test/app',
      '--out-cross-device',
    ]);
    expect([...options.groups]).toEqual(['smoke', 'laminar']);
    expect(options.tiers).toEqual(['S', 'L']);
    expect(options.remote).toBe('https://example.test/app/');
    expect(options.crossDevice).toBe(true);
  });

  it.each([
    ['--only=bogus', /group/],
    ['--only=', /group/],
    ['--tiers=XXL', /tier/],
    ['--remote=ftp://x', /http/],
    ['--no-docs', /Unknown option/],
    ['--out=file.json', /Unknown option/],
    ['results.json', /Unknown option/],
  ])('rejects %s', (argument, message) => {
    expect(() => parseArguments([argument])).toThrow(message);
  });

  it('resumes local measurements and rejects remote resume', () => {
    expect(parseArguments(['--resume']).resume).toBe(true);
    expect(() => parseArguments(['--resume', '--remote=https://example.test/'])).toThrow('local');
  });
});

describe('validate run planning', () => {
  it('needs no browser for the verification and the derived convergence', () => {
    expect(needsBrowser(parseArguments(['--only=verification']))).toBe(false);
    expect(needsBrowser(parseArguments(['--only=verification,convergence']))).toBe(false);
    expect(needsBrowser(parseArguments(['--only=smoke']))).toBe(true);
    expect(needsBrowser(parseArguments(['--only=grid-check']))).toBe(true);
    expect(needsBrowser(parseArguments([]))).toBe(true);
  });

  it('always needs a browser for a cross-device run, which is named after its adapter', () => {
    expect(needsBrowser(parseArguments(['--only=verification', '--out-cross-device']))).toBe(true);
  });

  it('names a cross-device file after the adapter, safe for a path', () => {
    const adapter = {
      vendor: 'NVIDIA',
      architecture: 'Ada Lovelace',
      device: 'RTX 4090/PCIe',
      description: 'x',
    };
    expect(adapterSlug(adapter)).toBe('nvidia-ada-lovelace-rtx-4090-pcie');
    expect(
      adapterSlug({
        vendor: 'unknown',
        architecture: 'unknown',
        device: 'unknown',
        description: 'x',
      }),
    ).toBe('unknown-adapter');
  });
});

it('refuses to stamp tracked or untracked changes', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sourceCommit } = await import('../../scripts/validate');
  const dir = mkdtempSync(join(tmpdir(), 'validation-stamp-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'source'), 'clean');
    git('add', 'source');
    git('commit', '-m', 'initial');
    expect(sourceCommit(dir)).toMatch(/^[a-f0-9]{7,}$/);
    writeFileSync(join(dir, 'source'), 'dirty');
    expect(() => sourceCommit(dir)).toThrow(/dirty working tree/i);
    git('checkout', '--', 'source');
    writeFileSync(join(dir, 'new-file'), 'new');
    expect(() => sourceCommit(dir)).toThrow(/dirty working tree/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
