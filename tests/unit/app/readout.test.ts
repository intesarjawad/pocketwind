import { describe, expect, it } from 'vitest';
import { type ReadoutState, readoutText } from '../../../src/app/readout';
import type { DragSummary } from '../../../src/forces/drag-stats';

const STEADY: DragSummary = {
  cd: 0.31,
  status: { kind: 'steady', relStdPct: 1.8, driftPct: 0.4 },
  samples: 120,
};

function state(patch: Partial<ReadoutState> = {}): ReadoutState {
  return {
    summary: STEADY,
    speedMps: 40,
    dragForceN: 6.2,
    grid: { nx: 256, ny: 128, nz: 128 },
    ...patch,
  };
}

describe('drag readout text', () => {
  it('reports Cd, steadiness, drag and grid in one sentence', () => {
    expect(readoutText(state())).toBe(
      'Cd 0.31, steady, fluctuation 1.8%, drag 6.2 N at 40 m/s, domain 256×128×128',
    );
  });

  it('adds the grid band once a convergence study exists', () => {
    expect(readoutText(state({ gridBandPct: 2.5 }))).toBe(
      'Cd 0.31, steady, fluctuation 1.8%, drag 6.2 N at 40 m/s, domain 256×128×128, grid band ±2.5%',
    );
  });

  it('states the Reynolds number the viscosity floor runs at', () => {
    expect(readoutText(state({ effectiveRe: 480.4 }))).toContain(
      'simulated at Re 480 (viscosity floor)',
    );
    expect(readoutText(state())).not.toContain('viscosity floor');
  });

  it('omits a missing grid band', () => {
    expect(readoutText(state({ gridBandPct: null }))).not.toContain('grid band');
  });

  it('names a preset reference area and a voxel frontal area', () => {
    expect(readoutText(state({ referenceAreaM2: 0.112, referenceAreaSource: 'preset' }))).toContain(
      'reference area 0.1120 m² (preset)',
    );
    expect(
      readoutText(state({ referenceAreaM2: 0.098, referenceAreaSource: 'frontal' })),
    ).toContain('reference area 0.0980 m² (frontal cells)');
  });

  it('withholds Cd, fluctuation and drag while the run settles', () => {
    expect(
      readoutText(
        state({
          summary: { cd: null, status: { kind: 'settling', etaS: 12 }, samples: 8 },
          dragForceN: null,
          grid: { nx: 64, ny: 64, nz: 64 },
          gridBandPct: null,
        }),
      ),
    ).toBe('Cd not reported, settling, domain 64×64×64');
  });

  it('reports an unsteady run with its fluctuation', () => {
    expect(
      readoutText(
        state({
          summary: {
            cd: 0.55,
            status: { kind: 'unsteady', relStdPct: 4.26, driftPct: 1.9 },
            samples: 90,
          },
          speedMps: 20,
          dragForceN: 7.2,
          grid: { nx: 128, ny: 64, nz: 64 },
        }),
      ),
    ).toBe('Cd 0.55, unsteady, fluctuation 4.3%, drag 7.2 N at 20 m/s, domain 128×64×64');
  });
});
