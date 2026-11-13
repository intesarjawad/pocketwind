import type { Walls } from '../../app/settings';
import { CELL_TYPE_MASK, CellType, NO_Q } from '../../geometry/voxel-grid';
import { DIRECTIONS, opp, WEIGHTS } from '../lattice';
import type { Layout } from '../layout';
import {
  collide,
  collideWall,
  equilibrium,
  type MacroState,
  moments,
  type Operator,
  type Vector,
} from './collision';

export type { MacroState, Operator, Vector } from './collision';

export type SolverOptions = {
  layout: Layout;
  tau0: number;
  operator?: Operator;
  les?: boolean;
  bodyForceLu?: Vector;
  /** Halfway bounce-back by default; `bouzidi` reads the packed link fractions in `flags`. */
  walls?: Walls;
  /** One flag per cell, or the packed geometry: flags, q offsets, then f32 link fractions. */
  flags?: Uint32Array;
  equilibriumState?: MacroState;
  initialState?: (x: number, y: number, z: number) => MacroState;
};

/** A short link pulls from `second`; -1 there, or q = 1/2, is halfway bounce-back. */
type WallLink = { cell: number; incoming: number; type: number; q: number; second: number };
const HALFWAY_Q = 0.5;
const REST: MacroState = { rho: 1, velocity: [0, 0, 0] };

function validateState({ rho, velocity }: MacroState): void {
  if (!Number.isFinite(rho) || rho <= 0) {
    throw new RangeError('Initial density must be finite and positive.');
  }
  if (!velocity.every(Number.isFinite)) {
    throw new RangeError('Initial velocity must be finite.');
  }
}

function referenceCellCount(options: SolverOptions): number {
  const { layout, tau0, flags } = options;
  for (const size of [layout.nx, layout.ny, layout.nz]) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new RangeError('Grid dimensions must be positive safe integers.');
    }
  }
  if (!Number.isFinite(tau0) || tau0 <= 0.5) {
    throw new RangeError('Relaxation time must be finite and greater than 0.5.');
  }
  const cells = layout.nx * layout.ny * layout.nz;
  if (!Number.isSafeInteger(cells) || cells * DIRECTIONS.length > 0x7fffffff) {
    throw new RangeError('Reference grid exceeds signed population indexing.');
  }
  if (flags && flags.length !== cells && flags.length < 2 * cells) {
    throw new RangeError('Flags must contain one entry per cell or the packed geometry.');
  }
  if (options.walls === 'bouzidi' && (flags?.length ?? 0) < 2 * cells) {
    throw new RangeError('Interpolated walls need the packed geometry with q offsets.');
  }
  return cells;
}

/** Float64 pull-stream/collide reference with periodic axes and explicit wall/EQ cells. */
export class CpuSolver {
  readonly layout: Layout;
  readonly cells: number;
  readonly tau0: number;
  readonly operator: Operator;
  readonly les: boolean;
  readonly walls: Walls;
  private readonly types: Uint8Array;
  private readonly sources: Int32Array;
  private readonly wallLinks: WallLink[] = [];
  /** Wall links are built in cell order; cell n owns links firstLink[n] to firstLink[n + 1]. */
  private readonly firstLink: Int32Array;
  private readonly eqCell = new Float64Array(DIRECTIONS.length);
  private readonly forceTerms = new Float64Array(DIRECTIONS.length);
  private readonly incoming = new Float64Array(DIRECTIONS.length);
  private readonly geq = new Float64Array(DIRECTIONS.length);
  private current: Float64Array;
  private next: Float64Array;

  constructor(options: SolverOptions) {
    this.cells = referenceCellCount(options);
    this.layout = { ...options.layout };
    this.tau0 = options.tau0;
    this.operator = options.operator ?? 'trt';
    this.les = options.les ?? false;
    this.walls = options.walls ?? 'bb';
    this.firstLink = new Int32Array(this.cells + 1);
    this.types = new Uint8Array(this.cells);
    this.sources = new Int32Array(this.cells * DIRECTIONS.length);
    this.current = new Float64Array(this.sources.length);
    this.next = new Float64Array(this.sources.length);
    const equilibriumState = options.equilibriumState ?? REST;
    validateState(equilibriumState);
    equilibrium(this.eqCell, equilibriumState);
    const [gx, gy, gz] = options.bodyForceLu ?? [0, 0, 0];
    if (![gx, gy, gz].every(Number.isFinite)) {
      throw new RangeError('Body acceleration must be finite.');
    }
    for (const [i, [cx, cy, cz]] of DIRECTIONS.entries()) {
      this.forceTerms[i] = 3 * (WEIGHTS[i] ?? NaN) * (cx * gx + cy * gy + cz * gz);
    }
    this.initialize(options);
    this.buildSources(options.walls === 'bouzidi' ? options.flags : undefined);
  }

