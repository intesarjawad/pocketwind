import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from '@playwright/test';
import { PRESETS } from '../src/app/params';
import type { Tier } from '../src/app/settings';
import { TIERS } from '../src/lbm/layout';
import {
  availableValidationFactors,
  type CaseSpec,
  planCases,
  plannedSkips,
  VALIDATION_GROUPS,
  type ValidationGroup,
} from '../src/validation/cases';
import { caseHash, gridCheckHash } from '../src/validation/links';
import {
  renderValidationMarkdown,
  replaceMarkedBlock,
  validationJson,
} from '../src/validation/report';
import {
  foldCrossDevice,
  type GridCheckRow,
  type Machine,
  mergeResults,
  parseResults,
  readGridCheck,
  type SkippedCase,
  type Stamp,
  skipForCase,
  type ValidationResults,
} from '../src/validation/results';
import {
  type AdapterInfo,
  type RunContext,
  readSolverRun,
  rowFromRun,
  type ValidationRow,
} from '../src/validation/runner';
import { measureAnalyticCases, verificationRows } from '../src/validation/verification';
import { probeCapabilities } from './probe-capabilities';
import { type ValidationProgress, validationProgress } from './validate-progress';

const RESULTS_PATH = 'public/validation/results.json';
const CROSS_DEVICE_DIRECTORY = 'public/validation/cross-device';
const DOCUMENTS = ['docs/validation.md'] as const;
// A stalled case must end with a skip record instead of holding the browser open.
const CASE_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_MS = 1000;
const BROWSER_FREE_GROUPS: readonly ValidationGroup[] = ['verification', 'convergence'];

export type Options = {
  groups: ReadonlySet<ValidationGroup>;
  tiers: readonly Tier[];
  remote: string | null;
  crossDevice: boolean;
  resume: boolean;
};

const ALL_TIERS: readonly Tier[] = ['S', 'M', 'L', 'XL'];

function isGroup(value: string): value is ValidationGroup {
  return (VALIDATION_GROUPS as readonly string[]).includes(value);
}

function parseGroups(value: string): Set<ValidationGroup> {
  const groups = new Set<ValidationGroup>();
  for (const name of value.split(',').map((entry) => entry.trim())) {
    if (!isGroup(name)) {
      throw new RangeError(`Unknown group "${name}". Use ${VALIDATION_GROUPS.join(', ')}.`);
    }
    groups.add(name);
  }
  return groups;
}

function parseTiers(value: string): Tier[] {
  const tiers = value.split(',').map((entry) => entry.trim());
  for (const tier of tiers) {
    if (!Object.hasOwn(TIERS, tier)) {
      throw new RangeError(`Unknown tier "${tier}". Use S, M, L or XL.`);
    }
  }
  return tiers as Tier[];
}

function parseRemote(url: string): string {
  if (!/^https?:\/\/\S+$/.test(url)) throw new RangeError('--remote needs an http(s) URL.');
  return url.endsWith('/') ? url : `${url}/`;
}

export function parseArguments(argv: readonly string[]): Options {
  const options = {
    groups: new Set<ValidationGroup>(VALIDATION_GROUPS) as ReadonlySet<ValidationGroup>,
    tiers: ALL_TIERS,
    remote: null as string | null,
    crossDevice: false,
    resume: false,
  };
  for (const argument of argv) {
    const [name = '', ...rest] = argument.split('=');
    const value = rest.join('=');
    if (name === '--only') options.groups = parseGroups(value);
    else if (name === '--tiers') options.tiers = parseTiers(value);
    else if (name === '--remote') options.remote = parseRemote(value);
    else if (argument === '--out-cross-device') options.crossDevice = true;
    else if (argument === '--resume') options.resume = true;
    else throw new Error(`Unknown option ${argument}.`);
  }
  if (options.resume && options.remote !== null) {
    throw new Error('--resume requires a local checkout, without --remote.');
  }
  return options;
}

/** A browser is needed for every group except the Node verification and the derived convergence. */
export function needsBrowser(options: Options): boolean {
  return (
    options.crossDevice || [...options.groups].some((group) => !BROWSER_FREE_GROUPS.includes(group))
  );
}

export function adapterSlug(adapter: Machine['adapter']): string {
  const parts = [adapter.vendor, adapter.architecture, adapter.device]
    .map((part) =>
      part
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, ''),
    )
    .filter((part) => part !== '' && part !== 'unknown');
  return parts.length === 0 ? 'unknown-adapter' : parts.join('-');
}

export function sourceCommit(directory = process.cwd()): string {
  const options = { cwd: directory, encoding: 'utf8' as const };
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    options,
  );
  if (status.trim() !== '') {
    throw new Error(
      'Cannot run validation with a dirty working tree. Commit or remove changes first.',
    );
  }
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], options).trim();
}

