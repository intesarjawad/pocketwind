import { describe, expect, it } from 'vitest';
import { buildCases } from '../../../src/validation/cases';
import {
  convergenceRows,
  foldCrossDevice,
  mergeResults,
  NO_MACHINE,
  parseResults,
  type RunOutput,
  readGridCheck,
  sharedCommit,
  skipForCase,
  type ValidationResults,
} from '../../../src/validation/results';
import type { AdapterInfo, ValidationRow } from '../../../src/validation/runner';

const ADAPTER: AdapterInfo = {
  vendor: 'test',
  architecture: 'cpu',
  device: 'stub',
  description: 'stub adapter',
  features: [],
};

const STAMP = { commit: 'new1234', date: '2026-11-07T00:00:00.000Z' };

const BASE_ROW: ValidationRow = {
  case: 'ahmed-25',
  id: 'ahmed-25-L-reg-default',
  group: 'validation',
  label: 'Ahmed body at 25 degrees',
  tier: 'L',
  grid: { nx: 256, ny: 128, nz: 128 },
  cells: 4194304,
  operator: 'reg',
  walls: 'bb',
  storage: 'f32',
  variant: 'default',
  sensitivity: null,
  shapeClass: 'road-vehicle',
  speedMps: 40,
  re: 2_784_000,
  les: false,
  floor: true,
  stilts: true,
  bodyLengthMm: 1044,
  bodyLengthCells: 128,
  cellSizeM: 0.00815625,
  referenceAreaM2: 0.112,
  voxelAreaM2: 0.11216,
  blockage: 0.102758,
  baselineBlockage: null,
  uLu: 0.05,
  steps: 30720,
  flowThroughSteps: 5120,
  msPerStep: 1.25,
  cd: 0.3,
  cdVoxel: 0.3,
  cdRaw: null,
  cdMaskell: null,
  referenceCd: 0.285,
  errorPct: 5.26,
  fx: 32,
  fy: 0,
  fz: 0,
  relStdPct: 0.8,
  driftPct: 0.4,
  forceHistory: [],
  adapter: ADAPTER,
  userAgent: 'test-agent',
  commit: 'old5678',
  date: '2026-11-06T00:00:00.000Z',
  isDefault: true,
  pass: true,
  reasons: [],
};

function row(patch: Partial<ValidationRow>): ValidationRow {
  return { ...BASE_ROW, ...patch };
}

function laminar(tier: 'S' | 'M' | 'L', nx: number, cd: number, operator: 'trt' | 'reg' = 'trt') {
  return row({
    case: 'sphere-re-100',
    id: `sphere-re-100-${tier}-${operator}`,
    group: 'laminar',
    tier,
    grid: { nx, ny: 1, nz: 1 },
    operator,
    variant: null,
    cd,
  });
}

function ahmed(tier: 'S' | 'M' | 'L' | 'XL', nx: number, cd: number, patch = {}) {
  return row({
    id: `ahmed-25-${tier}-reg-default`,
    tier,
    grid: { nx, ny: 1, nz: 1 },
    variant: tier === 'L' ? 'default' : null,
    cd,
    ...patch,
  });
}

function previous(patch: Partial<ValidationResults> = {}): ValidationResults {
  return {
    schemaVersion: 1,
    commit: 'old5678',
    date: '2026-11-06T00:00:00.000Z',
    machine: {
      adapter: { vendor: 'old', architecture: 'gpu', device: 'x', description: 'old adapter' },
      features: ['shader-f16'],
      limits: {},
      userAgent: 'old-agent',
    },
    factors: { operator: ['trt'], walls: ['bb'], storage: ['f32'] },
    verification: [],
    laminar: [],
    validation: [],
    confinement: [],
    convergence: [],
    sensitivity: [],
    gridCheck: [],
    crossDevice: [],
    skipped: [],
    ...patch,
  };
}

function run(patch: Partial<RunOutput> = {}): RunOutput {
  return {
    groups: new Set(['validation']),
    tiers: ['S', 'M', 'L', 'XL'],
    factors: { operator: ['trt'], walls: ['bb'], storage: ['f32'] },
    machine: null,
    stamp: STAMP,
    verification: [],
    rows: [],
    plannedIds: new Set(),
    gridCheck: [],
    skipped: [],
    crossDevice: [],
    ...patch,
  };
}

