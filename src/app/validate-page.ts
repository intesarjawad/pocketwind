import type { GridConvergence } from '../forces/convergence';
import { NU_AIR } from '../lbm/units';
import {
  AHMED_25_REFERENCE_CD,
  AHMED_25_REFERENCE_RE,
  AHMED_BODY_LENGTH_MM,
  AHMED_VALIDATION_SPEED_MPS,
  PASS_TOLERANCE_PCT,
} from '../validation/cases';
import type { GridCheckRow } from '../validation/results';
import type { ValidationRow } from '../validation/runner';
import type { VerificationRow } from '../validation/verification';
import { niceTicks } from './force-plot';
import { REPOSITORY_URL } from './panel';
import { formatRe } from './plate-caption';
import { ROUTE_TITLES, readRoute, routeHash } from './routes';
import { type ValidationRowView, validationRows } from './validation-view';

type CaseRow = Pick<
  ValidationRow,
  | 'case'
  | 'group'
  | 'tier'
  | 'cd'
  | 'errorPct'
  | 'pass'
  | 'shapeClass'
  | 'isDefault'
  | 'referenceCd'
> &
  // Older and hand-written results files can leave these out.
  Partial<
    Pick<
      ValidationRow,
      | 'id'
      | 're'
      | 'bodyLengthCells'
      | 'cellSizeM'
      | 'blockage'
      | 'baselineBlockage'
      | 'sensitivity'
      | 'walls'
      | 'operator'
      | 'storage'
      | 'stilts'
      | 'uLu'
    >
  >;
export type GridCheckEntry = { shapeClass: string; case: string; outcome: string };
export type CrossDeviceEntry = {
  adapter: string;
  case: string;
  cd: number;
  commit: string;
  date: string;
};

export type ResultsFile = {
  date: string;
  commit: string;
  cases: readonly CaseRow[];
  verification: readonly VerificationRow[];
  convergence: GridConvergence | null;
  /** Why the results generator could not estimate convergence, when it says. */
  convergenceSkipped?: string;
  gridCheck: readonly GridCheckEntry[] | null;
  crossDevice: readonly CrossDeviceEntry[] | null;
};

const SECTIONS_WITH_CASES = ['laminar', 'validation', 'confinement', 'sensitivity'] as const;
// The shape class a preset's drag belongs to, which is what the trust table is keyed by.
const PRESET_SHAPE_CLASS: Readonly<Record<string, string>> = {
  'ahmed-25': 'road-vehicle',
  'ahmed-35': 'road-vehicle',
  'ahmed-25-roof-box': 'road-vehicle',
  cube: 'sharp-edged',
  sphere: 'smooth-subcritical',
};

export type TrustRow = { shapeClass: string; error: string; note: string; gridCheck: string };

export const NOT_YET_RUN = 'Not yet run.';
const GRID_CHECK_PENDING = 'no fixed-Reynolds-number refinement check has been recorded.';
const TRUST_TIER = 'L';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCaseRow(value: unknown): value is CaseRow {
  return (
    isRecord(value) &&
    typeof value.case === 'string' &&
    typeof value.group === 'string' &&
    typeof value.tier === 'string' &&
    typeof value.shapeClass === 'string' &&
    typeof value.cd === 'number' &&
    typeof value.pass === 'boolean' &&
    typeof value.isDefault === 'boolean' &&
    (value.errorPct === null || typeof value.errorPct === 'number') &&
    (value.referenceCd === null || typeof value.referenceCd === 'number')
  );
}

function isGridCheckRow(value: unknown): value is GridCheckRow {
  return (
    isRecord(value) &&
    typeof value.case === 'string' &&
    (value.kind === 'band' || value.kind === 'no-band')
  );
}

function gridCheckEntry(row: GridCheckRow): GridCheckEntry {
  const outcome =
    row.kind === 'band'
      ? `GCI ${(row.gciPct ?? Number.NaN).toFixed(1)}%, extrapolated Cd ${(row.extrapolatedCd ?? Number.NaN).toFixed(4)}`
      : `No band: ${row.reason ?? 'no reason given'}`;
  return { shapeClass: PRESET_SHAPE_CLASS[row.case] ?? row.case, case: row.case, outcome };
}

