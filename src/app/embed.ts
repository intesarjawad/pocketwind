import type { UnsupportedReason } from '../gpu/device';
import { MESSAGES } from './messages';
import { presetById } from './params';
import { createReadout } from './readout';
import type { Settings } from './settings';
import { shareUrl } from './share-controls';
import type { SettingsStore } from './store';

export const EMBED_PARAM = 'embed';
export const EMBED_FRAME_WIDTH = 640;
export const EMBED_FRAME_HEIGHT = 360;
export const OPEN_FULL_TUNNEL_LABEL = 'Open full tunnel';

/** A dropped model never leaves the tab, so a frame elsewhere could not load it. */
export const CUSTOM_EMBED_REASON = 'custom STL files stay in your tab and cannot be embedded';

function hashQuery(hash: string): URLSearchParams {
  return new URLSearchParams(hash.split('?')[1] ?? '');
}

/** True when the hash asks for the frame view: canvas, readout and a link out, no panel. */
export function isEmbed(hash: string = location.hash): boolean {
  return hashQuery(hash).get(EMBED_PARAM) === '1';
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** The address a frame loads: the share link for these settings plus the embed flag. */
export function embedUrl(pageUrl: string, settings: Settings): string {
  return `${shareUrl(pageUrl, settings)}&${EMBED_PARAM}=1`;
}

/** The same page and hash without the embed flag, for opening the full tunnel. */
export function fullTunnelUrl(href: string): string {
  const url = new URL(href);
  const [path = '', query = ''] = url.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  params.delete(EMBED_PARAM);
  const rest = params.toString();
  url.hash = rest === '' ? path : `${path}?${rest}`;
  return url.toString();
}

/** Why the Embed button is off for these settings, or null when it can copy. */
export function embedBlockedReason(settings: Settings): string | null {
  return settings.presetId === 'custom' ? CUSTOM_EMBED_REASON : null;
}

/** The iframe markup for the current settings; the address and title are attribute-escaped. */
export function embedSnippet(pageUrl: string, settings: Settings): string {
  const name = presetById(settings.presetId)?.name ?? settings.presetId;
  const src = escapeAttribute(embedUrl(pageUrl, settings));
  const title = escapeAttribute(`Pocket Wind Tunnel: ${name}`);
  return `<iframe src="${src}" width="${EMBED_FRAME_WIDTH}" height="${EMBED_FRAME_HEIGHT}" title="${title}" loading="lazy"></iframe>`;
}

/** A link that opens the full tunnel in a new tab with the frame's settings. */
export function createFullTunnelLink(href: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = fullTunnelUrl(href);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = OPEN_FULL_TUNNEL_LABEL;
  return link;
}

/** The frame's content beside the canvas: the one-line readout and the link out. */
export function createEmbedView(href: string): {
  element: HTMLElement;
  readout: ReturnType<typeof createReadout>;
} {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Wind tunnel');
  section.className = 'embed-view';
  const readout = createReadout();
  section.append(readout.element, createFullTunnelLink(href));
  return { element: section, readout };
}

/** What a frame shows without WebGPU: the cause and a way out, never a blank frame. */
export function renderEmbedUnsupported(
  root: HTMLElement,
  reason: UnsupportedReason,
  href: string,
): void {
  const section = document.createElement('section');
  section.id = 'unsupported';
  const title = document.createElement('h1');
  title.textContent = 'WebGPU is unavailable';
  const what = document.createElement('p');
  what.dataset.message = 'what';
  what.textContent = MESSAGES[reason].what;
  section.append(title, what, createFullTunnelLink(href));
  root.replaceChildren(section);
}

/** The panel's Embed button with the reason it is off and a line that says what happened. */
export function createEmbedControl(options: {
  store: SettingsStore;
  pageUrl?: () => string;
}): HTMLElement {
  const { store } = options;
  const pageUrl = options.pageUrl ?? (() => location.href);
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Embed');

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Embed';
  const reason = document.createElement('p');
  reason.id = 'embed-reason';
  const code = document.createElement('input');
  code.type = 'text';
  code.readOnly = true;
  code.hidden = true;
  code.setAttribute('aria-label', 'Embed code');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');

  function sync(): void {
    const blocked = embedBlockedReason(store.settings);
    button.disabled = blocked !== null;
    reason.textContent = blocked ?? '';
    reason.hidden = blocked === null;
    if (blocked === null) button.removeAttribute('aria-describedby');
    else button.setAttribute('aria-describedby', reason.id);
  }

  button.addEventListener('click', async () => {
    const snippet = embedSnippet(pageUrl(), store.settings);
    try {
      await navigator.clipboard.writeText(snippet);
      code.hidden = true;
      status.textContent = 'Embed code copied.';
    } catch {
      code.value = snippet;
      code.hidden = false;
      code.select();
      status.textContent = 'The embed code could not be copied. Select it and copy it by hand.';
    }
  });

  store.subscribe(sync);
  sync();
  section.append(button, reason, code, status);
  return section;
}
