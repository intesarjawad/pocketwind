import type { MessageId } from '../app/messages';
import type { ReferenceAreaSource } from '../app/readout';
import type { Settings, StorageChoice, TierChoice } from '../app/settings';
import type { DragStatus } from '../forces/drag-stats';
import { TIERS } from '../lbm/layout';

export const RUN_FILE_SCHEMA_VERSION = 3;
export const MAX_RUN_FILE_BYTES = 5 * 1024 * 1024;

export type ForceHistoryPoint = readonly [step: number, cd: number];

export type UnvalidatedForce = 'fy' | 'fz';
export const UNVALIDATED_FORCES: readonly UnvalidatedForce[] = ['fy', 'fz'];

export type RunFile = Settings & {
  schemaVersion: typeof RUN_FILE_SCHEMA_VERSION;
  name: string;
  cd: number | null;
  cdaM2: number | null;
  dragForceN: number | null;
  status: DragStatus;
  fluctuationPct: number | null;
  semPct: number | null;
  effectiveRe: number | null;
  viscosityFloor: boolean | null;
  grid: { nx: number; ny: number; nz: number };
  /** Where the area behind Cd and CdA came from: the preset's stated area or projected solid cells. */
  referenceAreaRule: ReferenceAreaSource;
  forceHistory: readonly ForceHistoryPoint[];
  fy: number | null;
  fz: number | null;
  /** Lateral and vertical components are recorded without a validated reference. */
  unvalidated: readonly UnvalidatedForce[];
  commit: string;
  numericsHash: string;
};

export type RunFileRefusalKind = 'too-large' | 'invalid-json' | 'unknown-version' | 'missing-field';

export const RUN_FILE_MESSAGES = {
  'too-large': 'run-file-too-large',
  'invalid-json': 'run-file-invalid',
  'unknown-version': 'run-file-version',
  'missing-field': 'run-file-missing-field',
} as const satisfies Record<RunFileRefusalKind, MessageId>;

export type RunFileRefusal = {
  kind: RunFileRefusalKind;
  messageId: MessageId;
};

export type RunFileSource = string | ArrayBuffer | Uint8Array;

export function isRunFileRefusal(result: RunFile | RunFileRefusal): result is RunFileRefusal {
  return 'kind' in result;
}

