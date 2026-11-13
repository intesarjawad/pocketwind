export type Field = {
  nx: number;
  ny: number;
  nz: number;
  cellSizeM: number;
  rho: Float32Array;
  velocity: Float32Array;
};

const FLOAT_BYTES = 4;
const VECTOR_COMPONENTS = 3;
const NEWLINE = 0x0a;

function checkDimensions(nx: number, ny: number, nz: number): number {
  const cells = nx * ny * nz;
  if (![nx, ny, nz].every((size) => Number.isSafeInteger(size) && size > 0)) {
    throw new RangeError('Field dimensions must be positive integers.');
  }
  if (!Number.isSafeInteger(cells)) throw new RangeError('The field is too large to address.');
  return cells;
}

/**
 * Write a legacy VTK binary STRUCTURED_POINTS file so ParaView and other
 * readers can open a solved field without a custom importer.
 */
export function writeVtk(field: Field): Uint8Array {
  const { nx, ny, nz, cellSizeM, rho, velocity } = field;
  const cells = checkDimensions(nx, ny, nz);
  if (rho.length !== cells) throw new RangeError(`rho must hold ${cells} values.`);
  if (velocity.length !== cells * VECTOR_COMPONENTS) {
    throw new RangeError(`velocity must hold ${cells * VECTOR_COMPONENTS} values.`);
  }
  if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) {
    throw new RangeError('cellSizeM must be a positive finite number.');
  }

  const header = new TextEncoder().encode(
    [
      '# vtk DataFile Version 3.0',
      'PocketWind field',
      'BINARY',
      'DATASET STRUCTURED_POINTS',
      `DIMENSIONS ${nx} ${ny} ${nz}`,
      'ORIGIN 0 0 0',
      `SPACING ${cellSizeM} ${cellSizeM} ${cellSizeM}`,
      `POINT_DATA ${cells}`,
      'SCALARS rho float 1',
      'LOOKUP_TABLE default',
      '',
    ].join('\n'),
  );
  const vectors = new TextEncoder().encode('VECTORS velocity float\n');
  const bytes = new Uint8Array(
    header.length +
      cells * FLOAT_BYTES +
      1 +
      vectors.length +
      cells * VECTOR_COMPONENTS * FLOAT_BYTES +
      1,
  );
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  let offset = header.length;
  for (let cell = 0; cell < cells; cell += 1) {
    view.setFloat32(offset, rho[cell] ?? 0, false);
    offset += FLOAT_BYTES;
  }
  bytes[offset] = NEWLINE;
  offset += 1;
  bytes.set(vectors, offset);
  offset += vectors.length;
  for (let cell = 0; cell < cells; cell += 1) {
    for (let axis = 0; axis < VECTOR_COMPONENTS; axis += 1) {
      view.setFloat32(offset, velocity[cell * VECTOR_COMPONENTS + axis] ?? 0, false);
      offset += FLOAT_BYTES;
    }
  }
  bytes[offset] = NEWLINE;
  return bytes;
}
