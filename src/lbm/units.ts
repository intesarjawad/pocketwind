// Fixed inlet speed keeps the lattice Mach number near 0.087.
export const U_LU = 0.05;
// Kinematic viscosity of air at 20 degrees Celsius, in square metres per second.
export const NU_AIR = 1.5e-5;
// The Ahmed preset at tier M stays finite for six flow-throughs at 40 m/s only from this
// floor up (1e-6 to 1e-3 diverge within 700 steps); the readout states the Reynolds number it implies.
export const NU_MIN_LU = 1e-2;

type UnitInputs = { refLengthCells: number } & (
  | { speedMps: number; refLengthM: number }
  | { re: number }
);
type LatticeUnits = { re: number; viscosityLu: number };

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive.`);
  }
}

/** Convert physical flow or a prescribed Reynolds number to lattice viscosity. */
export function physicalToLattice(inputs: UnitInputs): LatticeUnits {
  positiveFinite(inputs.refLengthCells, 'Reference length in cells');
  let re: number;
  if ('re' in inputs) {
    re = inputs.re;
  } else {
    positiveFinite(inputs.speedMps, 'Speed in metres per second');
    positiveFinite(inputs.refLengthM, 'Reference length in metres');
    re = (inputs.speedMps * inputs.refLengthM) / NU_AIR;
  }
  positiveFinite(re, 'Reynolds number');
  const viscosityLu = Math.max(NU_MIN_LU, (U_LU * inputs.refLengthCells) / re);
  positiveFinite(viscosityLu, 'Lattice viscosity');
  return { re, viscosityLu };
}

/**
 * Reciprocal of lattice dynamic pressure times frontal area in cells, so a
 * solver force times this value is Cd. Lattice density is one.
 */
export function cdPerLatticeForce(frontalCells: number): number {
  positiveFinite(frontalCells, 'Frontal area in cells');
  return 1 / (0.5 * U_LU * U_LU * frontalCells);
}
