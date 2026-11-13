import type { Point3 } from './camera';

export type Color = readonly [number, number, number, number];
export interface RenderColors {
  readonly body: Color;
  readonly smoke: Color;
  readonly line: Color;
  readonly ground: Color;
}

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
export const FRAME_BYTES = 128;

/** Pack the matrix, eye and three material colours on vec4 boundaries. */
export function packFrame(
  matrix: Float32Array,
  eye: Point3,
  colors: RenderColors,
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(FRAME_BYTES / 4);
  data.set(matrix, 0);
  data.set([...eye, 1], 16);
  data.set(colors.body, 20);
  data.set(colors.smoke, 24);
  data.set(colors.line, 28);
  return data;
}

/** Render tokens accept sRGB hex; missing tokens keep the unstyled view neutral. */
export function parseRenderColor(value: string, fallback: Color): Color {
  const hex = value.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return fallback;
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const channel = (offset: number): number =>
    Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), expanded.length === 8 ? channel(6) : 1];
}

export function readRenderColors(canvas: HTMLCanvasElement): RenderColors {
  const style = getComputedStyle(canvas);
  return {
    body: parseRenderColor(style.getPropertyValue('--pwt-body'), [0.6, 0.6, 0.6, 1]),
    smoke: parseRenderColor(style.getPropertyValue('--pwt-smoke'), [0.7, 0.7, 0.7, 0.5]),
    line: parseRenderColor(style.getPropertyValue('--pwt-line'), [0.5, 0.5, 0.5, 1]),
    ground: parseRenderColor(style.getPropertyValue('--pwt-ground'), [0.05, 0.05, 0.05, 1]),
  };
}
