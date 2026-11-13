import { WINDOW_FLOW_THROUGHS } from '../forces/drag-stats';
import type { ForceHistoryPoint } from '../io/run-file';
import { type Color, readRenderColors } from '../render/frame';
import { createForceTable } from './force-table';
import { createReadout, type ReadoutState } from './readout';

// The plot is drawn at its displayed size so the scale text stays 11 px; this is the size before layout.
export const PLOT_WIDTH = 640;
export const PLOT_HEIGHT = 180;
const PLOT_MAX_HEIGHT = 240;
const PLOT_PADDING = 8;
// Room under the plot for the flow-through scale.
const PLOT_FOOT = 28;
// Room on the left for the Cd scale.
const PLOT_AXIS = 40;
const TICK_COUNT = 5;
// The averaged span is at least this wide; on the log scale it would be a sliver.
export const INSET_PX = 56;

export type PlotBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function plotBox(width: number, height: number): PlotBox {
  return {
    x: PLOT_AXIS,
    y: PLOT_PADDING,
    width: width - PLOT_AXIS - PLOT_PADDING,
    height: height - PLOT_PADDING - PLOT_FOOT,
  };
}

export const PLOT_BOX: PlotBox = plotBox(PLOT_WIDTH, PLOT_HEIGHT);

export function plotHeight(width: number): number {
  return Math.round(Math.min(PLOT_MAX_HEIGHT, Math.max(PLOT_HEIGHT, width * 0.2)));
}

export type StepRange = {
  readonly minStep: number;
  readonly maxStep: number;
  /** Where the averaged span starts; from here time runs linearly over the last INSET_PX. */
  readonly inset?: number;
};

export type CdRange = {
  readonly minCd: number;
  readonly maxCd: number;
};

export type PlotRanges = {
  readonly steps: StepRange;
  readonly cd: CdRange;
};

export type PlotPoint = {
  readonly x: number;
  readonly y: number;
};

export type Shade = {
  readonly x: number;
  readonly width: number;
};

export type ForceReportUpdate = {
  readonly history: readonly ForceHistoryPoint[];
  readonly compare?: readonly ForceHistoryPoint[];
  /** Drag area of the live run; a saved run's report leaves it out. */
  readonly cdaM2?: number | null;
  readonly windowSteps: number;
  readonly readout: ReadoutState;
  /** A measured Cd for the same shape, drawn as a dashed line. */
  readonly referenceCd?: number;
};

/** The analysis window that the drag statistics use for the latest sample. */
export function windowStepsFor(flowThroughSteps: number): number {
  return WINDOW_FLOW_THROUGHS * flowThroughSteps;
}

/** The span of both records in steps; the first step is the earliest after the start. */
export function stepRange(
  history: readonly ForceHistoryPoint[],
  compare: readonly ForceHistoryPoint[] = [],
): StepRange {
  let minStep = Number.POSITIVE_INFINITY;
  let maxStep = Number.NEGATIVE_INFINITY;
  for (const points of [history, compare]) {
    for (const [step] of points) {
      // Time runs on a log scale, which has no place for the start itself.
      if (step > 0) minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
    }
  }
  if (minStep === Number.POSITIVE_INFINITY && maxStep > 0) minStep = maxStep;
  if (minStep === Number.POSITIVE_INFINITY) return { minStep: 0, maxStep: 1 };
  // A single sample still needs a span, otherwise it would divide by zero.
  return { minStep, maxStep: maxStep > minStep ? maxStep : minStep + 1 };
}

export function plotRanges(
  history: readonly ForceHistoryPoint[],
  compare: readonly ForceHistoryPoint[] = [],
  referenceCd?: number,
  windowSteps = 0,
): PlotRanges {
  const steps = stepRange(history, compare);
  if (history.length === 0 && compare.length === 0) return { steps, cd: { minCd: 0, maxCd: 1 } };
  // Drag runs from zero to a quarter above the later half of the record (on the log time
  // scale) and the reference, so the settled value and the measurement stand apart. The
  // start-up surge runs off the top and is labelled with its own value.
  const settled = Math.sqrt(Math.max(steps.minStep, 1) * steps.maxStep);
  let low = 0;
  let high = referenceCd ?? 0;
  for (const points of [history, compare]) {
    const later = points.filter(([step]) => step >= settled);
    for (const [, cd] of later.length > 0 ? later : points) {
      low = Math.min(low, cd);
      high = Math.max(high, cd);
    }
  }
  const unit = 0.5 * 10 ** Math.floor(Math.log10(Math.max(high, 1e-6) * 1.25));
  const maxCd = Math.ceil((high * 1.25) / unit) * unit;
  // Time starts where the record comes into the scale; the surge before it is labelled.
  const entry = history.find(([step, cd]) => step > 0 && cd <= maxCd)?.[0] ?? steps.minStep;
  const minStep = Math.min(Math.max(steps.minStep, entry), steps.maxStep - 1);
  const lastStep = history[history.length - 1]?.[0] ?? 0;
  const inset = lastStep - windowSteps;
  return {
    steps: {
      minStep,
      maxStep: steps.maxStep,
      ...(windowSteps > 0 && inset > minStep ? { inset } : {}),
    },
    cd: { minCd: low < 0 ? low - 0.05 * (maxCd - low) : 0, maxCd },
  };
}

