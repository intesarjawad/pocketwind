import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';
import { build, preview } from 'vite';
import {
  type BenchRow,
  budgetFailures,
  mergeRows,
  readBenchReport,
  readBenchRows,
} from './bench-report';
import { browserVersionFromUserAgent, ENGINE_NAMES } from './cold-start-report';

const REPORT = 'bench/results.json';
// Three tiers at 500 steps each, plus device and pipeline creation.
const BENCH_TIMEOUT_MS = 300_000;

function sourceCommit(): string {
  return execFileSync('sh', ['scripts/source-commit.sh'], { encoding: 'utf8' }).trim();
}

function benchFinished(): boolean {
  return '__pwt' in window || document.querySelector('[role="alert"]') !== null;
}

function readPage(): { report: unknown; alert: string | null } {
  return {
    report: Reflect.get(window, '__pwt'),
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

async function measure(engine: (typeof ENGINE_NAMES)[number], pageUrl: string): Promise<BenchRow> {
  const launcher = engine === 'chromium' ? chromium : webkit;
  // WebGPU needs a real GPU, which headless launches do not always get.
  const browser = await launcher.launch({ headless: false });
  try {
    const page = await browser.newPage();
    await page.goto(`${pageUrl}#/bench`);
    await page.waitForFunction(benchFinished, undefined, { timeout: BENCH_TIMEOUT_MS });
    const { report, alert } = await page.evaluate(readPage);
    if (alert !== null) throw new Error(alert);
    const checked = readBenchReport(report);
    return {
      engine,
      browserVersion: browserVersionFromUserAgent(checked.userAgent),
      commit: sourceCommit(),
      date: new Date().toISOString(),
      report: checked,
    };
  } finally {
    await browser.close();
  }
}

async function readRows(): Promise<BenchRow[]> {
  if (!existsSync(REPORT)) return [];
  return readBenchRows(JSON.parse(await readFile(REPORT, 'utf8')), REPORT);
}

async function run(pageUrl: string): Promise<number> {
  const measured: BenchRow[] = [];
  let failed = false;
  for (const engine of ENGINE_NAMES) {
    let failures: string[];
    try {
      const row = await measure(engine, pageUrl);
      measured.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
      failures = budgetFailures(row.report);
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)];
    }
    for (const failure of failures) console.error(`${engine}: ${failure}`);
    if (failures.length > 0) failed = true;
    else process.stdout.write(`${engine}: ok\n`);
  }
  if (measured.length > 0) {
    await mkdir('bench', { recursive: true });
    const rows = mergeRows(await readRows(), measured);
    await writeFile(REPORT, `${JSON.stringify(rows, null, 2)}\n`);
  }
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) await build();
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  try {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite preview has no local URL. Check the preview configuration.');
    process.exitCode = await run(url);
  } finally {
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
