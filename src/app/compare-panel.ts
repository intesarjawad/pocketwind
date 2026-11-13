import { type CompareOutcome, type CompareRow, GRID_EFFECTS_HREF, outcomeText } from './compare';
import { READOUT_INTERVAL_MS, statusText } from './readout';

export type ComparePanelState = {
  readonly first: CompareRow;
  readonly second: CompareRow;
  readonly outcome: CompareOutcome;
};

const MISSING = 'n/a';
const COLUMNS = ['Run', 'Cd', 'CdA (m²)', 'Status', 'Standard error'];

function rowCells(row: CompareRow, index: number): string[] {
  return [
    `Run ${index}: ${row.label}`,
    row.cd === null ? MISSING : row.cd.toFixed(2),
    row.cdaM2 === null ? MISSING : row.cdaM2.toFixed(4),
    statusText(row.status),
    row.semPct === null ? MISSING : `±${row.semPct.toFixed(1)}%`,
  ];
}

/**
 * Two frozen-style rows and the verdict between them. Samples arrive per frame,
 * so the table follows the readout's cadence and the newest state wins.
 */
export function createComparePanel(options: { onFile: (file: File) => void; now?: () => number }): {
  element: HTMLElement;
  showRefusal: (text: string | null) => void;
  show: (state: ComparePanelState | null) => void;
  dispose: () => void;
} {
  const now = options.now ?? (() => Date.now());
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Compare');

  const label = document.createElement('label');
  label.textContent = 'Compare with a saved run file';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  label.append(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file !== undefined) options.onFile(file);
  });

  const refusal = document.createElement('p');
  refusal.setAttribute('role', 'alert');
  refusal.hidden = true;

  const result = document.createElement('div');
  result.hidden = true;
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = 'Run comparison';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of COLUMNS) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  table.append(caption, head, body);
  const outcome = document.createElement('p');
  outcome.setAttribute('role', 'status');
  const gridLink = document.createElement('a');
  gridLink.href = GRID_EFFECTS_HREF;
  gridLink.textContent = 'See how the grid changes drag.';
  const note = document.createElement('p');
  note.append(
    'The band covers sampling only, with the same grid for both runs. Vehicle-body drag comparisons are experimental visualisation, outside the validated laminar-sphere regime. ',
    gridLink,
  );
  result.append(table, outcome, note);

  let lastWrite = Number.NEGATIVE_INFINITY;
  let pending: ComparePanelState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function write(state: ComparePanelState): void {
    const rows = [state.first, state.second].map((row, index) => {
      const element = document.createElement('tr');
      for (const [column, value] of rowCells(row, index + 1).entries()) {
        const cell = document.createElement(column === 0 ? 'th' : 'td');
        if (column === 0) cell.scope = 'row';
        cell.textContent = value;
        element.append(cell);
      }
      return element;
    });
    body.replaceChildren(...rows);
    outcome.textContent = outcomeText(state.outcome);
    result.hidden = false;
    lastWrite = now();
  }

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  }

  function show(state: ComparePanelState | null): void {
    if (state === null) {
      cancel();
      result.hidden = true;
      return;
    }
    pending = state;
    if (timer !== undefined) return;
    const elapsed = now() - lastWrite;
    if (elapsed >= READOUT_INTERVAL_MS) {
      pending = undefined;
      write(state);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (pending === undefined) return;
      const latest = pending;
      pending = undefined;
      write(latest);
    }, READOUT_INTERVAL_MS - elapsed);
  }

  function showRefusal(text: string | null): void {
    refusal.textContent = text ?? '';
    refusal.hidden = text === null;
  }

  section.append(label, refusal, result);
  return { element: section, showRefusal, show, dispose: cancel };
}
