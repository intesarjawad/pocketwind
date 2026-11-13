import { describe, expect, it } from 'vitest';
import { compareRefusal, prepareComparison } from '../../../src/app/compare';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import type { Settings } from '../../../src/app/settings';
import {
  MAX_RUN_FILE_BYTES,
  parseRunFile,
  RUN_FILE_MESSAGES,
  RUN_FILE_SCHEMA_VERSION,
} from '../../../src/io/run-file';

function validRun(): Record<string, unknown> {
  return {
    schemaVersion: RUN_FILE_SCHEMA_VERSION,
    presetId: 'ahmed-25',
    tier: 'S',
    storage: 'auto',
    operator: 'trt',
    walls: 'bb',
    speedMps: 10,
    bodyLengthMm: 1044,
    flowAxis: 'x',
    flowSign: 1,
    upAxis: 'z',
    floor: true,
    paused: false,
    compare: { enabled: false },
    name: 'Ahmed 25',
    cd: 0.31,
    cdaM2: 0.0124,
    dragForceN: 0.28,
    status: { kind: 'steady', relStdPct: 0.4, driftPct: 0.2 },
    fluctuationPct: 0.4,
    semPct: 0.7,
    effectiveRe: 320,
    viscosityFloor: true,
    grid: { nx: 128, ny: 64, nz: 64 },
    referenceAreaRule: 'preset',
    forceHistory: [
      [0, 0.2],
      [8, 0.3],
    ],
    fy: -0.02,
    fz: 0.01,
    unvalidated: ['fy', 'fz'],
    commit: '9753a3c',
    numericsHash: 'abc123',
  };
}

function missing(field: string): Record<string, unknown> {
  const run = validRun();
  Reflect.deleteProperty(run, field);
  return run;
}

describe('run file parser', () => {
  it('marks conditions in older files as unknown and refuses malformed new fields', () => {
    const run = missing('effectiveRe');
    Reflect.deleteProperty(run, 'viscosityFloor');
    expect(parseRunFile(JSON.stringify(run))).toMatchObject({
      effectiveRe: null,
      viscosityFloor: null,
    });
    for (const patch of [{ effectiveRe: -1 }, { viscosityFloor: 'false' }]) {
      expect(parseRunFile(JSON.stringify({ ...validRun(), ...patch }))).toMatchObject({
        kind: 'missing-field',
      });
    }
  });

  it('reads a valid export and keeps every field', () => {
    const result = parseRunFile(JSON.stringify(validRun()));
    expect(result).toEqual(validRun());
  });

  it('accepts bytes as well as text', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(validRun()));
    expect(parseRunFile(bytes)).toEqual(validRun());
  });

  it('refuses a file over five megabytes before parsing it', () => {
    const result = parseRunFile('x'.repeat(MAX_RUN_FILE_BYTES + 1));
    expect(result).toEqual({
      kind: 'too-large',
      messageId: RUN_FILE_MESSAGES['too-large'],
    });
  });

  it('refuses invalid JSON without throwing', () => {
    expect(parseRunFile('{')).toEqual({
      kind: 'invalid-json',
      messageId: RUN_FILE_MESSAGES['invalid-json'],
    });
    expect(parseRunFile('[]')).toEqual({
      kind: 'invalid-json',
      messageId: RUN_FILE_MESSAGES['invalid-json'],
    });
  });

  it('refuses a schema version it does not know', () => {
    const result = parseRunFile(JSON.stringify({ ...validRun(), schemaVersion: 99 }));
    expect(result).toEqual({
      kind: 'unknown-version',
      messageId: RUN_FILE_MESSAGES['unknown-version'],
    });
  });

  it('treats a missing schema version as a missing field', () => {
    expect(parseRunFile(JSON.stringify(missing('schemaVersion')))).toEqual({
      kind: 'missing-field',
      messageId: RUN_FILE_MESSAGES['missing-field'],
    });
  });

  it('refuses a run file without a required settings or result field', () => {
    for (const field of [
      'presetId',
      'speedMps',
      'bodyLengthMm',
      'flowAxis',
      'compare',
      'grid',
      'referenceAreaRule',
      'status',
      'forceHistory',
      'numericsHash',
    ]) {
      expect(parseRunFile(JSON.stringify(missing(field)))).toEqual({
        kind: 'missing-field',
        messageId: RUN_FILE_MESSAGES['missing-field'],
      });
    }
  });

  it('defaults the unvalidated components when an older file omits them', () => {
    const run = validRun();
    Reflect.deleteProperty(run, 'unvalidated');
    const result = parseRunFile(JSON.stringify(run));
    expect(result).toEqual({ ...validRun(), unvalidated: ['fy', 'fz'] });
  });

  it('refuses fields whose type cannot describe a run', () => {
    for (const field of [
      { grid: { nx: 128, ny: 0, nz: 64 } },
      { tier: 'toString' },
      { storage: 'f64' },
      { operator: 'bgk' },
      { compare: true },
      { bodyLengthMm: 0 },
      { flowSign: 0 },
      { flowAxis: 'x', upAxis: 'x' },
      { status: { kind: 'steady' } },
      { referenceAreaRule: 'voxels' },
      { unvalidated: ['fx'] },
    ]) {
      expect(parseRunFile(JSON.stringify({ ...validRun(), ...field }))).toEqual({
        kind: 'missing-field',
        messageId: RUN_FILE_MESSAGES['missing-field'],
      });
    }
  });
});