/** Round values for a scale: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = TICK_COUNT): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  const ticks: number[] = [];
  // The tolerance keeps a tick that lands on an end despite rounding.
  const last = Math.floor(max / step + 1e-9);
  for (let index = Math.ceil(min / step - 1e-9); index <= last; index += 1) {
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * Log-scaled time, so the start-up transient is as wide as the settled record after it.
 * When the averaged span would be narrower than INSET_PX, it gets that width on a linear
 * scale at the right, and the log scale fills the rest.
 */
export function xForStep(step: number, range: StepRange, box: PlotBox = PLOT_BOX): number {
  const { inset, minStep, maxStep } = range;
  if (inset !== undefined && inset > minStep && inset < maxStep) {
    const natural =
      xForStep(maxStep, { minStep, maxStep }, box) - xForStep(inset, { minStep, maxStep }, box);
    if (natural < INSET_PX) {
      const edge = box.x + box.width - INSET_PX;
      if (step >= inset)
        return edge + ((Math.min(step, maxStep) - inset) / (maxStep - inset)) * INSET_PX;
      return xForStep(step, { minStep, maxStep: inset }, { ...box, width: box.width - INSET_PX });
    }
  }
  const low = Math.max(range.minStep, 1);
  const span = Math.log(range.maxStep / low);
  if (!(span > 0)) return box.x;
  return box.x + (Math.log(Math.max(step, low) / low) / span) * box.width;
}

/** Ticks for a log scale: 1, 2 and 5 times each power of ten, or the powers alone if crowded. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0 && max > min)) return [];
  const ticks: number[] = [];
  for (let power = Math.floor(Math.log10(min)); power <= Math.ceil(Math.log10(max)); power += 1) {
    for (const mantissa of [1, 2, 5]) {
      const tick = Number((mantissa * 10 ** power).toPrecision(12));
      if (tick >= min * (1 - 1e-9) && tick <= max * (1 + 1e-9)) ticks.push(tick);
    }
  }
  if (ticks.length <= TICK_COUNT + 2) return ticks;
  return ticks.filter((tick) => Math.abs(Math.log10(tick) - Math.round(Math.log10(tick))) < 1e-9);
}

export function yForCd(cd: number, range: CdRange, box: PlotBox = PLOT_BOX): number {
  const span = range.maxCd - range.minCd;
  if (span <= 0) return box.y + box.height / 2;
  return box.y + ((range.maxCd - cd) / span) * box.height;
}

/** Pixel span of the analysis window, clipped to the plotted time range. */
export function windowShade(
  lastStep: number,
  windowSteps: number,
  range: StepRange,
  box: PlotBox = PLOT_BOX,
): Shade {
  const startStep = Math.max(range.minStep, lastStep - Math.max(0, windowSteps));
  const endStep = Math.min(range.maxStep, lastStep);
  const x = xForStep(startStep, range, box);
  if (endStep <= startStep) return { x, width: 0 };
  return { x, width: xForStep(endStep, range, box) - x };
}

export function polyline(
  history: readonly ForceHistoryPoint[],
  ranges: PlotRanges,
  box: PlotBox = PLOT_BOX,
): PlotPoint[] {
  return history
    .filter(([step]) => step >= ranges.steps.minStep)
    .map(([step, cd]) => ({
      x: xForStep(step, ranges.steps, box),
      y: yForCd(cd, ranges.cd, box),
    }));
}

export function labelForHistory(
  history: readonly ForceHistoryPoint[],
  referenceCd?: number,
): string {
  const last = history[history.length - 1];
  if (last === undefined) return 'Drag coefficient history, no samples yet.';
  const reference = referenceCd === undefined ? '' : ` Measured reference ${referenceCd}.`;
  return `Drag coefficient history with ${history.length} samples; latest ${last[1].toFixed(2)}.${reference}`;
}