function crossDeviceEntry(value: unknown): CrossDeviceEntry | null {
  if (
    !isRecord(value) ||
    !isRecord(value.adapter) ||
    typeof value.adapter.vendor !== 'string' ||
    typeof value.adapter.architecture !== 'string' ||
    typeof value.case !== 'string' ||
    typeof value.cd !== 'number' ||
    typeof value.commit !== 'string' ||
    typeof value.date !== 'string'
  ) {
    return null;
  }
  return {
    adapter: `${value.adapter.vendor} ${value.adapter.architecture}`,
    case: value.case,
    cd: value.cd,
    commit: value.commit,
    date: value.date,
  };
}

function isVerificationRow(value: unknown): value is VerificationRow {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.steps === 'number' &&
    (value.error === null || typeof value.error === 'number') &&
    (value.errorPct === null || typeof value.errorPct === 'number')
  );
}

function isConvergence(value: unknown): value is GridConvergence {
  return isRecord(value) && typeof value.kind === 'string';
}

function rowsIn(data: Record<string, unknown>, name: string): unknown[] {
  const value = data[name];
  return Array.isArray(value) ? value : [];
}

/** Read `results.json`; a section that is missing or malformed is treated as not yet run. */
export function readResults(data: unknown): ResultsFile | null {
  if (!isRecord(data) || typeof data.date !== 'string' || typeof data.commit !== 'string') {
    return null;
  }
  const gridCheck = rowsIn(data, 'gridCheck').filter(isGridCheckRow).map(gridCheckEntry);
  const convergence = rowsIn(data, 'convergence').find(
    (row) => isRecord(row) && row.case === 'ahmed-25',
  );
  const skipped = rowsIn(data, 'skipped').find(
    (row) => isRecord(row) && row.case === 'ahmed-25' && row.group === 'convergence',
  );
  return {
    date: data.date,
    commit: data.commit,
    cases: SECTIONS_WITH_CASES.flatMap((name) => rowsIn(data, name).filter(isCaseRow)),
    verification: rowsIn(data, 'verification').filter(isVerificationRow),
    convergence: isConvergence(convergence) ? convergence : null,
    ...(isRecord(skipped) && typeof skipped.reason === 'string'
      ? { convergenceSkipped: skipped.reason }
      : {}),
    gridCheck,
    crossDevice: rowsIn(data, 'crossDevice').flatMap((row) => crossDeviceEntry(row) ?? []),
  };
}

function signedPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * One row per shape class that has a default-operator row. The error is the tier-L
 * row's, preferring one that has a reference value; the grid check comes from its own section.
 */
export function trustRows(
  cases: readonly CaseRow[],
  gridCheck: readonly GridCheckEntry[] | null,
): TrustRow[] {
  const defaults = cases.filter((row) => row.isDefault);
  const classes = [...new Set(defaults.map((row) => row.shapeClass))];
  return classes.map((shapeClass) => {
    const trusted = defaults.filter(
      (row) => row.shapeClass === shapeClass && row.tier === TRUST_TIER,
    );
    const row = trusted.find((candidate) => candidate.errorPct !== null) ?? trusted[0];
    // A class measured only on other grids says so, rather than reading as never run.
    const other = defaults.find(
      (candidate) => candidate.shapeClass === shapeClass && candidate.errorPct !== null,
    );
    const measuredElsewhere = row === undefined && other?.errorPct != null;
    const error =
      row === undefined
        ? measuredElsewhere
          ? 'Not run'
          : NOT_YET_RUN
        : row.errorPct === null
          ? 'No reference value'
          : signedPercent(row.errorPct);
    const others = defaults.filter(
      (candidate) =>
        candidate.shapeClass === shapeClass &&
        candidate.tier !== TRUST_TIER &&
        candidate.errorPct !== null,
    );
    const note =
      others.length === 0
        ? 'n/a'
        : others
            .map((entry) => `Tier ${entry.tier}: ${signedPercent(entry.errorPct ?? 0)}`)
            .join(', ');
    const check = gridCheck?.find((entry) => entry.shapeClass === shapeClass);
    return { shapeClass, error, note, gridCheck: check?.outcome ?? NOT_YET_RUN };
  });
}

