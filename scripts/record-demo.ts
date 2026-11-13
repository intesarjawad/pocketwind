import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { PASS_TOLERANCE_PCT, SPHERE_RE_100_REFERENCE_CD } from '../src/validation/cases';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const TIMEOUT_MS = 600_000;

async function main(): Promise<void> {
  const frames = await mkdtemp(join(tmpdir(), 'pocketwind-demo-'));
  await build({ logLevel: 'warn' });
  const server = await preview({ preview: { port: 4175, strictPort: true }, logLevel: 'warn' });
  const browser = await chromium.launch({ executablePath: BRAVE, headless: false });
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
      deviceScaleFactor: 1,
    });
    await page.goto(
      'http://localhost:4175/pocketwind/#/?p=sphere&t=M&st=f32&op=trt&fl=0&v=5&len=120&laminar=1',
    );
    await page.waitForSelector('.plate-caption', { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () => document.querySelector('.plate-conditions')?.textContent?.includes('domain'),
      undefined,
      { timeout: TIMEOUT_MS },
    );
    let frame = 0;
    const capture = async (): Promise<void> => {
      await page.screenshot({ path: join(frames, `${String(frame++).padStart(4, '0')}.png`) });
    };
    const captureUntil = async (step: number): Promise<void> => {
      const deadline = Date.now() + TIMEOUT_MS;
      let next = 0;
      while (true) {
        const current = await page.evaluate(() => window.__pocketwindRun?.step ?? 0);
        if (current >= next || current >= step) {
          await capture();
          next = current + 800;
        }
        if (current >= step) break;
        if (Date.now() > deadline) throw new Error('The demo run did not reach its target steps.');
        await page.waitForTimeout(1000);
      }
    };
    const verify = async (): Promise<void> => {
      const conditions = await page.locator('.plate-conditions').innerText();
      const value = Number(await page.locator('.plate-figure__value').innerText());
      const tolerance = PASS_TOLERANCE_PCT / 100;
      if (
        !conditions.includes('Re 100') ||
        !conditions.includes('192 × 96 × 96') ||
        !conditions.includes('LES off, no viscosity floor') ||
        !Number.isFinite(value) ||
        value < SPHERE_RE_100_REFERENCE_CD * (1 - tolerance) ||
        value > SPHERE_RE_100_REFERENCE_CD * (1 + tolerance)
      ) {
        throw new Error(
          `The sphere did not match the validated tier-M conditions: ${conditions}, Cd ${value}.`,
        );
      }
    };
    await captureUntil(24000);
    await verify();
    await page.locator('#size').fill('100');
    await page.waitForFunction(() =>
      document.querySelector('.plate-title')?.textContent?.includes('100 mm'),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) < 24000, undefined, {
      timeout: TIMEOUT_MS,
    });
    await captureUntil(24000);
    await verify();
    for (let i = 0; i < 6; i += 1) {
      await capture();
      await page.waitForTimeout(1000);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) >= 24000, undefined, {
      timeout: TIMEOUT_MS,
    });
    await verify();
    await page.screenshot({ path: 'docs/demo-still.png' });
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        '2',
        '-i',
        join(frames, '%04d.png'),
        '-filter_complex',
        'fps=2,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer',
        '-loop',
        '0',
        'docs/demo.gif',
      ],
      { stdio: 'inherit' },
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await rm(frames, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
