import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserContext, chromium, errors, type Page, webkit } from '@playwright/test';
import { build, preview } from 'vite';
import { MARKS } from '../src/app/timing';
import {
  browserVersionFromUserAgent,
  budgetFailures,
  type ColdStartOptions,
  type ColdStartRow,
  type EngineName,
  mergeRows,
  otherOriginRequests,
  parseArguments,
  stageTimes,
  unsupportedFailures,
} from './cold-start-report';

const FIXTURE = 'tests/fixtures/cold-start/ellipsoid.3mf';
const REPORT = 'bench/cold-start.json';
const VIEWPORT = { width: 1440, height: 900 };
const MARK_TIMEOUT_MS = 90_000;
const UNSUPPORTED_TIMEOUT_MS = 10_000;
const UNSUPPORTED_MARK = 'pwt-unsupported-rendered';
const MARK_NAMES: readonly string[] = Object.values(MARKS);

type Session = {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly requests: string[];
  close: () => Promise<void>;
};

/**
 * Runs in the page before any script: records every call that would raise a permission prompt.
 * It is serialised into the page, so it keeps its helpers inline.
 */
function trackPermissionRequests(): void {
  const asked: string[] = [];
  Reflect.set(globalThis, '__permissionRequests', asked);
  const calls: [object | undefined, string, string][] = [
    [globalThis.Notification, 'requestPermission', 'notifications'],
    [navigator.geolocation, 'getCurrentPosition', 'geolocation'],
    [navigator.geolocation, 'watchPosition', 'geolocation'],
    [navigator.mediaDevices, 'getUserMedia', 'camera or microphone'],
  ];
  for (const [target, name, label] of calls) {
    const original = target === undefined ? undefined : Reflect.get(target, name);
    if (target === undefined || typeof original !== 'function') continue;
    Reflect.set(target, name, (...args: unknown[]) => {
      asked.push(label);
      return Reflect.apply(original, target, args);
    });
  }
}

