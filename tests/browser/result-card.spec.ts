import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { RESULT_CARD_HEIGHT, RESULT_CARD_WIDTH } from '../../src/io/result-card';

// Cd appears only after two flow-throughs and enough independent batches.
const FIRST_RESULT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Colour management between the canvas compositor and a PNG decode can move a channel by a step or two.
const CHANNEL_TOLERANCE = 3;

/** Runs in the page: decode a PNG with the browser's own decoder and read its top-left pixel. */
async function decodeTopLeft(
  base64: string,
): Promise<{ width: number; height: number; pixel: number[] }> {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('A 2D context is needed to read the image.');
  context.drawImage(bitmap, 0, 0);
  return {
    width: bitmap.width,
    height: bitmap.height,
    pixel: [...context.getImageData(0, 0, 1, 1).data],
  };
}

test('Save image downloads a 1200×675 PNG of the rendered frame', async ({ page }) => {
  test.setTimeout(2 * FIRST_RESULT_MS);
  await page.goto('./');
  await expect(page.locator('.readout')).toHaveText(/Cd \d/, { timeout: FIRST_RESULT_MS });

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save image' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/-card\.png$/);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText(
    `Saved ${download.suggestedFilename()}.`,
  );

  await download.saveAs(test.info().outputPath('result-card.png'));
  const card = await readFile(await download.path());
  expect(card.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
  // IHDR is the first chunk; its width and height are big-endian at bytes 16 and 20.
  expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([
    RESULT_CARD_WIDTH,
    RESULT_CARD_HEIGHT,
  ]);

  const frame = await page.locator('#tunnel').screenshot();
  const decodedCard = await page.evaluate(decodeTopLeft, card.toString('base64'));
  const decodedFrame = await page.evaluate(decodeTopLeft, frame.toString('base64'));
  expect([decodedCard.width, decodedCard.height]).toEqual([RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT]);
  for (const [channel, value] of decodedCard.pixel.entries()) {
    expect(Math.abs(value - (decodedFrame.pixel[channel] ?? Number.NaN))).toBeLessThanOrEqual(
      CHANNEL_TOLERANCE,
    );
  }
});

test('Save image without a running view says so and downloads nothing', async ({ page }) => {
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  // A custom link arrives without its model file, so the tunnel has nothing to run.
  await page.goto('./#/?p=custom');
  await expect(page.getByText('a model file cannot travel in a link')).toBeVisible();

  await page.getByRole('button', { name: 'Save image' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'There is no view to save yet' }),
  ).toHaveText('There is no view to save yet. Wait for the tunnel to start.');
  expect(downloads).toBe(0);
});
