import { expect, test } from 'vitest';
import { millionTriangleArchive } from '../../../scripts/make-3mf-fixtures';
import { parseModel } from '../../../src/geometry/model';

const bytes = millionTriangleArchive();
test('one million deflated 3MF triangles parse under 3 seconds', async ({ bench }) => {
  await bench('parseModel: 1M deflated 3MF triangles', async () => {
    const start = performance.now();
    const result = await parseModel(bytes, 'million.3mf');
    expect(result).toHaveProperty('mesh.triangleCount', 1_000_000);
    expect(performance.now() - start).toBeLessThan(3000);
  }).run({ time: 1000, iterations: 3 });
});
