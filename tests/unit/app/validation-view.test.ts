import { describe, expect, it } from 'vitest';
import { validationRows, validationSummary } from '../../../src/app/validation-view';
import type { ValidationResults } from '../../../src/validation/results';
import type { AdapterInfo, ValidationRow } from '../../../src/validation/runner';
import type { VerificationRow } from '../../../src/validation/verification';

const ADAPTER: AdapterInfo = {
  vendor: 'test',
  architecture: 'cpu',
  device: 'stub',
  description: 'stub adapter',
  features: [],
};

function row(patch: Partial<ValidationRow>): ValidationRow {
  return {
    case: 'ahmed-25',
    id: 'ahmed-25-L-trt-default',
    group: 'validation',
    label: 'Ahmed body at 25 degrees',
    tier: 'L',
    grid: { nx: 256, ny: 128, nz: 128 },
    cells: 4194304,
    operator: 'trt',
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
    cd: 0.30124,
    cdVoxel: 0.3008,
    cdRaw: null,
    cdMaskell: null,
    referenceCd: 0.285,
    errorPct: 5.68,
    fx: 32.5,
    fy: 0,
    fz: 0,
    relStdPct: 0.8,
    driftPct: 0.4,
    forceHistory: [],
    adapter: ADAPTER,
    userAgent: 'test-agent',
    commit: 'abc1234',
    date: '2026-11-06T00:00:00.000Z',
    isDefault: true,
    pass: true,
    reasons: [],
    ...patch,
  };
}

describe('validation route view', () => {
  it('formats table cells with four decimals and a signed reference error', () => {
    expect(
      validationRows([
        {
          case: 'ahmed-25',
          tier: 'L',
          group: 'validation',
          cd: 0.30124,
          errorPct: 5.68,
          pass: true,
        },
        {
          case: 'sphere',
          tier: 'S',
          group: 'shape-class',
          cd: 0.4,
          errorPct: null,
          pass: false,
        },
      ]),
    ).toEqual([
      {
        case: 'ahmed-25',
        tier: 'L',
        group: 'validation',
        cd: '0.3012',
        error: '5.7%',
        result: 'Pass',
      },
      {
        case: 'sphere',
        tier: 'S',
        group: 'shape-class',
        cd: '0.4000',
        error: 'n/a',
        result: 'Fail',
      },
    ]);
  });

  it('summarises the pass count and the generated revision', () => {
    const results: ValidationResults = {
      schemaVersion: 1,
      commit: 'abc1234',
      date: '2026-11-06T00:00:00.000Z',
      machine: {
        adapter: { vendor: 'test', architecture: 'cpu', device: 'stub', description: 'stub' },
        features: [],
        limits: {},
        userAgent: 'test-agent',
      },
      factors: { operator: ['trt'], walls: ['bb'], storage: ['f32'] },
      verification: [{ pass: true } as VerificationRow],
      laminar: [row({ id: 'laminar', group: 'laminar', pass: false })],
      validation: [row({})],
      confinement: [],
      convergence: [],
      sensitivity: [],
      gridCheck: [],
      crossDevice: [],
      skipped: [],
    };
    expect(validationSummary(results)).toBe(
      '1 of 2 cases passed. Analytic verification passed. Generated 2026-11-06T00:00:00.000Z at commit abc1234.',
    );
    expect(validationSummary({ ...results, verification: [] })).toContain(
      'Analytic verification failed or absent.',
    );
  });
});
