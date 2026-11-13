// Standard-air density at 20 degrees Celsius, in kilograms per cubic metre.
export const RHO_AIR = 1.204;
export const AIR_DENSITY = RHO_AIR;

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive.`);
  }
}

/** Cd times the stated reference area, the drag area used by the force formula. */
export function cdaM2(cd: number, areaM2: number): number {
  if (!Number.isFinite(cd) || cd < 0) {
    throw new RangeError('Drag coefficient must be finite and non-negative.');
  }
  positiveFinite(areaM2, 'Reference area in square metres');
  return cd * areaM2;
}

/** Dynamic pressure times drag area, the force on a body at the stated speed. */
export function dragForceFromCda(cda: number, speedMps: number, densityKgm3 = RHO_AIR): number {
  if (!Number.isFinite(cda) || cda < 0) {
    throw new RangeError('CdA must be finite and non-negative.');
  }
  positiveFinite(speedMps, 'Speed in metres per second');
  positiveFinite(densityKgm3, 'Air density in kilograms per cubic metre');
  return 0.5 * densityKgm3 * speedMps * speedMps * cda;
}

/** Convert a coefficient on a stated reference area to a force in newtons. */
export function dragForceN(
  cd: number,
  areaM2: number,
  speedMps: number,
  densityKgm3 = RHO_AIR,
): number {
  return dragForceFromCda(cdaM2(cd, areaM2), speedMps, densityKgm3);
}

/** Dynamic pressure of the freestream, in pascals. */
export function dynamicPressurePa(speedMps: number, densityKgm3 = RHO_AIR): number {
  positiveFinite(speedMps, 'Speed in metres per second');
  positiveFinite(densityKgm3, 'Air density in kilograms per cubic metre');
  return 0.5 * densityKgm3 * speedMps * speedMps;
}

/** Reciprocal of dynamic pressure times area, so a force times this value is Cd. */
export function cdPerNewton(areaM2: number, speedMps: number, densityKgm3 = RHO_AIR): number {
  positiveFinite(areaM2, 'Reference area in square metres');
  return 1 / (dynamicPressurePa(speedMps, densityKgm3) * areaM2);
}
