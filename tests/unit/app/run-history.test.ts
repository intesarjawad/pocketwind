import { describe, expect, it } from 'vitest';
import { thinHistory } from '../../../src/app/run';
import type { ForceHistoryPoint } from '../../../src/io/run-file';

describe('force record thinning', () => {
  it('keeps the first sample and the newest half at full rate past the limit', () => {
    const history: ForceHistoryPoint[] = Array.from({ length: 9 }, (_, index) => [
      8 * (index + 1),
      1,
    ]);
    thinHistory(history, 8);
    expect(history.map(([step]) => step)).toEqual([8, 24, 40, 48, 56, 64, 72]);
    thinHistory(history, 8);
    expect(history).toHaveLength(7);
  });
});
