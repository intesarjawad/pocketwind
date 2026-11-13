import { describe, expect, it } from 'vitest';
import {
  browserVersionFromUserAgent,
  budgetFailures,
  type ColdStartRow,
  type MarkTimes,
  mergeRows,
  otherOriginRequests,
  parseArguments,
  type RunObservation,
  stageTimes,
  unsupportedFailures,
} from '../../scripts/cold-start-report';

const marks: MarkTimes = {
  'pwt:first-smoke': [1200.04],
  'pwt:first-cd': [2000],
  'pwt:drop': [5000],
  'pwt:drop-smoke': [6500.26],
  'pwt:drop-cd': [8000],
  'pwt:settled': [30000],
};

const clean: RunObservation = {
  stages: { firstSmokeMs: 1200, dropToSmokeMs: 1500, dropToCdMs: 3000, dropToSettledMs: 25000 },
  otherOriginRequests: 0,
  requestsAfterDrop: 0,
  cookies: 0,
  localStorageItems: 0,
  indexedDbDatabases: 0,
  dialogs: 0,
  permissionsAsked: [],
  consoleErrors: [],
};

function row(engine: 'chromium' | 'webkit', commit: string): ColdStartRow {
  return {
    url: 'http://127.0.0.1:4173/pocketwind/',
    engine,
    browserVersion: '1.0',
    ...clean.stages,
    requestsAfterDrop: 0,
    otherOriginRequests: 0,
    commit,
    date: '2026-01-01T00:00:00.000Z',
  };
}

describe('cold start arguments', () => {
  it('defaults to both engines against the built page', () => {
    expect(parseArguments([])).toEqual({
      url: undefined,
      engines: ['chromium', 'webkit'],
      expectUnsupported: false,
    });
  });

  it('reads the url, engine list and unsupported flag', () => {
    expect(
      parseArguments(['--url=http://localhost:4173/pocketwind/', '--engines=webkit,chromium']),
    ).toEqual({
      url: 'http://localhost:4173/pocketwind/',
      engines: ['chromium', 'webkit'],
      expectUnsupported: false,
    });
    expect(parseArguments(['--expect-unsupported', '--engines=chromium'])).toMatchObject({
      engines: ['chromium'],
      expectUnsupported: true,
    });
  });

  it('rejects unknown options, engines and addresses', () => {
    expect(() => parseArguments(['--headless'])).toThrow('Unknown option --headless');
    expect(() => parseArguments(['fast'])).toThrow('Unknown option fast');
    expect(() => parseArguments(['--engines=chromium,firefox'])).toThrow('"firefox"');
    expect(() => parseArguments(['--url=pocketwind'])).toThrow('--url');
    expect(() => parseArguments(['--url=file:///tmp/index.html'])).toThrow('--url');
  });
});

describe('cold start stages', () => {
  it('measures the first smoke from navigation and the rest from the drop', () => {
    expect(stageTimes(marks)).toEqual({
      firstSmokeMs: 1200,
      dropToSmokeMs: 1500.3,
      dropToCdMs: 3000,
      dropToSettledMs: 25000,
    });
  });

  it('uses the first mark at or after the drop, not an earlier run', () => {
    expect(
      stageTimes({ ...marks, 'pwt:settled': [1500, 30000, 40000], 'pwt:drop-cd': [5000] }),
    ).toMatchObject({ dropToSettledMs: 25000, dropToCdMs: 0 });
  });

  it('names the mark a page never emitted', () => {
    expect(() => stageTimes({ ...marks, 'pwt:first-smoke': [] })).toThrow('pwt:first-smoke');
    expect(() => stageTimes({ ...marks, 'pwt:drop-cd': [] })).toThrow('pwt:drop-cd after');
    expect(() => stageTimes({ ...marks, 'pwt:settled': [4000] })).toThrow('pwt:settled after');
    expect(() => stageTimes({ ...marks, 'pwt:drop': [] })).toThrow('pwt:drop');
  });
});

