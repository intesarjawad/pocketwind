import { DIRECTIONS, opp, WEIGHTS } from '../lattice';

export type Vector = readonly [number, number, number];
export type MacroState = { rho: number; velocity: Vector };
export type Operator = 'trt' | 'reg' | 'bgk';

// The TRT magic parameter fixes the halfway bounce-back wall location.
const LAMBDA = 3 / 16;
const SMAGORINSKY_CS = 0.1;

type Stress = {
  readonly xx: number;
  readonly yy: number;
  readonly zz: number;
  readonly xy: number;
  readonly xz: number;
  readonly yz: number;
};

/** Write the shifted D3Q19 equilibrium into a reusable cell buffer. */
export function equilibrium(
  target: Float64Array,
  { rho, velocity: [ux, uy, uz] }: MacroState,
): void {
  const speedSquared = ux * ux + uy * uy + uz * uz;
  for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const cu = cx * ux + cy * uy + cz * uz;
    target[i] =
      (WEIGHTS[i] ?? NaN) * (rho - 1 + rho * (3 * cu + 4.5 * cu * cu - 1.5 * speedSquared));
  }
}

/** Recover density and velocity from one cell's shifted populations. */
export function moments(populations: Float64Array): MacroState {
  let rho = 1;
  let ux = 0;
  let uy = 0;
  let uz = 0;
  for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const g = populations[i] ?? NaN;
    rho += g;
    ux += cx * g;
    uy += cy * g;
    uz += cz * g;
  }
  return { rho, velocity: [ux / rho, uy / rho, uz / rho] };
}

function nonEquilibriumStress(g: Float64Array, geq: Float64Array): Stress {
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const neq = (g[i] ?? NaN) - (geq[i] ?? NaN);
    xx += cx * cx * neq;
    yy += cy * cy * neq;
    zz += cz * cz * neq;
    xy += cx * cy * neq;
    xz += cx * cz * neq;
    yz += cy * cz * neq;
  }
  return { xx, yy, zz, xy, xz, yz };
}

function relaxationTime(tau0: number, rho: number, { xx, yy, zz, xy, xz, yz }: Stress): number {
  const q = xx * xx + yy * yy + zz * zz + 2 * (xy * xy + xz * xz + yz * yz);
  return (
    0.5 *
    (tau0 + Math.sqrt(tau0 * tau0 + (18 * Math.SQRT2 * SMAGORINSKY_CS ** 2 * Math.sqrt(q)) / rho))
  );
}

/** Relax only the projected second moment, keeping mass and momentum exact. */
function regularize(
  g: Float64Array,
  geq: Float64Array,
  rho: number,
  omegaPlus: number,
  { xx, yy, zz, xy, xz, yz }: Stress,
  forceTerms: Float64Array,
): void {
  const traceThird = (xx + yy + zz) / 3;
  for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
    const projected =
      cx * cx * xx +
      cy * cy * yy +
      cz * cz * zz +
      2 * (cx * cy * xy + cx * cz * xz + cy * cz * yz) -
      traceThird;
    const force = i === 0 ? 0 : rho * (forceTerms[i] ?? NaN);
    g[i] = (geq[i] ?? NaN) + (1 - omegaPlus) * 4.5 * (WEIGHTS[i] ?? NaN) * projected + force;
  }
}

/** Relax pairs with plus and minus rates; equal rates reduce TRT to BGK. */
function relaxPairs(
  g: Float64Array,
  geq: Float64Array,
  rho: number,
  omegaPlus: number,
  omegaMinus: number,
  forceTerms: Float64Array,
): void {
  g[0] = (g[0] ?? NaN) - omegaPlus * ((g[0] ?? NaN) - (geq[0] ?? NaN));
  for (let i = 1; i < DIRECTIONS.length; i += 2) {
    const j = i + 1;
    const gi = g[i] ?? NaN;
    const gj = g[j] ?? NaN;
    const eqi = geq[i] ?? NaN;
    const eqj = geq[j] ?? NaN;
    const even = 0.5 * omegaPlus * (gi + gj - eqi - eqj);
    const odd = 0.5 * omegaMinus * (gi - gj - eqi + eqj);
    g[i] = gi - even - odd + rho * (forceTerms[i] ?? NaN);
    g[j] = gj - even + odd + rho * (forceTerms[j] ?? NaN);
  }
}

