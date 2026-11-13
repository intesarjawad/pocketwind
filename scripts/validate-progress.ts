import { readFileSync, renameSync, writeFileSync } from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep completed GPU measurements across process interruption without publishing a partial sweep. */
export function validationProgress(path: string, key: string, resume: boolean, startedAt: string) {
  let entries: Record<string, unknown> = {};
  let date = startedAt;
  if (resume) {
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(saved) ||
      typeof saved.key !== 'string' ||
      typeof saved.date !== 'string' ||
      !Number.isFinite(Date.parse(saved.date)) ||
      !isRecord(saved.entries)
    ) {
      throw new Error(
        `Invalid validation progress in ${path}. Run without --resume to start fresh.`,
      );
    }
    if (saved.key !== key) {
      throw new Error(
        'Validation progress has a different source or machine. Run without --resume.',
      );
    }
    entries = saved.entries;
    date = saved.date;
  }
  const save = () => {
    const temporary = `${path}.tmp.local`;
    writeFileSync(temporary, JSON.stringify({ key, date, entries }));
    renameSync(temporary, path);
  };
  if (!resume) save();
  return {
    date,
    read(id: string): unknown {
      return entries[id];
    },
    write(id: string, value: unknown): void {
      entries[id] = value;
      save();
    },
  };
}

export type ValidationProgress = ReturnType<typeof validationProgress>;
