import { describe, expect, it } from 'vitest';
import {
  INSET_PX,
  labelForHistory,
  logTicks,
  niceTicks,
  PLOT_BOX,
  plotBox,
  plotHeight,
  plotRanges,
  polyline,
  stepRange,
  windowShade,
  windowStepsFor,
  xForStep,
  yForCd,
} from '../../../src/app/force-plot';

const BOX = { x: 0, y: 0, width: 100, height: 50 };

describe('force plot scales', () => {
  it('falls back to a unit range without points', () => {
    expect(plotRanges([]).cd).toEqual({ minCd: 0, maxCd: 1 });
  });

  it('includes the comparison record in the Cd range', () => {
    expect(plotRanges([[10, 0.2]], [[10, 0.8]]).cd.maxCd).toBeCloseTo(1, 12);
  });

  it('spans both records from the first step after the start, and widens a single sample', () => {
    expect(stepRange([])).toEqual({ minStep: 0, maxStep: 1 });
    expect(stepRange([[12, 0.3]])).toEqual({ minStep: 12, maxStep: 13 });
    expect(
      stepRange(
        [
          [0, 0.3],
          [400, 0.3],
        ],
        [
          [200, 0.4],
          [600, 0.4],
        ],
      ),
    ).toEqual({ minStep: 200, maxStep: 600 });
  });

  it('maps steps left to right on a log scale and Cd top down', () => {
    expect(xForStep(100, { minStep: 10, maxStep: 1000 }, BOX)).toBeCloseTo(50, 9);
    expect(xForStep(0, { minStep: 10, maxStep: 1000 }, BOX)).toBe(0);
    expect(yForCd(1, { minCd: 0, maxCd: 1 }, BOX)).toBe(0);
    expect(yForCd(0.25, { minCd: 0, maxCd: 1 }, BOX)).toBe(37.5);
    expect(yForCd(0, { minCd: 0, maxCd: 1 }, BOX)).toBe(50);
  });

  it('draws a polyline through every sample', () => {
    expect(
      polyline(
        [
          [10, 0],
          [1000, 1],
        ],
        { steps: { minStep: 10, maxStep: 1000 }, cd: { minCd: 0, maxCd: 1 } },
        BOX,
      ),
    ).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 0 },
    ]);
  });
});

describe('force plot window', () => {
  const range = { minStep: 10, maxStep: 1000 };
  it('shades the last flow-through of the record', () => {
    expect(windowStepsFor(100)).toBe(100);
    const shade = windowShade(1000, 900, range, BOX);
    expect(shade.x).toBeCloseTo(50, 9);
    expect(shade.width).toBeCloseTo(50, 9);
  });

  it('clips the window to the plotted range', () => {
    expect(windowShade(100, 400, range, BOX)).toEqual({ x: 0, width: 50 });
    const late = windowShade(10_000, 9_900, range, BOX);
    expect(late.x).toBeCloseTo(50, 9);
    expect(late.width).toBeCloseTo(50, 9);
  });

  it('draws no shading without a window or record', () => {
    expect(windowShade(100, 0, range, BOX)).toEqual({ x: 50, width: 0 });
    expect(windowShade(0, 400, range, BOX)).toEqual({ x: 0, width: 0 });
  });
});

describe('force plot inset', () => {
  it('widens a sliver of an averaged span to a linear inset at the right', () => {
    const box = { x: 0, y: 0, width: 400, height: 50 };
    const range = { minStep: 10, maxStep: 100_000, inset: 90_000 };
    expect(xForStep(90_000, range, box)).toBeCloseTo(400 - INSET_PX, 9);
    expect(xForStep(95_000, range, box)).toBeCloseTo(400 - INSET_PX / 2, 9);
    expect(xForStep(100_000, range, box)).toBeCloseTo(400, 9);
    expect(xForStep(10, range, box)).toBe(0);
  });

  it('keeps the log scale when the span is already wide enough', () => {
    const box = { x: 0, y: 0, width: 400, height: 50 };
    expect(xForStep(100, { minStep: 10, maxStep: 1000, inset: 100 }, box)).toBeCloseTo(200, 9);
  });

  it('sets the inset at the start of the window', () => {
    const history: [number, number][] = [
      [10, 1],
      [100_000, 1],
    ];
    expect(plotRanges(history, [], undefined, 10_000).steps.inset).toBe(90_000);
    expect(plotRanges(history).steps.inset).toBeUndefined();
  });
});

describe('force plot scale', () => {
  it('puts log ticks at 1, 2 and 5 times each power of ten, or the powers alone when crowded', () => {
    expect(logTicks(0.03, 12)).toEqual([0.1, 1, 10]);
    expect(logTicks(0.3, 6)).toEqual([0.5, 1, 2, 5]);
    expect(logTicks(1, 1)).toEqual([]);
  });

  it('steps by 1, 2 or 5 times a power of ten inside the range', () => {
    expect(niceTicks(0.2, 2.5)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(niceTicks(0.26, 0.34)).toEqual([0.26, 0.28, 0.3, 0.32, 0.34]);
    expect(niceTicks(1, 1)).toEqual([]);
  });

  it('runs Cd from zero to a quarter above the settled record and clips the start', () => {
    const history: [number, number][] = [
      [8, 33],
      [520, 3.2],
      [5000, 2.3],
      [40000, 2.27],
    ];
    expect(plotRanges(history, [], 0.285).cd).toEqual({ minCd: 0, maxCd: 3 });
    // Time starts where the record comes into the scale.
    expect(plotRanges(history, [], 0.285).steps.minStep).toBe(5000);
    expect(plotRanges([[8, -1], ...history]).cd.minCd).toBe(0);
    expect(
      plotRanges([
        [8, 0.2],
        [400, 0.31],
      ]).cd.maxCd,
    ).toBeCloseTo(0.4, 12);
  });
});

describe('force plot description', () => {
  it('names the sample count and the latest Cd', () => {
    expect(labelForHistory([])).toBe('Drag coefficient history, no samples yet.');
    expect(
      labelForHistory([
        [0, 0.2],
        [10, 0.31],
      ]),
    ).toBe('Drag coefficient history with 2 samples; latest 0.31.');
    expect(
      labelForHistory(
        [
          [0, 2.3],
          [10, 2.27],
        ],
        0.285,
      ),
    ).toBe('Drag coefficient history with 2 samples; latest 2.27. Measured reference 0.285.');
  });

  it('keeps the default plot box inside the logical canvas', () => {
    expect(PLOT_BOX).toEqual({ x: 40, y: 8, width: 592, height: 144 });
  });

  it('grows the plot with its displayed width between 180 and 240 px tall', () => {
    expect(plotHeight(358)).toBe(180);
    expect(plotHeight(1100)).toBe(220);
    expect(plotHeight(2000)).toBe(240);
    expect(plotBox(1376, 151)).toEqual({ x: 40, y: 8, width: 1328, height: 115 });
  });
});
