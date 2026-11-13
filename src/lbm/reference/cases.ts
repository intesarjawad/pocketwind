import type { Mesh } from '../../geometry/stl';
import { placeMesh } from '../../geometry/transform';
import { CellType, type Layout, NO_Q, type VoxelGrid } from '../../geometry/voxel-grid';
import { voxelize } from '../../geometry/voxelize';
import { DIRECTIONS } from '../lattice';
import { cdPerLatticeForce, U_LU } from '../units';
import { CpuSolver, type MacroState, type Operator } from './cpu-solver';

const TAYLOR_GREEN_TAU = 0.8;
const BASE_SIZE = 32;
const BASE_AMPLITUDE = 0.01;
const BASE_STEPS = 200;
const DECAY_START = 20;
const CHANNEL_NZ = 18;
const CHANNEL_MAX_SPEED = 0.01;
const CONVERGENCE_TOLERANCE = 1e-12;
const MAX_CHANNEL_STEPS = 100000;

/** Analytic periodic vortex, with pressure represented by the isothermal density. */
export function taylorGreenState(n: number, x: number, y: number, step = 0): MacroState {
  const k = (2 * Math.PI) / n;
  const nu = (TAYLOR_GREEN_TAU - 0.5) / 3;
  const amplitude = ((BASE_AMPLITUDE * BASE_SIZE) / n) * Math.exp(-2 * nu * k * k * step);
  return {
    rho: 1 - 0.75 * amplitude * amplitude * (Math.cos(2 * k * x) + Math.cos(2 * k * y)),
    velocity: [
      -amplitude * Math.cos(k * x) * Math.sin(k * y),
      amplitude * Math.sin(k * x) * Math.cos(k * y),
      0,
    ],
  };
}

function vortexMetrics(solver: CpuSolver, step: number): { amplitude: number; error: number } {
  const n = solver.layout.nx;
  const initialAmplitude = (BASE_AMPLITUDE * BASE_SIZE) / n;
  let projection = 0;
  let basisSquared = 0;
  let squaredError = 0;
  for (let cell = 0; cell < solver.cells; cell += 1) {
    const x = cell % n;
    const y = Math.floor(cell / n) % n;
    const expected = taylorGreenState(n, x, y, step).velocity;
    const basis = taylorGreenState(n, x, y).velocity;
    const actual = solver.macroscopic(cell).velocity;
    for (const axis of [0, 1, 2] as const) {
      const unit = basis[axis] / initialAmplitude;
      projection += actual[axis] * unit;
      basisSquared += unit * unit;
      squaredError += (actual[axis] - expected[axis]) ** 2;
    }
  }
  return {
    amplitude: projection / basisSquared,
    error: Math.sqrt(squaredError / solver.cells) / initialAmplitude,
  };
}

