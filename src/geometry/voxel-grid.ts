export type Layout = { nx: number; ny: number; nz: number };

export const CellType = { FLUID: 0, SOLID: 1, SUPPORT: 2, FLOOR: 3, EQ: 4 } as const;
export const CELL_TYPE_MASK = 7;
export const NO_Q = 0xffffffff;

export type VoxelGrid = Layout & {
  geometry: Uint32Array;
  boundaryCells: Uint32Array;
  solidCells: number;
  frontalCells: number;
  blockage: number;
  watertight: boolean;
  missedLinks: number;
};
