import { describe, expect, it } from 'vitest';
import { TABLE_SAMPLE_LIMIT, tableRows } from '../../../src/app/force-table';
import type { ForceHistoryPoint } from '../../../src/io/run-file';

function samples(count: number): ForceHistoryPoint[] {
  return Array.from({ length: count }, (_, index) => [index * 10, 0.1 + index * 0.01] as const);
}

describe('force table rows', () => {
  it('keeps the last twenty samples in run order', () => {
    const rows = tableRows(samples(25));
    expect(rows).toHaveLength(TABLE_SAMPLE_LIMIT);
    expect(rows[0]).toEqual({ step: '50', cd: '0.150' });
    expect(rows[19]).toEqual({ step: '240', cd: '0.340' });
  });

  it('keeps every row when the record is shorter than the limit', () => {
    const rows = tableRows([
      [0, 0.2],
      [10, 0.3],
      [20, 0.4],
    ]);
    expect(rows).toEqual([
      { step: '0', cd: '0.200' },
      { step: '10', cd: '0.300' },
      { step: '20', cd: '0.400' },
    ]);
  });

  it('keeps a full record unchanged', () => {
    expect(tableRows(samples(TABLE_SAMPLE_LIMIT))).toHaveLength(TABLE_SAMPLE_LIMIT);
  });

  it('rounds Cd to three decimals and leaves the step whole', () => {
    expect(tableRows([[40, 0.1234]])).toEqual([{ step: '40', cd: '0.123' }]);
  });

  it('returns no rows for an empty record', () => {
    expect(tableRows([])).toEqual([]);
  });
});
