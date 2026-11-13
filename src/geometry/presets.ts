import type { Mesh } from './stl';

// Ahmed et al. (1984) reference body, in millimetres, as in assets/scad/ahmed-25.scad.
const AHMED_LENGTH_MM = 1044;
const AHMED_WIDTH_MM = 389;
const AHMED_HEIGHT_MM = 288;
const AHMED_FRONT_RADIUS_MM = 100;
// The rear slant is 222 mm long, measured along the slant.
const AHMED_SLANT_LENGTH_MM = 222;
const AHMED_SLANT_RAD = (25 * Math.PI) / 180;
// The body stands on four 30 mm stilts with 50 mm ground clearance.
const AHMED_LIFT_MM = 50;
const STILT_DIAMETER_MM = 30;
const STILT_X_MM = [202, 672] as const;
const STILT_Y_MM = 163.5;
const FRONT_ROUND_SEGMENTS = 12;
const STILT_SEGMENTS = 16;

const CUBE_SIDE_MM = 100;
const SPHERE_DIAMETER_MM = 100;
const SPHERE_SEGMENTS = 24;
const SPHERE_RINGS = 16;

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];

function pointAt(points: readonly Point[], index: number): Point {
  const point = points[index];
  if (point === undefined) throw new RangeError('Preset mesh point index is out of range.');
  return point;
}

function buildMesh(triangles: readonly Triangle[]): Mesh {
  const positions = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const triangle of triangles) {
    for (const point of triangle) {
      positions.set(point, offset);
      offset += 3;
    }
  }
  return { positions, triangleCount: triangles.length };
}

/** A cross-section normal to x: the body spans these y and z ranges at this station. */
type Station = { x: number; yHalf: number; zMin: number; zMax: number };

function stationCorners(station: Station): Point[] {
  const { x, yHalf, zMin, zMax } = station;
  return [
    [x, -yHalf, zMin],
    [x, yHalf, zMin],
    [x, yHalf, zMax],
    [x, -yHalf, zMax],
  ];
}

function quad(triangles: Triangle[], a: Point, b: Point, c: Point, d: Point): void {
  triangles.push([a, b, c], [a, c, d]);
}

/** Join rectangular stations into a closed solid, capped at both ends. */
function loft(stations: readonly Station[]): Mesh {
  const rings = stations.map(stationCorners);
  const triangles: Triangle[] = [];
  for (let index = 0; index + 1 < rings.length; index += 1) {
    const near = rings[index] ?? [];
    const far = rings[index + 1] ?? [];
    for (let corner = 0; corner < 4; corner += 1) {
      const next = (corner + 1) % 4;
      quad(
        triangles,
        pointAt(near, corner),
        pointAt(far, corner),
        pointAt(far, next),
        pointAt(near, next),
      );
    }
  }
  const first = rings[0] ?? [];
  const last = rings[rings.length - 1] ?? [];
  quad(triangles, pointAt(first, 0), pointAt(first, 1), pointAt(first, 2), pointAt(first, 3));
  quad(triangles, pointAt(last, 0), pointAt(last, 3), pointAt(last, 2), pointAt(last, 1));
  return buildMesh(triangles);
}

/**
 * The Ahmed body above its stilts: the four front edges are rounded with the
 * 100 mm radius, so every station of the nose is the full section inset by the
 * same amount, and the roof falls along the rear slant.
 */