function refusal(kind: RunFileRefusalKind): RunFileRefusal {
  return { kind, messageId: RUN_FILE_MESSAGES[kind] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isTierChoice(value: unknown): value is TierChoice {
  return value === 'auto' || (typeof value === 'string' && Object.hasOwn(TIERS, value));
}

function isStorageChoice(value: unknown): value is StorageChoice {
  return value === 'auto' || value === 'f32' || value === 'f16';
}

function isAxis(value: unknown): value is Settings['flowAxis'] {
  return value === 'x' || value === 'y' || value === 'z';
}

function isOperator(value: unknown): value is Settings['operator'] {
  return value === 'trt' || value === 'reg';
}

function isWalls(value: unknown): value is Settings['walls'] {
  return value === 'bb' || value === 'bouzidi';
}

function isCompareState(value: unknown): value is Settings['compare'] {
  return isRecord(value) && typeof value.enabled === 'boolean';
}

function isGrid(value: unknown): value is { nx: number; ny: number; nz: number } {
  if (!isRecord(value)) return false;
  return isPositiveInteger(value.nx) && isPositiveInteger(value.ny) && isPositiveInteger(value.nz);
}

function isReferenceAreaRule(value: unknown): value is ReferenceAreaSource {
  return value === 'preset' || value === 'frontal';
}

function isDragStatus(value: unknown): value is DragStatus {
  if (!isRecord(value)) return false;
  if (value.kind === 'settling') return isNullableNumber(value.etaS);
  if (value.kind === 'steady' || value.kind === 'unsteady') {
    return isFiniteNumber(value.relStdPct) && isFiniteNumber(value.driftPct);
  }
  return false;
}

function isForceHistory(value: unknown): value is readonly ForceHistoryPoint[] {
  return (
    Array.isArray(value) &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        isFiniteNumber(point[0]) &&
        isFiniteNumber(point[1]),
    )
  );
}

function isUnvalidated(value: unknown): value is readonly UnvalidatedForce[] {
  return Array.isArray(value) && value.every((item) => item === 'fy' || item === 'fz');
}

function readSettings(value: Record<string, unknown>): Settings | null {
  const {
    presetId,
    tier,
    storage,
    operator,
    walls,
    speedMps,
    bodyLengthMm,
    flowAxis,
    flowSign,
    upAxis,
    floor,
    paused,
    compare,
  } = value;
  if (
    typeof presetId !== 'string' ||
    presetId === '' ||
    !isTierChoice(tier) ||
    !isStorageChoice(storage) ||
    !isOperator(operator) ||
    !isWalls(walls) ||
    !isFiniteNumber(speedMps) ||
    speedMps <= 0 ||
    !isFiniteNumber(bodyLengthMm) ||
    bodyLengthMm <= 0 ||
    !isAxis(flowAxis) ||
    (flowSign !== 1 && flowSign !== -1) ||
    !isAxis(upAxis) ||
    flowAxis === upAxis ||
    typeof floor !== 'boolean' ||
    typeof paused !== 'boolean' ||
    !isCompareState(compare)
  ) {
    return null;
  }
  return {
    presetId,
    tier,
    storage,
    operator,
    walls,
    speedMps,
    bodyLengthMm,
    flowAxis,
    flowSign,
    upAxis,
    floor,
    paused,
    compare: { enabled: compare.enabled },
  };
}

function readRunFields(value: Record<string, unknown>): Omit<RunFile, keyof Settings> | null {
  const { name, cd, cdaM2, dragForceN, status, fluctuationPct, semPct } = value;
  const { grid, referenceAreaRule, forceHistory, fy, fz, unvalidated } = value;
  const { commit, numericsHash } = value;
  const effectiveRe = value.effectiveRe ?? null;
  const viscosityFloor = value.viscosityFloor ?? null;
  if (
    typeof name !== 'string' ||
    !isNullableNumber(cd) ||
    !isNullableNumber(cdaM2) ||
    !isNullableNumber(dragForceN) ||
    !isDragStatus(status) ||
    !isNullableNumber(fluctuationPct) ||
    !isNullableNumber(semPct) ||
    !isNullableNumber(effectiveRe) ||
    (effectiveRe !== null && effectiveRe <= 0) ||
    (viscosityFloor !== null && typeof viscosityFloor !== 'boolean') ||
    !isGrid(grid) ||
    !isReferenceAreaRule(referenceAreaRule) ||
    !isForceHistory(forceHistory) ||
    !isNullableNumber(fy) ||
    !isNullableNumber(fz) ||
    (unvalidated !== undefined && !isUnvalidated(unvalidated)) ||
    typeof commit !== 'string' ||
    typeof numericsHash !== 'string'
  ) {
    return null;
  }
  return {
    schemaVersion: RUN_FILE_SCHEMA_VERSION,
    name,
    cd,
    cdaM2,
    dragForceN,
    status,
    fluctuationPct,
    semPct,
    effectiveRe,
    viscosityFloor,
    grid,
    referenceAreaRule,
    forceHistory: forceHistory.map(([step, pointCd]) => [step, pointCd] as const),
    fy,
    fz,
    unvalidated: unvalidated ?? UNVALIDATED_FORCES,
    commit,
    numericsHash,
  };
}

function sourceBytes(source: RunFileSource): number {
  if (typeof source === 'string') return new TextEncoder().encode(source).byteLength;
  return source.byteLength;
}

/**
 * Read a run file without throwing. A refusal always carries the message entry
 * the interface should show; a malformed field is treated as missing because the
 * file cannot be used either way.
 */
export function parseRunFile(source: RunFileSource): RunFile | RunFileRefusal {
  if (sourceBytes(source) > MAX_RUN_FILE_BYTES) return refusal('too-large');

  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refusal('invalid-json');
  }
  if (!isRecord(parsed)) return refusal('invalid-json');
  if (!('schemaVersion' in parsed)) return refusal('missing-field');
  if (parsed.schemaVersion !== RUN_FILE_SCHEMA_VERSION) return refusal('unknown-version');

  const settings = readSettings(parsed);
  const fields = readRunFields(parsed);
  if (settings === null || fields === null) return refusal('missing-field');
  return { ...settings, ...fields };
}
