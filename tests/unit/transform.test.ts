import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Mesh, parseStl } from '../../src/geometry/stl';
import { defaultLengthCells, defaultOrientation, placeMesh } from '../../src/geometry/transform';

const layout = { nx: 256, ny: 128, nz: 128 };
const orientation = { flowAxis: 'x', flowSign: 1, upAxis: 'z' } as const;

function cube(): Mesh {
  const mesh = parseStl(
    Uint8Array.from(readFileSync(new URL('../fixtures/stl/cube-binary.stl', import.meta.url)))
      .buffer,
  );
  if ('kind' in mesh) throw new Error(mesh.message);
  return mesh;
}

function box(x: number, y: number, z: number, offset = [0, 0, 0]): Mesh {
  const mesh = cube();
  const dimensions = [x, y, z];
  mesh.positions = mesh.positions.map(
    (value, index) => value * (dimensions[index % 3] ?? 0) + (offset[index % 3] ?? 0),
  );
  return mesh;
}

function bounds(mesh: Mesh): number[][] {
  return [0, 1, 2].map((axis) => {
    const values = mesh.positions.filter((_, index) => index % 3 === axis);
    return [Math.min(...values), Math.max(...values)];
  });
}

describe('mesh placement', () => {
  it('places the cube nose at one quarter of nx and centres y and z', () => {
    const source = cube();
    const original = source.positions.slice();
    const { body, supports } = placeMesh(source, {
      ...orientation,
      layout,
      floor: false,
      lengthCells: 40,
    });
    expect(bounds(body)).toEqual([
      [64, 104],
      [44, 84],
      [44, 84],
    ]);
    expect(body.triangleCount).toBe(12);
    expect(supports).toBeNull();
    expect(source.positions).toEqual(original);
  });

  it('reverses flow without moving the nose or changing the scale', () => {
    const mesh = box(10, 4, 2, [20, -3, 7]);
    const options = { ...orientation, layout, floor: false, lengthCells: 40 };
    const forward = placeMesh(mesh, options).body;
    const reverse = placeMesh(mesh, { ...options, flowSign: -1 }).body;
    expect(bounds(forward)).toEqual(bounds(reverse));
    for (let index = 0; index < forward.positions.length; index += 3) {
      expect((forward.positions[index] ?? 0) + (reverse.positions[index] ?? 0)).toBe(168);
    }
  });

  it('scales by the longest body dimension even when it is vertical', () => {
    const result = placeMesh(box(2, 4, 10), {
      ...orientation,
      layout,
      floor: false,
      lengthCells: 40,
    });
    expect(bounds(result.body)).toEqual([
      [64, 72],
      [56, 72],
      [44, 84],
    ]);
  });

  it('rotates y flow to lattice x with z up', () => {
    const result = placeMesh(box(10, 30, 5), {
      ...defaultOrientation(box(10, 30, 5)),
      layout,
      floor: false,
      lengthCells: 60,
    });
    expect(bounds(result.body)).toEqual([
      [64, 124],
      [54, 74],
      [59, 69],
    ]);
  });

  for (const flowAxis of ['x', 'y', 'z'] as const) {
    for (const upAxis of ['x', 'y', 'z'] as const) {
      if (flowAxis === upAxis) continue;
      for (const flowSign of [-1, 1] as const) {
        it(`preserves handedness with ${flowAxis}/${flowSign} flow and ${upAxis} up`, () => {
          const mesh: Mesh = {
            triangleCount: 1,
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
          };
          const { body } = placeMesh(mesh, {
            flowAxis,
            flowSign,
            upAxis,
            layout,
            floor: false,
            lengthCells: 1,
          });
          const sourceUp = { x: 0, y: 1, z: 2 }[upAxis];
          for (let vertex = 0; vertex < 3; vertex += 1) {
            expect(body.positions[vertex * 3 + 2]).toBe(
              63.5 + (mesh.positions[vertex * 3 + sourceUp] ?? 0),
            );
          }
          // A proper rotation preserves the cross product's component along up.
          const p = body.positions;
          const ax = (p[3] ?? 0) - (p[0] ?? 0);
          const ay = (p[4] ?? 0) - (p[1] ?? 0);
          const bx = (p[6] ?? 0) - (p[0] ?? 0);
          const by = (p[7] ?? 0) - (p[1] ?? 0);
          expect(ax * by - ay * bx + 0).toBe({ x: 0, y: -1, z: 1 }[upAxis]);
        });
      }
    }
  }

  it('places supports and body with one transform and rests their union on the floor', () => {
    const mesh = box(10, 4, 2, [0, 0, 5]);
    const supports = box(2, 2, 5, [2, 1, 0]);
    const original = supports.positions.slice();
    const result = placeMesh(mesh, {
      ...orientation,
      layout,
      floor: true,
      lengthCells: 40,
      supports,
    });
    expect(bounds(result.body)).toEqual([
      [64, 104],
      [56, 72],
      [20.5, 28.5],
    ]);
    if (!result.supports) throw new Error('Missing transformed supports');
    expect(bounds(result.supports)).toEqual([
      [72, 80],
      [60, 68],
      [0.5, 20.5],
    ]);
    expect(supports.positions).toEqual(original);
  });

  it('rests the body on the floor without supports', () => {
    const result = placeMesh(box(10, 4, 2, [10, -8, 20]), {
      ...orientation,
      layout,
      floor: true,
      lengthCells: 40,
    });
    expect(bounds(result.body)).toEqual([
      [64, 104],
      [56, 72],
      [0.5, 8.5],
    ]);
  });

  it('rejects parallel flow and up axes and invalid lengths', () => {
    expect(() =>
      placeMesh(cube(), { ...orientation, upAxis: 'x', layout, floor: false, lengthCells: 40 }),
    ).toThrow(RangeError);
    for (const lengthCells of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        placeMesh(cube(), { ...orientation, layout, floor: false, lengthCells }),
      ).toThrow(RangeError);
    }
  });
});

