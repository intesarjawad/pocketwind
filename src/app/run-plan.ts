import { presetMesh, presetSupports } from '../geometry/presets';
import type { Mesh } from '../geometry/stl';
import { defaultLengthCells } from '../geometry/transform';
import type { Layout } from '../geometry/voxel-grid';
import type { TierPolicy } from '../gpu/device';
import type { RunFile } from '../io/run-file';
import { decodeShareLink, SETTINGS_PARAMS } from '../io/share-link';
import { NU_AIR, U_LU } from '../lbm/units';
import { AHMED_25_REFERENCE_CD, flowThroughSteps, LAMINAR_SPHERE_RE } from '../validation/cases';
import { type ForceReportUpdate, windowStepsFor } from './force-plot';
import { presetById } from './params';
import type { Settings, Tier, TierChoice } from './settings';

export type Body = { readonly mesh: Mesh; readonly supports: Mesh | null; readonly label: string };

// The interactive Ahmed run uses half the streamwise domain, like the validation case.
const AHMED_BODY_LENGTH_FRACTION = 0.5;

/**
 * Automatic tier selection needs a measured probe; until then S is the only
 * choice that always fits the default limits, so it is the safe automatic answer.
 * XL needs the raised limits, so without them a chosen XL runs as L.
 */
export function runTier(choice: TierChoice, tierPolicy: TierPolicy): Tier {
  if (tierPolicy === 's-only' || choice === 'auto') return 'S';
  if (choice === 'XL' && tierPolicy !== 's-m-l-xl') return 'L';
  return choice;
}

/**
 * A preset keeps a fixed share of the domain so its cell size follows the tier;
 * a dropped model is placed against the blockage and length caps instead.
 */
export function runLengthCells(
  presetId: string,
  mesh: Mesh,
  layout: Layout,
  floor: boolean,
): number {
  if (presetId === 'none') return layout.nx;
  if (presetId === 'ahmed-25') {
    return Math.max(1, Math.round(layout.nx * AHMED_BODY_LENGTH_FRACTION));
  }
  return defaultLengthCells(mesh, layout, floor);
}

/** The rendered version of the validation sphere, selected explicitly in the hash. */
export function laminarPlate(hash: string, settings: Settings, nx: number) {
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  if (
    params.get('laminar') !== '1' ||
    settings.presetId !== 'sphere' ||
    settings.floor ||
    settings.operator !== 'trt' ||
    settings.walls !== 'bb'
  )
    return null;
  const lengthCells = nx / 8;
  return {
    lengthCells,
    speedMps: (LAMINAR_SPHERE_RE * NU_AIR) / (settings.bodyLengthMm / 1000),
    viscosityLu: (U_LU * lengthCells) / LAMINAR_SPHERE_RE,
  };
}

/** A route without run parameters keeps the session's choices; a share link replaces them. */
export function settingsFromHash(hash: string, current: Settings): Settings {
  const query = hash.split('?')[1];
  if (query === undefined) return current;
  // Other hash parameters (camera, route) never describe a run.
  const carriesSettings = [...new URLSearchParams(query).keys()].some((name) =>
    SETTINGS_PARAMS.has(name),
  );
  return carriesSettings ? decodeShareLink(hash).settings : current;
}

export function bodyFor(
  presetId: string,
  dropped: Mesh | undefined,
  fileName = 'Dropped model',
): Body | null {
  if (presetId === 'none')
    return {
      mesh: { positions: new Float32Array(), triangleCount: 0 },
      supports: null,
      label: 'Empty tunnel',
    };
  if (presetId === 'custom') {
    return dropped === undefined ? null : { mesh: dropped, supports: null, label: fileName };
  }
  const mesh = presetMesh(presetId);
  if (mesh === null) return null;
  return {
    mesh,
    supports: presetSupports(presetId),
    label: presetById(presetId)?.name ?? 'Preset body',
  };
}

/** Pick the run inputs from a saved file without its measured fields. */
export function settingsOfRun(run: RunFile): Settings {
  return {
    presetId: run.presetId,
    tier: run.tier,
    storage: run.storage,
    operator: run.operator,
    walls: run.walls,
    speedMps: run.speedMps,
    bodyLengthMm: run.bodyLengthMm,
    flowAxis: run.flowAxis,
    flowSign: run.flowSign,
    upAxis: run.upAxis,
    floor: run.floor,
    paused: run.paused,
    compare: { enabled: run.compare.enabled },
  };
}

/** A saved run replaces the live plot so an exported result can be read back. */
export function runFileReport(run: RunFile): ForceReportUpdate {
  return {
    history: run.forceHistory,
    cdaM2: run.cdaM2,
    windowSteps: windowStepsFor(flowThroughSteps(run.grid.nx)),
    ...(run.presetId === 'ahmed-25' ? { referenceCd: AHMED_25_REFERENCE_CD } : {}),
    readout: {
      summary: {
        cd: run.cd,
        status: run.status,
        samples: run.forceHistory.length,
        ...(run.semPct === null ? {} : { semPct: run.semPct }),
      },
      speedMps: run.speedMps,
      dragForceN: run.dragForceN,
      grid: run.grid,
      referenceAreaSource: run.referenceAreaRule,
      ...(run.viscosityFloor === true && run.effectiveRe !== null
        ? { effectiveRe: run.effectiveRe }
        : {}),
    },
  };
}
