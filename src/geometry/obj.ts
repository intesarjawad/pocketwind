import type { ModelParseError } from './model';
import type { Mesh } from './stl';

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function failure(
  kind: ModelParseError['kind'],
  byteOffset: number,
  message: string,
): ModelParseError {
  return { kind, byteOffset, message };
}

function readVertex(fields: string[], offset: number): number[] | ModelParseError {
  const coordinates = fields.slice(0, 3);
  if (coordinates.length !== 3 || coordinates.some((value) => !DECIMAL.test(value))) {
    return failure('not-stl', offset, 'An OBJ vertex needs three numeric coordinates.');
  }
  const vertex = coordinates.map(Number);
  return vertex.some((value) => !Number.isFinite(Math.fround(value)))
    ? failure('non-finite', offset, 'An OBJ vertex exceeds the finite float32 range.')
    : vertex;
}

function readFace(
  fields: string[],
  vertices: number[][],
  offset: number,
): number[] | ModelParseError {
  if (fields.length < 3)
    return failure('not-stl', offset, 'An OBJ face needs at least three vertices.');
  const face: number[] = [];
  for (const field of fields) {
    if (!/^[+-]?\d+(?:\/[+-]?\d+(?:\/[+-]?\d+)?|\/\/[+-]?\d+)?$/.test(field)) {
      return failure('not-stl', offset, 'An OBJ face contains an invalid vertex reference.');
    }
    const index = Number(field.split('/')[0]);
    const vertex = vertices[index > 0 ? index - 1 : vertices.length + index];
    if (index === 0 || !Number.isSafeInteger(index) || !vertex) {
      return failure('not-stl', offset, 'An OBJ face references a missing vertex.');
    }
    face.push(...vertex);
  }
  return face;
}

function appendFace(
  face: number[],
  positions: number[],
  limit: number,
  offset: number,
): ModelParseError | null {
  if (positions.length / 9 + face.length / 3 - 2 > limit) {
    return failure('too-many-triangles', offset, 'The OBJ exceeds the triangle limit.');
  }
  for (let index = 3; index < face.length - 3; index += 3) {
    positions.push(...face.slice(0, 3), ...face.slice(index, index + 6));
  }
  return null;
}

/** Read polygon faces as a triangle fan, resolving indices at each face declaration. */
export function parseObj(bytes: ArrayBuffer, maxTriangles = 2_000_000): Mesh | ModelParseError {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const vertices: number[][] = [];
  const positions: number[] = [];
  const encoder = new TextEncoder();
  let byteOffset = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
    const line = match[0];
    const fields = line.split('#', 1)[0]?.trim().split(/\s+/) ?? [];
    const tag = fields.shift();
    if (tag === 'v') {
      const vertex = readVertex(fields, byteOffset);
      if ('kind' in vertex) return vertex;
      vertices.push(vertex);
    } else if (tag === 'f') {
      const face = readFace(fields, vertices, byteOffset);
      if ('kind' in face) return face;
      const error = appendFace(face, positions, maxTriangles, byteOffset);
      if (error) return error;
    }
    byteOffset += encoder.encode(line).length;
  }
  return positions.length === 0
    ? failure('empty', 0, 'The OBJ contains no faces.')
    : { positions: new Float32Array(positions), triangleCount: positions.length / 9 };
}
