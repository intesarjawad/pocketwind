import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import { copyNote, shareUrl } from '../../../src/app/share-controls';

describe('share controls', () => {
  it('replaces the hash and keeps the rest of the address', () => {
    expect(shareUrl('https://example.test/pocketwind/?x=1#/validate?t=M', DEFAULT_SETTINGS)).toBe(
      'https://example.test/pocketwind/?x=1#/?p=ahmed-25&t=auto&st=auto&op=reg&w=bb&v=40&len=1044&ax=x&sg=1&up=z&fl=1',
    );
  });

  it('preserves the validated sphere mode in share links', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      presetId: 'sphere',
      operator: 'trt' as const,
      floor: false,
    };
    expect(shareUrl('https://example.test/#/?laminar=1', settings)).toContain('&laminar=1');
    expect(shareUrl('https://example.test/#/?laminar=1', DEFAULT_SETTINGS)).not.toContain(
      'laminar=1',
    );
  });

  it('says a custom link leaves the model file out', () => {
    expect(copyNote(DEFAULT_SETTINGS)).toBe('Link copied.');
    expect(copyNote({ ...DEFAULT_SETTINGS, presetId: 'custom' })).toBe(
      'Link copied. This link excludes the model file. Open it with the same file.',
    );
  });
});
