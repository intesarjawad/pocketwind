/** One built-in body. File names are relative to assets/geometry. */
export type PresetRecord = {
  id: string;
  /** Body meshes, read in order and joined into one mesh. */
  files: readonly string[];
  /** Mesh for the supports, kept apart so the solver gives them no body force. */
  supports?: string;
  refLengthMm: number;
  /** Literature frontal area, so a preset does not inherit the voxel quantisation. */
  refAreaMm2: number;
  /** Distance from the floor to the lowest point of the body; zero when it rests on the floor. */
  floorGapMm: number;
  references: readonly string[];
};

const AHMED_1984 =
  'Ahmed, S. R., Ramm, G. and Faltin, G. (1984). Some salient features of the time-averaged ground vehicle wake. SAE Technical Paper 840300.';
const AHMED_AREA_MM2 = 112_000;
const AHMED_STILT_LENGTH_MM = 50;

export const PRESET_REGISTRY: readonly PresetRecord[] = [
  {
    id: 'ahmed-25',
    files: ['ahmed-25.stl'],
    supports: 'stilts.stl',
    refLengthMm: 1044,
    refAreaMm2: AHMED_AREA_MM2,
    floorGapMm: AHMED_STILT_LENGTH_MM,
    references: [AHMED_1984],
  },
  {
    id: 'ahmed-35',
    files: ['ahmed-35.stl'],
    supports: 'stilts.stl',
    refLengthMm: 1044,
    refAreaMm2: AHMED_AREA_MM2,
    floorGapMm: AHMED_STILT_LENGTH_MM,
    references: [AHMED_1984],
  },
  {
    id: 'ahmed-25-roof-box',
    files: ['ahmed-25-roof-box.stl'],
    supports: 'stilts.stl',
    refLengthMm: 1044,
    // The 300 x 150 mm face of the roof box adds to the body frontal area.
    refAreaMm2: AHMED_AREA_MM2 + 300 * 150,
    floorGapMm: AHMED_STILT_LENGTH_MM,
    references: [],
  },
  {
    id: 'sphere',
    files: ['sphere.stl'],
    refLengthMm: 300,
    refAreaMm2: Math.PI * 150 * 150,
    floorGapMm: 0,
    references: [
      'Achenbach, E. (1972). Experiments on the flow past spheres at very high Reynolds numbers. Journal of Fluid Mechanics 54(3).',
    ],
  },
  {
    id: 'cube',
    files: ['cube.stl'],
    refLengthMm: 300,
    refAreaMm2: 300 * 300,
    floorGapMm: 0,
    references: ['Hoerner, S. F. (1965). Fluid-Dynamic Drag. Hoerner Fluid Dynamics.'],
  },
];

export function registryPresetById(id: string): PresetRecord | undefined {
  return PRESET_REGISTRY.find((preset) => preset.id === id);
}
