import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build } from 'vite';

export async function bundleRenderer(): Promise<string> {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./render-entry.ts', import.meta.url)),
        name: 'renderModule',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || !('output' in output)) throw new Error('Expected one render bundle.');
  const entry = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Render bundle has no entry chunk.');
  return entry.code;
}

export async function openFixture(page: Page, rendererCode: string): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('./#/validate');
  await expect(page.getByRole('heading', { name: 'Validation results' })).toBeVisible();
  // The results page is taller than the viewport; its scrollbar would narrow the fixture canvas.
  await page.evaluate(() => document.body.replaceChildren());
  await page.addScriptTag({ content: rendererCode });
}
