import { CELL_TYPE_MASK, CellType, type Layout } from '../geometry/voxel-grid';
import type { DomainBounds } from './lines-pipeline';

/** Smoke threads in the rake, released at evenly spaced heights on the inlet plane. */
export const RAKE_THREADS = 36;
/**
 * Dye ports on the body, as wind tunnels seed a wake the rake cannot reach: three on its
 * back, the middle one filling the dead air at mid-base, one where the upper surface separates, one at the top of the base and one below
 * the body, under the nose of a flat underside or where a rounded one separates.
 * None sits under the rear of the body: at these Reynolds numbers the gap there is dead
 * air on the centre plane, as the flow under the body leaves the plane sideways.
 */
export const PORTS = 6;
const BACK_PORTS = 3;
export const THREADS = RAKE_THREADS + PORTS;
/**
 * Ring slots per thread. The gap under a body runs at about a hundredth of the free
 * stream at these Reynolds numbers, so a thread there needs tens of flow-throughs of
 * release before its front comes to rest; with fewer slots its front left the ring first.
 */
export const RING_SLOTS = 8192;
/** A new puff leaves every rake nozzle once per this many frames. */
export const RELEASE_EVERY_FRAMES = 2;
/** Consecutive puffs farther apart than this, in cells, are drawn as a torn thread. */
export const TEAR_CELLS = 3;
export const SMOKE_PARAMS_BYTES = 48;
export const RAKE_X = 2;

// Below this width the plate is cropped to the nose of the body and the gap under it, as
// a page crops a plate to its subject; a phone is too narrow to hold the wake as well.
const COMPACT_WIDTH = 700;
// On a phone the plate's number and title sit above the picture, under the masthead.
const COMPACT_TOP_PX = 172;

export type PlateView = { readonly width: number; readonly height: number };

/** Cell coordinates map to CSS pixels as x * scale + originX and groundY - z * scale. */
export type PlateFrame = {
  readonly scale: number;
  readonly originX: number;
  readonly groundY: number;
  /** Highest z cell inside the plate; the rake stops below it. */
  readonly zTop: number;
  readonly compact: boolean;
};

/** Fit the centre plane into the band between the masthead and the caption. */
export function fitPlate(
  view: PlateView,
  grid: Layout,
  body: DomainBounds,
  mode: 'default' | 'complete' | 'embed' = 'default',
): PlateFrame {
  const { width, height } = view;
  if (!(width > 0 && height > 0) || !(grid.nx >= 5 && grid.nz >= 5)) {
    throw new RangeError('A plate needs a positive view and a grid of at least five cells.');
  }
  const compact = width < COMPACT_WIDTH;
  const bodyLength = Math.max(1, body.max[0] - body.min[0]);
  const top = mode === 'embed' ? 12 : compact ? COMPACT_TOP_PX : Math.max(120, 0.14 * height);
  const bottom =
    mode === 'embed'
      ? height - 12
      : compact
        ? 0.53 * height
        : height - Math.min(320, Math.max(260, 0.34 * height));
  // The desktop plate starts at the rake, so threads enter from its edge.
  const x0 = compact ? Math.max(RAKE_X, body.min[0] - 0.3 * bodyLength) : RAKE_X;
  const x1 = compact
    ? Math.min(grid.nx - 2, body.min[0] + (mode === 'default' ? 0.85 : 1.4) * bodyLength)
    : grid.nx - 2;
  const zSpan = Math.min(grid.nz - 2, Math.max(1.9 * body.max[2], 0.45 * grid.nz));
  const scale = Math.max(1e-3, Math.min(width / (x1 - x0), (bottom - top) / zSpan));
  const originX =
    compact && mode === 'default' ? -x0 * scale : (width - (x1 - x0) * scale) / 2 - x0 * scale;
  const zTop = Math.min(grid.nz - 2, (bottom - top) / scale);
  return { scale, originX, groundY: bottom, zTop, compact };
}

/**
 * Rake heights in cells: the lowest thread clears the floor, and the highest stays a
 * band below the top of the plate, which holds the exposure labels.
 */
export function rakeSpan(frame: PlateFrame, grid: Layout): readonly [number, number] {
  const low = 1.5;
  const high = Math.max(low + 1, Math.min(grid.nz - 2, frame.zTop - 4.5));
  return [low, high];
}

export function plateToCss(frame: PlateFrame, x: number, z: number): readonly [number, number] {
  return [frame.originX + x * frame.scale, frame.groundY - z * frame.scale];
}

export type SmokeParams = {
  readonly grid: Layout;
  readonly plane: number;
  readonly release: number;
  readonly releasing: boolean;
  readonly steps: number;
  readonly rake: readonly [number, number];
};

/** Pack the advection uniform: grid and plane, ring state, then rake and step count. */
export function packSmokeParams(params: SmokeParams): ArrayBuffer {
  const { grid, plane, release, releasing, steps, rake } = params;
  if (
    !Number.isSafeInteger(plane) ||
    plane < 0 ||
    plane >= grid.ny ||
    !Number.isSafeInteger(release) ||
    release < 0 ||
    release >= 2 ** 24 ||
    !(steps >= 0)
  ) {
    throw new RangeError('Smoke needs a plane inside the grid and a release index below 2^24.');
  }
  const buffer = new ArrayBuffer(SMOKE_PARAMS_BYTES);
  new Uint32Array(buffer).set([
    grid.nx,
    grid.ny,
    grid.nz,
    plane,
    THREADS,
    RING_SLOTS,
    release,
    releasing ? 1 : 0,
  ]);
  new Float32Array(buffer).set([RAKE_X, rake[0], rake[1], steps], 8);
  return buffer;
}

