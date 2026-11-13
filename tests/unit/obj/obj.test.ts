import { describe, expect, it } from 'vitest';
import { parseObj } from '../../../src/geometry/obj';
import { bounds, fixture } from '../model/fixtures';

const parse = (text: string, limit?: number) =>
  parseObj(new TextEncoder().encode(text).buffer, limit);
const vertices = 'v 0 0 0\r\nv 1 0 0\r\nv 1 1 0\r\nv 0 1 0\r\n';

describe('OBJ polygon import', () => {
  it('fans a CRLF quad cube into twelve triangles', () => {
    const mesh = parseObj(fixture('obj/quad-cube.obj'));
    if ('kind' in mesh) throw new Error(mesh.message);
    expect(mesh.triangleCount).toBe(12);
    bounds(mesh, [0, 0, 0], [300, 300, 300]);
  });
  for (const face of ['1 2 3 4', '1/9/8 2/7/6 3/5/4 4/3/2', '1//4 2//3 3//2 4//1', '-4 -3 -2 -1']) {
    it(`resolves ${face}`, () => {
      const mesh = parse(`${vertices}vt 0 0\nvn 0 0 1\ng cube\nusemtl red\n f ${face} # face\n`);
      if ('kind' in mesh) throw new Error(mesh.message);
      expect(mesh.triangleCount).toBe(2);
      expect(Array.from(mesh.positions)).toEqual([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0,
      ]);
    });
  }
  it('resolves negative indices before later vertices are declared', () => {
    expect(parse(`${vertices}f -4 -3 -2\nv 9 9 9`)).toHaveProperty('triangleCount', 1);
  });
  for (const face of ['0 1 2', '1 2 5', '-5 -2 -1', '1.5 2 3', '1 2', '1/no 2 3', '1/ 2/ 3/']) {
    it(`rejects invalid face ${face}`, () =>
      expect(parse(`${vertices}f ${face}`)).toHaveProperty('kind', 'not-stl'));
  }
  it('rejects malformed and overflowing coordinates', () => {
    expect(parse('v 1 2')).toHaveProperty('kind', 'not-stl');
    expect(parse('v 1e50 0 0')).toHaveProperty('kind', 'non-finite');
    expect(parse('v NaN 0 0')).toHaveProperty('kind', 'not-stl');
  });
  it('reports byte offsets after UTF-8 comments and mixed line endings', () => {
    const prefix = '\uFEFF# café\r\n' + vertices;
    expect(parse(`${prefix}f 0 1 2`)).toMatchObject({
      kind: 'not-stl',
      byteOffset: new TextEncoder().encode(prefix).length,
    });
  });
  it('enforces limits after polygon triangulation', () =>
    expect(parse(`${vertices}f 1 2 3 4`, 1)).toHaveProperty('kind', 'too-many-triangles'));
  it('reports vertices without faces as empty', () =>
    expect(parse(vertices)).toHaveProperty('kind', 'empty'));
});
