import { describe, expect, it } from 'vitest';
import { packFrame, parseRenderColor } from '../../../src/render/frame';
import { lineVertices } from '../../../src/render/lines-pipeline';
import { meshVertices } from '../../../src/render/mesh-pipeline';

it('packs the camera and material vec4s at their WGSL byte offsets', () => {
  const frame = packFrame(
    new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    [17, 18, 19],
    { body: [1, 0, 0, 1], smoke: [0, 1, 0, 0.5], line: [0, 0, 1, 1], ground: [0, 0, 0, 1] },
  );
  expect(frame.byteLength).toBe(128);
  expect(Array.from(frame)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 1, 1, 0, 0, 1, 0, 1, 0, 0.5,
    0, 0, 1, 1,
  ]);
});

it('reads short, full and alpha hex tokens and falls back for absent or invalid tokens', () => {
  expect(parseRenderColor(' #f80 ', [0, 0, 0, 0])).toEqual([1, 136 / 255, 0, 1]);
  expect(parseRenderColor('#80402080', [0, 0, 0, 0])).toEqual([
    128 / 255,
    64 / 255,
    32 / 255,
    128 / 255,
  ]);
  expect(parseRenderColor('#123456', [0, 0, 0, 0])).toEqual([18 / 255, 52 / 255, 86 / 255, 1]);
  for (const value of ['', '#xyz', '#12345', 'red'])
    expect(parseRenderColor(value, [1, 0, 1, 1])).toEqual([1, 0, 1, 1]);
});

describe('flat mesh buffer', () => {
  it('keeps lattice coordinates and gives every triangle a separate unit normal', () => {
    const data = meshVertices({
      triangleCount: 2,
      positions: new Float32Array([1, 2, 3, 3, 2, 3, 1, 5, 3, 1, 2, 3, 1, 2, 7, 3, 2, 3]),
    });
    expect(data.byteLength).toBe(144);
    expect(Array.from(data)).toEqual([
      1, 2, 3, 0, 0, 1, 3, 2, 3, 0, 0, 1, 1, 5, 3, 0, 0, 1, 1, 2, 3, 0, 1, 0, 1, 2, 7, 0, 1, 0, 3,
      2, 3, 0, 1, 0,
    ]);
  });
  it('reverses the normal with winding and keeps zero-area faces finite', () => {
    expect(
      Array.from(
        meshVertices({
          triangleCount: 1,
          positions: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]),
        }),
      ).slice(3, 6),
    ).toEqual([0, 0, -1]);
    expect(Array.from(meshVertices({ triangleCount: 1, positions: new Float32Array(9) }))).toEqual(
      Array(18).fill(0),
    );
  });
  it('rejects missing, incomplete and non-finite triangles', () => {
    for (const mesh of [
      { triangleCount: 0, positions: new Float32Array() },
      { triangleCount: 1, positions: new Float32Array(8) },
      { triangleCount: 1, positions: new Float32Array(9).fill(NaN) },
    ])
      expect(() => meshVertices(mesh)).toThrow(RangeError);
  });
});

describe('domain and floor lines', () => {
  it('emits each edge exactly once and only interior lines on the z-up floor', () => {
    const data = lineVertices({ min: [1, 2, 3], max: [5, 6, 7] }, 2);
    expect(data.byteLength).toBe(336);
    expect(Array.from(data)).toEqual([
      1, 2, 3, 5, 2, 3, 1, 2, 3, 1, 6, 3, 1, 2, 3, 1, 2, 7, 5, 2, 3, 5, 6, 3, 5, 2, 3, 5, 2, 7, 1,
      6, 3, 5, 6, 3, 1, 6, 3, 1, 6, 7, 5, 6, 3, 5, 6, 7, 1, 2, 7, 5, 2, 7, 1, 2, 7, 1, 6, 7, 5, 2,
      7, 5, 6, 7, 1, 6, 7, 5, 6, 7, 3, 2, 3, 3, 6, 3, 1, 4, 3, 5, 4, 3,
    ]);
  });
  it('does not duplicate boundary edges when the spacing exceeds the domain', () => {
    expect(lineVertices({ min: [0, 0, 0], max: [1, 1, 1] }, 2)).toHaveLength(72);
  });
  it('bounds the allocation for very fine grid spacing', () => {
    expect(() => lineVertices({ min: [0, 0, 0], max: [1, 1, 1] }, 1e-10)).toThrow(
      /floor grid exceeds/,
    );
  });
  it('rejects inverted bounds and invalid spacing', () => {
    for (const spacing of [0, -1, NaN, Infinity])
      expect(() => lineVertices({ min: [0, 0, 0], max: [1, 1, 1] }, spacing)).toThrow(RangeError);
    expect(() => lineVertices({ min: [2, 0, 0], max: [1, 1, 1] }, 1)).toThrow(RangeError);
    expect(() => lineVertices({ min: [0, 0, 0], max: [1, 1, NaN] }, 1)).toThrow(RangeError);
  });
});
