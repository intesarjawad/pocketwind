import type { Operator, Storage, Walls } from '../app/settings';

/**
 * Solver levels that the current shaders implement. A flip case can only run
 * when its factor has a second entry, so these lists gate the validation matrix.
 */
export const OPERATORS = ['trt', 'reg'] as const satisfies readonly Operator[];
export const WALLS = ['bb'] as const satisfies readonly Walls[];
export const STORAGES = ['f32', 'f16'] as const satisfies readonly Storage[];

// The force readback cadence shared by the solver and the drag statistics.
export const FORCE_EVERY_STEPS = 8;

// TRT is the accurate laminar operator, but only the regularized one stays finite once the sub-grid model is needed (ADR-013).
export const defaultOperator = (les: boolean): Operator => (les ? 'reg' : 'trt');
export const DEFAULT_WALLS: Walls = WALLS[0];
export const DEFAULT_STORAGE: Storage = STORAGES[0] ?? 'f32';