/**
 * The leading puff of each live thread, in cells. Each record is x, z, the release
 * the puff left the rake in (0 for the first, which leads the smoke) and its density
 * (0 once it has died).
 */
export function smokeFront(records: Float32Array): (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = [];
  for (let offset = 0; offset + 4 <= records.length; offset += 4) {
    const [x = 0, z = 0, index = -1, density = 0] = records.subarray(offset, offset + 4);
    if (density > 0 && index === 0) cells.push([x, z]);
  }
  return cells;
}

// The upper surface is taken to separate where, behind its crest, it first falls this
// many cells over the next SEPARATION_RUN columns: about 20 degrees.
const SEPARATION_DROP = 1.5;
const SEPARATION_RUN = 4;
// An underside whose lowest row runs this share of the body's length is flat.
const FLAT_UNDERSIDE = 0.25;

/**
 * Dye ports as x, z cell pairs. Three are the first fluid cell behind the body in evenly
 * spaced rows of the centre plane, inside the wake. The rest sit just off the body: above
 * the separation line of its upper surface and behind the top of its base, where the shear
 * layer leaves it, and below the body: under the nose of a flat underside, or below the
 * separation line of a rounded one. A port with no body to sit on gets (-1, -1).
 */
export function dyePorts(
  flags: Uint32Array,
  grid: Layout,
  plane: number,
  heights: readonly [number, number],
): Float32Array {
  const ports = new Float32Array(PORTS * 2).fill(-1);
  const solid = (x: number, z: number) =>
    ((flags[x + grid.nx * (plane + grid.ny * z)] ?? 0) & CELL_TYPE_MASK) === CellType.SOLID;
  const xs = Array.from({ length: grid.nx - 2 }, (_, index) => index + 1);
  const backwards = [...xs].reverse();
  const rearOf = (z: number) => backwards.find((x) => solid(x, z));
  const rows = Array.from({ length: grid.nz - 2 }, (_, index) => index + 1).filter(
    (z) => rearOf(z) !== undefined,
  );
  const fluid = (x: number, z: number) =>
    x >= 1 && x < grid.nx - 1 && z >= 1 && z < grid.nz - 1 && !solid(x, z);
  const place = (slot: number, x: number | undefined, z: number) => {
    if (x !== undefined && fluid(x, z)) ports.set([x, z], slot * 2);
  };
  const [low, high] = heights;
  for (let port = 0; port < BACK_PORTS; port += 1) {
    const z = Math.round(low + ((high - low) * (port + 0.5)) / BACK_PORTS);
    const rear = z >= 1 && z < grid.nz - 1 ? rearOf(z) : undefined;
    place(port, rear === undefined ? undefined : rear + 1, z);
  }
  const top = rows[rows.length - 1];
  const bottom = rows[0];
  if (top === undefined || bottom === undefined) return ports;
  const base = Math.max(...rows.map((z) => rearOf(z) ?? 0));
  const baseTop = rows.filter((z) => rearOf(z) === base).pop() ?? top;
  // The upper profile, a sharp roof edge and a smooth body alike: the highest solid cell
  // of each column, or 0 past the body.
  const crestOf = (x: number) => [...rows].reverse().find((z) => solid(x, z)) ?? 0;
  const crest = xs.find((x) => crestOf(x) === top) ?? base;
  const separation = xs.find(
    (x) =>
      x >= crest &&
      x <= base &&
      crestOf(x + 1) < crestOf(x) &&
      crestOf(x) - crestOf(x + SEPARATION_RUN) >= SEPARATION_DROP,
  );
  place(BACK_PORTS, separation, separation === undefined ? 0 : crestOf(separation) + 1);
  place(BACK_PORTS + 1, base + 1, baseTop + 1);
  // A flat underside gets its port under the nose, at the start of the flat; a rounded one
  // gets it where the lower surface separates, as the upper one does, since its lowest
  // cells sit mid-belly in the slowest air under the body.
  const flat = xs.filter((x) => solid(x, bottom));
  const front = xs.find((x) => rows.some((z) => solid(x, z))) ?? base;
  if (flat.length >= FLAT_UNDERSIDE * (base - front)) {
    place(BACK_PORTS + 2, flat[0], bottom - 1);
    return ports;
  }
  const keelOf = (x: number) => rows.find((z) => solid(x, z)) ?? grid.nz;
  const keel = flat[flat.length - 1] ?? base;
  const lower = xs.find(
    (x) =>
      x >= keel &&
      x <= base &&
      keelOf(x + 1) > keelOf(x) &&
      keelOf(x + SEPARATION_RUN) < grid.nz &&
      keelOf(x + SEPARATION_RUN) - keelOf(x) >= SEPARATION_DROP,
  );
  place(BACK_PORTS + 2, lower, lower === undefined ? 0 : keelOf(lower) - 1);
  return ports;
}

/** Physical seconds per lattice step: the inlet's lattice speed over its physical speed. */
export function secondsPerStep(cellSizeM: number, speedMps: number, uLu: number): number {
  if (!(cellSizeM > 0 && speedMps > 0 && uLu > 0)) {
    throw new RangeError('Cell size, speed and lattice speed must be positive.');
  }
  return (uLu * cellSizeM) / speedMps;
}
