import type { ModelParseError } from './model';
import type { Mesh } from './stl';
import { inflateZipPart, readZip, type ZipPart } from './zip';

type Attributes = Record<string, string>;
type Reference = { id: string; path: string; transform: number[] };
type ObjectMesh = { vertices: number[]; indices: number[]; components: Reference[] };
type ModelPart = { objects: Map<string, ObjectMesh>; items: Reference[]; unitMm: number };
type Instance = { object: ObjectMesh; transforms: number[][]; unitMm: number };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const UNITS: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function invalid(message: string): never {
  throw new SyntaxError(message);
}

function unescapeXml(value: string): string {
  return value.replace(/&([^;]*);|&/g, (_match, entity: string | undefined) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity && Object.hasOwn(named, entity) && named[entity] !== undefined) return named[entity];
    if (entity && /^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) {
      const code = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))
        return String.fromCodePoint(code);
    }
    return invalid('The XML contains an unknown or invalid entity.');
  });
}

function tagAttributes(token: string, name: string, pattern: RegExp): Attributes {
  const attrs: Attributes = {};
  let cursor = name.length + 1;
  for (;;) {
    pattern.lastIndex = cursor;
    const attribute = pattern.exec(token);
    if (!attribute) break;
    const key = attribute[1];
    if (!key || Object.hasOwn(attrs, key)) invalid('The XML has duplicate attributes.');
    const value = attribute[2] ?? attribute[3] ?? '';
    attrs[key] = value.includes('&') ? unescapeXml(value) : value;
    cursor = pattern.lastIndex;
  }
  if (!/^\s*\/?>$/.test(token.slice(cursor))) invalid('The XML attributes must be quoted.');
  return attrs;
}

// DOMParser is exposed to Window only; this scanner also runs in module workers.
function scanXml(text: string, visit: (path: string, attrs: Attributes) => void): void {
  const tags =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  const stack: string[] = [];
  const paths: string[] = [];
  const attributes = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let offset = 0;
  let roots = 0;
  for (const match of text.matchAll(tags)) {
    const gap = text.slice(offset, match.index);
    if (gap.includes('<') || (stack.length === 0 && gap.trim()))
      invalid('The XML contains malformed text.');
    const token = match[0];
    offset = match.index + token.length;
    if (token.startsWith('<?') || token.startsWith('<!')) continue;
    const name = /^<\/?([\w.:-]+)/.exec(token)?.[1];
    if (!name) invalid('The XML element has no name.');
    if (token.startsWith('</')) {
      if (!/^<\/[\w.:-]+\s*>$/.test(token)) invalid('The XML closing tag is malformed.');
      if (stack.pop() !== name) invalid('The XML elements are not balanced.');
      paths.pop();
      continue;
    }
    if (stack.length === 0) roots += 1;
    const localName = name.slice(name.lastIndexOf(':') + 1);
    const parent = paths.at(-1);
    const path = parent ? `${parent}/${localName}` : localName;
    visit(path, tagAttributes(token, name, attributes));
    if (!token.endsWith('/>')) {
      stack.push(name);
      paths.push(path);
    }
  }
  if (stack.length || roots !== 1 || text.slice(offset).trim())
    invalid('The XML document is incomplete.');
}

function number(value: string | undefined): number {
  if (value === undefined || !DECIMAL.test(value) || !Number.isFinite(Number(value))) {
    return invalid('A model coordinate or transform is not a finite number.');
  }
  return Number(value);
}

function reference(attrs: Attributes): Reference {
  const id = attrs.objectid;
  if (!id) invalid('A component or build item is missing its object ID.');
  const transform =
    attrs.transform === undefined ? IDENTITY : attrs.transform.trim().split(/\s+/).map(number);
  if (transform.length !== 12) invalid('A 3MF transform must contain twelve numbers.');
  return {
    id,
    path: Object.entries(attrs).find(([key]) => key.endsWith(':path'))?.[1] ?? '',
    transform,
  };
}

