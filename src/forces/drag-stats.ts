import { FORCE_EVERY_STEPS } from '../lbm/params';

// One flow-through keeps the window responsive to the latest wake state.
export const WINDOW_FLOW_THROUGHS = 1;
// Two flow-throughs give the startup transient time to leave before a settled report.
export const SETTLING_FLOW_THROUGHS = 2;
export const STEADY_FLUCTUATION_PCT = 3;
export const STEADY_REL_STD_PCT = STEADY_FLUCTUATION_PCT;
export const STEADY_DRIFT_PCT = 1;
// Five batches keep the variance estimate from resting on a handful of differences.
export const MIN_BATCHES = 5;
// More batches than this no longer sharpen the mean estimate enough to matter.
export const MAX_BATCHES = 16;
export const TOO_FEW_INDEPENDENT_SAMPLES = 'too-few-independent-samples';

export type DragStatus =
  | { kind: 'settling'; etaS: number | null }
  | { kind: 'steady'; relStdPct: number; driftPct: number }
  | { kind: 'unsteady'; relStdPct: number; driftPct: number };

export type DragSummary = {
  cd: number | null;
  status: DragStatus;
  samples: number;
  /** Batch-means uncertainty of the mean over the two-flow-through window. */
  semPct?: number | null;
  reason?: typeof TOO_FEW_INDEPENDENT_SAMPLES;
};

type ForceSample = { step: number; fx: number };

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = meanOf(values) ?? 0;
  let squares = 0;
  for (const value of values) {
    const deviation = value - mean;
    squares += deviation * deviation;
  }
  return Math.sqrt(squares / (values.length - 1));
}

function relativeStdPct(values: readonly number[]): number {
  const mean = meanOf(values);
  if (mean === null) return 0;
  const std = sampleStdDev(values);
  if (mean === 0) return std === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (100 * std) / Math.abs(mean);
}

/** Compare the first and second half of the window; an odd count leaves the middle in the second half. */
function halfDriftPct(values: readonly number[]): number {
  const count = values.length;
  if (count < 2) return 0;
  const half = Math.floor(count / 2);
  const first = meanOf(values.slice(0, half));
  const second = meanOf(values.slice(half));
  const mean = meanOf(values);
  if (first === null || second === null || mean === null) return 0;
  const change = Math.abs(first - second);
  if (mean === 0) return change === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (100 * change) / Math.abs(mean);
}

/**
 * Integral time in steps, from the sample autocorrelation summed until its
 * first zero crossing. Lag zero counts as one, so white noise still gives one
 * sample interval rather than zero.
 */
export function tauInt(values: readonly number[], sampleSpacingSteps = 1): number {
  if (!Number.isFinite(sampleSpacingSteps) || sampleSpacingSteps <= 0) {
    throw new RangeError('Sample spacing must be finite and positive.');
  }
  const count = values.length;
  if (count < 2) return sampleSpacingSteps;
  const centred = new Float64Array(count);
  let mean = 0;
  for (let i = 0; i < count; i++) mean += values[i] ?? 0;
  mean /= count;
  let variance = 0;
  for (let i = 0; i < count; i++) {
    const deviation = (values[i] ?? 0) - mean;
    centred[i] = deviation;
    variance += deviation * deviation;
  }
  if (variance === 0) return sampleSpacingSteps;
  let sum = 1;
  const maxLag = Math.floor(count / 2);
  for (let lag = 1; lag <= maxLag; lag++) {
    let covariance = 0;
    for (let i = 0; i + lag < count; i++) {
      covariance += (centred[i] ?? 0) * (centred[i + lag] ?? 0);
    }
    if (covariance <= 0) break;
    sum += covariance / variance;
  }
  return sum * sampleSpacingSteps;
}

/**
 * Batch length in steps. The floor keeps two consecutive force samples from
 * forming a batch, and twice the integral time decorrelates a wake period.
 */
export function batchLength(values: readonly number[], sampleSpacingSteps = 1): number {
  return Math.max(2 * tauInt(values, sampleSpacingSteps), 8 * FORCE_EVERY_STEPS);
}

/**
 * Standard error of the mean as a percentage, from batch means. Returns null
 * when the window cannot support five independent batches, because a mean
 * without an uncertainty is not a reportable drag value.
 */
