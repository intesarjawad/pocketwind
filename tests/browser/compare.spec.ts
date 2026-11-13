import { expect, test } from '@playwright/test';
import { MESSAGES } from '../../src/app/messages';

// Cd appears only after two flow-throughs and enough independent batches.
const FIRST_RESULT_MS = 120_000;

test('compares the current model with a saved run file, and refuses a different tier', async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * FIRST_RESULT_MS);
  await page.goto('./');
  await expect(page.locator('.readout')).toHaveText(/Cd \d/, { timeout: FIRST_RESULT_MS });

  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export run' }).click();
  const saved = testInfo.outputPath('first-run.json');
  await (await exported).saveAs(saved);

  await page.reload();
  const fileInput = page.getByLabel('Compare with a saved run file');
  await fileInput.setInputFiles(saved);
  const comparison = page.getByRole('table', { name: 'Run comparison' });
  await expect(comparison.getByRole('row')).toHaveCount(3, { timeout: 30_000 });
  await expect(comparison.getByRole('row').nth(1)).toContainText('Run 1');
  await expect(comparison.getByRole('row').nth(2)).toContainText('Run 2');

  const smallGpu = await page.getByText(MESSAGES['tier-s-only'].what).count();
  test.skip(smallGpu > 0, 'A GPU limited to tier S cannot run another tier.');

  await page.getByText('Advanced').click();
  // The label wraps the select, so its text also holds the option names; match the accessible name.
  await page.getByRole('combobox', { name: 'Tier', exact: true }).selectOption('M');
  await fileInput.setInputFiles(saved);
  await expect(page.getByRole('alert').filter({ hasText: 'The saved run used' })).toHaveText(
    'The saved run used grid 128×64×64; this run allocated 192×96×96. Run both models on the same grid before comparing.',
  );
});
