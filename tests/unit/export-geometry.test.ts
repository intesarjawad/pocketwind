import { describe, expect, it } from 'vitest';
import { meshStl } from '../../scripts/export-geometry';
import { presetMesh, presetSupports } from '../../src/geometry/presets';
import { parseStl } from '../../src/geometry/stl';

describe('validation geometry export', () => {
  it('round-trips the exact browser triangles for every measured body and its supports', () => {
    for (const mesh of [
      presetMesh('ahmed-25'),
      presetMesh('sphere'),
      presetMesh('cube'),
      presetSupports('ahmed-25'),
    ]) {
      if (mesh === null) throw new Error('Missing preset geometry.');
      const bytes = meshStl(mesh);
      const decoded = parseStl(Uint8Array.from(bytes).buffer);
      if ('kind' in decoded) throw new Error(decoded.message);
      expect(decoded.triangleCount).toBe(mesh.triangleCount);
      expect([...decoded.positions]).toEqual(
        [...mesh.positions].map((value) => (value === 0 ? 0 : value)),
      );
      expect(meshStl(mesh)).toEqual(bytes);
    }
  });
});
