import { describe, expect, it } from 'vitest';
import { defaultOperator } from '../../../src/lbm/params';
import type { ValidationFactors } from '../../../src/validation/cases';
import {
  AHMED_25_REFERENCE_CD,
  availableValidationFactors,
  buildCases,
  CUBE_SPHERE_BLOCKAGE,
  flowThroughSteps,
  isDefaultRow,
  planCases,
  plannedSkips,
  SPHERE_RE_100_REFERENCE_CD,
  type ValidationGroup,
} from '../../../src/validation/cases';

const ALL_FACTORS: ValidationFactors = {
  operator: ['trt', 'reg'],
  walls: ['bb', 'bouzidi'],
  storage: ['f32', 'f16'],
};

function rowsFor(tier: string, group: string) {
  return buildCases().filter((row) => row.tier === tier && row.group === group);
}

describe('validation case list', () => {
  it('runs six flow-throughs and averages the last two', () => {
    const steps = flowThroughSteps(128);
    expect(steps).toBe(2560);
    const row = buildCases({ tiers: ['S'] }).find(
      (candidate) => candidate.group === 'validation' && candidate.tier === 'S',
    );
    expect(row?.steps).toBe(6 * steps);
    expect(row?.averageSteps).toBe(2 * steps);
  });

  it('puts the laminar sphere at one eighth of the streamwise length', () => {
    const rows = buildCases().filter((row) => row.group === 'laminar' && row.operator === 'trt');
    expect(rows.map((row) => [row.tier, row.bodyLengthCells])).toEqual([
      ['L', 32],
      ['M', 24],
      ['S', 16],
    ]);
    for (const row of rows) {
      expect(row.re).toBe(100);
      expect(row.les).toBe(false);
      expect(row.shapeClass).toBe('laminar');
      expect(row.referenceCd).toBe(SPHERE_RE_100_REFERENCE_CD);
      expect(row.speedMps).toBeCloseTo(0.015, 12);
    }
  });

  it('uses the interactive defaults for every Ahmed validation tier', () => {
    const rows = rowsFor('L', 'validation').filter((row) => row.variant === 'default');
    expect(rows.map((row) => row.variant)).toEqual(['default']);
    expect(rows[0]?.bodyLengthMm).toBe(1044);
    expect(rows[0]?.bodyLengthCells).toBe(128);
    expect(rows[0]?.grid).toEqual({ nx: 256, ny: 128, nz: 128 });
    expect(rows[0]?.referenceCd).toBe(AHMED_25_REFERENCE_CD);
    expect(rows[0]?.re).toBeCloseTo(2_784_000, 2);
    expect(rowsFor('S', 'validation')[0]?.bodyLengthCells).toBe(64);
    expect(rowsFor('M', 'validation')[0]?.bodyLengthCells).toBe(96);
    expect(rowsFor('XL', 'validation')[0]?.bodyLengthCells).toBe(192);
  });

  it('gives the cube and sphere four percent frontal blockage', () => {
    const shapeRows = buildCases().filter((row) => row.group === 'shape-class');
    expect(shapeRows).toHaveLength(6);
    const cube = shapeRows.find((row) => row.case === 'cube' && row.tier === 'S');
    const sphere = shapeRows.find((row) => row.case === 'sphere' && row.tier === 'S');
    expect(cube?.blockage).toBeCloseTo(0.04, 12);
    expect(sphere?.blockage).toBeCloseTo(Math.PI * 0.113 ** 2, 12);
    expect(sphere?.blockage).toBeCloseTo(CUBE_SPHERE_BLOCKAGE, 3);
    expect(cube?.shapeClass).toBe('sharp-edged');
    expect(sphere?.shapeClass).toBe('smooth-subcritical');
    expect(cube?.floor).toBe(false);
    expect(cube?.les).toBe(true);
    expect(cube?.speedMps).toBe(40);
    expect(sphere?.re).toBe(20000);
    expect(sphere?.speedMps).toBeCloseTo((20000 * 1.5e-5) / 0.226, 9);
    expect(sphere?.referenceCd).toBeNull();
  });

  it('keeps the tier-L body size on the XL grid for confinement', () => {
    const rows = buildCases({ tiers: ['S'] }).filter(
      (row) => row.group === 'confinement' && row.operator === 'trt',
    );
    expect(rows.map((row) => row.tier)).toEqual(['XL', 'XL']);
    const sphere = rows.find((row) => row.case === 'sphere-confinement');
    const cube = rows.find((row) => row.case === 'cube-confinement');
    expect(sphere?.bodyLengthCells).toBe(32);
    expect((sphere?.grid.ny ?? NaN) / 32).toBe(6);
    expect(sphere?.blockage).toBeCloseTo((Math.PI * 16 ** 2) / 192 ** 2, 12);
    expect(cube?.blockage).toBeCloseTo((0.2 * 128) ** 2 / 192 ** 2, 12);
    expect(cube?.blockage).toBeCloseTo(0.04 / 2.25, 12);
    expect(cube?.cellSizeM).toBe(1 / 128);
  });

  it('runs laminar and confinement rows for each operator level', () => {
    const rows = buildCases({ factors: { ...ALL_FACTORS, walls: ['bb'], storage: ['f32'] } });
    const laminar = rows.filter((row) => row.group === 'laminar');
    expect(laminar.map((row) => [row.tier, row.operator])).toEqual([
      ['L', 'reg'],
      ['L', 'trt'],
      ['M', 'reg'],
      ['M', 'trt'],
      ['S', 'reg'],
      ['S', 'trt'],
    ]);
    const confinement = rows.filter((row) => row.group === 'confinement');
    expect(confinement.map((row) => `${row.case}-${row.operator}`)).toEqual([
      'cube-confinement-reg',
      'cube-confinement-trt',
      'sphere-confinement-reg',
      'sphere-confinement-trt',
    ]);
  });

  it('adds one tier-L Ahmed flip row per factor with a second level', () => {
    const rows = buildCases({ tiers: ['L'], factors: ALL_FACTORS }).filter(
      (row) => row.group === 'validation',
    );
    expect(rows.map((row) => row.variant).sort()).toEqual([
      'default',
      'flip-operator',
      'flip-storage',
      'flip-walls',
    ]);
    expect(rows.map((row) => row.id).sort()).toEqual([
      'ahmed-25-L-operator-trt',
      'ahmed-25-L-reg-default',
      'ahmed-25-L-storage-f16',
      'ahmed-25-L-walls-bouzidi',
    ]);
  });

  it('marks only rows at the run-time defaults', () => {
    const defaults = buildCases({ factors: ALL_FACTORS });
    expect(defaults.find((row) => row.id === 'ahmed-25-L-reg-default')?.isDefault).toBe(true);
    expect(defaults.find((row) => row.id === 'ahmed-25-L-operator-trt')?.isDefault).toBe(false);
    expect(defaults.find((row) => row.id === 'ahmed-25-L-walls-bouzidi')?.isDefault).toBe(false);
    expect(defaults.find((row) => row.id === 'ahmed-25-L-storage-f16')?.isDefault).toBe(false);
    expect(defaults.find((row) => row.id === 'sphere-re-100-S-trt')?.isDefault).toBe(true);
    expect(defaults.find((row) => row.id === 'sphere-re-100-S-reg')?.isDefault).toBe(false);
    expect(defaults.find((row) => row.id === 'sensitivity-domain')?.isDefault).toBe(false);
  });

  it('resolves the default operator from the regime of each case', () => {
    expect(defaultOperator(false)).toBe('trt');
    expect(defaultOperator(true)).toBe('reg');
    for (const row of buildCases({ factors: ALL_FACTORS })) {
      if (!row.isDefault) continue;
      expect(row.operator, row.id).toBe(row.les ? 'reg' : 'trt');
    }
    const defaultOf = (group: string) =>
      buildCases({ factors: ALL_FACTORS }).filter((r) => r.group === group && r.isDefault);
    expect(new Set(defaultOf('laminar').map((r) => r.operator))).toEqual(new Set(['trt']));
    expect(new Set(defaultOf('shape-class').map((r) => r.operator))).toEqual(new Set(['reg']));
  });

  it('does not treat a fixed-geometry row as a default when a factor differs', () => {
    const row = buildCases({ factors: ALL_FACTORS }).find((candidate) => candidate.id === 'cube-S');
    if (!row) throw new Error('cube-S is missing from the case list.');
    expect(row.isDefault).toBe(true);
    expect(isDefaultRow({ ...row, operator: 'trt' })).toBe(false);
  });

  it('only offers storage the adapter can address', () => {
    expect(availableValidationFactors([]).storage).toEqual(['f32']);
    expect(availableValidationFactors(['shader-f16']).storage).toEqual(['f32', 'f16']);
  });

  it('records both blockages for the larger domain at the same cell size', () => {
    const rows = buildCases().filter((row) => row.group === 'sensitivity');
    expect(rows).toHaveLength(5);
    const domain = rows.find((row) => row.sensitivity === 'domain');
    const baseline = domain?.baselineBlockage ?? NaN;
    expect(domain?.blockage).toBeCloseTo(baseline / 2.25, 12);
    const body = rows.find((row) => row.sensitivity === 'body-length');
    expect(body?.bodyLengthCells).toBeCloseTo(0.3 * 256, 12);
    const speed = rows.find((row) => row.sensitivity === 'inlet-speed');
    expect(speed?.tier).toBe('M');
    expect(speed?.uLu).toBe(0.1);
    expect(rows.filter((row) => row.sensitivity === 'stilts')).toHaveLength(2);
  });
});

