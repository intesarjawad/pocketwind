import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/app/params';
import {
  bodyFor,
  runFileReport,
  runLengthCells,
  runTier,
  settingsFromHash,
  settingsOfRun,
} from '../../../src/app/run-plan';
import { presetMesh, presetSupports } from '../../../src/geometry/presets';
import type { RunFile } from '../../../src/io/run-file';

function savedRun(): RunFile {
  return {
    schemaVersion: 3,
    ...DEFAULT_SETTINGS,
    name: 'Ahmed 25',
    cd: 0.3012,
    cdaM2: 0.03373,
    dragForceN: 32.48,
    status: { kind: 'steady', relStdPct: 0.8, driftPct: 0.4 },
    fluctuationPct: 0.8,
    semPct: 0.2,
    effectiveRe: 320,
    viscosityFloor: true,
    grid: { nx: 128, ny: 64, nz: 64 },
    referenceAreaRule: 'preset',
    forceHistory: [
      [8, 0.28],
      [16, 0.3],
    ],
    fy: 0,
    fz: 0,
    unvalidated: ['fy', 'fz'],
    commit: 'abc1234',
    numericsHash: 'def5678',
  };
}

describe('run plan', () => {
  it('keeps the automatic tier on S and respects a chosen tier', () => {
    expect(runTier('auto', 's-m-l')).toBe('S');
    expect(runTier('L', 's-m-l')).toBe('L');
    expect(runTier('XL', 's-only')).toBe('S');
    expect(runTier('XL', 's-m-l')).toBe('L');
    expect(runTier('XL', 's-m-l-xl')).toBe('XL');
    expect(runTier('L', 's-m-l-xl')).toBe('L');
  });

  it('gives the Ahmed preset half the streamwise domain', () => {
    const mesh = presetMesh('ahmed-25');
    if (mesh === null) throw new Error('Expected the Ahmed preset mesh.');
    expect(runLengthCells('ahmed-25', mesh, { nx: 128, ny: 64, nz: 64 }, true)).toBe(64);
    expect(runLengthCells('ahmed-25', mesh, { nx: 256, ny: 128, nz: 128 }, true)).toBe(128);
  });

  it('applies a share link but keeps settings for a bare route', () => {
    const current = { ...DEFAULT_SETTINGS, speedMps: 12 };
    expect(settingsFromHash('#/?v=90', current).speedMps).toBe(60);
    expect(settingsFromHash('#/validate', current).speedMps).toBe(12);
    expect(settingsFromHash('#/validate?', current).speedMps).toBe(12);
    expect(settingsFromHash('#/?cam=front', current).speedMps).toBe(12);
    expect(settingsFromHash('#/bench?t=M', current).tier).toBe('M');
  });

  it('resolves a preset body, a dropped body and a missing custom body', () => {
    const mesh = presetMesh('sphere');
    if (mesh === null) throw new Error('Expected the sphere preset mesh.');
    expect(bodyFor('sphere', undefined)).toEqual({
      mesh,
      supports: null,
      label: 'Sphere, 100 mm',
    });
    expect(bodyFor('ahmed-25', undefined)?.supports).toEqual(presetSupports('ahmed-25'));
    expect(bodyFor('custom', mesh)).toEqual({ mesh, supports: null, label: 'Dropped model' });
    expect(bodyFor('custom', undefined)).toBeNull();
    expect(bodyFor('missing', undefined)).toBeNull();
    expect(bodyFor('none', undefined)).toMatchObject({
      mesh: { triangleCount: 0 },
      label: 'Empty tunnel',
    });
  });

  it('restores the run inputs without the measured fields', () => {
    expect(settingsOfRun(savedRun())).toEqual(DEFAULT_SETTINGS);
    expect(settingsOfRun(savedRun())).not.toHaveProperty('name');
  });

  it('shows a saved run in the force report', () => {
    const run = savedRun();
    const update = runFileReport(run);
    expect(update.history).toEqual(run.forceHistory);
    expect(update.windowSteps).toBe(2560);
    expect(update.readout).toEqual({
      summary: { cd: 0.3012, status: run.status, samples: 2, semPct: 0.2 },
      effectiveRe: 320,
      referenceAreaSource: 'preset',
      speedMps: 40,
      dragForceN: 32.48,
      grid: { nx: 128, ny: 64, nz: 64 },
    });
  });
});

it('sets the rendered laminar sphere to the validated conditions', async () => {
  const { laminarPlate } = await import('../../../src/app/run-plan');
  const settings = {
    ...DEFAULT_SETTINGS,
    presetId: 'sphere',
    tier: 'M' as const,
    floor: false,
    operator: 'trt' as const,
    bodyLengthMm: 100,
  };
  expect(laminarPlate('#/?laminar=1', settings, 192)).toEqual({
    lengthCells: 24,
    speedMps: expect.closeTo(0.015, 10),
    viscosityLu: expect.closeTo(0.012, 10),
  });
  expect(laminarPlate('#/', settings, 192)).toBeNull();
  expect(laminarPlate('#/?laminar=1', DEFAULT_SETTINGS, 192)).toBeNull();
});
