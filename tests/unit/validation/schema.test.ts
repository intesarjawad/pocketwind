import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/validate-schema.mjs';

type Row = Record<string, unknown>;

const TRT_ONLY = { operator: ['trt'], walls: ['bb'], storage: ['f32'] };
const TWO_OPERATORS = { operator: ['trt', 'reg'], walls: ['bb'], storage: ['f32'] };

function document(rows: Row[], factors: Record<string, string[]> = TRT_ONLY, extra: Row = {}): Row {
  const section = (group: string) =>
    rows
      .filter((row) => {
        const own = ['laminar', 'confinement', 'sensitivity'].includes(String(row.group))
          ? String(row.group)
          : 'validation';
        return own === group;
      })
      .map((row) => ({ commit: 'abc1234', ...row }));
  return {
    schemaVersion: 1,
    commit: 'abc1234',
    date: '2026-11-06T00:00:00.000Z',
    machine: {
      adapter: { vendor: 'test', architecture: 'cpu', device: 'stub', description: 'stub' },
      features: [],
      limits: {},
      userAgent: 'test-agent',
    },
    factors,
    verification: [],
    laminar: section('laminar'),
    validation: section('validation'),
    confinement: section('confinement'),
    convergence: [],
    sensitivity: section('sensitivity'),
    gridCheck: [],
    crossDevice: [],
    skipped: [],
    ...extra,
  };
}

function report(rows: Row[], factors?: Record<string, string[]>, extra?: Row): string {
  return JSON.stringify(document(rows, factors, extra));
}

function baseRows(): Row[] {
  return [
    { case: 'ahmed-25', group: 'validation', tier: 'L', variant: 'default', isDefault: true },
    { case: 'sphere-re-100', group: 'laminar', tier: 'S', operator: 'trt', isDefault: true },
    { case: 'sphere-re-100', group: 'laminar', tier: 'M', operator: 'trt', isDefault: true },
    { case: 'sphere-re-100', group: 'laminar', tier: 'L', operator: 'trt', isDefault: true },
    {
      case: 'cube-confinement',
      group: 'confinement',
      tier: 'XL',
      operator: 'trt',
      isDefault: true,
    },
    {
      case: 'sphere-confinement',
      group: 'confinement',
      tier: 'XL',
      operator: 'trt',
      isDefault: true,
    },
    { case: 'cube', group: 'shape-class', tier: 'S', isDefault: true },
  ];
}

/** Every row a complete run holds for the factor levels the tests use, written out by hand. */
function completeRows(operators: string[], flips: string[]): Row[] {
  const rows: Row[] = [];
  for (const tier of ['S', 'M', 'XL']) {
    rows.push({ case: 'ahmed-25', group: 'validation', tier, isDefault: true });
  }
  rows.push({
    case: 'ahmed-25',
    group: 'validation',
    tier: 'L',
    variant: 'default',
    isDefault: true,
  });
  for (const flip of flips) {
    rows.push({
      case: 'ahmed-25',
      group: 'validation',
      tier: 'L',
      variant: `flip-${flip}`,
      isDefault: false,
    });
  }
  for (const tier of ['S', 'M', 'L']) {
    rows.push(
      { case: 'cube', group: 'shape-class', tier, isDefault: true },
      { case: 'sphere', group: 'shape-class', tier, isDefault: true },
    );
  }
  for (const [index, operator] of operators.entries()) {
    for (const tier of ['S', 'M', 'L']) {
      rows.push({
        case: 'sphere-re-100',
        group: 'laminar',
        tier,
        operator,
        isDefault: index === 0,
      });
    }
    for (const caseId of ['cube-confinement', 'sphere-confinement']) {
      rows.push({
        case: caseId,
        group: 'confinement',
        tier: 'XL',
        operator,
        isDefault: index === 0,
      });
    }
  }
  rows.push(
    { case: 'ahmed-25', group: 'sensitivity', tier: 'XL', sensitivity: 'domain', isDefault: false },
    {
      case: 'ahmed-25',
      group: 'sensitivity',
      tier: 'L',
      sensitivity: 'body-length',
      isDefault: false,
    },
    {
      case: 'ahmed-25',
      group: 'sensitivity',
      tier: 'M',
      sensitivity: 'inlet-speed',
      isDefault: false,
    },
    {
      case: 'ahmed-25',
      group: 'sensitivity',
      tier: 'L',
      sensitivity: 'stilts',
      stilts: true,
      isDefault: false,
    },
    {
      case: 'ahmed-25',
      group: 'sensitivity',
      tier: 'L',
      sensitivity: 'stilts',
      stilts: false,
      isDefault: false,
    },
  );
  return rows;
}

