import { describe, expect, it } from 'vitest';
import { CellType, NO_Q } from '../../../src/geometry/voxel-grid';
import { DIRECTIONS, WEIGHTS } from '../../../src/lbm/lattice';
import { frictionVelocity } from '../../../src/lbm/reference/collision';
import { CpuSolver } from '../../../src/lbm/reference/cpu-solver';

describe('CPU reference boundaries and shifted storage', () => {
  it.each([CellType.SOLID, CellType.SUPPORT, CellType.FLOOR])(
    'holds wall type %s at rest in both buffers from initialization',
    (type) => {
      const solver = new CpuSolver({
        layout: { nx: 3, ny: 1, nz: 1 },
        tau0: 0.8,
        flags: new Uint32Array([CellType.FLUID, type, CellType.EQ]),
        equilibriumState: { rho: 1.02, velocity: [0.05, 0, 0] },
        initialState: () => ({ rho: 1.03, velocity: [0.02, -0.01, 0.005] }),
      });
      for (let step = 0; step <= 4; step += 1) {
        expect(solver.macroscopic(1)).toEqual({ rho: 1, velocity: [0, 0, 0] });
        for (let i = 0; i < 19; i += 1) expect(solver.populations[i * solver.cells + 1]).toBe(0);
        solver.step();
      }
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid supplied density %s', (rho) => {
    const options = { layout: { nx: 1, ny: 1, nz: 1 }, tau0: 0.8 };
    const state = { rho, velocity: [0, 0, 0] as const };
    expect(() => new CpuSolver({ ...options, initialState: () => state })).toThrow(/density/i);
    expect(() => new CpuSolver({ ...options, equilibriumState: state })).toThrow(/density/i);
  });

  it.each([0, 1, 2] as const)('rejects non-finite supplied velocity component %s', (axis) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const velocity: [number, number, number] = [0, 0, 0];
      velocity[axis] = value;
      const options = { layout: { nx: 1, ny: 1, nz: 1 }, tau0: 0.8 };
      const state = { rho: 1, velocity };
      expect(() => new CpuSolver({ ...options, initialState: () => state })).toThrow(/velocity/i);
      expect(() => new CpuSolver({ ...options, equilibriumState: state })).toThrow(/velocity/i);
    }
  });

  it('keeps a periodic rest field exactly at zero in shifted storage', () => {
    const solver = new CpuSolver({ layout: { nx: 4, ny: 4, nz: 4 }, tau0: 0.8 });
    solver.step();
    expect(solver.populations.every((g) => g === 0)).toBe(true);
    expect(solver.macroscopic(0)).toEqual({ rho: 1, velocity: [0, 0, 0] });
  });

  it.each(['trt', 'bgk'] as const)(
    'preserves uniform moving equilibrium with %s and LES',
    (operator) => {
      const state = { rho: 1.02, velocity: [0.02, -0.01, 0.005] as const };
      const solver = new CpuSolver({
        layout: { nx: 4, ny: 3, nz: 2 },
        tau0: 0.8,
        operator,
        les: true,
        initialState: () => state,
      });
      for (let step = 0; step < 10; step += 1) solver.step();
      for (let cell = 0; cell < solver.cells; cell += 1) {
        const actual = solver.macroscopic(cell);
        expect(actual.rho).toBeCloseTo(state.rho, 14);
        for (const axis of [0, 1, 2] as const) {
          expect(actual.velocity[axis]).toBeCloseTo(state.velocity[axis], 14);
        }
      }
    },
  );

  it('prescribes the inlet, carries the upstream velocity to the outlet and skips forcing there', () => {
    const flags = new Uint32Array([CellType.EQ, CellType.FLUID, CellType.EQ]);
    const solver = new CpuSolver({
      layout: { nx: 3, ny: 1, nz: 1 },
      tau0: 0.8,
      flags,
      equilibriumState: { rho: 1, velocity: [0.05, 0, 0] },
      initialState: () => ({ rho: 1, velocity: [0, 0, 0] }),
      bodyForceLu: [0.001, 0, 0],
    });
    for (let step = 0; step < 5; step += 1) {
      const upstream = solver.macroscopic(1).velocity;
      solver.step();
      expect(solver.macroscopic(0).velocity[0]).toBeCloseTo(0.05, 14);
      expect(solver.macroscopic(0).rho).toBeCloseTo(1, 14);
      const outlet = solver.macroscopic(2);
      expect(outlet.rho).toBeCloseTo(1, 14);
      for (const [axis, component] of upstream.entries()) {
        expect(outlet.velocity[axis]).toBeCloseTo(component, 14);
      }
    }
    expect(solver.macroscopic(1).velocity[0]).toBeGreaterThan(0);
  });

  it('adds the prescribed population force after collision', () => {
    const acceleration = [1e-5, -2e-5, 3e-5] as const;
    const solver = new CpuSolver({
      layout: { nx: 2, ny: 2, nz: 2 },
      tau0: 0.8,
      bodyForceLu: acceleration,
    });
    solver.step();
    for (const [i, c] of DIRECTIONS.entries()) {
      const dot = c[0] * acceleration[0] + c[1] * acceleration[1] + c[2] * acceleration[2];
      expect(solver.populations[i * solver.cells]).toBeCloseTo(3 * (WEIGHTS[i] ?? NaN) * dot, 18);
    }
    expect(solver.macroscopic(0).rho).toBeCloseTo(1, 14);
    for (const axis of [0, 1, 2] as const) {
      expect(solver.macroscopic(0).velocity[axis]).toBeCloseTo(acceleration[axis], 16);
    }
  });

  it.each(DIRECTIONS.slice(1).map((c, index) => [index + 1, c] as const))(
    'pulls direction %s across periodic boundaries before collision',
    (i, [cx, cy, cz]) => {
      const solver = new CpuSolver({ layout: { nx: 5, ny: 5, nz: 5 }, tau0: 0.8 });
      const perturbation = 0.001;
      solver.populations[i * solver.cells] = perturbation;
      solver.step();
      const destination = ((cx + 5) % 5) + 5 * (((cy + 5) % 5) + 5 * ((cz + 5) % 5));
      for (let cell = 0; cell < solver.cells; cell += 1) {
        const actual = solver.macroscopic(cell);
        const excess = cell === destination ? perturbation : 0;
        expect(actual.rho).toBeCloseTo(1 + excess, 14);
        expect(actual.velocity[0]).toBeCloseTo((cx * excess) / (1 + excess), 14);
        expect(actual.velocity[1]).toBeCloseTo((cy * excess) / (1 + excess), 14);
        expect(actual.velocity[2]).toBeCloseTo((cz * excess) / (1 + excess), 14);
      }
    },
  );
});