type PlotPalette = {
  readonly axis: string;
  readonly label: string;
  readonly font: string;
  readonly history: string;
  readonly compare: string;
  readonly window: string;
};

function cssColor([red, green, blue, alpha]: Color): string {
  const channel = (value: number): number => Math.round(value * 255);
  return `rgba(${channel(red)}, ${channel(green)}, ${channel(blue)}, ${alpha})`;
}

function strokePoints(
  context: CanvasRenderingContext2D,
  points: readonly PlotPoint[],
  color: string,
  dash: readonly number[],
): void {
  if (points.length === 0) return;
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.setLineDash(dash);
  if (points.length === 1) {
    const point = points[0];
    if (point !== undefined) {
      context.beginPath();
      context.arc(point.x, point.y, 1.5, 0, 2 * Math.PI);
      context.fillStyle = color;
      context.fill();
    }
    return;
  }
  context.beginPath();
  const [first, ...rest] = points;
  if (first === undefined) return;
  context.moveTo(first.x, first.y);
  for (const point of rest) context.lineTo(point.x, point.y);
  context.stroke();
}

function drawScale(
  context: CanvasRenderingContext2D,
  ranges: PlotRanges,
  flowThroughSteps: number,
  referenceCd: number | undefined,
  palette: PlotPalette,
  box: PlotBox,
): void {
  const range = ranges.cd;
  context.font = `11px ${palette.font}`;
  context.fillStyle = palette.label;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const bottom = box.y + box.height;
  const { minStep, maxStep } = ranges.steps;
  for (const tick of logTicks(minStep / flowThroughSteps, maxStep / flowThroughSteps)) {
    const x = xForStep(tick * flowThroughSteps, ranges.steps, box);
    // The axis title owns the right end of the scale.
    if (x > box.x + box.width - 150) continue;
    context.fillText(String(tick), x, bottom + 6);
    context.fillRect(Math.round(x), bottom, 1, 4);
  }
  context.textAlign = 'right';
  context.font = `italic 11px ${palette.font}`;
  context.fillText('flow-throughs, log scale', box.x + box.width, bottom + 6);
  context.font = `11px ${palette.font}`;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const tick of niceTicks(range.minCd, range.maxCd)) {
    const y = yForCd(tick, range, box);
    // The Cd label owns the top of the scale.
    if (y < box.y + 20) continue;
    context.fillText(String(tick), box.x - 8, y);
    context.fillRect(box.x - 4, Math.round(y), 4, 1);
  }
  context.textBaseline = 'top';
  context.font = `italic 11px ${palette.font}`;
  context.fillText('Cd', box.x - 8, box.y + 2);
  if (referenceCd === undefined) return;
  const y = Math.round(yForCd(referenceCd, range, box)) + 0.5;
  context.strokeStyle = palette.label;
  context.lineWidth = 1;
  context.setLineDash([2, 4]);
  context.beginPath();
  context.moveTo(box.x, y);
  context.lineTo(box.x + box.width, y);
  context.stroke();
  // The run's own label sits at the right, so the measurement's sits at the left.
  context.textAlign = 'left';
  context.textBaseline = 'bottom';
  context.fillText(`${referenceCd} wind tunnel`, box.x + 6, y - 3);
}

/** A bracket over the averaged span, open downward, with its name to the left. */
function drawBracket(
  context: CanvasRenderingContext2D,
  shade: Shade,
  flowThroughs: number,
  palette: PlotPalette,
  box: PlotBox,
): void {
  const left = Math.round(shade.x);
  const right = Math.round(shade.x + shade.width);
  const top = box.y + 1;
  context.fillStyle = palette.label;
  context.fillRect(left, top, right - left + 1, 1);
  context.fillRect(left, top, 1, 6);
  context.fillRect(right, top, 1, 6);
  context.font = `italic 11px ${palette.font}`;
  context.textAlign = 'right';
  context.textBaseline = 'top';
  const span = Number(flowThroughs.toFixed(1));
  context.fillText(
    `averaged over the last ${span} flow-through${span === 1 ? '' : 's'}`,
    left - 6,
    top,
  );
}

/**
 * Labels taken from the record itself: the start-up surge where it leaves the scale, and
 * the run's figure against the measurement.
 */
