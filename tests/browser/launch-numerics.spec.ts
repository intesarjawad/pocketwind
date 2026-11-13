import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// These exercise the live solver; the CPU project excludes this tag.
test.describe('launch numerics', { tag: '@gpu' }, () => {
  test('loading and re-exporting a saved result preserves every field', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('.readout')).toContainText('domain', { timeout: 30_000 });
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) > 0);
    const exported = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export run' }).click();
    const original = await readFile(await (await exported).path());
    const fields: Record<string, unknown> = JSON.parse(original.toString());
    expect(fields.effectiveRe).toBe(320);
    expect(fields.viscosityFloor).toBe(true);
    expect(fields).toHaveProperty('semPct');
    Object.assign(fields, {
      cd: 2.27,
      cdaM2: 0.25424,
      semPct: 1.7,
      fluctuationPct: 0.4,
      status: { kind: 'steady', relStdPct: 0.4, driftPct: 0.2 },
      forceHistory: [
        [8, 2.2],
        [16, 2.27],
      ],
    });
    await page.getByLabel('Open a saved run').setInputFiles({
      name: 'saved.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(fields)),
    });
    await expect(page.getByText(/Showing the saved run/)).toBeVisible();
    const again = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export run' }).click();
    expect(JSON.parse(await readFile(await (await again).path(), 'utf8'))).toEqual(fields);
  });

  test('a successful model import clears the stale custom-link notice', async ({ page }) => {
    await page.goto('./#/?p=custom');
    await expect(page.getByText(/Drop the model again/)).toBeVisible();
    await page
      .locator('input[type=file][accept*=".stl"]')
      .setInputFiles('tests/fixtures/stl/cube-binary.stl');
    await expect(page.locator('.readout')).toContainText('domain', { timeout: 30_000 });
    await expect(page.getByText(/Drop the model again/)).toBeHidden();
    await expect(page.locator('#tunnel')).toBeVisible();
  });

  test('the documented empty tunnel renders without a custom-model error or a drag value', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./#/?p=none');
    await expect(page.locator('[name=presetId]')).toHaveValue('none');
    await expect(page.locator('.readout')).toContainText('domain', { timeout: 30_000 });
    await expect(page.locator('#tunnel')).toBeVisible();
    await expect(page.getByText(/Drop the model again/)).toHaveCount(0);
    await expect(page.locator('#run-status')).toContainText('there is no body drag to report');
    await expect(page.locator('.plate-caption')).toBeHidden();
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) > 0);
    await expect(page.locator('.readout')).toContainText('Cd not reported');
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) >= 2560);
    await page.screenshot({ path: test.info().outputPath('empty-tunnel.png') });
    expect(errors).toEqual([]);
  });

  test('unsupported Bouzidi walls are disabled and a direct link is refused before running', async ({
    page,
  }) => {
    await page.goto('./#/?w=bouzidi');
    await expect(page.locator('[name=walls] option[value=bouzidi]')).toHaveJSProperty(
      'disabled',
      true,
    );
    await expect(page.locator('#run-status')).toContainText('LES');
    await expect(page.locator('#run-status')).toContainText('not validated');
    await expect(page.locator('#tunnel')).toBeHidden();
  });

  test('Check grid runs the S/M/L refinement and restores the live view', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const samples: number[][] = [];
      Reflect.set(window, '__gridPhysics', samples);
      const write = GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer = function (...args: Parameters<GPUQueue['writeBuffer']>) {
        const [buffer, , data] = args;
        if (buffer.label === 'solver parameters' && data instanceof ArrayBuffer) {
          const values = new DataView(data);
          const entry = [
            values.getUint32(0, true),
            values.getFloat32(16, true),
            values.getFloat32(20, true),
          ];
          if (!samples.some((sample) => sample.every((value, index) => value === entry[index])))
            samples.push(entry);
        }
        return Reflect.apply(write, this, args);
      };
    });
    await page.goto('./#/?gcT=0.0001');
    await expect(page.locator('.readout')).toContainText('domain', { timeout: 30_000 });
    await page.waitForFunction(() => (window.__pocketwindRun?.step ?? 0) > 0);
    await page.getByRole('button', { name: 'Check grid' }).click();
    await expect(page.locator('#run-status')).toContainText('S/M/L check at Re', {
      timeout: 90_000,
    });
    await expect(page.locator('#run-status')).toContainText(/finest-grid (grid band|no grid band)/);
    const physics: number[][] = await page.evaluate(() => Reflect.get(window, '__gridPhysics'));
    expect(physics.map(([nx]) => nx).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([128, 192, 256]);
    for (const [nx = 0, speed = 0, viscosity = 0] of physics) {
      expect((speed * (nx / 2)) / viscosity).toBeCloseTo(320, 2);
    }
    await expect(page.locator('#tunnel')).toBeVisible();
  });
});
