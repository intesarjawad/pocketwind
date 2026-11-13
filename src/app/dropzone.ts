import type { Mesh } from '../geometry/stl';
import { defaultOrientation } from '../geometry/transform';
import type { Reply } from '../geometry/worker-protocol';
import { MESSAGES, type MessageId } from './messages';
import type { Axis, Settings } from './settings';
import type { SettingsStore } from './store';
import { markDrop } from './timing';

export const MAX_MODEL_BYTES = 200 * 1024 * 1024;
export const MODEL_ACCEPT = '.stl,.3mf,.obj';

const CAD_EXTENSIONS = /\.(?:step|stp|iges|igs)$/i;
const MESH_EXTENSIONS = /\.(?:stl|3mf|obj)$/i;

export type LoadedModel = {
  mesh: Mesh;
  format: 'stl' | '3mf' | 'obj';
  unitMm: number | null;
};

export type ModelFailure = {
  kind: string;
  message: string;
  byteOffset?: number;
  part?: string;
};

export type ModelLoader = (
  bytes: ArrayBuffer,
  fileName: string,
) => Promise<LoadedModel | ModelFailure>;

export type FileCheck = { ok: true } | { ok: false; messageId: MessageId };

export type Dropzone = {
  element: HTMLElement;
  input: HTMLInputElement;
};

export const MODEL_ERROR_MESSAGES: Record<string, MessageId> = {
  truncated: 'model-truncated',
  'not-stl': 'model-not-stl',
  'too-many-triangles': 'model-too-many-triangles',
  empty: 'model-empty',
  'non-finite': 'model-non-finite',
  'zip-unsupported': 'model-zip-unsupported',
  'no-model-part': 'model-no-model-part',
  'bad-xml': 'model-bad-xml',
  'unsupported-cad': 'model-unsupported-cad',
  'operation-failed': 'model-operation-failed',
  'no-solid-cells': 'model-no-solid-cells',
};

const UNIT_NAMES: readonly (readonly [number, string])[] = [
  [0.001, 'microns'],
  [1, 'millimetres'],
  [10, 'centimetres'],
  [25.4, 'inches'],
  [304.8, 'feet'],
  [1000, 'metres'],
];

export function modelFileCheck(file: { name: string; size: number }): FileCheck {
  if (CAD_EXTENSIONS.test(file.name)) return { ok: false, messageId: 'model-unsupported-cad' };
  if (file.size > MAX_MODEL_BYTES) return { ok: false, messageId: 'model-too-large' };
  if (!MESH_EXTENSIONS.test(file.name)) return { ok: false, messageId: 'model-unsupported-format' };
  return { ok: true };
}

/** Put the worker's own kind and location in the message so a bug report is specific. */
export function modelErrorText(failure: ModelFailure): string {
  const message = MESSAGES[MODEL_ERROR_MESSAGES[failure.kind] ?? 'model-operation-failed'];
  const location =
    failure.part !== undefined
      ? ` in ${failure.part}`
      : failure.byteOffset !== undefined
        ? ` at byte ${failure.byteOffset}`
        : '';
  return `${message.what} (${failure.kind}${location}). ${message.next}`;
}

export function fileCheckText(check: Extract<FileCheck, { ok: false }>): string {
  const message = MESSAGES[check.messageId];
  return `${message.what} ${message.next}`;
}

export function unitLabel(unitMm: number | null): string {
  const unit = UNIT_NAMES.find(([millimetres]) => millimetres === unitMm);
  if (unit) return unit[1];
  return unitMm === null ? 'millimetres' : `${unitMm} mm units`;
}

