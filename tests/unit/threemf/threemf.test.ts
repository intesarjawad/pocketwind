import { describe, expect, it } from 'vitest';
import {
  CUBE_OBJECT,
  MODEL_PATH,
  makeArchive,
  modelArchive,
  modelXml,
} from '../../../scripts/make-3mf-fixtures';
import { parseThreeMf } from '../../../src/geometry/threemf';
import { voxelize } from '../../../src/geometry/voxelize';
import { bounds, fixture } from '../model/fixtures';

describe('3MF build import', () => {
  for (const [name, count, min, max, items, unit] of [
    ['single-object', 12, [0, 0, 0], [300, 300, 300], 1, 1],
    ['stored', 12, [0, 0, 0], [300, 300, 300], 1, 1],
    ['inch', 12, [0, 0, 0], [7620, 7620, 7620], 1, 25.4],
    ['components', 24, [-300, 0, 0], [980, 310, 330], 2, 1],
    ['external-part', 12, [10, 20, 30], [310, 320, 330], 1, 1],
  ] as const) {
    it(`reads ${name} with the expected merged bounds`, async () => {
      const result = await parseThreeMf(fixture(`3mf/${name}.3mf`));
      if ('kind' in result) throw new Error(result.message);
      expect(result.mesh.triangleCount).toBe(count);
      expect(result.unitMm).toBe(unit);
      expect(result.itemCount).toBe(items);
      bounds(result.mesh, [...min], [...max]);
    });
  }
  for (const [unit, mm] of Object.entries({
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    inch: 25.4,
    foot: 304.8,
    meter: 1000,
  })) {
    it(`converts ${unit} to millimeters`, async () => {
      const result = await parseThreeMf(
        modelArchive(modelXml(CUBE_OBJECT, '<item objectid="1"/>', unit)),
      );
      if ('kind' in result) throw new Error(result.message);
      expect(result.unitMm).toBe(mm);
      bounds(result.mesh, [0, 0, 0], [300 * mm, 300 * mm, 300 * mm]);
    });
  }
  for (const [name, kind] of [
    ['zip64', 'zip-unsupported'],
    ['encrypted', 'zip-unsupported'],
    ['unsupported-method', 'zip-unsupported'],
    ['missing-model', 'no-model-part'],
  ]) {
    it(`reports ${name}`, async () =>
      expect(await parseThreeMf(fixture(`3mf/${name}.3mf`))).toHaveProperty('kind', kind));
  }
  it('follows the start relationship, namespace prefixes, single quotes and escaped paths', async () => {
    const text = modelXml()
      .replaceAll('"', "'")
      .replaceAll('<model', '<c:model')
      .replaceAll('</model>', '</c:model>')
      .replace('xmlns=', 'xmlns:c=');
    const bytes = makeArchive([
      {
        name: '_rels/.rels',
        text: '<r:Relationships xmlns:r="urn:rels"><r:Relationship Type="StartPart" Target="/3D/a&amp;b.model"/></r:Relationships>',
      },
      { name: '3D/a&b.model', text },
    ]);
    expect(await parseThreeMf(bytes)).toHaveProperty('mesh.triangleCount', 12);
  });
  it('uses the default model path without relationships and defaults to millimeters', async () => {
    const bytes = makeArchive([
      { name: MODEL_PATH, text: modelXml().replace(' unit="millimeter"', '') },
    ]);
    expect(await parseThreeMf(bytes)).toMatchObject({ unitMm: 1, mesh: { triangleCount: 12 } });
  });
  it('ignores metadata, comments, colours and unused resources', async () => {
    const text = modelXml(`${CUBE_OBJECT}<object id="2"/>`).replace(
      '<resources>',
      '<!-- <bad> --><metadata name="x"><![CDATA[a < b]]></metadata><resources><colorgroup id="3"/>',
    );
    expect(await parseThreeMf(modelArchive(text))).toHaveProperty('mesh.triangleCount', 12);
  });
  for (const text of [
    '<model><resources></model>',
    '<!DOCTYPE model><model/>',
    '<model unit=millimeter/>',
    modelXml().replace('v1="0"', 'v1="900"'),
    modelXml().replace('x="0"', 'x="no"'),
    modelXml().replace('id="1"', 'id="1" id="2"'),
    modelXml(CUBE_OBJECT, '<item objectid="9"/>'),
    modelXml(CUBE_OBJECT, '<item objectid="1" transform="1 2"/>'),
    modelXml(CUBE_OBJECT, '<item objectid="1"/>', 'yard'),
    modelXml('<object id="1"><components><component objectid="1"/></components></object>'),
  ]) {
    it(`rejects invalid model ${text.slice(0, 45)}`, async () =>
      expect(await parseThreeMf(modelArchive(text))).toMatchObject({
        kind: 'bad-xml',
        part: MODEL_PATH,
      }));
  }
  it('reports the missing external part', async () => {
    const text = modelXml(
      '<object id="1"><components><component objectid="2" p:path="Objects/missing.model"/></components></object>',
    );
    expect(await parseThreeMf(modelArchive(text))).toMatchObject({
      kind: 'no-model-part',
      part: '3D/Objects/missing.model',
    });
  });
  it('limits the merged instance count as well as individual mesh size', async () => {
    expect(await parseThreeMf(fixture('3mf/single-object.3mf'), 11)).toHaveProperty(
      'kind',
      'too-many-triangles',
    );
    expect(
      await parseThreeMf(
        modelArchive(modelXml(CUBE_OBJECT, '<item objectid="1"/><item objectid="1"/>')),
        12,
      ),
    ).toHaveProperty('kind', 'too-many-triangles');
  });
  it('rejects overflow after transforms and unit conversion', async () => {
    const text = modelXml(
      CUBE_OBJECT,
      '<item objectid="1" transform="1e40 0 0 0 1 0 0 0 1 0 0 0"/>',
    );
    expect(await parseThreeMf(modelArchive(text))).toHaveProperty('kind', 'non-finite');
  });
  it('imports the closed 327680-triangle ellipsoid and voxelizes it watertight', async () => {
    const result = await parseThreeMf(fixture('cold-start/ellipsoid.3mf'));
    if ('kind' in result) throw new Error(result.message);
    expect(result.mesh.triangleCount).toBe(327680);
    bounds(result.mesh, [-450, -150, -150], [450, 150, 150]);
    const positions = Float32Array.from(
      result.mesh.positions,
      (value, index) => value / 40 + (index % 3 === 0 ? 16 : 8),
    );
    const grid = voxelize(
      { positions, triangleCount: result.mesh.triangleCount },
      null,
      { nx: 32, ny: 16, nz: 16 },
      { floor: false },
    );
    expect(grid.solidCells).toBeGreaterThan(0);
    expect(grid.watertight).toBe(true);
    // Parsing and voxelizing 327,680 triangles takes about 4 s alone, more on a loaded machine.
  }, 30_000);
});
