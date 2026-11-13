import { describe, expect, it } from 'vitest';
import {
  describeDrop,
  droppedPlacement,
  fileCheckText,
  formatLengthMm,
  type LoadedModel,
  longestSideMm,
  MAX_MODEL_BYTES,
  modelErrorText,
  modelFileCheck,
  unitLabel,
} from '../../../src/app/dropzone';
import { MESSAGES } from '../../../src/app/messages';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import { parseModel } from '../../../src/geometry/model';
import type { Mesh } from '../../../src/geometry/stl';
import { fixture } from '../model/fixtures';

function mesh(positions: number[]): Mesh {
  return { positions: new Float32Array(positions), triangleCount: positions.length / 9 };
}

const INCH_CUBE: LoadedModel = {
  mesh: mesh([0, 0, 0, 7620, 0, 0, 0, 7620, 7620]),
  format: '3mf',
  unitMm: 25.4,
};

describe('model file checks', () => {
  it.each(['wing.stl', 'wing.3mf', 'wing.obj', 'WING.STL'])('accepts %s', (name) => {
    expect(modelFileCheck({ name, size: 1024 })).toEqual({ ok: true });
  });

  it.each(['part.step', 'part.stp', 'part.iges', 'part.igs', 'PART.STEP'])(
    'asks for an export from CAD for %s without reading it',
    (name) => {
      expect(modelFileCheck({ name, size: 1 })).toEqual({
        ok: false,
        messageId: 'model-unsupported-cad',
      });
    },
  );

  it('rejects a file over 200 MB before reading it', () => {
    expect(modelFileCheck({ name: 'wing.stl', size: MAX_MODEL_BYTES + 1 })).toEqual({
      ok: false,
      messageId: 'model-too-large',
    });
    expect(modelFileCheck({ name: 'wing.stl', size: MAX_MODEL_BYTES })).toEqual({ ok: true });
  });

  it('rejects another file type with a next step', () => {
    expect(modelFileCheck({ name: 'notes.txt', size: 10 })).toEqual({
      ok: false,
      messageId: 'model-unsupported-format',
    });
    expect(fileCheckText({ ok: false, messageId: 'model-unsupported-format' })).toBe(
      `${MESSAGES['model-unsupported-format'].what} ${MESSAGES['model-unsupported-format'].next}`,
    );
  });
});

describe('model error text', () => {
  it('names the parser kind and the byte offset', () => {
    const text = modelErrorText({ kind: 'truncated', message: '', byteOffset: 12 });
    expect(text).toContain(MESSAGES['model-truncated'].what);
    expect(text).toContain('(truncated at byte 12)');
    expect(text).toContain(MESSAGES['model-truncated'].next);
  });

  it('names the 3MF part when the archive has one', () => {
    const text = modelErrorText({
      kind: 'bad-xml',
      message: '',
      byteOffset: 4,
      part: '3D/3dmodel.model',
    });
    expect(text).toContain('(bad-xml in 3D/3dmodel.model)');
  });

  it('falls back to the operation message for an unknown kind', () => {
    expect(modelErrorText({ kind: 'mystery', message: '' })).toContain(
      MESSAGES['model-operation-failed'].what,
    );
  });
});

describe('dropped model description', () => {
  it('reads a 3MF unit and reports the longest side in millimetres', () => {
    expect(unitLabel(25.4)).toBe('inches');
    expect(unitLabel(1)).toBe('millimetres');
    expect(unitLabel(null)).toBe('millimetres');
    expect(unitLabel(10)).toBe('centimetres');
    expect(unitLabel(304.8)).toBe('feet');
    expect(unitLabel(1000)).toBe('metres');
    expect(unitLabel(2.54)).toBe('2.54 mm units');
  });

  it('measures the longest bounding-box side', () => {
    expect(longestSideMm(INCH_CUBE.mesh)).toBe(7620);
    expect(longestSideMm(mesh([0, 0, 0, 10, 0, 0, 0, 30, 5]))).toBe(30);
  });

  it('formats whole and fractional millimetres without noise', () => {
    expect(formatLengthMm(7620)).toBe('7620');
    expect(formatLengthMm(25.4)).toBe('25.4');
  });

  it('uses the longest side for the first orientation', () => {
    expect(droppedPlacement(mesh([0, 0, 0, 10, 0, 0, 0, 30, 5]))).toEqual({
      flowAxis: 'y',
      flowSign: 1,
      upAxis: 'z',
    });
  });

  it('describes the size, orientation and speed after a drop', () => {
    expect(describeDrop(INCH_CUBE, { ...DEFAULT_SETTINGS, bodyLengthMm: 7620 })).toEqual({
      size: '7620 mm, read as inches',
      orientation: 'flow along the longest side',
      speed: '40 m/s',
    });
  });

  it('follows a changed size in the description', () => {
    expect(describeDrop(INCH_CUBE, { ...DEFAULT_SETTINGS, bodyLengthMm: 500 }).size).toBe(
      '500 mm, read as inches',
    );
  });

  it('describes an orientation the person changed', () => {
    expect(
      describeDrop(INCH_CUBE, { ...DEFAULT_SETTINGS, flowAxis: 'z', upAxis: 'y' }).orientation,
    ).toBe('flow along Z, up Y');
  });

  it('reads the inch 3MF fixture as 25.4 times its 300 unit side', async () => {
    const parsed = await parseModel(fixture('3mf/unit-inch.3mf'), 'unit-inch.3mf');
    if ('kind' in parsed) throw new Error(parsed.message);
    expect(parsed.unitMm).toBe(25.4);
    expect(longestSideMm(parsed.mesh)).toBe(300 * 25.4);
    expect(
      describeDrop(
        { mesh: parsed.mesh, format: parsed.format, unitMm: parsed.unitMm },
        { ...DEFAULT_SETTINGS, bodyLengthMm: 300 * 25.4 },
      ),
    ).toEqual({
      size: '7620 mm, read as inches',
      orientation: 'flow along the longest side',
      speed: '40 m/s',
    });
  });
});