describe('run groups', () => {
  const groups = (...names: ValidationGroup[]) => new Set<ValidationGroup>(names);

  it('plans a two-flow-through tier-S smoke case with no reference to judge it by', () => {
    const [smoke] = planCases(groups('smoke'));
    expect(smoke?.id).toBe('smoke-ahmed-25-S');
    expect(smoke?.steps).toBe(2 * 2560);
    expect(smoke?.averageSteps).toBe(smoke?.steps);
    expect(smoke?.referenceCd).toBeNull();
    expect(smoke?.isDefault).toBe(false);
    expect(planCases(groups('smoke'), { tiers: ['L'] })).toEqual([]);
  });

  it('selects the rows of each CLI group and none for the groups without a browser case', () => {
    const idsOf = (name: ValidationGroup) => planCases(groups(name)).map((row) => row.group);
    expect(new Set(idsOf('shape-classes'))).toEqual(new Set(['shape-class']));
    expect(idsOf('shape-classes')).toHaveLength(6);
    expect(new Set(idsOf('validation'))).toEqual(new Set(['validation']));
    expect(new Set(idsOf('confinement'))).toEqual(new Set(['confinement']));
    expect(new Set(idsOf('laminar'))).toEqual(new Set(['laminar']));
    expect(idsOf('sensitivity')).toHaveLength(5);
    for (const name of ['verification', 'convergence', 'grid-check'] as const) {
      expect(planCases(groups(name))).toEqual([]);
    }
  });

  it('restricts the tiers inside the selected groups but not the confinement grid', () => {
    const ids = planCases(groups('validation', 'laminar'), { tiers: ['S'] }).map((row) => row.id);
    expect(ids.sort()).toEqual([
      'ahmed-25-S-reg-default',
      'sphere-re-100-S-reg',
      'sphere-re-100-S-trt',
    ]);
    expect(planCases(groups('confinement'), { tiers: ['S'] })).toHaveLength(4);
  });

  it('records the 35 degree body as skipped while it has no reference value', () => {
    expect(plannedSkips()).toEqual([
      {
        case: 'ahmed-35',
        group: 'validation',
        tier: 'L',
        reason: 'No reference value for the 35 degree body is recorded in docs/validation.md.',
      },
    ]);
    expect(plannedSkips(['S', 'M'])).toEqual([]);
    expect(buildCases().some((row) => row.case === 'ahmed-35')).toBe(false);
  });
});
