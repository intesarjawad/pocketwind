import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Mesh, parseStl } from '../../../src/geometry/stl';
import { defaultLengthCells, placeMesh } from '../../../src/geometry/transform';
import { voxelize } from '../../../src/geometry/voxelize';
import { TIERS } from '../../../src/lbm/layout';
import { PRESET_REGISTRY, registryPresetById } from '../../../src/presets/registry';

const SCAD_DIR = new URL('../../../assets/scad/', import.meta.url);
const GEOMETRY_DIR = new URL('../../../assets/geometry/', import.meta.url);
const MAX_STL_BYTES = 300_000;

function area(id: string): number {
  const preset = registryPresetById(id);
  if (preset === undefined) throw new Error(`Missing preset ${id}.`);
  return preset.refAreaMm2;
}

function readMesh(names: readonly string[]): Mesh {
  const meshes = names.map((name) => {
    const bytes = readFileSync(new URL(name, GEOMETRY_DIR));
    const mesh = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    if ('kind' in mesh) throw new Error(`${name}: ${mesh.message}`);
    return mesh;
  });
  const positions = new Float32Array(meshes.reduce((sum, mesh) => sum + mesh.positions.length, 0));
  let offset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, offset);
    offset += mesh.positions.length;
  }
  return { positions, triangleCount: positions.length / 9 };
}

describe('preset registry', () => {
  it('lists each preset once', () => {
    const ids = PRESET_REGISTRY.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['ahmed-25', 'ahmed-35', 'ahmed-25-roof-box', 'sphere', 'cube']);
  });

  it('names only meshes that an OpenSCAD source produces', () => {
    for (const preset of PRESET_REGISTRY) {
      for (const file of [
        ...preset.files,
        ...(preset.supports === undefined ? [] : [preset.supports]),
      ]) {
        expect(file).toMatch(/\.stl$/);
        expect(existsSync(new URL(file.replace(/\.stl$/, '.scad'), SCAD_DIR)), file).toBe(true);
      }
    }
  });

  it('keeps the stilts out of the body files', () => {
    for (const preset of PRESET_REGISTRY) {
      expect(preset.files).not.toContain('stilts.stl');
    }
    expect(registryPresetById('ahmed-35')?.supports).toBe('stilts.stl');
    expect(registryPresetById('sphere')?.supports).toBeUndefined();
  });

  it('lifts the Ahmed bodies by the stilt length', () => {
    const source = readFileSync(new URL('stilts.scad', SCAD_DIR), 'utf8');
    const length = Number(/length = (\d+);/.exec(source)?.[1]);
    expect(length).toBe(50);
    for (const id of ['ahmed-25', 'ahmed-35', 'ahmed-25-roof-box']) {
      expect(registryPresetById(id)?.floorGapMm).toBe(length);
    }
    expect(registryPresetById('sphere')?.floorGapMm).toBe(0);
    expect(registryPresetById('cube')?.floorGapMm).toBe(0);
  });

  it('carries the reference lengths and frontal areas', () => {
    expect(registryPresetById('ahmed-25')?.refLengthMm).toBe(1044);
    expect(registryPresetById('sphere')?.refLengthMm).toBe(300);
    expect(area('ahmed-25')).toBe(112_000);
    expect(area('ahmed-35')).toBe(112_000);
    expect(area('ahmed-25-roof-box')).toBe(157_000);
    expect(area('cube')).toBe(90_000);
    expect(area('sphere')).toBeCloseTo(70_685.83, 2);
  });

  it('cites a source for every literature body', () => {
    for (const id of ['ahmed-25', 'ahmed-35', 'sphere', 'cube']) {
      expect(registryPresetById(id)?.references.length).toBeGreaterThan(0);
    }
  });

  describe('generated meshes', () => {
    for (const preset of PRESET_REGISTRY) {
      const names = [...preset.files, ...(preset.supports === undefined ? [] : [preset.supports])];
      const generated = names.every((name) => existsSync(new URL(name, GEOMETRY_DIR)));

      it.skipIf(!generated)(
        `${preset.id} is small, parses and voxelizes watertight at tier M`,
        () => {
          for (const name of names) {
            expect(statSync(new URL(name, GEOMETRY_DIR)).size, name).toBeLessThan(MAX_STL_BYTES);
          }
          const body = readMesh(preset.files);
          const supports = preset.supports === undefined ? undefined : readMesh([preset.supports]);
          const layout = { nx: TIERS.M.nx, ny: TIERS.M.ny, nz: TIERS.M.nz };
          const placed = placeMesh(body, {
            layout,
            lengthCells: defaultLengthCells(body, layout, true),
            flowAxis: 'x',
            flowSign: 1,
            upAxis: 'z',
            floor: true,
            ...(supports === undefined ? {} : { supports }),
          });
          const grid = voxelize(placed.body, placed.supports, layout, { floor: true });
          expect(grid.watertight).toBe(true);
          expect(grid.solidCells).toBeGreaterThan(0);
        },
      );
    }
  });
});
