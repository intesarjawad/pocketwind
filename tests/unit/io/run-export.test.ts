import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunExportInput } from '../../../src/io/run-export';
import { buildRunFile, runFileJson, runFileName } from '../../../src/io/run-export';
import { MAX_RUN_FILE_BYTES, parseRunFile, RUN_FILE_MESSAGES } from '../../../src/io/run-file';

const EXTEND_DOC = readFileSync(new URL('../../../docs/extend.md', import.meta.url), 'utf8');

function documentedFields(): string[] {
  const start = EXTEND_DOC.indexOf('\n## Run file\n');
  if (start < 0) throw new Error('docs/extend.md has no "Run file" section.');
  const end = EXTEND_DOC.indexOf('\n## ', start + 1);
  const section = EXTEND_DOC.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\| `(\w+)` \|/gm)].map((match) => match[1] ?? '');
}

const INPUT: RunExportInput = {
  name: 'Ahmed 25',
  settings: {
    presetId: 'ahmed-25',
    tier: 'M',
    storage: 'f32',
    operator: 'trt',
    walls: 'bb',
    speedMps: 10,
    bodyLengthMm: 1044,
    flowAxis: 'x',
    flowSign: 1,
    upAxis: 'z',
    floor: true,
    paused: false,
    compare: { enabled: true },
  },
  summary: {
    cd: 0.31,
    status: { kind: 'steady', relStdPct: 0.4, driftPct: 0.2 },
    samples: 42,
  },
  cdaM2: 0.0124,
  dragForceN: 0.28,
  semPct: 0.7,
  effectiveRe: 320,
  viscosityFloor: true,
  grid: { nx: 192, ny: 96, nz: 96 },
  referenceAreaRule: 'preset',
  forceHistory: [
    [0, 0.2],
    [8, 0.3],
  ],
  fy: -0.02,
  fz: 0.01,
  commit: '9753a3c',
  numericsHash: 'abc123',
};

describe('run export', () => {
  it('flattens settings and results into one run file', () => {
    expect(buildRunFile(INPUT)).toEqual({
      schemaVersion: 3,
      presetId: 'ahmed-25',
      tier: 'M',
      storage: 'f32',
      operator: 'trt',
      walls: 'bb',
      speedMps: 10,
      bodyLengthMm: 1044,
      flowAxis: 'x',
      flowSign: 1,
      upAxis: 'z',
      floor: true,
      paused: false,
      compare: { enabled: true },
      name: 'Ahmed 25',
      cd: 0.31,
      cdaM2: 0.0124,
      dragForceN: 0.28,
      status: { kind: 'steady', relStdPct: 0.4, driftPct: 0.2 },
      fluctuationPct: 0.4,
      semPct: 0.7,
      effectiveRe: 320,
      viscosityFloor: true,
      grid: { nx: 192, ny: 96, nz: 96 },
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
    });
  });

  it('withholds fluctuation while the run is still settling', () => {
    const run = buildRunFile({
      ...INPUT,
      summary: { cd: null, status: { kind: 'settling', etaS: 12 }, samples: 8 },
    });
    expect(run.fluctuationPct).toBeNull();
    expect(run.semPct).toBe(0.7);
  });

  it('writes indented JSON with a trailing newline', () => {
    const json = runFileJson(buildRunFile(INPUT));
    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('\n  "schemaVersion": 3,');
    expect(JSON.parse(json)).toEqual(buildRunFile(INPUT));
  });

  it('names the download after the run', () => {
    expect(runFileName('Ahmed 25')).toBe('Ahmed 25-run.json');
  });

  it('writes the documented fields and additive flow-condition metadata', () => {
    const documented = documentedFields();
    expect(documented.length).toBeGreaterThan(0);
    expect(Object.keys(buildRunFile(INPUT)).sort()).toEqual(
      [...documented, 'effectiveRe', 'viscosityFloor'].sort(),
    );
  });

  it('reads an exported run back as an equal object', () => {
    const run = buildRunFile(INPUT);
    expect(parseRunFile(runFileJson(run))).toEqual(run);
    expect(parseRunFile(new TextEncoder().encode(runFileJson(run)))).toEqual(run);
  });

  it('refuses each malformed export with its message', () => {
    const json = runFileJson(buildRunFile(INPUT));
    const withoutCd = JSON.parse(json) as Record<string, unknown>;
    Reflect.deleteProperty(withoutCd, 'cd');
    const cases = [
      ['too-large', 'x'.repeat(MAX_RUN_FILE_BYTES + 1)],
      ['invalid-json', json.slice(0, json.length / 2)],
      ['unknown-version', json.replace('"schemaVersion": 3', '"schemaVersion": 4')],
      ['missing-field', JSON.stringify(withoutCd)],
    ] as const;
    for (const [kind, text] of cases) {
      expect(parseRunFile(text)).toEqual({ kind, messageId: RUN_FILE_MESSAGES[kind] });
    }
  });

  it('keeps a file name free of path separators', () => {
    expect(runFileName('a/b:c')).toBe('a-b-c-run.json');
    expect(runFileName('  ')).toBe('untitled-run.json');
  });
});
