import { resultCardFileName } from '../io/result-card';
import { runFileJson, runFileName } from '../io/run-export';
import type { RunFile } from '../io/run-file';
import { CUSTOM_LINK_NOTE, encodeShareLink } from '../io/share-link';
import { TIERS } from '../lbm/layout';
import { laminarPlate } from './run-plan';
import type { Settings } from './settings';

/** The page address with its hash replaced by the link for these settings. */
export function shareUrl(pageUrl: string, settings: Settings): string {
  const url = new URL(pageUrl);
  const laminar = laminarPlate(url.hash, settings, TIERS.M.nx);
  url.hash = `${encodeShareLink(settings)}${laminar ? '&laminar=1' : ''}`;
  return url.toString();
}

/** What to say after a link is copied; a custom run cannot bring its model file along. */
export function copyNote(settings: Settings): string {
  return settings.presetId === 'custom' ? `Link copied. ${CUSTOM_LINK_NOTE}` : 'Link copied.';
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type ResultCardDownload = { readonly name: string; readonly png: Blob };

/** A link field with copy, export and image buttons, announced through one status line. */
export function createShareControls(options: {
  settings: () => Settings;
  runFile: () => RunFile | null;
  resultCard: () => Promise<ResultCardDownload | null>;
  unavailable?: () => string | null;
}): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Share');

  const link = document.createElement('input');
  link.type = 'text';
  link.readOnly = true;
  link.setAttribute('aria-label', 'Share link');

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy link';
  const exportRun = document.createElement('button');
  exportRun.type = 'button';
  exportRun.textContent = 'Export run';
  const saveImage = document.createElement('button');
  saveImage.type = 'button';
  saveImage.textContent = 'Save image';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');

  function refreshLink(): void {
    link.value = shareUrl(location.href, options.settings());
  }

  copy.addEventListener('click', async () => {
    refreshLink();
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = copyNote(options.settings());
    } catch {
      link.focus();
      link.select();
      status.textContent = 'The link could not be copied. Select it and copy it by hand.';
    }
  });
  exportRun.addEventListener('click', () => {
    const reason = options.unavailable?.();
    if (reason) {
      status.textContent = reason;
      return;
    }
    const run = options.runFile();
    if (run === null) {
      status.textContent = 'There is no result to export yet. Wait for the first Cd value.';
      return;
    }
    const fileName = runFileName(run.name);
    download(new Blob([runFileJson(run)], { type: 'application/json' }), fileName);
    status.textContent = `Saved ${fileName}.`;
  });
  saveImage.addEventListener('click', async () => {
    const reason = options.unavailable?.();
    if (reason) {
      status.textContent = reason;
      return;
    }
    saveImage.disabled = true;
    try {
      const card = await options.resultCard();
      if (card === null) {
        status.textContent = 'There is no view to save yet. Wait for the tunnel to start.';
        return;
      }
      const fileName = resultCardFileName(card.name);
      download(card.png, fileName);
      status.textContent = `Saved ${fileName}.`;
    } catch (error) {
      status.textContent = `The image could not be saved. ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      saveImage.disabled = false;
    }
  });
  link.addEventListener('focus', refreshLink);

  refreshLink();
  section.append(link, copy, exportRun, saveImage, status);
  return section;
}
