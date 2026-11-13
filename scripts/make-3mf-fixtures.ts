import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/geometry/zip';

export type FixturePart = { name: string; text: string; method?: number; flags?: number };

/** Write reproducible ZIP headers with no timestamps or platform attributes. */
export function makeArchive(parts: FixturePart[]): ArrayBuffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, text, method = 8, flags = 0 } of parts) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, central, end])).buffer;
}

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
export const MODEL_PATH = '3D/3dmodel.model';
const RELS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="start" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>';
const CONTENT_TYPES =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const VERTICES = [
  [0, 0, 0],
  [300, 0, 0],
  [300, 300, 0],
  [0, 300, 0],
  [0, 0, 300],
  [300, 0, 300],
  [300, 300, 300],
  [0, 300, 300],
];
const FACES = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];

function meshXml(vertices: number[][], faces: number[][]): string {
  return `<mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
}

export const CUBE_OBJECT = `<object id="1" type="model">${meshXml(VERTICES, FACES)}</object>`;
export function modelXml(
  objects = CUBE_OBJECT,
  build = '<item objectid="1"/>',
  unit = 'millimeter',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?><model xmlns="${CORE}" xmlns:p="${PRODUCTION}" unit="${unit}"><resources>${objects}</resources><build>${build}</build></model>`;
}

export function modelArchive(text: string, method = 8): ArrayBuffer {
  return makeArchive([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: RELS },
    { name: MODEL_PATH, text, method },
  ]);
}

/** Share vertices across faces so subdivision preserves a closed, outward-facing surface. */
function ellipsoidXml(): string {
  const phi = (1 + Math.sqrt(5)) / 2;
  const vertices = [
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
  ].map(normalize);
  let faces = [
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
  // Seven refinements of the 20-face icosahedron give 327680 faces.
  for (let level = 1; level <= 7; level += 1) {
    const midpoints = new Map<string, number>();
    function midpoint(a: number, b: number): number {
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const first = vertices[a];
      const second = vertices[b];
      if (!first || !second) throw new Error('Missing sphere vertex.');
      const point = normalize(first.map((value, axis) => (value + (second[axis] ?? 0)) / 2));
      const index = vertices.length;
      vertices.push(point);
      midpoints.set(key, index);
      return index;
    }
    faces = faces.flatMap(([a = 0, b = 0, c = 0]) => {
      const ab = midpoint(a, b),
        bc = midpoint(b, c),
        ca = midpoint(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  const stretched = vertices.map(([x = 0, y = 0, z = 0]) => [x * 450, y * 150, z * 150]);
  return modelXml(`<object id="1" type="model">${meshXml(stretched, faces)}</object>`);
}

function normalize(point: number[]): number[] {
  const length = Math.hypot(...point);
  return point.map((coordinate) => coordinate / length);
}

export function millionTriangleArchive(): ArrayBuffer {
  const columns = 1000;
  const rows = 500;
  const vertices: number[][] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= columns; x += 1) {
      vertices.push([x, y, ((x % 32) * (y % 32)) / 1024]);
    }
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const a = y * (columns + 1) + x;
      const b = a + 1;
      const c = a + columns + 1;
      faces.push([a, b, c], [b, c + 1, c]);
    }
  }
  return modelArchive(modelXml(`<object id="1">${meshXml(vertices, faces)}</object>`));
}

function writeFixtures(): void {
  const root = new URL('../tests/fixtures/', import.meta.url);
  for (const directory of ['3mf', 'obj', 'cold-start'])
    mkdirSync(new URL(`${directory}/`, root), { recursive: true });
  const write = (name: string, bytes: ArrayBuffer) =>
    writeFileSync(new URL(name, root), new Uint8Array(bytes));
  write('3mf/single-object.3mf', modelArchive(modelXml()));
  write('3mf/stored.3mf', modelArchive(modelXml(), 0));
  write('3mf/inch.3mf', modelArchive(modelXml(CUBE_OBJECT, '<item objectid="1"/>', 'inch')));
  const components = `${CUBE_OBJECT}<object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></components></object>`;
  const items =
    '<item objectid="2" transform="0 1 0 -1 0 0 0 0 1 1000 0 0"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 -300 0 0"/>';
  write('3mf/components.3mf', modelArchive(modelXml(components, items)));
  write(
    '3mf/external-part.3mf',
    makeArchive([
      { name: '[Content_Types].xml', text: CONTENT_TYPES },
      { name: '_rels/.rels', text: RELS },
      {
        name: MODEL_PATH,
        text: modelXml(
          '<object id="2"><components><component objectid="1" p:path="/3D/Objects/cube.model" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></components></object>',
          '<item objectid="2"/>',
        ),
      },
      { name: '3D/Objects/cube.model', text: modelXml() },
    ]),
  );
  const zip64 = modelArchive(modelXml());
  new DataView(zip64).setUint16(zip64.byteLength - 12, 0xffff, true);
  write('3mf/zip64.3mf', zip64);
  write('3mf/encrypted.3mf', makeArchive([{ name: MODEL_PATH, text: modelXml(), flags: 1 }]));
  write(
    '3mf/unsupported-method.3mf',
    makeArchive([{ name: MODEL_PATH, text: modelXml(), method: 12 }]),
  );
  write('3mf/missing-model.3mf', makeArchive([{ name: '_rels/.rels', text: RELS }]));
  write('cold-start/ellipsoid.3mf', modelArchive(ellipsoidXml()));
  const quadFaces = [
    [1, 4, 3, 2],
    [5, 6, 7, 8],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 4, 8, 7],
    [4, 1, 5, 8],
  ];
  writeFileSync(
    new URL('obj/quad-cube.obj', root),
    `${VERTICES.map((vertex) => `v ${vertex.join(' ')}`).join('\r\n')}\r\n${quadFaces.map((face) => `f ${face.join(' ')}`).join('\r\n')}\r\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFixtures();
