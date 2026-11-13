import { describe, expect, it } from 'vitest';
import {
  type BenchRow,
  budgetFailures,
  mergeRows,
  readBenchReport,
  readBenchRows,
  TIER_L_ROOFLINE_BUDGET_PCT,
} from '../../scripts/bench-report';
import type { BenchReport } from '../../src/app/bench-page';

const REPORT: BenchReport = {
  copyGBps: 102.4,
  perTier: {
    S: { mlups: 300, msPerStep: 1.75, rooflinePct: 45.7 },
    L: { mlups: 420, msPerStep: 10.8, rooflinePct: 64 },
  },
  adapter: { vendor: 'apple', architecture: 'metal-3', device: '', description: '' },
  features: ['shader-f16', 'timestamp-query'],
  userAgent: 'Mozilla/5.0 Chrome/156.0.0.0',
  timing: 'timestamp-query',
  steps: 500,
};

function row(engine: 'chromium' | 'webkit', patch: Partial<BenchReport> = {}): BenchRow {
  return {
    engine,
    browserVersion: '156.0',
    commit: 'abc1234',
    date: '2026-11-09T00:00:00.000Z',
    report: { ...REPORT, ...patch },
  };
}

describe('reading the page report', () => {
  it('accepts a complete report unchanged', () => {
    expect(readBenchReport(structuredClone(REPORT))).toEqual(REPORT);
  });

  it('keeps tiers the page skipped, with their reasons', () => {
    const skipped = { ...REPORT, skipped: { XL: 'The adapter limits buffers to 1 GiB.' } };
    expect(readBenchReport(skipped)).toEqual(skipped);
  });

  it('refuses a missing report', () => {
    expect(() => readBenchReport(undefined)).toThrow('The page published no benchmark report.');
    expect(() => readBenchReport([])).toThrow('The page published no benchmark report.');
  });

  it('refuses a copy bandwidth that is not a positive number', () => {
    for (const copyGBps of [0, -1, Number.NaN, '102']) {
      expect(() => readBenchReport({ ...REPORT, copyGBps })).toThrow('copyGBps');
    }
  });

  it('refuses a tier result with a missing or non-positive measurement', () => {
    expect(() =>
      readBenchReport({ ...REPORT, perTier: { S: { mlups: 300, msPerStep: 0, rooflinePct: 45 } } }),
    ).toThrow('perTier.S');
    expect(() => readBenchReport({ ...REPORT, perTier: { S: { mlups: 300 } } })).toThrow(
      'perTier.S',
    );
  });

  it('refuses a tier the solver does not have', () => {
    expect(() =>
      readBenchReport({
        ...REPORT,
        perTier: { Q: { mlups: 1, msPerStep: 1, rooflinePct: 1 } },
      }),
    ).toThrow('Unknown tier Q');
  });

  it('refuses a report without its adapter, user agent or timing method', () => {
    expect(() => readBenchReport({ ...REPORT, adapter: null })).toThrow('adapter');
    expect(() => readBenchReport({ ...REPORT, userAgent: 1 })).toThrow('userAgent');
    expect(() => readBenchReport({ ...REPORT, timing: 'clock' })).toThrow('timing');
    expect(() => readBenchReport({ ...REPORT, features: 'shader-f16' })).toThrow('features');
    expect(() => readBenchReport({ ...REPORT, steps: 0 })).toThrow('steps');
  });
});

describe('budget failures', () => {
  it('passes a tier L result at or above the roofline budget', () => {
    expect(TIER_L_ROOFLINE_BUDGET_PCT).toBe(60);
    expect(budgetFailures(REPORT)).toEqual([]);
  });

  it('names a tier L result under the budget', () => {
    const slow = { ...REPORT, perTier: { L: { mlups: 300, msPerStep: 15, rooflinePct: 46.2 } } };
    expect(budgetFailures(slow)).toEqual([
      'Tier L reached 46.2% of the copy roofline, under the 60% budget.',
    ]);
  });

  it('says so when tier L was not measured', () => {
    const smallOnly = { S: { mlups: 300, msPerStep: 1.75, rooflinePct: 45.7 } };
    expect(budgetFailures({ ...REPORT, perTier: smallOnly })).toEqual([
      'Tier L was not measured, so its budget could not be checked.',
    ]);
    expect(budgetFailures({ ...REPORT, perTier: {}, skipped: { L: 'Out of memory.' } })).toEqual([
      'Tier L was not measured: Out of memory.',
    ]);
  });

  it('flags any tier faster than the copy roofline as a timing fault', () => {
    const impossible = {
      ...REPORT,
      perTier: { ...REPORT.perTier, S: { mlups: 900, msPerStep: 0.5, rooflinePct: 137.1 } },
    };
    expect(budgetFailures(impossible)).toEqual([
      'Tier S reached 137.1% of the copy roofline, which no memory-bound step can; check the timing.',
    ]);
  });
});

describe('reading the results file', () => {
  it('reads back the rows it wrote', () => {
    const rows = [row('chromium'), row('webkit')];
    expect(readBenchRows(JSON.parse(JSON.stringify(rows)), 'results.json')).toEqual(rows);
  });

  it('refuses a file that is not a list', () => {
    expect(() => readBenchRows({}, 'results.json')).toThrow(
      'results.json is not a list of rows. Move it aside and run again.',
    );
  });

  it('names the malformed row', () => {
    expect(() =>
      readBenchRows([row('chromium'), { ...row('webkit'), engine: 'gecko' }], 'results.json'),
    ).toThrow('Row 1 of results.json is malformed.');
    expect(() =>
      readBenchRows([{ ...row('webkit'), report: { copyGBps: 1 } }], 'results.json'),
    ).toThrow('perTier');
  });
});

describe('merging rows', () => {
  it('replaces the row for the same engine and adapter and keeps the rest', () => {
    const otherAdapter = row('chromium', {
      adapter: { vendor: 'nvidia', architecture: 'ada', device: '', description: '' },
    });
    const merged = mergeRows(
      [row('chromium'), row('webkit'), otherAdapter],
      [{ ...row('chromium'), commit: 'def5678' }],
    );
    expect(
      merged.map((entry) => [entry.engine, entry.report.adapter.vendor, entry.commit]),
    ).toEqual([
      ['chromium', 'apple', 'def5678'],
      ['chromium', 'nvidia', 'abc1234'],
      ['webkit', 'apple', 'abc1234'],
    ]);
  });

  it('adds rows for a new adapter', () => {
    expect(mergeRows([], [row('webkit'), row('chromium')]).map((entry) => entry.engine)).toEqual([
      'chromium',
      'webkit',
    ]);
  });
});
