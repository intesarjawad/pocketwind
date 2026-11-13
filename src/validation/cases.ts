import { DEFAULT_SETTINGS } from '../app/params';
import type { Operator, Storage, Tier, Walls } from '../app/settings';
import { type Layout, TIERS } from '../lbm/layout';
import {
  DEFAULT_STORAGE,
  DEFAULT_WALLS,
  defaultOperator,
  OPERATORS,
  STORAGES,
  WALLS,
} from '../lbm/params';
import { NU_AIR, U_LU } from '../lbm/units';

export type CaseGroup =
  | 'smoke'
  | 'validation'
  | 'laminar'
  | 'shape-class'
  | 'confinement'
  | 'sensitivity';
export type ShapeKind = 'ahmed-25' | 'ahmed-35' | 'sphere' | 'cube';
export type ShapeClass = 'road-vehicle' | 'laminar' | 'sharp-edged' | 'smooth-subcritical';
/** What `--only` selects; one name may cover rows of several `CaseGroup`s or none. */
export const VALIDATION_GROUPS = [
  'smoke',
  'verification',
  'laminar',
  'validation',
  'shape-classes',
  'confinement',
  'convergence',
  'sensitivity',
  'grid-check',
] as const;
export type ValidationGroup = (typeof VALIDATION_GROUPS)[number];
export type FlipFactor = 'operator' | 'walls' | 'storage';
export type CaseVariant = 'default' | `flip-${FlipFactor}`;

export type ValidationFactors = {
  readonly operator: readonly Operator[];
  readonly walls: readonly Walls[];
  readonly storage: readonly Storage[];
};

export type CaseSpec = {
  /** Stable identity shared by variants of the same case, used by the schema check. */
  case: string;
  id: string;
  group: CaseGroup;
  label: string;
  tier: Tier;
  grid: Layout;
  cells: number;
  operator: Operator;
  walls: Walls;
  storage: Storage;
  variant: CaseVariant | null;
  sensitivity: string | null;
  shape: ShapeKind;
  shapeClass: ShapeClass;
  speedMps: number;
  re: number | null;
  les: boolean;
  floor: boolean;
  stilts: boolean;
  bodyLengthMm: number;
  bodyLengthCells: number;
  cellSizeM: number;
  referenceAreaM2: number;
  voxelAreaM2: number;
  blockage: number;
  baselineBlockage: number | null;
  uLu: number;
  steps: number;
  flowThroughSteps: number;
  averageSteps: number;
  referenceCd: number | null;
  isDefault: boolean;
};

// Ahmed et al. (1984) rear-slant drag coefficient, based on the 0.112 m2 frontal area.
export const AHMED_25_REFERENCE_CD = 0.285;
// The Reynolds number of that measurement, on the body length.
export const AHMED_25_REFERENCE_RE = 4.29e6;
// No 35 degree value is recorded in docs/validation.md yet; the row runs once one is.
export const AHMED_35_REFERENCE_CD: number | null = null;
// Schiller-Naumann correlation at Re = 100, Cd = 24/Re (1 + 0.15 Re^0.687) = 1.092.
export const SPHERE_RE_100_REFERENCE_CD = 1.09;
// 389 mm wide by 288 mm high.
export const AHMED_FRONTAL_AREA_M2 = 0.112;
export const AHMED_BODY_LENGTH_MM = 1044;
/** The full-scale speed the validation runs hold the Ahmed body at. */
export const AHMED_VALIDATION_SPEED_MPS = 40;
// The interactive preset uses half the streamwise domain for the body.
export const AHMED_BODY_LENGTH_FRACTION = 0.5;
export const CUBE_SIDE_FRACTION = 0.2;
export const SPHERE_DIAMETER_FRACTION = 0.226;
export const CUBE_SPHERE_BLOCKAGE = 0.04;
export const MASKELL_THETA = 2.5;
export const FLOW_THROUGHS = 6;
export const AVERAGE_THROUGHS = 2;
export const PASS_TOLERANCE_PCT = 10;