/** Collide in place; force terms contain 3 w_i (c_i dot acceleration). */
export function collide(
  g: Float64Array,
  geq: Float64Array,
  rho: number,
  tau0: number,
  operator: Operator,
  les: boolean,
  forceTerms: Float64Array,
): void {
  const stress = les || operator === 'reg' ? nonEquilibriumStress(g, geq) : null;
  const tau = les && stress !== null ? relaxationTime(tau0, rho, stress) : tau0;
  const omegaPlus = 1 / tau;
  if (operator === 'reg' && stress !== null) {
    regularize(g, geq, rho, omegaPlus, stress, forceTerms);
    return;
  }
  const omegaMinus = operator === 'bgk' ? omegaPlus : 1 / (LAMBDA / (tau - 0.5) + 0.5);
  relaxPairs(g, geq, rho, omegaPlus, omegaMinus, forceTerms);
}

// Werner and Wengle's wall law, u+ = 8.3 y+^(1/7), joined to u+ = y+ where both give 11.81.
const WALL_A = 8.3;
const WALL_B = 1 / 7;
const WALL_SUBLAYER = 11.81;
// Halfway bounce-back puts the first fluid node half a cell from the wall.
const WALL_DISTANCE = 0.5;

/** Friction velocity for a slip speed half a cell from the wall, in lattice units. */
export function frictionVelocity(speed: number, viscosity: number): number {
  const viscous = Math.sqrt((viscosity * speed) / WALL_DISTANCE);
  if ((WALL_DISTANCE * viscous) / viscosity <= WALL_SUBLAYER) return viscous;
  return ((speed * (viscosity / WALL_DISTANCE) ** WALL_B) / WALL_A) ** (1 / (1 + WALL_B));
}

/**
 * Set a wall cell's post-collision state so that the bounce-back flux along its slip
 * direction is the wall-law shear, with the smallest stress that does so. `wallIncoming`
 * lists the directions that arrive from a wall. Returns false, leaving `g` untouched, when
 * the cell has no slip, too few links carrying flux, or a nonphysical wall stress.
 */
export function collideWall(
  g: Float64Array,
  geq: Float64Array,
  { rho, velocity }: MacroState,
  wallIncoming: readonly number[],
  viscosity: number,
  forceTerms: Float64Array,
): boolean {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let exposed = 0;
  for (const i of wallIncoming) {
    const [cx, cy, cz] = DIRECTIONS[i] ?? DIRECTIONS[0];
    const w = WEIGHTS[i] ?? NaN;
    nx += w * cx;
    ny += w * cy;
    nz += w * cz;
    exposed += w;
  }
  let [sx, sy, sz] = velocity;
  const normalLength = Math.hypot(nx, ny, nz);
  if (normalLength > 1e-3) {
    const normal = (sx * nx + sy * ny + sz * nz) / (normalLength * normalLength);
    sx -= normal * nx;
    sy -= normal * ny;
    sz -= normal * nz;
  }
  const speed = Math.hypot(sx, sy, sz);
  if (speed < 1e-7) return false;
  const [tx, ty, tz] = [sx / speed, sy / speed, sz / speed];
  const uTau = frictionVelocity(speed, viscosity);
  // One flat face has link weights summing to 1/6.
  const shear = 6 * exposed * rho * uTau * uTau;
  let flux = 0;
  const b = { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 };
  for (const i of wallIncoming) {
    const j = opp(i);
    const [cx, cy, cz] = DIRECTIONS[j] ?? DIRECTIONS[0];
    const along = cx * tx + cy * ty + cz * tz;
    flux += 2 * along * ((geq[j] ?? NaN) + (WEIGHTS[j] ?? NaN));
    const s = 9 * (WEIGHTS[j] ?? NaN) * along;
    b.xx += s * (cx * cx - 1 / 3);
    b.yy += s * (cy * cy - 1 / 3);
    b.zz += s * (cz * cz - 1 / 3);
    b.xy += s * cx * cy;
    b.xz += s * cx * cz;
    b.yz += s * cy * cz;
  }
  const norm =
    b.xx * b.xx + b.yy * b.yy + b.zz * b.zz + 2 * (b.xy * b.xy + b.xz * b.xz + b.yz * b.yz);
  // A flat face gives 0.5; links that carry a tenth of that along the slip would need an
  // outsized stress to set the wall shear, so the cell keeps the plain collision.
  if (norm < 0.05) return false;
  // The post-collision stress is (shear - flux) b / |b|^2, independent of the relaxation rate;
  // regularize writes geq + (1 - omega) times the stress it is given.
  const post = new Float64Array(19);
  regularize(post, geq, rho, 1 - (shear - flux) / norm, b, forceTerms);
  // Pores can demand an inadmissible stress; shifted g must still give physical f = g + w >= 0.
  if (post.some((value, i) => value + (WEIGHTS[i] ?? NaN) < 0)) return false;
  g.set(post);
  return true;
}
