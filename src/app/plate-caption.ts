import { NU_AIR } from '../lbm/units';
import {
  AHMED_25_REFERENCE_CD,
  AHMED_25_REFERENCE_RE,
  AHMED_BODY_LENGTH_MM,
  AHMED_VALIDATION_SPEED_MPS,
  SPHERE_RE_100_REFERENCE_CD,
} from '../validation/cases';
import { figureGrade, figureVerdict, GRADES, type Grade, type Withheld } from './figure-grade';
import type { ForceReportUpdate } from './force-plot';
import type { PlateExposure } from './run';

const SVG = 'http://www.w3.org/2000/svg';
// Exposure labels stay below the masthead.
const LABEL_FLOOR_PX = 76;
// The figure is redrawn at most this often, so a settling number reads instead of flickering.
const FIGURE_INTERVAL_MS = 120;
// A change of grade crossfades, so the figure erodes or sharpens rather than swapping type.
const GRADE_FADE_MS = 600;

// The speed of Ahmed's tunnel, from the Reynolds number and body length the reference
// carries, to the nearest 5 m/s: 4.29 million on 1044 mm gives 61.6, published as 60.
const AHMED_TUNNEL_MPS =
  Math.round((AHMED_25_REFERENCE_RE * NU_AIR) / (AHMED_BODY_LENGTH_MM / 1000) / 5) * 5;

export type PlateRun = {
  readonly plate: number;
  readonly presetId: string;
  readonly label: string;
  readonly speedMps: number;
  readonly bodyLengthMm: number;
  readonly laminar?: boolean;
};

/** Preset titles set like a plate caption: the body, then its variant in italic. */
const TITLES: Record<string, readonly [string, string]> = {
  'ahmed-25': ['Ahmed body,', '25° slant'],
};

export function plateTitle(
  presetId: string,
  label: string,
  bodyLengthMm: number,
): readonly [string, string] {
  return presetId === 'sphere'
    ? ['Sphere,', `${bodyLengthMm} mm`]
    : (TITLES[presetId] ?? [label, '']);
}

/** The Reynolds number the lattice runs at: the floor's value when it applies. */
export function simulatedRe(update: ForceReportUpdate, run: PlateRun): number {
  return update.readout.effectiveRe ?? (run.speedMps * run.bodyLengthMm) / 1000 / NU_AIR;
}

export function formatRe(re: number): string {
  if (re >= 1e6) return `${(re / 1e6).toFixed(1)} million`;
  if (re >= 1e4) return `${Math.round(re / 1000)} thousand`;
  return String(Math.round(re));
}

/**
 * The front as an SVG path, lifted wherever neighbouring threads are far apart, so a
 * front split by the body is not drawn across it.
 */
