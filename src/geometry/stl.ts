export type Mesh = { positions: Float32Array; triangleCount: number };

export type StlParseError = {
  kind: 'truncated' | 'not-stl' | 'too-many-triangles' | 'empty' | 'non-finite';
  byteOffset: number;
  message: string;
};

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const RECORD_BYTES = 50;
const NORMAL_BYTES = 12;
const COORDINATES_PER_TRIANGLE = 9;
const FLOAT_BYTES = 4;
const DEFAULT_MAX_TRIANGLES = 2_000_000;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function error(kind: StlParseError['kind'], byteOffset: number): StlParseError {
  const messages: Record<StlParseError['kind'], string> = {
    truncated: 'The STL ends before the mesh is complete.',
    'not-stl': 'The file does not contain a valid STL mesh.',
    'too-many-triangles': 'The STL exceeds the triangle limit.',
    empty: 'The STL contains no triangles.',
    'non-finite': 'A vertex cannot be represented as a finite float32 coordinate.',
  };
  return { kind, byteOffset, message: messages[kind] };
}

function parseBinary(view: DataView, triangleCount: number): Mesh | StlParseError {
  if (triangleCount === 0) return error('empty', HEADER_BYTES);
  const positions = new Float32Array(triangleCount * COORDINATES_PER_TRIANGLE);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const start = HEADER_BYTES + COUNT_BYTES + triangle * RECORD_BYTES + NORMAL_BYTES;
    for (let coordinate = 0; coordinate < COORDINATES_PER_TRIANGLE; coordinate += 1) {
      const byteOffset = start + coordinate * FLOAT_BYTES;
      const value = view.getFloat32(byteOffset, true);
      if (!Number.isFinite(value)) return error('non-finite', byteOffset);
      positions[triangle * COORDINATES_PER_TRIANGLE + coordinate] = value;
    }
  }
  return { positions, triangleCount };
}

const FACET_GRAMMAR = [
  'normal',
  'ignored',
  'ignored',
  'ignored',
  'outer',
  'loop',
  'vertex',
  'coordinate',
  'coordinate',
  'coordinate',
  'vertex',
  'coordinate',
  'coordinate',
  'coordinate',
  'vertex',
  'coordinate',
  'coordinate',
  'coordinate',
  'endloop',
  'endfacet',
] as const;

function readFacet(text: string, tokens: RegExp, positions: number[]): StlParseError | null {
  for (const expected of FACET_GRAMMAR) {
    const token = tokens.exec(text);
    if (!token) return error('truncated', text.length);
    if (expected === 'ignored') continue;
    if (expected !== 'coordinate') {
      if (token[0] !== expected) return error('not-stl', token.index);
      continue;
    }
    if (!DECIMAL.test(token[0]) && !/^[+-]?(?:NaN|Infinity)$/i.test(token[0])) {
      return error('not-stl', token.index);
    }
    const value = Number(token[0]);
    if (!Number.isFinite(Math.fround(value))) return error('non-finite', token.index);
    positions.push(value);
  }
  return null;
}

function finishAscii(
  text: string,
  nameOffset: number,
  facetOffset: number,
  positions: number[],
  triangleCount: number,
): Mesh | StlParseError {
  const lineEnd = /[\r\n]/.exec(text.slice(nameOffset));
  if (lineEnd) {
    const extraOffset = nameOffset + lineEnd.index;
    const extra = /\S/.exec(text.slice(extraOffset));
    if (extra) return error('not-stl', extraOffset + extra.index);
  }
  if (triangleCount === 0) return error('empty', facetOffset);
  return { positions: new Float32Array(positions), triangleCount };
}

function parseAscii(text: string, maxTriangles: number): Mesh | StlParseError {
  const header = /^solid[^\r\n]*(?:\r\n|[\r\n]|$)/.exec(text);
  if (!header) return error('not-stl', 0);
  const tokens = /\S+/g;
  tokens.lastIndex = header[0].length;
  const positions: number[] = [];
  let triangleCount = 0;
  for (;;) {
    const facet = tokens.exec(text);
    if (!facet) return error('truncated', text.length);
    if (facet[0] === 'endsolid') {
      return finishAscii(text, tokens.lastIndex, facet.index, positions, triangleCount);
    }
    if (facet[0] !== 'facet') return error('not-stl', facet.index);
    if (triangleCount >= maxTriangles) return error('too-many-triangles', facet.index);
    const failure = readFacet(text, tokens, positions);
    if (failure) return failure;
    triangleCount += 1;
  }
}

/** Read STL triangle positions, preferring an exact binary record layout over ASCII. */
export function parseStl(
  bytes: ArrayBuffer,
  maxTriangles = DEFAULT_MAX_TRIANGLES,
): Mesh | StlParseError {
  if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 0) {
    throw new RangeError('maxTriangles must be a non-negative safe integer.');
  }
  const view = new DataView(bytes);
  const hasCount = bytes.byteLength >= HEADER_BYTES + COUNT_BYTES;
  const count = hasCount ? view.getUint32(HEADER_BYTES, true) : 0;
  const expectedLength = HEADER_BYTES + COUNT_BYTES + RECORD_BYTES * count;
  if (hasCount && expectedLength === bytes.byteLength) {
    if (count > maxTriangles) return error('too-many-triangles', HEADER_BYTES);
    return parseBinary(view, count);
  }
  // A single-byte decoder keeps token indices equal to offsets in the original file.
  const prefix = new TextDecoder('windows-1252').decode(bytes.slice(0, 6));
  if (/^solid(?:\s|$)/.test(prefix)) {
    return parseAscii(new TextDecoder('windows-1252').decode(bytes), maxTriangles);
  }
  if (hasCount && expectedLength > bytes.byteLength) {
    if (count > maxTriangles) return error('too-many-triangles', HEADER_BYTES);
    return error('truncated', bytes.byteLength);
  }
  return error('not-stl', 0);
}
