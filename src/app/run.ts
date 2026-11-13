import { createDragStats } from '../forces/drag-stats';
import { cdaM2, dragForceFromCda } from '../forces/physical';
import { frontalAreaM2, referenceAreaCells } from '../forces/reference-area';
import type { Mesh } from '../geometry/stl';
import { placeMesh } from '../geometry/transform';
import type { Layout } from '../geometry/voxel-grid';
import { voxelize } from '../geometry/voxelize';
import type { TierPolicy } from '../gpu/device';
import { BUILD_COMMIT } from '../io/build-info';
import { isCardFormat, renderResultCard } from '../io/result-card';
import type { RunMeasurements } from '../io/run-export';
import type { ForceHistoryPoint } from '../io/run-file';
import {
  AllocationFailure,
  FORCE_EVERY_STEPS,
  type ForceSample,
  GpuSolver,
} from '../lbm/gpu-solver';
import { TIERS } from '../lbm/layout';
import { OPERATORS, STORAGES, WALLS } from '../lbm/params';
import { resolveStorage } from '../lbm/precision';
import { allocateWithStepDown } from '../lbm/tier-probe';
import { cdPerLatticeForce, NU_MIN_LU, U_LU } from '../lbm/units';
import { cameraPresetFromHash } from '../render/camera';
import type { DomainBounds } from '../render/lines-pipeline';
import { createPlate } from '../render/plate';
import { secondsPerStep } from '../render/plate-layout';
import { createScene } from '../render/scene';
import { AHMED_25_REFERENCE_CD, flowThroughSteps } from '../validation/cases';
import { type ForceReportUpdate, windowStepsFor } from './force-plot';
import { MESSAGES } from './messages';
import { presetById } from './params';
import { laminarPlate, runLengthCells, runTier } from './run-plan';
import type { Settings } from './settings';
import { acquireSolverSlot } from './solver-slot';
import { viscosityLu } from './store';
import { createRunMarks } from './timing';

type Tier = keyof typeof TIERS;

// One force sample per frame keeps the eight-step readback cadence without a queue.
const STEPS_PER_FRAME = FORCE_EVERY_STEPS;
// A long session keeps a bounded plot; the live readout always uses the newest window.
const HISTORY_LIMIT = 2048;

/**
 * Past the limit, the older half of the record keeps every other sample, so the
 * start-up transient stays in the record however long the run, ever more sparsely,
 * as a log time axis wants it.
 */
export function thinHistory(history: ForceHistoryPoint[], limit: number): void {
  if (history.length <= limit) return;
  const older = Math.floor(history.length / 2);
  history.splice(0, older, ...history.slice(0, older).filter((_, index) => index % 2 === 0));
}

/** The stability script reads this; the page never writes it back. */
export type RunProgress = {
  readonly step: number;
  readonly finite: boolean;
  readonly history: readonly ForceHistoryPoint[];
};

declare global {
  interface Window {
    __pocketwindRun?: RunProgress;
  }
}

function publishProgress(
  step: number,
  finite: boolean,
  history: readonly ForceHistoryPoint[],
): void {
  window.__pocketwindRun = { step, finite, history: [...history] };
}

