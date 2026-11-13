import { DEFAULT_WALLS, defaultOperator } from '../lbm/params';
import type { Settings } from './settings';

export const DEFAULT_SPEED_MPS = 40;
/** The slider covers light indoor flow through to a fast tunnel. */
export const MIN_SPEED_MPS = 5;
export const MAX_SPEED_MPS = 60;

export type Preset = {
  id: string;
  name: string;
  bodyLengthMm: number;
  /** Literature frontal area, so a preset does not inherit the voxel quantisation. */
  refAreaMm2: number;
};

export const PRESETS: readonly Preset[] = [
  { id: 'ahmed-25', name: 'Ahmed body at 25 degrees', bodyLengthMm: 1044, refAreaMm2: 112_000 },
  { id: 'sphere', name: 'Sphere, 100 mm', bodyLengthMm: 100, refAreaMm2: Math.PI * 50 * 50 },
];

export const DEFAULT_SETTINGS: Settings = {
  presetId: 'ahmed-25',
  tier: 'auto',
  storage: 'auto',
  // The app always runs with the sub-grid model on.
  operator: defaultOperator(true),
  walls: DEFAULT_WALLS,
  speedMps: DEFAULT_SPEED_MPS,
  bodyLengthMm: 1044,
  flowAxis: 'x',
  flowSign: 1,
  upAxis: 'z',
  floor: true,
  paused: false,
  compare: { enabled: false },
};

/** Keep the slider and any restored link inside the range the panel offers. */
export function clampSpeedMps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEED_MPS;
  return Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, value));
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