describe('convergence rows', () => {
  it('estimates the default Ahmed rows over M, L and XL from cell size 1/nx', () => {
    const { rows, skipped } = convergenceRows(
      [ahmed('M', 1, 9), ahmed('L', 2, 3), ahmed('XL', 4, 1.5)],
      [],
      STAMP,
    );
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    const [result] = rows;
    if (result?.kind !== 'monotone') throw new Error('Expected a monotone estimate.');
    expect(result.order).toBeCloseTo(2, 9);
    expect(result.extrapolated).toBeCloseTo(1, 9);
    expect(result.gciFinePct).toBeCloseTo(125 / 3, 9);
    expect(result.tiers).toEqual(['M', 'L', 'XL']);
    expect(result.commit).toBe('new1234');
  });

  it('ignores flipped and non-default Ahmed rows', () => {
    const { rows, skipped } = convergenceRows(
      [ahmed('M', 1, 9), ahmed('L', 2, 3), ahmed('XL', 4, 1.5, { isDefault: false })],
      [],
      STAMP,
    );
    expect(rows).toEqual([]);
    expect(skipped).toEqual([
      {
        case: 'ahmed-25',
        group: 'convergence',
        operator: 'reg',
        reason: 'Needs rows at M, L, XL.',
      },
    ]);
  });

  it('estimates the laminar sphere over S, M and L once per operator', () => {
    const { rows, skipped } = convergenceRows(
      [laminar('S', 1, 9), laminar('M', 2, 3), laminar('L', 4, 1.5), laminar('S', 1, 5, 'reg')],
      ['trt', 'reg'],
      STAMP,
    );
    expect(rows.map((entry) => [entry.case, entry.operator, entry.kind])).toEqual([
      ['sphere-re-100', 'trt', 'monotone'],
    ]);
    expect(skipped.map((entry) => [entry.case, entry.operator])).toEqual([
      ['ahmed-25', 'reg'],
      ['sphere-re-100', 'reg'],
    ]);
  });
});

