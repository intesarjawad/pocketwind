import { parseObj } from './obj';
import { type Mesh, parseStl, type StlParseError } from './stl';
import { parseThreeMf } from './threemf';

export type ModelParseError = Omit<StlParseError, 'kind'> & {
  kind: StlParseError['kind'] | 'zip-unsupported' | 'no-model-part' | 'bad-xml' | 'unsupported-cad';
  part?: string;
};

export type ParsedModel = {
  mesh: Mesh;
  format: 'stl' | '3mf' | 'obj';
  unitMm: number | null;
  itemCount: number;
};

function textFormat(bytes: ArrayBuffer): 'stl' | 'obj' | null {
  const view = new DataView(bytes);
  const exactBinary =
    bytes.byteLength >= 84 && 84 + view.getUint32(80, true) * 50 === bytes.byteLength;
  if (exactBinary) return 'stl';
  const text = new TextDecoder().decode(bytes);
  if (/^solid(?:\s|$)/.test(text)) return 'stl';
  return /^\s*v[ \t]+/m.test(text) ? 'obj' : null;
}

/** Detect mesh content independently of the filename; CAD extensions get an export hint. */
export async function parseModel(
  bytes: ArrayBuffer,
  fileName: string,
  maxTriangles = 2_000_000,
): Promise<ParsedModel | ModelParseError> {
  if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 0) {
    throw new RangeError('maxTriangles must be a non-negative safe integer.');
  }
  const view = new DataView(bytes);
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === 0x04034b50) {
    const result = await parseThreeMf(bytes, maxTriangles);
    return 'kind' in result ? result : { ...result, format: '3mf' };
  }
  const detected = textFormat(bytes);
  if (detected === null && /\.(?:step|stp|iges|igs)$/i.test(fileName)) {
    return {
      kind: 'unsupported-cad',
      byteOffset: 0,
      message: 'Export this CAD model as STL, 3MF or OBJ before importing it.',
    };
  }
  const format = detected ?? 'stl';
  const mesh = format === 'obj' ? parseObj(bytes, maxTriangles) : parseStl(bytes, maxTriangles);
  return 'kind' in mesh ? mesh : { mesh, format, unitMm: null, itemCount: 1 };
}