const COMPLETE_EXTRA = {
  verification: [{ case: 'taylor-green-16', group: 'verification', commit: 'abc1234' }],
  convergence: [{ case: 'ahmed-25', group: 'convergence', commit: 'abc1234' }],
  gridCheck: [{ case: 'sphere', kind: 'no-band', reason: 'x', commit: 'abc1234' }],
  skipped: [{ case: 'ahmed-35', group: 'validation', tier: 'L', reason: 'No reference.' }],
};

function check(json: string, ...flags: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'pocketwind-schema-'));
  try {
    const path = join(directory, 'results.json');
    writeFileSync(path, json);
    return spawnSync(process.execPath, [SCRIPT, path, ...flags], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('validation result schema', () => {
  it('accepts a well-formed report and derives its row set from factors', () => {
    const result = check(report(baseRows()));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is valid');
  });

  it('rejects a required row without isDefault', () => {
    const rows = baseRows();
    delete rows[0]?.isDefault;
    const result = check(report(rows));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no boolean isDefault');
  });

  it('rejects two default rows for one case and tier', () => {
    const result = check(
      report([
        ...baseRows(),
        { case: 'ahmed-25', group: 'validation', tier: 'L', isDefault: true },
      ]),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('2 default rows at tier L');
  });

  it('rejects an unknown or impossible flip variant', () => {
    const unknown = check(
      report([
        ...baseRows(),
        { case: 'ahmed-25', group: 'validation', tier: 'L', variant: 'flip-magic' },
      ]),
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown variant flip-magic');
    const oneLevel = check(
      report([
        ...baseRows(),
        { case: 'ahmed-25', group: 'validation', tier: 'L', variant: 'flip-walls' },
      ]),
    );
    expect(oneLevel.status).toBe(1);
    expect(oneLevel.stderr).toContain('no second level');
  });

  it('rejects a duplicate variant and a non-default variant marked as default', () => {
    const duplicate = check(
      report(
        [...baseRows(), { case: 'ahmed-25', group: 'validation', tier: 'L', variant: 'default' }],
        { operator: ['trt', 'reg'], walls: ['bb'], storage: ['f32'] },
      ),
    );
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('repeats variant default');
    const marked = check(
      report(
        [
          ...baseRows(),
          {
            case: 'ahmed-25',
            group: 'validation',
            tier: 'L',
            variant: 'flip-operator',
            isDefault: true,
          },
        ],
        { operator: ['trt', 'reg'], walls: ['bb'], storage: ['f32'] },
      ),
    );
    expect(marked.status).toBe(1);
    expect(marked.stderr).toContain('flips operator but is marked as the default');
  });

  it('requires every factor level with the strict flags', () => {
    const factors = {
      operator: ['trt', 'reg'],
      walls: ['bb', 'bouzidi'],
      storage: ['f32', 'f16'],
    };
    const flips = ['operator', 'walls', 'storage'];
    const rows = completeRows(['trt', 'reg'], flips);
    expect(check(report(rows, factors, COMPLETE_EXTRA), '--require-all').status).toBe(0);
    const missing = check(
      report(
        rows.filter((row) => row.variant !== 'flip-storage'),
        factors,
        COMPLETE_EXTRA,
      ),
      '--require-all',
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('expected default, flip-operator, flip-storage, flip-walls');
  });

  it('accepts a recorded skip reason in place of a row, and nothing else', () => {
    const rows = completeRows(['trt'], []).filter((row) => row.case !== 'cube' || row.tier !== 'M');
    const missing = check(report(rows, TRT_ONLY, COMPLETE_EXTRA), '--require-all');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('shape-class cube lacks a row or a skip reason for tier M');
    const skipped = check(
      report(rows, TRT_ONLY, {
        ...COMPLETE_EXTRA,
        skipped: [
          ...COMPLETE_EXTRA.skipped,
          { case: 'cube', group: 'shape-classes', tier: 'M', reason: 'timed out' },
        ],
      }),
      '--require-all',
    );
    expect(skipped.status).toBe(0);
  });

  it('needs the verification, convergence, grid check and sensitivity sections when complete', () => {
    const rows = completeRows(['trt'], []);
    const empty = check(report(rows), '--require-all');
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('verification has no rows');
    expect(empty.stderr).toContain('convergence has no Ahmed 25 estimate');
    expect(empty.stderr).toContain('gridCheck has no rows');
    expect(empty.stderr).toContain('validation ahmed-35 lacks a row or a skip reason');
    const noSensitivity = check(
      report(
        rows.filter((row) => row.group !== 'sensitivity'),
        TRT_ONLY,
        COMPLETE_EXTRA,
      ),
      '--require-all',
    );
    expect(noSensitivity.stderr).toContain('sensitivity domain lacks a row or a skip reason');
    expect(noSensitivity.stderr).toContain('stilts excluded');
  });

  it('requires laminar and confinement rows for every listed operator', () => {
    expect(check(report(baseRows(), TWO_OPERATORS), '--require-operators').status).toBe(1);
    const rows = [
      ...baseRows(),
      { case: 'sphere-re-100', group: 'laminar', tier: 'S', operator: 'reg', isDefault: false },
      { case: 'sphere-re-100', group: 'laminar', tier: 'M', operator: 'reg', isDefault: false },
      { case: 'sphere-re-100', group: 'laminar', tier: 'L', operator: 'reg', isDefault: false },
      {
        case: 'cube-confinement',
        group: 'confinement',
        tier: 'XL',
        operator: 'reg',
        isDefault: false,
      },
      {
        case: 'sphere-confinement',
        group: 'confinement',
        tier: 'XL',
        operator: 'reg',
        isDefault: false,
      },
    ];
    expect(check(report(rows, TWO_OPERATORS), '--require-operators').status).toBe(0);
  });

  it('does not ask the operator check for Ahmed variants or other sections', () => {
    const rows = baseRows().filter((row) => row.group !== 'validation' || row.case !== 'ahmed-25');
    expect(check(report(rows), '--require-operators').status).toBe(0);
  });

  it('requires a non-Apple adapter for the cross-device flag', () => {
    const apple = { case: 'cube', commit: 'abc1234', adapter: { vendor: 'apple' } };
    const nvidia = { case: 'cube', commit: 'def5678', adapter: { vendor: 'nvidia' } };
    const onlyApple = check(
      report(baseRows(), TRT_ONLY, { crossDevice: [apple] }),
      '--require-cross-device',
    );
    expect(onlyApple.status).toBe(1);
    expect(onlyApple.stderr).toContain('non-Apple adapter');
    expect(
      check(
        report(baseRows(), TRT_ONLY, { crossDevice: [apple, nvidia] }),
        '--require-cross-device',
      ).status,
    ).toBe(0);
  });

  it('rejects a document missing its envelope, a row commit or an unknown flag', () => {
    const noMachine = check(report(baseRows(), TRT_ONLY, { machine: null }));
    expect(noMachine.status).toBe(1);
    expect(noMachine.stderr).toContain('machine must have adapter, features, limits and userAgent');
    const noArray = check(report(baseRows(), TRT_ONLY, { gridCheck: null }));
    expect(noArray.stderr).toContain('gridCheck must be an array');
    const noCommit = check(
      report(baseRows(), TRT_ONLY, { verification: [{ case: 'taylor-green-16' }] }),
    );
    expect(noCommit.stderr).toContain('verification row 0 has no commit');
    expect(check(report(baseRows()), '--require-everything').stderr).toContain('unknown option');
  });
});
