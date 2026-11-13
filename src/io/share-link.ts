import { clampSpeedMps, DEFAULT_SETTINGS } from '../app/params';
import type {
  Axis,
  FlowSign,
  Settings,
  Storage,
  StorageChoice,
  Tier,
  TierChoice,
} from '../app/settings';
import { TIERS } from '../lbm/layout';

export const SHARE_ROUTES = ['', 'validate', 'bench'] as const;
export type ShareRoute = (typeof SHARE_ROUTES)[number];

export type DecodedShareLink = {
  route: ShareRoute;
  settings: Settings;
  /** A custom run keeps its preset in the link; its model file cannot travel with it. */
  excludesCustomGeometry: boolean;
};

export { DEFAULT_SETTINGS };

/** Hash parameters that carry a `Settings` field; camera and runner parameters do not. */
export const SETTINGS_PARAMS: ReadonlySet<string> = new Set([
  'p',
  't',
  'st',
  'op',
  'w',
  'v',
  'len',
  'ax',
  'sg',
  'up',
  'fl',
]);

// Read by the camera, the run or a results route rather than by the settings.
const OTHER_PARAMS: ReadonlySet<string> = new Set([
  'cam',
  'laminar',
  'record',
  'embed',
  'auto',
  'stopAt',
  're',
  'les',
  'lc',
  'ulu',
  'stilts',
  'inject_nan',
  'gcT',
  'gc',
  'tiers',
  'steps',
  'ramp',
]);

/** Said next to a copied link whose run depends on a model file the link cannot carry. */
export const CUSTOM_LINK_NOTE = 'This link excludes the model file. Open it with the same file.';

function isTier(value: string | null): value is Tier {
  return value !== null && Object.hasOwn(TIERS, value);
}

function isTierChoice(value: string | null): value is TierChoice {
  return value === 'auto' || isTier(value);
}

function isStorage(value: string | null): value is Storage {
  return value === 'f32' || value === 'f16';
}

function isStorageChoice(value: string | null): value is StorageChoice {
  return value === 'auto' || isStorage(value);
}

function isAxis(value: string | null): value is Axis {
  return value === 'x' || value === 'y' || value === 'z';
}

function isOperator(value: string | null): value is Settings['operator'] {
  return value === 'trt' || value === 'reg';
}

function isWalls(value: string | null): value is Settings['walls'] {
  return value === 'bb' || value === 'bouzidi';
}

function isShareRoute(value: string): value is ShareRoute {
  return (SHARE_ROUTES as readonly string[]).includes(value);
}

/**
 * Encode settings into the hash form `#/<route>?<params>`. Paused and compare
 * state are deliberately absent: neither describes the flow, and a custom run
 * is recognised by its `custom` preset.
 */
export function encodeShareLink(settings: Settings, route: ShareRoute = ''): string {
  const params = new URLSearchParams({
    p: settings.presetId,
    t: settings.tier,
    st: settings.storage,
    op: settings.operator,
    w: settings.walls,
    v: String(clampSpeedMps(settings.speedMps)),
    len: String(settings.bodyLengthMm),
    ax: settings.flowAxis,
    sg: String(settings.flowSign),
    up: settings.upAxis,
    fl: settings.floor ? '1' : '0',
  });
  return `#/${route}?${params.toString()}`;
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`Ignoring hash parameter "${name}" with a non-finite number.`);
    return fallback;
  }
  return value;
}

function positiveParam(params: URLSearchParams, name: string, fallback: number): number {
  const value = numberParam(params, name, fallback);
  if (value <= 0) {
    console.warn(`Ignoring hash parameter "${name}" with a non-positive number.`);
    return fallback;
  }
  return value;
}

function optionParam<T extends string>(
  params: URLSearchParams,
  name: string,
  fallback: T,
  isValid: (value: string | null) => value is T,
): T {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!isValid(raw)) {
    console.warn(`Ignoring hash parameter "${name}" with an unknown value.`);
    return fallback;
  }
  return raw;
}

function flowSignParam(params: URLSearchParams): FlowSign {
  const raw = params.get('sg');
  if (raw === null) return DEFAULT_SETTINGS.flowSign;
  if (raw === '1' || raw === '-1') return raw === '1' ? 1 : -1;
  console.warn('Ignoring hash parameter "sg" with an unknown value.');
  return DEFAULT_SETTINGS.flowSign;
}

function floorParam(params: URLSearchParams): boolean {
  const raw = params.get('fl');
  if (raw === null) return DEFAULT_SETTINGS.floor;
  if (raw === '1') return true;
  if (raw === '0') return false;
  console.warn('Ignoring hash parameter "fl" with an unknown value.');
  return DEFAULT_SETTINGS.floor;
}

function upAxisParam(params: URLSearchParams, flowAxis: Axis): Axis {
  const upAxis = optionParam(params, 'up', DEFAULT_SETTINGS.upAxis, isAxis);
  if (upAxis !== flowAxis) return upAxis;
  console.warn('Ignoring hash parameter "up" because flow and up axes must differ.');
  return flowAxis === 'z' ? 'y' : 'z';
}

/**
 * Read the hash a share link produces. Unknown routes and parameters are
 * ignored with a warning so a newer link still opens an older build.
 */
export function decodeShareLink(hash: string): DecodedShareLink {
  const [rawPath, rawQuery = ''] = hash.replace(/^#/, '').split('?');
  const routeName = (rawPath ?? '').replace(/^\//, '');
  let route: ShareRoute = '';
  if (isShareRoute(routeName)) {
    route = routeName;
  } else {
    console.warn(`Ignoring unknown hash route "${routeName}".`);
  }

  const params = new URLSearchParams(rawQuery);
  for (const name of params.keys()) {
    if (!SETTINGS_PARAMS.has(name) && !OTHER_PARAMS.has(name))
      console.warn(`Ignoring unknown hash parameter "${name}".`);
  }

  const preset = params.get('p');
  const flowAxis = optionParam(params, 'ax', DEFAULT_SETTINGS.flowAxis, isAxis);
  const settings: Settings = {
    presetId: preset === null || preset === '' ? DEFAULT_SETTINGS.presetId : preset,
    tier: optionParam(params, 't', DEFAULT_SETTINGS.tier, isTierChoice),
    storage: optionParam(params, 'st', DEFAULT_SETTINGS.storage, isStorageChoice),
    operator: optionParam(params, 'op', DEFAULT_SETTINGS.operator, isOperator),
    walls: optionParam(params, 'w', DEFAULT_SETTINGS.walls, isWalls),
    speedMps: clampSpeedMps(numberParam(params, 'v', DEFAULT_SETTINGS.speedMps)),
    bodyLengthMm: positiveParam(params, 'len', DEFAULT_SETTINGS.bodyLengthMm),
    flowAxis,
    flowSign: flowSignParam(params),
    upAxis: upAxisParam(params, flowAxis),
    floor: floorParam(params),
    paused: DEFAULT_SETTINGS.paused,
    compare: { ...DEFAULT_SETTINGS.compare },
  };
  return { route, settings, excludesCustomGeometry: settings.presetId === 'custom' };
}
