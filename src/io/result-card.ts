import type { Tier } from '../app/settings';
import type { DragStatus } from '../forces/drag-stats';
import { TIERS } from '../lbm/layout';
import { downloadStem } from './run-export';

export const RESULT_CARD_WIDTH = 1200;
export const RESULT_CARD_HEIGHT = 675;

// copyTextureToBuffer requires each row of the destination buffer to start on this multiple.
const BYTES_PER_ROW_ALIGNMENT = 256;
const BYTES_PER_PIXEL = 4;
const OVERLAY_HEIGHT_PX = 212;

export type CardFormat = 'rgba8unorm' | 'bgra8unorm';

/** The two formats `getPreferredCanvasFormat` can return. */
export function isCardFormat(format: GPUTextureFormat): format is CardFormat {
  return format === 'rgba8unorm' || format === 'bgra8unorm';
}

export function resultCardFileName(name: string): string {
  return `${downloadStem(name)}-card.png`;
}

export type ResultCardInfo = {
  name: string;
  cd: number | null;
  status: DragStatus;
  cdaM2: number | null;
  grid: { nx: number; ny: number; nz: number };
  /** True when the body mesh was not watertight, so the solid cells are less certain. */
  openMesh: boolean;
  effectiveRe: number | null;
  viscosityFloor: boolean | null;
  commit: string;
};

export type ResultCardText = {
  headline: string;
  details: readonly string[];
  badge: string | null;
  footer: string;
};

/** Row pitch the buffer needs: 4 864 bytes for 1 200 pixels. */
export function paddedBytesPerRow(widthPx: number): number {
  const rowBytes = widthPx * BYTES_PER_PIXEL;
  return Math.ceil(rowBytes / BYTES_PER_ROW_ALIGNMENT) * BYTES_PER_ROW_ALIGNMENT;
}

/**
 * Drop the row padding and return RGBA bytes. A `bgra8unorm` texture stores blue
 * first, so its red and blue channels are swapped to the order ImageData expects.
 */
export function unpadRows(
  source: Uint8Array,
  widthPx: number,
  heightPx: number,
  bytesPerRow: number,
  format: CardFormat,
): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = widthPx * BYTES_PER_PIXEL;
  if (bytesPerRow < rowBytes || source.length < bytesPerRow * (heightPx - 1) + rowBytes) {
    throw new RangeError('The texture copy is smaller than its stated size.');
  }
  const swap = format === 'bgra8unorm';
  const pixels = new Uint8ClampedArray(rowBytes * heightPx);
  for (let y = 0; y < heightPx; y++) {
    const from = y * bytesPerRow;
    const to = y * rowBytes;
    for (let x = 0; x < rowBytes; x += BYTES_PER_PIXEL) {
      const first = source[from + x] ?? 0;
      const third = source[from + x + 2] ?? 0;
      pixels[to + x] = swap ? third : first;
      pixels[to + x + 1] = source[from + x + 1] ?? 0;
      pixels[to + x + 2] = swap ? first : third;
      pixels[to + x + 3] = source[from + x + 3] ?? 0;
    }
  }
  return pixels;
}

/** The tier whose grid has these dimensions, or null for a grid no tier produces. */
export function tierOfGrid(grid: { nx: number; ny: number; nz: number }): Tier | null {
  for (const tier of Object.keys(TIERS) as Tier[]) {
    const layout = TIERS[tier];
    if (layout.nx === grid.nx && layout.ny === grid.ny && layout.nz === grid.nz) return tier;
  }
  return null;
}

function statusText(status: DragStatus): string {
  if (status.kind === 'settling') return 'settling';
  return `${status.kind}, fluctuation ${status.relStdPct.toFixed(1)}%`;
}

