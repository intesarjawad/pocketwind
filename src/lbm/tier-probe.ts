import { MESSAGES } from '../app/messages';
import { AllocationFailure, type GpuSolver } from './gpu-solver';
import { TIERS } from './layout';
import { U_LU } from './units';

type Tier = keyof typeof TIERS;
type AutomaticTier = Exclude<Tier, 'XL'>;
type TierMeasurement = { tier: 'S' | 'M'; msPerStep: number };
export type TierDecision =
  | { kind: 'measure-m' }
  | { kind: 'selected'; tier: AutomaticTier; predictedTimeTo2TS: number };

type AllocationMessage = { what: string; next: string };
export type TierAllocation<Value> =
  | { status: 'ok'; tier: Tier; value: Value; message: AllocationMessage | null }
  | { status: 'error'; tier: Tier; error: AllocationFailure; message: AllocationMessage };

const ANSWER_BUDGET_S = 60;
const PROBE_STEPS = 30;
const MS_PER_SECOND = 1000;
const FLOW_THROUGHS_TO_ANSWER = 2;
const LOWER_TIER = { XL: 'L', L: 'M', M: 'S', S: null } as const;

/** Predict 2T using cell-ratio step cost and the target grid's flow-through length. */
export function predictTimeTo2TS(measured: TierMeasurement, tier: AutomaticTier): number {
  if (!Number.isFinite(measured.msPerStep) || measured.msPerStep <= 0) {
    throw new RangeError('Measured milliseconds per step must be finite and positive.');
  }
  const source = TIERS[measured.tier];
  const target = TIERS[tier];
  const cellRatio = (target.nx * target.ny * target.nz) / (source.nx * source.ny * source.nz);
  const stepsToAnswer = (FLOW_THROUGHS_TO_ANSWER * target.nx) / U_LU;
  return (measured.msPerStep * cellRatio * stepsToAnswer) / MS_PER_SECOND;
}

/**
 * Request M only when it can run within budget; use its timing before selecting L.
 * S remains the fallback when measured M exceeds the budget.
 */
export function decideTier(measured: TierMeasurement): TierDecision {
  if (measured.tier === 'S' && predictTimeTo2TS(measured, 'M') <= ANSWER_BUDGET_S) {
    return { kind: 'measure-m' };
  }
  const choices: readonly AutomaticTier[] = measured.tier === 'M' ? ['L', 'M'] : [];
  for (const tier of choices) {
    const predictedTimeTo2TS = predictTimeTo2TS(measured, tier);
    if (predictedTimeTo2TS <= ANSWER_BUDGET_S) {
      return { kind: 'selected', tier, predictedTimeTo2TS };
    }
  }
  return { kind: 'selected', tier: 'S', predictedTimeTo2TS: predictTimeTo2TS(measured, 'S') };
}

/**
 * Time an already allocated S or M solver with 30 submitted steps.
 * Allocation stays outside timing so M is allocated only when its predicted
 * run time is viable. Release S before allocating M to limit peak memory.
 * Initialization is drained so compilation and setup do not inflate step cost;
 * encoding, submission and completion of the measured batch remain timed.
 */
export async function probeTier(
  device: Pick<GPUDevice, 'createCommandEncoder'> & {
    queue: Pick<GPUQueue, 'submit' | 'onSubmittedWorkDone'>;
  },
  solver: Pick<GpuSolver, 'step'>,
  tier: TierMeasurement['tier'],
): Promise<TierDecision> {
  await device.queue.onSubmittedWorkDone();
  const startedMs = performance.now();
  const encoder = device.createCommandEncoder();
  solver.step(encoder, PROBE_STEPS, true);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  return decideTier({ tier, msPerStep: (performance.now() - startedMs) / PROBE_STEPS });
}

/**
 * Retry one lower tier only for an allocation failure. The allocator must destroy
 * partial buffers before returning AllocationFailure, as GpuSolver.create does.
 */
export async function allocateWithStepDown<Value>(
  tier: Tier,
  create: (tier: Tier) => Promise<Value | AllocationFailure>,
): Promise<TierAllocation<Value>> {
  const value = await create(tier);
  if (!(value instanceof AllocationFailure)) {
    return { status: 'ok', tier, value, message: null };
  }
  const lower = LOWER_TIER[tier];
  const attemptedTier = lower ?? tier;
  const retry = lower === null ? value : await create(lower);
  const message =
    retry instanceof AllocationFailure
      ? MESSAGES['allocation-failed']
      : MESSAGES['allocation-step-down'];
  const detail = {
    what: message.what.replace('{tier}', attemptedTier),
    next: message.next,
  };
  return retry instanceof AllocationFailure
    ? { status: 'error', tier: attemptedTier, error: retry, message: detail }
    : { status: 'ok', tier: attemptedTier, value: retry, message: detail };
}
