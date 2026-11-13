import { expect, test } from '@playwright/test';
import { MESSAGES } from '../../src/app/messages';

test('missing WebGPU renders both message parts promptly without console errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, 'gpu');
    Reflect.deleteProperty(navigator, 'gpu');
    const observer = new MutationObserver(() => {
      if (document.querySelector('#unsupported [data-message="next"]')) {
        performance.mark('unsupported-rendered');
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto('./');
  await expect(page.locator('#unsupported [data-message="what"]')).toHaveText(
    MESSAGES['webgpu-missing'].what,
  );
  await expect(page.locator('#unsupported [data-message="next"]')).not.toBeEmpty();
  await expect(page.locator('#unsupported [data-message="next"]')).toContainText(
    MESSAGES['webgpu-missing'].next,
  );
  await expect(page.locator('#tunnel')).toBeHidden();
  const renderMs = await page.evaluate(() => {
    const rendered = performance.getEntriesByName('unsupported-rendered')[0];
    const script = Array.from(document.scripts).find((element) => element.type === 'module');
    const resource = script ? performance.getEntriesByName(script.src)[0] : undefined;
    if (!rendered || !resource) throw new Error('Missing unsupported render timing entries.');
    return rendered.startTime - (resource.startTime + resource.duration);
  });
  expect(renderMs).toBeGreaterThanOrEqual(0);
  expect(renderMs).toBeLessThan(100);
  await page.getByRole('link', { name: 'Read the validation results' }).click();
  await expect(page.getByRole('heading', { name: 'Validation results' })).toBeVisible();
  await expect(page.locator('#tunnel')).toBeHidden();
  expect(errors).toEqual([]);
});

for (const failure of ['no-adapter', 'device-rejected'] as const) {
  test(`${failure} shows its reason and next step`, async ({ page }) => {
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          async requestAdapter() {
            if (mode === 'no-adapter') return null;
            return {
              features: new Set(),
              limits: {},
              async requestDevice() {
                throw new Error('Device rejected');
              },
            };
          },
        },
      });
    }, failure);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./');
    const reason = failure === 'no-adapter' ? 'adapter-unavailable' : 'device-unavailable';
    await expect(page.locator('[data-message="what"]')).toHaveText(MESSAGES[reason].what);
    await expect(page.locator('[data-message="next"]')).toContainText(MESSAGES[reason].next);
    await expect(page.locator('#tunnel')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('low adapter limits show the tier S notice', { tag: '@gpu' }, async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = navigator.gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => gpu.getPreferredCanvasFormat(),
        async requestAdapter() {
          const adapter = await gpu.requestAdapter();
          if (!adapter) throw new Error('A WebGPU adapter is required for the tunnel view.');
          return {
            features: adapter.features,
            limits: {
              maxBufferSize: 134217728,
              maxStorageBufferBindingSize: 67108864,
              maxStorageBuffersPerShaderStage: 8,
            },
            requestDevice: (descriptor: GPUDeviceDescriptor) => adapter.requestDevice(descriptor),
          };
        },
      },
    });
  });
  await page.goto('./');
  await expect(
    page.getByRole('status').filter({ hasText: MESSAGES['tier-s-only'].what }),
  ).toHaveText(`${MESSAGES['tier-s-only'].what} ${MESSAGES['tier-s-only'].next}`);
  await expect(page.locator('#tunnel')).toBeVisible();
});

test('validation route never requests a GPU', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      get() {
        throw new Error('GPU must not be read');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./#/validate');
  await expect(page.getByRole('heading', { name: 'Validation results' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Validation', exact: true })).toBeVisible();
  await expect(page.locator('#tunnel')).toBeHidden();
  expect(errors).toEqual([]);
});
