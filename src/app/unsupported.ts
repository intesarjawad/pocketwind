import type { UnsupportedReason } from '../gpu/device';
import { MESSAGES, type MessageId } from './messages';

export function browserMessageId(userAgent: string): MessageId {
  if (/Android/i.test(userAgent)) {
    return /Firefox\//i.test(userAgent) ? 'firefox-android' : 'android-browser';
  }
  if (/iPhone|iPad|iPod|Macintosh/i.test(userAgent)) return 'apple-browser';
  if (/Linux/i.test(userAgent)) {
    return /Firefox\//i.test(userAgent) ? 'firefox-linux' : 'chromium-linux';
  }
  return 'desktop-browser';
}

export function renderUnsupported(
  root: HTMLElement,
  reason: UnsupportedReason,
  userAgent: string,
): void {
  const section = document.createElement('section');
  section.id = 'unsupported';
  const still = document.createElement('img');
  still.src = `${import.meta.env.BASE_URL}plate/plate.png`;
  still.alt =
    'Smoke threads bending around the Ahmed body on its centre plane, developed by the solver in a browser with WebGPU.';
  still.width = 1440;
  still.height = 900;
  const title = document.createElement('h1');
  title.textContent = 'WebGPU is unavailable';
  const what = document.createElement('p');
  what.dataset.message = 'what';
  what.textContent = MESSAGES[reason].what;
  const next = document.createElement('p');
  next.dataset.message = 'next';
  next.textContent = `${MESSAGES[reason].next} ${MESSAGES[browserMessageId(userAgent)].next}`;
  const validation = document.createElement('a');
  validation.href = '#/validate';
  validation.textContent = 'Read the validation results';
  section.append(title, what, next, validation, still);
  root.replaceChildren(section);
}