/** The band a row must fall in to pass, from the reference value the rows carry. */
export function referenceBand(rows: readonly CaseRow[]): string {
  const references = [...new Set(rows.flatMap((row) => row.referenceCd ?? []))];
  if (references.length === 0) return 'No reference value; these rows record raw drag only.';
  const spread = PASS_TOLERANCE_PCT / 100;
  return references
    .map(
      (cd) =>
        `Reference Cd ${cd.toFixed(3)}. A row whose drag falls within ±${PASS_TOLERANCE_PCT}% (${(cd * (1 - spread)).toFixed(4)} to ${(cd * (1 + spread)).toFixed(4)}) passes.`,
    )
    .join(' ');
}

export function convergenceText(convergence: GridConvergence | null): string {
  if (convergence === null) return NOT_YET_RUN;
  if (convergence.kind !== 'monotone') return `Not estimated: ${convergence.kind}.`;
  return `Monotone, observed order ${convergence.order.toFixed(3)}, extrapolated Cd ${convergence.extrapolated.toFixed(4)}, fine-grid GCI ${convergence.gciFinePct.toFixed(2)}%.`;
}

/** A signed value with a true minus sign, and a plus where the sign carries meaning. */
export function signed(value: number, digits: number, unit = ''): string {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return `${text}${unit}`;
  return `${value < 0 ? '\u2212' : '+'}${text}${unit}`;
}

/** Taylor-Green rows: the amplitude error against the analytic field, relative, in percent. */
export function taylorGreenRows(rows: readonly VerificationRow[]): string[][] {
  return rows
    .filter((row) => row.kind === 'taylor-green' && row.error !== null)
    .map((row) => [row.label, String(row.steps), `${(100 * (row.error ?? 0)).toPrecision(3)}%`]);
}

/** Poiseuille rows: the channel's peak speed against the parabola, signed, in percent. */
export function poiseuilleRows(rows: readonly VerificationRow[]): string[][] {
  return rows
    .filter((row) => row.kind !== 'taylor-green' && row.errorPct !== null)
    .map((row) => [row.label, String(row.steps), signed(row.errorPct ?? 0, 2, '%')]);
}

/**
 * The order of accuracy the Taylor-Green errors show, worked out here from the saved
 * errors: each halving of the grid spacing divides the error by 2 to the order.
 */
export function taylorGreenOrder(rows: readonly VerificationRow[]): string | null {
  const errors = rows
    .filter((row) => row.kind === 'taylor-green' && row.error !== null && row.error > 0)
    .map((row) => row.error ?? 0)
    .sort((a, b) => b - a);
  const ratios = errors.slice(1).map((fine, index) => (errors[index] ?? fine) / fine);
  if (ratios.length === 0) return null;
  const orders = ratios.map((ratio) => Math.log2(ratio));
  const list = (values: number[], digits: number) =>
    values.map((value) => value.toFixed(digits)).join(' and then ');
  const second = orders.every((order) => Math.abs(order - 2) < 0.1);
  return `Each halving of the grid spacing divides the amplitude error by ${list(ratios, 2)}: an observed order of ${list(orders, 2)}, ${second ? 'which is the second-order accuracy the scheme is built for' : 'short of the second order the scheme is built for'}.`;
}

/** Why the BGK row's large error is the expected outcome, in the row's own numbers. */
export function bgkNote(rows: readonly VerificationRow[]): string | null {
  const row = rows.find((candidate) => candidate.kind === 'poiseuille-bgk');
  if (row === undefined || row.errorPct === null || row.tau0 === null) return null;
  const cause =
    'This row shows the check can see a known error: plain BGK collision puts the bounce-back wall at a distance that changes with viscosity,';
  const offset = `${row.errorPct.toFixed(1)}% off the parabola`;
  return row.pass
    ? `${cause} and at tau0 ${row.tau0} the channel's peak speed duly comes out ${offset}, the error the TRT rows remove.`
    : `${cause} but at tau0 ${row.tau0} the channel's peak speed comes out only ${offset}, so this check is failing.`;
}

const SVG = 'http://www.w3.org/2000/svg';
const FIGURE = { width: 520, height: 264, left: 40, right: 12, top: 38, bottom: 70 };
// In the figure's own units, so the type scales with the drawing.
const FIGURE_TYPE = 10;