function triangleIndex(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    invalid('A triangle index is invalid.');
  }
  return Number(value);
}

function modelUnit(unit: string): number {
  const mm = UNITS[unit];
  if (!Object.hasOwn(UNITS, unit) || mm === undefined) invalid('The 3MF unit is unsupported.');
  return mm;
}

function parsePart(text: string, maxTriangles: number): ModelPart {
  const result: ModelPart = { objects: new Map(), items: [], unitMm: 1 };
  let current: ObjectMesh | undefined;
  let modelSeen = false;
  scanXml(text, (path, attrs) => {
    switch (path) {
      case 'model': {
        modelSeen = true;
        result.unitMm = modelUnit(attrs.unit ?? 'millimeter');
        break;
      }
      case 'model/resources/object': {
        if (!attrs.id || result.objects.has(attrs.id))
          invalid('An object ID is missing or duplicated.');
        current = { vertices: [], indices: [], components: [] };
        result.objects.set(attrs.id, current);
        break;
      }
      case 'model/resources/object/mesh/vertices/vertex':
        if (current) current.vertices.push(number(attrs.x), number(attrs.y), number(attrs.z));
        break;
      case 'model/resources/object/mesh/triangles/triangle':
        if (current) {
          if (current.indices.length / 3 >= maxTriangles)
            throw new RangeError('The 3MF exceeds the triangle limit.');
          current.indices.push(
            triangleIndex(attrs.v1),
            triangleIndex(attrs.v2),
            triangleIndex(attrs.v3),
          );
        }
        break;
      case 'model/resources/object/components/component':
        if (current) current.components.push(reference(attrs));
        break;
      case 'model/build/item':
        result.items.push(reference(attrs));
        break;
    }
  });
  if (!modelSeen) invalid('The model part has no model root.');
  for (const object of result.objects.values()) {
    if (object.components.length && object.indices.length)
      invalid('An object cannot contain both a mesh and components.');
    if (object.indices.some((index) => index * 3 >= object.vertices.length))
      invalid('A triangle references a missing vertex.');
  }
  return result;
}