/** The stability script ramps the inlet with `ramp=<flow-throughs>` in the hash. */
function rampFlowThroughsFromHash(): number {
  const query = location.hash.split('?')[1];
  if (query === undefined) return 0;
  const value = Number(new URLSearchParams(query).get('ramp'));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export type RunHandle = {
  readonly history: readonly ForceHistoryPoint[];
  /** The newest results in the form a run file stores them. */
  snapshot: () => RunMeasurements;
  /** The current view and newest results as a 1200×675 PNG. */
  resultCard: () => Promise<Blob>;
  dispose: () => void;
};

export type StartRunOptions = {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly settings: Settings;
  readonly mesh: Mesh;
  /** Stand under the body and carry no body force. */
  readonly supports: Mesh | null;
  readonly bodyLabel: string;
  readonly tierPolicy: TierPolicy;
  readonly compare?: readonly ForceHistoryPoint[];
  readonly onUpdate: (update: ForceReportUpdate) => void;
  readonly onNotice?: (message: string) => void;
  /** A kept smoke front: physical time since the flow started, and its points on the canvas. */
  readonly onExposure?: (exposure: PlateExposure) => void;
  readonly signal: AbortSignal;
};

export type PlateExposure = {
  readonly milliseconds: number;
  readonly points: readonly (readonly [number, number])[];
  readonly band: number;
  readonly gap?: {
    readonly under: readonly [number, number];
    readonly below: readonly [number, number];
    readonly speed: number;
  };
};

/** A camera in the link asks for the orbit view; otherwise the run draws the smoke plate. */
export function wantsOrbit(hash: string): boolean {
  const query = hash.split('?')[1] ?? hash.replace(/^#\/?/, '');
  return new URLSearchParams(query).has('cam');
}

type TierRun = {
  readonly history: readonly ForceHistoryPoint[];
  readonly snapshot: () => RunMeasurements;
  readonly resultCard: () => Promise<Blob>;
  readonly dispose: () => void;
};

function meshBounds(mesh: Mesh): DomainBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const point = [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]];
    for (const [axis, value] of point.entries()) {
      if (value === undefined || !Number.isFinite(value)) {
        throw new RangeError('A placed model coordinate must be finite.');
      }
      min[axis] = Math.min(min[axis] ?? value, value);
      max[axis] = Math.max(max[axis] ?? value, value);
    }
  }
  return { min, max };
}

function unsupportedChoices(settings: Settings): string[] {
  const unsupported: string[] = [];
  if (!(OPERATORS as readonly string[]).includes(settings.operator)) unsupported.push('operator');
  if (!(WALLS as readonly string[]).includes(settings.walls)) unsupported.push('walls');
  if (!(STORAGES as readonly string[]).includes(settings.storage) && settings.storage !== 'auto') {
    unsupported.push('storage');
  }
  return unsupported;
}

/**
 * Allocate the requested tier, retrying one tier lower on an allocation failure.
 * The callback rebuilds voxel data for the smaller grid, because cell sizes and
 * the placed body both depend on the layout.
 */
