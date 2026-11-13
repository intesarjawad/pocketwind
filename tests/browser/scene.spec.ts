import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    sceneProbe: { frames: number; submissions: number; matrix: number[]; gpuErrors: string[] };
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.addInitScript(() => {
    window.sceneProbe = { frames: 0, submissions: 0, matrix: [], gpuErrors: [] };
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame((time) => {
        window.sceneProbe.frames += 1;
        callback(time);
      });
    if (!navigator.gpu) return;
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (options) => {
      const adapter = await requestAdapter(options);
      if (!adapter) return null;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (descriptor) => {
        const device = await requestDevice(descriptor);
        device.addEventListener('uncapturederror', (event) => {
          window.sceneProbe.gpuErrors.push(event.error.message);
        });
        const submit = device.queue.submit.bind(device.queue);
        device.queue.submit = (commands) => {
          submit(commands);
          window.sceneProbe.submissions += 1;
        };
        const writeBuffer = device.queue.writeBuffer.bind(device.queue);
        device.queue.writeBuffer = (...args) => {
          const [buffer, , data] = args;
          if (buffer.label === 'Camera view projection' && data instanceof Float32Array) {
            window.sceneProbe.matrix = Array.from(data);
          }
          writeBuffer(...args);
        };
        return device;
      };
      return adapter;
    };
  });
});

test('draws the domain, exposes keyboard controls and saves a screenshot', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('./#/?cam=rearquarter');
  const canvas = page.locator('#tunnel');
  await expect(canvas).toHaveAttribute('data-scene-state', 'running');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.submissions)).toBeGreaterThan(2);
  await expect(canvas).toHaveAccessibleName(
    'Wind tunnel, Ahmed body at 25 degrees, flow particles, domain outline and floor grid, view ready.',
  );
  await expect(canvas).toHaveAttribute('aria-description', /Arrow keys.*R resets.*Space/);
  // The masthead's links and the expose button come before the plate in the tab order.
  for (let press = 0; press < 6; press += 1) {
    if (await canvas.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(canvas).toBeFocused();

  const baseline = await page.evaluate(() => window.sceneProbe.matrix);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).not.toEqual(baseline);
  await page.keyboard.press('R');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).toEqual(baseline);

  const box = await canvas.boundingBox();
  if (!box) throw new Error('The scene canvas has no visible bounds.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).not.toEqual(baseline);
  await page.keyboard.press('R');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).toEqual(baseline);
  await page.mouse.wheel(0, 150);
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).not.toEqual(baseline);
  await page.keyboard.press('R');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.matrix)).toEqual(baseline);

  const screenshot = testInfo.outputPath('domain-outline.png');
  await canvas.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('Domain outline', { path: screenshot, contentType: 'image/png' });
  expect(await page.evaluate(() => window.sceneProbe.gpuErrors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('pauses animation when hidden and preserves an explicit pause across visibility changes', async ({
  page,
}) => {
  await page.goto('./');
  const canvas = page.locator('#tunnel');
  await expect(canvas).toHaveAttribute('data-scene-state', 'running');
  await expect.poll(() => page.evaluate(() => window.sceneProbe.submissions)).toBeGreaterThan(2);
  // Dispatch the visibility event deterministically without depending on window focus.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-scene-state', 'hidden');
  const hiddenFrames = await page.evaluate(() => window.sceneProbe.frames);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sceneProbe.frames)).toBe(hiddenFrames);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => window.sceneProbe.frames))
    .toBeGreaterThan(hiddenFrames);
  await canvas.focus();
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-scene-state', 'paused');
  await expect(canvas).toHaveAccessibleName(/view paused/);
  // The input schedules one final redraw before the paused loop becomes idle.
  await page.waitForTimeout(150);
  const pausedFrames = await page.evaluate(() => window.sceneProbe.frames);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sceneProbe.frames)).toBe(pausedFrames);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-scene-state', 'paused');
  await page.waitForTimeout(150);
  const restoredFrames = await page.evaluate(() => window.sceneProbe.frames);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sceneProbe.frames)).toBe(restoredFrames);
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-scene-state', 'running');
  await expect
    .poll(() => page.evaluate(() => window.sceneProbe.frames))
    .toBeGreaterThan(restoredFrames);
  expect(await page.evaluate(() => window.sceneProbe.gpuErrors)).toEqual([]);
});

test('resizes colour and depth attachments with capped pixel density and cleans up routes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
  });
  await page.goto('./#/?cam=top');
  const canvas = page.locator('#tunnel');
  await expect(canvas).toHaveAttribute('data-scene-state', 'running');
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected the scene canvas.');
        return element.width === Math.round(element.clientWidth * 2);
      }),
    )
    .toBe(true);
  const originalWidth = await canvas.getAttribute('width');
  await page.setViewportSize({ width: 600, height: 500 });
  await expect.poll(() => canvas.getAttribute('width')).not.toBe(originalWidth);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected the scene canvas.');
        return (
          element.width === Math.round(element.clientWidth * 2) &&
          element.height === Math.round(element.clientHeight * 2)
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    location.hash = '/validate';
  });
  await expect(canvas).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-scene-state');
  const stoppedFrames = await page.evaluate(() => window.sceneProbe.frames);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.sceneProbe.frames)).toBe(stoppedFrames);
  await page.getByRole('link', { name: 'Open the tunnel' }).click();
  await expect(canvas).toHaveAttribute('data-scene-state', 'running');
  await expect
    .poll(() => page.evaluate(() => window.sceneProbe.frames))
    .toBeGreaterThan(stoppedFrames);
  expect(await page.evaluate(() => window.sceneProbe.gpuErrors)).toEqual([]);
});