const MILLIMETRES_PER_METRE = 1000;
const LAMINAR_SPHERE_DIAMETER_MM = 100;
export const LAMINAR_SPHERE_RE = 100;
const SHAPE_SPHERE_RE = 20000;
const SHAPE_SPEED_MPS = 40;
const DEFAULT_TIERS: readonly Tier[] = ['S', 'M', 'L', 'XL'];
const SHAPE_TIERS: readonly Tier[] = ['S', 'M', 'L'];

export function validationGroupOf(group: CaseGroup): ValidationGroup {
  return group === 'shape-class' ? 'shape-classes' : group;
}

/** Storage levels the adapter can actually address; f16 needs the shader feature. */
export function availableValidationFactors(
  adapterFeatures: readonly string[] = [],
): ValidationFactors {
  return {
    operator: OPERATORS,
    walls: WALLS,
    storage: STORAGES.filter(
      (storage) => storage !== 'f16' || adapterFeatures.includes('shader-f16'),
    ),
  };
}

export function flowThroughSteps(nx: number, uLu: number = U_LU): number {
  if (!Number.isSafeInteger(nx) || nx < 1) throw new RangeError('Grid length must be positive.');
  if (!Number.isFinite(uLu) || uLu <= 0) throw new RangeError('Inlet speed must be positive.');
  return Math.ceil(nx / uLu);
}

function gridFor(tier: Tier): Layout {
  const { nx, ny, nz } = TIERS[tier];
  return { nx, ny, nz };
}

function cellsFor(grid: Layout): number {
  return grid.nx * grid.ny * grid.nz;
}

function defaultAhmedBodyLengthCells(tier: Tier): number {
  return TIERS[tier].nx * AHMED_BODY_LENGTH_FRACTION;
}

function sameGrid(a: Layout, b: Layout): boolean {
  return a.nx === b.nx && a.ny === b.ny && a.nz === b.nz;
}

function tunnelAreaM2(grid: Layout, cellSizeM: number): number {
  return grid.ny * grid.nz * cellSizeM * cellSizeM;
}

function blockageFor(areaM2: number, grid: Layout, cellSizeM: number): number {
  return areaM2 / tunnelAreaM2(grid, cellSizeM);
}

/** Projected solid cells cannot be fractional, so the voxel area is quantised. */
function voxelAreaM2(areaM2: number, cellSizeM: number): number {
  const cells = Math.max(1, Math.round(areaM2 / (cellSizeM * cellSizeM)));
  return cells * cellSizeM * cellSizeM;
}

type Defaults = {
  walls: Walls;
  storage: Storage;
  bodyLengthMm: number;
};

/**
 * Defaults are read from the run-time solver lists and the app's preset, never
 * from a flag on the row.
 */
export function isDefaultRow(
  row: Pick<
    CaseSpec,
    | 'group'
    | 'shape'
    | 'tier'
    | 'grid'
    | 'operator'
    | 'les'
    | 'walls'
    | 'storage'
    | 'bodyLengthMm'
    | 'bodyLengthCells'
  >,
  defaults: Defaults = {
    walls: DEFAULT_WALLS,
    storage: DEFAULT_STORAGE,
    bodyLengthMm: DEFAULT_SETTINGS.bodyLengthMm,
  },
): boolean {
  const factorsDefault =
    row.operator === defaultOperator(row.les) &&
    row.walls === defaults.walls &&
    row.storage === defaults.storage;
  if (row.group === 'sensitivity' || row.group === 'smoke') return false;
  if (row.group !== 'validation') return factorsDefault;
  if (!row.shape.startsWith('ahmed-')) return false;
  return (
    factorsDefault &&
    row.bodyLengthMm === defaults.bodyLengthMm &&
    row.bodyLengthCells === defaultAhmedBodyLengthCells(row.tier) &&
    sameGrid(row.grid, gridFor(row.tier))
  );
}