describe('merging a partial run', () => {
  it('replaces only the rows of the groups it ran and keeps the rest', () => {
    const keptLaminar = laminar('S', 16, 1.1);
    const stale = ahmed('S', 64, 0.4);
    const fresh = ahmed('S', 64, 0.31, { commit: 'new1234' });
    const merged = mergeResults(
      previous({ laminar: [keptLaminar], validation: [stale, ahmed('M', 96, 0.4)] }),
      run({ tiers: ['S'], rows: [fresh], plannedIds: new Set([fresh.id]) }),
    );
    expect(merged.laminar).toEqual([keptLaminar]);
    expect(merged.validation.map((entry) => [entry.tier, entry.cd])).toEqual([
      ['M', 0.4],
      ['S', 0.31],
    ]);
  });

  it('drops a stale row of a planned case that failed this time and records the skip', () => {
    const stale = ahmed('S', 64, 0.4);
    const spec = buildCases({ tiers: ['S'] }).find((entry) => entry.id === stale.id);
    if (!spec) throw new Error('The tier-S Ahmed case is missing.');
    const merged = mergeResults(
      previous({ validation: [stale] }),
      run({
        tiers: ['S'],
        plannedIds: new Set([stale.id]),
        skipped: [skipForCase(spec, 'timed out')],
      }),
    );
    expect(merged.validation).toEqual([]);
    expect(merged.skipped.filter((entry) => entry.group === 'validation')).toEqual([
      { case: 'ahmed-25', group: 'validation', tier: 'S', operator: 'reg', reason: 'timed out' },
    ]);
  });

  it('keeps shape-class and smoke rows when only the validation group runs', () => {
    const shape = row({
      id: 'cube-S',
      case: 'cube',
      group: 'shape-class',
      tier: 'S',
      variant: null,
    });
    const smoke = row({ id: 'smoke-ahmed-25-S', group: 'smoke', tier: 'S', isDefault: false });
    const merged = mergeResults(
      previous({ validation: [shape, smoke, ahmed('S', 64, 0.4)] }),
      run({ rows: [], plannedIds: new Set() }),
    );
    expect(merged.validation.map((entry) => entry.id)).toEqual(['cube-S', 'smoke-ahmed-25-S']);
  });

  it('puts every row group in its section', () => {
    const merged = mergeResults(
      null,
      run({
        groups: new Set(['smoke', 'shape-classes', 'laminar', 'confinement', 'sensitivity']),
        rows: [
          row({ id: 'a', group: 'smoke' }),
          row({ id: 'b', group: 'shape-class' }),
          row({ id: 'c', group: 'laminar' }),
          row({ id: 'd', group: 'confinement' }),
          row({ id: 'e', group: 'sensitivity' }),
        ],
      }),
    );
    expect(merged.validation.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(merged.laminar.map((entry) => entry.id)).toEqual(['c']);
    expect(merged.confinement.map((entry) => entry.id)).toEqual(['d']);
    expect(merged.sensitivity.map((entry) => entry.id)).toEqual(['e']);
  });

  it('keeps the previous machine when no browser ran and takes the new one otherwise', () => {
    const old = previous();
    expect(mergeResults(old, run()).machine).toEqual(old.machine);
    expect(mergeResults(null, run()).machine).toEqual(NO_MACHINE);
    const machine = { ...NO_MACHINE, userAgent: 'new-agent' };
    expect(mergeResults(old, run({ machine })).machine).toEqual(machine);
  });

  it('recomputes convergence when its inputs ran and keeps it otherwise', () => {
    const rows = [
      ahmed('M', 1, 9, { commit: 'new1234' }),
      ahmed('L', 2, 3, { commit: 'new1234' }),
      ahmed('XL', 4, 1.5, { commit: 'new1234' }),
    ];
    const merged = mergeResults(
      null,
      run({ rows, plannedIds: new Set(rows.map((entry) => entry.id)) }),
    );
    expect(merged.convergence.map((entry) => [entry.case, entry.kind])).toEqual([
      ['ahmed-25', 'monotone'],
    ]);
    const kept = mergeResults(merged, run({ groups: new Set(['verification']) }));
    expect(kept.convergence).toEqual(merged.convergence);
    const fromStored = mergeResults(merged, run({ groups: new Set(['convergence']) }));
    expect(fromStored.convergence).toEqual(merged.convergence);
  });

  it('replaces convergence skips once the rows exist', () => {
    const first = mergeResults(null, run({ groups: new Set(['convergence']) }));
    expect(first.skipped.map((entry) => [entry.group, entry.case])).toEqual([
      ['convergence', 'ahmed-25'],
      ['convergence', 'sphere-re-100'],
    ]);
    const rows = [ahmed('M', 1, 9), ahmed('L', 2, 3), ahmed('XL', 4, 1.5)];
    const second = mergeResults(first, run({ rows, groups: new Set(['validation']) }));
    expect(second.skipped.map((entry) => entry.case)).toEqual(['sphere-re-100']);
    expect(second.convergence.map((entry) => entry.case)).toEqual(['ahmed-25']);
  });

  it('replaces grid checks and verification only when their groups ran', () => {
    const check = { case: 'sphere', kind: 'no-band' as const, reason: 'x', ...STAMP };
    const merged = mergeResults(
      previous(),
      run({ groups: new Set(['grid-check']), gridCheck: [check] }),
    );
    expect(merged.gridCheck).toEqual([check]);
    expect(merged.verification).toEqual([]);
    expect(mergeResults(merged, run()).gridCheck).toEqual([check]);
  });

  it('writes factors, the run date and the folded cross-device rows', () => {
    const other = row({ id: 'other', adapter: { ...ADAPTER, vendor: 'nvidia' } });
    const merged = mergeResults(
      previous(),
      run({
        factors: { operator: ['trt', 'reg'], walls: ['bb'], storage: ['f32'] },
        crossDevice: [other],
      }),
    );
    expect(merged.factors.operator).toEqual(['trt', 'reg']);
    expect(merged.date).toBe('2026-11-07T00:00:00.000Z');
    expect(merged.crossDevice).toEqual([other]);
  });
});

describe('top-level commit', () => {
  it('is the shared commit of every row, or mixed when they differ', () => {
    const base = previous();
    expect(sharedCommit(base, 'fallback')).toBe('fallback');
    const one = previous({ validation: [row({ commit: 'aaa' }), row({ commit: 'aaa' })] });
    expect(sharedCommit(one, 'fallback')).toBe('aaa');
    const two = previous({
      validation: [row({ commit: 'aaa' })],
      laminar: [row({ commit: 'bbb' })],
    });
    expect(sharedCommit(two, 'fallback')).toBe('mixed');
  });

  it('ignores cross-device rows, which keep the commit they were measured on', () => {
    const results = previous({
      validation: [row({ commit: 'aaa' })],
      crossDevice: [row({ commit: 'zzz' })],
    });
    expect(sharedCommit(results, 'fallback')).toBe('aaa');
  });

  it('counts verification, convergence and grid check rows', () => {
    const results = previous({
      validation: [row({ commit: 'aaa' })],
      gridCheck: [{ case: 'sphere', kind: 'no-band', reason: 'x', commit: 'bbb', date: 'd' }],
    });
    expect(sharedCommit(results, 'fallback')).toBe('mixed');
  });
});

describe('results files', () => {
  it('reads a document in this layout and treats any other as absent', () => {
    const text = JSON.stringify(previous());
    expect(parseResults(text)?.commit).toBe('old5678');
    expect(parseResults('not json')).toBeNull();
    expect(parseResults(JSON.stringify({ generatedAt: 'x', cases: [] }))).toBeNull();
    expect(parseResults(JSON.stringify({ ...previous(), gridCheck: null }))).toBeNull();
  });

  it('folds the rows of every cross-device document and keeps their own stamps', () => {
    const a = previous({ validation: [row({ id: 'a', commit: 'aaa', date: 'd1' })] });
    const b = previous({
      laminar: [row({ id: 'b', commit: 'bbb', date: 'd2' })],
      crossDevice: [row({ id: 'ignored' })],
    });
    expect(foldCrossDevice([a, b]).map((entry) => [entry.id, entry.commit, entry.date])).toEqual([
      ['a', 'aaa', 'd1'],
      ['b', 'bbb', 'd2'],
    ]);
  });
});

describe('grid check rows', () => {
  it('stamps a band and a no-band result with the preset', () => {
    expect(readGridCheck('cube', { kind: 'band', gciPct: 3, extrapolatedCd: 1.05 }, STAMP)).toEqual(
      {
        case: 'cube',
        kind: 'band',
        gciPct: 3,
        extrapolatedCd: 1.05,
        ...STAMP,
      },
    );
    expect(readGridCheck('sphere', { kind: 'no-band', reason: 'drag crisis' }, STAMP)).toEqual({
      case: 'sphere',
      kind: 'no-band',
      reason: 'drag crisis',
      ...STAMP,
    });
  });

  it.each([
    [null],
    [{ kind: 'maybe' }],
    [{ kind: 'band', gciPct: 3 }],
    [{ kind: 'band', gciPct: 'x', extrapolatedCd: 1 }],
    [{ kind: 'no-band' }],
  ])('rejects %j', (value) => {
    expect(() => readGridCheck('cube', value, STAMP)).toThrow(RangeError);
  });

  it('passes on the reason a page gave for a grid check it could not finish', () => {
    expect(() => readGridCheck('cube', { error: 'Tier L could not be allocated.' }, STAMP)).toThrow(
      'Tier L could not be allocated.',
    );
  });
});

describe('skip records', () => {
  it('name a sensitivity case by its kind and a flip by its variant', () => {
    const cases = buildCases();
    const sensitivity = cases.find((entry) => entry.id === 'sensitivity-domain');
    const flip = cases.find((entry) => entry.variant === 'flip-operator');
    if (!sensitivity || !flip) throw new Error('Expected cases are missing.');
    expect(skipForCase(sensitivity, 'x')).toEqual({
      case: 'sensitivity-domain',
      group: 'sensitivity',
      tier: 'XL',
      operator: 'reg',
      reason: 'x',
    });
    expect(skipForCase(flip, 'y')).toMatchObject({
      case: 'ahmed-25',
      variant: 'flip-operator',
      tier: 'L',
    });
  });
});
