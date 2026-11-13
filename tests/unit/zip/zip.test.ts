import { describe, expect, it } from 'vitest';
import { makeArchive } from '../../../scripts/make-3mf-fixtures';
import { crc32, inflateZipPart, readZip } from '../../../src/geometry/zip';
import { fixture } from '../model/fixtures';

describe('ZIP directory and inflation', () => {
  for (const method of [0, 8]) {
    it(`reads method ${method}, including UTF-8 and empty members`, async () => {
      const parts = readZip(
        makeArchive([
          { name: 'part.xml', text: 'mesh & café', method },
          { name: 'empty', text: '', method },
        ]),
      );
      if ('kind' in parts) throw new Error(parts.message);
      for (const [name, expected] of [
        ['part.xml', 'mesh & café'],
        ['empty', ''],
      ]) {
        const part = parts.get(name ?? '');
        if (!part) throw new Error('Missing test member');
        expect(await inflateZipPart(part)).toEqual(new TextEncoder().encode(expected));
      }
    });
  }
  it('checks IEEE CRC-32 against the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  for (const name of ['zip64', 'encrypted', 'unsupported-method']) {
    it(`rejects ${name}`, () => {
      expect(readZip(fixture(`3mf/${name}.3mf`))).toHaveProperty('kind', 'zip-unsupported');
    });
  }
  it('rejects every truncated prefix without throwing', () => {
    const bytes = makeArchive([{ name: 'a', text: 'abc' }]);
    for (let length = 0; length < bytes.byteLength; length += 1) {
      expect(readZip(bytes.slice(0, length))).toHaveProperty('kind', 'truncated');
    }
  });
  it('honors an EOCD comment rather than a signature inside that comment', () => {
    const archive = makeArchive([{ name: 'a', text: 'abc' }]);
    const bytes = new Uint8Array(archive.byteLength + 30);
    bytes.set(new Uint8Array(archive));
    const view = new DataView(bytes.buffer);
    view.setUint16(archive.byteLength - 2, 30, true);
    view.setUint32(archive.byteLength + 3, 0x06054b50, true);
    expect(readZip(bytes.buffer)).toBeInstanceOf(Map);
  });
  it('rejects a corrupt stored member and a truncated deflate stream', async () => {
    for (const method of [0, 8]) {
      const parts = readZip(makeArchive([{ name: 'a', text: 'abc', method }]));
      if ('kind' in parts) throw new Error(parts.message);
      const part = parts.get('a');
      if (!part) throw new Error('Missing test member');
      part.compressed.fill(255);
      expect(await inflateZipPart(part)).toMatchObject({ kind: 'truncated', part: 'a' });
    }
  });
  it('rejects inflated sizes that disagree in either direction', async () => {
    const parts = readZip(makeArchive([{ name: 'a', text: 'abc' }]));
    if ('kind' in parts) throw new Error(parts.message);
    const part = parts.get('a');
    if (!part) throw new Error('Missing test member');
    for (const size of [1, 10])
      expect(await inflateZipPart({ ...part, size })).toHaveProperty('kind', 'truncated');
  });
  it('supports data descriptors through central-directory sizes', async () => {
    const bytes = makeArchive([{ name: 'a', text: 'abc', flags: 8 }]);
    const view = new DataView(bytes);
    view.setUint32(14, 0, true);
    view.setUint32(18, 0, true);
    view.setUint32(22, 0, true);
    const parts = readZip(bytes);
    if ('kind' in parts) throw new Error(parts.message);
    const part = parts.get('a');
    if (!part) throw new Error('Missing test member');
    expect(await inflateZipPart(part)).toEqual(new TextEncoder().encode('abc'));
  });
  it('rejects a forged oversized archive before expansion', () => {
    const bytes = makeArchive([{ name: 'a', text: 'abc' }]);
    const view = new DataView(bytes);
    const central = view.getUint32(bytes.byteLength - 6, true);
    view.setUint32(central + 24, 513 * 1024 * 1024, true);
    expect(readZip(bytes)).toHaveProperty('kind', 'zip-unsupported');
  });
});
