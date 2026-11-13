import type { ModelParseError } from './model';

export type ZipPart = {
  name: string;
  method: number;
  size: number;
  crc: number;
  byteOffset: number;
  compressed: Uint8Array<ArrayBuffer>;
};

const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 65_535;
// Keep archive expansion bounded before allocating XML or mesh storage.
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

function failure(
  kind: ModelParseError['kind'],
  byteOffset: number,
  message: string,
): ModelParseError {
  return { kind, byteOffset, message };
}

/** ZIP's IEEE CRC-32, used to reject corrupt stored and raw-deflate members. */
export function crc32(bytes: Uint8Array): number {
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (table[(crc ^ byte) & 255] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip64Extra(view: DataView, start: number, end: number): boolean {
  for (let offset = start; offset < end; ) {
    if (offset + 4 > end) return true;
    const length = view.getUint16(offset + 2, true);
    if (view.getUint16(offset, true) === 1 || offset + 4 + length > end) return true;
    offset += 4 + length;
  }
  return false;
}

/** Index ordinary single-disk ZIP members without expanding unused slicer metadata. */
export function readZip(bytes: ArrayBuffer): Map<string, ZipPart> | ModelParseError {
  const view = new DataView(bytes);
  let end = bytes.byteLength - EOCD_BYTES;
  const minimum = Math.max(0, end - MAX_COMMENT_BYTES);
  while (end >= minimum) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + EOCD_BYTES + view.getUint16(end + 20, true) === bytes.byteLength
    )
      break;
    end -= 1;
  }
  if (end < minimum) return failure('truncated', bytes.byteLength, 'The ZIP directory is missing.');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    offset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  )
    return failure('zip-unsupported', end, 'ZIP64 and multi-disk archives are unsupported.');
  if (offset + directorySize !== end) {
    return failure('truncated', offset, 'The ZIP directory has an invalid size or offset.');
  }
  const parts = new Map<string, ZipPart>();
  let expandedBytes = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      return failure('truncated', offset, 'A ZIP directory entry is incomplete.');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const next = offset + 46 + nameLength + extraLength + view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (next > end)
      return failure('truncated', offset, 'A ZIP entry extends beyond its directory.');
    if (
      (flags & 0x41) !== 0 ||
      (method !== 0 && method !== 8) ||
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      local === 0xffffffff ||
      view.getUint16(offset + 34, true) !== 0 ||
      zip64Extra(view, offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
    )
      return failure(
        'zip-unsupported',
        offset,
        'Use a ZIP without encryption or ZIP64, stored or deflated.',
      );
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) {
      return failure('truncated', local, 'A ZIP local header is missing.');
    }
    const localFlags = view.getUint16(local + 6, true);
    if ((localFlags & 0x41) !== 0 || view.getUint16(local + 8, true) !== method) {
      return failure(
        'zip-unsupported',
        local,
        'ZIP local compression flags disagree with the directory.',
      );
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const data = local + 30 + localNameLength + localExtraLength;
    if (data + compressedSize > offset)
      return failure('truncated', data, 'A ZIP member is incomplete.');
    if (zip64Extra(view, data - localExtraLength, data)) {
      return failure('zip-unsupported', local, 'ZIP64 members are unsupported.');
    }
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localName = new TextDecoder().decode(
      bytes.slice(local + 30, local + 30 + localNameLength),
    );
    if (name !== localName || parts.has(name)) {
      return failure('zip-unsupported', local, 'ZIP member names disagree or are duplicated.');
    }
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      return failure('zip-unsupported', offset, 'The expanded ZIP exceeds 512 MiB.');
    }
    parts.set(name, {
      name,
      method,
      size,
      crc: view.getUint32(offset + 16, true),
      byteOffset: data,
      compressed: new Uint8Array(bytes, data, compressedSize),
    });
    offset = next;
  }
  return offset === end
    ? parts
    : failure('truncated', offset, 'The ZIP directory count is incorrect.');
}

/** Expand one member and validate its declared size and checksum. */
export async function inflateZipPart(
  part: ZipPart,
): Promise<Uint8Array<ArrayBuffer> | ModelParseError> {
  const fail = (message: string): ModelParseError => ({
    kind: 'truncated',
    byteOffset: part.byteOffset,
    part: part.name,
    message,
  });
  let bytes = part.compressed;
  if (part.method === 8) {
    try {
      const reader = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
      bytes = new Uint8Array(part.size);
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > part.size) {
          await reader.cancel();
          return fail('The ZIP member expands beyond its declared size.');
        }
        bytes.set(value, offset);
        offset += value.length;
      }
      if (offset !== part.size) return fail('The ZIP member expands to an incorrect size.');
    } catch {
      return fail('The ZIP member contains invalid raw-deflate data.');
    }
  }
  return bytes.length === part.size && crc32(bytes) === part.crc
    ? bytes
    : fail('The ZIP member size or checksum is incorrect.');
}