function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function cellMm(row: CaseRow): string {
  return ((row.cellSizeM ?? Number.NaN) * 1000).toFixed(1);
}

/** The figure's caption, every number taken from the rows it draws. */
export function ahmedCaption(rows: readonly CaseRow[]): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return '';
  const res = [...new Set(rows.flatMap((row) => row.re ?? []))];
  const at = res.length === 1 ? ` at Re ${formatRe(res[0] ?? 0)} on body length` : '';
  const sized = rows.every((row) => row.cellSizeM !== undefined);
  const trend =
    rows.length > 1 && sized
      ? ` Drag falls from ${first.cd.toFixed(3)} to ${last.cd.toFixed(3)} as the cells shrink from ${cellMm(first)} to ${cellMm(last)} mm, and the finest grid still reads ${(last.cd / AHMED_25_REFERENCE_CD).toFixed(1)} times the measurement.`
      : '';
  return `Ahmed body, 25° slant${at}: drag coefficient by grid, against the ${AHMED_25_REFERENCE_CD} Ahmed and colleagues measured at Re ${formatRe(AHMED_25_REFERENCE_RE)} and its ${PASS_TOLERANCE_PCT}% pass band.${trend}`;
}

/**
 * The Ahmed rows drawn against the measured value: one mark per grid, the pass band
 * around the measurement, and a caption whose every number comes from the rows.
 */
export function ahmedFigure(cases: readonly CaseRow[]): HTMLElement | null {
  const rows = cases
    .filter((row) => row.group === 'validation' && row.case === 'ahmed-25' && row.isDefault)
    .sort((a, b) => (a.bodyLengthCells ?? 0) - (b.bodyLengthCells ?? 0));
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return null;
  const { width, height, left, right, top, bottom } = FIGURE;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const ceiling = Math.ceil(Math.max(...rows.map((row) => row.cd), AHMED_25_REFERENCE_CD) * 5) / 5;
  const y = (cd: number) => top + plotHeight * (1 - cd / ceiling);
  const spread = PASS_TOLERANCE_PCT / 100;

  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-labelledby': 'ahmed-figure-caption',
    'font-size': FIGURE_TYPE,
  });
  chart.append(
    svg('rect', {
      class: 'figure-band',
      x: left,
      width: plotWidth,
      y: y(AHMED_25_REFERENCE_CD * (1 + spread)),
      height: y(AHMED_25_REFERENCE_CD * (1 - spread)) - y(AHMED_25_REFERENCE_CD * (1 + spread)),
    }),
    svg('line', {
      class: 'figure-reference',
      x1: left,
      x2: left + plotWidth,
      y1: y(AHMED_25_REFERENCE_CD),
      y2: y(AHMED_25_REFERENCE_CD),
    }),
    svg(
      'text',
      {
        x: left + plotWidth - 8,
        y: y(AHMED_25_REFERENCE_CD * (1 + spread)) - 8,
        'text-anchor': 'end',
      },
      `${AHMED_25_REFERENCE_CD} measured at Re ${formatRe(AHMED_25_REFERENCE_RE)}`,
    ),
    svg('line', { class: 'figure-axis', x1: left, x2: left, y1: top, y2: top + plotHeight }),
    svg('text', { x: left, y: top - 16, 'text-anchor': 'middle', class: 'figure-symbol' }, 'Cd'),
  );
  for (const tick of niceTicks(0, ceiling)) {
    chart.append(svg('text', { x: left - 10, y: y(tick) + 4, 'text-anchor': 'end' }, String(tick)));
  }
  rows.forEach((row, index) => {
    // The stems leave the right of the plot to the measurement's label.
    const x = left + (plotWidth * (index + 1)) / (rows.length + 1.6);
    const cells = row.bodyLengthCells === undefined ? '' : `${row.bodyLengthCells} cells long`;
    const size = row.cellSizeM === undefined ? '' : `${cellMm(row)} mm cells`;
    chart.append(
      svg('line', { class: 'figure-stem', x1: x, x2: x, y1: y(row.cd), y2: y(0) }),
      svg('circle', { class: 'figure-mark', cx: x, cy: y(row.cd), r: 5 }),
      svg('text', { x, y: y(row.cd) - 14, 'text-anchor': 'middle' }, row.cd.toFixed(3)),
      svg('text', { x, y: y(0) + 22, 'text-anchor': 'middle' }, `Tier ${row.tier}`),
      svg('text', { x, y: y(0) + 38, 'text-anchor': 'middle' }, cells),
      svg('text', { x, y: y(0) + 54, 'text-anchor': 'middle', class: 'figure-quiet' }, size),
    );
  });

  const figure = document.createElement('figure');
  figure.className = 'validate-figure';
  const caption = document.createElement('figcaption');
  caption.id = 'ahmed-figure-caption';
  const record = document.createElement('a');
  record.href = `${REPOSITORY_URL}/blob/main/docs/adr/013-high-reynolds-walls.md`;
  record.textContent = 'decision record 013';
  caption.append(ahmedCaption(rows), ' The ', record, ' traces where the excess acts.');
  const chartScroll = document.createElement('div');
  chartScroll.className = 'validate-chart-scroll';
  chartScroll.tabIndex = 0;
  chartScroll.setAttribute('role', 'region');
  chartScroll.setAttribute('aria-label', 'Drag coefficient by grid chart');
  chartScroll.append(chart);
  figure.append(chartScroll, caption);
  return figure;
}