function ahmedMesh(): Mesh {
  const radius = AHMED_FRONT_RADIUS_MM;
  const halfWidth = AHMED_WIDTH_MM / 2;
  const bottom = AHMED_LIFT_MM;
  const top = AHMED_LIFT_MM + AHMED_HEIGHT_MM;
  const nose: Station[] = [];
  for (let segment = 0; segment <= FRONT_ROUND_SEGMENTS; segment += 1) {
    const angle = (segment / FRONT_ROUND_SEGMENTS) * (Math.PI / 2);
    const inset = radius * (1 - Math.sin(angle));
    nose.push({
      x: radius * (1 - Math.cos(angle)),
      yHalf: halfWidth - inset,
      zMin: bottom + inset,
      zMax: top - inset,
    });
  }
  const slantStart = AHMED_LENGTH_MM - AHMED_SLANT_LENGTH_MM * Math.cos(AHMED_SLANT_RAD);
  const slantDrop = AHMED_SLANT_LENGTH_MM * Math.sin(AHMED_SLANT_RAD);
  return loft([
    ...nose,
    { x: slantStart, yHalf: halfWidth, zMin: bottom, zMax: top },
    { x: AHMED_LENGTH_MM, yHalf: halfWidth, zMin: bottom, zMax: top - slantDrop },
  ]);
}

/** A closed prism standing on z = 0 with its axis at (x, y). */
function cylinder(x: number, y: number, diameter: number, height: number): Triangle[] {
  const radius = diameter / 2;
  const rim = (z: number, segment: number): Point => {
    const theta = (segment / STILT_SEGMENTS) * 2 * Math.PI;
    return [x + radius * Math.cos(theta), y + radius * Math.sin(theta), z];
  };
  const triangles: Triangle[] = [];
  for (let segment = 0; segment < STILT_SEGMENTS; segment += 1) {
    const next = segment + 1;
    quad(triangles, rim(0, segment), rim(0, next), rim(height, next), rim(height, segment));
    triangles.push([[x, y, 0], rim(0, next), rim(0, segment)]);
    triangles.push([[x, y, height], rim(height, segment), rim(height, next)]);
  }
  return triangles;
}

/** The four stilts under the Ahmed body, from the floor to its underside. */
function stiltsMesh(): Mesh {
  return buildMesh(
    STILT_X_MM.flatMap((x) =>
      [-STILT_Y_MM, STILT_Y_MM].flatMap((y) => cylinder(x, y, STILT_DIAMETER_MM, AHMED_LIFT_MM)),
    ),
  );
}

function cubeMesh(): Mesh {
  const half = CUBE_SIDE_MM / 2;
  return loft([
    { x: 0, yHalf: half, zMin: 0, zMax: CUBE_SIDE_MM },
    { x: CUBE_SIDE_MM, yHalf: half, zMin: 0, zMax: CUBE_SIDE_MM },
  ]);
}

/** Latitude and longitude sphere; poles carry one vertex per meridian. */
function sphereMesh(): Mesh {
  const radius = SPHERE_DIAMETER_MM / 2;
  const vertex = (ring: number, segment: number): Point => {
    const phi = (ring / SPHERE_RINGS) * Math.PI;
    const theta = (segment / SPHERE_SEGMENTS) * 2 * Math.PI;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ];
  };
  const triangles: Triangle[] = [];
  for (let ring = 0; ring < SPHERE_RINGS; ring += 1) {
    for (let segment = 0; segment < SPHERE_SEGMENTS; segment += 1) {
      const next = (segment + 1) % SPHERE_SEGMENTS;
      const top = vertex(ring, segment);
      const bottom = vertex(ring + 1, segment);
      const bottomNext = vertex(ring + 1, next);
      const topNext = vertex(ring, next);
      if (ring !== 0) triangles.push([top, bottom, topNext]);
      if (ring !== SPHERE_RINGS - 1) triangles.push([topNext, bottom, bottomNext]);
    }
  }
  return buildMesh(triangles);
}

/** Built-in bodies are label-only in links and run files, so their shapes live here. */
export function presetMesh(presetId: string): Mesh | null {
  if (presetId === 'ahmed-25') return ahmedMesh();
  if (presetId === 'sphere') return sphereMesh();
  if (presetId === 'cube') return cubeMesh();
  return null;
}

/** Supports stand under a body but carry no body force; only the Ahmed body has them. */
export function presetSupports(presetId: string): Mesh | null {
  return presetId === 'ahmed-25' ? stiltsMesh() : null;
}
