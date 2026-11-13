import type { Mesh } from './stl';

type Axis = 'x' | 'y' | 'z';
type Vector = Record<Axis, number>;
type Bounds = { min: Vector; max: Vector };
type GridDimensions = { nx: number; ny: number; nz: number };
type Orientation = { flowAxis: Axis; flowSign: 1 | -1; upAxis: Axis };
type Placement = Orientation & {
  lengthCells: number;
  layout: GridDimensions;
  floor: boolean;
  supports?: Mesh;
};

// Placement and blockage limits from the tunnel geometry specification.
const NOSE_FRACTION_NX = 0.25;
const LENGTH_CAP_NX = 0.4;
const BLOCKAGE_MAX = 0.08;
const FLOOR_WALL_Z_CELLS = 0.5;
const AXES = ['x', 'y', 'z'] as const;

function vertexAt(mesh: Mesh, index: number): Vector {
  const x = mesh.positions[index];
  const y = mesh.positions[index + 1];
  const z = mesh.positions[index + 2];
  if (x === undefined || y === undefined || z === undefined) {
    throw new RangeError('Mesh positions must contain complete vertices.');
  }
  return { x, y, z };
}

function meshBounds(mesh: Mesh): Bounds {
  if (mesh.triangleCount < 1 || mesh.positions.length !== mesh.triangleCount * 9) {
    throw new RangeError('Mesh positions must match a positive triangle count.');
  }
  const min: Vector = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vector = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const vertex = vertexAt(mesh, index);
    for (const axis of AXES) {
      if (!Number.isFinite(vertex[axis])) {
        throw new RangeError('Mesh coordinates must be finite.');
      }
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  }
  return { min, max };
}

function dimensions(bounds: Bounds): Vector {
  return {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
}

function longestExtent(extents: Vector): number {
  const longest = Math.max(extents.x, extents.y, extents.z);
  if (longest === 0) throw new RangeError('Mesh must have a nonzero extent.');
  return longest;
}

function validateLayout(layout: GridDimensions): void {
  for (const size of [layout.nx, layout.ny, layout.nz]) {
    if (!Number.isSafeInteger(size) || size < 2) {
      throw new RangeError('Grid dimensions must be integers of at least two cells.');
    }
  }
}

/** Choose Z up and positive flow along the longest horizontal extent. */
export function defaultOrientation(mesh: Mesh): Orientation {
  const extents = dimensions(meshBounds(mesh));
  return { flowAxis: extents.y > extents.x ? 'y' : 'x', flowSign: 1, upAxis: 'z' };
}

/** Size a dropped body using its default orientation and frontal bounding box. */
export function defaultLengthCells(mesh: Mesh, layout: GridDimensions, _floor: boolean): number {
  validateLayout(layout);
  const extents = dimensions(meshBounds(mesh));
  const longest = longestExtent(extents);
  const frontalArea = Math.min(extents.x, extents.y) * extents.z;
  // Round the blockage-limited length down to whole cells to stay below the cap.
  const blockageLength =
    frontalArea === 0
      ? Infinity
      : Math.floor(longest * Math.sqrt((BLOCKAGE_MAX * layout.ny * layout.nz) / frontalArea));
  return Math.min(LENGTH_CAP_NX * layout.nx, blockageLength);
}

function lateralAxis(orientation: Orientation): { axis: Axis; sign: number } {
  const { flowAxis, upAxis, flowSign } = orientation;
  if (flowAxis === upAxis) throw new RangeError('Flow and up axes must differ.');
  const axis = AXES.find((candidate) => candidate !== flowAxis && candidate !== upAxis);
  if (axis === undefined) throw new RangeError('Flow and up must be coordinate axes.');
  // y = up × flow keeps every orientation right-handed, including reversed flow.
  const positive =
    (upAxis === 'z' && flowAxis === 'x') ||
    (upAxis === 'x' && flowAxis === 'y') ||
    (upAxis === 'y' && flowAxis === 'z');
  return { axis, sign: positive ? flowSign : -flowSign };
}

function transformedMesh(mesh: Mesh, transform: (vertex: Vector) => Vector): Mesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    const point = transform(vertexAt(mesh, index));
    positions[index] = point.x;
    positions[index + 1] = point.y;
    positions[index + 2] = point.z;
  }
  return { positions, triangleCount: mesh.triangleCount };
}

/** Rotate and scale body and supports together, then place them in lattice cells. */
export function placeMesh(mesh: Mesh, options: Placement): { body: Mesh; supports: Mesh | null } {
  const { lengthCells, flowAxis, flowSign, upAxis, layout, floor, supports } = options;
  validateLayout(layout);
  if (!Number.isFinite(lengthCells) || lengthCells <= 0) {
    throw new RangeError('Body length in cells must be finite and positive.');
  }
  const lateral = lateralAxis(options);
  const bodyBounds = meshBounds(mesh);
  const supportBounds = supports === undefined ? null : meshBounds(supports);
  const scale = lengthCells / longestExtent(dimensions(bodyBounds));
  const nose = flowSign === 1 ? bodyBounds.min[flowAxis] : bodyBounds.max[flowAxis];
  const centreY = (bodyBounds.min[lateral.axis] + bodyBounds.max[lateral.axis]) / 2;
  const centreZ = (bodyBounds.min[upAxis] + bodyBounds.max[upAxis]) / 2;
  const lowest = Math.min(bodyBounds.min[upAxis], supportBounds?.min[upAxis] ?? Infinity);
  const transform = (vertex: Vector): Vector => ({
    x: NOSE_FRACTION_NX * layout.nx + flowSign * (vertex[flowAxis] - nose) * scale,
    y: layout.ny / 2 + lateral.sign * (vertex[lateral.axis] - centreY) * scale,
    z: floor
      ? FLOOR_WALL_Z_CELLS + (vertex[upAxis] - lowest) * scale
      : layout.nz / 2 + (vertex[upAxis] - centreZ) * scale,
  });
  return {
    body: transformedMesh(mesh, transform),
    supports: supports === undefined ? null : transformedMesh(supports, transform),
  };
}