export function semPct(
  values: readonly number[],
  sampleSpacingSteps = 1,
  windowSteps = values.length * sampleSpacingSteps,
): number | null {
  const count = values.length;
  const mean = meanOf(values);
  if (mean === null) return null;
  if (!Number.isFinite(windowSteps) || windowSteps <= 0) return null;
  const length = batchLength(values, sampleSpacingSteps);
  const samplesPerBatch = Math.max(1, Math.round(length / sampleSpacingSteps));
  const available = Math.floor(count / samplesPerBatch);
  const batches = Math.min(MAX_BATCHES, Math.floor(windowSteps / length), available);
  if (batches < MIN_BATCHES) return null;
  const batchMeans = new Float64Array(batches);
  // The newest complete batches describe the current window, not its start-up tail.
  const start = count - batches * samplesPerBatch;
  for (let batch = 0; batch < batches; batch++) {
    let sum = 0;
    const from = start + batch * samplesPerBatch;
    for (let i = from; i < from + samplesPerBatch; i++) sum += values[i] ?? 0;
    batchMeans[batch] = sum / samplesPerBatch;
  }
  const std = sampleStdDev(Array.from(batchMeans));
  if (mean === 0) return std === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (100 * (std / Math.sqrt(batches))) / Math.abs(mean);
}

function sampleSpacing(samples: readonly ForceSample[]): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || samples.length < 2) return FORCE_EVERY_STEPS;
  const spacing = (last.step - first.step) / (samples.length - 1);
  return Number.isFinite(spacing) && spacing > 0 ? spacing : FORCE_EVERY_STEPS;
}

/**
 * Collect drag-force samples for one analysis window. `cdPerForce` converts a
 * force into Cd, so a caller with a reference area and speed passes
 * `cdPerNewton(areaM2, speedMps)`; the default reports the mean force itself.
 */
export function createDragStats(
  flowThroughSteps: number,
  cdPerForce = 1,
): {
  push(step: number, fx: number): void;
  summary(stepsPerS: number | null): DragSummary;
} {
  if (!Number.isFinite(flowThroughSteps) || flowThroughSteps <= 0) {
    throw new RangeError('Flow-through steps must be finite and positive.');
  }
  if (!Number.isFinite(cdPerForce)) {
    throw new RangeError('Cd per unit force must be finite.');
  }
  const windowSteps = WINDOW_FLOW_THROUGHS * flowThroughSteps;
  const settleSteps = SETTLING_FLOW_THROUGHS * flowThroughSteps;
  const samples: ForceSample[] = [];

  return {
    push(step: number, fx: number): void {
      if (!Number.isFinite(step) || !Number.isFinite(fx)) {
        throw new RangeError('Drag samples require a finite step and force.');
      }
      const previous = samples[samples.length - 1];
      if (previous !== undefined && step <= previous.step) {
        throw new RangeError('Drag sample steps must strictly increase.');
      }
      samples.push({ step, fx });
      while (samples.length > 0) {
        const oldest = samples[0];
        if (oldest === undefined || oldest.step > step - settleSteps) break;
        samples.shift();
      }
    },

    /** `stepsPerS` turns the remaining startup time into seconds; null keeps etaS unknown. */
    summary(stepsPerS: number | null): DragSummary {
      const last = samples[samples.length - 1];
      const elapsed = last?.step ?? 0;
      const window = samples.filter((sample) => sample.step > elapsed - windowSteps);
      const values = window.map((sample) => sample.fx);
      const allValues = samples.map((sample) => sample.fx);
      const mean = meanOf(values);
      const sem = semPct(allValues, sampleSpacing(samples), settleSteps);
      const cd = mean !== null && sem !== null ? mean * cdPerForce : null;
      const reason: { reason?: typeof TOO_FEW_INDEPENDENT_SAMPLES } =
        sem === null ? { reason: TOO_FEW_INDEPENDENT_SAMPLES } : {};
      if (elapsed < settleSteps) {
        const etaS =
          stepsPerS !== null && Number.isFinite(stepsPerS) && stepsPerS > 0
            ? Math.max(0, (settleSteps - elapsed) / stepsPerS)
            : null;
        return {
          cd,
          status: { kind: 'settling', etaS },
          samples: values.length,
          semPct: sem,
          ...reason,
        };
      }
      const fluctuation = relativeStdPct(values);
      const drift = halfDriftPct(values);
      const settled = fluctuation < STEADY_FLUCTUATION_PCT && drift < STEADY_DRIFT_PCT;
      return {
        cd,
        status: settled
          ? { kind: 'steady', relStdPct: fluctuation, driftPct: drift }
          : { kind: 'unsteady', relStdPct: fluctuation, driftPct: drift },
        samples: values.length,
        semPct: sem,
        ...reason,
      };
    },
  };
}
