import { RHO_AIR } from '../forces/physical';
import { referenceAreaCells } from '../forces/reference-area';
import type { Mesh } from '../geometry/stl';
import { placeMesh } from '../geometry/transform';
import { voxelize } from '../geometry/voxelize';
import { detectGpu } from '../gpu/device';
import type { ForceHistoryPoint } from '../io/run-file';
import { decodeShareLink } from '../io/share-link';
import {
  AllocationFailure,
  FORCE_EVERY_STEPS,
  type ForceSample,
  GpuSolver,
} from '../lbm/gpu-solver';
import { TIERS } from '../lbm/layout';
import { resolveStorage } from '../lbm/precision';
import { cdPerLatticeForce, NU_AIR, U_LU } from '../lbm/units';
import type { SolverRun } from '../validation/runner';
import {
  type GridCheckOptions,
  type GridCheckRunner,
  gridCheckSteps,
  runFlowThroughsFromHash,
  runGridCheck,
} from './grid-check';
import { presetById } from './params';
import { type Body, bodyFor, runLengthCells } from './run-plan';
import type { Settings, Tier } from './settings';
import { acquireSolverSlot } from './solver-slot';
import { viscosityLu } from './store';

/** What an unattended run reproduces beyond the settings, read from the runner hash parameters. */
export type CaseParameters = {
  readonly stopAtSteps: number;
  /** Set directly when the case fixes its Reynolds number; otherwise speed and length give it. */
  readonly re: number | null;
  readonly les: boolean;
  /** Body length in cells; null keeps the interactive placement. */
  readonly lengthCells: number | null;
  readonly uLu: number;
  /** Count the supports in the force sum, as the stilts sensitivity row asks. */
  readonly supportsInForce: boolean;
};

export type UnattendedRequest =
  | { readonly kind: 'case'; readonly parameters: CaseParameters }
  | { readonly kind: 'grid-check' };

function positiveNumber(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`The runner parameter ${name}=${raw} must be a positive number.`);
  }
  return value;
}

function flag(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (raw !== '0' && raw !== '1') {
    throw new RangeError(`The runner parameter ${name}=${raw} must be 0 or 1.`);
  }
  return raw === '1';
}

function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.split('?')[1] ?? '');
}

/** `auto=1` hands the page to the validation runner instead of a person. */
export function isUnattended(hash: string): boolean {
  return hashParams(hash).get('auto') === '1';
}

/** A run without a step count is refused rather than left running. */
export function unattendedRequest(hash: string): UnattendedRequest {
  const params = hashParams(hash);
  if (params.get('gc') === '1') return { kind: 'grid-check' };
  const stopAtSteps = positiveNumber(params, 'stopAt');
  if (stopAtSteps === null || !Number.isSafeInteger(stopAtSteps)) {
    throw new RangeError('An unattended run needs stopAt=<steps> as a whole number.');
  }
  return {
    kind: 'case',
    parameters: {
      stopAtSteps,
      re: positiveNumber(params, 're'),
      les: flag(params, 'les', true),
      lengthCells: positiveNumber(params, 'lc'),
      uLu: positiveNumber(params, 'ulu') ?? U_LU,
      supportsInForce: flag(params, 'stilts', false),
    },
  };
}

/** The physical scales of a case: the Reynolds number fixes the speed when the case sets it. */
export function caseScales(
  settings: Pick<Settings, 'speedMps' | 'bodyLengthMm'>,
  parameters: Pick<CaseParameters, 're' | 'uLu'>,
  lengthCells: number,
): { re: number; speedMps: number; viscosityLu: number; cellSizeM: number } {
  const lengthM = settings.bodyLengthMm / 1000;
  const re = parameters.re ?? (settings.speedMps * lengthM) / NU_AIR;
  return {
    re,
    speedMps: parameters.re === null ? settings.speedMps : (re * NU_AIR) / lengthM,
    viscosityLu: (parameters.uLu * lengthCells) / re,
    cellSizeM: lengthM / lengthCells,
  };
}

function joined(a: Mesh, b: Mesh): Mesh {
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  return { positions, triangleCount: a.triangleCount + b.triangleCount };
}

function voxelBody(
  body: Body,
  settings: Settings,
  tier: Tier,
  lengthCells: number,
  supportsInForce: boolean,
) {
  const layout = TIERS[tier];
  const placed = placeMesh(body.mesh, {
    layout,
    lengthCells,
    flowAxis: settings.flowAxis,
    flowSign: settings.flowSign,
    upAxis: settings.upAxis,
    floor: settings.floor,
    ...(body.supports === null ? {} : { supports: body.supports }),
  });
  const { supports } = placed;
  const counted = supportsInForce && supports !== null;
  const grid = voxelize(
    counted ? joined(placed.body, supports) : placed.body,
    counted ? null : supports,
    layout,
    { floor: settings.floor, linkFractions: settings.walls === 'bouzidi' },
  );
  if (grid.solidCells === 0) throw new Error('The body covers no grid cells at this size.');
  return grid;
}

