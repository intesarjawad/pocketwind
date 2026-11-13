function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive.`);
  }
}

/**
 * Projected SOLID cells behind a dropped model, or the registry area converted
 * from square millimetres by the square of the cell size for a preset.
 */
export function referenceAreaCells(
  presetAreaMm2: number | undefined,
  frontalCells: number,
  cellSizeMm: number,
): number {
  if (presetAreaMm2 === undefined) {
    if (!Number.isSafeInteger(frontalCells) || frontalCells < 0) {
      throw new RangeError('Frontal cell count must be a non-negative safe integer.');
    }
    return frontalCells;
  }
  positiveFinite(presetAreaMm2, 'Preset reference area in square millimetres');
  positiveFinite(cellSizeMm, 'Cell size in millimetres');
  return presetAreaMm2 / (cellSizeMm * cellSizeMm);
}

/**
 * Convert the projected SOLID-cell count to physical frontal area.
 * SUPPORT and FLOOR cells are excluded by the caller because they carry no body force.
 */
export function frontalAreaM2(frontalCells: number, cellSizeM: number): number {
  if (!Number.isSafeInteger(frontalCells) || frontalCells < 0) {
    throw new RangeError('Frontal cell count must be a non-negative safe integer.');
  }
  positiveFinite(cellSizeM, 'Cell size in metres');
  return frontalCells * cellSizeM * cellSizeM;
}
