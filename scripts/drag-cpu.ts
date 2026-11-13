import { pathToFileURL } from 'node:url';
import { DEFAULT_SPEED_MPS } from '../src/app/params';
import { presetMesh } from '../src/geometry/presets';
import { type DragFlowThrough, runBodyDrag } from '../src/lbm/reference/cases';
import type { Operator } from '../src/lbm/reference/collision';
import { physicalToLattice } from '../src/lbm/units';
import { AHMED_BODY_LENGTH_MM } from '../src/validation/cases';

// Small enough to run the reference solver in Node, large enough to keep the
// body clear of the inlet and outlet.
const LAYOUT = { nx: 64, ny: 32, nz: 32 };
const BODY_LENGTH_CELLS = 24;
const DEFAULT_FLOW_THROUGHS = 4;
// Single-rate relaxation is the sensitivity run; the live default stays TRT.
const OPERATORS: readonly Operator[] = ['trt', 'reg', 'bgk'];

type Options = { operators: readonly Operator[]; flowThroughs: number };

function error(message: string): never {
  throw new Error(message);
}

function positiveCount(value: string, name: string): number {
  const parsed = Number(value);
  if (value === '' || !Number.isSafeInteger(parsed) || parsed < 1) {
    error(`--${name} needs a whole number of at least one, not "${value}".`);
  }
  return parsed;
}

export function parseArguments(argv: readonly string[]): Options {
  let options: Options = { operators: OPERATORS, flowThroughs: DEFAULT_FLOW_THROUGHS };
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) error(`Unknown option ${argument}.`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    switch (name) {
      case 'operator': {
        const operator = OPERATORS.find((candidate) => candidate === value);
        if (operator === undefined) error(`Unknown operator "${value}". Use trt, reg or bgk.`);
        options = { ...options, operators: [operator] };
        break;
      }
      case 'flowthroughs':
        options = { ...options, flowThroughs: positiveCount(value, name) };
        break;
      default:
        error(`Unknown option --${name}.`);
    }
  }
  return options;
}

function formatMean(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(4);
}

function formatLine(operator: Operator, stats: DragFlowThrough, finite: boolean): string {
  return [
    `operator=${operator}`,
    `flow-through=${stats.flowThrough}`,
    `step=${stats.step}`,
    `samples=${stats.samples}`,
    `meanCd=${formatMean(stats.meanCd)}`,
    `relStdPct=${stats.relStdPct === null ? 'n/a' : stats.relStdPct.toFixed(2)}`,
    `finite=${finite ? 'yes' : 'no'}`,
  ].join(' ');
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const body = presetMesh('ahmed-25');
  if (body === null) error('The Ahmed preset mesh is unavailable.');
  const { viscosityLu, re } = physicalToLattice({
    refLengthCells: BODY_LENGTH_CELLS,
    speedMps: DEFAULT_SPEED_MPS,
    refLengthM: AHMED_BODY_LENGTH_MM / 1000,
  });
  const tau0 = viscosityLu * 3 + 0.5;
  process.stdout.write(
    [
      `grid=${LAYOUT.nx}x${LAYOUT.ny}x${LAYOUT.nz}`,
      `body-length=${BODY_LENGTH_CELLS}`,
      `re=${re.toFixed(0)}`,
      `nu=${viscosityLu.toExponential(3)}`,
      `tau0=${tau0.toFixed(6)}`,
      `speed-mps=${DEFAULT_SPEED_MPS}`,
      'les=on',
      'floor=on',
    ].join(' '),
  );
  process.stdout.write('\n');
  for (const operator of options.operators) {
    const result = runBodyDrag({
      layout: LAYOUT,
      body,
      bodyLengthCells: BODY_LENGTH_CELLS,
      tau0,
      operator,
      les: true,
      floor: true,
      flowThroughs: options.flowThroughs,
    });
    process.stdout.write(
      `operator=${operator} frontal-cells=${result.grid.frontalCells} blockage=${(100 * result.grid.blockage).toFixed(2)} pct steps-per-flow-through=${result.stepsPerFlowThrough}\n`,
    );
    for (const stats of result.flowThroughs) {
      process.stdout.write(`${formatLine(operator, stats, result.finite)}\n`);
      if (!result.finite) break;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }
}