describe('momentum exchange', () => {
  it.each([CellType.SOLID, CellType.SUPPORT, CellType.FLOOR])('handles wall type %s', (type) => {
    const layout = { nx: 5, ny: 5, nz: 5 };
    const flags = new Uint32Array(125);
    const solid = 2 + 5 * (2 + 5 * 2);
    flags[solid] = type;
    const solver = new CpuSolver({ layout, tau0: 0.8, flags });
    const restForce = solver.momentumExchange();
    expect(Math.hypot(...restForce)).toBeLessThan(1e-15);
    solver.populations[solver.cells + solid - 1] = 0.01;
    const force = solver.momentumExchange();
    // Half of 2 g*_1: the sample averages with the previous state, still at rest.
    expect(force[0]).toBeCloseTo(type === CellType.SOLID ? 0.01 : 0, 15);
    expect(Math.abs(force[1])).toBeLessThan(1e-15);
    expect(Math.abs(force[2])).toBeLessThan(1e-15);
    solver.step();
    const reflected = solver.macroscopic(solid - 1);
    expect(reflected.rho).toBeCloseTo(1.01, 14);
    expect(reflected.velocity[0]).toBeCloseTo(-0.01 / 1.01, 14);
  });
});

describe('paired momentum exchange', () => {
  it('averages the two latest states, so a period-two oscillation cancels', () => {
    const layout = { nx: 5, ny: 5, nz: 5 };
    const flags = new Uint32Array(125);
    const solid = 2 + 5 * (2 + 5 * 2);
    flags[solid] = CellType.SOLID;
    const solver = new CpuSolver({ layout, tau0: 0.8, flags });
    solver.populations[solver.cells + solid - 1] = 0.01;
    solver.step();
    solver.populations[solver.cells + solid - 1] = -0.01;
    expect(Math.abs(solver.momentumExchange()[0])).toBeLessThan(1e-15);
  });

  it('feels no reference pressure on a body cut by its support', () => {
    const layout = { nx: 5, ny: 5, nz: 5 };
    const flags = new Uint32Array(125);
    const body = 2 + 5 * (2 + 5 * 2);
    flags[body] = CellType.SOLID;
    flags[body - 25] = CellType.SUPPORT;
    const solver = new CpuSolver({ layout, tau0: 0.8, flags });
    for (let step = 0; step < 3; step += 1) solver.step();
    expect(Math.hypot(...solver.momentumExchange())).toBeLessThan(1e-15);
  });
});

