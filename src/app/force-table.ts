import type { ForceHistoryPoint } from '../io/run-file';

export const TABLE_SAMPLE_LIMIT = 20;

export type ForceTableRow = {
  readonly step: string;
  readonly cd: string;
};

// The clip pattern keeps the table in the accessibility tree while it is closed.
const HIDDEN_STYLE =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
  'clip:rect(0 0 0 0);white-space:nowrap;border:0;';

/** Newest samples last, so the rows follow the run rather than reverse it. */
export function tableRows(history: readonly ForceHistoryPoint[]): ForceTableRow[] {
  return history.slice(-TABLE_SAMPLE_LIMIT).map(([step, cd]) => ({
    step: String(step),
    cd: cd.toFixed(3),
  }));
}

export function createForceTable(options: { id?: string } = {}): {
  element: HTMLElement;
  update: (history: readonly ForceHistoryPoint[]) => void;
} {
  const id = options.id ?? 'force-samples';
  const wrapper = document.createElement('div');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Show data table';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', id);

  const container = document.createElement('div');
  container.id = id;
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = `Latest ${TABLE_SAMPLE_LIMIT} drag samples`;
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Step', 'Cd']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  table.append(caption, head, body);
  container.append(table);

  let expanded = false;
  function setExpanded(next: boolean): void {
    expanded = next;
    toggle.textContent = expanded ? 'Hide data table' : 'Show data table';
    toggle.setAttribute('aria-expanded', String(expanded));
    container.style.cssText = expanded ? '' : HIDDEN_STYLE;
  }
  toggle.addEventListener('click', () => setExpanded(!expanded));
  setExpanded(false);

  wrapper.append(toggle, container);

  return {
    element: wrapper,
    update(history) {
      const rows = tableRows(history).map((row) => {
        const element = document.createElement('tr');
        for (const value of [row.step, row.cd]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          element.append(cell);
        }
        return element;
      });
      body.replaceChildren(...rows);
    },
  };
}
