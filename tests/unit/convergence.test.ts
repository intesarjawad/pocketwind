import { describe, expect, it } from 'vitest';
import { gridConvergence } from '../../src/forces/convergence';

const quadratic = (h: number) => 1 + 0.5 * h ** 2;

function monotone(rows: { h: number; value: number }[]) {
  const result = gridConvergence(rows);
  if (result.kind !== 'monotone') throw new Error(`Expected monotone, got ${result.kind}`);
  return result;
}

describe('grid convergence', () => {
  it('recovers order two and the exact limit from four refined grids', () => {
    const rows = [1 / 384, 1 / 128, 1 / 256, 1 / 192].map((h) => ({ h, value: quadratic(h) }));
    const result = monotone(rows);
    expect(Math.abs(result.order - 2)).toBeLessThan(0.01);
    expect(Math.abs(result.extrapolated - 1)).toBeLessThan(1e-6);
  });

  it('applies the safety factor to the fine-grid index', () => {
    const result = monotone([
      { h: 1, value: 1.5 },
      { h: 2, value: 3 },
      { h: 4, value: 9 },
    ]);
    expect(result.order).toBeCloseTo(2, 9);
    expect(result.extrapolated).toBeCloseTo(1, 9);
    expect(result.gciFinePct).toBeCloseTo(125 / 3, 10);
  });

  it('handles refinement ratios that are not constant', () => {
    const result = monotone([
      { h: 1, value: 1.5 },
      { h: 2, value: 3 },
      { h: 6, value: 19 },
    ]);
    expect(Math.abs(result.order - 2)).toBeLessThan(1e-8);
    expect(Math.abs(result.extrapolated - 1)).toBeLessThan(1e-8);
  });

  it('ignores levels coarser than the three finest', () => {
    const result = monotone([
      { h: 1 / 8, value: quadratic(1 / 8) },
      { h: 1 / 4, value: quadratic(1 / 4) },
      { h: 1 / 2, value: quadratic(1 / 2) },
      { h: 1, value: 42 },
    ]);
    expect(result.order).toBeCloseTo(2, 9);
    expect(result.extrapolated).toBeCloseTo(1, 9);
  });

  it('reports alternating values as oscillatory', () => {
    expect(
      gridConvergence([
        { h: 1, value: 1 },
        { h: 2, value: 2 },
        { h: 3, value: 1 },
      ]),
    ).toEqual({ kind: 'oscillatory' });
  });

  it('reports differences that grow toward the fine grid as divergent', () => {
    expect(
      gridConvergence([
        { h: 1, value: 1 },
        { h: 2, value: 3 },
        { h: 3, value: 4 },
      ]),
    ).toEqual({ kind: 'divergent' });
  });

  it('needs three levels', () => {
    expect(
      gridConvergence([
        { h: 1, value: 1.5 },
        { h: 2, value: 3 },
      ]),
    ).toEqual({ kind: 'insufficient' });
  });

  it('rejects levels that do not change between refinements', () => {
    expect(
      gridConvergence([
        { h: 1, value: 1 },
        { h: 2, value: 1 },
        { h: 4, value: 2 },
      ]),
    ).toEqual({ kind: 'insufficient' });
  });
});
