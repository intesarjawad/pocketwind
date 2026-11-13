import { physicalToLattice } from '../lbm/units';
import { clampSpeedMps, DEFAULT_SETTINGS } from './params';
import type { Settings } from './settings';

export type SettingKey = keyof Settings;
export type ChangeKind = 'restart' | 'live' | 'view';

export type StoreChange = {
  settings: Settings;
  changed: readonly SettingKey[];
  kind: ChangeKind;
  /** Increments only when the next frame must rebuild the simulation. */
  generation: number;
};

export type SettingsStore = {
  readonly settings: Settings;
  readonly generation: number;
  subscribe: (listener: (change: StoreChange) => void) => () => void;
  update: (patch: Partial<Settings>) => StoreChange;
  replace: (settings: Settings) => StoreChange;
  restart: () => StoreChange;
};

const SETTING_KEYS: readonly SettingKey[] = [
  'presetId',
  'tier',
  'storage',
  'operator',
  'walls',
  'speedMps',
  'bodyLengthMm',
  'flowAxis',
  'flowSign',
  'upAxis',
  'floor',
  'paused',
  'compare',
];

/** Tier, storage, collision and geometry all allocate buffers or rebuild cell data. */
const RESTART_KEYS = new Set<SettingKey>([
  'presetId',
  'tier',
  'storage',
  'operator',
  'walls',
  'bodyLengthMm',
  'flowAxis',
  'flowSign',
  'upAxis',
  'floor',
]);

function sameSetting(a: Settings, b: Settings, key: SettingKey): boolean {
  if (key === 'compare') return a.compare.enabled === b.compare.enabled;
  return a[key] === b[key];
}

export function changeKind(changed: readonly SettingKey[]): ChangeKind {
  if (changed.some((key) => RESTART_KEYS.has(key))) return 'restart';
  if (changed.includes('speedMps')) return 'live';
  return 'view';
}

/** Relaxation time follows the current speed without rebuilding the grid. */
export function viscosityLu(settings: Settings, refLengthCells: number): number {
  return physicalToLattice({
    speedMps: settings.speedMps,
    refLengthM: settings.bodyLengthMm / 1000,
    refLengthCells,
  }).viscosityLu;
}

export function createStore(initial: Settings = DEFAULT_SETTINGS): SettingsStore {
  let settings = { ...initial, compare: { ...initial.compare } };
  let generation = 0;
  const listeners = new Set<(change: StoreChange) => void>();

  function emit(changed: readonly SettingKey[]): StoreChange {
    const kind = changeKind(changed);
    if (kind === 'restart') generation += 1;
    const change: StoreChange = { settings, changed, kind, generation };
    for (const listener of [...listeners]) listener(change);
    return change;
  }

  function replace(next: Settings): StoreChange {
    const sanitized = {
      ...next,
      speedMps: clampSpeedMps(next.speedMps),
      compare: { ...next.compare },
    };
    const changed = SETTING_KEYS.filter((key) => !sameSetting(settings, sanitized, key));
    if (changed.length === 0) return { settings, changed, kind: 'view', generation };
    settings = sanitized;
    return emit(changed);
  }

  return {
    get settings() {
      return settings;
    },
    get generation() {
      return generation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      return replace({ ...settings, ...patch });
    },
    replace,
    restart() {
      generation += 1;
      const change: StoreChange = { settings, changed: [], kind: 'restart', generation };
      for (const listener of [...listeners]) listener(change);
      return change;
    },
  };
}
