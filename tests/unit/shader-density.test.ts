import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WEIGHTS } from '../../src/lbm/lattice';

const kernel = readFileSync(
  new URL('../../src/lbm/shaders/stream_collide.wgsl', import.meta.url),
  'utf8',
);
const f32 = Math.fround;

/** Execute the kernel's scalar density statements with f32 arithmetic, including assignments. */
function densityPath(code: string, g: Float32Array): { rho: number; equilibriumDelta: number } {
  const path = code.match(/var rho_delta[\s\S]*?(?=let velocity)/)?.[0];
  const loop = path?.match(/for\s*\(var i = 0u; i < (\d+)u; i\+\+\)\s*\{([^}]+)\}/);
  const argument = code.match(/equilibrium\[i\] = geq\(i, ([^,]+), velocity\)/)?.[1];
  if (!path || !loop || loop.index === undefined || !argument)
    throw new Error('Unsupported density path.');
  const values = new Map<string, number>();
  function expression(source: string, i: number): number {
    const terms = source.trim().split(/\s*([+-])\s*/);
    function value(term: string): number {
      if (term === 'g[i]') return g[i] ?? NaN;
      const known = values.get(term);
      if (known !== undefined) return known;
      if (/^\d+(?:\.\d+)?$/.test(term)) return f32(Number(term));
      throw new Error(`Unsupported density expression: ${source}`);
    }
    let result = value(terms[0] ?? '');
    for (let j = 1; j < terms.length; j += 2) {
      const operand = value(terms[j + 1] ?? '');
      result = f32(terms[j] === '+' ? result + operand : result - operand);
    }
    return result;
  }
  function statements(source: string, i = 0): void {
    for (const match of source.matchAll(/(?:var |let )?(rho_delta|rho)\s*(\+=|=)\s*([^;]+);/g)) {
      const [, name = '', operator, rhs = ''] = match;
      const value = expression(rhs, i);
      values.set(name, operator === '+=' ? f32((values.get(name) ?? NaN) + value) : value);
    }
  }
  statements(path.slice(0, loop.index));
  for (let i = 0; i < Number(loop[1]); i += 1) statements(loop[2] ?? '', i);
  statements(path.slice(loop.index + loop[0].length));
  return { rho: values.get('rho') ?? NaN, equilibriumDelta: expression(argument, 0) };
}

it.each([2 ** -28, -(2 ** -28), 2 ** -20])(
  'retains density deviation %s through the f32 equilibrium path',
  (delta) => {
    const incoming = Float32Array.from(WEIGHTS, (weight) => f32(f32(weight) * delta));
    const state = densityPath(kernel, incoming);
    const equilibrium = Float32Array.from(WEIGHTS, (weight) =>
      f32(f32(weight) * state.equilibriumDelta),
    );
    const recoveredDelta = equilibrium.reduce((sum, value) => f32(sum + value), 0);
    expect(state.rho).toBe(f32(1 + delta));
    expect(Math.abs(recoveredDelta / delta - 1)).toBeLessThan(2e-6);
  },
);

it('detects a density reset inserted before physical density reconstruction', () => {
  const incoming = Float32Array.from(WEIGHTS, (weight) => f32(weight * 2 ** -28));
  const reset = kernel.replace('let rho =', 'rho_delta = 0.0;\n  let rho =');
  expect(densityPath(kernel, incoming).equilibriumDelta).not.toBe(0);
  expect(densityPath(reset, incoming).equilibriumDelta).toBe(0);
});