describe('comparing with a saved run file', () => {
  const build = { numericsHash: 'abc123', tierPolicy: 's-m-l' } as const;
  const current: Settings = { ...DEFAULT_SETTINGS, tier: 'S', speedMps: 10 };

  function fileText(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...validRun(), ...patch });
  }

  function refusalId(patch: Record<string, unknown>, settings: Settings = current): unknown {
    const result = prepareComparison(fileText(patch), settings, build);
    return 'messageId' in result ? result.messageId : null;
  }

  it('accepts a file made at the same tier, speed and reference-area rule', () => {
    const result = prepareComparison(fileText(), current, build);
    expect(result).toEqual({ run: validRun() });
  });

  it('accepts a different commit when the numerics hash matches', () => {
    expect(refusalId({ commit: '0000000' })).toBeNull();
  });

  it('resolves an automatic tier before comparing tiers', () => {
    expect(refusalId({ tier: 'auto' })).toBeNull();
    expect(refusalId({ tier: 'S' }, { ...current, tier: 'auto' })).toBeNull();
  });

  it('checks measured dimensions after allocation, including fallback from the same requested tier', () => {
    const parsed = parseRunFile(fileText({ tier: 'M', grid: { nx: 192, ny: 96, nz: 96 } }));
    if ('kind' in parsed) throw new Error('Expected a valid run.');
    const settings = { ...current, tier: 'M' } as const;
    expect(compareRefusal(parsed, settings, build)).toBeNull();
    expect(compareRefusal(parsed, settings, build, { nx: 128, ny: 64, nz: 64 })).toMatchObject({
      messageId: 'compare-grid-mismatch',
    });
    expect(compareRefusal(parsed, { ...settings, tier: 'L' }, build, parsed.grid)).toBeNull();
    expect(compareRefusal(parsed, settings, build, { ...parsed.grid, nz: 64 })).toMatchObject({
      messageId: 'compare-grid-mismatch',
    });
  });

  it('refuses a different speed', () => {
    const result = prepareComparison(fileText({ speedMps: 25 }), current, build);
    expect(result).toEqual({
      messageId: 'compare-setting-mismatch',
      text: 'The saved run used tier S, 25 m/s and the preset reference area. Choose tier S and 25 m/s, then compare again.',
    });
  });

  it('refuses a different reference-area rule', () => {
    const custom = { ...current, presetId: 'custom' };
    expect(refusalId({}, custom)).toBe('compare-setting-mismatch');
    const result = prepareComparison(fileText({ referenceAreaRule: 'frontal' }), current, build);
    expect(result).toMatchObject({
      messageId: 'compare-setting-mismatch',
      text: expect.stringContaining('the frontal cells reference area'),
    });
  });

  it('refuses a different numerics hash even when the settings match', () => {
    const result = prepareComparison(fileText({ numericsHash: 'other' }), current, build);
    expect(result).toEqual({
      messageId: 'compare-version-mismatch',
      text: 'The saved run was made with different solver numerics, so its drag cannot be compared with this version. Run both models again on this version.',
    });
  });

  it('gives the malformed-file message instead of throwing', () => {
    expect(prepareComparison('{', current, build)).toMatchObject({
      messageId: RUN_FILE_MESSAGES['invalid-json'],
    });
    expect(prepareComparison(fileText({ schemaVersion: 99 }), current, build)).toMatchObject({
      messageId: RUN_FILE_MESSAGES['unknown-version'],
    });
  });

  it('compares the tier of a parsed file with the current tier choice', () => {
    const parsed = parseRunFile(fileText({ tier: 'L' }));
    if ('kind' in parsed) throw new Error('Expected a valid run file.');
    expect(compareRefusal(parsed, current, build, { nx: 192, ny: 96, nz: 96 })?.messageId).toBe(
      'compare-grid-mismatch',
    );
    expect(compareRefusal(parsed, { ...current, tier: 'L' }, build)).toBeNull();
  });

  it('limits a small GPU to tier S on both sides', () => {
    const small = { numericsHash: 'abc123', tierPolicy: 's-only' } as const;
    const parsed = parseRunFile(fileText({ tier: 'L' }));
    if ('kind' in parsed) throw new Error('Expected a valid run file.');
    expect(compareRefusal(parsed, { ...current, tier: 'XL' }, small)).toBeNull();
  });
});