describe('dropped mesh defaults', () => {
  it('chooses the longest horizontal extent, with x winning ties', () => {
    expect(defaultOrientation(box(10, 30, 5))).toEqual({ ...orientation, flowAxis: 'y' });
    expect(defaultOrientation(box(30, 10, 5))).toEqual(orientation);
    expect(defaultOrientation(box(10, 10, 30))).toEqual(orientation);
  });

  it('caps a sphere bounding box at 36 cells at tier L', () => {
    const sphere: Mesh = {
      triangleCount: 2,
      positions: new Float32Array([
        -150, 0, 0, 150, 0, 0, 0, -150, 0, 0, 150, 0, 0, 0, -150, 0, 0, 150,
      ]),
    };
    for (const floor of [true, false]) {
      const length = defaultLengthCells(sphere, layout, floor);
      expect(length).toBe(36);
      expect(length ** 2 / (layout.ny * layout.nz)).toBeLessThanOrEqual(0.08);
    }
  });

  it('uses the blockage cap for Ahmed dimensions and the length cap for a slender body', () => {
    const ahmed = box(1044, 389, 288);
    const blockLength = Math.floor(Math.sqrt((0.08 * 128 * 128) / (389 * 288)) * 1044);
    expect(defaultLengthCells(ahmed, layout, true)).toBe(Math.min(0.4 * 256, blockLength));
    expect(defaultLengthCells(box(1000, 1, 1), layout, false)).toBe(0.4 * 256);
  });

  it('sizes y-oriented and tall bodies by their longest dimension', () => {
    expect(defaultLengthCells(box(389, 1044, 288), layout, false)).toBe(
      defaultLengthCells(box(1044, 389, 288), layout, false),
    );
    expect(defaultLengthCells(box(1, 1, 10), layout, false)).toBe(102.4);
  });
});