function readIfPresent(path: string): ValidationResults | null {
  return existsSync(path) ? parseResults(readFileSync(path, 'utf8')) : null;
}

function crossDeviceDocuments(): ValidationResults[] {
  if (!existsSync(CROSS_DEVICE_DIRECTORY)) return [];
  return readdirSync(CROSS_DEVICE_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap(
      (name) => parseResults(readFileSync(join(CROSS_DEVICE_DIRECTORY, name), 'utf8')) ?? [],
    );
}

function updateDocuments(results: ValidationResults): void {
  const body = renderValidationMarkdown(results);
  for (const path of DOCUMENTS) {
    if (!existsSync(path)) continue;
    writeFileSync(path, replaceMarkedBlock(readFileSync(path, 'utf8'), body));
  }
}

type PwtWindow = { __pwt?: Record<string, unknown> };

/** Runs in the page, so it may only reach globals; the app owns the object's contents. */
function hasPwtValue(key: string): boolean {
  return (globalThis as PwtWindow).__pwt?.[key] !== undefined;
}

function readPwtValue(key: string): unknown {
  return (globalThis as PwtWindow).__pwt?.[key];
}

async function readAdapterInfo(): Promise<Omit<AdapterInfo, 'features'>> {
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null;
  return {
    vendor: adapter?.info.vendor || 'unknown',
    architecture: adapter?.info.architecture || 'unknown',
    device: adapter?.info.device || 'unknown',
    description: adapter?.info.description || 'unknown',
  };
}

async function openAndRead(
  browser: Browser,
  url: string,
  key: 'result' | 'gridCheck',
): Promise<unknown> {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.waitForFunction(hasPwtValue, key, { timeout: CASE_TIMEOUT_MS, polling: POLL_MS });
    return await page.evaluate(readPwtValue, key);
  } finally {
    await page.close();
  }
}

async function probeMachine(browser: Browser, base: string): Promise<Machine> {
  const page = await browser.newPage();
  try {
    // The results route draws no tunnel, so the probe owns adapter creation.
    await page.goto(`${base}#/validate`);
    const capabilities = await page.evaluate(probeCapabilities);
    if (capabilities.status !== 'available') {
      throw new Error(`No usable WebGPU adapter in this browser (${capabilities.status}).`);
    }
    const adapter = await page.evaluate(readAdapterInfo);
    return {
      adapter,
      features: capabilities.features,
      limits: capabilities.limits,
      userAgent: capabilities.userAgent,
    };
  } finally {
    await page.close();
  }
}

type Collected = {
  rows: ValidationRow[];
  skipped: SkippedCase[];
  gridCheck: GridCheckRow[];
};

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectCases(
  browser: Browser,
  base: string,
  specs: readonly CaseSpec[],
  context: RunContext,
  collected: Collected,
  progress: ValidationProgress,
): Promise<void> {
  for (const spec of specs) {
    const key = JSON.stringify(spec);
    const cached = progress.read(key);
    const resumed = cached === undefined ? null : readSolverRun(cached);
    let measured: ReturnType<typeof readSolverRun> | undefined;
    process.stdout.write(
      `${spec.id}: start, load ${loadavg()
        .map((value) => value.toFixed(2))
        .join('/')}\n`,
    );
    try {
      const run =
        resumed ?? readSolverRun(await openAndRead(browser, `${base}${caseHash(spec)}`, 'result'));
      const row = rowFromRun(spec, run, context);
      collected.rows.push(row);
      measured = run;
      process.stdout.write(
        `${spec.id}: Cd ${row.cd.toFixed(4)} ${row.pass ? 'pass' : `fail (${row.reasons.join('; ')})`}, ${
          resumed
            ? 'resumed'
            : `${row.msPerStep.toFixed(3)} ms/step, load ${loadavg()
                .map((value) => value.toFixed(2))
                .join('/')}`
        }\n`,
      );
    } catch (error) {
      const reason = failureReason(error);
      collected.skipped.push(skipForCase(spec, reason));
      process.stdout.write(`${spec.id}: skipped, ${reason}\n`);
    }
    if (measured !== undefined && resumed === null) progress.write(key, measured);
  }
}

async function collectGridChecks(
  browser: Browser,
  base: string,
  stamp: Stamp,
  collected: Collected,
  progress: ValidationProgress,
): Promise<void> {
  for (const preset of PRESETS) {
    const key = `grid-check:${gridCheckHash(preset.id)}`;
    const cached = progress.read(key);
    const resumed = cached === undefined ? null : readGridCheck(preset.id, cached, stamp);
    let measured: unknown;
    const startedAtMs = Date.now();
    process.stdout.write(`grid check ${preset.id}: start, load ${loadavg().join('/')}\n`);
    try {
      const value =
        resumed ?? (await openAndRead(browser, `${base}${gridCheckHash(preset.id)}`, 'gridCheck'));
      collected.gridCheck.push(resumed ?? readGridCheck(preset.id, value, stamp));
      measured = value;
      process.stdout.write(
        `grid check ${preset.id}: ${resumed ? 'resumed' : `${((Date.now() - startedAtMs) / 1000).toFixed(3)} s`}, load ${loadavg().join('/')}\n`,
      );
    } catch (error) {
      const reason = failureReason(error);
      collected.skipped.push({ case: preset.id, group: 'grid-check', reason });
      process.stdout.write(`grid check ${preset.id}: skipped, ${reason}\n`);
    }
    if (measured !== undefined && resumed === null) progress.write(key, measured);
  }
}