async function createRunForTier(
  options: StartRunOptions,
  tier: Tier,
): Promise<TierRun | AllocationFailure> {
  const { settings } = options;
  const layout: Layout = TIERS[tier];
  const laminar = laminarPlate(location.hash, settings, layout.nx);
  const lengthCells =
    laminar?.lengthCells ?? runLengthCells(settings.presetId, options.mesh, layout, settings.floor);
  const empty = settings.presetId === 'none';
  const placed = empty
    ? { body: options.mesh, supports: null }
    : placeMesh(options.mesh, {
        layout,
        lengthCells,
        flowAxis: settings.flowAxis,
        flowSign: settings.flowSign,
        upAxis: settings.upAxis,
        floor: settings.floor,
        ...(options.supports === null ? {} : { supports: options.supports }),
      });
  const grid = voxelize(placed.body, placed.supports, layout, {
    floor: settings.floor,
    linkFractions: settings.walls === 'bouzidi',
  });
  if (!empty && grid.solidCells === 0) {
    throw new Error('The model does not cover any grid cells at this size.');
  }
  const viscosity = laminar?.viscosityLu ?? viscosityLu(settings, lengthCells);
  const flowThrough = flowThroughSteps(layout.nx);
  const precision = resolveStorage(settings.storage, options.device.features);
  const release = await acquireSolverSlot(options.signal);
  let solver: GpuSolver | AllocationFailure;
  try {
    solver = await GpuSolver.create(options.device, layout, grid, {
      tau0: viscosity * 3 + 0.5,
      uIn: U_LU,
      les: laminar === null,
      operator: settings.operator,
      walls: settings.walls,
      precision,
      rampSteps: rampFlowThroughsFromHash() * flowThrough,
    });
  } catch (error) {
    release();
    throw error;
  }
  if (solver instanceof AllocationFailure) {
    release();
    return solver;
  }
  const active: GpuSolver = solver;
  const destroy = (): void => {
    active.destroy();
    release();
  };

  const cellSizeM = settings.bodyLengthMm / 1000 / lengthCells;
  const cellSizeMm = settings.bodyLengthMm / lengthCells;
  const preset = presetById(settings.presetId);
  const presetArea =
    preset && laminar
      ? preset.refAreaMm2 * (settings.bodyLengthMm / preset.bodyLengthMm) ** 2
      : preset?.refAreaMm2;
  const referenceArea = empty ? 1 : referenceAreaCells(presetArea, grid.frontalCells, cellSizeMm);
  const areaM2 = preset
    ? (presetArea ?? preset.refAreaMm2) / 1_000_000
    : frontalAreaM2(grid.frontalCells, cellSizeM);
  if (!empty && !(areaM2 > 0)) {
    destroy();
    throw new Error('The model has no frontal area at this size.');
  }
  const cdPerForce = cdPerLatticeForce(referenceArea);
  const stats = createDragStats(flowThrough, cdPerForce);
  const marks = createRunMarks();
  const history: ForceHistoryPoint[] = [];
  const compare = options.compare ?? [];
  // Lateral and vertical force have no reference case, so only the newest sample is kept.
  let latestFy: number | null = null;
  let latestFz: number | null = null;
  let reading = false;
  let disposed = false;

  function snapshot(): RunMeasurements {
    const summary = stats.summary(null);
    const cdaValue = summary.cd === null ? null : cdaM2(Math.abs(summary.cd), areaM2);
    return {
      summary,
      cdaM2: cdaValue,
      // At the viscosity floor the Cd belongs to a slower, more viscous flow, so it has no force at this speed.
      dragForceN:
        cdaValue === null || viscosity === NU_MIN_LU
          ? null
          : dragForceFromCda(cdaValue, settings.speedMps),
      semPct: summary.semPct ?? null,
      effectiveRe: empty ? null : (U_LU * lengthCells) / viscosity,
      viscosityFloor: viscosity === NU_MIN_LU,
      grid: { nx: layout.nx, ny: layout.ny, nz: layout.nz },
      referenceAreaRule: preset ? 'preset' : 'frontal',
      forceHistory: [...history],
      fy: latestFy,
      fz: latestFz,
    };
  }

  function emit(): void {
    const { summary, dragForceN, forceHistory, cdaM2: cda } = snapshot();
    if (summary.cd !== null) marks.cd();
    if (summary.status.kind !== 'settling') marks.settled();
    options.onUpdate({
      history: forceHistory,
      cdaM2: cda,
      compare,
      windowSteps: windowStepsFor(flowThrough),
      ...(settings.presetId === 'ahmed-25' ? { referenceCd: AHMED_25_REFERENCE_CD } : {}),
      readout: {
        summary,
        speedMps: settings.speedMps,
        dragForceN,
        grid: { nx: layout.nx, ny: layout.ny, nz: layout.nz },
        referenceAreaM2: areaM2,
        referenceAreaSource: preset ? 'preset' : 'frontal',
        ...(!empty && viscosity === NU_MIN_LU
          ? { effectiveRe: (U_LU * lengthCells) / viscosity }
          : {}),
        blockagePct: (100 * grid.frontalCells) / (layout.ny * layout.nz),
      },
    });
  }

  function record(sample: ForceSample): void {
    if (disposed) return;
    if (!Number.isFinite(sample.fx)) {
      publishProgress(sample.step, false, history);
      const message = MESSAGES['run-not-finite'];
      options.onNotice?.(
        `${message.what.replace('step N', `step ${sample.step}`)} ${message.next}`,
      );
      return;
    }
    if (empty) {
      publishProgress(sample.step, true, history);
      return;
    }
    stats.push(sample.step, sample.fx);
    latestFy = Number.isFinite(sample.fy) ? sample.fy * cdPerForce : null;
    latestFz = Number.isFinite(sample.fz) ? sample.fz * cdPerForce : null;
    history.push([sample.step, sample.fx * cdPerForce]);
    thinHistory(history, HISTORY_LIMIT);
    publishProgress(sample.step, true, history);
    emit();
  }

  /**
   * The previous frame's encoder has already been submitted, so its force sample
   * can be mapped now. A pending map skips the next sample instead of queueing.
   */
  function readSample(): void {
    if (reading) return;
    reading = true;
    void active
      .readForce()
      .then((sample) => {
        if (sample !== 'busy') record(sample);
      })
      .catch(() => {
        // Device loss is reported by the scene; a dropped sample needs no message.
      })
      .finally(() => {
        reading = false;
      });
  }

  emit();
  publishProgress(0, true, history);
  try {
    const advance = (encoder: GPUCommandEncoder): number => {
      readSample();
      active.step(encoder, STEPS_PER_FRAME, true);
      active.encodeForce(encoder);
      return STEPS_PER_FRAME;
    };
    const bodyBounds: DomainBounds = empty
      ? { min: [1, layout.ny / 2, 1], max: [layout.nx - 2, layout.ny / 2, layout.nz - 2] }
      : meshBounds(placed.body);
    const stepSeconds = secondsPerStep(cellSizeM, settings.speedMps, U_LU);
    const mounted =
      wantsOrbit(location.hash) && !empty
        ? await createScene(options.canvas, options.device, cameraPresetFromHash(location.hash), {
            signal: options.signal,
            body: { mesh: placed.body, label: options.bodyLabel },
            flow: {
              grid,
              bodyBounds,
              macroBuffer: active.macroBuffer,
              count: TIERS[tier].particles,
              seed: 1,
              advance,
            },
          })
        : await createPlate(options.canvas, options.device, {
            grid,
            macroBuffer: active.macroBuffer,
            body: placed.body.positions,
            supports: placed.supports?.positions ?? null,
            bodyBounds,
            label: options.bodyLabel,
            still: matchMedia('(prefers-reduced-motion: reduce)').matches,
            flowThroughSteps: flowThrough,
            advance,
            onSmoke: () => marks.smoke(),
            onExposure: (exposure) =>
              options.onExposure?.({
                milliseconds: exposure.step * stepSeconds * 1000,
                points: exposure.points,
                band: exposure.band,
                ...(exposure.gap && { gap: exposure.gap }),
              }),
            signal: options.signal,
          });
    void options.device.lost.then((info) => {
      if (options.signal.aborted || info.reason === 'destroyed') return;
      options.canvas.hidden = true;
      const alert = document.createElement('section');
      alert.setAttribute('role', 'alert');
      const title = document.createElement('h1');
      title.textContent = 'The graphics device was lost';
      const message = document.createElement('p');
      message.textContent = 'The current run has stopped. Reload to start a new run.';
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.addEventListener('click', () => location.reload());
      alert.append(title, message, reload);
      document.querySelector('#app')?.replaceChildren(alert);
    });
    const { format, drawInto } = mounted;
    return {
      history,
      snapshot,
      async resultCard() {
        if (!isCardFormat(format)) {
          throw new Error(`A ${format} canvas cannot be saved as an image.`);
        }
        const { summary, cdaM2: cda } = snapshot();
        return await renderResultCard({
          device: options.device,
          format,
          drawFrame: drawInto,
          info: {
            name: options.bodyLabel,
            cd: summary.cd,
            status: summary.status,
            cdaM2: cda,
            grid: { nx: layout.nx, ny: layout.ny, nz: layout.nz },
            openMesh: !grid.watertight,
            effectiveRe: empty ? null : (U_LU * lengthCells) / viscosity,
            viscosityFloor: viscosity === NU_MIN_LU,
            commit: BUILD_COMMIT,
          },
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        mounted.dispose();
        destroy();
      },
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

/** Start one run and return its handle; aborting the signal disposes it before returning null. */
export async function startRun(options: StartRunOptions): Promise<RunHandle | null> {
  options.signal.throwIfAborted();
  const unsupported = unsupportedChoices(options.settings);
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported solver choices: ${unsupported.join(', ')}. Bouzidi walls are disabled for interactive LES: the interpolated wall model is not validated (ADR 013). Choose halfway bounce-back.`,
    );
  }
  if (
    options.settings.storage === 'f16' &&
    resolveStorage(options.settings.storage, options.device.features) === 'f32'
  ) {
    const message = MESSAGES['storage-f16-unavailable'];
    options.onNotice?.(`${message.what} ${message.next}`);
  }

  const requested = runTier(options.settings.tier, options.tierPolicy);
  const allocation = await allocateWithStepDown(requested, (tier) =>
    createRunForTier(options, tier),
  );
  if (allocation.message) {
    options.onNotice?.(`${allocation.message.what} ${allocation.message.next}`);
  }
  if (allocation.status === 'error') {
    throw new Error(`${allocation.message.what} ${allocation.message.next}`);
  }
  if (options.signal.aborted) {
    allocation.value.dispose();
    return null;
  }
  return allocation.value;
}