const NUMBER = /^[+\u2212-]?\d[\d.,]*%?$/;

function table(caption: string, headers: readonly string[], rows: readonly string[][]) {
  const element = document.createElement('table');
  // The section heading already names the table; the caption stays for assistive technology.
  const title = document.createElement('caption');
  title.className = 'visually-hidden';
  title.textContent = caption;
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  // A column of figures is set right-aligned in lining, tabular figures.
  const numeric = headers.map(
    (_, column) =>
      rows.length > 0 &&
      rows.every((values) => NUMBER.test(values[column] ?? '') || values[column] === 'n/a'),
  );
  for (const [column, label] of headers.entries()) {
    const header = document.createElement('th');
    if (numeric[column]) header.className = 'figure-cell';
    header.scope = 'col';
    header.textContent = label;
    headRow.append(header);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const tr = document.createElement('tr');
    for (const [column, value] of values.entries()) {
      const cell = document.createElement('td');
      if (numeric[column]) cell.className = 'figure-cell';
      cell.textContent = NUMBER.test(value) ? value.replace(/^-/, '\u2212') : value;
      tr.append(cell);
    }
    body.append(tr);
  }
  element.append(title, head, body);
  return element;
}

function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.textContent = text;
  return element;
}

function section(id: string, heading: string, ...content: HTMLElement[]): HTMLElement {
  const element = document.createElement('section');
  element.setAttribute('aria-labelledby', id);
  const title = document.createElement('h2');
  title.id = id;
  title.textContent = heading;
  element.append(title, ...content);
  return element;
}

const OPERATOR_NAMES: Record<string, string> = { reg: 'Regularized', trt: 'TRT', bgk: 'BGK' };

/** A row's name for a reader, from what the row varies rather than its file id. */
export function runLabel(row: CaseRow): string {
  switch (row.sensitivity) {
    case 'domain':
      return row.blockage == null
        ? 'Larger domain'
        : `Larger domain, ${(row.blockage * 100).toFixed(1)}% blockage`;
    case 'body-length':
      return `Shorter body, ${Math.round(row.bodyLengthCells ?? 0)} cells long`;
    case 'inlet-speed':
      return `Faster lattice inlet, ${row.uLu} cells per step`;
    case 'stilts':
      return row.stilts ? 'Stilts in the drag' : 'Stilts left out of the drag';
  }
  const operator = OPERATOR_NAMES[row.operator ?? ''] ?? row.id ?? row.case;
  return row.storage === 'f16' ? `${operator}, 16-bit storage` : operator;
}

function caseSection(id: string, heading: string, rows: readonly CaseRow[]): HTMLElement {
  const views: readonly ValidationRowView[] = rows;
  return section(
    id,
    heading,
    paragraph(referenceBand(rows)),
    table(
      heading,
      ['Run', 'Tier', 'Cd', 'Cd error', `Within ${PASS_TOLERANCE_PCT}%`],
      validationRows(views).map((row, index) => [
        rows[index] === undefined ? row.case : runLabel(rows[index]),
        row.tier,
        row.cd,
        row.error,
        rows[index]?.pass ? 'yes' : 'no',
      ]),
    ),
  );
}