async function collect(
  browser: Browser,
  base: string,
  specs: readonly CaseSpec[],
  options: Options,
  context: RunContext,
  progress: ValidationProgress,
): Promise<Collected> {
  const collected: Collected = { rows: [], skipped: [], gridCheck: [] };
  await collectCases(browser, base, specs, context, collected, progress);
  if (options.groups.has('grid-check'))
    await collectGridChecks(browser, base, context, collected, progress);
  return collected;
}

async function withBrowser<T>(
  options: Options,
  use: (browser: Browser, base: string) => Promise<T>,
): Promise<T> {
  const [{ chromium }, { build, preview }] = await Promise.all([
    import('@playwright/test'),
    import('vite'),
  ]);
  let server: Awaited<ReturnType<typeof preview>> | null = null;
  let base = options.remote;
  if (base === null) {
    // A build left from older sources would measure that code instead of this checkout.
    await build();
    server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
    base = server.resolvedUrls?.local[0] ?? null;
    if (base === null) {
      await server.close();
      throw new Error('Vite preview has no local URL. Check the preview configuration.');
    }
  }
  // Headless Chromium has no WebGPU adapter on the target machine.
  const browser = await chromium.launch({ headless: false });
  try {
    return await use(browser, base);
  } finally {
    await browser.close();
    await server?.close();
  }
}

type BrowserRun = {
  machine: Machine;
  factors: ReturnType<typeof availableValidationFactors>;
  planned: CaseSpec[];
  collected: Collected;
};

function runInBrowser(options: Options, context: Omit<RunContext, 'adapter' | 'userAgent'>) {
  return withBrowser(options, async (browser, base): Promise<BrowserRun> => {
    const machine = await probeMachine(browser, base);
    const factors = availableValidationFactors(machine.features);
    const planned = planCases(options.groups, { tiers: options.tiers, factors });
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          commit: context.commit,
          numerics: execFileSync('sh', ['scripts/numerics-hash.sh'], { encoding: 'utf8' }).trim(),
          sourceDiff: execFileSync('git', ['diff', 'HEAD', '--', 'src'], { encoding: 'utf8' }),
          machine,
        }),
      )
      .digest('hex');
    const progress = validationProgress(
      '.validation-progress.local',
      key,
      options.resume,
      context.date,
    );
    const collected = await collect(
      browser,
      base,
      planned,
      options,
      {
        ...context,
        date: progress.date,
        adapter: { ...machine.adapter, features: machine.features },
        userAgent: machine.userAgent,
      },
      progress,
    );
    return { machine, factors, planned, collected };
  });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const stamp = { commit: sourceCommit(), date: new Date().toISOString() };
  const verification = options.groups.has('verification')
    ? verificationRows(measureAnalyticCases(), stamp)
    : [];

  const browserRun = needsBrowser(options) ? await runInBrowser(options, stamp) : null;
  const outputPath =
    options.crossDevice && browserRun
      ? join(CROSS_DEVICE_DIRECTORY, `${adapterSlug(browserRun.machine.adapter)}.json`)
      : RESULTS_PATH;
  const previous = readIfPresent(outputPath);
  const collected = browserRun?.collected ?? { rows: [], skipped: [], gridCheck: [] };
  const results = mergeResults(previous, {
    groups: options.groups,
    tiers: options.tiers,
    factors: browserRun?.factors ?? availableValidationFactors(previous?.machine.features ?? []),
    machine: browserRun?.machine ?? null,
    stamp,
    verification,
    rows: collected.rows,
    plannedIds: new Set((browserRun?.planned ?? []).map((spec) => spec.id)),
    gridCheck: collected.gridCheck,
    skipped: [
      ...(options.groups.has('validation') ? plannedSkips(options.tiers) : []),
      ...collected.skipped,
    ],
    crossDevice: options.crossDevice ? [] : foldCrossDevice(crossDeviceDocuments()),
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, validationJson(results));
  if (!options.crossDevice) updateDocuments(results);
  process.stdout.write(`Wrote ${outputPath} at commit ${results.commit}.\n`);

  const failed = verification.some((row) => !row.pass) || collected.rows.some((row) => !row.pass);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
