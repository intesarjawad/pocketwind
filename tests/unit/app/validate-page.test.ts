import { describe, expect, it } from 'vitest';
import {
  ahmedCaption,
  bgkNote,
  blockageNote,
  convergenceText,
  humanDate,
  NOT_YET_RUN,
  poiseuilleRows,
  readResults,
  referenceBand,
  sensitivityRows,
  signed,
  taylorGreenOrder,
  taylorGreenRows,
  trustRows,
} from '../../../src/app/validate-page';

type Row = Parameters<typeof trustRows>[0][number];

function row(patch: Partial<Row>): Row {
  return {
    case: 'ahmed-25',
    group: 'validation',
    tier: 'L',
    cd: 0.3,
    errorPct: 5.68,
    pass: true,
    shapeClass: 'road-vehicle',
    isDefault: true,
    referenceCd: 0.285,
    ...patch,
  };
}

describe('where to trust it', () => {
  it('gives one row per shape class of the default rows, with the tier-L error', () => {
    const rows = trustRows(
      [
        row({ tier: 'M', errorPct: 9 }),
        row({}),
        row({ case: 'cube', group: 'shape-class', shapeClass: 'sharp-edged', errorPct: null }),
        row({ case: 'cube-flip', shapeClass: 'sharp-edged', isDefault: false, errorPct: 40 }),
      ],
      [{ shapeClass: 'road-vehicle', case: 'ahmed-25', outcome: 'GCI 2.1%' }],
    );
    expect(rows).toEqual([
      { shapeClass: 'road-vehicle', error: '5.7%', note: 'Tier M: 9.0%', gridCheck: 'GCI 2.1%' },
      {
        shapeClass: 'sharp-edged',
        error: 'No reference value',
        note: 'n/a',
        gridCheck: NOT_YET_RUN,
      },
    ]);
  });

  it('says a class has not run at tier L when only other tiers exist', () => {
    expect(trustRows([row({ tier: 'S' })], null)).toEqual([
      {
        shapeClass: 'road-vehicle',
        error: 'Not run',
        note: 'Tier S: 5.7%',
        gridCheck: NOT_YET_RUN,
      },
    ]);
    expect(trustRows([row({ tier: 'S', errorPct: null })], null)).toEqual([
      { shapeClass: 'road-vehicle', error: NOT_YET_RUN, note: 'n/a', gridCheck: NOT_YET_RUN },
    ]);
  });

  it('is empty without default rows', () => {
    expect(trustRows([row({ isDefault: false })], null)).toEqual([]);
  });
});

describe('reference bands', () => {
  it('spans ten percent either side of the reference', () => {
    expect(referenceBand([row({ referenceCd: 1 })])).toBe(
      'Reference Cd 1.000. A row whose drag falls within ±10% (0.9000 to 1.1000) passes.',
    );
  });

  it('says so when no row has a reference', () => {
    expect(referenceBand([row({ referenceCd: null })])).toBe(
      'No reference value; these rows record raw drag only.',
    );
  });
});

describe('convergence text', () => {
  it('describes each outcome', () => {
    expect(convergenceText(null)).toBe(NOT_YET_RUN);
    expect(convergenceText({ kind: 'oscillatory' })).toBe('Not estimated: oscillatory.');
    expect(
      convergenceText({ kind: 'monotone', order: 1.5, extrapolated: 0.25, gciFinePct: 3 }),
    ).toBe('Monotone, observed order 1.500, extrapolated Cd 0.2500, fine-grid GCI 3.00%.');
  });
});

