import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
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

const shaders = [
  ...SOLVER_KERNELS.map((kernel) => ({ name: kernel, code: assembleShader(kernel, sources) })),
  { name: 'streamCollide-reg', code: assembleShader('streamCollide', sources, 'reg') },
  ...STANDALONE_SHADERS.map((file) => ({
    name: file,
    code: readFileSync(new URL(`../../src/lbm/shaders/${file}`, import.meta.url), 'utf8'),
  })),
];

// The f16 prelude needs the optional shader feature, so these compile separately.
const f16Shaders = [
  ...SOLVER_KERNELS.map((kernel) => ({
    name: kernel,
    code: assembleShader(kernel, sources, 'trt', 'f16'),
  })),
  { name: 'streamCollide-reg', code: assembleShader('streamCollide', sources, 'reg', 'f16') },
];

test('f16 kernels compile when the adapter advertises shader-f16', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async (shaders) => {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has('shader-f16')) return null;
    const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    const uncapturedErrors: string[] = [];
    device.addEventListener('uncapturederror', (event) => {
      uncapturedErrors.push(event.error.message);
    });
    device.pushErrorScope('validation');
    try {
      const compiled: { name: string; compilationErrors: string[] }[] = [];
      for (const { name, code } of shaders) {
        const module = device.createShaderModule({ code });
        const info = await module.getCompilationInfo();
        await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        });
        compiled.push({
          name,
          compilationErrors: info.messages
            .filter((message) => message.type === 'error')
            .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`),
        });
      }
      const error = await device.popErrorScope();
      return { compiled, validationError: error?.message ?? null, uncapturedErrors };
    } finally {
      device.destroy();
    }
  }, f16Shaders);
  test.skip(result === null, 'shader-f16 is unavailable.');
  if (result === null) return;
  for (const shader of result.compiled) {
    expect(shader.compilationErrors, shader.name).toEqual([]);
  }
  expect(result.validationError).toBeNull();
  expect(result.uncapturedErrors).toEqual([]);
});

for (const { name, code } of shaders) {
  test(`${name}: f32 compiles`, async ({ page }) => {
    await page.goto('./');
    const diagnostics = await page.evaluate(async (code) => {
      if (!navigator.gpu) throw new Error('WebGPU is unavailable. Run a GPU browser project.');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for shader validation.');
      const device = await adapter.requestDevice();
      const uncapturedErrors: string[] = [];
      device.addEventListener('uncapturederror', (event) => {
        uncapturedErrors.push(event.error.message);
      });
      device.pushErrorScope('validation');
      try {
        const module = device.createShaderModule({ code });
        const info = await module.getCompilationInfo();
        await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        });
        const error = await device.popErrorScope();
        return {
          compilationErrors: info.messages
            .filter((message) => message.type === 'error')
            .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`),
          validationError: error?.message ?? null,
          uncapturedErrors,
        };
      } finally {
        device.destroy();
      }
    }, code);
    expect(diagnostics.compilationErrors).toEqual([]);
    expect(diagnostics.validationError).toBeNull();
    expect(diagnostics.uncapturedErrors).toEqual([]);
  });
}
