import { DEFAULT_SETTINGS } from '../app/params';
import type { Settings } from '../app/settings';
import { encodeShareLink } from '../io/share-link';
import { U_LU } from '../lbm/units';
import type { CaseSpec } from './cases';

const MILLIMETRE_DECIMALS = 6;

/**
 * The hash that runs one case unattended: the settings a person would pick,
 * then the runner parameters that fix the body size in cells, the Reynolds
 * number, the step count and the automatic start.
 */
export function caseHash(spec: CaseSpec): string {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    presetId: spec.shape,
    tier: spec.tier,
    storage: spec.storage,
    operator: spec.operator,
    walls: spec.walls,
    speedMps: spec.speedMps,
    bodyLengthMm: Number(spec.bodyLengthMm.toFixed(MILLIMETRE_DECIMALS)),
    floor: spec.floor,
  };
  const extra = new URLSearchParams();
  // A sphere's speed follows from its Reynolds number, which can fall below the slider range.
  if (spec.shape === 'sphere' && spec.re !== null) extra.set('re', String(spec.re));
  extra.set('les', spec.les ? '1' : '0');
  extra.set('lc', String(spec.bodyLengthCells));
  if (spec.uLu !== U_LU) extra.set('ulu', String(spec.uLu));
  if (spec.sensitivity === 'stilts') extra.set('stilts', spec.stilts ? '1' : '0');
  extra.set('auto', '1');
  extra.set('stopAt', String(spec.steps));
  return `${encodeShareLink(settings)}&${extra.toString()}`;
}

/** The hash that makes a preset report the grid check the button shows. */
export function gridCheckHash(presetId: string): string {
  return `#/?${new URLSearchParams({ p: presetId, gc: '1', auto: '1' }).toString()}`;
}