describe('cold start budgets', () => {
  it('accepts a run inside every budget, including the limits themselves', () => {
    expect(budgetFailures(clean)).toEqual([]);
    expect(
      budgetFailures({
        ...clean,
        stages: {
          firstSmokeMs: 3000,
          dropToSmokeMs: 3000,
          dropToCdMs: 4000,
          dropToSettledMs: 75000,
        },
      }),
    ).toEqual([]);
  });

  it('names each stage that is over', () => {
    const failures = budgetFailures({
      ...clean,
      stages: {
        firstSmokeMs: 3000.1,
        dropToSmokeMs: 3001,
        dropToCdMs: 4001,
        dropToSettledMs: 75001,
      },
    });
    expect(failures).toHaveLength(4);
    expect(failures.join('\n')).toMatch(/First smoke.*Drop to smoke.*Drop to Cd.*Drop to settled/s);
  });

  it('fails on any request, stored item, dialog, permission request or console error', () => {
    const failures = budgetFailures({
      ...clean,
      otherOriginRequests: 1,
      requestsAfterDrop: 2,
      cookies: 1,
      localStorageItems: 3,
      indexedDbDatabases: 1,
      dialogs: 1,
      permissionsAsked: ['geolocation'],
      consoleErrors: ['boom'],
    });
    expect(failures).toEqual([
      'Requests to another origin: 1, expected none.',
      'Requests after the drop: 2, expected none.',
      'Cookies: 1, expected none.',
      'localStorage items: 3, expected none.',
      'IndexedDB databases: 1, expected none.',
      'Dialogs: 1, expected none.',
      'Permission requests: 1, expected none.',
      'Console error: boom',
    ]);
  });
});

describe('unsupported page budget', () => {
  const ok = { renderMs: 400, otherOriginRequests: 0, cookies: 0 };

  it('accepts a prompt page with no other origin and no cookies', () => {
    expect(unsupportedFailures(ok)).toEqual([]);
    expect(unsupportedFailures({ ...ok, renderMs: 1000 })).toEqual([]);
  });

  it('fails a slow, missing or leaky page', () => {
    expect(unsupportedFailures({ ...ok, renderMs: 1000.5 })).toHaveLength(1);
    expect(unsupportedFailures({ ...ok, renderMs: null })[0]).toContain('never showed');
    expect(unsupportedFailures({ ...ok, otherOriginRequests: 1, cookies: 2 })).toHaveLength(2);
  });
});

describe('requests', () => {
  const page = 'http://127.0.0.1:4173/pocketwind/';

  it('finds requests to any origin other than the page', () => {
    expect(
      otherOriginRequests(
        [
          'http://127.0.0.1:4173/pocketwind/assets/index.js',
          'http://127.0.0.1:4173/favicon.ico',
          'https://fonts.example/a.woff2',
          'http://localhost:4173/pocketwind/',
          'http://127.0.0.1:4174/pocketwind/',
        ],
        page,
      ),
    ).toEqual([
      'https://fonts.example/a.woff2',
      'http://localhost:4173/pocketwind/',
      'http://127.0.0.1:4174/pocketwind/',
    ]);
  });

  it('does not count data, blob or about URLs', () => {
    expect(
      otherOriginRequests(['data:,', 'blob:http://127.0.0.1:4173/id', 'about:blank'], page),
    ).toEqual([]);
  });
});

describe('browser version', () => {
  it('reads Chromium and WebKit user agents', () => {
    expect(
      browserVersionFromUserAgent(
        'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/139.0.7258.5 Safari/537.36',
      ),
    ).toBe('139.0.7258.5');
    expect(
      browserVersionFromUserAgent('Mozilla/5.0 AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'),
    ).toBe('26.0');
    expect(browserVersionFromUserAgent('curl/8')).toBe('curl/8');
  });
});

describe('cold start report rows', () => {
  it('replaces the rows of measured engines and keeps the others in engine order', () => {
    const merged = mergeRows(
      [row('webkit', 'old'), row('chromium', 'old')],
      [row('chromium', 'new')],
    );
    expect(merged.map((entry) => [entry.engine, entry.commit])).toEqual([
      ['chromium', 'new'],
      ['webkit', 'old'],
    ]);
  });
});
