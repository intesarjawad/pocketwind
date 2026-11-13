import { describe, expect, it } from 'vitest';
import { browserMessageId } from '../../src/app/unsupported';

describe('browser next steps', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/147.0', 'firefox-linux'],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0', 'chromium-linux'],
    ['Mozilla/5.0 (Android 14; Mobile) Firefox/147.0', 'firefox-android'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/156.0', 'android-browser'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/605.1', 'apple-browser'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0', 'apple-browser'],
    ['Mozilla/5.0 (Windows NT 10.0) Edg/156.0', 'desktop-browser'],
    ['Unknown browser', 'desktop-browser'],
  ])('chooses a next step for %s', (userAgent, messageId) => {
    expect(browserMessageId(userAgent)).toBe(messageId);
  });
});
