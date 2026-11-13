import { createDragStats } from '../forces/drag-stats';
import { cdPerNewton } from '../forces/physical';
import type { CaseSpec } from './cases';
import { MASKELL_THETA, PASS_TOLERANCE_PCT } from './cases';

/** The browser force readback runs every eight solver steps. */
export const FORCE_SAMPLE_STEPS = 8;

export type AdapterInfo = {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  features: readonly string[];
};

export type ForceSample = {
  step: number;
  fx: number;
  fy: number;
  fz: number;
};

export type SolverRun = {
  forces: readonly ForceSample[];
  steps: number;
  msPerStep: number;
  /** Measured projected area, when the solver can report it. */
  voxelAreaM2?: number;
  blockage?: number;
  adapter?: AdapterInfo;
  userAgent?: string;
};

export type CaseSolver = {
  run(spec: CaseSpec): Promise<SolverRun>;
};

export type RunContext = {
  commit: string;
  date: string;
  adapter: AdapterInfo;
  userAgent: string;
};

export type ValidationRow = {
  case: string;
  id: string;
  group: CaseSpec['group'];
  label: string;
  tier: CaseSpec['tier'];
  grid: CaseSpec['grid'];
  cells: number;
  operator: CaseSpec['operator'];
  walls: CaseSpec['walls'];
  storage: CaseSpec['storage'];
  variant: CaseSpec['variant'];
  sensitivity: CaseSpec['sensitivity'];
  shapeClass: CaseSpec['shapeClass'];
  speedMps: number;
  re: number | null;
  les: boolean;
  floor: boolean;
  stilts: boolean;
  bodyLengthMm: number;
  bodyLengthCells: number;
  cellSizeM: number;
  referenceAreaM2: number;
  voxelAreaM2: number;
  blockage: number;
  baselineBlockage: number | null;
  uLu: number;
  steps: number;
  flowThroughSteps: number;
  msPerStep: number;
  cd: number;
  cdVoxel: number;
  cdRaw: number | null;
  cdMaskell: number | null;
  referenceCd: number | null;
  errorPct: number | null;
  fx: number;
  fy: number;
  fz: number;
  relStdPct: number;
  driftPct: number;
  forceHistory: readonly (readonly [number, number, number, number])[];
  adapter: AdapterInfo;
  userAgent: string;
  commit: string;
  date: string;
  isDefault: boolean;
  pass: boolean;
  reasons: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readAdapter(value: unknown): AdapterInfo {
  if (
    !isRecord(value) ||
    typeof value.vendor !== 'string' ||
    typeof value.architecture !== 'string' ||
    typeof value.device !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.features) ||
    !value.features.every((feature) => typeof feature === 'string')
  ) {
    throw new RangeError('The page returned a malformed adapter record.');
  }
  return {
    vendor: value.vendor,
    architecture: value.architecture,
    device: value.device,
    description: value.description,
    features: value.features,
  };
}

function readForces(value: unknown): ForceSample[] {
  if (!Array.isArray(value)) throw new RangeError('The page returned no force history.');
  return value.map((sample: unknown) => {
    if (
      !isRecord(sample) ||
      !isFiniteNumber(sample.step) ||
      !isFiniteNumber(sample.fx) ||
      !isFiniteNumber(sample.fy) ||
      !isFiniteNumber(sample.fz)
    ) {
      throw new RangeError('The page returned a malformed force sample.');
    }
    return { step: sample.step, fx: sample.fx, fy: sample.fy, fz: sample.fz };
  });
}