/** Words drawn over the frame; kept apart from canvas drawing so the content is checkable. */
export function resultCardText(info: ResultCardInfo): ResultCardText {
  const cd = info.cd === null ? 'Cd not reported' : `Cd ${info.cd.toFixed(2)}`;
  const cda = info.cdaM2 === null ? 'CdA not reported' : `CdA ${info.cdaM2.toFixed(4)} m²`;
  const tier = tierOfGrid(info.grid);
  const grid = `domain ${info.grid.nx}×${info.grid.ny}×${info.grid.nz}`;
  return {
    headline: info.name,
    details: [
      `${cd}, ${statusText(info.status)}`,
      `${cda}, ${grid}${tier === null ? '' : `, tier ${tier}`}`,
      `Effective Re ${info.effectiveRe === null ? 'unknown' : info.effectiveRe.toPrecision(3)}${info.viscosityFloor === true ? '; viscosity floor, so Cd is not drag at the requested speed' : info.viscosityFloor === null ? '; viscosity floor unknown' : ''}`,
    ],
    badge: info.openMesh ? 'Open mesh' : null,
    footer: `commit ${info.commit}`,
  };
}

function drawOverlay(context: CanvasRenderingContext2D, text: ResultCardText): void {
  const top = RESULT_CARD_HEIGHT - OVERLAY_HEIGHT_PX;
  context.fillStyle = 'rgba(0, 0, 0, 0.78)';
  context.fillRect(0, top, RESULT_CARD_WIDTH, OVERLAY_HEIGHT_PX);
  context.fillStyle = '#ffffff';
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.font = '600 40px sans-serif';
  context.fillText(text.headline, 32, top + 52);
  context.font = '26px sans-serif';
  text.details.forEach((line, index) => {
    context.fillText(line, 32, top + 96 + index * 34);
  });
  context.textAlign = 'right';
  context.font = '24px sans-serif';
  context.fillText(text.footer, RESULT_CARD_WIDTH - 32, RESULT_CARD_HEIGHT - 24);
  if (text.badge !== null) {
    context.font = '600 28px sans-serif';
    context.fillText(text.badge, RESULT_CARD_WIDTH - 32, top + 52);
  }
}

declare const GPUBufferUsage: { readonly COPY_DST: number; readonly MAP_READ: number };
declare const GPUTextureUsage: {
  readonly RENDER_ATTACHMENT: number;
  readonly COPY_SRC: number;
};
declare const GPUMapMode: { readonly READ: number };

export type ResultCardOptions = {
  device: GPUDevice;
  /** The format the scene's pipelines were built for, normally the canvas format. */
  format: CardFormat;
  /** Encode and submit one frame of the current view into `target`. */
  drawFrame: (target: GPUTexture, size: { width: number; height: number }) => void;
  info: ResultCardInfo;
};

async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  format: CardFormat,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const bytesPerRow = paddedBytesPerRow(RESULT_CARD_WIDTH);
  const buffer = device.createBuffer({
    label: 'Result card readback',
    size: bytesPerRow * RESULT_CARD_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: 'Result card copy' });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [
      RESULT_CARD_WIDTH,
      RESULT_CARD_HEIGHT,
    ]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    try {
      const mapped = new Uint8Array(buffer.getMappedRange());
      return unpadRows(mapped, RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT, bytesPerRow, format);
    } finally {
      buffer.unmap();
    }
  } finally {
    buffer.destroy();
  }
}

/** Render one frame at card size, read it back and draw the result text over its lower edge. */
export async function renderResultCard(options: ResultCardOptions): Promise<Blob> {
  const { device, format } = options;
  const texture = device.createTexture({
    label: 'Result card frame',
    size: [RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  let pixels: Uint8ClampedArray<ArrayBuffer>;
  try {
    options.drawFrame(texture, { width: RESULT_CARD_WIDTH, height: RESULT_CARD_HEIGHT });
    pixels = await readTexture(device, texture, format);
  } finally {
    texture.destroy();
  }

  const canvas = document.createElement('canvas');
  canvas.width = RESULT_CARD_WIDTH;
  canvas.height = RESULT_CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The result card canvas could not be drawn.');
  context.putImageData(new ImageData(pixels, RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT), 0, 0);
  drawOverlay(context, resultCardText(options.info));
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('The result card could not be encoded as a PNG.'));
      else resolve(blob);
    }, 'image/png');
  });
}
