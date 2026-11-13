import { describe, expect, it } from 'vitest';
import {
  flowThroughStats,
  formatFlowThroughLine,
  formatSteadyLine,
  parseArguments,
  timeToSteady,
} from '../../scripts/stability';
import { rampFactor } from '../../src/lbm/gpu-solver';

describe('stability arguments', () => {
  it('runs both operators on tier S by default', () => {
    expect(parseArguments([])).toEqual({
      operators: ['trt', 'reg'],
      walls: ['bb', 'bouzidi'],
      tier: 'S',
      preset: 'ahmed-25',
      flowThroughs: 8,
      ramp: 0,
    });
  });

  it('reads every option once', () => {
    expect(
      parseArguments([
        '--operator=reg',
        '--walls=bouzidi',
        '--tier=M',
        '--preset=sphere',
        '--flowthroughs=3',
        '--ramp=2',
      ]),
    ).toEqual({
      operators: ['reg'],
      walls: ['bouzidi'],
      tier: 'M',
      preset: 'sphere',
      flowThroughs: 3,
      ramp: 2,
    });
  });

  it.each([
    ['--operator=bgk', /operator/],
    ['--walls=slip', /wall mode/],
    ['--tier=X', /tier/],
    ['--preset=', /preset/],
    ['--flowthroughs=0', /flowthroughs/],
    ['--flowthroughs=1.5', /flowthroughs/],
    ['--ramp=-1', /ramp/],
    ['--ramp=soon', /ramp/],
    ['--slides=2', /Unknown option/],
    ['stability', /Unknown option/],
  ] as const)('rejects %s', (argument, message) => {
    expect(() => parseArguments([argument])).toThrow(message);
  });
});

describe('flow-through summary', () => {
  const history = [
    [10, 2],
    [20, 4],
    [30, 6],
    [40, 8],
  ] as const;

  it('takes the mean and relative deviation inside one flow-through', () => {
    const stats = flowThroughStats(history, 0, 30);
    expect(stats.step).toBe(20);
    expect(stats.samples).toBe(2);
    expect(stats.meanCd).toBeCloseTo(3, 12);
    expect(stats.relStdPct).toBeCloseTo(47.140452, 6);
  });

  it('keeps the step bins aligned when a flow-through straddles samples', () => {
    const stats = flowThroughStats(history, 1, 30);
    expect(stats.step).toBe(40);
    expect(stats.meanCd).toBeCloseTo(7, 12);
    expect(stats.relStdPct).toBeCloseTo(20.203051, 6);
  });

  it('reports an empty flow-through without a mean or deviation', () => {
    expect(flowThroughStats(history, 2, 30)).toEqual({
      step: 0,
      samples: 0,
      meanCd: null,
      relStdPct: null,
    });
  });

  it.each([0, -30, 1.5, Number.NaN])('rejects a flow-through length of %s', (length) => {
    expect(() => flowThroughStats(history, 0, length)).toThrow(RangeError);
  });

  it('prints one line per flow-through', () => {
    expect(
      formatFlowThroughLine(
        'trt',
        'bb',
        2,
        { step: 2560, samples: 320, meanCd: 0.3, relStdPct: 1.5 },
        true,
      ),
    ).toBe(
      'operator=trt walls=bb flow-through=2 step=2560 finite=yes meanCd=0.3000 relStdPct=1.50',
    );
    expect(
      formatFlowThroughLine(
        'reg',
        'bouzidi',
        1,
        { step: 0, samples: 0, meanCd: null, relStdPct: null },
        false,
      ),
    ).toBe('operator=reg walls=bouzidi flow-through=1 step=0 finite=no meanCd=n/a relStdPct=n/a');
  });
});

describe('time to steady', () => {
  const alternating = (from: number, to: number): [number, number][] => {
    const points: [number, number][] = [];
    for (let step = from; step <= to; step += 1) points.push([step, step % 2 === 0 ? 3 : 1]);
    return points;
  };
  const constant = (from: number, to: number): [number, number][] => {
    const points: [number, number][] = [];
    for (let step = from; step <= to; step += 1) points.push([step, 2]);
    return points;
  };

  it('starts at the first sample whose one-flow-through window is quiet', () => {
    const history = [...alternating(1, 20), ...constant(21, 40)];
    expect(timeToSteady(history, 10)).toEqual({ step: 30, flowThroughs: 3 });
  });

  it('starts at two flow-throughs when the run is quiet from the first sample', () => {
    expect(timeToSteady(constant(1, 40), 10)).toEqual({ step: 20, flowThroughs: 2 });
  });

  it('drops an earlier steady spell when the run leaves it', () => {
    const history: [number, number][] = [...constant(1, 39), [40, 4]];
    expect(timeToSteady(history, 10)).toBeNull();
  });

  it('is null while the run is still settling or never quiet', () => {
    expect(timeToSteady(constant(1, 19), 10)).toBeNull();
    expect(timeToSteady(alternating(1, 60), 10)).toBeNull();
  });

  it('prints one line per operator and wall mode', () => {
    expect(formatSteadyLine('trt', 'bb', { step: 2560, flowThroughs: 2.5 })).toBe(
      'operator=trt walls=bb steady=yes steadyStep=2560 steadyFlowThroughs=2.50',
    );
    expect(formatSteadyLine('reg', 'bouzidi', null)).toBe('operator=reg walls=bouzidi steady=no');
  });
});

describe('inlet ramp factor', () => {
  it('starts at rest and reaches full speed over the ramp', () => {
    expect(rampFactor(0, 100)).toBe(0);
    expect(rampFactor(25, 100)).toBe(0.25);
    expect(rampFactor(50, 100)).toBe(0.5);
    expect(rampFactor(100, 100)).toBe(1);
    expect(rampFactor(500, 100)).toBe(1);
  });

  it('keeps the full speed when no ramp is requested', () => {
    expect(rampFactor(0, 0)).toBe(1);
    expect(rampFactor(10, 0)).toBe(1);
  });
});
