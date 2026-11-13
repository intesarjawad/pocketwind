type GridSample = { h: number; value: number };

export type GridConvergence =
  | { kind: 'monotone'; order: number; extrapolated: number; gciFinePct: number }
  | { kind: 'oscillatory' | 'divergent' | 'insufficient' };

const MAX_ROUNDS = 100;
const SETTLE_TOLERANCE = 1e-10;
// Celik et al. recommend 1.25 when the observed order comes from a three-grid estimate.
const SAFETY_FACTOR = 1.25;

/** Fixed-point iteration, because the closed form only holds when both refinement ratios are equal. */
function observedOrder(ratio: number, r21: number, r32: number, s: number): number | undefined {
  let order = 1;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const q = Math.log((r21 ** order - s) / (r32 ** order - s));
    const next = Math.abs(Math.log(Math.abs(ratio)) + q) / Math.log(r21);
    if (Math.abs(next - order) < SETTLE_TOLERANCE) return next;
    order = next;
  }
  return undefined;
}

/**
 * Estimate the observed order, the Richardson extrapolation and the fine-grid
 * grid convergence index from three grid levels. Only the three finest levels
 * are used; extra coarser levels cannot improve a three-point estimate.
 */
export function gridConvergence(rows: readonly GridSample[]): GridConvergence {
  const [fine, mid, coarse] = [...rows].sort((a, b) => a.h - b.h);
  if (!fine || !mid || !coarse) return { kind: 'insufficient' };
  const r21 = mid.h / fine.h;
  const r32 = coarse.h / mid.h;
  const e21 = mid.value - fine.value;
  const e32 = coarse.value - mid.value;
  if (e21 === 0 || e32 === 0) return { kind: 'insufficient' };
  const ratio = e32 / e21;
  if (ratio < 0) return { kind: 'oscillatory' };
  // Differences that grow toward the fine grid mean the sequence is not converging.
  if (Math.abs(e21) >= Math.abs(e32)) return { kind: 'divergent' };
  const order = observedOrder(ratio, r21, r32, Math.sign(ratio));
  if (order === undefined) return { kind: 'divergent' };
  const factor = r21 ** order - 1;
  const extrapolated = (r21 ** order * fine.value - mid.value) / factor;
  const gciFinePct =
    (100 * SAFETY_FACTOR * Math.abs((fine.value - mid.value) / fine.value)) / factor;
  return { kind: 'monotone', order, extrapolated, gciFinePct };
}
