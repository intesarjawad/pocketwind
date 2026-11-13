import { describe, expect, it } from 'vitest';
import {
  isCardFormat,
  paddedBytesPerRow,
  RESULT_CARD_HEIGHT,
  RESULT_CARD_WIDTH,
  type ResultCardInfo,
  resultCardFileName,
  resultCardText,
  tierOfGrid,
  unpadRows,
} from '../../../src/io/result-card';

const INFO: ResultCardInfo = {
  name: 'Ahmed 25',
  cd: 0.3012,
  status: { kind: 'steady', relStdPct: 0.84, driftPct: 0.4 },
  cdaM2: 0.03373,
  grid: { nx: 192, ny: 96, nz: 96 },
  openMesh: false,
  effectiveRe: 320,
  viscosityFloor: true,
  commit: '9753a3c',
};

describe('result card size', () => {
  it('is 1200 by 675 pixels', () => {
    expect([RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT]).toEqual([1200, 675]);
  });

  it('pads each row to a multiple of 256 bytes', () => {
    expect(paddedBytesPerRow(1200)).toBe(4864);
    expect(paddedBytesPerRow(64)).toBe(256);
    expect(paddedBytesPerRow(65)).toBe(512);
    expect(paddedBytesPerRow(1)).toBe(256);
  });
});

describe('texture readback', () => {
  // Two rows of three pixels, each row padded to eight bytes of 255 filler.
  const padded = new Uint8Array([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    ...[255, 255, 255, 255],
    ...[21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
    ...[255, 255, 255, 255],
  ]);

  it('removes the padding and keeps the channel order of an rgba texture', () => {
    expect([...unpadRows(padded, 3, 2, 16, 'rgba8unorm')]).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      ...[21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
    ]);
  });

  it('swaps red and blue for a bgra texture', () => {
    expect([...unpadRows(padded, 3, 2, 16, 'bgra8unorm')]).toEqual([
      ...[3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12],
      ...[23, 22, 21, 24, 27, 26, 25, 28, 31, 30, 29, 32],
    ]);
  });

  it('refuses a copy shorter than its stated size or pitch', () => {
    expect(() => unpadRows(padded.subarray(0, 20), 3, 2, 16, 'rgba8unorm')).toThrow(RangeError);
    expect(() => unpadRows(padded, 3, 2, 8, 'rgba8unorm')).toThrow(RangeError);
  });
});

describe('result card text', () => {
  it('states the name, Cd, status, CdA, grid, tier and commit', () => {
    expect(resultCardText(INFO)).toEqual({
      headline: 'Ahmed 25',
      details: [
        'Cd 0.30, steady, fluctuation 0.8%',
        'CdA 0.0337 m², domain 192×96×96, tier M',
        'Effective Re 320; viscosity floor, so Cd is not drag at the requested speed',
      ],
      badge: null,
      footer: 'commit 9753a3c',
    });
  });

  it('badges an open mesh and shows a missing value as a dash', () => {
    const text = resultCardText({
      ...INFO,
      cd: null,
      cdaM2: null,
      status: { kind: 'settling', etaS: 4 },
      openMesh: true,
      grid: { nx: 100, ny: 50, nz: 50 },
    });
    expect(text.badge).toBe('Open mesh');
    expect(text.details).toEqual([
      'Cd not reported, settling',
      'CdA not reported, domain 100×50×50',
      'Effective Re 320; viscosity floor, so Cd is not drag at the requested speed',
    ]);
  });

  it('maps a grid to its tier only when a tier produces it', () => {
    expect(tierOfGrid({ nx: 128, ny: 64, nz: 64 })).toBe('S');
    expect(tierOfGrid({ nx: 384, ny: 192, nz: 192 })).toBe('XL');
    expect(tierOfGrid({ nx: 128, ny: 64, nz: 65 })).toBeNull();
  });
});

describe('result card file', () => {
  it('names the download after the run, without path characters', () => {
    expect(resultCardFileName('ahmed-25')).toBe('ahmed-25-card.png');
    expect(resultCardFileName('wing/v2: final')).toBe('wing-v2- final-card.png');
    expect(resultCardFileName('  ')).toBe('untitled-card.png');
  });

  it('accepts only the two canvas formats it can read back', () => {
    expect(isCardFormat('rgba8unorm')).toBe(true);
    expect(isCardFormat('bgra8unorm')).toBe(true);
    expect(isCardFormat('rgba16float')).toBe(false);
    expect(isCardFormat('rgba8unorm-srgb')).toBe(false);
  });
});