function fittedDecay(samples: readonly { step: number; amplitude: number }[]): number {
  const meanStep = samples.reduce((sum, sample) => sum + sample.step, 0) / samples.length;
  const meanLog =
    samples.reduce((sum, sample) => sum + Math.log(sample.amplitude), 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (const { step, amplitude } of samples) {
    covariance += (step - meanStep) * (Math.log(amplitude) - meanLog);
    variance += (step - meanStep) ** 2;
  }
  return -covariance / variance;
}

/** Measure velocity error at equal diffusive time; optionally fit steps 20 through 200. */
export function runTaylorGreen(n: 16 | 32 | 64, measureDecay = false) {
  if (measureDecay && n !== BASE_SIZE) {
    throw new RangeError('The decay fit uses the 32-cell vortex.');
  }
  const solver = new CpuSolver({
    layout: { nx: n, ny: n, nz: 4 },
    tau0: TAYLOR_GREEN_TAU,
    initialState: (x, y) => taylorGreenState(n, x, y),
  });
  const steps = BASE_STEPS * (n / BASE_SIZE) ** 2;
  const samples: { step: number; amplitude: number }[] = [];
  for (let step = 1; step <= steps; step += 1) {
    solver.step();
    if (measureDecay && step >= DECAY_START) {
      samples.push({ step, amplitude: vortexMetrics(solver, step).amplitude });
    }
  }
  const nu = (TAYLOR_GREEN_TAU - 0.5) / 3;
  return {
    n,
    steps,
    ...vortexMetrics(solver, steps),
    decayRate: measureDecay ? fittedDecay(samples) : null,
    expectedDecayRate: 2 * nu * ((2 * Math.PI) / n) ** 2,
  };
}

export type ChannelOptions = {
  /** Fluid nodes across the channel. */
  readonly fluidNodes?: number;
  /** Wall distance from the outermost fluid nodes as a link fraction; set for interpolated walls. */
  readonly q?: number;
};

function channelLayout(fluidNodes: number, q: number | undefined): Layout {
  if (!Number.isSafeInteger(fluidNodes) || fluidNodes < 2) {
    throw new RangeError('The channel needs at least two fluid nodes across.');
  }
  if (q !== undefined && !(q > 0 && q <= 1)) {
    throw new RangeError('The wall fraction must be in (0, 1].');
  }
  return { nx: 2, ny: 2, nz: fluidNodes + 2 };
}

/** Wall flags alone, or packed with per-cell q offsets and one fraction per link, all at q. */
function channelGeometry(layout: Layout, q: number | undefined): Uint32Array {
  const plane = layout.nx * layout.ny;
  const cells = plane * layout.nz;
  if (q === undefined) {
    const flags = new Uint32Array(cells);
    flags.fill(CellType.SOLID, 0, plane);
    flags.fill(CellType.SOLID, cells - plane);
    return flags;
  }
  const linksPerSide = DIRECTIONS.filter(([, , cz]) => cz === 1).length;
  const fractions = new Float32Array(2 * plane * linksPerSide).fill(q);
  const geometry = new Uint32Array(2 * cells + fractions.length);
  geometry.fill(CellType.SOLID, 0, plane);
  geometry.fill(CellType.SOLID, cells - plane, cells);
  geometry.fill(NO_Q, cells, 2 * cells);
  for (let cell = 0; cell < plane; cell += 1) {
    geometry[cells + plane + cell] = cell * linksPerSide;
    geometry[2 * cells - 2 * plane + cell] = (plane + cell) * linksPerSide;
  }
  new Float32Array(geometry.buffer, 2 * cells * 4).set(fractions);
  return geometry;
}

/**
 * Run a periodic, uniformly forced channel to a per-step velocity tolerance of 1e-12.
 * Halfway walls sit half a link outside the outermost fluid nodes; interpolated walls sit q outside.
 */
export function runPoiseuille(
  tau0: number,
  operator: Operator = 'trt',
  { fluidNodes = CHANNEL_NZ - 2, q }: ChannelOptions = {},
) {
  const layout = channelLayout(fluidNodes, q);
  const plane = layout.nx * layout.ny;
  const wallOffset = q === undefined ? 0.5 : Math.fround(q);
  const height = fluidNodes - 1 + 2 * wallOffset;
  const nu = (tau0 - 0.5) / 3;
  const acceleration = (8 * nu * CHANNEL_MAX_SPEED) / height ** 2;
  const solver = new CpuSolver({
    layout,
    tau0,
    operator,
    walls: q === undefined ? 'bb' : 'bouzidi',
    flags: channelGeometry(layout, q),
    bodyForceLu: [acceleration, 0, 0],
  });
  const previous = new Float64Array(solver.cells * 3);
  let maxChange = Infinity;
  let steps = 0;
  while (steps < MAX_CHANNEL_STEPS && maxChange >= CONVERGENCE_TOLERANCE) {
    solver.step();
    steps += 1;
    maxChange = 0;
    for (let cell = plane; cell < solver.cells - plane; cell += 1) {
      const velocity = solver.macroscopic(cell).velocity;
      for (const axis of [0, 1, 2] as const) {
        const offset = cell * 3 + axis;
        maxChange = Math.max(maxChange, Math.abs(velocity[axis] - (previous[offset] ?? NaN)));
        previous[offset] = velocity[axis];
      }
    }
  }
  if (maxChange >= CONVERGENCE_TOLERANCE || !Number.isFinite(maxChange)) {
    throw new Error(`Channel did not converge after ${steps} steps (max change ${maxChange}).`);
  }
  const profile = Array.from(
    { length: fluidNodes },
    (_, i) => solver.macroscopic((i + 1) * plane).velocity[0],
  );
  const analyticProfile = profile.map((_, i) => {
    const distance = i + wallOffset;
    return (acceleration * distance * (height - distance)) / (2 * nu);
  });
  const maxSpeed = Math.max(...profile);
  // Stored momentum is after the force impulse; the continuum velocity is at its midpoint.
  const centeredProfile = profile.map((u) => u - acceleration / 2);
  const profileError = Math.max(
    ...centeredProfile.map((u, i) => Math.abs(u - (analyticProfile[i] ?? NaN))),
  );
  return {
    tau0,
    operator,
    steps,
    maxChange,
    maxSpeed,
    maxSpeedErrorPct: (100 * (maxSpeed - CHANNEL_MAX_SPEED)) / CHANNEL_MAX_SPEED,
    profileErrorPct: (100 * profileError) / CHANNEL_MAX_SPEED,
    profile,
    centeredProfile,
    analyticProfile,
    force: solver.momentumExchange(),
    expectedForce: [acceleration * plane * fluidNodes, 0, 0] as const,
  };
}

// Same eight-step cadence as the live readback, so the means compare like for like.
const FORCE_SAMPLE_STEPS = 8;

export type DragCaseOptions = {
  readonly layout: Layout;
  readonly body: Mesh;
  readonly bodyLengthCells: number;
  readonly tau0: number;
  readonly operator?: Operator;
  readonly les?: boolean;
  readonly floor?: boolean;
  readonly uIn?: number;
  readonly flowThroughs?: number;
};

export type DragFlowThrough = {
  readonly flowThrough: number;
  readonly step: number;
  readonly samples: number;
  readonly meanCd: number | null;
  readonly relStdPct: number | null;
};

export type DragCaseResult = {
  readonly grid: VoxelGrid;
  readonly stepsPerFlowThrough: number;
  readonly cdPerForce: number;
  readonly finite: boolean;
  readonly flowThroughs: readonly DragFlowThrough[];
};

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function relativeStdPct(values: readonly number[]): number | null {
  const mean = meanOf(values);
  if (mean === null || values.length < 2) return null;
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  const std = Math.sqrt(squares / (values.length - 1));
  return (100 * std) / Math.abs(mean);
}

/**
 * Run the reference solver over a placed body and report the drag coefficient
 * per flow-through, binned by step the way the live readout does.
 */
export function runBodyDrag({
  layout,
  body,
  bodyLengthCells,
  tau0,
  operator = 'trt',
  les = true,
  floor = true,
  uIn = U_LU,
  flowThroughs = 4,
}: DragCaseOptions): DragCaseResult {
  const placed = placeMesh(body, {
    layout,
    lengthCells: bodyLengthCells,
    flowAxis: 'x',
    flowSign: 1,
    upAxis: 'z',
    floor,
  });
  const grid = voxelize(placed.body, placed.supports, layout, { floor });
  if (grid.solidCells === 0) throw new Error('The body does not cover any grid cells.');
  const cells = layout.nx * layout.ny * layout.nz;
  const solver = new CpuSolver({
    layout,
    tau0,
    operator,
    les,
    flags: grid.geometry.subarray(0, cells),
    equilibriumState: { rho: 1, velocity: [uIn, 0, 0] },
  });
  const stepsPerFlowThrough = Math.ceil(layout.nx / U_LU);
  const cdPerForce = cdPerLatticeForce(grid.frontalCells);
  const buckets: number[][] = Array.from({ length: flowThroughs }, () => []);
  const lastSteps: number[] = Array.from({ length: flowThroughs }, () => 0);
  for (let step = 1; step <= flowThroughs * stepsPerFlowThrough; step += 1) {
    solver.step();
    if (step % FORCE_SAMPLE_STEPS !== 0) continue;
    const flowThrough = Math.floor(step / stepsPerFlowThrough);
    if (flowThrough >= flowThroughs) continue;
    buckets[flowThrough]?.push(solver.momentumExchange()[0] * cdPerForce);
    lastSteps[flowThrough] = step;
  }
  const samplesAllFinite = buckets.every((values) => values.every(Number.isFinite));
  const finite = samplesAllFinite && solver.populations.every(Number.isFinite);
  return {
    grid,
    stepsPerFlowThrough,
    cdPerForce,
    finite,
    flowThroughs: buckets.map((values, index) => ({
      flowThrough: index + 1,
      step: lastSteps[index] ?? 0,
      samples: values.length,
      meanCd: meanOf(values),
      relStdPct: relativeStdPct(values),
    })),
  };
}