describe('results file', () => {
  const stamp = { commit: 'abc1234', date: '2026-11-06T00:00:00.000Z' };

  it('rejects anything without a generation stamp', () => {
    expect(readResults(null)).toBeNull();
    expect(readResults({ laminar: [] })).toBeNull();
    expect(readResults({ generatedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234' })).toBeNull();
  });

  it('treats absent or malformed sections as not yet run', () => {
    expect(
      readResults({
        ...stamp,
        validation: [{ case: 'broken' }],
        verification: [{ label: 'broken' }],
        convergence: [{ case: 'ahmed-25' }],
        gridCheck: [{ case: 'sphere', kind: 'maybe' }],
        crossDevice: [{ case: 'cube' }],
      }),
    ).toEqual({
      ...stamp,
      cases: [],
      verification: [],
      convergence: null,
      gridCheck: [],
      crossDevice: [],
    });
  });

  it('gathers rows from every case section and keys grid checks by shape class', () => {
    const base = {
      group: 'validation',
      tier: 'L',
      shapeClass: 'road-vehicle',
      cd: 0.3,
      pass: true,
      isDefault: true,
      errorPct: null,
      referenceCd: null,
    };
    const results = readResults({
      ...stamp,
      laminar: [{ ...base, case: 'sphere-re-100', group: 'laminar' }],
      validation: [{ ...base, case: 'ahmed-25' }],
      confinement: [{ ...base, case: 'cube-confinement', group: 'confinement' }],
      sensitivity: [{ ...base, case: 'ahmed-25', group: 'sensitivity' }],
      convergence: [
        { case: 'sphere-re-100', kind: 'oscillatory' },
        { case: 'ahmed-25', kind: 'monotone', order: 2, extrapolated: 0.25, gciFinePct: 1.5 },
      ],
      gridCheck: [
        { case: 'ahmed-25', kind: 'band', gciPct: 2.14, extrapolatedCd: 0.29, ...stamp },
        { case: 'sphere', kind: 'no-band', reason: 'drag crisis', ...stamp },
        { case: 'unlisted', kind: 'no-band', ...stamp },
      ],
      crossDevice: [
        {
          case: 'cube',
          cd: 1.05,
          adapter: { vendor: 'nvidia', architecture: 'ada' },
          ...stamp,
        },
      ],
    });
    expect(results?.cases.map((row) => `${row.group}:${row.case}`)).toEqual([
      'laminar:sphere-re-100',
      'validation:ahmed-25',
      'confinement:cube-confinement',
      'sensitivity:ahmed-25',
    ]);
    expect(results?.convergence).toMatchObject({ kind: 'monotone', order: 2 });
    expect(results?.gridCheck).toEqual([
      {
        shapeClass: 'road-vehicle',
        case: 'ahmed-25',
        outcome: 'GCI 2.1%, extrapolated Cd 0.2900',
      },
      { shapeClass: 'smooth-subcritical', case: 'sphere', outcome: 'No band: drag crisis' },
      { shapeClass: 'unlisted', case: 'unlisted', outcome: 'No band: no reason given' },
    ]);
    expect(results?.crossDevice).toEqual([
      { adapter: 'nvidia ada', case: 'cube', cd: 1.05, ...stamp },
    ]);
  });
});

describe('verification rows', () => {
  const row = {
    group: 'verification' as const,
    observedOrder: null,
    decayRelativeError: null,
    profileErrorPct: null,
    forceError: null,
    tau0: null,
    pass: true,
    commit: 'abc1234',
    date: '2026-11-06T00:00:00.000Z',
    error: null,
    errorPct: null,
  };
  const taylorGreen = (n: number, steps: number, error: number) => ({
    ...row,
    case: `taylor-green-${n}`,
    kind: 'taylor-green' as const,
    label: `Taylor-Green ${n}`,
    steps,
    error,
  });
  const rows = [
    taylorGreen(16, 50, 0.0023950162),
    taylorGreen(32, 200, 0.0005953),
    taylorGreen(64, 800, 0.0001487),
    {
      ...row,
      case: 'poiseuille-tau0-0.6',
      kind: 'poiseuille' as const,
      label: 'Poiseuille tau0 0.6',
      steps: 12777,
      errorPct: -0.3385,
    },
  ];

  it('gives each check its own error in percent, signed where the sign matters', () => {
    expect(taylorGreenRows(rows)).toEqual([
      ['Taylor-Green 16', '50', '0.240%'],
      ['Taylor-Green 32', '200', '0.0595%'],
      ['Taylor-Green 64', '800', '0.0149%'],
    ]);
    expect(poiseuilleRows(rows)).toEqual([['Poiseuille tau0 0.6', '12777', '\u22120.34%']]);
  });

  it('works out the observed order from the saved errors', () => {
    expect(taylorGreenOrder(rows)).toBe(
      'Each halving of the grid spacing divides the amplitude error by 4.02 and then 4.00: an observed order of 2.01 and then 2.00, which is the second-order accuracy the scheme is built for.',
    );
    expect(taylorGreenOrder([taylorGreen(16, 50, 0.01), taylorGreen(32, 200, 0.005)])).toContain(
      'an observed order of 1.00, short of the second order',
    );
    expect(taylorGreenOrder(rows.slice(3))).toBeNull();
  });

  it('writes a sign only on a value that is not zero, with a true minus', () => {
    expect(signed(-1.25, 1, '%')).toBe('\u22121.3%');
    expect(signed(0.001, 1)).toBe('0.0');
    expect(signed(2, 0)).toBe('+2');
  });
});

describe('Ahmed figure caption', () => {
  it('reads the Reynolds number, cell sizes and the ratio to the measurement from the rows', () => {
    const caption = ahmedCaption([
      row({ cd: 0.79053, re: 2_784_000, cellSizeM: 0.00815625 }),
      row({ cd: 0.7301, re: 2_784_000, cellSizeM: 0.0054375 }),
    ]);
    expect(caption).toContain('Ahmed body, 25° slant at Re 2.8 million');
    expect(caption).toContain('from 0.791 to 0.730 as the cells shrink from 8.2 to 5.4 mm');
    expect(caption).toContain('2.6 times the measurement');
  });

  it('leaves out what the rows do not record', () => {
    expect(ahmedCaption([row({ cd: 0.79 })])).not.toContain('cells');
    expect(ahmedCaption([])).toBe('');
  });
});

describe('BGK note', () => {
  const bgk = {
    case: 'poiseuille-bgk-tau0-3',
    group: 'verification' as const,
    kind: 'poiseuille-bgk' as const,
    label: 'Poiseuille tau0 3 (BGK)',
    steps: 673,
    error: null,
    observedOrder: null,
    decayRelativeError: null,
    errorPct: 13.54,
    profileErrorPct: 12.63,
    forceError: null,
    tau0: 3,
    pass: true,
    commit: 'abc1234',
    date: '2026-11-06T00:00:00.000Z',
  };

  it('explains the expected offset with the row numbers', () => {
    const note = bgkNote([bgk]);
    expect(note).toContain('tau0 3');
    expect(note).toContain('13.5% off the parabola');
    expect(note).toContain('duly comes out');
    expect(note).not.toContain('meant to miss');
  });

  it('says so when the offset is missing, and stays silent without the row', () => {
    expect(bgkNote([{ ...bgk, pass: false }])).toContain('this check is failing');
    expect(bgkNote([])).toBeNull();
  });
});

describe('sensitivity and blockage', () => {
  const base = row({ cd: 0.79, bodyLengthCells: 128, blockage: 0.1 });
  const wide = row({
    id: 'sensitivity-domain',
    group: 'sensitivity',
    tier: 'XL',
    cd: 0.648,
    isDefault: false,
    errorPct: null,
    sensitivity: 'domain',
    bodyLengthCells: 128,
    blockage: 0.045,
  });

  it('does not substitute a different-tier baseline for a sensitivity row', () => {
    expect(sensitivityRows([base, wide])).toEqual([
      ['Larger domain, 4.5% blockage', 'XL', '0.6480', 'n/a'],
    ]);
  });

  it('compares the review inlet row against tier M, not tier L', () => {
    const m = row({ tier: 'M', cd: 0.8104422716233239 });
    const inlet = row({
      group: 'sensitivity',
      tier: 'M',
      cd: 0.7508552637509999,
      isDefault: false,
      sensitivity: 'inlet-speed',
      uLu: 0.1,
    });
    expect(sensitivityRows([base, m, inlet])[0]?.[3]).toBe('−7.35%');
  });

  it('labels a sensitivity row that reproduces the default', () => {
    const same = row({
      id: 'sensitivity-stilts-excluded',
      group: 'sensitivity',
      cd: 0.79,
      isDefault: false,
      sensitivity: 'stilts',
      stilts: false,
    });
    expect(sensitivityRows([base, same])[0]?.[0]).toBe('Stilts left out of the drag (default)');
  });

  it('states the blockage effect from the domain row', () => {
    expect(blockageNote([base, wide])).toBe(
      'Blockage matters here. The same 128-cell body in a larger domain, filling 4.5% of the section instead of 10.0%, reads 0.648 against 0.790: 18% lower. The confinement of these grids and their near inlet add about that much drag.',
    );
    expect(blockageNote([base])).toBeNull();
  });
});

describe('human date', () => {
  it('writes the UTC date and time, and keeps an unreadable value as it is', () => {
    expect(humanDate('2026-11-11T15:02:40.054Z')).toBe('11 November 2026, 15:02 UTC');
    expect(humanDate('soon')).toBe('soon');
  });
});
