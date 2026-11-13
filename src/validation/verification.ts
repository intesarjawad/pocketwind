import { runPoiseuille, runTaylorGreen } from '../lbm/reference/cases';

const TAYLOR_GREEN_ORDER_MIN = 1.8;
const TAYLOR_GREEN_ORDER_MAX = 2.2;
const DECAY_RELATIVE_ERROR_MAX = 0.01;
const SPEED_ERROR_MAX_PCT = 1;

type PoiseuilleCheck = {
  maxChange: number;
  maxSpeedErrorPct: number;
  profileErrorPct: number;
  forceError: readonly number[];
};

function poiseuillePasses(result: PoiseuilleCheck): boolean {
  return (
    result.maxChange < 1e-12 &&
    Math.abs(result.maxSpeedErrorPct) < SPEED_ERROR_MAX_PCT &&
    result.profileErrorPct < SPEED_ERROR_MAX_PCT &&
    result.forceError.every((error, axis) => Math.abs(error) < (axis === 0 ? 5e-9 : 1e-14))
  );
}

// BGK is expected to miss the parabola: it passes by showing the offset the TRT rows lack.
function bgkShowsOffset(result: { maxChange: number; maxSpeedErrorPct: number }): boolean {
  return result.maxChange < 1e-12 && Math.abs(result.maxSpeedErrorPct) > 5;
}

/**
 * Re-run the analytic cases before any browser work. These are deterministic
 * CPU measurements, so a regression here invalidates the drag comparison.
 */
export function measureAnalyticCases() {
  const coarse = runTaylorGreen(16);
  const medium = runTaylorGreen(32, true);
  const fine = runTaylorGreen(64);
  const observedOrder = [
    Math.log2(coarse.error / medium.error),
    Math.log2(medium.error / fine.error),
  ];
  const decayRelativeError = Math.abs((medium.decayRate ?? NaN) / medium.expectedDecayRate - 1);
  const poiseuille = [0.6, 0.8, 1.5, 3].map((tau0) => {
    const result = runPoiseuille(tau0);
    return {
      ...result,
      forceError: result.force.map((force, axis) => force - (result.expectedForce[axis] ?? NaN)),
    };
  });
  const bgk = runPoiseuille(3, 'bgk');
  const passed =
    decayRelativeError < DECAY_RELATIVE_ERROR_MAX &&
    observedOrder.every(
      (order) => order > TAYLOR_GREEN_ORDER_MIN && order < TAYLOR_GREEN_ORDER_MAX,
    ) &&
    poiseuille.every(poiseuillePasses) &&
    bgkShowsOffset(bgk);
  return {
    passed,
    taylorGreen: { cases: [coarse, medium, fine], observedOrder, decayRelativeError },
    poiseuille,
    bgk,
  };
}

export type VerificationResults = ReturnType<typeof measureAnalyticCases>;

export type VerificationRow = {
  case: string;
  group: 'verification';
  kind: 'taylor-green' | 'poiseuille' | 'poiseuille-bgk';
  label: string;
  steps: number;
  /** Taylor-Green amplitude error against the analytic field, relative. */
  error: number | null;
  /** Observed order between this grid and the next coarser one. */
  observedOrder: number | null;
  /** Relative error of the fitted decay rate, on the grid that measures it. */
  decayRelativeError: number | null;
  /** Poiseuille maximum speed error against the parabola, signed percent. */
  errorPct: number | null;
  profileErrorPct: number | null;
  forceError: readonly number[] | null;
  tau0: number | null;
  pass: boolean;
  commit: string;
  date: string;
};

type Stamp = { commit: string; date: string };

function taylorGreenRows(results: VerificationResults, stamp: Stamp): VerificationRow[] {
  const { cases, observedOrder, decayRelativeError } = results.taylorGreen;
  return cases.map((result, index) => {
    const order = index === 0 ? null : (observedOrder[index - 1] ?? null);
    const decay = result.decayRate === null ? null : decayRelativeError;
    return {
      case: `taylor-green-${result.n}`,
      group: 'verification',
      kind: 'taylor-green',
      label: `Taylor-Green ${result.n}`,
      steps: result.steps,
      error: result.error,
      observedOrder: order,
      decayRelativeError: decay,
      errorPct: null,
      profileErrorPct: null,
      forceError: null,
      tau0: null,
      pass:
        Number.isFinite(result.error) &&
        (order === null || (order > TAYLOR_GREEN_ORDER_MIN && order < TAYLOR_GREEN_ORDER_MAX)) &&
        (decay === null || decay < DECAY_RELATIVE_ERROR_MAX),
      ...stamp,
    };
  });
}

/** One row per analytic case, so a partial run can replace the whole section. */
export function verificationRows(results: VerificationResults, stamp: Stamp): VerificationRow[] {
  const poiseuille = results.poiseuille.map(
    (result): VerificationRow => ({
      case: `poiseuille-tau0-${result.tau0}`,
      group: 'verification',
      kind: 'poiseuille',
      label: `Poiseuille tau0 ${result.tau0}`,
      steps: result.steps,
      error: null,
      observedOrder: null,
      decayRelativeError: null,
      errorPct: result.maxSpeedErrorPct,
      profileErrorPct: result.profileErrorPct,
      forceError: result.forceError,
      tau0: result.tau0,
      pass: poiseuillePasses(result),
      ...stamp,
    }),
  );
  const { bgk } = results;
  return [
    ...taylorGreenRows(results, stamp),
    ...poiseuille,
    {
      case: `poiseuille-bgk-tau0-${bgk.tau0}`,
      group: 'verification',
      kind: 'poiseuille-bgk',
      label: `Poiseuille tau0 ${bgk.tau0} (BGK)`,
      steps: bgk.steps,
      error: null,
      observedOrder: null,
      decayRelativeError: null,
      errorPct: bgk.maxSpeedErrorPct,
      profileErrorPct: bgk.profileErrorPct,
      forceError: null,
      tau0: bgk.tau0,
      pass: bgkShowsOffset(bgk),
      ...stamp,
    },
  ];
}