function partPath(base: string, target: string): string {
  const decoded = decodeURIComponent(target);
  if (/[?#\\]/.test(decoded) || /^[a-z]+:/i.test(decoded)) invalid('A model part path is invalid.');
  const segments = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      if (!segments.pop()) invalid('A model part path leaves the archive root.');
    } else if (segment && segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}

async function readText(
  parts: Map<string, ZipPart>,
  path: string,
): Promise<string | ModelParseError> {
  const part = parts.get(path);
  if (!part)
    return {
      kind: 'no-model-part',
      byteOffset: 0,
      part: path,
      message: 'The referenced 3MF part is missing.',
    };
  const data = await inflateZipPart(part);
  if ('kind' in data) return data;
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function transformVertices(instance: Instance): Float32Array | ModelParseError {
  const { object, transforms, unitMm } = instance;
  const vertices = new Float32Array(object.vertices.length);
  for (let offset = 0; offset < object.vertices.length; offset += 3) {
    let x = object.vertices[offset] ?? NaN;
    let y = object.vertices[offset + 1] ?? NaN;
    let z = object.vertices[offset + 2] ?? NaN;
    for (const matrix of transforms) {
      const [
        a = 0,
        b = 0,
        c = 0,
        d = 0,
        e = 0,
        f = 0,
        g = 0,
        h = 0,
        i = 0,
        tx = 0,
        ty = 0,
        tz = 0,
      ] = matrix;
      [x, y, z] = [
        x * a + y * d + z * g + tx,
        x * b + y * e + z * h + ty,
        x * c + y * f + z * i + tz,
      ];
    }
    vertices.set([x * unitMm, y * unitMm, z * unitMm], offset);
  }
  return vertices.some((value) => !Number.isFinite(value))
    ? {
        kind: 'non-finite',
        byteOffset: 0,
        message: 'A transformed 3MF vertex exceeds the finite float32 range.',
      }
    : vertices;
}

function flatten(instances: Instance[], triangleCount: number): Mesh | ModelParseError {
  const positions = new Float32Array(triangleCount * 9);
  let offset = 0;
  for (const instance of instances) {
    const vertices = transformVertices(instance);
    if ('kind' in vertices) return vertices;
    for (const index of instance.object.indices) {
      positions.set(vertices.subarray(index * 3, index * 3 + 3), offset);
      offset += 3;
    }
  }
  return { positions, triangleCount };
}

/** Merge all build items and component instances into millimeter triangle positions. */
export async function parseThreeMf(
  bytes: ArrayBuffer,
  maxTriangles = 2_000_000,
): Promise<{ mesh: Mesh; unitMm: number; itemCount: number } | ModelParseError> {
  const parts = readZip(bytes);
  if ('kind' in parts) return parts;
  const directory = parts;
  let activePart = '_rels/.rels';
  try {
    let rootPath = '3D/3dmodel.model';
    if (parts.has(activePart)) {
      const rels = await readText(parts, activePart);
      if (typeof rels !== 'string') return rels;
      scanXml(rels, (path, attrs) => {
        if (
          path === 'Relationships/Relationship' &&
          /(?:\/3dmodel|\/StartPart|^StartPart)$/.test(attrs.Type ?? '')
        ) {
          if (attrs.TargetMode === 'External' || !attrs.Target)
            invalid('The start model must be an archive part.');
          rootPath = partPath('', attrs.Target);
        }
      });
    }
    const cache = new Map<string, ModelPart>();
    async function load(path: string): Promise<ModelPart | ModelParseError> {
      activePart = path;
      const cached = cache.get(path);
      if (cached) return cached;
      const text = await readText(directory, path);
      if (typeof text !== 'string') return text;
      const model = parsePart(text, maxTriangles);
      cache.set(path, model);
      return model;
    }
    const root = await load(rootPath);
    if ('kind' in root) return root;
    const unitMm = root.unitMm;
    const instances: Instance[] = [];
    let triangleCount = 0;
    async function expand(
      ref: Reference,
      path: string,
      transforms: number[][],
      ancestors: Set<string>,
    ): Promise<ModelParseError | null> {
      const target = ref.path ? partPath(path, ref.path) : path;
      const key = `${target}#${ref.id}`;
      if (ancestors.has(key) || ancestors.size >= 128)
        invalid('The component hierarchy is cyclic or too deep.');
      const model = await load(target);
      if ('kind' in model) return model;
      if (model.unitMm !== unitMm) invalid('All 3MF model parts must use the same unit.');
      const object = model.objects.get(ref.id);
      if (!object) invalid('A build item or component references a missing object.');
      // Component transforms act before their enclosing item transforms (row-vector convention).
      const chain = [ref.transform, ...transforms];
      ancestors.add(key);
      for (const child of object.components) {
        const error = await expand(child, target, chain, ancestors);
        if (error) return error;
      }
      ancestors.delete(key);
      triangleCount += object.indices.length / 3;
      if (triangleCount > maxTriangles) throw new RangeError('The 3MF exceeds the triangle limit.');
      instances.push({ object, transforms: chain, unitMm });
      return null;
    }
    for (const item of root.items) {
      const error = await expand(item, rootPath, [], new Set());
      if (error) return error;
    }
    if (triangleCount === 0)
      return {
        kind: 'empty',
        byteOffset: 0,
        part: rootPath,
        message: 'The 3MF build contains no triangles.',
      };
    const mesh = flatten(instances, triangleCount);
    return 'kind' in mesh ? mesh : { mesh, unitMm, itemCount: root.items.length };
  } catch (error) {
    return {
      kind: error instanceof RangeError ? 'too-many-triangles' : 'bad-xml',
      byteOffset: 0,
      part: activePart,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
