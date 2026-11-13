import { lookup } from 'node:dns/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { MESSAGES } from '../../src/app/messages';

const FIRST_READOUT_MS = 120_000;

function hostPage(frameUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Embedding host</title></head>
  <body>
    <main>
      <h1>Embedding host</h1>
      <iframe src="${frameUrl}" width="640" height="360" title="Pocket Wind Tunnel: Ahmed body at 25 degrees"></iframe>
    </main>
  </body>
</html>`;
}

/**
 * WebGPU needs a secure context in every ancestor, and a blank setContent page is not one.
 * The preview server's loopback address is secure and a different origin from localhost,
 * so the host document is written over a page served from that address.
 */
async function openHost(page: Page, frameUrl: string): Promise<void> {
  const { address, family } = await lookup('localhost');
  const hostUrl = new URL('./#/validate', frameUrl);
  hostUrl.hostname = family === 6 ? `[${address}]` : address;
  await page.goto(hostUrl.toString());
  await page.setContent(hostPage(frameUrl));
}

test('a cross-origin frame shows the canvas and readout without the panel', {
  tag: '@gpu',
}, async ({ page, baseURL }) => {
  test.setTimeout(2 * FIRST_READOUT_MS);
  const frameUrl = new URL('#/?p=ahmed-25&embed=1', baseURL).toString();
  await openHost(page, frameUrl);
  const frame = page.frameLocator('iframe');

  await expect(frame.locator('#tunnel')).toBeVisible();
  await expect(frame.locator('.readout')).toHaveText(/domain \d/, { timeout: FIRST_READOUT_MS });
  await expect(frame.locator('#panel')).toHaveCount(0);

  const link = frame.getByRole('link', { name: 'Open full tunnel' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
  await expect(link).toHaveAttribute('href', /#\/\?p=ahmed-25$/);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('a frame without WebGPU shows the link instead of a blank frame', async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, 'gpu');
    Reflect.deleteProperty(navigator, 'gpu');
  });
  const frameUrl = new URL('#/?p=ahmed-25&embed=1', baseURL).toString();
  await openHost(page, frameUrl);
  const frame = page.frameLocator('iframe');

  await expect(frame.locator('#unsupported [data-message="what"]')).toHaveText(
    MESSAGES['webgpu-missing'].what,
  );
  const link = frame.getByRole('link', { name: 'Open full tunnel' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
  await expect(frame.locator('#tunnel')).toBeHidden();
  await expect(frame.locator('#panel')).toHaveCount(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
