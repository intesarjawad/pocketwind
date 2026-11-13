import { TIERS } from '../lbm/layout';
import { DEFAULT_SETTINGS, MAX_SPEED_MPS, MIN_SPEED_MPS } from './params';
import { createPresetsMenu } from './presets-menu';
import { laminarPlate } from './run-plan';
import type { Settings } from './settings';
import type { SettingsStore } from './store';

export const REPOSITORY_URL = 'https://github.com/intesarjawad/pocketwind';

export const FOOTER_LINKS = [
  { label: 'how it works', href: `${REPOSITORY_URL}#how-it-works` },
  { label: 'validation page', href: '#/validate' },
  { label: 'make it yours', href: `${REPOSITORY_URL}/blob/main/docs/extend.md` },
] as const;

export const ADVANCED_FIELDS = ['operator', 'walls', 'storage', 'tier'] as const;

export function advancedChangeCount(settings: Settings): number {
  let count = 0;
  if (settings.operator !== DEFAULT_SETTINGS.operator) count += 1;
  if (settings.walls !== DEFAULT_SETTINGS.walls) count += 1;
  if (settings.storage !== DEFAULT_SETTINGS.storage) count += 1;
  if (settings.tier !== DEFAULT_SETTINGS.tier) count += 1;
  return count;
}

export function advancedSummary(settings: Settings): string {
  const count = advancedChangeCount(settings);
  return count === 0 ? 'Advanced' : `Advanced (${count} changed)`;
}

type SelectOption = { value: string; label: string; disabled?: boolean };

function labelledControl(
  labelText: string,
  control: HTMLInputElement | HTMLSelectElement,
  suffix?: string,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.append(control);
  if (suffix !== undefined) label.append(suffix);
  return label;
}

