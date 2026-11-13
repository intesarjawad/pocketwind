import type { DragStatus, DragSummary } from '../forces/drag-stats';
import { samplingText } from './figure-grade';

export const READOUT_INTERVAL_MS = 1000;

export type GridShape = {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
};

export type ReferenceAreaSource = 'preset' | 'frontal';

export type ReadoutState = {
  readonly summary: DragSummary;
  readonly speedMps: number;
  readonly dragForceN: number | null;
  readonly grid: GridShape;
  /** The area definition used for Cd, so a preset and a voxel frontal area stay distinguishable. */
  readonly referenceAreaM2?: number;
  readonly referenceAreaSource?: ReferenceAreaSource;
  /** Grid-refinement band, when a convergence study is available. */
  readonly gridBandPct?: number | null;
  /** Reynolds number the lattice actually runs at, when the viscosity floor raised it above nominal viscosity. */
  readonly effectiveRe?: number;
  /** Share of the tunnel's cross-section the body's frontal area fills, in percent. */
  readonly blockagePct?: number;
};

export function statusText(status: DragStatus): string {
  if (status.kind === 'settling') return 'settling';
  const pct = status.relStdPct;
  return `${status.kind}, fluctuation ${pct < 1 ? 'under 1%' : `${pct.toFixed(1)}%`}`;
}

/** One sentence so the live region never dribbles values out of order. */
export function readoutText(state: ReadoutState): string {
  const { summary, speedMps, dragForceN, grid, gridBandPct } = state;
  const cd = summary.cd === null ? 'Cd not reported' : `Cd ${summary.cd.toFixed(2)}`;
  const parts = [
    cd,
    summary.semPct === undefined || summary.semPct === null
      ? statusText(summary.status)
      : `${summary.status.kind}, ${samplingText(summary)}`,
  ];
  if (dragForceN !== null) parts.push(`drag ${dragForceN.toFixed(1)} N at ${speedMps} m/s`);
  parts.push(`domain ${grid.nx}×${grid.ny}×${grid.nz}`);
  if (state.effectiveRe !== undefined) {
    parts.push(`simulated at Re ${Math.round(state.effectiveRe)} (viscosity floor)`);
  }
  if (state.referenceAreaM2 !== undefined && state.referenceAreaSource !== undefined) {
    const source = state.referenceAreaSource === 'preset' ? 'preset' : 'frontal cells';
    parts.push(`reference area ${state.referenceAreaM2.toFixed(4)} m² (${source})`);
  }
  if (gridBandPct !== undefined && gridBandPct !== null && Number.isFinite(gridBandPct)) {
    parts.push(`grid band ±${gridBandPct.toFixed(1)}%`);
  }
  return parts.join(', ');
}

/**
 * The live region keeps its own cadence: samples arrive per frame, but a screen
 * reader hears at most one sentence per second, and the newest state wins.
 */
export function createReadout(options: { now?: () => number } = {}): {
  element: HTMLElement;
  update: (state: ReadoutState) => void;
  dispose: () => void;
} {
  const now = options.now ?? (() => Date.now());
  const element = document.createElement('p');
  element.className = 'readout';
  element.setAttribute('role', 'status');

  let lastWrite = Number.NEGATIVE_INFINITY;
  let pending: ReadoutState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function write(state: ReadoutState): void {
    element.textContent = readoutText(state);
    lastWrite = now();
  }

  function update(state: ReadoutState): void {
    pending = state;
    if (timer !== undefined) return;
    const elapsed = now() - lastWrite;
    if (elapsed >= READOUT_INTERVAL_MS) {
      pending = undefined;
      write(state);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (pending !== undefined) {
        const latest = pending;
        pending = undefined;
        write(latest);
      }
    }, READOUT_INTERVAL_MS - elapsed);
  }

  return {
    element,
    update,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
