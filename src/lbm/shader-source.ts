import type { Operator } from '../app/settings';
import type { Precision } from './layout';

const COLLISION_FILES = {
  trt: 'collide-trt.wgsl',
  reg: 'collide-reg.wgsl',
} as const satisfies Record<Operator, string>;

export const SHADER_FILES = {
  prelude: 'prelude-f32.wgsl',
  preludeF16: 'prelude-f16.wgsl',
  common: 'common.wgsl',
  walls: 'walls.wgsl',
  collisionTrt: COLLISION_FILES.trt,
  collisionReg: COLLISION_FILES.reg,
  init: 'init.wgsl',
  streamCollide: 'stream_collide.wgsl',
  force: 'force.wgsl',
} as const;

export type ShaderSources = { readonly [Part in keyof typeof SHADER_FILES]: string };
export type SolverKernel = 'init' | 'streamCollide' | 'force';

export const SOLVER_KERNELS = ['init', 'streamCollide', 'force'] as const;
export const STANDALONE_SHADERS = ['copy_bandwidth.wgsl', 'nan_guard.wgsl', 'reduce.wgsl'] as const;

/** Assemble the requested kernels; streaming and the force share one wall reconstruction. */
export function assembleShader(
  kernel: SolverKernel,
  sources: ShaderSources,
  operator: Operator = 'trt',
  precision: Precision = 'f32',
): string {
  const prelude = precision === 'f16' ? sources.preludeF16 : sources.prelude;
  const parts = [prelude, sources.common];
  if (kernel === 'streamCollide') {
    parts.push(sources.walls, operator === 'reg' ? sources.collisionReg : sources.collisionTrt);
  } else if (kernel === 'force') {
    parts.push(sources.walls);
  }
  parts.push(sources[kernel]);
  return `${parts.join('\n\n')}\n`;
}