  private initialize(options: SolverOptions): void {
    for (let cell = 0; cell < this.cells; cell += 1) {
      const type = (options.flags?.[cell] ?? CellType.FLUID) & CELL_TYPE_MASK;
      if (type > CellType.EQ) throw new RangeError('Unknown cell type.');
      this.types[cell] = type;
      const [x, y, z] = this.coordinates(cell);
      const state = options.initialState?.(x, y, z) ?? options.equilibriumState ?? REST;
      validateState(state);
      // Zeroed ping-pong storage defines resting wall outputs from initialization onward.
      if (type >= CellType.SOLID && type <= CellType.FLOOR) continue;
      equilibrium(this.geq, state);
      for (let i = 0; i < DIRECTIONS.length; i += 1) {
        this.current[i * this.cells + cell] =
          type === CellType.EQ ? (this.eqCell[i] ?? NaN) : (this.geq[i] ?? NaN);
      }
    }
    // Both states hold the start, as on the GPU, so the first force sample has a predecessor.
    this.next.set(this.current);
  }

  /** Latest post-collision populations, in 19 direction-major planes. */
  get populations(): Float64Array {
    return this.current;
  }

  private coordinates(cell: number): Vector {
    const { nx, ny } = this.layout;
    return [cell % nx, Math.floor(cell / nx) % ny, Math.floor(cell / (nx * ny))];
  }

  private buildSources(geometry: Uint32Array | undefined): void {
    for (let cell = 0; cell < this.cells; cell += 1) {
      this.firstLink[cell] = this.wallLinks.length;
      if (this.types[cell] !== CellType.FLUID) continue;
      let rank = 0;
      for (let i = 0; i < DIRECTIONS.length; i += 1) {
        const type = this.pullSource(cell, i);
        if (type === null) continue;
        this.addWallLink(cell, i, type, geometry ? this.linkFraction(geometry, cell, rank) : null);
        rank += 1;
      }
    }
    this.firstLink[this.cells] = this.wallLinks.length;
  }

  /** Set the pull source for one direction; returns the wall type when it bounces back. */
  private pullSource(cell: number, i: number): number | null {
    const [cx, cy, cz] = DIRECTIONS[i] ?? DIRECTIONS[0];
    const neighbour = this.wrapped(cell, -cx, -cy, -cz);
    const type = this.types[neighbour] ?? CellType.FLUID;
    const wall = type >= CellType.SOLID && type <= CellType.FLOOR;
    this.sources[i * this.cells + cell] = wall
      ? opp(i) * this.cells + cell
      : i * this.cells + neighbour;
    return wall ? type : null;
  }

  private addWallLink(cell: number, incoming: number, type: number, fraction: number | null): void {
    const q = fraction ?? HALFWAY_Q;
    const [cx, cy, cz] = DIRECTIONS[incoming] ?? DIRECTIONS[0];
    const second = this.wrapped(cell, cx, cy, cz);
    const shortLink = q < HALFWAY_Q && this.types[second] === CellType.FLUID;
    this.wallLinks.push({ cell, incoming, type, q, second: shortLink ? second : -1 });
  }

  private wrapped(cell: number, cx: number, cy: number, cz: number): number {
    const { nx, ny, nz } = this.layout;
    const [x, y, z] = this.coordinates(cell);
    return ((x + cx + nx) % nx) + nx * (((y + cy + ny) % ny) + ny * ((z + cz + nz) % nz));
  }

  private linkFraction(geometry: Uint32Array, cell: number, rank: number): number {
    const base = geometry[this.cells + cell] ?? NO_Q;
    if (base === NO_Q) return HALFWAY_Q;
    const index = 2 * this.cells + base + rank;
    if (index >= geometry.length) {
      throw new RangeError(`Wall-link fraction is missing at cell ${cell}.`);
    }
    const q = new Float32Array(geometry.buffer, geometry.byteOffset, geometry.length)[index] ?? NaN;
    if (!(q > 0 && q <= 1)) {
      throw new RangeError(`Wall-link fraction at cell ${cell} must be in (0, 1].`);
    }
    return q;
  }