type CaseInput = Omit<
  CaseSpec,
  | 'cells'
  | 'steps'
  | 'flowThroughSteps'
  | 'averageSteps'
  | 'voxelAreaM2'
  | 'blockage'
  | 'referenceAreaM2'
  | 'isDefault'
> & {
  cellSizeM: number;
  areaM2: number;
  steps?: number;
  flowThroughSteps?: number;
};

function caseSpec(input: CaseInput): CaseSpec {
  const flowSteps = input.flowThroughSteps ?? flowThroughSteps(input.grid.nx, input.uLu);
  const cells = cellsFor(input.grid);
  const areaM2 = input.areaM2;
  const completed: CaseSpec = {
    ...input,
    cells,
    referenceAreaM2: areaM2,
    voxelAreaM2: voxelAreaM2(areaM2, input.cellSizeM),
    blockage: blockageFor(areaM2, input.grid, input.cellSizeM),
    steps: input.steps ?? FLOW_THROUGHS * flowSteps,
    flowThroughSteps: flowSteps,
    averageSteps: AVERAGE_THROUGHS * flowSteps,
    isDefault: false,
  };
  return { ...completed, isDefault: isDefaultRow(completed) };
}

function ahmedCase(
  tier: Tier,
  operator: Operator,
  walls: Walls,
  storage: Storage,
  options: {
    bodyLengthCells?: number;
    uLu?: number;
    stilts?: boolean;
    variant?: CaseVariant | null;
    sensitivity?: string | null;
    group?: CaseGroup;
    baselineBlockage?: number | null;
    referenceCd?: number | null;
    id?: string;
    preset?: 'ahmed-25' | 'ahmed-35';
    steps?: number;
  } = {},
): CaseSpec {
  const preset = options.preset ?? 'ahmed-25';
  const grid = gridFor(tier);
  const bodyLengthCells = options.bodyLengthCells ?? defaultAhmedBodyLengthCells(tier);
  const cellSizeM = AHMED_BODY_LENGTH_MM / MILLIMETRES_PER_METRE / bodyLengthCells;
  return caseSpec({
    case: preset,
    id: options.id ?? `${preset}-${tier}-${operator}-${options.variant ?? 'default'}`,
    group: options.group ?? 'validation',
    label: `Ahmed body at ${preset === 'ahmed-25' ? 25 : 35} degrees`,
    tier,
    grid,
    operator,
    walls,
    storage,
    variant: options.variant ?? null,
    sensitivity: options.sensitivity ?? null,
    shape: preset,
    shapeClass: 'road-vehicle',
    speedMps: AHMED_VALIDATION_SPEED_MPS,
    re: (AHMED_VALIDATION_SPEED_MPS * AHMED_BODY_LENGTH_MM) / MILLIMETRES_PER_METRE / NU_AIR,
    // The tunnel runs the Ahmed body with the sub-grid model on; at Re 2.78e6 a run without it is not finite.
    les: true,
    floor: true,
    stilts: options.stilts ?? true,
    bodyLengthMm: AHMED_BODY_LENGTH_MM,
    bodyLengthCells,
    cellSizeM,
    areaM2: AHMED_FRONTAL_AREA_M2,
    baselineBlockage: options.baselineBlockage ?? null,
    uLu: options.uLu ?? U_LU,
    ...(options.steps === undefined ? {} : { steps: options.steps }),
    referenceCd: options.referenceCd === undefined ? AHMED_25_REFERENCE_CD : options.referenceCd,
  });
}