function labelRecord(
  context: CanvasRenderingContext2D,
  update: ForceReportUpdate,
  ranges: PlotRanges,
  palette: PlotPalette,
  box: PlotBox,
): void {
  const { history } = update;
  context.fillStyle = palette.label;
  context.font = `italic 11px ${palette.font}`;
  context.textBaseline = 'top';
  context.textAlign = 'left';
  const peak = history.reduce<ForceHistoryPoint | undefined>(
    (best, point) => (best === undefined || point[1] > best[1] ? point : best),
    undefined,
  );
  if (peak !== undefined && peak[1] > ranges.cd.maxCd) {
    const x = xForStep(peak[0], ranges.steps, box);
    context.fillText(`\u2191 ${Math.round(peak[1])} at start`, x + 6, box.y + 2);
  }
  const figure = update.readout.summary.cd ?? history[history.length - 1]?.[1];
  if (figure === undefined || !Number.isFinite(figure)) return;
  context.textAlign = 'right';
  context.textBaseline = 'bottom';
  const shade = windowShade(
    history[history.length - 1]?.[0] ?? 0,
    update.windowSteps,
    ranges.steps,
    box,
  );
  context.fillText(
    `${figure.toFixed(2)} this run`,
    Math.min(shade.x, box.x + box.width) - 8,
    yForCd(figure, ranges.cd, box) - 4,
  );
}

function drawForcePlot(
  context: CanvasRenderingContext2D,
  update: ForceReportUpdate,
  palette: PlotPalette,
  size: { readonly width: number; readonly height: number },
): void {
  const box = plotBox(size.width, size.height);
  const { history, windowSteps, referenceCd } = update;
  const compare = update.compare ?? [];
  const ranges = plotRanges(history, compare, referenceCd, windowSteps);
  const last = history[history.length - 1];
  context.clearRect(0, 0, size.width, size.height);

  if (last !== undefined) {
    const shade = windowShade(last[0], windowSteps, ranges.steps, box);
    context.fillStyle = palette.window;
    context.fillRect(shade.x, box.y, shade.width, box.height);
    const averaged =
      (last[0] - Math.max(ranges.steps.minStep, last[0] - windowSteps)) /
      (windowSteps / WINDOW_FLOW_THROUGHS);
    if (shade.width > 0) drawBracket(context, shade, averaged, palette, box);
  }

  if (last !== undefined) {
    drawScale(context, ranges, windowSteps / WINDOW_FLOW_THROUGHS, referenceCd, palette, box);
  }
  context.save();
  context.beginPath();
  context.rect(box.x, box.y, box.width, box.height);
  context.clip();
  strokePoints(context, polyline(compare, ranges, box), palette.compare, [4, 3]);
  strokePoints(context, polyline(history, ranges, box), palette.history, []);
  context.restore();
  if (last !== undefined) labelRecord(context, update, ranges, palette, box);

  context.setLineDash([]);
  context.fillStyle = palette.axis;
  context.fillRect(box.x, box.y + box.height, box.width, 1);
  context.fillRect(box.x, box.y, 1, box.height);
}

export function createForceReport(): {
  element: HTMLElement;
  update: (update: ForceReportUpdate) => void;
} {
  const section = document.createElement('section');
  section.className = 'force-report';
  section.setAttribute('aria-label', 'Drag');

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', labelForHistory([]));

  const created = canvas.getContext('2d');
  if (created === null) throw new Error('The force plot could not create a 2D canvas context.');
  const context = created;
  let size = { width: 0, height: 0 };

  function fit(): { width: number; height: number } {
    const width = Math.round(canvas.clientWidth) || PLOT_WIDTH;
    if (width === size.width) return size;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    size = { width, height: plotHeight(width) };
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    canvas.style.height = `${size.height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return size;
  }
  canvas.style.height = `${PLOT_HEIGHT}px`;

  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.textContent =
    'Drag coefficient since the air started, against flow-throughs of the tunnel on a log scale. The figure on the plate averages the shaded span, which keeps a readable width on a linear scale of its own.';
  figure.append(canvas, caption);

  const table = createForceTable();
  const readout = createReadout();
  section.append(figure, table.element, readout.element);

  let last: ForceReportUpdate | undefined;

  function draw(update: ForceReportUpdate): void {
    const colors = readRenderColors(canvas);
    const palette: PlotPalette = {
      axis: cssColor(colors.line),
      label: getComputedStyle(canvas).color,
      font: getComputedStyle(canvas).fontFamily,
      history: cssColor(colors.body),
      compare: cssColor(colors.line),
      window: cssColor(colors.smoke),
    };
    drawForcePlot(context, update, palette, fit());
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (last !== undefined) draw(last);
    }).observe(canvas);
  }

  return {
    element: section,
    update(update) {
      last = update;
      draw(update);
      canvas.setAttribute('aria-label', labelForHistory(update.history, update.referenceCd));
      table.update(update.history);
      readout.update(update.readout);
    },
  };
}
