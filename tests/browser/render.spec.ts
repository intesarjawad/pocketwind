import { expect, test } from '@playwright/test';
import { bundleRenderer, openFixture } from './render-fixture';

declare const renderModule: typeof import('./render-entry');
declare global {
  interface Window {
    renderFixture: { scene: { dispose(): void }; device: GPUDevice; errors: string[] };
  }
}

let rendererCode = '';
test.beforeAll(async () => {
  rendererCode = await bundleRenderer();
});

for (const body of [false, true]) {
  test(
    body
      ? 'Ahmed 25 degree fixture matches the per-browser golden'
      : 'domain outline and floor grid match the per-browser golden',
    async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openFixture(page, rendererCode);
      const diagnostics = await page.evaluate(async (withBody) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter is available for rendering.');
        const device = await adapter.requestDevice();
        const gpuErrors: string[] = [];
        device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
        device.pushErrorScope('validation');
        device.pushErrorScope('out-of-memory');
        const canvas = document.createElement('canvas');
        canvas.id = 'render-fixture';
        canvas.style.setProperty('--pwt-ground', '#101010');
        canvas.style.setProperty('--pwt-line', '#808080');
        canvas.style.setProperty('--pwt-body', '#999999');
        document.body.append(canvas);
        // The rear roof falls at 25 degrees; the fixture stays in lattice coordinates.
        const rearRoof = 8 - 5 * Math.tan((25 * Math.PI) / 180);
        const vertices = [
          [16, 12, 2],
          [36, 12, 2],
          [36, 12, rearRoof],
          [31, 12, 8],
          [16, 12, 8],
          [16, 20, 2],
          [36, 20, 2],
          [36, 20, rearRoof],
          [31, 20, 8],
          [16, 20, 8],
        ];
        const triangles = [
          [0, 1, 2],
          [0, 2, 3],
          [0, 3, 4],
          [5, 7, 6],
          [5, 8, 7],
          [5, 9, 8],
          [0, 5, 6],
          [0, 6, 1],
          [0, 4, 9],
          [0, 9, 5],
          [1, 6, 7],
          [1, 7, 2],
          [2, 7, 8],
          [2, 8, 3],
          [3, 8, 9],
          [3, 9, 4],
        ];
        const mesh = {
          triangleCount: triangles.length,
          positions: Float32Array.from(
            triangles.flatMap((triangle) => triangle.flatMap((index) => vertices[index] ?? [])),
          ),
        };
        const scene = await renderModule.createScene(canvas, device, 'rearquarter', {
          bounds: { min: [0, 0, 0], max: [63, 31, 23] },
          gridSpacing: 4,
          ...(withBody ? { body: { mesh, label: 'Ahmed body, 25 degree slant' } } : {}),
        });
        window.renderFixture = { scene, device, errors: gpuErrors };
        return {
          allocation: (await device.popErrorScope())?.message ?? null,
          validation: (await device.popErrorScope())?.message ?? null,
        };
      }, body);
      const canvas = page.locator('#render-fixture');
      await expect(canvas).toHaveAttribute('data-scene-state', 'running');
      await canvas.focus();
      await page.keyboard.press('Space');
      await expect(canvas).toHaveAttribute('data-scene-state', 'paused');
      if (body) await expect(canvas).toHaveAccessibleName(/Ahmed body, 25 degree slant/);
      await expect(canvas).toHaveScreenshot(body ? 'ahmed-25-body.png' : 'domain-floor-grid.png', {
        maxDiffPixelRatio: 0.02,
      });
      expect(diagnostics).toEqual({ allocation: null, validation: null });
      expect(
        await page.evaluate(async () => {
          await window.renderFixture.device.queue.onSubmittedWorkDone();
          return window.renderFixture.errors;
        }),
      ).toEqual([]);
      expect(errors).toEqual([]);
      await page.evaluate(() => {
        window.renderFixture.scene.dispose();
        window.renderFixture.device.destroy();
      });
    },
  );
}
