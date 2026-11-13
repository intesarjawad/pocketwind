import { expect, test } from 'vitest';
import { voxelize } from '../../../src/geometry/voxelize';
import { sphere } from './fixtures';

const mesh = sphere([84.37, 64.23, 64.41], 18, 6, 39360);

test('200k triangles at 256 × 128 × 128 under 400 ms', async ({ bench }) => {
  expect(mesh.triangleCount).toBe(200000);
  await bench('voxelize 200k triangles at tier L', () => {
    const start = performance.now();
    const grid = voxelize(mesh, null, { nx: 256, ny: 128, nz: 128 }, { floor: false });
    const elapsedMs = performance.now() - start;
    expect(grid.solidCells).toBeGreaterThan(0);
    expect(grid.watertight).toBe(true);
    expect(elapsedMs).toBeLessThan(400);
  }).run({ time: 1000, iterations: 3 });
});