/** Each sensitivity row as a change from the default row it varies; there is nothing to pass. */
export function sensitivityRows(cases: readonly CaseRow[]): string[][] {
  return cases
    .filter((row) => row.group === 'sensitivity')
    .map((row) => {
      const base = cases.find(
        (candidate) =>
          candidate.group === 'validation' &&
          candidate.isDefault &&
          candidate.case === row.case &&
          candidate.tier === row.tier &&
          candidate.operator === row.operator &&
          candidate.walls === row.walls &&
          candidate.storage === row.storage,
      );
      return [
        `${runLabel(row)}${row.cd === base?.cd ? ' (default)' : ''}`,
        row.tier,
        row.cd.toFixed(4),
        base === undefined ? 'n/a' : signed((row.cd / base.cd - 1) * 100, 2, '%'),
      ];
    });
}

/** What the domain-size row says about confinement, in its own numbers. */
export function blockageNote(cases: readonly CaseRow[]): string | null {
  const wide = cases.find((row) => row.sensitivity === 'domain');
  const base = cases.find(
    (row) =>
      row.group === 'validation' &&
      row.isDefault &&
      row.case === wide?.case &&
      row.bodyLengthCells === wide?.bodyLengthCells,
  );
  if (wide?.blockage == null || base?.blockage == null) return null;
  const change = (1 - wide.cd / base.cd) * 100;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return `Blockage matters here. The same ${base.bodyLengthCells}-cell body in a larger domain, filling ${pct(wide.blockage)} of the section instead of ${pct(base.blockage)}, reads ${wide.cd.toFixed(3)} against ${base.cd.toFixed(3)}: ${change.toFixed(0)}% lower. The confinement of these grids and their near inlet add about that much drag.`;
}

const RUN_NOTE = `These are offline runs at Re ${formatRe((AHMED_VALIDATION_SPEED_MPS * AHMED_BODY_LENGTH_MM) / 1000 / NU_AIR)}, full scale at ${AHMED_VALIDATION_SPEED_MPS} m/s (the measurement ran at ${formatRe(AHMED_25_REFERENCE_RE)}), with the regularized collision and a wall model. The plate on the tunnel page is a different, live run on the smallest grid, held at a far lower Reynolds number by the viscosity floor, so its drag is higher still.`;

