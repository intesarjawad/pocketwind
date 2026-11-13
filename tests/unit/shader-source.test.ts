import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CELL_TYPE_MASK, CellType } from '../../src/geometry/voxel-grid';
import { DIRECTIONS, WEIGHTS } from '../../src/lbm/lattice';
import {
  assembleShader,
  SHADER_FILES,
  type ShaderSources,
  SOLVER_KERNELS,
  STANDALONE_SHADERS,
} from '../../src/lbm/shader-source';

function readPart(part: keyof ShaderSources): string {
  return readFileSync(
    new URL(`../../src/lbm/shaders/${SHADER_FILES[part]}`, import.meta.url),
    'utf8',
  );
}

const sources: ShaderSources = {
  prelude: readPart('prelude'),
  preludeF16: readPart('preludeF16'),
  common: readPart('common'),
  walls: readPart('walls'),
  collisionTrt: readPart('collisionTrt'),
  collisionReg: readPart('collisionReg'),
  init: readPart('init'),
  streamCollide: readPart('streamCollide'),
  force: readPart('force'),
};

describe('shader assembly', () => {
  it('includes every WGSL file in the compilation gate', () => {
    const files = readdirSync(new URL('../../src/lbm/shaders/', import.meta.url)).filter((file) =>
      file.endsWith('.wgsl'),
    );
    expect([...Object.values(SHADER_FILES), ...STANDALONE_SHADERS].sort()).toEqual(files.sort());
  });
  it('assembles initialization without streaming or collision', () => {
    expect(assembleShader('init', sources)).toBe(
      `${[sources.prelude, sources.common, sources.init].join('\n\n')}\n`,
    );
  });

  it('assembles streaming with the wall and collision definitions before its entry point', () => {
    expect(assembleShader('streamCollide', sources, 'trt')).toBe(
      `${[
        sources.prelude,
        sources.common,
        sources.walls,
        sources.collisionTrt,
        sources.streamCollide,
      ].join('\n\n')}\n`,
    );
  });

  it('assembles the force with the same wall reconstruction as streaming', () => {
    expect(assembleShader('force', sources)).toBe(
      `${[sources.prelude, sources.common, sources.walls, sources.force].join('\n\n')}\n`,
    );
  });

  it.each([
    ['trt', 'collisionTrt', 'collisionReg'],
    ['reg', 'collisionReg', 'collisionTrt'],
  ] as const)('selects the %s collision part', (operator, selected, other) => {
    const code = assembleShader('streamCollide', sources, operator);
    expect(code).toContain(sources[selected]);
    expect(code).not.toContain(sources[other]);
  });

  it.each(SOLVER_KERNELS)('%s has one f32 prelude and one compute entry point', (kernel) => {
    const code = assembleShader(kernel, sources);
    expect(code.match(/alias pop = f32;/g)).toHaveLength(1);
    expect(code.match(/@compute\s+@workgroup_size\(64\)/g)).toHaveLength(1);
    expect(code.match(/fn main\(/g)).toHaveLength(1);
  });

  it.each(SOLVER_KERNELS)('%s swaps in the f16 prelude without another entry point', (kernel) => {
    const code = assembleShader(kernel, sources, 'trt', 'f16');
    expect(code.match(/enable f16;/g)).toHaveLength(1);
    expect(code.match(/alias pop = f16;/g)).toHaveLength(1);
    expect(code).not.toContain('alias pop = f32;');
    expect(code.match(/fn main\(/g)).toHaveLength(1);
  });
});

describe('shader host and numerical contracts', () => {
  it('uses the CPU direction order and weights', () => {
    const directions = Array.from(
      sources.common.matchAll(/vec3i\((-?\d+), (-?\d+), (-?\d+)\)/g),
      (match) => match.slice(1).map(Number),
    );
    const weights = Array.from(
      sources.common.matchAll(/1\.0 \/ (3|18|36)\.0/g),
      (match) => 1 / Number(match[1]),
    );
    expect(directions).toEqual(DIRECTIONS);
    expect(weights).toEqual(WEIGHTS);
  });

  it('uses the geometry cell kinds and low-bit mask', () => {
    for (const [name, value] of Object.entries({ ...CellType, CELL_TYPE_MASK })) {
      expect(sources.common).toContain(`const ${name}: u32 = ${value}u;`);
    }
  });

  it('keeps the uniform at twelve scalar fields in upload order', () => {
    const params = sources.common.match(/struct Params \{([^}]+)\}/)?.[1];
    expect(params?.match(/\w+: (?:u32|f32)/g)).toEqual([
      'nx: u32',
      'ny: u32',
      'nz: u32',
      'cells: u32',
      'u_in: f32',
      'nu: f32',
      'cs_term: f32',
      'lambda: f32',
      'les: u32',
      'walls: u32',
      'write_macro: u32',
      'step: u32',
    ]);
  });

  it('fits the eight-storage-buffer limit with separate direction groups', () => {
    const bindings = Array.from(
      sources.common.matchAll(/@group\(0\) @binding\((\d+)\) var<([^>]+)> (\w+): ([^;]+);/g),
      (match) => match.slice(1),
    );
    expect(bindings).toEqual([
      ['0', 'uniform', 'p', 'Params'],
      ['1', 'storage, read', 'in_a', 'array<pop>'],
      ['2', 'storage, read', 'in_b', 'array<pop>'],
      ['3', 'storage, read', 'in_c', 'array<pop>'],
      ['4', 'storage, read_write', 'out_a', 'array<pop>'],
      ['5', 'storage, read_write', 'out_b', 'array<pop>'],
      ['6', 'storage, read_write', 'out_c', 'array<pop>'],
      ['7', 'storage, read', 'geometry', 'array<u32>'],
      ['8', 'storage, read_write', 'macros', 'array<vec4f>'],
    ]);
  });
});
