import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Mesh } from '../../../src/geometry/stl';

export function fixture(name: string): ArrayBuffer {
  return Uint8Array.from(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url))).buffer;
}

export function bounds(mesh: Mesh, min: number[], max: number[]): void {
  for (let axis = 0; axis < 3; axis += 1) {
    let low = Infinity;
    let high = -Infinity;
    for (let coordinate = axis; coordinate < mesh.positions.length; coordinate += 3) {
      const value = mesh.positions[coordinate] ?? NaN;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(Math.abs(low - (min[axis] ?? NaN))).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(high - (max[axis] ?? NaN))).toBeLessThanOrEqual(1e-3);
  }
}