  /** Linear Bouzidi reconstruction from a post-collision state. */
  private wallValue({ cell, incoming: i, q, second }: WallLink, state = this.current): number {
    const reflected = state[opp(i) * this.cells + cell] ?? NaN;
    if (q === HALFWAY_Q) return reflected;
    if (q < HALFWAY_Q) {
      if (second < 0) return reflected;
      return 2 * q * reflected + (1 - 2 * q) * (state[opp(i) * this.cells + second] ?? NaN);
    }
    return (reflected + (2 * q - 1) * (state[i * this.cells + cell] ?? NaN)) / (2 * q);
  }

  /** Recover macros from the latest post-collision state, without a half-force correction. */
  macroscopic(cell: number): MacroState {
    if (!Number.isInteger(cell) || cell < 0 || cell >= this.cells) {
      throw new RangeError('Cell index is outside the grid.');
    }
    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      this.incoming[i] = this.current[i * this.cells + cell] ?? NaN;
    }
    return moments(this.incoming);
  }

  /** Advance one lattice step, applying the uniform body force after collision. */
  step(): void {
    for (let cell = 0; cell < this.cells; cell += 1) {
      const type = this.types[cell];
      if (type === CellType.EQ) {
        const outlet = this.outletState(cell);
        if (outlet !== null) equilibrium(this.geq, outlet);
        const source = outlet === null ? this.eqCell : this.geq;
        for (let i = 0; i < DIRECTIONS.length; i += 1) {
          this.next[i * this.cells + cell] = source[i] ?? NaN;
        }
      } else if (type === CellType.FLUID) {
        this.advanceFluid(cell);
      }
    }
    [this.current, this.next] = [this.next, this.current];
  }

  /** The last x layer leaves at unit density with the velocity arriving from upstream. */
  private outletState(cell: number): MacroState | null {
    const { nx } = this.layout;
    if (nx < 2 || cell % nx !== nx - 1) return null;
    return { rho: 1, velocity: this.macroscopic(cell - 1).velocity };
  }

  private advanceFluid(cell: number): void {
    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      const source = this.sources[i * this.cells + cell] ?? -1;
      this.incoming[i] = this.current[source] ?? NaN;
    }
    if (this.walls === 'bouzidi') {
      const end = this.firstLink[cell + 1] ?? 0;
      for (let link = this.firstLink[cell] ?? 0; link < end; link += 1) {
        const wallLink = this.wallLinks[link];
        if (wallLink) this.incoming[wallLink.incoming] = this.wallValue(wallLink);
      }
    }
    const state = moments(this.incoming);
    equilibrium(this.geq, state);
    if (!this.collideAtWall(cell, state)) {
      collide(
        this.incoming,
        this.geq,
        state.rho,
        this.tau0,
        this.operator,
        this.les,
        this.forceTerms,
      );
    }
    this.store(cell);
  }

  /** The wall law belongs to the sub-grid model, as in the GPU kernel. */
  private collideAtWall(cell: number, state: MacroState): boolean {
    const first = this.firstLink[cell] ?? 0;
    const end = this.firstLink[cell + 1] ?? 0;
    if (!this.les || end === first) return false;
    const wallIncoming = this.wallLinks.slice(first, end).map((link) => link.incoming);
    const viscosity = (this.tau0 - 0.5) / 3;
    return collideWall(this.incoming, this.geq, state, wallIncoming, viscosity, this.forceTerms);
  }

  private store(cell: number): void {
    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      this.next[i * this.cells + cell] = this.incoming[i] ?? NaN;
    }
  }

  /**
   * Mean over the two latest states of the body momentum exchange c_j (f*_j + f_i), with
   * f_i the population the next step reconstructs, so halfway links give 2 c_j g*_j. The
   * rest weights carry the reference pressure and are left out, as on the GPU. Support and
   * floor links contribute no body force.
   */
  momentumExchange(): Vector {
    const latest = this.exchange(this.current);
    const previous = this.exchange(this.next);
    return [
      0.5 * (latest[0] + previous[0]),
      0.5 * (latest[1] + previous[1]),
      0.5 * (latest[2] + previous[2]),
    ];
  }

  private exchange(state: Float64Array): Vector {
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (const link of this.wallLinks) {
      if (link.type !== CellType.SOLID) continue;
      const j = opp(link.incoming);
      const [cx, cy, cz] = DIRECTIONS[j] ?? DIRECTIONS[0];
      const outgoing = state[j * this.cells + link.cell] ?? NaN;
      const exchange =
        outgoing + (this.walls === 'bouzidi' ? this.wallValue(link, state) : outgoing);
      fx += cx * exchange;
      fy += cy * exchange;
      fz += cz * exchange;
    }
    return [fx, fy, fz];
  }
}
