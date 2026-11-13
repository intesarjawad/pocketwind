import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseStl } from '../src/geometry/stl';

const HEADER = 'pocketwind preset geometry';
const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const RECORD_BYTES = 50;
const NORMAL_BYTES = 12;

/**
 * Rewrite any STL as binary with a fixed header, zero normals and zero attribute bytes,
 * so the same mesh always produces the same bytes and the same checksum.
 */
export function canonicalStl(bytes: Uint8Array): Uint8Array {
  const mesh = parseStl(Uint8Array.from(bytes).buffer);
  if ('kind' in mesh) throw new Error(`${mesh.message} (${mesh.kind} at byte ${mesh.byteOffset})`);
  const out = new Uint8Array(HEADER_BYTES + COUNT_BYTES + RECORD_BYTES * mesh.triangleCount);
  out.set(new TextEncoder().encode(HEADER));
  const view = new DataView(out.buffer);
  view.setUint32(HEADER_BYTES, mesh.triangleCount, true);
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const start = HEADER_BYTES + COUNT_BYTES + triangle * RECORD_BYTES + NORMAL_BYTES;
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      const value = mesh.positions[triangle * 9 + coordinate] ?? 0;
      // Negative zero would otherwise change the bytes without changing the mesh.
      view.setFloat32(start + coordinate * 4, value === 0 ? 0 : value, true);
    }
  }
  return out;
}

function main(argv: readonly string[]): void {
  const [input, output, ...extra] = argv;
  if (input === undefined || output === undefined || extra.length > 0) {
    throw new Error('Usage: stl-canonical.ts <input.stl> <output.stl>');
  }
  writeFileSync(output, canonicalStl(readFileSync(input)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
