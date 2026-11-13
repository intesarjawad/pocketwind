import { describe, expect, it } from 'vitest';
import { parseModel } from '../../../src/geometry/model';
import { fixture } from './fixtures';

describe('model content dispatch', () => {
  for (const [path, format, unitMm] of [
    ['stl/cube-binary.stl', 'stl', null],
    ['stl/cube-ascii-crlf.stl', 'stl', null],
    ['stl/solid-header-binary.stl', 'stl', null],
    ['3mf/single-object.3mf', '3mf', 1],
    ['obj/quad-cube.obj', 'obj', null],
    ['3mf/inch.3mf', '3mf', 25.4],
  ] as const) {
    it(`detects ${path} regardless of its extension`, async () =>
      expect(await parseModel(fixture(path), 'misnamed.step')).toMatchObject({
        format,
        unitMm,
        itemCount: 1,
        mesh: { triangleCount: 12 },
      }));
  }
  for (const name of ['part.step', 'part.STP', 'part.iges', 'part.IGS']) {
    it(`gives an export hint for ${name}`, async () =>
      expect(
        await parseModel(new TextEncoder().encode('ISO-10303-21;').buffer, name),
      ).toMatchObject({ kind: 'unsupported-cad', message: expect.stringContaining('Export') }));
  }
  it('retains STL errors and honors limits across formats', async () => {
    expect(await parseModel(fixture('stl/truncated.stl'), 'bad.stl')).toHaveProperty(
      'kind',
      'truncated',
    );
    for (const name of ['stl/cube-binary.stl', '3mf/single-object.3mf', 'obj/quad-cube.obj']) {
      expect(await parseModel(fixture(name), name, 11)).toHaveProperty(
        'kind',
        'too-many-triangles',
      );
    }
  });
  it('rejects invalid limits', async () => {
    for (const limit of [-1, NaN, 0.5])
      await expect(parseModel(new ArrayBuffer(0), 'x', limit)).rejects.toThrow(RangeError);
  });
  it('keeps OBJ vertex text in a binary STL header from changing dispatch', async () => {
    const bytes = fixture('stl/cube-binary.stl');
    new Uint8Array(bytes).set(new TextEncoder().encode('v 0 0 0\n'));
    expect(await parseModel(bytes, 'cube.obj')).toHaveProperty('format', 'stl');
  });
});