function select(
  name: string,
  options: readonly SelectOption[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const element = document.createElement('select');
  element.name = name;
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    item.disabled = option.disabled ?? false;
    element.append(item);
  }
  element.value = value;
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

export function createFooter(): HTMLElement {
  const footer = document.createElement('footer');
  const [how, validation, extend] = FOOTER_LINKS.map((link) => {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.textContent = link.label;
    return anchor;
  });
  const colophon = document.createElement('p');
  colophon.append(
    'Every thread on the plate is a streakline the solver carries itself; the README sets out ',
    how ?? '',
    '. Drag validation covers the laminar sphere; vehicle bodies are experimental visualisations. The failing reference comparisons remain on the ',
    validation ?? '',
    '. To add a body or a check of your own, ',
    extend ?? '',
    '.',
  );
  footer.append(colophon);
  return footer;
}

/**
 * Build the controls in reading order. The details element stays closed on load
 * so the common path is file, size, speed, compare and one button.
 */
export function createPanel(options: {
  store: SettingsStore;
  dropzone: HTMLElement;
  onCheckGrid?: () => void;
}): HTMLElement {
  const { store } = options;
  const wrapper = document.createElement('div');
  wrapper.className = 'panel';
  wrapper.id = 'panel';
  const form = document.createElement('form');
  form.setAttribute('aria-label', 'Tunnel controls');

  const size = document.createElement('input');
  size.type = 'number';
  size.name = 'bodyLengthMm';
  size.id = 'size';
  size.setAttribute('aria-label', 'Size');
  size.min = '1';
  size.step = '1';
  size.value = String(store.settings.bodyLengthMm);
  size.addEventListener('input', () => {
    const value = Number(size.value);
    if (Number.isFinite(value) && value > 0) store.update({ bodyLengthMm: value });
  });
  const sizeSection = document.createElement('section');
  sizeSection.append(labelledControl('Size', size, ' mm'));

  const speed = document.createElement('input');
  speed.type = 'range';
  speed.name = 'speedMps';
  speed.id = 'speed';
  speed.setAttribute('aria-label', 'Speed');
  speed.min = String(MIN_SPEED_MPS);
  speed.max = String(MAX_SPEED_MPS);
  speed.step = '1';
  speed.value = String(store.settings.speedMps);
  const speedOutput = document.createElement('output');
  speedOutput.htmlFor = speed.id;
  speed.addEventListener('input', () => store.update({ speedMps: Number(speed.value) }));
  const speedNote = document.createElement('span');
  const speedSection = document.createElement('section');
  speedSection.append(labelledControl('Speed', speed), speedOutput, speedNote);

  const compare = document.createElement('input');
  compare.type = 'checkbox';
  compare.name = 'compare';
  compare.setAttribute('aria-label', 'Compare');
  compare.checked = store.settings.compare.enabled;
  compare.addEventListener('change', () => store.update({ compare: { enabled: compare.checked } }));
  const compareSection = document.createElement('section');
  compareSection.append(labelledControl('Compare with the previous run', compare));

  const checkGrid = document.createElement('button');
  checkGrid.type = 'submit';
  checkGrid.textContent = 'Check grid';

  const advanced = document.createElement('details');
  const advancedTitle = document.createElement('summary');
  const operator = select(
    'operator',
    [
      { value: 'trt', label: 'TRT' },
      { value: 'reg', label: 'Regularized' },
    ],
    store.settings.operator,
    (value) => store.update({ operator: value as Settings['operator'] }),
  );
  const walls = select(
    'walls',
    [
      { value: 'bb', label: 'Halfway bounce-back' },
      {
        value: 'bouzidi',
        label: 'Bouzidi (unavailable: LES wall model not validated)',
        disabled: true,
      },
    ],
    store.settings.walls,
    (value) => store.update({ walls: value as Settings['walls'] }),
  );
  const storage = select(
    'storage',
    [
      { value: 'auto', label: 'Auto (float16 if supported)' },
      { value: 'f32', label: 'float32' },
      { value: 'f16', label: 'float16' },
    ],
    store.settings.storage,
    (value) => store.update({ storage: value as Settings['storage'] }),
  );
  const tier = select(
    'tier',
    [
      { value: 'auto', label: 'Auto' },
      { value: 'S', label: 'S' },
      { value: 'M', label: 'M' },
      { value: 'L', label: 'L' },
      { value: 'XL', label: 'XL' },
    ],
    store.settings.tier,
    (value) => store.update({ tier: value as Settings['tier'] }),
  );
  advanced.append(
    advancedTitle,
    labelledControl('Operator', operator),
    labelledControl('Walls', walls),
    labelledControl('Storage', storage),
    labelledControl('Tier', tier),
  );

  function sync(): void {
    const settings = store.settings;
    size.value = String(settings.bodyLengthMm);
    const laminar = laminarPlate(location.hash, settings, TIERS.M.nx);
    speed.disabled = laminar !== null;
    speed.value = String(settings.speedMps);
    speedOutput.value = `${Number((laminar?.speedMps ?? settings.speedMps).toPrecision(4))} m/s`;
    speedNote.textContent = laminar
      ? 'Set by Re 100; change size to adjust speed. Comparison, grid checks and exports are unavailable in this mode.'
      : '';
    compare.disabled = laminar !== null;
    checkGrid.disabled = laminar !== null;
    compare.checked = laminar === null && settings.compare.enabled;
    operator.value = settings.operator;
    walls.value = settings.walls;
    storage.value = settings.storage;
    tier.value = settings.tier;
    advancedTitle.textContent = advancedSummary(settings);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    store.update({ paused: false });
    if (options.onCheckGrid) options.onCheckGrid();
    else store.restart();
  });
  store.subscribe(sync);
  sync();

  form.append(
    options.dropzone,
    createPresetsMenu(store),
    sizeSection,
    speedSection,
    compareSection,
    advanced,
    checkGrid,
  );
  wrapper.append(form, createFooter());
  return wrapper;
}
