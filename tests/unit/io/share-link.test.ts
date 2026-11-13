import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../../src/app/settings';
import {
  DEFAULT_SETTINGS,
  decodeShareLink,
  encodeShareLink,
  SETTINGS_PARAMS,
} from '../../../src/io/share-link';

const SETTINGS: Settings = {
  presetId: 'ahmed-25',
  tier: 'M',
  storage: 'f32',
  operator: 'trt',
  walls: 'bb',
  speedMps: 10,
  bodyLengthMm: 100,
  flowAxis: 'x',
  flowSign: 1,
  upAxis: 'z',
  floor: true,
  paused: true,
  compare: { enabled: true },
};

// One non-default value per setting parameter, written by hand from the parameter table.
const CHANGES: ReadonlyArray<{
  param: string;
  value: string;
  expected: Partial<Settings>;
}> = [
  { param: 'p', value: 'sphere', expected: { presetId: 'sphere' } },
  { param: 'p', value: 'none', expected: { presetId: 'none' } },
  { param: 't', value: 'XL', expected: { tier: 'XL' } },
  { param: 't', value: 'auto', expected: { tier: 'auto' } },
  { param: 'st', value: 'f16', expected: { storage: 'f16' } },
  { param: 'op', value: 'reg', expected: { operator: 'reg' } },
  { param: 'w', value: 'bouzidi', expected: { walls: 'bouzidi' } },
  { param: 'v', value: '25.5', expected: { speedMps: 25.5 } },
  { param: 'len', value: '300', expected: { bodyLengthMm: 300 } },
  { param: 'ax', value: 'y', expected: { flowAxis: 'y' } },
  { param: 'sg', value: '-1', expected: { flowSign: -1 } },
  { param: 'up', value: 'y', expected: { upAxis: 'y' } },
  { param: 'fl', value: '0', expected: { floor: false } },
];

const RUNNER_PARAMS = [
  'cam=side',
  'record=1',
  'embed=1',
  'auto=1',
  'stopAt=5000',
  're=1000000',
  'les=0',
  'lc=64',
  'inject_nan=1',
  'gcT=2',
  'gc=1',
  'ramp=2',
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('share link', () => {
  it('encodes every restorable setting in a stable order', () => {
    expect(encodeShareLink(SETTINGS, 'validate')).toBe(
      '#/validate?p=ahmed-25&t=M&st=f32&op=trt&w=bb&v=10&len=100&ax=x&sg=1&up=z&fl=1',
    );
  });

  it('names exactly the setting parameters in the table', () => {
    expect([...SETTINGS_PARAMS].sort()).toEqual(
      ['p', 't', 'st', 'op', 'w', 'v', 'len', 'ax', 'sg', 'up', 'fl'].sort(),
    );
  });

  it.each(CHANGES)('reads $param=$value into its setting', ({ param, value, expected }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = decodeShareLink(`#/?${param}=${value}`);
    expect(decoded.settings).toEqual({ ...DEFAULT_SETTINGS, ...expected });
    expect(warn).not.toHaveBeenCalled();
  });

  it('round-trips a run that changes every setting', () => {
    const changed: Settings = {
      presetId: 'cube',
      tier: 'L',
      storage: 'f16',
      operator: 'reg',
      walls: 'bouzidi',
      speedMps: 33,
      bodyLengthMm: 250,
      flowAxis: 'y',
      flowSign: -1,
      upAxis: 'x',
      floor: false,
      paused: false,
      compare: { enabled: false },
    };
    expect(decodeShareLink(encodeShareLink(changed)).settings).toEqual(changed);
  });

  it('round-trips the settings and keeps the route', () => {
    const decoded = decodeShareLink(encodeShareLink(SETTINGS, 'bench'));
    expect(decoded.route).toBe('bench');
    expect(decoded.settings).toEqual({
      ...SETTINGS,
      floor: true,
      paused: false,
      compare: { enabled: false },
    });
    expect(decoded.excludesCustomGeometry).toBe(false);
  });

  it('leaves a custom model file out of the link and says so', () => {
    const link = encodeShareLink({ ...SETTINGS, presetId: 'custom' }, '');
    expect(link).not.toContain('wing.stl');
    expect(link).not.toContain('customGeometry');

    const decoded = decodeShareLink(link);
    expect(decoded.route).toBe('');
    expect(decoded.settings.presetId).toBe('custom');
    expect(decoded.excludesCustomGeometry).toBe(true);
  });

  it('accepts the runner and camera parameters without a warning or a settings change', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const route of ['', 'validate', 'bench']) {
      const decoded = decodeShareLink(`#/${route}?${RUNNER_PARAMS.join('&')}&tiers=S,M&steps=100`);
      expect(decoded.route).toBe(route);
      expect(decoded.settings).toEqual(DEFAULT_SETTINGS);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses defaults for a bare route', () => {
    expect(decodeShareLink('#/')).toEqual({
      route: '',
      settings: DEFAULT_SETTINGS,
      excludesCustomGeometry: false,
    });
  });

  it('clamps the speed to the slider range', () => {
    expect(decodeShareLink('#/?v=90').settings.speedMps).toBe(60);
    expect(decodeShareLink('#/?v=1').settings.speedMps).toBe(5);
    expect(decodeShareLink('#/?v=32.5').settings.speedMps).toBe(32.5);
  });

  it('ignores unknown parameters with a warning, including the old long names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = decodeShareLink('#/validate?p=sphere&unknown=1&preset=cube');
    expect(decoded.settings.presetId).toBe('sphere');
    expect(warn).toHaveBeenCalledWith('Ignoring unknown hash parameter "unknown".');
    expect(warn).toHaveBeenCalledWith('Ignoring unknown hash parameter "preset".');
  });

  it('ignores unknown routes and invalid values with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = decodeShareLink('#/nope?v=fast&t=XX');
    expect(decoded.route).toBe('');
    expect(decoded.settings.speedMps).toBe(DEFAULT_SETTINGS.speedMps);
    expect(decoded.settings.tier).toBe(DEFAULT_SETTINGS.tier);
    expect(warn).toHaveBeenCalledWith('Ignoring unknown hash route "nope".');
    expect(warn).toHaveBeenCalledWith('Ignoring hash parameter "v" with a non-finite number.');
    expect(warn).toHaveBeenCalledWith('Ignoring hash parameter "t" with an unknown value.');
  });

  it('keeps flow and up axes different', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = decodeShareLink('#/?ax=x&up=x');
    expect(decoded.settings.flowAxis).toBe('x');
    expect(decoded.settings.upAxis).toBe('z');
    expect(warn).toHaveBeenCalledWith(
      'Ignoring hash parameter "up" because flow and up axes must differ.',
    );
  });

  it('falls back for a length that cannot describe a body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(decodeShareLink('#/?len=0').settings.bodyLengthMm).toBe(DEFAULT_SETTINGS.bodyLengthMm);
    expect(warn).toHaveBeenCalledWith('Ignoring hash parameter "len" with a non-positive number.');
  });

  it('falls back for a flow sign or floor flag it does not know', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = decodeShareLink('#/?sg=2&fl=yes');
    expect(decoded.settings.flowSign).toBe(DEFAULT_SETTINGS.flowSign);
    expect(decoded.settings.floor).toBe(DEFAULT_SETTINGS.floor);
    expect(warn).toHaveBeenCalledWith('Ignoring hash parameter "sg" with an unknown value.');
    expect(warn).toHaveBeenCalledWith('Ignoring hash parameter "fl" with an unknown value.');
  });
});