/** Check what `window.__pwt.result` held before it becomes a row; a bad record fails its case. */
export function readSolverRun(value: unknown): SolverRun {
  if (!isRecord(value)) throw new RangeError('The page returned no result record.');
  if (typeof value.error === 'string') throw new Error(value.error);
  if (!isFiniteNumber(value.steps) || !isFiniteNumber(value.msPerStep)) {
    throw new RangeError('The result record has no step count or step time.');
  }
  const run: SolverRun = {
    forces: readForces(value.forces),
    steps: value.steps,
    msPerStep: value.msPerStep,
  };
  if (value.voxelAreaM2 !== undefined) {
    if (!isFiniteNumber(value.voxelAreaM2)) throw new RangeError('voxelAreaM2 must be a number.');
    run.voxelAreaM2 = value.voxelAreaM2;
  }
  if (value.blockage !== undefined) {
    if (!isFiniteNumber(value.blockage)) throw new RangeError('blockage must be a number.');
    run.blockage = value.blockage;
  }
  if (value.adapter !== undefined) run.adapter = readAdapter(value.adapter);
  if (typeof value.userAgent === 'string') run.userAgent = value.userAgent;
  return run;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function requireFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite.`);
}

function inAverageWindow(sample: ForceSample, spec: CaseSpec): boolean {
  return sample.step > spec.steps - spec.averageSteps && sample.step <= spec.steps;
}

function sampleHistory(
  run: SolverRun,
  steps: number,
): (readonly [number, number, number, number])[] {
  return run.forces
    .filter((sample) => sample.step % FORCE_SAMPLE_STEPS === 0 && sample.step <= steps)
    .map((sample) => [sample.step, sample.fx, sample.fy, sample.fz] as const);
}

function maskell(cdRaw: number, blockage: number): number {
  return cdRaw / (1 + MASKELL_THETA * cdRaw * blockage);
}

function evaluate(
  cd: number,
  referenceCd: number | null,
  errorPct: number | null,
  relStdPct: number,
  driftPct: number,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Number.isFinite(cd)) reasons.push('Cd is not finite');
  if (!Number.isFinite(relStdPct)) reasons.push('relative standard deviation is not finite');
  if (!Number.isFinite(driftPct)) reasons.push('drift is not finite');
  if (referenceCd !== null) {
    if (errorPct === null || !Number.isFinite(errorPct)) {
      reasons.push('reference error is missing');
    } else if (Math.abs(errorPct) > PASS_TOLERANCE_PCT) {
      reasons.push(`reference error ${errorPct.toFixed(1)}% exceeds ${PASS_TOLERANCE_PCT}%`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function validateRun(spec: CaseSpec, run: SolverRun): void {
  if (!Number.isSafeInteger(run.steps) || run.steps < spec.steps) {
    throw new RangeError(
      `Case ${spec.id} ran ${run.steps} steps, expected at least ${spec.steps}.`,
    );
  }
  requireFinite(run.msPerStep, 'Milliseconds per step');
  for (const sample of run.forces) {
    if (
      !Number.isFinite(sample.step) ||
      !Number.isFinite(sample.fx) ||
      !Number.isFinite(sample.fy) ||
      !Number.isFinite(sample.fz)
    ) {
      throw new RangeError(`Case ${spec.id} returned a non-finite force sample.`);
    }
  }
}

function averagedForces(spec: CaseSpec, run: SolverRun): { fx: number; fy: number; fz: number } {
  const window = run.forces.filter((sample) => inAverageWindow(sample, spec));
  if (window.length === 0) {
    throw new RangeError(`Case ${spec.id} returned no force samples in the averaging window.`);
  }
  return {
    fx: mean(window.map((sample) => sample.fx)),
    fy: mean(window.map((sample) => sample.fy)),
    fz: mean(window.map((sample) => sample.fz)),
  };
}

function fluctuations(spec: CaseSpec, run: SolverRun): { relStdPct: number; driftPct: number } {
  const stats = createDragStats(spec.flowThroughSteps);
  for (const sample of run.forces) stats.push(sample.step, sample.fx);
  const summary = stats.summary(null);
  if (summary.status.kind === 'settling') return { relStdPct: 0, driftPct: 0 };
  return { relStdPct: summary.status.relStdPct, driftPct: summary.status.driftPct };
}

/**
 * Turn one solver record into a reported row. The mean is taken over the last
 * two flow-throughs; the history keeps the eight-step readback cadence.
 */
export function rowFromRun(spec: CaseSpec, run: SolverRun, context: RunContext): ValidationRow {
  validateRun(spec, run);
  const { fx, fy, fz } = averagedForces(spec, run);
  const cd = fx * cdPerNewton(spec.referenceAreaM2, spec.speedMps);
  const voxelAreaM2 = run.voxelAreaM2 ?? spec.voxelAreaM2;
  const cdVoxel = fx * cdPerNewton(voxelAreaM2, spec.speedMps);
  const { relStdPct, driftPct } = fluctuations(spec, run);
  const errorPct =
    spec.referenceCd === null ? null : (100 * (cd - spec.referenceCd)) / spec.referenceCd;
  const { pass, reasons } = evaluate(cd, spec.referenceCd, errorPct, relStdPct, driftPct);
  const measuredShape = spec.shape === 'cube' || spec.shape === 'sphere';
  const blockage = run.blockage ?? spec.blockage;

  return {
    case: spec.case,
    id: spec.id,
    group: spec.group,
    label: spec.label,
    tier: spec.tier,
    grid: spec.grid,
    cells: spec.cells,
    operator: spec.operator,
    walls: spec.walls,
    storage: spec.storage,
    variant: spec.variant,
    sensitivity: spec.sensitivity,
    shapeClass: spec.shapeClass,
    speedMps: spec.speedMps,
    re: spec.re,
    les: spec.les,
    floor: spec.floor,
    stilts: spec.stilts,
    bodyLengthMm: spec.bodyLengthMm,
    bodyLengthCells: spec.bodyLengthCells,
    cellSizeM: spec.cellSizeM,
    referenceAreaM2: spec.referenceAreaM2,
    voxelAreaM2,
    blockage,
    baselineBlockage: spec.baselineBlockage,
    uLu: spec.uLu,
    steps: run.steps,
    flowThroughSteps: spec.flowThroughSteps,
    msPerStep: run.msPerStep,
    cd,
    cdVoxel,
    cdRaw: measuredShape ? cdVoxel : null,
    cdMaskell: measuredShape ? maskell(cdVoxel, blockage) : null,
    referenceCd: spec.referenceCd,
    errorPct,
    fx,
    fy,
    fz,
    relStdPct,
    driftPct,
    forceHistory: sampleHistory(run, run.steps),
    adapter: run.adapter ?? context.adapter,
    userAgent: run.userAgent ?? context.userAgent,
    commit: context.commit,
    date: context.date,
    isDefault: spec.isDefault,
    pass,
    reasons,
  };
}

export async function runCases(
  solver: CaseSolver,
  cases: readonly CaseSpec[],
  context: RunContext,
): Promise<ValidationRow[]> {
  const rows: ValidationRow[] = [];
  for (const spec of cases) {
    rows.push(rowFromRun(spec, await solver.run(spec), context));
  }
  return rows;
}
