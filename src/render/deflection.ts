import { PARTICLE_BYTES } from './particle-layout';

const FLOATS = PARTICLE_BYTES / 4;
// A particle that turns by about six degrees has left the free stream.
const MIN_CROSS_STREAM_FRACTION = 0.1;
// Below this a step is rounding or a respawn (prev equals pos), not motion.
const MIN_STEP_CELLS = 1e-3;
// A few stray particles at the inlet do not make smoke.
export const MIN_DEFLECTED_PARTICLES = 16;

/**
 * Count records whose last step bent away from the flow, which runs along grid x.
 * Records are position, age, previous position and generation, as the renderer stores them.
 */
export function countDeflected(records: Float32Array, count: number): number {
  let deflected = 0;
  for (let id = 0; id < count; id += 1) {
    const base = id * FLOATS;
    const dx = (records[base] ?? NaN) - (records[base + 4] ?? NaN);
    const dy = (records[base + 1] ?? NaN) - (records[base + 5] ?? NaN);
    const dz = (records[base + 2] ?? NaN) - (records[base + 6] ?? NaN);
    const cross = dy * dy + dz * dz;
    const length = dx * dx + cross;
    if (
      Number.isFinite(length) &&
      length >= MIN_STEP_CELLS * MIN_STEP_CELLS &&
      cross >= MIN_CROSS_STREAM_FRACTION * MIN_CROSS_STREAM_FRACTION * length
    ) {
      deflected += 1;
    }
  }
  return deflected;
}

export function particlesDeflected(records: Float32Array, count: number): boolean {
  return countDeflected(records, count) >= MIN_DEFLECTED_PARTICLES;
}
