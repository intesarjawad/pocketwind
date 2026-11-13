import { describe, expect, it } from 'vitest';
import {
  renderValidationMarkdown,
  replaceMarkedBlock,
  validationJson,
} from '../../../src/validation/report';
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

const ROW: ValidationRow = {
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
  cd: 0.3012,
  cdVoxel: 0.3008,
  cdRaw: null,
  cdMaskell: null,
  referenceCd: 0.285,
  errorPct: 5.68,
  fx: 32.5,
  fy: 0.01,
  fz: -0.02,
  relStdPct: 0.8,
  driftPct: 0.4,
  forceHistory: [
    [0, 31, 0, 0],
    [8, 32, 0, 0],
  ],
  adapter: ADAPTER,
  userAgent: 'test-agent',
  commit: 'abc1234',
  date: '2026-11-06T00:00:00.000Z',
  isDefault: true,
  pass: true,
  reasons: [],
};

const STAMP = { commit: 'abc1234', date: '2026-11-06T00:00:00.000Z' };

function verificationRow(patch: Partial<VerificationRow>): VerificationRow {
  return {
    case: 'taylor-green-32',
    group: 'verification',
    kind: 'taylor-green',
    label: 'Taylor-Green 32',
    steps: 200,
    error: 0.0005,
    observedOrder: 2.01,
    decayRelativeError: 0.0002,
    errorPct: null,
    profileErrorPct: null,
    forceError: null,
    tau0: null,
    pass: true,
    ...STAMP,
    ...patch,
  };
}

function results(patch: Partial<ValidationResults> = {}): ValidationResults {
  return {
    schemaVersion: 1,
    ...STAMP,
    machine: {
      adapter: { vendor: 'test', architecture: 'cpu', device: 'stub', description: 'stub adapter' },
      features: [],
      limits: {},
      userAgent: 'test-agent',
    },
    factors: { operator: ['trt'], walls: ['bb'], storage: ['f32'] },
    verification: [],
    laminar: [],
    validation: [ROW],
    confinement: [],
    convergence: [],
    sensitivity: [],
    gridCheck: [],
    crossDevice: [],
    skipped: [],
    ...patch,
  };
}

describe('validation report', () => {
  it('replaces only the marked block and rejects missing markers', () => {
    const document = 'Before\n<!-- validation:start -->\nOld\n<!-- validation:end -->\nAfter\n';
    const updated = replaceMarkedBlock(document, 'New table');
    expect(updated).toBe(
      'Before\n<!-- validation:start -->\nNew table\n<!-- validation:end -->\nAfter\n',
    );
    expect(() => replaceMarkedBlock('No markers', 'New')).toThrow('markers');
    expect(() =>
      replaceMarkedBlock('<!-- validation:end --><!-- validation:start -->', 'New'),
    ).toThrow('markers');
  });

  it('names every commit of a merged file instead of the word mixed', () => {
    const markdown = renderValidationMarkdown(
      results({ commit: 'mixed', verification: [verificationRow({ commit: 'def5678' })] }),
    );
    expect(markdown).toContain('at commits abc1234 and def5678.');
    expect(renderValidationMarkdown(results())).toContain('at commit abc1234.');
  });

  it('renders the case row and the skip count into Markdown', () => {
    const markdown = renderValidationMarkdown(
      results({
        skipped: [{ case: 'ahmed-35', group: 'validation', tier: 'L', reason: 'No value.' }],
      }),
    );
    expect(markdown).toContain('Cases: 1 run: 1 pass, 0 fail; 1 skipped.');
    expect(markdown).toContain(
      '| ahmed-25 | validation | L | 256×128×128 | 4194304 | trt | bb | f32 | default |',
    );
    expect(markdown).toContain('| 0.3012 |');
    expect(markdown).toContain('| 5.7 |');
    expect(markdown).toContain('| yes | pass |');
    expect(markdown).toContain('No analytic verification was run.');
    expect(markdown).toContain('- ahmed-35 at L: No value.');
  });

  it('renders a failing row with its reasons', () => {
    const markdown = renderValidationMarkdown(
      results({ validation: [{ ...ROW, pass: false, reasons: ['Cd is not finite'] }] }),
    );
    expect(markdown).toContain('fail: Cd is not finite');
    expect(markdown).toContain('Cases: 1 run: 0 pass, 1 fail');
  });

  it('renders verification rows, convergence rows and grid checks', () => {
    const markdown = renderValidationMarkdown(
      results({
        verification: [
          verificationRow({
            case: 'taylor-green-16',
            label: 'Taylor-Green 16',
            observedOrder: null,
            decayRelativeError: null,
          }),
          verificationRow({}),
          verificationRow({
            case: 'poiseuille-bgk-tau0-3',
            kind: 'poiseuille-bgk',
            label: 'Poiseuille tau0 3 (BGK)',
            steps: 673,
            error: null,
            observedOrder: null,
            decayRelativeError: null,
            errorPct: 13.5,
          }),
        ],
        convergence: [
          {
            kind: 'monotone',
            order: 2,
            extrapolated: 0.25,
            gciFinePct: 1.5,
            case: 'ahmed-25',
            group: 'convergence',
            operator: 'trt',
            tiers: ['M', 'L', 'XL'],
            ...STAMP,
          },
          {
            kind: 'oscillatory',
            case: 'sphere-re-100',
            group: 'convergence',
            operator: 'trt',
            tiers: ['S', 'M', 'L'],
            ...STAMP,
          },
        ],
        gridCheck: [
          { case: 'cube', kind: 'band', gciPct: 3.25, extrapolatedCd: 1.05, ...STAMP },
          { case: 'sphere', kind: 'no-band', reason: 'drag crisis', ...STAMP },
        ],
      }),
    );
    expect(markdown).toContain('Taylor-Green observed order: 2.010; decay error 0.02%.');
    expect(markdown).toContain('| Taylor-Green 32 | 200 | 5.000e-4 | pass |');
    expect(markdown).toContain('| Poiseuille tau0 3 (BGK) | 673 | 13.50% | expected offset |');
    expect(markdown).toContain(
      '- ahmed-25, trt, tiers M, L, XL: monotone, observed order 2.000, extrapolated Cd 0.2500, fine-grid GCI 1.50%.',
    );
    expect(markdown).toContain('- sphere-re-100, trt, tiers S, M, L: not estimated, oscillatory.');
    expect(markdown).toContain('| cube | n/a | band | 3.25 | 1.0500 | n/a |');
    expect(markdown).toContain('| sphere | n/a | no-band | n/a | n/a | drag crisis |');
  });

  it('writes JSON with a trailing newline', () => {
    const json = validationJson(results());
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json).date).toBe('2026-11-06T00:00:00.000Z');
  });

  it('leaves the per-run force history out of the published file', () => {
    expect(validationJson(results())).not.toContain('forceHistory');
  });
});
