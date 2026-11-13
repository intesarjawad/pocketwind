import { describe, expect, it } from 'vitest';
import { buildCases, type CaseSpec } from '../../../src/validation/cases';
import type { AdapterInfo, CaseSolver, SolverRun } from '../../../src/validation/runner';
import { readSolverRun, rowFromRun, runCases } from '../../../src/validation/runner';

const ADAPTER: AdapterInfo = {
  vendor: 'test',
  architecture: 'cpu',
  device: 'stub',
  description: 'stub adapter',
  features: [],
};

const CONTEXT = {
  commit: 'abc1234',
  date: '2026-11-06T00:00:00.000Z',
  adapter: ADAPTER,
  userAgent: 'test-agent',
};

function shortSpec(patch: Partial<CaseSpec> = {}): CaseSpec {
  const base = buildCases({ tiers: ['S'] }).find(
    (row) => row.group === 'validation' && row.tier === 'S',
  );
  if (!base) throw new Error('The S validation row is missing.');
  return {
    ...base,
    steps: 12,
    flowThroughSteps: 2,
    averageSteps: 4,
    referenceCd: 0.025,
    ...patch,
  };
}

const RUN: SolverRun = {
  steps: 12,
  msPerStep: 2.5,
  forces: [
    { step: 8, fx: 1, fy: 1, fz: 0.25 },
    { step: 10, fx: 2, fy: 0.5, fz: 0.25 },
    { step: 12, fx: 3, fy: -0.5, fz: 0.25 },
  ],
};

describe('validation runner', () => {
  it('averages the last two flow-throughs and converts the mean force', () => {
    const spec = shortSpec();
    const row = rowFromRun(spec, RUN, CONTEXT);
    const expectedCd = 2.5 / (0.5 * 1.204 * 40 * 40 * 0.112);
    const expectedVoxel = 2.5 / (0.5 * 1.204 * 40 * 40 * spec.voxelAreaM2);
    expect(row.cd).toBeCloseTo(expectedCd, 12);
    expect(row.cdVoxel).toBeCloseTo(expectedVoxel, 12);
    expect(row.errorPct).toBeCloseTo((100 * (expectedCd - 0.025)) / 0.025, 12);
    expect(row.fx).toBe(2.5);
    expect(row.fy).toBe(0);
    expect(row.fz).toBe(0.25);
    expect(row.steps).toBe(12);
    expect(row.msPerStep).toBe(2.5);
  });

  it('reports the fluctuation and drift of the force record', () => {
    const row = rowFromRun(shortSpec({ flowThroughSteps: 6 }), RUN, CONTEXT);
    // Sample standard deviation of 1, 2, 3 is 1 around a mean of 2.
    expect(row.relStdPct).toBeCloseTo(50, 12);
    // The first half is 1 and the second half is the mean of 2 and 3.
    expect(row.driftPct).toBeCloseTo(75, 12);
    expect(row.forceHistory).toEqual([[8, 1, 1, 0.25]]);
  });

  it('passes a reference comparison inside the tolerance and fails outside it', () => {
    const passed = rowFromRun(shortSpec(), RUN, CONTEXT);
    expect(passed.pass).toBe(true);
    const failed = rowFromRun(shortSpec({ referenceCd: 0.02 }), RUN, CONTEXT);
    expect(failed.pass).toBe(false);
    expect(failed.reasons.join(' ')).toMatch(/exceeds 10%/);
  });

  it('records raw drag and the Maskell bound for cube and sphere rows', () => {
    const cube = buildCases({ tiers: ['S'] }).find((row) => row.id === 'cube-S');
    if (!cube) throw new Error('cube-S is missing.');
    const spec: CaseSpec = {
      ...cube,
      steps: 12,
      flowThroughSteps: 2,
      averageSteps: 4,
    };
    const row = rowFromRun(spec, RUN, CONTEXT);
    const expectedRaw = 2.5 / (0.5 * 1.204 * 1600 * spec.voxelAreaM2);
    expect(row.cdRaw).toBeCloseTo(expectedRaw, 12);
    expect(row.cdMaskell).toBeCloseTo(expectedRaw / (1 + 2.5 * expectedRaw * 0.04), 12);
    expect(row.cdMaskell).toBeLessThan(row.cdRaw ?? Infinity);
  });

  it('rejects a short run, a missing averaging window and non-finite forces', () => {
    expect(() => rowFromRun(shortSpec(), { ...RUN, steps: 11 }, CONTEXT)).toThrow(/at least 12/);
    expect(() =>
      rowFromRun(shortSpec(), { ...RUN, forces: RUN.forces.slice(0, 1) }, CONTEXT),
    ).toThrow(/averaging window/);
    expect(() =>
      rowFromRun(
        shortSpec(),
        { ...RUN, forces: [{ step: 12, fx: Number.NaN, fy: 0, fz: 0 }] },
        CONTEXT,
      ),
    ).toThrow(/non-finite/);
  });

  it('drives every case through the solver in list order', async () => {
    const cases = buildCases({ tiers: ['S'] }).filter((row) => row.group === 'validation');
    const seen: string[] = [];
    const solver: CaseSolver = {
      async run(spec) {
        seen.push(spec.id);
        const forces = Array.from({ length: Math.floor(spec.steps / 8) + 1 }, (_, index) => ({
          step: index * 8,
          fx: 10,
          fy: 0,
          fz: 0,
        }));
        return { steps: spec.steps, msPerStep: 1, forces };
      },
    };
    const rows = await runCases(solver, cases, CONTEXT);
    expect(seen).toEqual(cases.map((spec) => spec.id));
    expect(rows).toHaveLength(cases.length);
    expect(rows[0]?.commit).toBe('abc1234');
  });
});

describe('page result record', () => {
  const record = {
    steps: 12,
    msPerStep: 2.5,
    forces: [{ step: 8, fx: 1, fy: 0, fz: -1 }],
  };

  it('reads the required fields and the optional measurements', () => {
    expect(readSolverRun(record)).toEqual(record);
    const full = {
      ...record,
      voxelAreaM2: 0.11,
      blockage: 0.1,
      userAgent: 'agent',
      adapter: { ...ADAPTER, features: ['shader-f16'] },
    };
    expect(readSolverRun(full)).toEqual(full);
  });

  it.each([
    ['nothing', null],
    ['no forces', { steps: 12, msPerStep: 2.5 }],
    ['a missing step time', { ...record, msPerStep: undefined }],
    ['a non-finite force', { ...record, forces: [{ step: 8, fx: Number.NaN, fy: 0, fz: 0 }] }],
    ['a string step', { ...record, forces: [{ step: '8', fx: 1, fy: 0, fz: 0 }] }],
    ['a bad voxel area', { ...record, voxelAreaM2: 'big' }],
    ['a bad blockage', { ...record, blockage: Number.POSITIVE_INFINITY }],
    ['a malformed adapter', { ...record, adapter: { vendor: 'x' } }],
  ])('rejects %s', (_name, value) => {
    expect(() => readSolverRun(value)).toThrow(RangeError);
  });
  it('passes on the reason a page gave for a run it could not finish', () => {
    expect(() => readSolverRun({ error: 'The force was not finite at step 872 of 5120.' })).toThrow(
      'The force was not finite at step 872 of 5120.',
    );
  });
});
