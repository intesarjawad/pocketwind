import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { MESSAGES } from '../../src/app/messages';

// The standard the project commits to; best-practice rules are left out so a finding is a WCAG failure.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MAX_TAB_PRESSES = 40;

async function wcagViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unrated'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
}

async function withoutWebGpu(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, 'gpu');
    Reflect.deleteProperty(navigator, 'gpu');
  });
}

/** Press Tab until the target holds focus, so a control that cannot be reached fails the test. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TAB_PRESSES; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Tab did not reach ${target} within ${MAX_TAB_PRESSES} presses.`);
}

async function openPanel(page: Page): Promise<Locator> {
  await page.goto('./');
  await page.locator('#panel, #unsupported').first().waitFor();
  test.skip(
    (await page.locator('#unsupported').count()) > 0,
    'The panel needs WebGPU, and this browser has none.',
  );
  return page.locator('#panel');
}

const UNSUPPORTED_ROUTES = [
  {
    name: 'tunnel',
    hash: './',
    ready: (page: Page) => page.locator('#unsupported [data-message="next"]'),
  },
  {
    name: 'embedded frame',
    hash: './#/?p=ahmed-25&embed=1',
    ready: (page: Page) => page.locator('#unsupported [data-message="what"]'),
  },
  {
    name: 'validate',
    hash: './#/validate',
    ready: (page: Page) => page.getByRole('heading', { name: 'Validation results' }),
  },
  {
    name: 'bench',
    hash: './#/bench',
    ready: (page: Page) => page.getByRole('alert').filter({ hasText: 'nothing was measured' }),
  },
];

test.describe('without WebGPU', () => {
  test.beforeEach(async ({ page }) => {
    await withoutWebGpu(page);
  });

  for (const route of UNSUPPORTED_ROUTES) {
    test(`${route.name} route has no WCAG violations`, async ({ page }) => {
      await page.goto(route.hash);
      await expect(route.ready(page)).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
    });
  }

  test('flow B: unsupported page to validation results and back by keyboard', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#unsupported')).toBeVisible();
    const toValidation = page.getByRole('link', { name: 'Read the validation results' });
    await tabTo(page, toValidation);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Validation results' })).toBeVisible();

    await tabTo(page, page.getByRole('link', { name: 'Open the tunnel' }));
    await page.keyboard.press('Enter');
    await expect(page.locator('#unsupported [data-message="what"]')).toHaveText(
      MESSAGES['webgpu-missing'].what,
    );
  });

  test('flow C: benchmark page reaches the tunnel by keyboard', async ({ page }) => {
    await page.goto('./#/bench');
    await expect(page.getByRole('heading', { name: 'Performance results' })).toBeVisible();
    await tabTo(page, page.getByRole('link', { name: 'Open the tunnel' }));
    await page.keyboard.press('Enter');
    await expect(page.locator('#unsupported')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Performance results' })).toHaveCount(0);
  });
});

test.describe('with WebGPU', { tag: '@gpu' }, () => {
  test('tunnel panel has no WCAG violations, closed or with Advanced open', async ({ page }) => {
    await openPanel(page);
    expect(await wcagViolations(page)).toEqual([]);
    await page.locator('#panel summary').click();
    await expect(page.locator('#panel details')).toHaveJSProperty('open', true);
    expect(await wcagViolations(page)).toEqual([]);
  });

  test('benchmark page has no WCAG violations while it measures', async ({ page }) => {
    await page.goto('./#/bench');
    await expect(page.getByRole('heading', { name: 'Performance results' })).toBeVisible();
    expect(await wcagViolations(page)).toEqual([]);
  });

  test('flow A: every panel control is reached and operated by keyboard', async ({ page }) => {
    const panel = await openPanel(page);

    await tabTo(page, panel.getByRole('button', { name: 'Choose a model' }));
    await tabTo(page, panel.locator('[name="presetId"]'));
    await tabTo(page, panel.getByLabel('Size', { exact: true }));

    const speed = panel.getByLabel('Speed', { exact: true });
    await tabTo(page, speed);
    const before = Number(await speed.inputValue());
    await page.keyboard.press('ArrowRight');
    await expect(speed).toHaveValue(String(before + 1));
    await expect(panel.locator('output')).toHaveText(`${before + 1} m/s`);

    const compare = panel.getByLabel('Compare', { exact: true });
    await tabTo(page, compare);
    await page.keyboard.press('Space');
    await expect(compare).toBeChecked();

    await tabTo(page, panel.locator('summary'));
    await page.keyboard.press('Enter');
    await expect(panel.locator('details')).toHaveJSProperty('open', true);
    for (const name of ['operator', 'walls', 'storage', 'tier']) {
      await tabTo(page, panel.locator(`[name="${name}"]`));
    }

    await tabTo(page, panel.getByRole('button', { name: 'Check grid' }));

    // The colophon's links close the page, after the record and the share controls.
    const notes = page.locator('#app > footer');
    await tabTo(page, notes.getByRole('link', { name: 'validation page' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Validation results' })).toBeVisible();
    await tabTo(page, page.getByRole('link', { name: 'Open the tunnel' }));
    await page.keyboard.press('Enter');
    await expect(page.locator('#panel')).toBeVisible();
  });
});
