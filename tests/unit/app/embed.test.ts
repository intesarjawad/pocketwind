import { describe, expect, it } from 'vitest';
import {
  CUSTOM_EMBED_REASON,
  embedBlockedReason,
  embedSnippet,
  embedUrl,
  fullTunnelUrl,
  isEmbed,
} from '../../../src/app/embed';
import { DEFAULT_SETTINGS, PRESETS } from '../../../src/app/params';

const PAGE = 'https://example.test/pocketwind/';
const DEFAULT_PARAMS = 'p=ahmed-25&t=auto&st=auto&op=reg&w=bb&v=40&len=1044&ax=x&sg=1&up=z&fl=1';

describe('embed flag', () => {
  it.each([
    ['#/?p=ahmed-25&embed=1', true],
    ['#/?embed=1', true],
    ['#/?embed=0', false],
    ['#/?embed=10', false],
    ['#/?p=ahmed-25', false],
    ['#/', false],
    ['', false],
  ])('reads %s as %s', (hash, expected) => {
    expect(isEmbed(hash)).toBe(expected);
  });
});

describe('embed snippet', () => {
  it('builds the frame for the default settings', () => {
    expect(embedSnippet(PAGE, DEFAULT_SETTINGS)).toBe(
      `<iframe src="${PAGE}#/?${DEFAULT_PARAMS.replaceAll('&', '&amp;')}&amp;embed=1" width="640" height="360" title="Pocket Wind Tunnel: Ahmed body at 25 degrees" loading="lazy"></iframe>`,
    );
  });

  it('puts the unescaped address in the url builder', () => {
    expect(embedUrl(PAGE, DEFAULT_SETTINGS)).toBe(`${PAGE}#/?${DEFAULT_PARAMS}&embed=1`);
  });

  it('names every preset in its title and keeps its settings in the address', () => {
    const titles: Record<string, string> = {
      'ahmed-25': 'Ahmed body at 25 degrees',
      sphere: 'Sphere, 100 mm',
    };
    expect(PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(titles).sort());
    for (const preset of PRESETS) {
      const snippet = embedSnippet(PAGE, {
        ...DEFAULT_SETTINGS,
        presetId: preset.id,
        bodyLengthMm: preset.bodyLengthMm,
      });
      expect(snippet).toContain(`title="Pocket Wind Tunnel: ${titles[preset.id]}"`);
      expect(snippet).toContain(`#/?p=${preset.id}&amp;`);
      expect(snippet).toContain(`&amp;len=${preset.bodyLengthMm}&amp;`);
      expect(snippet).toContain(
        `&amp;embed=1" width="640" height="360" title="Pocket Wind Tunnel: ${titles[preset.id]}" loading="lazy"></iframe>`,
      );
    }
  });

  it('escapes quotes, angle brackets and ampersands in the title and the address', () => {
    const snippet = embedSnippet(`${PAGE}?x=1&y=2`, { ...DEFAULT_SETTINGS, presetId: 'a"<b>&' });
    expect(snippet).toContain(`src="${PAGE}?x=1&amp;y=2#/?p=a%22%3Cb%3E%26&amp;t=auto`);
    expect(snippet).toContain('title="Pocket Wind Tunnel: a&quot;&lt;b&gt;&amp;"');
    expect(snippet.match(/"/g)).toHaveLength(10);
  });

  it('drops a hash that was already on the page address', () => {
    expect(embedUrl(`${PAGE}#/validate?t=M&embed=1`, DEFAULT_SETTINGS)).toBe(
      `${PAGE}#/?${DEFAULT_PARAMS}&embed=1`,
    );
  });
});

describe('embed availability', () => {
  it('is on for presets and off for a dropped model, with the reason', () => {
    expect(embedBlockedReason(DEFAULT_SETTINGS)).toBeNull();
    expect(embedBlockedReason({ ...DEFAULT_SETTINGS, presetId: 'custom' })).toBe(
      'custom STL files stay in your tab and cannot be embedded',
    );
    expect(CUSTOM_EMBED_REASON).toBe('custom STL files stay in your tab and cannot be embedded');
  });
});

describe('full tunnel link', () => {
  it.each([
    [`${PAGE}#/?p=sphere&embed=1`, `${PAGE}#/?p=sphere`],
    [`${PAGE}#/?embed=1&p=sphere&v=30`, `${PAGE}#/?p=sphere&v=30`],
    [`${PAGE}#/?embed=1`, `${PAGE}#/`],
    [`${PAGE}?x=1#/?p=sphere&embed=1`, `${PAGE}?x=1#/?p=sphere`],
    [`${PAGE}#/?p=sphere`, `${PAGE}#/?p=sphere`],
    [PAGE, PAGE],
  ])('turns %s into %s', (href, expected) => {
    expect(fullTunnelUrl(href)).toBe(expected);
  });
});