function laminarSphereCase(
  tier: Tier,
  operator: Operator,
  walls: Walls,
  storage: Storage,
): CaseSpec {
  const grid = gridFor(tier);
  const diameterCells = grid.nx / 8;
  const cellSizeM = LAMINAR_SPHERE_DIAMETER_MM / MILLIMETRES_PER_METRE / diameterCells;
  const diameterM = diameterCells * cellSizeM;
  const speedMps = (LAMINAR_SPHERE_RE * NU_AIR) / diameterM;
  return caseSpec({
    case: 'sphere-re-100',
    id: `sphere-re-100-${tier}-${operator}`,
    group: 'laminar',
    label: 'Sphere at Re 100',
    tier,
    grid,
    operator,
    walls,
    storage,
    variant: null,
    sensitivity: null,
    shape: 'sphere',
    shapeClass: 'laminar',
    speedMps,
    re: LAMINAR_SPHERE_RE,
    les: false,
    floor: false,
    stilts: false,
    bodyLengthMm: LAMINAR_SPHERE_DIAMETER_MM,
    bodyLengthCells: diameterCells,
    cellSizeM,
    areaM2: Math.PI * (diameterM / 2) ** 2,
    baselineBlockage: null,
    uLu: U_LU,
    referenceCd: SPHERE_RE_100_REFERENCE_CD,
  });
}

function shapeCase(kind: 'cube' | 'sphere', tier: Tier): CaseSpec {
  const grid = gridFor(tier);
  // One metre across the tunnel makes the blockage fractions dimensionless.
  const cellSizeM = 1 / grid.ny;
  const sizeCells = (kind === 'cube' ? CUBE_SIDE_FRACTION : SPHERE_DIAMETER_FRACTION) * grid.ny;
  const diameterM = sizeCells * cellSizeM;
  const areaM2 = kind === 'cube' ? diameterM ** 2 : Math.PI * (diameterM / 2) ** 2;
  const speedMps = kind === 'sphere' ? (SHAPE_SPHERE_RE * NU_AIR) / diameterM : SHAPE_SPEED_MPS;
  return caseSpec({
    case: kind,
    id: `${kind}-${tier}`,
    group: 'shape-class',
    label: kind === 'cube' ? 'Cube face-on' : 'Sphere at Re 20000',
    tier,
    grid,
    operator: defaultOperator(true),
    walls: DEFAULT_WALLS,
    storage: DEFAULT_STORAGE,
    variant: null,
    sensitivity: null,
    shape: kind,
    shapeClass: kind === 'cube' ? 'sharp-edged' : 'smooth-subcritical',
    speedMps,
    re: kind === 'sphere' ? SHAPE_SPHERE_RE : null,
    les: true,
    floor: false,
    stilts: false,
    bodyLengthMm: diameterM * MILLIMETRES_PER_METRE,
    bodyLengthCells: sizeCells,
    cellSizeM,
    areaM2,
    baselineBlockage: null,
    uLu: U_LU,
    referenceCd: null,
  });
}

function confinementSphereCase(operator: Operator): CaseSpec {
  const grid = gridFor('XL');
  const diameterCells = TIERS.L.nx / 8;
  const cellSizeM = LAMINAR_SPHERE_DIAMETER_MM / MILLIMETRES_PER_METRE / diameterCells;
  const diameterM = diameterCells * cellSizeM;
  return caseSpec({
    case: 'sphere-confinement',
    id: `sphere-confinement-${operator}`,
    group: 'confinement',
    label: 'Sphere at Re 100 in the larger domain',
    tier: 'XL',
    grid,
    operator,
    walls: DEFAULT_WALLS,
    storage: DEFAULT_STORAGE,
    variant: null,
    sensitivity: null,
    shape: 'sphere',
    shapeClass: 'laminar',
    speedMps: (LAMINAR_SPHERE_RE * NU_AIR) / diameterM,
    re: LAMINAR_SPHERE_RE,
    les: false,
    floor: false,
    stilts: false,
    bodyLengthMm: LAMINAR_SPHERE_DIAMETER_MM,
    bodyLengthCells: diameterCells,
    cellSizeM,
    areaM2: Math.PI * (diameterM / 2) ** 2,
    baselineBlockage: null,
    uLu: U_LU,
    referenceCd: SPHERE_RE_100_REFERENCE_CD,
  });
}