/** A results date as a reader would write it, in UTC so every reader sees the same one. */
export function humanDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const time = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${time} UTC`;
}

function trustSection(results: ResultsFile | null): HTMLElement {
  const rows = results === null ? [] : trustRows(results.cases, results.gridCheck);
  const heading = 'Where to trust it';
  if (rows.length === 0) return section('trust', heading, paragraph(NOT_YET_RUN));
  return section(
    'trust',
    heading,
    table(
      heading,
      ['Shape class', `Tier ${TRUST_TIER} error`, 'Other tiers', 'Grid check'],
      rows.map((row) => [row.shapeClass, row.error, row.note, row.gridCheck]),
    ),
  );
}

function element(tag: string, className: string, ...content: (HTMLElement | null)[]) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...content.flatMap((child) => child ?? []));
  return node;
}

function tunnelLink(): HTMLAnchorElement {
  const tunnel = document.createElement('a');
  tunnel.href = routeHash('', readRoute().settings);
  tunnel.textContent = 'Open the tunnel';
  return tunnel;
}

function verificationSection(rows: readonly VerificationRow[]): HTMLElement {
  const bgk = bgkNote(rows);
  const order = taylorGreenOrder(rows);
  return section(
    'verification',
    'Verification',
    paragraph('Reference: analytic Taylor-Green and Poiseuille solutions.'),
    table('Taylor-Green', ['Case', 'Steps', 'Amplitude error'], taylorGreenRows(rows)),
    ...(order === null ? [] : [paragraph(order)]),
    table('Poiseuille', ['Case', 'Steps', 'Peak speed error'], poiseuilleRows(rows)),
    ...(bgk === null ? [] : [paragraph(bgk)]),
  );
}

/** A section for each saved group, and one line for each group that has not been run. */
function resultSections(results: ResultsFile): { sections: HTMLElement[]; pending: string[] } {
  const { cases } = results;
  const pending: string[] = [];
  const sections: HTMLElement[] = [];
  const rowsIn = (group: string) => cases.filter((row) => row.group === group);

  if (results.verification.length === 0) pending.push('Verification: no analytic cases are saved.');
  else sections.push(verificationSection(results.verification));
  for (const [id, heading] of [
    ['laminar', 'Laminar'],
    ['validation', 'Validation'],
  ] as const) {
    const rows = rowsIn(id);
    if (rows.length === 0) pending.push(`${heading}: no rows are saved.`);
    else sections.push(caseSection(id, heading, rows));
  }
  if (rowsIn('sensitivity').length > 0) {
    sections.push(
      section(
        'sensitivity',
        'Sensitivity',
        paragraph(
          `Each row changes one thing about the tier ${TRUST_TIER} default and shows how far its drag moves. There is no reference to pass against.`,
        ),
        table('Sensitivity', ['Run', 'Tier', 'Cd', 'Change'], sensitivityRows(cases)),
      ),
    );
  }
  if (results.convergence === null) {
    pending.push(`Convergence: ${results.convergenceSkipped ?? 'no estimate is saved.'}`);
  } else {
    sections.push(
      section('convergence', 'Convergence', paragraph(convergenceText(results.convergence))),
    );
  }
  if (!results.gridCheck?.length) {
    pending.push(`Grid check: ${GRID_CHECK_PENDING}`);
  } else {
    sections.push(
      section(
        'grid-check',
        'Grid check',
        table(
          'Grid check',
          ['Preset', 'Shape class', 'Outcome'],
          results.gridCheck.map((entry) => [entry.case, entry.shapeClass, entry.outcome]),
        ),
      ),
    );
  }
  if (!results.crossDevice?.length) {
    pending.push('Cross-device: no other adapter has saved results yet.');
  } else {
    sections.push(
      section(
        'cross-device',
        'Cross-device',
        table(
          'Cross-device',
          ['Adapter', 'Case', 'Cd', 'Commit', 'Date'],
          results.crossDevice.map((entry) => [
            entry.adapter,
            entry.case,
            entry.cd.toFixed(4),
            entry.commit,
            entry.date,
          ]),
        ),
      ),
    );
  }

  return { sections, pending };
}

export function renderValidatePage(root: HTMLElement, results: ResultsFile | null): void {
  root.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = ROUTE_TITLES.validate;
  if (results === null) {
    root.append(title, trustSection(null), tunnelLink());
    return;
  }

  const { cases } = results;
  const { sections, pending } = resultSections(results);
  const list = document.createElement('ul');
  list.className = 'pending-list';
  list.append(...pending.map((text) => element('li', '', paragraph(text))));
  const blockage = blockageNote(cases);
  root.append(
    title,
    paragraph(
      results.commit === 'mixed'
        ? `Generated ${humanDate(results.date)} from runs made at different versions of the code; each row in results.json names its own.`
        : `Generated ${humanDate(results.date)} from commit ${results.commit}.`,
    ),
    element(
      'div',
      'validate-plate',
      ahmedFigure(cases),
      element(
        'div',
        'validate-notes',
        paragraph(RUN_NOTE),
        blockage === null ? null : paragraph(blockage),
        trustSection(results),
      ),
    ),
    element(
      'div',
      'validate-sections',
      ...sections,
      ...(pending.length === 0 ? [] : [section('pending', 'Not yet run', list)]),
    ),
    tunnelLink(),
  );
}

export async function renderValidateRoute(
  root: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const loading = paragraph('Loading validation results.');
  loading.setAttribute('role', 'status');
  root.replaceChildren(loading);
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}validation/results.json`, {
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`validation results returned ${response.status}`);
    const data: unknown = await response.json();
    if (!isCurrent()) return;
    const results = readResults(data);
    if (results === null) throw new Error('The validation results file is invalid.');
    renderValidatePage(root, results);
  } catch (error) {
    if (!isCurrent()) return;
    const message = paragraph(
      `Could not load validation results. ${error instanceof Error ? error.message : String(error)} Reload the page to retry.`,
    );
    message.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = ROUTE_TITLES.validate;
    root.replaceChildren(title, message, tunnelLink());
  }
}
