import { describe, expect, it } from 'vitest';
import { binTriangles, nearestLinkHit } from '../../../src/geometry/triangle-bins';
import { CELL_TYPE_MASK, CellType, NO_Q, type VoxelGrid } from '../../../src/geometry/voxel-grid';
import { voxelize } from '../../../src/geometry/voxelize';
import { buildWallLinks, DIRECTIONS } from '../../../src/geometry/wall-links';
import { box, sphere } from '../voxelize/fixtures';

const layout = { nx: 64, ny: 64, nz: 64 };
const cells = layout.nx * layout.ny * layout.nz;

type Point = readonly [number, number, number];

function analyticQ(origin: Point, direction: Point, centre: Point, radius: number): number {
  const d = direction.map((value) => -value);
  const relative = origin.map((value, axis) => value - (centre[axis] ?? 0));
  const a = d.reduce((sum, value) => sum + value * value, 0);
  const b = 2 * relative.reduce((sum, value, axis) => sum + value * (d[axis] ?? 0), 0);
  const c = relative.reduce((sum, value) => sum + value * value, 0) - radius * radius;
  return (-b - Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function pullWallType(grid: VoxelGrid, cell: number, direction: Point): number {
  const x = (cell % 64) - direction[0];
  const y = ((Math.floor(cell / 64) % 64) - direction[1] + 64) % 64;
  const z = Math.floor(cell / 4096) - direction[2];
  if (x < 0 || x >= 64 || z < 0 || z >= 64) return CellType.EQ;
  return (grid.geometry[x + 64 * (y + 64 * z)] ?? 0) & CELL_TYPE_MASK;
}

function expectedLinks(grid: VoxelGrid, cell: number) {
  if (((grid.geometry[cell] ?? 0) & CELL_TYPE_MASK) !== CellType.FLUID) return [];
  return DIRECTIONS.map((direction, i) => ({
    i,
    type: pullWallType(grid, cell, direction),
  })).filter(({ i, type }) => i > 0 && type >= CellType.SOLID && type <= CellType.FLOOR);
}

describe('wall links', () => {
  // Facet radial error is amplified by the inverse incidence cosine, so grazing q needs a surface check.
  it('matches every off-grid sphere link against an analytic ray-sphere intersection', () => {
    const centre = [31.37, 30.23, 32.41] as const;
    const radius = 20;
    const mesh = sphere(centre, radius, 5);
    expect(mesh.triangleCount).toBe(20480);
    const grid = voxelize(mesh, null, layout, { floor: false });
    const q = new Float32Array(grid.geometry.buffer, grid.geometry.byteOffset + cells * 8);
    let checked = 0;
    let analyticChecked = 0;
    let maximumRadialError = 0;
    let maximumQError = 0;
    for (const cell of grid.boundaryCells) {
      const flag = grid.geometry[cell] ?? 0;
      const base = grid.geometry[cells + cell] ?? NO_Q;
      expect(base).not.toBe(NO_Q);
      const origin: Point = [cell % 64, Math.floor(cell / 64) % 64, Math.floor(cell / 4096)];
      let offset = 0;
      DIRECTIONS.forEach((direction, i) => {
        if ((flag & (1 << (3 + i))) === 0) return;
        const expected = analyticQ(origin, direction, centre, radius);
        const actual = q[base + offset] ?? Number.NaN;
        const radialDistance = Math.hypot(
          origin[0] - actual * direction[0] - centre[0],
          origin[1] - actual * direction[1] - centre[1],
          origin[2] - actual * direction[2] - centre[2],
        );
        maximumRadialError = Math.max(maximumRadialError, Math.abs(radialDistance - radius));
        const analyticHit: Point = [
          origin[0] - expected * direction[0] - centre[0],
          origin[1] - expected * direction[1] - centre[1],
          origin[2] - expected * direction[2] - centre[2],
        ];
        const incidenceCosine =
          Math.abs(
            analyticHit[0] * direction[0] +
              analyticHit[1] * direction[1] +
              analyticHit[2] * direction[2],
          ) /
          (radius * Math.hypot(...direction));
        if (expected >= 0 && expected <= 1 && incidenceCosine >= 0.6) {
          maximumQError = Math.max(maximumQError, Math.abs(actual - expected));
          analyticChecked += 1;
        }
        expect(actual).toBeGreaterThanOrEqual(0.001 - 1e-9);
        expect(actual).toBeLessThanOrEqual(1);
        offset += 1;
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(10000);
    expect(analyticChecked).toBeGreaterThan(0);
    expect(maximumRadialError).toBeLessThan(0.02);
    expect(maximumQError).toBeLessThan(0.02);
    expect(grid.missedLinks).toBe(0);
    expect(q.length).toBe(checked);
  });

  it('packs ascending pull bits, q offsets and body-only boundary cells', () => {
    const grid = voxelize(
      box([20.25, 20.25, 20.25], [24.25, 24.25, 24.25]),
      box([30.25, 30.25, 30.25], [34.25, 34.25, 34.25]),
      layout,
      { floor: true },
    );
    const boundary = new Set(grid.boundaryCells);
    const q = new Float32Array(grid.geometry.buffer, grid.geometry.byteOffset + cells * 8);
    let nextBase = 0;
    let floorLinks = 0;
    let supportLinks = 0;
    let mismatchedMasks = 0;
    let mismatchedBoundary = 0;
    let mismatchedBases = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const flag = grid.geometry[cell] ?? 0;
      const links = expectedLinks(grid, cell);
      const expectedMask = links.reduce((mask, { i }) => mask | (1 << (3 + i)), 0);
      mismatchedMasks += Number((flag & ~CELL_TYPE_MASK) !== expectedMask);
      const touchesBody = links.some(({ type }) => type === CellType.SOLID);
      if (boundary.has(cell) !== touchesBody) mismatchedBoundary += 1;
      const linkCount = links.length;
      if (grid.geometry[cells + cell] !== (linkCount === 0 ? NO_Q : nextBase)) mismatchedBases += 1;
      links.forEach(({ type }, offset) => {
        if (type === CellType.FLOOR) {
          expect(q[nextBase + offset]).toBe(0.5);
          floorLinks += 1;
        }
        if (type === CellType.SUPPORT) supportLinks += 1;
      });
      nextBase += linkCount;
    }
    expect(mismatchedMasks).toBe(0);
    expect(mismatchedBoundary).toBe(0);
    expect(mismatchedBases).toBe(0);
    expect(q).toHaveLength(nextBase);
    expect(floorLinks).toBeGreaterThan(0);
    expect(supportLinks).toBeGreaterThan(0);
    expect(boundary.size).toBe(grid.boundaryCells.length);
    expect(grid.missedLinks).toBe(0);
  });

  it('keeps masks, offsets and boundary cells but writes halfway fractions when not measuring', () => {
    const mesh = box([20.25, 20.25, 20.25], [24.25, 24.25, 24.25]);
    const measured = voxelize(mesh, null, layout, { floor: false });
    const halfway = voxelize(mesh, null, layout, { floor: false, linkFractions: false });
    expect(halfway.geometry.subarray(0, 2 * cells)).toEqual(
      measured.geometry.subarray(0, 2 * cells),
    );
    expect(halfway.geometry).toHaveLength(measured.geometry.length);
    expect(halfway.boundaryCells).toEqual(measured.boundaryCells);
    const q = new Float32Array(halfway.geometry.buffer, cells * 8);
    expect(q.length).toBeGreaterThan(0);
    expect(q).toEqual(new Float32Array(q.length).fill(0.5));
    expect(halfway.missedLinks).toBe(0);
  });

  it('finds the nearest of multiple intersections, including bin and facet edges', () => {
    const mesh = box([4, 4, 4], [4.75, 8, 8]);
    const bins = binTriangles(mesh, { nx: 16, ny: 16, nz: 16 });
    expect(nearestLinkHit(bins, [3.5, 6, 6], [1, 0, 0])).toBeCloseTo(0.5);
    expect(nearestLinkHit(bins, [5, 6, 6], [-1, 0, 0])).toBeCloseTo(0.25);
    expect(nearestLinkHit(bins, [3, 6, 6], [1, 0, 0])).toBeCloseTo(1);
    expect(nearestLinkHit(bins, [3, 6, 6], [-1, 0, 0])).toBeNull();
  });
});

describe('wall geometry edge cases', () => {
  for (const axis of [1, 2] as const) {
    it(`uses the nearest periodic image on axis ${axis} when the floor is off`, () => {
      const low: [number, number, number] = [20.2, 20.2, 20.2];
      const high: [number, number, number] = [24.2, 24.2, 24.2];
      low[axis] = 60.2;
      high[axis] = 63.2;
      const grid = voxelize(box(low, high), null, layout, { floor: false });
      const point: [number, number, number] = [22, 22, 22];
      point[axis] = 0;
      const cell = point[0] + 64 * (point[1] + 64 * point[2]);
      const q = new Float32Array(grid.geometry.buffer, cells * 8);
      let offset = grid.geometry[cells + cell] ?? NO_Q;
      let checked = 0;
      for (const [i, direction] of DIRECTIONS.entries()) {
        if (((grid.geometry[cell] ?? 0) & (1 << (3 + i))) === 0) continue;
        if (direction[axis] === 1) {
          expect(q[offset]).toBeCloseTo(0.8, 4);
          checked += 1;
        }
        offset += 1;
      }
      expect(checked).toBe(5);
      expect(grid.missedLinks).toBe(0);
    });
  }

  it('clamps a wall arbitrarily close to a fluid centre', () => {
    const grid = voxelize(box([20.0001, 20.2, 20.2], [24.2, 24.2, 24.2]), null, layout, {
      floor: false,
    });
    const cell = 20 + 64 * (22 + 64 * 22);
    const base = grid.geometry[cells + cell] ?? NO_Q;
    const q = new Float32Array(grid.geometry.buffer, cells * 8);
    expect(q[base]).toBeCloseTo(0.001, 6);
  });
});

it('counts every missing triangle intersection and uses mid-link fractions', () => {
  const flags = new Uint32Array(cells);
  flags[32 + 64 * (32 + 64 * 32)] = CellType.SOLID;
  const grid = buildWallLinks(flags, box([10, 10, 10], [12, 12, 12]), null, layout, false);
  const q = new Float32Array(grid.geometry.buffer, cells * 8);
  expect(grid.boundaryCells).toHaveLength(18);
  expect(grid.missedLinks).toBe(18);
  expect(q).toEqual(new Float32Array(18).fill(0.5));
});
