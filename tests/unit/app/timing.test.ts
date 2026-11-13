import { describe, expect, it } from 'vitest';
import { createRunMarks, MARKS, markDrop } from '../../../src/app/timing';

function fakeClock() {
  const entries: { name: string; startTime: number }[] = [];
  let now = 0;
  return {
    advance(ms: number) {
      now += ms;
    },
    mark(name: string) {
      entries.push({ name, startTime: now });
    },
    getEntriesByName(name: string) {
      return entries.filter((entry) => entry.name === name);
    },
    names: () => entries.map((entry) => entry.name),
  };
}

describe('run marks', () => {
  it('marks the first smoke, Cd and settled once and ignores later repeats', () => {
    const clock = fakeClock();
    const marks = createRunMarks(clock);
    marks.smoke();
    marks.smoke();
    marks.cd();
    marks.settled();
    marks.settled();
    expect(clock.names()).toEqual(['pwt:first-smoke', 'pwt:first-cd', 'pwt:settled']);
  });

  it('keeps the first marks of the page when a later run starts', () => {
    const clock = fakeClock();
    createRunMarks(clock).smoke();
    clock.advance(5);
    createRunMarks(clock).smoke();
    expect(clock.getEntriesByName(MARKS.firstSmoke)).toEqual([
      { name: 'pwt:first-smoke', startTime: 0 },
    ]);
  });

  it('adds the drop marks only for a run that started after the drop', () => {
    const clock = fakeClock();
    const before = createRunMarks(clock);
    clock.advance(10);
    markDrop(clock);
    clock.advance(10);
    before.smoke();
    before.cd();
    expect(clock.names()).toEqual(['pwt:drop', 'pwt:first-smoke', 'pwt:first-cd']);
    const after = createRunMarks(clock);
    clock.advance(10);
    after.smoke();
    after.cd();
    after.settled();
    after.smoke();
    expect(clock.names()).toEqual([
      'pwt:drop',
      'pwt:first-smoke',
      'pwt:first-cd',
      'pwt:drop-smoke',
      'pwt:drop-cd',
      'pwt:settled',
    ]);
    expect(clock.getEntriesByName(MARKS.dropSmoke)[0]?.startTime).toBe(30);
  });

  it('reports settled again for a run that follows a later drop', () => {
    const clock = fakeClock();
    createRunMarks(clock).settled();
    clock.advance(1);
    markDrop(clock);
    createRunMarks(clock).settled();
    expect(clock.names()).toEqual(['pwt:settled', 'pwt:drop', 'pwt:settled']);
  });

  it('gives each drop its own drop marks', () => {
    const clock = fakeClock();
    markDrop(clock);
    createRunMarks(clock).smoke();
    clock.advance(1);
    markDrop(clock);
    createRunMarks(clock).smoke();
    expect(clock.getEntriesByName(MARKS.dropSmoke).map((entry) => entry.startTime)).toEqual([0, 1]);
  });
});
