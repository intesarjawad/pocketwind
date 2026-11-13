import type { ReferenceAreaSource } from '../app/readout';
import type { Settings } from '../app/settings';
import type { DragSummary } from '../forces/drag-stats';
import type { Layout } from '../geometry/voxel-grid';
import {
  type ForceHistoryPoint,
  RUN_FILE_SCHEMA_VERSION,
  type RunFile,
  UNVALIDATED_FORCES,
} from './run-file';

export type RunExportInput = {
  name: string;
  settings: Settings;
  summary: DragSummary;
  cdaM2: number | null;
  dragForceN: number | null;
  semPct: number | null;
  effectiveRe: number | null;
  viscosityFloor: boolean | null;
  grid: Layout;
  referenceAreaRule: ReferenceAreaSource;
  forceHistory: readonly ForceHistoryPoint[];
  fy: number | null;
  fz: number | null;
  commit: string;
  numericsHash: string;
};

/** What a run measures, without the labels and build stamps a file adds. */
export type RunMeasurements = Omit<RunExportInput, 'name' | 'settings' | 'commit' | 'numericsHash'>;

/** Flatten the settings into one record so a reader needs no schema lookup. */
export function buildRunFile(input: RunExportInput): RunFile {
  const fluctuationPct =
    input.summary.status.kind === 'settling' ? null : input.summary.status.relStdPct;
  return {
    schemaVersion: RUN_FILE_SCHEMA_VERSION,
    ...input.settings,
    name: input.name,
    cd: input.summary.cd,
    cdaM2: input.cdaM2,
    dragForceN: input.dragForceN,
    status: input.summary.status,
    fluctuationPct,
    semPct: input.semPct,
    effectiveRe: input.effectiveRe,
    viscosityFloor: input.viscosityFloor,
    grid: { nx: input.grid.nx, ny: input.grid.ny, nz: input.grid.nz },
    referenceAreaRule: input.referenceAreaRule,
    forceHistory: input.forceHistory.map(([step, cd]) => [step, cd] as const),
    fy: input.fy,
    fz: input.fz,
    unvalidated: UNVALIDATED_FORCES,
    commit: input.commit,
    numericsHash: input.numericsHash,
  };
}

export function runFileJson(run: RunFile): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

/** Path separators and reserved characters would split or reject the download name. */
export function downloadStem(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return safe === '' ? 'untitled' : safe;
}

export function runFileName(name: string): string {
  return `${downloadStem(name)}-run.json`;
}
