import { U_LU } from '../lbm/units';
import { type Color, parseRenderColor } from './frame';

export type SliceField = 'speed' | 'cp';

export interface ColorMap {
  readonly label: string;
  readonly low: number;
  readonly high: number;
  /** Evenly spaced sRGB stops from low to high. */
  readonly stops: readonly string[];
  readonly ticks: readonly number[];
}

export const COLOR_STOPS = 9;

// Viridis is sequential and perceptually uniform; ColorBrewer RdBu stays readable with
// red-green colour blindness and keeps zero at its neutral middle stop.
export const COLOR_MAPS: Readonly<Record<SliceField, ColorMap>> = {
  speed: {
    label: 'Speed, |u| divided by inlet speed',
    low: 0,
    high: 2,
    stops: [
      '#440154',
      '#472c7a',
      '#3b518b',
      '#2c718e',
      '#21908d',
      '#27ad81',
      '#5cc863',
      '#aadc32',
      '#fde725',
    ],
    ticks: [0, 0.5, 1, 1.5, 2],
  },
  cp: {
    label: 'Pressure coefficient Cp',
    low: -1.5,
    high: 1.5,
    stops: [
      '#2166ac',
      '#4393c3',
      '#92c5de',
      '#d1e5f0',
      '#f7f7f7',
      '#fddbc7',
      '#f4a582',
      '#d6604d',
      '#b2182b',
    ],
    ticks: [-1.5, -0.75, 0, 0.75, 1.5],
  },
};

/** Velocity magnitude in units of the inlet speed. */
export function speedValue(ux: number, uy: number, uz: number): number {
  return Math.hypot(ux, uy, uz) / U_LU;
}

/** Lattice pressure is rho / 3 and the reference density is one. */
export function cpValue(rho: number): number {
  return (rho - 1) / 3 / (0.5 * U_LU * U_LU);
}

/** The same piecewise-linear lookup the slice shader performs, clamped to the map range. */
export function colorAt(field: SliceField, value: number): Color {
  const map = COLOR_MAPS[field];
  const t = Math.min(1, Math.max(0, (value - map.low) / (map.high - map.low)));
  const position = t * (map.stops.length - 1);
  const index = Math.min(map.stops.length - 2, Math.floor(position));
  const black: Color = [0, 0, 0, 1];
  const a = parseRenderColor(map.stops[index] ?? '', black);
  const b = parseRenderColor(map.stops[index + 1] ?? '', black);
  const weight = position - index;
  const mix = (c: 0 | 1 | 2 | 3): number => a[c] + (b[c] - a[c]) * weight;
  return [mix(0), mix(1), mix(2), mix(3)];
}

export function legendGradient(field: SliceField): string {
  return `linear-gradient(to right, ${COLOR_MAPS[field].stops.join(', ')})`;
}

/** Tick positions as fractions of the bar width, so numbers carry the value, not colour alone. */
export function legendTicks(field: SliceField): readonly { offset: number; label: string }[] {
  const map = COLOR_MAPS[field];
  return map.ticks.map((tick) => ({
    offset: (tick - map.low) / (map.high - map.low),
    label: tick < 0 ? `\u2212${-tick}` : String(tick),
  }));
}

/** Replace the element's content with a captioned colour bar and its numeric ticks. */
export function renderLegend(element: HTMLElement, field: SliceField): void {
  const doc = element.ownerDocument;
  const figure = doc.createElement('figure');
  const caption = doc.createElement('figcaption');
  caption.textContent = COLOR_MAPS[field].label;
  const bar = doc.createElement('div');
  bar.setAttribute('aria-hidden', 'true');
  bar.style.background = legendGradient(field);
  bar.style.height = '0.75rem';
  const list = doc.createElement('ul');
  list.style.position = 'relative';
  list.style.listStyle = 'none';
  list.style.margin = '0';
  list.style.padding = '0';
  list.style.height = '1.5em';
  for (const tick of legendTicks(field)) {
    const item = doc.createElement('li');
    item.textContent = tick.label;
    item.style.position = 'absolute';
    item.style.left = `${tick.offset * 100}%`;
    item.style.transform = `translateX(-${tick.offset * 100}%)`;
    list.append(item);
  }
  figure.append(caption, bar, list);
  element.replaceChildren(figure);
  element.dataset.field = field;
}
