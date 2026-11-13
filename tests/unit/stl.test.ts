import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../../src/geometry/stl';

function fixture(name: string): ArrayBuffer {
  return Uint8Array.from(readFileSync(new URL(`../fixtures/stl/${name}.stl`, import.meta.url)))
    .buffer;
}

function ascii(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('STL parser', () => {
  for (const name of ['cube-binary', 'cube-ascii-crlf', 'solid-header-binary']) {
    it(`reads ${name} with the same cube vertices`, () => {
      const mesh = parseStl(fixture(name));
      expect(mesh).toHaveProperty('triangleCount', 12);
      if ('kind' in mesh) throw new Error(mesh.message);
      expect(mesh.positions).toHaveLength(108);
      const expected = parseStl(fixture('cube-binary'));
      if ('kind' in expected) throw new Error(expected.message);
      expect(mesh.positions).toEqual(expected.positions);
      expect(new Set(mesh.positions)).toEqual(new Set([0, 1]));
    });
  }

  it('reports the first missing byte of a truncated binary record', () => {
    const bytes = fixture('truncated');
    expect(parseStl(bytes)).toMatchObject({ kind: 'truncated', byteOffset: bytes.byteLength });
  });

  it('rejects random bytes', () => {
    expect(parseStl(fixture('random'))).toMatchObject({ kind: 'not-stl', byteOffset: 0 });
  });

  it('rejects an empty binary mesh', () => {
    expect(parseStl(fixture('empty'))).toMatchObject({ kind: 'empty', byteOffset: 80 });
  });

  it('reports the byte offset of a non-finite binary vertex', () => {
    expect(parseStl(fixture('nan-vertex'))).toMatchObject({
      kind: 'non-finite',
      byteOffset: 96,
    });
  });

  for (const name of ['cube-binary', 'cube-ascii-crlf']) {
    it(`enforces the triangle limit for ${name}`, () => {
      expect(parseStl(fixture(name), 11)).toHaveProperty('kind', 'too-many-triangles');
    });
  }

  it('ignores binary normals and attribute bytes', () => {
    const bytes = fixture('cube-binary');
    const view = new DataView(bytes);
    view.setFloat32(84, Number.NaN, true);
    view.setUint16(132, 65535, true);
    expect(parseStl(bytes)).toHaveProperty('triangleCount', 12);
  });

  it('rejects trailing binary bytes', () => {
    const bytes = new Uint8Array(685);
    bytes.set(new Uint8Array(fixture('cube-binary')));
    expect(parseStl(bytes.buffer)).toHaveProperty('kind', 'not-stl');
  });

  it('rejects an empty ASCII mesh', () => {
    expect(parseStl(ascii('solid empty\nendsolid empty\n'))).toHaveProperty('kind', 'empty');
  });

  it('reports ASCII truncation at the end of the input', () => {
    const bytes = ascii('solid cube\nfacet normal 0 0 0\nouter loop\nvertex 0 0');
    expect(parseStl(bytes)).toMatchObject({ kind: 'truncated', byteOffset: bytes.byteLength });
  });

  it('reports malformed ASCII at the offending token', () => {
    const text = 'solid cube\nfacet normal 0 0 0\nouter loop\nwrong 0 0 0';
    expect(parseStl(ascii(text))).toMatchObject({
      kind: 'not-stl',
      byteOffset: text.indexOf('wrong'),
    });
  });

  for (const value of ['NaN', 'Infinity', '-Infinity', '1e400', '1e39']) {
    it(`rejects ASCII vertex ${value} before storing float32`, () => {
      const text = `solid cube\nfacet normal 0 0 0\nouter loop\nvertex ${value} 0 0`;
      expect(parseStl(ascii(text))).toMatchObject({
        kind: 'non-finite',
        byteOffset: text.indexOf(value),
      });
    });
  }

  it('rejects invalid triangle limits', () => {
    for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseStl(fixture('empty'), limit)).toThrow(RangeError);
    }
  });

  it('preserves byte offsets after a UTF-8 solid name', () => {
    const prefix = 'solid caf\u00e9\nfacet normal 0 0 0\nouter loop\nvertex ';
    expect(parseStl(ascii(`${prefix}NaN 0 0`))).toMatchObject({
      kind: 'non-finite',
      byteOffset: new TextEncoder().encode(prefix).byteLength,
    });
  });

  it('rejects an invalid coordinate token', () => {
    const prefix = 'solid cube\nfacet normal 0 0 0\nouter loop\nvertex ';
    expect(parseStl(ascii(`${prefix}wrong 0 0`))).toMatchObject({
      kind: 'not-stl',
      byteOffset: prefix.length,
    });
  });

  it('rejects content after the endsolid line', () => {
    const text = new TextDecoder().decode(fixture('cube-ascii-crlf'));
    expect(parseStl(ascii(`${text}facet`))).toMatchObject({
      kind: 'not-stl',
      byteOffset: text.length,
    });
  });

  it('accepts signed decimal and scientific notation', () => {
    const text = new TextDecoder().decode(fixture('cube-ascii-crlf'));
    const bytes = ascii(text.replace('vertex 0 0 0', 'vertex -1e-2 +.5 1.'));
    const mesh = parseStl(bytes);
    if ('kind' in mesh) throw new Error(mesh.message);
    expect(Array.from(mesh.positions.slice(0, 3))).toEqual([Math.fround(-0.01), 0.5, 1]);
  });

  it('uses the default triangle cap before allocating or reading records', () => {
    const bytes = new ArrayBuffer(84);
    new DataView(bytes).setUint32(80, 2_000_001, true);
    expect(parseStl(bytes)).toMatchObject({ kind: 'too-many-triangles', byteOffset: 80 });
  });
});
