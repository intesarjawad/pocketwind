import { describe, expect, it } from 'vitest';
import { runPoiseuille, runTaylorGreen } from '../../../src/lbm/reference/cases';

describe('analytic flow verification', () => {
  it('recovers Taylor-Green decay and second-order velocity convergence', () => {
    const coarse = runTaylorGreen(16);
    const medium = runTaylorGreen(32, true);
    const fine = runTaylorGreen(64);
    expect(medium.decayRate).not.toBeNull();
    expect(Math.abs((medium.decayRate ?? NaN) / medium.expectedDecayRate - 1)).toBeLessThan(0.01);
    const orders = [Math.log2(coarse.error / medium.error), Math.log2(medium.error / fine.error)];
    for (const order of orders) {
      expect(order).toBeGreaterThan(1.8);
      expect(order).toBeLessThan(2.2);
    }
  }, 120000);

  it.each([0.6, 0.8, 1.5, 3.0])(
    'recovers Poiseuille flow with TRT at tau0=%s',
    (tau0) => {
      const result = runPoiseuille(tau0);
      expect(result.maxChange).toBeLessThan(1e-12);
      expect(Math.abs(result.maxSpeedErrorPct)).toBeLessThan(1);
      expect(result.profileErrorPct).toBeLessThan(1);
      expect(result.force[0]).toBeCloseTo(result.expectedForce[0], 8);
      expect(Math.abs(result.force[1])).toBeLessThan(1e-14);
      expect(Math.abs(result.force[2])).toBeLessThan(1e-14);
    },
    120000,
  );

  it('exposes BGK wall-location sensitivity at tau0=3', () => {
    const result = runPoiseuille(3, 'bgk');
    expect(result.maxChange).toBeLessThan(1e-12);
    expect(Math.abs(result.maxSpeedErrorPct)).toBeGreaterThan(5);
  }, 120000);

  it.each([0.6, 1.5])(
    'recovers Poiseuille flow between interpolated walls at q=0.3 with TRT at tau0=%s',
    (tau0) => {
      const result = runPoiseuille(tau0, 'trt', { q: 0.3 });
      expect(result.maxChange).toBeLessThan(1e-12);
      expect(result.profileErrorPct).toBeLessThan(1);
      // Steady state returns the whole body-force impulse through the walls.
      expect(Math.abs(result.force[0] / result.expectedForce[0] - 1)).toBeLessThan(1e-6);
      expect(Math.abs(result.force[1])).toBeLessThan(1e-14);
      expect(Math.abs(result.force[2])).toBeLessThan(1e-14);
    },
    120000,
  );

  it.each([0.25, 0.75])(
    'converges at second order between interpolated walls at q=%s',
    (q) => {
      const runs = [8, 16, 32].map((fluidNodes) => {
        const result = runPoiseuille(0.8, 'trt', { q, fluidNodes });
        expect(result.maxChange).toBeLessThan(1e-12);
        return { height: fluidNodes - 1 + 2 * q, error: result.profileErrorPct };
      });
      for (let i = 1; i < runs.length; i += 1) {
        const coarse = runs[i - 1];
        const fine = runs[i];
        if (!coarse || !fine) throw new Error('Missing channel run.');
        const order = Math.log(coarse.error / fine.error) / Math.log(fine.height / coarse.height);
        expect(order).toBeGreaterThan(1.8);
        expect(order).toBeLessThan(2.2);
      }
    },
    120000,
  );

  it('matches the analytic profile at every resolution when q=0.5 coincides with halfway walls', () => {
    for (const fluidNodes of [8, 16, 32]) {
      const result = runPoiseuille(0.8, 'trt', { q: 0.5, fluidNodes });
      expect(result.maxChange).toBeLessThan(1e-12);
      expect(result.profileErrorPct).toBeLessThan(1e-4);
    }
  }, 120000);

  it.each([0.6, 0.8, 1.5])(
    'recovers Poiseuille flow with the regularized operator at tau0=%s',
    (tau0) => {
      const result = runPoiseuille(tau0, 'reg');
      expect(result.maxChange).toBeLessThan(1e-12);
      expect(Math.abs(result.maxSpeedErrorPct)).toBeLessThan(1);
      expect(result.profileErrorPct).toBeLessThan(1);
      expect(result.force[0]).toBeCloseTo(result.expectedForce[0], 8);
      expect(Math.abs(result.force[1])).toBeLessThan(1e-14);
      expect(Math.abs(result.force[2])).toBeLessThan(1e-14);
    },
    120000,
  );
});
