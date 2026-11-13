import { rowsOf, type ValidationResults } from '../validation/results';
import type { ValidationRow } from '../validation/runner';
import { readRoute, routeHash } from './routes';

export type ValidationRowView = Pick<
  ValidationRow,
  'case' | 'tier' | 'cd' | 'errorPct' | 'pass' | 'group'
>;

export type ValidationTableRow = {
  case: string;
  tier: string;
  group: string;
  cd: string;
  error: string;
  result: string;
};

function decimal(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** Plain text cells so the table reads the same in the browser and in tests. */
export function validationRows(rows: readonly ValidationRowView[]): ValidationTableRow[] {
  return rows.map((row) => ({
    case: row.case,
    tier: row.tier,
    group: row.group,
    cd: decimal(row.cd, 4),
    error: row.errorPct === null ? 'n/a' : `${row.errorPct.toFixed(1)}%`,
    result: row.pass ? 'Pass' : 'Fail',
  }));
}

export function validationSummary(results: ValidationResults): string {
  const rows = rowsOf(results);
  const passed = rows.filter((row) => row.pass).length;
  const verified = results.verification.length > 0 && results.verification.every((row) => row.pass);
  return `${passed} of ${rows.length} cases passed. Analytic verification ${verified ? 'passed' : 'failed or absent'}. Generated ${results.date} at commit ${results.commit}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResults(value: unknown): value is ValidationResults {
  return (
    isRecord(value) &&
    typeof value.date === 'string' &&
    typeof value.commit === 'string' &&
    Array.isArray(value.verification) &&
    ['laminar', 'validation', 'confinement', 'sensitivity'].every((name) =>
      Array.isArray(value[name]),
    )
  );
}

export function renderValidationResults(
  root: HTMLElement,
  results: ValidationResults | null,
): void {
  root.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Validation results';
  const tunnel = document.createElement('a');
  tunnel.href = routeHash('', readRoute().settings);
  tunnel.textContent = 'Open the tunnel';
  root.append(title);

  if (results === null) {
    const pending = document.createElement('p');
    pending.textContent = 'Not yet run.';
    root.append(pending, tunnel);
    return;
  }

  const summary = document.createElement('p');
  summary.textContent = validationSummary(results);
  root.append(summary);

  const rows = rowsOf(results);
  if (rows.length === 0) {
    const pending = document.createElement('p');
    pending.textContent = 'Not yet run.';
    root.append(pending);
  } else {
    const table = document.createElement('table');
    const caption = document.createElement('caption');
    caption.textContent = 'Measured drag by case';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Case', 'Group', 'Tier', 'Cd', 'Error', 'Result']) {
      const header = document.createElement('th');
      header.scope = 'col';
      header.textContent = label;
      headRow.append(header);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const row of validationRows(rows)) {
      const tr = document.createElement('tr');
      for (const value of [row.case, row.group, row.tier, row.cd, row.error, row.result]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      body.append(tr);
    }
    table.append(caption, head, body);
    root.append(table);
  }
  root.append(tunnel);
}

export async function renderValidationRoute(
  root: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}validation/results.json`, {
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`validation results returned ${response.status}`);
    const data: unknown = await response.json();
    if (!isCurrent()) return;
    renderValidationResults(root, isResults(data) ? data : null);
  } catch {
    if (isCurrent()) renderValidationResults(root, null);
  }
}
