import { describe, expect, it } from 'vitest';
import { DIRECTIONS, WEIGHTS } from '../../../src/lbm/lattice';
import {
  collide,
  collideWall,
  equilibrium,
  frictionVelocity,
  moments,
} from '../../../src/lbm/reference/collision';

type Tensor = readonly (readonly number[])[];
const csSquared = 1 / 3;
const smagorinskyCs = 0.1;

/** Solve nu_eff = nu_0 + Cs² |S| using Pi_ij = -2 rho cs² tau_eff S_ij. */
function expectedRelaxation(stress: Tensor, rho: number, tau0: number): number {
  let low = tau0;
  let high = tau0 + 1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const tau = (low + high) / 2;
    const strain = stress.flat().map((component) => -component / (2 * rho * csSquared * tau));
    const strainMagnitude = Math.sqrt(
      2 * strain.reduce((sum, component) => sum + component ** 2, 0),
    );
    const viscosity = (tau - 0.5) * csSquared;
    const target = (tau0 - 0.5) * csSquared + smagorinskyCs ** 2 * strainMagnitude;
    if (viscosity > target) high = tau;
    else low = tau;
  }
  return (low + high) / 2;
}

const stresses = [
  {
    name: 'pure normal stress',
    tensor: [
      [0.02, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  },
  {
    name: 'pure xy shear',
    tensor: [
      [0, 0.02, 0],
      [0.02, 0, 0],
      [0, 0, 0],
    ],
  },
  {
    name: 'pure xz shear',
    tensor: [
      [0, 0, -0.02],
      [0, 0, 0],
      [-0.02, 0, 0],
    ],
  },
  {
    name: 'pure yz shear',
    tensor: [
      [0, 0, 0],
      [0, 0, 0.02],
      [0, 0.02, 0],
    ],
  },
  {
    name: 'mixed normal and shear stress',
    tensor: [
      [0.02, -0.007, 0.011],
      [-0.007, -0.013, 0.005],
      [0.011, 0.005, 0.009],
    ],
  },
] as const;

for (const { name, tensor } of stresses) {
  it.each([0.6, 0.8, 1.5])(
    `relaxes ${name} using viscosity and strain definitions at tau0=%s`,
    (tau0) => {
      const rho = 1.02;
      const geq = new Float64Array(19);
      equilibrium(geq, { rho, velocity: [0, 0, 0] });
      // The second Hermite moment constructs a prescribed symmetric stress tensor.
      const perturbations = DIRECTIONS.map((direction, i) => {
        let contraction = 0;
        for (const a of [0, 1, 2] as const) {
          for (const b of [0, 1, 2] as const) {
            contraction += (direction[a] * direction[b] - (a === b ? csSquared : 0)) * tensor[a][b];
          }
        }
        return ((WEIGHTS[i] ?? NaN) * contraction) / (2 * csSquared ** 2);
      });
      const g = Float64Array.from(geq, (value, i) => value + (perturbations[i] ?? NaN));
      const tau = expectedRelaxation(tensor, rho, tau0);
      collide(g, geq, rho, tau0, 'trt', true, new Float64Array(19));
      for (let i = 0; i < 19; i += 1) {
        expect(g[i]).toBeCloseTo((geq[i] ?? NaN) + (perturbations[i] ?? NaN) * (1 - 1 / tau), 15);
      }
      expect(tau).toBeGreaterThan(tau0);
    },
  );
}

/** Independent invariant sums over shifted populations (g = f - w). */
function invariants(populations: Float64Array) {
  let mass = 0;
  const momentum: [number, number, number] = [0, 0, 0];
  for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const value = populations[i] ?? NaN;
    mass += value;
    momentum[0] += cx * value;
    momentum[1] += cy * value;
    momentum[2] += cz * value;
  }
  return { mass, momentum };
}

describe('regularized collisions', () => {
  it.each([false, true])('leaves equilibrium unchanged with LES=%s', (les) => {
    const rho = 1.04;
    const geq = new Float64Array(19);
    equilibrium(geq, { rho, velocity: [0.03, -0.02, 0.01] });
    const g = Float64Array.from(geq);
    collide(g, geq, rho, 0.8, 'reg', les, new Float64Array(19));
    for (let i = 0; i < 19; i += 1) expect(g[i]).toBe(geq[i]);
  });

  it('conserves mass and momentum in one collision', () => {
    const rho = 1.02;
    const geq = new Float64Array(19);
    equilibrium(geq, { rho, velocity: [0.05, -0.03, 0.02] });
    // Second-order perturbations keep mass and momentum at zero while loading the stress mode.
    const g = Float64Array.from(geq, (value, i) => {
      const [cx, cy, cz] = DIRECTIONS[i] ?? [0, 0, 0];
      const shape = (cx * cy + 0.5 * (cx * cx - cy * cy) + 0.5 * cx * cz) * 0.02;
      return value + (WEIGHTS[i] ?? NaN) * shape;
    });
    const initial = Float64Array.from(g);
    const before = invariants(g);
    collide(g, geq, rho, 0.8, 'reg', false, new Float64Array(19));
    const after = invariants(g);
    expect(after.mass).toBeCloseTo(before.mass, 15);
    for (const axis of [0, 1, 2] as const) {
      expect(after.momentum[axis] ?? NaN).toBeCloseTo(before.momentum[axis] ?? NaN, 15);
    }
    expect(g.some((value, i) => Math.abs(value - (initial[i] ?? NaN)) > 1e-9)).toBe(true);
  });
});

describe('wall law', () => {
  it('uses the viscous sublayer below y+ = 11.81 and the power law above it', () => {
    const viscous = frictionVelocity(1e-4, 1e-3);
    expect(viscous).toBeCloseTo(Math.sqrt((1e-3 * 1e-4) / 0.5), 15);
    expect((0.5 * viscous) / 1e-3).toBeLessThan(11.81);
    const turbulent = frictionVelocity(0.05, 1e-6);
    const yPlus = (0.5 * turbulent) / 1e-6;
    expect(yPlus).toBeGreaterThan(11.81);
    expect(0.05 / turbulent).toBeCloseTo(8.3 * yPlus ** (1 / 7), 9);
  });

  it('is continuous where the two branches meet', () => {
    // u+ = y+ = 11.81 at the junction gives speed = 11.81^2 nu / y.
    const viscosity = 1e-4;
    const speed = (11.81 ** 2 * viscosity) / 0.5;
    const below = frictionVelocity(speed * (1 - 1e-9), viscosity);
    const above = frictionVelocity(speed * (1 + 1e-9), viscosity);
    expect(above / below).toBeCloseTo(1, 4);
  });
});

describe('wall cell collision', () => {
  // Directions that arrive from a wall below the cell: c_z = +1.
  const fromFloor = [5, 9, 11, 16, 18];
  const state = { rho: 1.002, velocity: [0.04, -0.01, 0.002] as const };

  function wallCell(
    velocity: readonly [number, number, number] = state.velocity,
    wallIncoming: readonly number[] = fromFloor,
  ) {
    const geq = new Float64Array(19);
    equilibrium(geq, { rho: state.rho, velocity });
    const g = Float64Array.from(geq, (value, i) => value + 1e-4 * Math.sin(i));
    const applied = collideWall(
      g,
      geq,
      { rho: state.rho, velocity },
      wallIncoming,
      1e-6,
      new Float64Array(19),
    );
    return { g, geq, applied };
  }

  it('keeps mass and momentum', () => {
    const { g, applied } = wallCell();
    expect(applied).toBe(true);
    const kept = moments(g);
    expect(kept.rho).toBeCloseTo(state.rho, 14);
    for (const axis of [0, 1, 2])
      expect(kept.velocity[axis]).toBeCloseTo(state.velocity[axis] ?? NaN, 14);
  });

  it('gives the wall the wall-law shear along the slip and leaves the normal flux alone', () => {
    const { g, geq } = wallCell();
    const flux = (populations: Float64Array): [number, number, number] => {
      const sum: [number, number, number] = [0, 0, 0];
      for (const i of fromFloor) {
        const j = i % 2 === 1 ? i + 1 : i - 1;
        const [cx, cy, cz] = DIRECTIONS[j] ?? DIRECTIONS[0];
        const f = 2 * ((populations[j] ?? NaN) + (WEIGHTS[j] ?? NaN));
        sum[0] += cx * f;
        sum[1] += cy * f;
        sum[2] += cz * f;
      }
      return sum;
    };
    const [ux, uy] = state.velocity;
    const speed = Math.hypot(ux, uy);
    const shear = state.rho * frictionVelocity(speed, 1e-6) ** 2;
    const [fx, fy, fz] = flux(g);
    expect(fx).toBeCloseTo((shear * ux) / speed, 14);
    expect(fy).toBeCloseTo((shear * uy) / speed, 14);
    expect(fz).toBeCloseTo(flux(geq)[2], 14);
  });

  it('leaves a cell without slip to the bulk collision', () => {
    const { g, geq, applied } = wallCell([0, 0, 0.01]);
    expect(applied).toBe(false);
    expect(Array.from(g)).toEqual(Array.from(geq, (value, i) => value + 1e-4 * Math.sin(i)));
  });

  it('leaves a cell whose wall links barely carry flux along the slip to the bulk collision', () => {
    // Two axis links in a concave edge: their stress basis is about 2% of a flat face's.
    const { g, geq, applied } = wallCell(state.velocity, [3, 5]);
    expect(applied).toBe(false);
    expect(Array.from(g)).toEqual(Array.from(geq, (value, i) => value + 1e-4 * Math.sin(i)));
  });

  it('leaves a pore whose wall stress would create negative populations to the bulk collision', () => {
    const state = { rho: 1, velocity: [0.05, 0, 0] as const };
    const geq = new Float64Array(19);
    equilibrium(geq, state);
    const g = geq.slice();
    expect(collideWall(g, geq, state, [1, 2, 4, 8], 0.01, new Float64Array(19))).toBe(false);
    expect(g).toEqual(geq);
  });
});