export function exposurePath(points: readonly (readonly [number, number])[]): string {
  const gaps = points.slice(1).map((point, index) => {
    const previous = points[index] ?? point;
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const limit = Math.max(24, 4 * typical);
  return points
    .map(([x, y], index) => {
      const command = index === 0 || (gaps[index - 1] ?? 0) > limit ? 'M' : 'L';
      return `${command}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * A note set inside the body, with a leader down to the gap where the smoke stalls. The
 * speed is the solver's; that the flow there leaves the centre plane sideways was found
 * on the Ahmed plate (see DESIGN.md), so only that body carries the note.
 */
function gapNote({ under, below, speed }: NonNullable<PlateExposure['gap']>): SVGGElement {
  const percent = 100 * speed;
  const lines = [
    `gap flow about ${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`,
    'of the free stream, leaving',
    'the centre plane sideways',
  ];
  const note = document.createElementNS(SVG, 'g');
  note.classList.add('plate-note');
  const [x, top] = under;
  const leader = document.createElementNS(SVG, 'path');
  leader.setAttribute(
    'd',
    `M${x.toFixed(1)} ${(top - 8).toFixed(1)} L${x.toFixed(1)} ${below[1].toFixed(1)}`,
  );
  const text = document.createElementNS(SVG, 'text');
  text.setAttribute('text-anchor', 'middle');
  for (const [index, words] of lines.entries()) {
    const line = document.createElementNS(SVG, 'tspan');
    line.setAttribute('x', x.toFixed(1));
    line.setAttribute('y', (top - 14 - 16 * (lines.length - 1 - index)).toFixed(1));
    line.textContent = words;
    text.append(line);
  }
  note.append(leader, text);
  return note;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(text: string, href: string, className = ''): HTMLAnchorElement {
  const anchor = element('a', className, text);
  anchor.href = href;
  return anchor;
}

/** The caption under the plate and the kept smoke fronts drawn over it. */
export function createPlateCaption(): {
  element: HTMLElement;
  overlay: SVGSVGElement;
  begin: (run: PlateRun) => void;
  update: (update: ForceReportUpdate) => void;
  expose: (exposure: PlateExposure) => void;
} {
  const caption = element('div', 'plate-caption');
  const left = element('div', 'plate-caption__subject');
  const number = element('p', 'plate-number');
  const title = element('h1', 'plate-title');
  const conditions = element('p', 'plate-conditions');
  const scale = element('p', 'plate-scale');
  const speed = link('', '#speed', 'plate-condition--control');
  const length = link('', '#size', 'plate-condition--control');
  for (const control of [speed, length]) {
    control.addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById(control.hash.slice(1))?.focus();
    });
  }
  const scaleBefore = document.createTextNode('');
  const scaleAfter = document.createTextNode('');
  scale.append(scaleBefore, speed, ', ', length, scaleAfter);
  const whyText = document.createTextNode('');
  const whyLink = link('How accurate is this?', '#/validate', 'plate-why__link');
  const fit = element('button', 'plate-fit', 'Show complete body');
  fit.type = 'button';
  fit.setAttribute('aria-pressed', 'false');
  fit.addEventListener('click', () => {
    const complete = fit.getAttribute('aria-pressed') !== 'true';
    fit.setAttribute('aria-pressed', String(complete));
    fit.textContent = complete ? 'Show close view' : 'Show complete body';
    document.dispatchEvent(new CustomEvent('plate-fit', { detail: complete }));
  });
  const hint = element(
    'p',
    'plate-hint',
    'Drop an STL, 3MF or OBJ anywhere on the plate to expose your own body.',
  );
  const heading = element('div', 'plate-heading');
  heading.append(number, title);
  const why = element('p', 'plate-why');
  const notes = element('div', 'plate-notes');
  why.append(whyText, whyLink);
  notes.append(scale, why);
  left.append(heading, fit, conditions, notes, hint);

  const right = element('div', 'plate-caption__figure');
  const figure = element('p', 'plate-figure');
  const symbol = element('span', 'plate-figure__symbol');
  symbol.innerHTML = 'C<sub>d</sub>';
  const value = element('span', 'plate-figure__value');
  figure.append(symbol, value);
  const verdict = element('p', 'plate-verdict');
  const comparison = element('div', 'plate-compare');
  comparison.hidden = true;
  const reading = element('div', 'plate-reading');
  reading.append(comparison, figure);
  right.append(reading, verdict);
  caption.append(left, right);

  const overlay = document.createElementNS(SVG, 'svg');
  overlay.classList.add('plate-exposures');
  overlay.setAttribute('aria-hidden', 'true');

  // Every grade is fetched up front, so a change of grade never falls back to another face.
  for (const grade of GRADES) void document.fonts?.load(`40px '${grade}'`).catch(() => undefined);
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  let run: PlateRun | undefined;
  let lastFigure = Number.NEGATIVE_INFINITY;
  let shown = false;
  let grade: Grade | undefined;
  const kept = new Map<number, SVGGElement>();

  function show(text: string, next: Grade): void {
    if (next !== grade && value.textContent && !still.matches) {
      const ghost = value.cloneNode(true) as HTMLElement;
      ghost.classList.add('plate-figure__ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.left = `${value.offsetLeft}px`;
      ghost.style.top = `${value.offsetTop}px`;
      figure.append(ghost);
      // The old grade leaves before the new one arrives, so the two never overlap as a jumble.
      const out = 0.4 * GRADE_FADE_MS;
      void ghost
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: out, easing: 'ease-in' })
        .finished.catch(() => undefined)
        .finally(() => ghost.remove());
      value.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: GRADE_FADE_MS - out,
        delay: out,
        easing: 'ease-out',
        fill: 'backwards',
      });
    }
    value.textContent = text;
    if (next !== grade) value.style.fontFamily = `'${next}', var(--pwt-serif)`;
    grade = next;
  }

  function condition(text: string, className = 'plate-condition'): HTMLElement {
    return element('span', className, text);
  }

  function writeConditions(update: ForceReportUpdate | undefined): void {
    if (run === undefined) return;
    const fullScale = (run.speedMps * run.bodyLengthMm) / 1000 / NU_AIR;
    const simulated = update === undefined ? fullScale : simulatedRe(update, run);
    const floored = update?.readout.effectiveRe !== undefined;
    const grid = update?.readout.grid;
    const blockage = update?.readout.blockagePct;
    speed.textContent = `${Number(run.speedMps.toPrecision(4))} m/s`;
    speed.href = run.laminar ? '#size' : '#speed';
    length.textContent = `${run.bodyLengthMm} mm long`;
    const lead = condition(`Re ${formatRe(simulated)}`, 'plate-condition plate-condition--lead');
    lead.append(element('span', 'plate-condition__basis', ' on body length'));
    conditions.replaceChildren(
      lead,
      ...(grid ? [condition(`domain ${grid.nx} × ${grid.ny} × ${grid.nz} cells`)] : []),
      ...(blockage === undefined ? [] : [condition(`blockage ${Math.round(blockage)}%`)]),
      ...(run.laminar ? [condition('LES off, no viscosity floor')] : []),
      condition('centre plane'),
    );
    scaleBefore.data = floored ? 'Full-scale reference: ' : '';
    scaleAfter.data = floored
      ? `, Re ${formatRe(fullScale)}. The lattice cannot run so thin a flow, so this plate runs at its viscosity floor. Exposure times assume the reference speed.`
      : '. The exposure times are at this speed.';
    const ahmed = run.presetId === 'ahmed-25';
    comparison.hidden = !ahmed && !run.laminar;
    if (run.laminar) {
      comparison.replaceChildren(
        element('p', 'plate-compare__figure', String(SPHERE_RE_100_REFERENCE_CD)),
        element('p', 'plate-compare__label', 'Schiller–Naumann correlation at Re 100'),
      );
    }
    const flooredRe = floored ? formatRe(simulated) : undefined;
    if (ahmed) compare(flooredRe, blockage);
    else if (run.laminar)
      whyText.data = 'The sphere is compared with the Schiller–Naumann correlation at Re 100. ';
    else unmeasured(flooredRe);
  }

  function unmeasured(flooredRe: string | undefined): void {
    whyText.data = `${flooredRe === undefined ? '' : `This live run holds the body at Re ${flooredRe}, where the air acts far more viscous than at full scale, which raises its drag. `}No wind-tunnel measurement of this body sits beside the figure. `;
  }

  function compare(flooredRe: string | undefined, blockage: number | undefined): void {
    comparison.replaceChildren(
      element('p', 'plate-compare__figure', String(AHMED_25_REFERENCE_CD)),
      element(
        'p',
        'plate-compare__label',
        `measured at ${AHMED_TUNNEL_MPS} m/s, Re ${formatRe(AHMED_25_REFERENCE_RE)}, by Ahmed and colleagues, 1984`,
      ),
    );
    const crowding =
      blockage === undefined
        ? ' That raises its drag'
        : `, and the body fills ${Math.round(blockage)}% of the tunnel's section, which crowds the flow. Both raise its drag`;
    whyText.data =
      flooredRe === undefined
        ? ''
        : `This live run holds the body at Re ${flooredRe}, where the air acts far more viscous${blockage === undefined ? '.' : ''}${crowding} well above the measurement. Validation runs the full-scale Re ${formatRe((AHMED_VALIDATION_SPEED_MPS * AHMED_BODY_LENGTH_MM) / 1000 / NU_AIR)} on finer grids. `;
  }

  return {
    element: caption,
    overlay,
    begin(next) {
      run = next;
      fit.setAttribute('aria-pressed', 'false');
      fit.textContent = 'Show complete body';
      number.textContent = `Plate ${next.plate}`;
      const [subject, variant] = plateTitle(next.presetId, next.label, next.bodyLengthMm);
      title.replaceChildren(subject);
      if (variant) title.append(' ', element('em', '', variant));
      shown = false;
      value.textContent = '';
      show('', 'Redaction 10');
      verdict.textContent = figureVerdict({
        cd: null,
        status: { kind: 'settling', etaS: null },
        samples: 0,
      });
      writeConditions(undefined);
      kept.clear();
      overlay.replaceChildren();
    },
    update(update) {
      if (run === undefined) return;
      const now = performance.now();
      const { summary } = update.readout;
      const settled = summary.status.kind !== 'settling';
      if (now - lastFigure < FIGURE_INTERVAL_MS && !settled) return;
      lastFigure = now;
      const latest = update.history[update.history.length - 1]?.[1];
      let withheld: Withheld = shown ? 'last reported' : 'nothing';
      if (summary.cd !== null) {
        shown = true;
        show(summary.cd.toFixed(2), figureGrade(summary, update.readout.gridBandPct));
      } else if (!shown && latest !== undefined && Number.isFinite(latest)) {
        withheld = 'instantaneous';
        show(latest.toFixed(2), figureGrade(summary, update.readout.gridBandPct));
      }
      verdict.textContent = figureVerdict(summary, update.readout.gridBandPct, withheld);
      writeConditions(update);
    },
    expose({ milliseconds, points, band, gap }) {
      const key = Math.round(milliseconds * 10);
      const refit = kept.get(key);
      refit?.remove();
      const top = points.reduce(
        (best, point) => (point[1] < best[1] ? point : best),
        [0, Infinity],
      );
      if (!Number.isFinite(top[1])) return;
      const group = document.createElementNS(SVG, 'g');
      // A front redrawn for a new plate size is already developed; only a new one fades in.
      group.classList.add(refit ? 'plate-exposure--kept' : 'plate-exposure');
      const line = document.createElementNS(SVG, 'path');
      // The front, joined by a leader to its label in the clear band above the rake.
      const labelY = Math.max(LABEL_FLOOR_PX, Math.min(band - 8, top[1] - 18));
      line.setAttribute(
        'd',
        `M${top[0].toFixed(1)} ${(labelY + 4).toFixed(1)} L${top[0].toFixed(1)} ${top[1].toFixed(1)} ${exposurePath(points)}`,
      );
      const label = document.createElementNS(SVG, 'text');
      label.setAttribute('x', top[0].toFixed(1));
      label.setAttribute('y', labelY.toFixed(1));
      label.setAttribute('text-anchor', 'middle');
      label.textContent =
        milliseconds >= 1000
          ? `${(milliseconds / 1000).toFixed(1)} s`
          : `${milliseconds.toFixed(1)} ms`;
      group.append(line, label);
      if (gap && run?.presetId === 'ahmed-25') group.append(gapNote(gap));
      overlay.append(group);
      kept.set(key, group);
    },
  };
}
