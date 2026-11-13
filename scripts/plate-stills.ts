import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { TIERS } from '../src/lbm/layout';
import { flowThroughSteps } from '../src/validation/cases';

/**
 * Develop the default plate in a GPU browser and keep it as images: the README hero
 * and the page shown without WebGPU, and the social card. Every number in them is the
 * live solver's own output at the default settings.
 */
const OUT = 'public/plate';
const SHOTS = [
  { file: `${OUT}/plate.png`, width: 1440, height: 900 },
  { file: `${OUT}/social.png`, width: 1200, height: 630 },
] as const;
// The default run is tier S. The rake crosses the tunnel in about two flow-throughs and
// the dye behind the base rolls into its spiral within ten, but the slowest threads, in
// the gap under the body, only come to rest after about twenty.
const DEVELOPED_STEPS = 20 * flowThroughSteps(TIERS.S.nx);
const TIMEOUT_MS = 600_000;

function developed(steps: number): boolean {
  const run = Reflect.get(window, '__pocketwindRun') as { step: number } | undefined;
  const value = document.querySelector('.plate-figure__value')?.textContent ?? '';
  return run !== undefined && run.step >= steps && /\d/.test(value);
}

async function main(): Promise<void> {
  await build({ logLevel: 'warn' });
  const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'warn' });
  // The GPU adapter is only exposed to a headed browser on macOS.
  const browser = await chromium.launch({ headless: false });
  try {
    await mkdir(OUT, { recursive: true });
    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
      await page.goto('http://localhost:4174/pocketwind/#/');
      await page.waitForFunction(developed, DEVELOPED_STEPS, { timeout: TIMEOUT_MS });
      // Pausing stops the solver, so the caption logged below is the one in the image.
      const plate = page.locator('#tunnel');
      await plate.press('Space');
      await plate.blur();
      await page.waitForTimeout(1000);
      // A window in the background may hold its fades at the start; the still shows them done.
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish();
      });
      // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps the breaks between caption parts.
      const caption = await page.locator('.plate-caption').innerText();
      await page.locator('.plate').screenshot({ path: shot.file });
      process.stdout.write(`${shot.file}: ${caption.replace(/\s+/g, ' ').trim()}\n`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
