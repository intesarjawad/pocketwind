import { PRESETS, presetById } from './params';
import type { SettingsStore } from './store';

export const CUSTOM_PRESET_LABEL = 'Dropped model';

export function createPresetsMenu(store: SettingsStore): HTMLElement {
  const wrapper = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = 'Preset';
  const select = document.createElement('select');
  select.name = 'presetId';
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }
  const empty = document.createElement('option');
  empty.value = 'none';
  empty.textContent = 'Empty tunnel';
  select.append(empty);
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = CUSTOM_PRESET_LABEL;
  select.append(custom);
  label.append(select);

  function sync(): void {
    select.value = store.settings.presetId;
  }

  select.addEventListener('change', () => {
    const preset = presetById(select.value);
    store.update(
      preset
        ? { presetId: preset.id, bodyLengthMm: preset.bodyLengthMm }
        : { presetId: select.value },
    );
  });

  store.subscribe(sync);
  sync();
  wrapper.append(label);
  return wrapper;
}
