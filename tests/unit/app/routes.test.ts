import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import {
  currentRoute,
  isEmbedRoute,
  ROUTE_TITLES,
  readRoute,
  routeHash,
  tunnelHiddenOn,
} from '../../../src/app/routes';

describe('routes', () => {
  it.each([
    ['#/', ''],
    ['#/validate', 'validate'],
    ['#/bench', 'bench'],
    ['#/validate?t=M', 'validate'],
  ] as const)('reads %s as %s', (hash, route) => {
    expect(currentRoute(hash)).toBe(route);
  });

  it('keeps an unknown route on the tunnel with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(currentRoute('#/unknown')).toBe('');
    expect(warn).toHaveBeenCalledWith('Ignoring unknown hash route "unknown".');
    warn.mockRestore();
  });

  it('shows a clamped speed from a link', () => {
    expect(readRoute('#/?v=90').settings.speedMps).toBe(60);
    expect(readRoute('#/bench?v=32').settings.speedMps).toBe(32);
  });

  it('builds a link for another route from the current settings', () => {
    expect(routeHash('validate', DEFAULT_SETTINGS)).toContain('#/validate?p=ahmed-25');
    expect(routeHash('bench', DEFAULT_SETTINGS)).toContain('#/bench?');
  });

  it('names each route', () => {
    expect(ROUTE_TITLES).toEqual({
      '': 'Tunnel',
      validate: 'Validation results',
      bench: 'Performance results',
    });
  });

  it('hides the tunnel on the results routes only', () => {
    expect(tunnelHiddenOn('')).toBe(false);
    expect(tunnelHiddenOn('validate')).toBe(true);
    expect(tunnelHiddenOn('bench')).toBe(true);
  });

  it('shows the frame view on the tunnel route only', () => {
    expect(isEmbedRoute('#/?p=sphere&embed=1')).toBe(true);
    expect(isEmbedRoute('#/?p=sphere')).toBe(false);
    expect(isEmbedRoute('#/validate?embed=1')).toBe(false);
    expect(isEmbedRoute('#/bench?embed=1')).toBe(false);
  });
});
