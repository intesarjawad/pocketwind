import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { DEFAULT_SETTINGS, DEFAULT_SPEED_MPS } from '../src/app/params';
import type { Operator, Tier, Walls } from '../src/app/settings';
import { createDragStats } from '../src/forces/drag-stats';
import type { ForceHistoryPoint } from '../src/io/run-file';
import { encodeShareLink } from '../src/io/share-link';
import { TIERS } from '../src/lbm/layout';
import { flowThroughSteps } from '../src/validation/cases';

type RunProgress = {
  readonly step: number;
  readonly finite: boolean;
  readonly history: readonly ForceHistoryPoint[];
};

export type StabilityOptions = {
  readonly operators: readonly Operator[];
  readonly walls: readonly Walls[];
  readonly tier: Tier;
  readonly preset: string;
  readonly flowThroughs: number;
  readonly ramp: number;
};

export type FlowThroughStats = {
  /** Newest sample step inside the flow-through. */
  readonly step: number;
  readonly samples: number;
  readonly meanCd: number | null;
  readonly relStdPct: number | null;
};

const OPERATOR_ORDER: readonly Operator[] = ['trt', 'reg'];
const WALLS_ORDER: readonly Walls[] = ['bb', 'bouzidi'];
const DEFAULT_FLOW_THROUGHS = 8;
// A stalled run must end with a report instead of holding the browser open.
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 250;

function wholeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (value === '' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} needs a whole number, not "${value}".`);
  }
  return parsed;
}

function positiveCount(value: string, name: string): number {
  const parsed = wholeNumber(value, name);
  if (parsed === 0) throw new Error(`--${name} needs at least one, not "${value}".`);
  return parsed;
}

function operatorArgument(value: string): Operator {
  const operator = OPERATOR_ORDER.find((candidate) => candidate === value);
  if (operator === undefined) throw new Error(`Unknown operator "${value}". Use trt or reg.`);
  return operator;
}

function wallsArgument(value: string): Walls {
  const walls = WALLS_ORDER.find((candidate) => candidate === value);
  if (walls === undefined) throw new Error(`Unknown wall mode "${value}". Use bb or bouzidi.`);
  return walls;
}

/** Every operator and wall mode runs one after the other unless a single one is chosen. */
export function parseArguments(argv: readonly string[]): StabilityOptions {
  let options: StabilityOptions = {
    operators: OPERATOR_ORDER,
    walls: WALLS_ORDER,
    tier: 'S',
    preset: DEFAULT_SETTINGS.presetId,
    flowThroughs: DEFAULT_FLOW_THROUGHS,
    ramp: 0,
  };
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) {
      throw new Error(`Unknown option ${argument}.`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    switch (name) {
      case 'operator':
        options = { ...options, operators: [operatorArgument(value)] };
        break;
      case 'walls':
        options = { ...options, walls: [wallsArgument(value)] };
        break;
      case 'tier':
        if (!Object.hasOwn(TIERS, value)) {
          throw new Error(`Unknown tier "${value}". Use S, M, L or XL.`);
        }
        options = { ...options, tier: value as Tier };
        break;
      case 'preset':
        if (value === '') throw new Error('--preset needs a preset id.');
        options = { ...options, preset: value };
        break;
      case 'flowthroughs':
        options = { ...options, flowThroughs: positiveCount(value, name) };
        break;
      case 'ramp':
        options = { ...options, ramp: wholeNumber(value, name) };
        break;
      default:
        throw new Error(`Unknown option --${name}.`);
    }
  }
  return options;
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample standard deviation as a percentage of the mean, or null below two samples. */
function relativeStdPct(values: readonly number[]): number | null {
  const mean = meanOf(values);
  if (mean === null || values.length < 2) return null;
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  const std = Math.sqrt(squares / (values.length - 1));
  if (mean === 0) return std === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (100 * std) / Math.abs(mean);
}

/**
 * Samples are binned by step rather than arrival order, so a late poll reports
 * the same flow-through boundaries the run stepped through.
 */
export function flowThroughStats(
  history: readonly ForceHistoryPoint[],
  flowThrough: number,
  stepsPerFlowThrough: number,
): FlowThroughStats {
  if (!Number.isSafeInteger(stepsPerFlowThrough) || stepsPerFlowThrough <= 0) {
    throw new RangeError('Flow-through length must be a positive whole number of steps.');
  }
  const values: number[] = [];
  let step = 0;
  for (const [sampleStep, cd] of history) {
    if (Math.floor(sampleStep / stepsPerFlowThrough) !== flowThrough) continue;
    values.push(cd);
    step = Math.max(step, sampleStep);
  }
  return {
    step,
    samples: values.length,
    meanCd: meanOf(values),
    relStdPct: relativeStdPct(values),
  };
}

export type TimeToSteady = {
  readonly step: number;
  readonly flowThroughs: number;
};

/**
 * Replays the history through the app's own settling rule and returns the
 * first sample after which every later sample still reads steady; null when
 * the run ends unsteady or still settling.
 */
export function timeToSteady(
  history: readonly ForceHistoryPoint[],
  stepsPerFlowThrough: number,
): TimeToSteady | null {
  const stats = createDragStats(stepsPerFlowThrough);
  let since: number | null = null;
  for (const [step, cd] of history) {
    stats.push(step, cd);
    if (stats.summary(null).status.kind === 'steady') since ??= step;
    else since = null;
  }
  if (since === null) return null;
  return { step: since, flowThroughs: since / stepsPerFlowThrough };
}

export function formatSteadyLine(
  operator: Operator,
  walls: Walls,
  result: TimeToSteady | null,
): string {
  const settled =
    result === null
      ? ['steady=no']
      : [
          'steady=yes',
          `steadyStep=${result.step}`,
          `steadyFlowThroughs=${result.flowThroughs.toFixed(2)}`,
        ];
  return [`operator=${operator}`, `walls=${walls}`, ...settled].join(' ');
}

export function formatFlowThroughLine(
  operator: Operator,
  walls: Walls,
  flowThrough: number,
  stats: FlowThroughStats,
  finite: boolean,
): string {
  const meanCd = stats.meanCd === null ? 'n/a' : stats.meanCd.toFixed(4);
  const relStdPct = stats.relStdPct === null ? 'n/a' : stats.relStdPct.toFixed(2);
  return [
    `operator=${operator}`,
    `walls=${walls}`,
    `flow-through=${flowThrough}`,
    `step=${stats.step}`,
    `finite=${finite ? 'yes' : 'no'}`,
    `meanCd=${meanCd}`,
    `relStdPct=${relStdPct}`,
  ].join(' ');
}

/** Runs in the page, so it may only reach globals; the app owns the object's contents. */
function readProgress(): RunProgress | null {
  return (globalThis as { __pocketwindRun?: RunProgress }).__pocketwindRun ?? null;
}

async function measureOperator(
  page: Page,
  options: StabilityOptions,
  operator: Operator,
  walls: Walls,
  url: string,
): Promise<number> {
  const settings = {
    ...DEFAULT_SETTINGS,
    presetId: options.preset,
    tier: options.tier,
    operator,
    walls,
    speedMps: DEFAULT_SPEED_MPS,
  };
  await page.goto(`${url}${encodeShareLink(settings)}&ramp=${options.ramp}`);
  const stepsPerFlowThrough = flowThroughSteps(TIERS[options.tier].nx);
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let printed = 0;
  let history: readonly ForceHistoryPoint[] = [];
  while (printed < options.flowThroughs) {
    if (Date.now() > deadline) {
      process.stdout.write(
        `operator=${operator} walls=${walls}: no run progress within the time limit.\n`,
      );
      return 1;
    }
    const progress = await page.evaluate(readProgress);
    if (progress === null) {
      await page.waitForTimeout(POLL_MS);
      continue;
    }
    if (!progress.finite) {
      process.stdout.write(
        `operator=${operator} walls=${walls} step=${progress.step} finite=no: the run stopped being finite.\n`,
      );
      return 1;
    }
    history = progress.history;
    const completed = Math.floor(progress.step / stepsPerFlowThrough);
    while (printed < completed && printed < options.flowThroughs) {
      const stats = flowThroughStats(progress.history, printed, stepsPerFlowThrough);
      process.stdout.write(`${formatFlowThroughLine(operator, walls, printed + 1, stats, true)}\n`);
      printed += 1;
    }
    if (printed < options.flowThroughs) await page.waitForTimeout(POLL_MS);
  }
  const runSteps = options.flowThroughs * stepsPerFlowThrough;
  const measured = history.filter(([step]) => step < runSteps);
  process.stdout.write(
    `${formatSteadyLine(operator, walls, timeToSteady(measured, stepsPerFlowThrough))}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const [{ chromium }, { build, preview }] = await Promise.all([
    import('@playwright/test'),
    import('vite'),
  ]);
  if (!existsSync('dist/index.html')) await build();
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  const browser = await chromium.launch({ headless: false });
  let status = 0;
  try {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite preview has no local URL. Check the preview configuration.');
    const page = await browser.newPage();
    for (const operator of options.operators) {
      for (const walls of options.walls) {
        status = await measureOperator(page, options, operator, walls, url);
        if (status !== 0) break;
      }
      if (status !== 0) break;
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exitCode = status;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
