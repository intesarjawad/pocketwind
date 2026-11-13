import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { presetMesh, presetSupports } from '../src/geometry/presets';
import type { Mesh } from '../src/geometry/stl';
import { canonicalStl } from './stl-canonical';

/** Export the exact browser triangles, with canonical STL headers and zero normals. */
export function meshStl(mesh: Mesh): Uint8Array {
  const bytes = new Uint8Array(84 + mesh.triangleCount * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, mesh.triangleCount, true);
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      view.setFloat32(
        84 + triangle * 50 + 12 + coordinate * 4,
        mesh.positions[triangle * 9 + coordinate] ?? 0,
        true,
      );
    }
  }
  return canonicalStl(bytes);
}

function main(): void {
  const directory = process.env.GEOMETRY_DIR ?? 'public/validation/geometry';
  mkdirSync(directory, { recursive: true });
  const parts = [
    ['ahmed-25', presetMesh('ahmed-25')],
    ['cube', presetMesh('cube')],
    ['sphere', presetMesh('sphere')],
    ['stilts', presetSupports('ahmed-25')],
  ] as const;
  for (const [name, mesh] of parts) {
    if (mesh === null) throw new Error(`Missing runtime geometry: ${name}.`);
    writeFileSync(join(directory, `${name}.stl`), meshStl(mesh));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