function confinementCubeCase(operator: Operator): CaseSpec {
  const grid = gridFor('XL');
  // Keep the tier-L cell size so only the domain grows.
  const cellSizeM = 1 / TIERS.L.ny;
  const sizeCells = CUBE_SIDE_FRACTION * TIERS.L.ny;
  return caseSpec({
    case: 'cube-confinement',
    id: `cube-confinement-${operator}`,
    group: 'confinement',
    label: 'Cube face-on in the larger domain',
    tier: 'XL',
    grid,
    operator,
    walls: DEFAULT_WALLS,
    storage: DEFAULT_STORAGE,
    variant: null,
    sensitivity: null,
    shape: 'cube',
    shapeClass: 'sharp-edged',
    speedMps: SHAPE_SPEED_MPS,
    re: null,
    les: true,
    floor: false,
    stilts: false,
    bodyLengthMm: sizeCells * cellSizeM * MILLIMETRES_PER_METRE,
    bodyLengthCells: sizeCells,
    cellSizeM,
    areaM2: (sizeCells * cellSizeM) ** 2,
    baselineBlockage: null,
    uLu: U_LU,
    referenceCd: null,
  });
}

type AhmedBase = { operator: Operator; walls: Walls; storage: Storage };

function flippedAhmedCase(base: AhmedBase, factor: FlipFactor, other: string): CaseSpec {
  const options = {
    variant: `flip-${factor}` as CaseVariant,
    id: `ahmed-25-L-${factor}-${other}`,
  };
  if (factor === 'operator') {
    return ahmedCase('L', other as Operator, base.walls, base.storage, options);
  }
  if (factor === 'walls') {
    return ahmedCase('L', base.operator, other as Walls, base.storage, options);
  }
  return ahmedCase('L', base.operator, base.walls, other as Storage, options);
}

function ahmedFlipRows(base: AhmedBase, factors: ValidationFactors): CaseSpec[] {
  const levels: [FlipFactor, readonly string[], string][] = [
    ['operator', factors.operator, base.operator],
    ['walls', factors.walls, base.walls],
    ['storage', factors.storage, base.storage],
  ];
  const rows: CaseSpec[] = [];
  for (const [factor, values, current] of levels) {
    const other = values.length === 2 ? values.find((level) => level !== current) : undefined;
    if (other !== undefined) rows.push(flippedAhmedCase(base, factor, other));
  }
  return rows;
}

function flattenedAhmedRows(tiers: readonly Tier[], factors: ValidationFactors): CaseSpec[] {
  const base = {
    operator: defaultOperator(true),
    walls: DEFAULT_WALLS,
    storage: DEFAULT_STORAGE,
  };
  return tiers.flatMap((tier) => {
    if (tier !== 'L') return [ahmedCase(tier, base.operator, base.walls, base.storage)];
    const ahmed35 =
      AHMED_35_REFERENCE_CD === null
        ? []
        : [
            ahmedCase(tier, base.operator, base.walls, base.storage, {
              preset: 'ahmed-35',
              referenceCd: AHMED_35_REFERENCE_CD,
            }),
          ];
    return [
      ahmedCase(tier, base.operator, base.walls, base.storage, { variant: 'default' }),
      ...ahmedFlipRows(base, factors),
      ...ahmed35,
    ];
  });
}

