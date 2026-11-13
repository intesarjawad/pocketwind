/** User Timing marks the cold-start script reads; times are relative to navigation start. */
export const MARKS = {
  firstSmoke: 'pwt:first-smoke',
  firstCd: 'pwt:first-cd',
  drop: 'pwt:drop',
  dropSmoke: 'pwt:drop-smoke',
  dropCd: 'pwt:drop-cd',
  settled: 'pwt:settled',
} as const;

export type MarkClock = {
  mark(name: string): unknown;
  getEntriesByName(name: string): readonly { readonly startTime: number }[];
};

function hasMark(clock: MarkClock, name: string, since: number | undefined): boolean {
  return clock
    .getEntriesByName(name)
    .some((entry) => since === undefined || entry.startTime >= since);
}

function lastMarkTime(clock: MarkClock, name: string): number | undefined {
  const times = clock.getEntriesByName(name).map((entry) => entry.startTime);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** A file was received; later runs measure their own first frames from here. */
export function markDrop(clock: MarkClock = performance): void {
  clock.mark(MARKS.drop);
}

/**
 * Marks for one run. A run created after a drop also reports the drop marks, once
 * per drop, so a run that was already going when the file arrived never claims them.
 */
export function createRunMarks(clock: MarkClock = performance): {
  smoke: () => void;
  cd: () => void;
  settled: () => void;
} {
  const drop = lastMarkTime(clock, MARKS.drop);
  const markOnce = (name: string, since: number | undefined): void => {
    if (!hasMark(clock, name, since)) clock.mark(name);
  };
  return {
    smoke() {
      markOnce(MARKS.firstSmoke, undefined);
      if (drop !== undefined) markOnce(MARKS.dropSmoke, drop);
    },
    cd() {
      markOnce(MARKS.firstCd, undefined);
      if (drop !== undefined) markOnce(MARKS.dropCd, drop);
    },
    settled() {
      markOnce(MARKS.settled, drop);
    },
  };
}