function axisExtent(mesh: Mesh, axis: number): number {
  let min = Infinity;
  let max = -Infinity;
  for (let offset = axis; offset < mesh.positions.length; offset += 3) {
    const value = mesh.positions[offset] ?? NaN;
    if (!Number.isFinite(value)) throw new RangeError('Model coordinates must be finite.');
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return max - min;
}

export function longestSideMm(mesh: Mesh): number {
  if (mesh.triangleCount < 1 || mesh.positions.length < 9) {
    throw new RangeError('A model needs at least one triangle to have a size.');
  }
  return Math.max(axisExtent(mesh, 0), axisExtent(mesh, 1), axisExtent(mesh, 2));
}

export function formatLengthMm(millimetres: number): string {
  if (!Number.isFinite(millimetres)) throw new RangeError('Length must be finite.');
  return Number.isInteger(millimetres)
    ? String(millimetres)
    : millimetres.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function droppedPlacement(mesh: Mesh): Pick<Settings, 'flowAxis' | 'flowSign' | 'upAxis'> {
  return defaultOrientation(mesh);
}

export function describeDrop(
  model: LoadedModel,
  settings: Settings,
): { size: string; orientation: string; speed: string } {
  const placement = droppedPlacement(model.mesh);
  const defaultFlow =
    settings.flowAxis === placement.flowAxis &&
    settings.flowSign === placement.flowSign &&
    settings.upAxis === placement.upAxis;
  return {
    size: `${formatLengthMm(settings.bodyLengthMm)} mm, read as ${unitLabel(model.unitMm)}`,
    orientation: defaultFlow
      ? 'flow along the longest side'
      : `flow along ${settings.flowAxis.toUpperCase()}, up ${settings.upAxis.toUpperCase()}`,
    speed: `${settings.speedMps} m/s`,
  };
}

function createWorkerLoader(): { load: ModelLoader; warm: () => void } {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, (result: LoadedModel | ModelFailure) => void>();

  function failAll(): void {
    for (const resolve of pending.values()) {
      resolve({ kind: 'operation-failed', message: 'The geometry worker stopped.' });
    }
    pending.clear();
    worker = undefined;
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('../geometry/worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<Reply>) => {
      const reply = event.data;
      if (reply.type === 'progress') return;
      const resolve = pending.get(reply.id);
      if (!resolve) return;
      pending.delete(reply.id);
      if (reply.type === 'done' && reply.operation === 'parse') {
        resolve({ mesh: reply.mesh, format: reply.format, unitMm: reply.unitMm });
      } else if (reply.type === 'error') {
        resolve(reply.error);
      } else {
        resolve({
          kind: 'operation-failed',
          message: 'The geometry worker sent an unknown reply.',
        });
      }
    });
    worker.addEventListener('error', failAll);
    return worker;
  }

  /** Fetch the worker's code before a file arrives, so a drop starts no request. */
  function warm(): void {
    try {
      ensureWorker();
    } catch {
      // The first load reports a worker that cannot start.
    }
  }

  const load: ModelLoader = (bytes, fileName) =>
    new Promise((resolve) => {
      let target: Worker;
      try {
        target = ensureWorker();
      } catch {
        resolve({ kind: 'operation-failed', message: 'The geometry worker could not start.' });
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      try {
        target.postMessage({ type: 'parse', id, bytes, fileName }, [bytes]);
      } catch (error) {
        pending.delete(id);
        resolve({
          kind: 'operation-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  return { load, warm };
}

function text(tag: 'p' | 'span', value: string, data?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  if (data !== undefined) element.dataset.value = data;
  return element;
}

export function createDropzone(options: {
  store: SettingsStore;
  load?: ModelLoader;
  onModel?: (model: LoadedModel, fileName: string) => void;
}): Dropzone {
  const { store } = options;
  const loader =
    options.load === undefined
      ? createWorkerLoader()
      : { load: options.load, warm: (): void => undefined };
  const { load } = loader;
  loader.warm();
  let model: LoadedModel | null = null;

  const element = document.createElement('section');
  element.className = 'dropzone';
  element.id = 'dropzone';
  element.setAttribute('aria-label', 'Model file');

  const hint = document.createElement('p');
  hint.textContent = 'Drop an STL, 3MF or OBJ file.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Choose a model';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = MODEL_ACCEPT;
  input.hidden = true;
  button.addEventListener('click', () => input.click());

  const status = document.createElement('p');
  status.setAttribute('role', 'alert');
  status.hidden = true;
  const summary = document.createElement('div');
  summary.dataset.modelSummary = '';
  summary.hidden = true;

  function showFailure(messageId: MessageId, failure?: ModelFailure): void {
    summary.hidden = true;
    model = null;
    status.hidden = false;
    status.textContent =
      failure === undefined ? fileCheckText({ ok: false, messageId }) : modelErrorText(failure);
    status.dataset.messageId = messageId;
    if (failure === undefined) {
      delete status.dataset.kind;
      delete status.dataset.byteOffset;
      delete status.dataset.part;
      return;
    }
    status.dataset.kind = failure.kind;
    if (failure.byteOffset !== undefined) status.dataset.byteOffset = String(failure.byteOffset);
    if (failure.part !== undefined) status.dataset.part = failure.part;
  }

  function renderSummary(): void {
    if (model === null) return;
    const description = describeDrop(model, store.settings);
    const sizeRow = document.createElement('p');
    sizeRow.append(text('span', description.size, 'size'));
    const sizeButton = document.createElement('button');
    sizeButton.type = 'button';
    sizeButton.textContent = 'Change size';
    sizeButton.addEventListener('click', () => {
      document.querySelector<HTMLInputElement>('input[name="bodyLengthMm"]')?.focus();
    });
    sizeRow.append(sizeButton);

    const orientationRow = document.createElement('p');
    orientationRow.append(text('span', description.orientation, 'orientation'));
    const orientationLabel = document.createElement('label');
    orientationLabel.textContent = 'Flow axis';
    const orientation = document.createElement('select');
    for (const axis of ['x', 'y', 'z'] as const) {
      const option = document.createElement('option');
      option.value = axis;
      option.textContent = axis.toUpperCase();
      orientation.append(option);
    }
    orientation.value = store.settings.flowAxis;
    orientation.addEventListener('change', () => {
      const flowAxis = orientation.value as Axis;
      const upAxis =
        flowAxis === store.settings.upAxis ? (flowAxis === 'z' ? 'y' : 'z') : store.settings.upAxis;
      store.update({ flowAxis, upAxis });
    });
    orientationLabel.append(orientation);
    orientationRow.append(orientationLabel);

    const speedRow = document.createElement('p');
    speedRow.append(text('span', description.speed, 'speed'));
    const speedButton = document.createElement('button');
    speedButton.type = 'button';
    speedButton.textContent = 'Change speed';
    speedButton.addEventListener('click', () => {
      document.querySelector<HTMLInputElement>('input[name="speedMps"]')?.focus();
    });
    speedRow.append(speedButton);

    summary.replaceChildren(sizeRow, orientationRow, speedRow);
    summary.hidden = false;
  }

  async function accept(file: File): Promise<void> {
    markDrop();
    const check = modelFileCheck(file);
    if (!check.ok) {
      showFailure(check.messageId);
      return;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      showFailure('model-read-failed');
      return;
    }
    const result = await load(bytes, file.name);
    if ('kind' in result) {
      showFailure(MODEL_ERROR_MESSAGES[result.kind] ?? 'model-operation-failed', result);
      return;
    }
    model = result;
    status.hidden = true;
    const placement = droppedPlacement(result.mesh);
    store.update({ presetId: 'custom', bodyLengthMm: longestSideMm(result.mesh), ...placement });
    renderSummary();
    options.onModel?.(result, file.name);
  }

  element.addEventListener('dragover', (event) => {
    event.preventDefault();
    element.classList.add('dropzone-over');
    element.style.outline = '2px dashed currentColor';
  });
  element.addEventListener('dragleave', () => {
    element.classList.remove('dropzone-over');
    element.style.outline = '';
  });
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    element.classList.remove('dropzone-over');
    element.style.outline = '';
    const file = event.dataTransfer?.files[0];
    if (file) void accept(file);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void accept(file);
    input.value = '';
  });
  store.subscribe(renderSummary);

  const labelledButton = document.createElement('p');
  labelledButton.append(button, input);
  element.append(hint, labelledButton, status, summary);
  return { element, input };
}
