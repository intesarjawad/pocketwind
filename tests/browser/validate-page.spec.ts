import { expect, type Page, test } from '@playwright/test';
import { NOT_YET_RUN } from '../../src/app/validate-page';

const RESULTS_URL = '**/validation/results.json';

/** The fields the page reads, with one row in each section that feeds the trust table. */
const RESULTS = {
  schemaVersion: 1,
  commit: 'abc1234',
  date: '2026-11-01T00:00:00.000Z',
  verification: [
    { kind: 'taylor-green', label: 'Taylor-Green 32', steps: 200, error: 0.0006, errorPct: null },
  ],
  validation: [
    {
      case: 'ahmed-25',
      group: 'validation',
      tier: 'L',
      cd: 0.301,
      errorPct: 5.6,
      pass: true,
      shapeClass: 'road-vehicle',
      isDefault: true,
      referenceCd: 0.285,
    },
  ],
  gridCheck: [{ case: 'ahmed-25', kind: 'band', gciPct: 2.1, extrapolatedCd: 0.2954 }],
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('loaded results put the trust table first, then each section, with the tunnel hidden', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.route(RESULTS_URL, (route) => route.fulfill({ json: RESULTS }));
  await page.goto('./#/validate');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Validation results');
  await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Where to trust it');
  const trust = page.getByRole('table', { name: 'Where to trust it' });
  await expect(trust.getByRole('row').nth(1).getByRole('cell')).toHaveText([
    'road-vehicle',
    '5.6%',
    'n/a',
    'GCI 2.1%, extrapolated Cd 0.2954',
  ]);
  await expect(
    page.getByText('Generated 1 November 2026, 00:00 UTC from commit abc1234.'),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Taylor-Green', exact: true })).toContainText(
    'Taylor-Green 32',
  );
  await expect(page.getByRole('table', { name: 'Validation', exact: true })).toContainText(
    'ahmed-25',
  );
  await expect(
    page
      .getByRole('region', { name: 'Not yet run', exact: true })
      .getByText('Cross-device: no other adapter has saved results yet.'),
  ).toBeVisible();
  await expect(page.locator('#tunnel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('the committed results file renders its verification rows', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/validate');

  // A file merged from several runs names no single commit; each of its rows records its own.
  await expect(
    page.getByText(
      /^Generated .+ UTC from (commit [0-9a-f]{7,}|runs made at different versions of the code; .+)\.$/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Taylor-Green', exact: true }).getByRole('row').nth(1),
  ).toBeVisible();
  await expect(page.locator('#tunnel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('missing results show a retrieval error, with the tunnel hidden', async ({ page }) => {
  await page.route(RESULTS_URL, (route) => route.fulfill({ status: 404 }));
  await page.goto('./#/validate');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Validation results');
  await expect(page.getByRole('alert')).toContainText('Could not load validation results.');
  await expect(page.getByText(NOT_YET_RUN, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the tunnel' })).toBeVisible();
  await expect(page.locator('#tunnel')).toBeHidden();
});

test('a malformed results file shows an error', async ({ page }) => {
  await page.route(RESULTS_URL, (route) =>
    route.fulfill({ body: '{"date":', contentType: 'application/json' }),
  );
  await page.goto('./#/validate');

  await expect(page.getByRole('alert')).toContainText('Could not load validation results.');
  await expect(page.getByText(NOT_YET_RUN, { exact: true })).toHaveCount(0);
  await expect(page.locator('#tunnel')).toBeHidden();
});

test('loading, valid empty results and retrieval errors have different states', async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(RESULTS_URL, async (route) => {
    await held;
    await route.fulfill({ json: { ...RESULTS, validation: [], verification: [], gridCheck: [] } });
  });
  await page.goto('./#/validate');
  await expect(page.getByRole('status')).toHaveText('Loading validation results.');
  release();
  await expect(
    page.getByRole('region', { name: 'Where to trust it' }).getByText(NOT_YET_RUN),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Loading validation results.')).toHaveCount(0);
});

test('figure labels do not overlap and its caption stays outside the scroller', async ({
  page,
}) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('./#/validate');
    const figure = page.locator('.validate-figure');
    await expect(figure.locator('figcaption')).toBeVisible();
    const scroller = figure.getByRole('region', { name: 'Drag coefficient by grid chart' });
    await scroller.focus();
    await expect(scroller).toBeFocused();
    const geometry = await figure.evaluate((element) => {
      const chart = element.querySelector('svg');
      const scroller = element.querySelector('.validate-chart-scroll');
      const caption = element.querySelector('figcaption');
      if (!chart || !scroller || !caption) throw new Error('Figure is incomplete');
      const labels = [...chart.querySelectorAll('text')].filter((text) => text.textContent?.trim());
      const overlaps = labels.flatMap((a, i) =>
        labels.slice(i + 1).flatMap((b) => {
          const x = a.getBBox();
          const y = b.getBBox();
          return x.x < y.x + y.width &&
            x.x + x.width > y.x &&
            x.y < y.y + y.height &&
            x.y + x.height > y.y
            ? [`${a.textContent} / ${b.textContent}`]
            : [];
        }),
      );
      return {
        overlaps,
        captionInScroller: scroller.contains(caption),
        captionWidth: caption.getBoundingClientRect().width,
        figureWidth: element.getBoundingClientRect().width,
      };
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(geometry.overlaps).toEqual([]);
    expect(geometry.captionInScroller).toBe(false);
    expect(geometry.captionWidth).toBeLessThanOrEqual(geometry.figureWidth);
  }
});
