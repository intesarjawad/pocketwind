import { describe, expect, it } from 'vitest';
import { acquireSolverSlot, activeSolvers } from '../../../src/app/solver-slot';

describe('solver slot', () => {
  it('lets one solver hold the slot and counts it', async () => {
    const release = await acquireSolverSlot(new AbortController().signal);
    expect(activeSolvers()).toBe(1);
    release();
    expect(activeSolvers()).toBe(0);
  });

  it('holds a second solver back until the first is released', async () => {
    const signal = new AbortController().signal;
    const first = await acquireSolverSlot(signal);
    let secondHeld = false;
    const second = acquireSolverSlot(signal).then((release) => {
      secondHeld = true;
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondHeld).toBe(false);
    expect(activeSolvers()).toBe(1);

    first();
    const release = await second;
    expect(secondHeld).toBe(true);
    expect(activeSolvers()).toBe(1);
    release();
    expect(activeSolvers()).toBe(0);
  });

  it('ignores a second release of the same slot', async () => {
    const signal = new AbortController().signal;
    const first = await acquireSolverSlot(signal);
    first();
    const second = await acquireSolverSlot(signal);
    first();
    expect(activeSolvers()).toBe(1);
    second();
    expect(activeSolvers()).toBe(0);
  });

  it('stops waiting when the run is aborted, and leaves the holder alone', async () => {
    const holder = await acquireSolverSlot(new AbortController().signal);
    const controller = new AbortController();
    const waiting = acquireSolverSlot(controller.signal);
    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(activeSolvers()).toBe(1);
    holder();
    expect(activeSolvers()).toBe(0);
  });

  it('refuses to wait on a run that is already aborted', async () => {
    const holder = await acquireSolverSlot(new AbortController().signal);
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(acquireSolverSlot(controller.signal)).rejects.toThrow('stopped');
    holder();
  });
});
