import { expect, test } from '@playwright/test';

test('caption links keep focus during updates and focus controls without navigation', async ({
  page,
}) => {
  await page.goto('./');
  const speed = page.locator('.plate-scale a[href="#speed"]');
  await expect(speed).toBeVisible();
  await speed.focus();
  await page.waitForTimeout(1500);
  await expect(speed).toBeFocused();
  const hash = await page.evaluate(() => location.hash);
  await speed.click();
  await expect(page.locator('#speed')).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  const size = page.locator('.plate-scale a[href="#size"]');
  await size.click();
  await expect(page.locator('#size')).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
});

test('the frame contains its readout and exit at 640 by 360', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('./#/?embed=1');
  const link = page.getByRole('link', { name: 'Open full tunnel' });
  await expect(page.locator('.embed-view .readout')).not.toBeEmpty();
  await expect(link).toBeInViewport();
  const box = await link.boundingBox();
  expect(box?.y).toBeLessThan(360);
});

test('phone can switch to the complete body', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const fit = page.getByRole('button', { name: 'Show complete body' });
  await fit.click();
  await expect(page.getByRole('button', { name: 'Show close view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('device loss clears the result and offers reload', async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = navigator.gpu;
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      const adapter = await requestAdapter(...args);
      if (!adapter) return null;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...options) => {
        const device = await requestDevice(...options);
        Object.defineProperty(device, 'lost', {
          value: new Promise((resolve) => {
            Reflect.set(window, '__loseDevice', () =>
              resolve({ reason: 'unknown', message: 'test' }),
            );
          }),
        });
        return device;
      };
      return adapter;
    };
  });
  await page.goto('./');
  await expect(page.locator('.plate-caption')).toBeVisible();
  await page.evaluate(() => Reflect.get(window, '__loseDevice')());
  await expect(page.getByRole('alert')).toContainText('The graphics device was lost');
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.locator('.plate-figure')).toBeHidden();
  await expect(page.locator('.readout')).toHaveCount(0);
});
