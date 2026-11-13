import { cpus } from 'node:os';
import { expect, type Page, test } from '@playwright/test';
import type { BenchReport } from '../../src/app/bench-page';

const BENCH_MS = 120_000;
// On the base M5 the copy kernel must sustain at least 80 GB/s and cannot exceed the
// chip's 153 GB/s peak memory bandwidth.
const M5_COPY_GBPS = { min: 80, max: 153 } as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** Runs in the page before any script: hold pipeline creation until the test releases it. */
function holdPipelines(): void {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(window, '__releasePipelines', () => release());
  const prototype = Reflect.get(window, 'GPUDevice')?.prototype;
  const original: unknown = prototype && Reflect.get(prototype, 'createComputePipelineAsync');
  if (typeof original !== 'function') return;
  Reflect.set(
    prototype,
    'createComputePipelineAsync',
    async function (this: GPUDevice, ...args: unknown[]) {
      await held;
      return Reflect.apply(original, this, args);
    },
  );
}

function readReport(): BenchReport | undefined {
  return window.__pwt;
}

test('the bench page shows its progress, then the report, with the tunnel hidden', {
  tag: '@gpu',
}, async ({ page }) => {
  test.setTimeout(2 * BENCH_MS);
  const errors = collectErrors(page);
  await page.addInitScript(holdPipelines);
  await page.goto('./#/bench?tiers=S&steps=100');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Performance results');
  await expect(page.getByRole('status')).toHaveText('Measuring copy bandwidth.');
  await expect(page.getByLabel('Benchmark report')).toBeHidden();
  expect(await page.evaluate(readReport)).toBeUndefined();
  await expect(page.locator('#tunnel')).toBeHidden();

  await page.evaluate(() => Reflect.apply(Reflect.get(window, '__releasePipelines'), window, []));
  await expect(page.getByRole('status')).toHaveText('Measured.', { timeout: BENCH_MS });
  const report = await page.evaluate(readReport);
  if (report === undefined) throw new Error('The page finished without publishing its report.');

  const shown: unknown = JSON.parse(
    (await page.getByLabel('Benchmark report').textContent()) ?? '',
  );
  expect(shown).toEqual(report);
  expect(Object.keys(report.perTier)).toEqual(['S']);
  expect(report.steps).toBe(100);
  expect(report.copyGBps).toBeGreaterThan(0);
  const tier = report.perTier.S;
  expect(tier?.mlups).toBeGreaterThan(0);
  expect(tier?.msPerStep).toBeGreaterThan(0);
  expect(tier?.rooflinePct).toBeGreaterThan(0);
  expect(tier?.rooflinePct).toBeLessThanOrEqual(100);
  expect(report.userAgent).toBe(await page.evaluate(() => navigator.userAgent));
  expect(['timestamp-query', 'submitted-work-done']).toContain(report.timing);

  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  const add = page.getByRole('link', { name: 'Add my GPU' });
  await expect(add).toHaveAttribute('target', '_blank');
  await expect(add).toHaveAttribute('href', /\/issues\/new\?template=bench-report\.yml&/);
  await expect(page.locator('#tunnel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('without WebGPU the bench page says nothing was measured', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, 'gpu');
    Reflect.deleteProperty(navigator, 'gpu');
  });
  await page.goto('./#/bench');

  await expect(page.getByRole('alert')).toHaveText(
    'WebGPU is unavailable, so nothing was measured.',
  );
  await expect(page.getByLabel('Benchmark report')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
  expect(await page.evaluate(readReport)).toBeUndefined();
  await expect(page.locator('#tunnel')).toBeHidden();
});

test('without an adapter the bench page says nothing was measured', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => null },
    });
  });
  await page.goto('./#/bench');

  await expect(page.getByRole('alert')).toHaveText(
    'No WebGPU adapter is available, so nothing was measured.',
  );
  expect(await page.evaluate(readReport)).toBeUndefined();
  await expect(page.locator('#tunnel')).toBeHidden();
});

test('the base M5 reports a copy bandwidth its memory can sustain', { tag: '@gpu' }, async ({
  page,
}) => {
  test.skip(cpus()[0]?.model !== 'Apple M5', 'The bandwidth band is for the base M5 only.');
  test.setTimeout(BENCH_MS);
  await page.goto('./#/bench?tiers=S&steps=100');
  await expect(page.getByRole('status')).toHaveText('Measured.', { timeout: BENCH_MS });
  const report = await page.evaluate(readReport);
  expect(report?.copyGBps).toBeGreaterThanOrEqual(M5_COPY_GBPS.min);
  expect(report?.copyGBps).toBeLessThanOrEqual(M5_COPY_GBPS.max);
});