describe('wall function', () => {
  // A solid plane at z = 0 in a periodic box: the layers above and below it are wall cells.
  const layout = { nx: 4, ny: 4, nz: 4 };
  const flags = new Uint32Array(64);
  flags.fill(CellType.SOLID, 0, 16);
  const tau0 = 0.5 + 3 * 1e-5;

  /** Wall-law shear along x on the latest state, from the moments the collision kept. */
  function expectedShear(solver: CpuSolver): number {
    let sum = 0;
    for (const z of [1, 3]) {
      for (let cell = 16 * z; cell < 16 * (z + 1); cell += 1) {
        const { rho, velocity } = solver.macroscopic(cell);
        const speed = Math.hypot(velocity[0], velocity[1]);
        sum += (rho * frictionVelocity(speed, 1e-5) ** 2 * velocity[0]) / speed;
      }
    }
    return sum;
  }

  it('makes each face of the plate take the wall-law shear', () => {
    const solver = new CpuSolver({
      layout,
      tau0,
      les: true,
      flags,
      initialState: () => ({ rho: 1, velocity: [0.05, 0.01, 0] }),
    });
    solver.step();
    const first = expectedShear(solver);
    solver.step();
    const second = expectedShear(solver);
    expect(solver.momentumExchange()[0]).toBeCloseTo((first + second) / 2, 12);
    expect(first).toBeGreaterThan(0);
  });
});

describe('interpolated walls', () => {
  const layout = { nx: 5, ny: 5, nz: 5 };
  const cells = 125;
  const solid = 2 + 5 * (2 + 5 * 2);
  const fluid = solid - 1;

  // The fluid cell left of the solid pulls direction 2 (-x) from the wall.
  function packed(solids: readonly number[], fractions: readonly number[]): Uint32Array {
    const geometry = new Uint32Array(2 * cells + fractions.length);
    for (const cell of solids) geometry[cell] = CellType.SOLID;
    geometry.fill(NO_Q, cells, 2 * cells);
    if (fractions.length > 0) geometry[cells + fluid] = 0;
    new Float32Array(geometry.buffer, 8 * cells).set(fractions);
    return geometry;
  }

  function solver(geometry: Uint32Array): CpuSolver {
    return new CpuSolver({ layout, tau0: 0.8, walls: 'bouzidi', flags: geometry });
  }

  it('interpolates a short link from the second fluid node', () => {
    const reference = solver(packed([solid], [0.25]));
    reference.populations[cells + fluid] = 0.01;
    reference.populations[cells + fluid - 1] = 0.004;
    // 2q g*_1(x_f) + (1 - 2q) g*_1(x_f - e_x) = 0.5 * 0.01 + 0.5 * 0.004, averaged with rest.
    expect(reference.momentumExchange()[0]).toBeCloseTo((0.01 + 0.007) / 2, 15);
  });

  it('interpolates a long link from the population leaving the wall', () => {
    const reference = solver(packed([solid], [0.75]));
    reference.populations[cells + fluid] = 0.01;
    reference.populations[2 * cells + fluid] = 0.004;
    // (g*_1 + (2q - 1) g*_2) / 2q = (0.01 + 0.5 * 0.004) / 1.5 = 0.008, averaged with rest.
    expect(reference.momentumExchange()[0]).toBeCloseTo((0.01 + 0.008) / 2, 15);
    reference.step();
    const state = reference.macroscopic(fluid);
    expect(state.rho).toBeCloseTo(1.008, 14);
    expect(state.velocity[0]).toBeCloseTo(-0.008 / 1.008, 14);
  });

  it('reduces to halfway bounce-back at q = 1/2 and without a fraction', () => {
    for (const geometry of [packed([solid], [0.5]), packed([solid], [])]) {
      const reference = solver(geometry);
      reference.populations[cells + fluid] = 0.01;
      expect(reference.momentumExchange()[0]).toBeCloseTo(0.01, 15);
    }
  });

  it('falls back to halfway when the second node of a short link is not fluid', () => {
    // Directions 1 and 2 are both walls at the fluid cell, packed in direction order.
    const reference = solver(packed([solid, solid - 2], [0.25, 0.25]));
    reference.populations[cells + fluid] = 0.01;
    expect(reference.momentumExchange()[0]).toBeCloseTo(0.01, 15);
  });

  it('rejects missing packed geometry and invalid fractions', () => {
    const flags = new Uint32Array(cells);
    flags[solid] = CellType.SOLID;
    expect(() => new CpuSolver({ layout, tau0: 0.8, walls: 'bouzidi', flags })).toThrow(
      /packed geometry/,
    );
    for (const q of [0, -0.25, 1.5, NaN]) {
      expect(() => solver(packed([solid], [q]))).toThrow(/fraction/);
    }
    const truncated = packed([solid], [0.25]).subarray(0, 2 * cells);
    expect(() => solver(truncated)).toThrow(/missing/);
  });
});
