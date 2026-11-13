import { MARKS } from '../src/app/timing';

export const ENGINE_NAMES = ['chromium', 'webkit'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export type ColdStartOptions = {
  readonly url: string | undefined;
  readonly engines: readonly EngineName[];
  readonly expectUnsupported: boolean;
};

export const BUDGETS = {
  firstSmokeMs: 3000,
  dropToSmokeMs: 3000,
  dropToCdMs: 4000,
  dropToSettledMs: 75000,
  unsupportedMs: 1000,
} as const;

export type StageTimes = {
  readonly firstSmokeMs: number;
  readonly dropToSmokeMs: number;
  readonly dropToCdMs: number;
  readonly dropToSettledMs: number;
};

export type ColdStartRow = StageTimes & {
  readonly url: string;
  readonly engine: EngineName;
  readonly browserVersion: string;
  readonly requestsAfterDrop: number;
  readonly otherOriginRequests: number;
  readonly commit: string;
  readonly date: string;
};

/** Start times of every entry carrying each mark's name, as the page's timeline reports them. */
export type MarkTimes = Readonly<Record<string, readonly number[]>>;

export type RunObservation = {
  readonly stages: StageTimes;
  readonly otherOriginRequests: number;
  readonly requestsAfterDrop: number;
  readonly cookies: number;
  readonly localStorageItems: number;
  readonly indexedDbDatabases: number;
  readonly dialogs: number;
  /** Permissions the page asked for, which Playwright answers without showing a prompt. */
  readonly permissionsAsked: readonly string[];
  readonly consoleErrors: readonly string[];
};

export type UnsupportedObservation = {
  readonly renderMs: number | null;
  readonly otherOriginRequests: number;
  readonly cookies: number;
};

function urlArgument(value: string): string {
  let protocol = '';
  try {
    protocol = new URL(value).protocol;
  } catch {
    // The check below reports an unparsable address like any other.
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`--url needs an http or https address, not "${value}".`);
  }
  return value;
}

function enginesArgument(value: string): EngineName[] {
  const names = value.split(',');
  const unknown = names.find((engine) => !(ENGINE_NAMES as readonly string[]).includes(engine));
  if (unknown !== undefined) {
    throw new Error(`Unknown engine "${unknown}". Use ${ENGINE_NAMES.join(' or ')}.`);
  }
  return ENGINE_NAMES.filter((engine) => names.includes(engine));
}

export function parseArguments(argv: readonly string[]): ColdStartOptions {
  let options: ColdStartOptions = {
    url: undefined,
    engines: ENGINE_NAMES,
    expectUnsupported: false,
  };
  for (const argument of argv) {
    if (argument === '--expect-unsupported') {
      options = { ...options, expectUnsupported: true };
      continue;
    }
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) throw new Error(`Unknown option ${argument}.`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    switch (name) {
      case 'url':
        options = { ...options, url: urlArgument(value) };
        break;
      case 'engines':
        options = { ...options, engines: enginesArgument(value) };
        break;
      default:
        throw new Error(`Unknown option --${name}.`);
    }
  }
  return options;
}

/** `HeadlessChrome/139.0.1.2` and `Version/26.0 Safari/…` both name the engine release. */
export function browserVersionFromUserAgent(userAgent: string): string {
  return (
    /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(userAgent)?.[1] ??
    /Version\/([\d.]+)/.exec(userAgent)?.[1] ??
    userAgent
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The drop marks of the first file received are the first entries at or after it.
 * A page that never reached a mark is reported by name rather than as a zero.
 */
export function stageTimes(marks: MarkTimes): StageTimes {
  const first = (name: keyof typeof MARKS): number => {
    const time = marks[MARKS[name]]?.[0];
    if (time === undefined) throw new Error(`The page never emitted ${MARKS[name]}.`);
    return time;
  };
  const drop = first('drop');
  const afterDrop = (name: keyof typeof MARKS): number => {
    const time = marks[MARKS[name]]?.find((candidate) => candidate >= drop);
    if (time === undefined)
      throw new Error(`The page never emitted ${MARKS[name]} after the drop.`);
    return round(time - drop);
  };
  return {
    firstSmokeMs: round(first('firstSmoke')),
    dropToSmokeMs: afterDrop('dropSmoke'),
    dropToCdMs: afterDrop('dropCd'),
    dropToSettledMs: afterDrop('settled'),
  };
}

const NON_NETWORK_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);

/** Requests to any origin but the page's; data, blob and about URLs never leave the browser. */
export function otherOriginRequests(urls: readonly string[], pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  return urls.filter((request) => {
    const parsed = new URL(request);
    return !NON_NETWORK_PROTOCOLS.has(parsed.protocol) && parsed.origin !== origin;
  });
}

export function budgetFailures(run: RunObservation): string[] {
  const failures: string[] = [];
  const over = (label: string, value: number, budget: number): void => {
    if (value > budget) failures.push(`${label} took ${value} ms, over the ${budget} ms budget.`);
  };
  over('First smoke', run.stages.firstSmokeMs, BUDGETS.firstSmokeMs);
  over('Drop to smoke', run.stages.dropToSmokeMs, BUDGETS.dropToSmokeMs);
  over('Drop to Cd', run.stages.dropToCdMs, BUDGETS.dropToCdMs);
  over('Drop to settled', run.stages.dropToSettledMs, BUDGETS.dropToSettledMs);
  const none = (label: string, count: number): void => {
    if (count > 0) failures.push(`${label}: ${count}, expected none.`);
  };
  none('Requests to another origin', run.otherOriginRequests);
  none('Requests after the drop', run.requestsAfterDrop);
  none('Cookies', run.cookies);
  none('localStorage items', run.localStorageItems);
  none('IndexedDB databases', run.indexedDbDatabases);
  none('Dialogs', run.dialogs);
  none('Permission requests', run.permissionsAsked.length);
  for (const message of run.consoleErrors) failures.push(`Console error: ${message}`);
  return failures;
}

export function unsupportedFailures(run: UnsupportedObservation): string[] {
  const failures: string[] = [];
  if (run.renderMs === null) {
    failures.push('The unsupported page never showed both message parts.');
  } else if (run.renderMs > BUDGETS.unsupportedMs) {
    failures.push(
      `The unsupported page took ${run.renderMs} ms, over the ${BUDGETS.unsupportedMs} ms budget.`,
    );
  }
  if (run.otherOriginRequests > 0) {
    failures.push(`Requests to another origin: ${run.otherOriginRequests}, expected none.`);
  }
  if (run.cookies > 0) failures.push(`Cookies: ${run.cookies}, expected none.`);
  return failures;
}

/** Rows from engines measured now replace their older rows; other engines keep theirs. */
export function mergeRows(
  existing: readonly ColdStartRow[],
  measured: readonly ColdStartRow[],
): ColdStartRow[] {
  const replaced = new Set(measured.map((row) => row.engine));
  const kept = existing.filter((row) => !replaced.has(row.engine));
  return [...kept, ...measured].sort(
    (a, b) => ENGINE_NAMES.indexOf(a.engine) - ENGINE_NAMES.indexOf(b.engine),
  );
}
