/** Built-in preset name, or `custom` once a model file is dropped. */
export type PresetId = string;

export type Tier = 'S' | 'M' | 'L' | 'XL';
/** A tier chosen by the device probe, or one the person selected. */
export type TierChoice = 'auto' | Tier;

export type Storage = 'f32' | 'f16';
export type StorageChoice = 'auto' | Storage;

export type Operator = 'trt' | 'reg';
export type Walls = 'bb' | 'bouzidi';

export type Axis = 'x' | 'y' | 'z';
export type FlowSign = 1 | -1;

/** The comparison view is local to the session and never travels in a link. */
export type CompareState = { enabled: boolean };

/**
 * Inputs that identify a run independently of the solved field. Geometry is
 * described by its size and placement rather than by a model file, so a link
 * or a run file never carries the mesh itself.
 */
export type Settings = {
  presetId: PresetId;
  tier: TierChoice;
  storage: StorageChoice;
  operator: Operator;
  walls: Walls;
  speedMps: number;
  bodyLengthMm: number;
  flowAxis: Axis;
  flowSign: FlowSign;
  upAxis: Axis;
  floor: boolean;
  paused: boolean;
  compare: CompareState;
};
