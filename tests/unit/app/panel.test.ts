import { describe, expect, it } from 'vitest';
import {
  ADVANCED_FIELDS,
  advancedChangeCount,
  advancedSummary,
  FOOTER_LINKS,
  REPOSITORY_URL,
} from '../../../src/app/panel';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import type { Settings } from '../../../src/app/settings';

function withSettings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('panel state', () => {
  it('closes Advanced with no changed solver choices', () => {
    expect(advancedChangeCount(DEFAULT_SETTINGS)).toBe(0);
    expect(advancedSummary(DEFAULT_SETTINGS)).toBe('Advanced');
  });

  it('counts each changed solver choice', () => {
    for (const patch of [
      { operator: 'trt' },
      { walls: 'bouzidi' },
      { storage: 'f16' },
      { tier: 'L' },
    ] as const) {
      expect(advancedChangeCount(withSettings(patch))).toBe(1);
      expect(advancedSummary(withSettings(patch))).toBe('Advanced (1 changed)');
    }
    expect(
      advancedChangeCount(
        withSettings({ operator: 'trt', walls: 'bouzidi', storage: 'f16', tier: 'L' }),
      ),
    ).toBe(4);
    expect(advancedSummary(withSettings({ tier: 'M', storage: 'f32' }))).toBe(
      'Advanced (2 changed)',
    );
  });

  it('keeps the advanced fields in the agreed order', () => {
    expect(ADVANCED_FIELDS).toEqual(['operator', 'walls', 'storage', 'tier']);
  });

  it('links the footer to the readme, validation and extension guide', () => {
    expect(FOOTER_LINKS).toEqual([
      { label: 'how it works', href: `${REPOSITORY_URL}#how-it-works` },
      { label: 'validation page', href: '#/validate' },
      { label: 'make it yours', href: `${REPOSITORY_URL}/blob/main/docs/extend.md` },
    ]);
  });
});