function sensitivityRows(): CaseSpec[] {
  const operator = defaultOperator(true);
  const walls = DEFAULT_WALLS;
  const storage = DEFAULT_STORAGE;
  const bodyLengthCells = defaultAhmedBodyLengthCells('L');
  const baseline = ahmedCase('L', operator, walls, storage);
  return [
    ahmedCase('XL', operator, walls, storage, {
      group: 'sensitivity',
      sensitivity: 'domain',
      bodyLengthCells,
      baselineBlockage: baseline.blockage,
      variant: null,
      referenceCd: null,
      id: 'sensitivity-domain',
    }),
    ahmedCase('L', operator, walls, storage, {
      group: 'sensitivity',
      sensitivity: 'body-length',
      bodyLengthCells: 0.3 * TIERS.L.nx,
      variant: null,
      referenceCd: null,
      id: 'sensitivity-body-length-0.3',
    }),
    ahmedCase('M', operator, walls, storage, {
      group: 'sensitivity',
      sensitivity: 'inlet-speed',
      uLu: 0.1,
      variant: null,
      referenceCd: null,
      id: 'sensitivity-u-lu-0.1',
    }),
    ahmedCase('L', operator, walls, storage, {
      group: 'sensitivity',
      sensitivity: 'stilts',
      stilts: true,
      variant: null,
      referenceCd: null,
      id: 'sensitivity-stilts-included',
    }),
    ahmedCase('L', operator, walls, storage, {
      group: 'sensitivity',
      sensitivity: 'stilts',
      stilts: false,
      variant: null,
      referenceCd: null,
      id: 'sensitivity-stilts-excluded',
    }),
  ];
}

/**
 * Build the run list. Tier selection narrows the per-tier suites, but the
 * confinement rows always use the XL grid because they compare domains at one
 * cell size.
 */
export function buildCases(
  options: { tiers?: readonly Tier[]; factors?: ValidationFactors } = {},
): CaseSpec[] {
  const tiers = options.tiers ?? DEFAULT_TIERS;
  const factors = options.factors ?? availableValidationFactors();
  const rows: CaseSpec[] = [...flattenedAhmedRows(tiers, factors)];

  if (tiers.includes('L')) {
    rows.push(...sensitivityRows());
  }

  for (const operator of factors.operator) {
    for (const tier of SHAPE_TIERS) {
      if (tiers.includes(tier))
        rows.push(laminarSphereCase(tier, operator, DEFAULT_WALLS, DEFAULT_STORAGE));
    }
    rows.push(confinementCubeCase(operator), confinementSphereCase(operator));
  }

  for (const tier of SHAPE_TIERS) {
    if (!tiers.includes(tier)) continue;
    rows.push(shapeCase('cube', tier), shapeCase('sphere', tier));
  }

  return rows.sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}

/** Ahmed tiers used by the convergence section, in increasing resolution. */
export const CONVERGENCE_TIERS: readonly Tier[] = ['M', 'L', 'XL'];

/** A plumbing check: tier S at the defaults for two flow-throughs, with no reference to judge it by. */
export function smokeCase(): CaseSpec {
  return ahmedCase('S', defaultOperator(true), DEFAULT_WALLS, DEFAULT_STORAGE, {
    group: 'smoke',
    id: 'smoke-ahmed-25-S',
    referenceCd: null,
    steps: AVERAGE_THROUGHS * flowThroughSteps(TIERS.S.nx),
  });
}

export type PlannedSkip = {
  case: string;
  group: ValidationGroup;
  tier: Tier;
  reason: string;
};

/** Cases the run list leaves out on purpose, so a complete run can still say why. */
export function plannedSkips(tiers: readonly Tier[] = DEFAULT_TIERS): PlannedSkip[] {
  if (AHMED_35_REFERENCE_CD !== null || !tiers.includes('L')) return [];
  return [
    {
      case: 'ahmed-35',
      group: 'validation',
      tier: 'L',
      reason: 'No reference value for the 35 degree body is recorded in docs/validation.md.',
    },
  ];
}

/** The cases a selection of groups runs in a browser; the other groups need none. */
export function planCases(
  groups: ReadonlySet<ValidationGroup>,
  options: { tiers?: readonly Tier[]; factors?: ValidationFactors } = {},
): CaseSpec[] {
  const wanted = new Set(
    [...groups].flatMap((group) => (group === 'shape-classes' ? ['shape-class'] : [group])),
  );
  const rows = buildCases(options).filter((row) => wanted.has(row.group));
  const tiers = options.tiers ?? DEFAULT_TIERS;
  return groups.has('smoke') && tiers.includes('S') ? [smokeCase(), ...rows] : rows;
}