/**
 * Step one batch of eight and read its force before encoding the next, so no
 * sample is skipped; returns at `stopAtSteps`, at a non-finite force, or when stopped.
 */
async function stepWithForces(
  device: GPUDevice,
  solver: GpuSolver,
  stopAtSteps: number,
  onSample: (sample: ForceSample) => boolean,
): Promise<void> {
  while (solver.stepCount < stopAtSteps) {
    const encoder = device.createCommandEncoder();
    solver.step(encoder, Math.min(FORCE_EVERY_STEPS, stopAtSteps - solver.stepCount), false);
    solver.encodeForce(encoder);
    device.queue.submit([encoder.finish()]);
    const sample = await solver.readForce();
    if (sample === 'busy') throw new Error('The force readback was still busy after its batch.');
    if (!onSample(sample)) return;
  }
}

async function createSolver(
  device: GPUDevice,
  settings: Settings,
  tier: Tier,
  grid: ReturnType<typeof voxelize>,
  options: { viscosityLu: number; uLu: number; les: boolean },
): Promise<GpuSolver> {
  const solver = await GpuSolver.create(device, TIERS[tier], grid, {
    tau0: 3 * options.viscosityLu + 0.5,
    uIn: options.uLu,
    les: options.les,
    operator: settings.operator,
    walls: settings.walls,
    precision: resolveStorage(settings.storage, device.features),
  });
  if (solver instanceof AllocationFailure) {
    throw new Error(`Tier ${tier} could not be allocated on this GPU.`);
  }
  return solver;
}

function bodyOrThrow(presetId: string): Body {
  const body = bodyFor(presetId, undefined);
  if (body === null) throw new Error(`The preset ${presetId} has no built-in geometry.`);
  return body;
}

/**
 * Run one validation case to its step count without drawing. Forces are
 * reported in newtons on the case's physical scales; the viscosity follows the
 * case's own Reynolds number and never the interactive floor.
 */
export async function runCase(
  device: GPUDevice,
  settings: Settings & { tier: Tier },
  parameters: CaseParameters,
): Promise<SolverRun | { error: string }> {
  const layout = TIERS[settings.tier];
  const body = bodyOrThrow(settings.presetId);
  const lengthCells =
    parameters.lengthCells ?? runLengthCells(settings.presetId, body.mesh, layout, settings.floor);
  const grid = voxelBody(body, settings, settings.tier, lengthCells, parameters.supportsInForce);
  const scales = caseScales(settings, parameters, lengthCells);
  const solver = await createSolver(device, settings, settings.tier, grid, {
    viscosityLu: scales.viscosityLu,
    uLu: parameters.uLu,
    les: parameters.les,
  });
  const newtonsPerForce = RHO_AIR * (scales.speedMps / parameters.uLu) ** 2 * scales.cellSizeM ** 2;
  const forces: ForceSample[] = [];
  let failedAt: number | null = null;
  const started = performance.now();
  try {
    await stepWithForces(device, solver, parameters.stopAtSteps, (sample) => {
      if (![sample.fx, sample.fy, sample.fz].every(Number.isFinite)) {
        failedAt = sample.step;
        return false;
      }
      forces.push({
        step: sample.step,
        fx: sample.fx * newtonsPerForce,
        fy: sample.fy * newtonsPerForce,
        fz: sample.fz * newtonsPerForce,
      });
      return true;
    });
  } finally {
    solver.destroy();
  }
  if (failedAt !== null) {
    return { error: `The force was not finite at step ${failedAt} of ${parameters.stopAtSteps}.` };
  }
  return {
    forces,
    steps: parameters.stopAtSteps,
    msPerStep: (performance.now() - started) / parameters.stopAtSteps,
    voxelAreaM2: grid.frontalCells * scales.cellSizeM ** 2,
    blockage: grid.frontalCells / (layout.ny * layout.nz),
  };
}

/** Refine the grid at a fixed Reynolds number, including when the live run hits the floor. */
export function gridCheckViscosity(re: number, lengthCells: number): number {
  if (!(re > 0) || !Number.isFinite(re) || !(lengthCells > 0) || !Number.isFinite(lengthCells)) {
    throw new RangeError('Grid refinement needs a positive Reynolds number and body length.');
  }
  return (U_LU * lengthCells) / re;
}