/** Runs in the page before any script: stamps the first frame that shows both message parts. */
function stampUnsupportedPage(mark: string): void {
  const observer = new MutationObserver(() => {
    const parts = ['what', 'next'].map((part) =>
      document.querySelector(`#unsupported [data-message="${part}"]`)?.textContent?.trim(),
    );
    if (parts.every((text) => text)) {
      performance.mark(mark);
      observer.disconnect();
    }
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
}

async function openSession(engine: EngineName, headless: boolean): Promise<Session> {
  const profile = await mkdtemp(join(tmpdir(), 'pocketwind-cold-start-'));
  const launcher = engine === 'chromium' ? chromium : webkit;
  let context: BrowserContext;
  try {
    context = await launcher.launchPersistentContext(profile, { headless, viewport: VIEWPORT });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  const requests: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    requests,
    async close() {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

function sourceCommit(): string {
  return execFileSync('sh', ['scripts/source-commit.sh'], { encoding: 'utf8' }).trim();
}

function markSeen(name: string): boolean {
  return performance.getEntriesByName(name).length > 0;
}

function marksSeenAfterDrop(arg: { drop: string; names: string[] }): boolean {
  const drop = performance.getEntriesByName(arg.drop)[0];
  return (
    drop !== undefined &&
    arg.names.every((name) =>
      performance.getEntriesByName(name).some((entry) => entry.startTime >= drop.startTime),
    )
  );
}

function readMarks(names: string[]): Record<string, number[]> {
  return Object.fromEntries(
    names.map((name) => [name, performance.getEntriesByName(name).map((entry) => entry.startTime)]),
  );
}

async function readStorage(): Promise<{ localStorageItems: number; indexedDbDatabases: number }> {
  return {
    localStorageItems: localStorage.length,
    indexedDbDatabases: (await indexedDB.databases()).length,
  };
}

function readPermissionRequests(): string[] {
  const asked = Reflect.get(globalThis, '__permissionRequests');
  return Array.isArray(asked) ? asked.map(String) : [];
}

async function measureEngine(
  engine: EngineName,
  pageUrl: string,
): Promise<{ row: ColdStartRow | null; failures: string[] }> {
  const session = await openSession(engine, false);
  const { context, page, requests } = session;
  const consoleErrors: string[] = [];
  let dialogs = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  try {
    await context.addInitScript(trackPermissionRequests);
    await page.goto(`${pageUrl}#/`);
    await page.waitForFunction(markSeen, MARKS.firstCd, { timeout: MARK_TIMEOUT_MS });
    const requestsBeforeDrop = requests.length;
    await page.locator('#dropzone input[type="file"]').setInputFiles(FIXTURE);
    await page.waitForFunction(
      marksSeenAfterDrop,
      { drop: MARKS.drop, names: [MARKS.dropSmoke, MARKS.dropCd, MARKS.settled] },
      { timeout: MARK_TIMEOUT_MS },
    );
    const marks = await page.evaluate(readMarks, [...MARK_NAMES]);
    const stages = stageTimes(marks);
    const { localStorageItems, indexedDbDatabases } = await page.evaluate(readStorage);
    const requestsAfterDrop = requests.length - requestsBeforeDrop;
    const otherOrigin = otherOriginRequests(requests, pageUrl).length;
    const failures = budgetFailures({
      stages,
      otherOriginRequests: otherOrigin,
      requestsAfterDrop,
      cookies: (await context.cookies()).length,
      localStorageItems,
      indexedDbDatabases,
      dialogs,
      permissionsAsked: await page.evaluate(readPermissionRequests),
      consoleErrors,
    });
    const row: ColdStartRow = {
      url: pageUrl,
      engine,
      browserVersion: browserVersionFromUserAgent(await page.evaluate(() => navigator.userAgent)),
      ...stages,
      requestsAfterDrop,
      otherOriginRequests: otherOrigin,
      commit: sourceCommit(),
      date: new Date().toISOString(),
    };
    return { row, failures };
  } catch (error) {
    return { row: null, failures: [error instanceof Error ? error.message : String(error)] };
  } finally {
    await session.close();
  }
}

async function checkUnsupported(engine: EngineName, pageUrl: string): Promise<string[]> {
  const session = await openSession(engine, true);
  const { context, page, requests } = session;
  try {
    await context.addInitScript(stampUnsupportedPage, UNSUPPORTED_MARK);
    await page.goto(`${pageUrl}#/`);
    let renderMs: number | null = null;
    try {
      await page.waitForFunction(markSeen, UNSUPPORTED_MARK, { timeout: UNSUPPORTED_TIMEOUT_MS });
      const marks = await page.evaluate(readMarks, [UNSUPPORTED_MARK]);
      renderMs = marks[UNSUPPORTED_MARK]?.[0] ?? null;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    return unsupportedFailures({
      renderMs: renderMs === null ? null : Math.round(renderMs * 10) / 10,
      otherOriginRequests: otherOriginRequests(requests, pageUrl).length,
      cookies: (await context.cookies()).length,
    });
  } finally {
    await session.close();
  }
}

async function readRows(): Promise<ColdStartRow[]> {
  if (!existsSync(REPORT)) return [];
  const rows: unknown = JSON.parse(await readFile(REPORT, 'utf8'));
  if (!Array.isArray(rows)) {
    throw new Error(`${REPORT} is not a list of rows. Move it aside and run again.`);
  }
  return rows as ColdStartRow[];
}

async function writeRows(measured: readonly ColdStartRow[]): Promise<void> {
  const rows = mergeRows(await readRows(), measured);
  await mkdir('bench', { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(rows, null, 2)}\n`);
}

async function run(options: ColdStartOptions, baseUrl: string): Promise<number> {
  const page = new URL(baseUrl);
  page.hash = '';
  const pageUrl = page.href;
  const measured: ColdStartRow[] = [];
  let failed = false;
  for (const engine of options.engines) {
    let failures: string[];
    if (options.expectUnsupported) {
      failures = await checkUnsupported(engine, pageUrl);
    } else {
      const result = await measureEngine(engine, pageUrl);
      failures = result.failures;
      if (result.row !== null) {
        measured.push(result.row);
        process.stdout.write(`${JSON.stringify(result.row)}\n`);
      }
    }
    for (const failure of failures) console.error(`${engine}: ${failure}`);
    if (failures.length > 0) failed = true;
    else process.stdout.write(`${engine}: ok\n`);
  }
  if (measured.length > 0) await writeRows(measured);
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.url !== undefined) {
    process.exitCode = await run(options, options.url);
    return;
  }
  if (!existsSync('dist/index.html')) await build();
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  try {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite preview has no local URL. Check the preview configuration.');
    process.exitCode = await run(options, url);
  } finally {
    await server.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
