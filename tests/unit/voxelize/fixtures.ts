import { readFileSync } from 'node:fs';
import { type Mesh, parseStl } from '../../../src/geometry/stl';

type Point = readonly [number, number, number];
type Face = readonly [Point, Point, Point];

export function box(min: Point, max: Point, open = false): Mesh {
  const mesh = parseStl(
    Uint8Array.from(readFileSync(new URL('../../fixtures/stl/cube-binary.stl', import.meta.url)))
      .buffer,
  );
  if ('kind' in mesh) throw new Error(mesh.message);
  const positions = mesh.positions.map((value, index) => {
    const axis = index % 3;
    return (min[axis] ?? 0) + value * ((max[axis] ?? 0) - (min[axis] ?? 0));
  });
  if (!open) return { positions, triangleCount: mesh.triangleCount };
  // Remove both triangles on the maximum-X face regardless of facet order.
  const kept: number[] = [];
  for (let offset = 0; offset < positions.length; offset += 9) {
    if ([0, 3, 6].every((vertex) => positions[offset + vertex] === Math.fround(max[0]))) continue;
    kept.push(...positions.subarray(offset, offset + 9));
  }
  return { positions: new Float32Array(kept), triangleCount: kept.length / 9 };
}

function unit(point: Point): Point {
  const length = Math.hypot(...point);
  return [point[0] / length, point[1] / length, point[2] / length];
}

function midpoint(a: Point, b: Point): Point {
  return unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function split([a, b, c]: Face): Face[] {
  const ab = midpoint(a, b);
  const bc = midpoint(b, c);
  const ca = midpoint(c, a);
  return [
    [a, ab, ca],
    [b, bc, ab],
    [c, ca, bc],
    [ab, bc, ca],
  ];
}

export function sphere(centre: Point, radius: number, subdivisions = 5, extraSplits = 0): Mesh {
  const phi = (1 + Math.sqrt(5)) / 2;
  const vertices: Point[] = [
    [-1, phi, 0],
    [1, phi, 0],
    [-1, -phi, 0],
    [1, -phi, 0],
    [0, -1, phi],
    [0, 1, phi],
    [0, -1, -phi],
    [0, 1, -phi],
    [phi, 0, -1],
    [phi, 0, 1],
    [-phi, 0, -1],
    [-phi, 0, 1],
  ].map((point) => unit([point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]));
  const indices = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  let faces: Face[] = indices.map(([a = 0, b = 0, c = 0]) => {
    const first = vertices[a];
    const second = vertices[b];
    const third = vertices[c];
    if (!first || !second || !third) throw new Error('Invalid sphere facet');
    return [first, second, third];
  });
  for (let level = 0; level < subdivisions; level += 1) faces = faces.flatMap(split);
  if (extraSplits > 0)
    faces = faces.flatMap((face, index) => (index < extraSplits ? split(face) : [face]));
  const positions = new Float32Array(faces.length * 9);
  let offset = 0;
  for (const face of faces) {
    for (const point of face) {
      positions.set(
        point.map((value, axis) => value * radius + (centre[axis] ?? 0)),
        offset,
      );
      offset += 3;
    }
  }
  return { positions, triangleCount: faces.length };
}
