import { describe, expect, it } from 'vitest';
import { canonicalStl } from '../../scripts/stl-canonical';
import { parseStl } from '../../src/geometry/stl';

const HEADER = 'pocketwind preset geometry';

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function facet(normal: string, vertices: readonly string[]): string {
  const lines = vertices.map((vertex) => `      vertex ${vertex}`).join('\n');
  return `  facet normal ${normal}\n    outer loop\n${lines}\n    endloop\n  endfacet\n`;
}

/** Hand-laid binary triangle with a non-zero normal and attribute, for the rewrite to discard. */
function binaryTriangle(): Uint8Array {
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('some other tool'));
  view.setUint32(80, 1, true);
  [0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((value, index) => {
    view.setFloat32(84 + index * 4, value, true);
  });
  view.setUint16(84 + 48, 0xabcd, true);
  return bytes;
}

describe('canonical STL', () => {
  it('writes a fixed header, zero normals, vertices and zero attributes', () => {
    const bytes = canonicalStl(
      ascii(
        `solid OpenSCAD_Model\n${facet('0 0 1', ['1 2 3', '4 5 6', '7 8 9'])}endsolid OpenSCAD_Model\n`,
      ),
    );
    expect(bytes).toHaveLength(134);
    const view = new DataView(bytes.buffer);
    const header = new Uint8Array(80);
    header.set(ascii(HEADER));
    expect(bytes.subarray(0, 80)).toEqual(header);
    expect(view.getUint32(80, true)).toBe(1);
    const floats = Array.from({ length: 12 }, (_, index) => view.getFloat32(84 + index * 4, true));
    expect(floats).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(view.getUint16(132, true)).toBe(0);
  });

  it('gives identical bytes for ASCII and binary input of the same triangle', () => {
    const fromAscii = canonicalStl(
      ascii(`solid a\n${facet('1 0 0', ['1 2 3', '4 5 6', '7 8 9'])}endsolid a\n`),
    );
    expect(canonicalStl(binaryTriangle())).toEqual(fromAscii);
  });

  it('does not let negative zero change the bytes', () => {
    const negative = canonicalStl(
      ascii(`solid a\n${facet('0 0 1', ['-0 -0.0 3', '4 5 6', '7 8 9'])}endsolid a\n`),
    );
    const positive = canonicalStl(
      ascii(`solid a\n${facet('0 0 1', ['0 0 3', '4 5 6', '7 8 9'])}endsolid a\n`),
    );
    expect(negative).toEqual(positive);
  });

  it('reads back as the same mesh', () => {
    const mesh = parseStl(canonicalStl(binaryTriangle()).slice().buffer);
    if ('kind' in mesh) throw new Error(mesh.message);
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects input that is not an STL', () => {
    expect(() => canonicalStl(ascii('not a mesh at all'))).toThrow(/not-stl/);
  });
});