export async function runBodyGridCheck(
  device: GPUDevice,
  settings: Settings,
  body: Body,
  current: GridCheckOptions['current'],
  signal: AbortSignal,
  hash: string,
) {
  const preset = presetById(settings.presetId);
  const re = (U_LU * current.lengthCells) / viscosityLu(settings, current.lengthCells);
  const runFlowThroughs = runFlowThroughsFromHash(hash);
  const runner: GridCheckRunner = async (request) => {
    const layout = TIERS[request.tier];
    const grid = voxelBody(body, settings, request.tier, request.lengthCells, false);
    const cellSizeMm = settings.bodyLengthMm / request.lengthCells;
    const cdPerForce = cdPerLatticeForce(
      referenceAreaCells(preset?.refAreaMm2, grid.frontalCells, cellSizeMm),
    );
    const release = await acquireSolverSlot(request.signal);
    let solver: GpuSolver;
    try {
      solver = await createSolver(device, settings, request.tier, grid, {
        viscosityLu: gridCheckViscosity(re, request.lengthCells),
        uLu: U_LU,
        les: true,
      });
    } catch (error) {
      release();
      throw error;
    }
    let stopped = false;
    const history: ForceHistoryPoint[] = [];
    const steps = gridCheckSteps(request.tier, runFlowThroughs).totalSteps;
    void stepWithForces(device, solver, steps, (sample) => {
      history.push([sample.step, sample.fx * cdPerForce]);
      request.onHistory(history);
      return !stopped && !request.signal.aborted;
    })
      .catch(() => {
        // A failed run still has to end its tier; a non-finite mean reads as no usable Cd.
        history.push([Number.MAX_SAFE_INTEGER, Number.NaN]);
        request.onHistory(history);
      })
      .finally(() => {
        solver.destroy();
        release();
      });
    return {
      nx: layout.nx,
      dispose() {
        stopped = true;
      },
    };
  };
  const result = await runGridCheck({
    current,
    runFlowThroughs,
    runner,
    restore: async () => {},
    signal,
  });
  return { ...result, re };
}

/** Published preset checks start at S; finer runs retain its effective Reynolds number. */
export async function runPresetGridCheck(device: GPUDevice, settings: Settings, hash: string) {
  const preset = presetById(settings.presetId);
  if (preset === undefined) throw new Error(`The preset ${settings.presetId} is not shipped.`);
  const presetSettings = { ...settings, bodyLengthMm: preset.bodyLengthMm };
  const body = bodyOrThrow(settings.presetId);
  const result = await runBodyGridCheck(
    device,
    presetSettings,
    body,
    {
      lengthCells: runLengthCells(settings.presetId, body.mesh, TIERS.S, settings.floor),
      nx: TIERS.S.nx,
    },
    new AbortController().signal,
    hash,
  );
  if (result.kind !== 'done') throw new Error('The grid check was cancelled.');
  return { ...result.band, re: result.re, rows: result.rows };
}

function publish(key: 'result' | 'gridCheck', value: unknown): void {
  Reflect.set(window, '__pwt', { [key]: value });
}

async function unattendedDevice(tier: Tier): Promise<GPUDevice> {
  const support = await detectGpu('gpu' in navigator ? navigator.gpu : undefined, {
    xl: tier === 'XL',
  });
  if (support.status === 'unsupported') {
    throw new Error(`WebGPU is unavailable in this browser (${support.reason}).`);
  }
  const allowed = support.tierPolicy === 's-only' ? ['S'] : ['S', 'M', 'L'];
  if (support.tierPolicy === 's-m-l-xl') allowed.push('XL');
  if (!allowed.includes(tier)) {
    throw new Error(`This adapter's limits do not allow tier ${tier}.`);
  }
  return support.device;
}

/**
 * Run the case or grid check the hash describes and publish it on
 * `window.__pwt`; a failure is published as `{ error }` so the runner records
 * the reason instead of waiting for its timeout.
 */
export async function runUnattended(root: HTMLElement, hash: string): Promise<void> {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Running a validation case.';
  root.replaceChildren(status);
  Reflect.deleteProperty(window, '__pwt');
  let key: 'result' | 'gridCheck' = 'result';
  let device: GPUDevice | undefined;
  try {
    const request = unattendedRequest(hash);
    const settings = decodeShareLink(hash).settings;
    const tier = settings.tier === 'auto' ? 'S' : settings.tier;
    device = await unattendedDevice(request.kind === 'case' ? tier : 'L');
    if (request.kind === 'grid-check') {
      key = 'gridCheck';
      publish(key, await runPresetGridCheck(device, settings, hash));
    } else {
      publish(key, await runCase(device, { ...settings, tier }, request.parameters));
    }
    status.textContent = 'The validation case finished.';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publish(key, { error: message });
    status.textContent = `The validation case failed. ${message}`;
  } finally {
    device?.destroy();
  }
}
