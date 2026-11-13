import { describe, expect, it } from 'vitest';
import { presetMesh, presetSupports } from '../../src/geometry/presets';
import type { Mesh } from '../../src/geometry/stl';
import { placeMesh } from '../../src/geometry/transform';
import { voxelize } from '../../src/geometry/voxelize';

function bounds(mesh: Mesh): {
  min: [number, number, number];
  size: [number, number, number];
} {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[offset + axis] ?? NaN;
      min[axis] = Math.min(min[axis] ?? value, value);
      max[axis] = Math.max(max[axis] ?? value, value);
    }
  }
  return {
    min: [min[0] ?? NaN, min[1] ?? NaN, min[2] ?? NaN],
    size: [
      (max[0] ?? 0) - (min[0] ?? 0),
      (max[1] ?? 0) - (min[1] ?? 0),
      (max[2] ?? 0) - (min[2] ?? 0),
    ],
  };
}

function requireMesh(presetId: string): Mesh {
  const mesh = presetMesh(presetId);
  if (mesh === null) throw new Error(`Expected a mesh for ${presetId}.`);
  return mesh;
}

function requireSupports(presetId: string): Mesh {
  const mesh = presetSupports(presetId);
  if (mesh === null) throw new Error(`Expected supports for ${presetId}.`);
  return mesh;
}

describe('preset geometry', () => {
  it('builds the Ahmed body at its reference size', () => {
    expect(bounds(requireMesh('ahmed-25')).size).toEqual([1044, 389, 288]);
  });

  it('lifts the Ahmed body 50 mm onto four 30 mm stilts', () => {
    expect(bounds(requireMesh('ahmed-25')).min[2]).toBe(50);
    const { min, size } = bounds(requireSupports('ahmed-25'));
    expect(min[2]).toBe(0);
    expect(size[2]).toBe(50);
    expect(size[0]).toBeCloseTo(672 - 202 + 30, 9);
    expect(size[1]).toBeCloseTo(2 * 163.5 + 30, 9);
    expect(presetSupports('sphere')).toBeNull();
  });

  it('rounds the four front edges of the Ahmed body with the 100 mm radius', () => {
    const positions = requireMesh('ahmed-25').positions;
    const nose: number[][] = [];
    for (let offset = 0; offset < positions.length; offset += 3) {
      if (positions[offset] === 0)
        nose.push([positions[offset + 1] ?? NaN, positions[offset + 2] ?? NaN]);
    }
    const ys = nose.map(([y]) => y ?? NaN);
    const zs = nose.map(([, z]) => z ?? NaN);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-94.5, 94.5]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([150, 238]);
  });

  it('cuts a 222 mm rear slant at 25 degrees', () => {
    const positions = requireMesh('ahmed-25').positions;
    let baseTop = -Infinity;
    for (let offset = 0; offset < positions.length; offset += 3) {
      if (positions[offset] === 1044) baseTop = Math.max(baseTop, positions[offset + 2] ?? NaN);
    }
    expect(baseTop).toBeCloseTo(338 - 222 * Math.sin((25 * Math.PI) / 180), 4);
  });

  it('builds a 100 mm cube', () => {
    expect(bounds(requireMesh('cube')).size).toEqual([100, 100, 100]);
  });

  it('builds a 100 mm sphere', () => {
    expect(bounds(requireMesh('sphere')).size.map((value) => Math.round(value))).toEqual([
      100, 100, 100,
    ]);
  });

  it('has no geometry for an unknown preset', () => {
    expect(presetMesh('custom')).toBeNull();
    expect(presetMesh('missing')).toBeNull();
  });

  it('voxelizes the Ahmed body as a closed surface', () => {
    const layout = { nx: 64, ny: 32, nz: 32 };
    const placed = placeMesh(requireMesh('ahmed-25'), {
      layout,
      lengthCells: 32,
      flowAxis: 'x',
      flowSign: 1,
      upAxis: 'z',
      floor: true,
      supports: requireSupports('ahmed-25'),
    });
    const grid = voxelize(placed.body, placed.supports, layout, { floor: true });
    expect(grid.watertight).toBe(true);
    expect(grid.solidCells).toBeGreaterThan(0);
  });

  it('voxelizes the cube as a closed surface', () => {
    const layout = { nx: 32, ny: 32, nz: 32 };
    const placed = placeMesh(requireMesh('cube'), {
      layout,
      lengthCells: 8,
      flowAxis: 'x',
      flowSign: 1,
      upAxis: 'z',
      floor: false,
    });
    const grid = voxelize(placed.body, placed.supports, layout, { floor: false });
    expect(grid.watertight).toBe(true);
    expect(grid.solidCells).toBe(8 * 8 * 8);
  });

  it('voxelizes the sphere as a closed surface', () => {
    const layout = { nx: 32, ny: 32, nz: 32 };
    const placed = placeMesh(requireMesh('sphere'), {
      layout,
      lengthCells: 12,
      flowAxis: 'x',
      flowSign: 1,
      upAxis: 'z',
      floor: false,
    });
    const grid = voxelize(placed.body, placed.supports, layout, { floor: false });
    expect(grid.watertight).toBe(true);
    expect(grid.solidCells).toBeGreaterThan(0);
  });
});
