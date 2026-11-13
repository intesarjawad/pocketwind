/**
 * One solver at a time: a second grid beside the first would double the GPU
 * memory a tier was sized for. A run that wants the slot waits for the holder
 * to release it, and the count is asserted rather than assumed.
 */
let held = 0;
const waiters: Array<() => void> = [];

export function activeSolvers(): number {
  return held;
}

/** Resolve with a release function once no other solver is alive; an abort ends the wait. */
export async function acquireSolverSlot(signal: AbortSignal): Promise<() => void> {
  while (held > 0) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      };
      waiters.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  signal.throwIfAborted();
  held += 1;
  if (held > 1) {
    held -= 1;
    throw new Error('A second solver was allocated while one was still alive.');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    waiters.shift()?.();
  };
}
