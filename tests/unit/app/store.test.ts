import { describe, expect, it, vi } from 'vitest';
import { changeKind, createStore, type StoreChange, viscosityLu } from '../../../src/app/store';
import { NU_MIN_LU } from '../../../src/lbm/units';

describe('settings store', () => {
  it('increments the generation only for changes that restart the run', () => {
    const store = createStore();
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.update({ speedMps: 20 });
    expect(store.generation).toBe(0);
    expect(changes.at(-1)).toMatchObject({ kind: 'live', changed: ['speedMps'] });

    for (const patch of [
      { tier: 'M' as const },
      { storage: 'f16' as const },
      { operator: 'trt' as const },
      { walls: 'bouzidi' as const },
      { bodyLengthMm: 500 },
      { flowAxis: 'y' as const },
      { presetId: 'sphere' },
    ]) {
      const before = store.generation;
      store.update(patch);
      expect(store.generation).toBe(before + 1);
      expect(changes.at(-1)?.kind).toBe('restart');
    }
  });

  it('leaves a paused or comparison change off the simulation boundary', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ paused: true });
    store.update({ compare: { enabled: true } });
    expect(store.generation).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ kind: 'view' });
  });

  it('does not notify for an unchanged value', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ speedMps: store.settings.speedMps });
    expect(listener).not.toHaveBeenCalled();
  });

  it('clamps the speed to the panel range before comparing it', () => {
    const store = createStore();
    store.update({ speedMps: 60 });
    const change = store.update({ speedMps: 90 });
    expect(store.settings.speedMps).toBe(60);
    expect(change.changed).toEqual([]);
  });

  it('restarts explicitly from the check-grid action', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.restart();
    expect(store.generation).toBe(1);
    expect(listener).toHaveBeenCalledWith({
      settings: store.settings,
      changed: [],
      kind: 'restart',
      generation: 1,
    });
  });

  it('unsubscribes cleanly', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.update({ paused: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('classifies a geometry change with a speed change as a restart', () => {
    expect(changeKind(['speedMps', 'tier'])).toBe('restart');
    expect(changeKind(['paused', 'compare'])).toBe('view');
  });

  it('holds live viscosity at the floor across road speeds', () => {
    const store = createStore();
    expect(viscosityLu(store.settings, 102.4)).toBe(NU_MIN_LU);
    store.update({ speedMps: 20 });
    expect(viscosityLu(store.settings, 102.4)).toBe(NU_MIN_LU);
  });
});
