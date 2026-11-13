# Design

The page is a photographic plate. The solver's own velocity field carries smoke
threads past the body, and the threads are the picture. Everything else on the
page is the caption under that plate and the notes behind it.

## What it takes, and from where

- **Étienne-Jules Marey's smoke machine (1901).** Parallel threads of smoke drawn
  past a card in a black box, photographed on glass. From Marey: a rake of evenly
  spaced threads entering from the left edge, a black velvet ground, a body shown
  as a dark card rather than a model, and the plate number and title set under the
  image like a catalogue entry. Marey also exposed the moving smoke at known
  instants; the dashed lines across the plate are those instants, labelled in
  milliseconds of physical time on a clear band above the rake.
- **Dye ports, as smoke tunnels use them.** Six more threads are released from
  the body itself: three one cell behind its base (the middle one fills the dead
  air at mid-base), one just above the separation
  line of the upper surface (where it first falls away at about 20 degrees behind
  its crest: the end of the roof on the Ahmed body, the rear shoulder of a smooth
  body), one just behind the top of the base, and one in the gap under the nose of
  a flat underside or, on a rounded body, at the separation line of the lower
  surface, so smoke frames the wake from below as well.
  They are streaklines of the same field, so the shear layer leaving the roof and
  slant wraps the bubble behind the base. Smoke behind the base laps the bubble
  every few flow-throughs; it is drawn for its first two laps and fades out between
  3.5 and 6 flow-throughs of age, so the bubble reads as an open spiral with free
  ends rather than closed orbits filled with old dye. Port dye that has barely left
  its port after a flow-through, in a dead corner beside the body, fades out rather
  than building into a grey block; behind the base it is circling the bubble, so it
  stays.
- **Mathis Biabiany, "Figures drawn in light" (Codrops, 2026).** Lines rendered
  as lit tubes rather than flat strokes: each thread has a round cross-section lit
  from one lamp, a narrow sheen along its crest and a soft halation around it. Here
  the tubes are the streaklines themselves, so the figure builds as the flow
  develops instead of following a scripted path.
- **The eroded figure.** The drag coefficient is set in Redaction, whose grades
  run from a clean cut to a heavily eroded print. The figure's grade follows its
  uncertainty, so convergence reads in the type instead of in a second chart.
  From grade 20 up the curves break into square pixels at figure size and read
  as a display font rather than worn print, so the figure uses only grade 10 and
  the clean cut: grade 10 until the sampling and grid bands together fall under
  0.25%. A change of grade fades through over 600 ms (the old grade leaves before
  the new one arrives) instead of swapping fonts.

## The signature moment

On load the plate is black. The rake starts releasing puffs at the inlet, and the
threads grow across the plate, part around the nose, run along the roof and
leave the slant, where the dye ports' threads curl into the recirculation behind
the base. Until the drag statistics can report a band, the caption shows the
instantaneous drag in Redaction 10 and says so, and sharpens to the clean cut
only once a grid band is known and small. Three exposure lines appear as the
smoke front passes 12%, 55% and 105% of the body length.

Each thread keeps 8192 puffs, about fifty flow-throughs of release. The threads
under the body do not reach the base, and that is the flow, not the renderer: at
Re 320 the gap under the body runs at about a hundredth of the free stream, and
its rear is dead air on the centre plane, because the flow there leaves the plane
sideways. Their fronts slow to a stop about an eighth of a body length short of the
base (at x ≈ 1000 px of 1440 after 31 flow-throughs, against 935 px after 17),
and dye released under the rear of the body never moves far enough from its
port to show.
Smoke diffuses as it ages: each puff widens with the root of its age (twice as
wide after 4.5 flow-throughs) and dims as it widens, and an old puff loses its
crest and fades out toward its edge. Smoke that moves with the free stream leaves
the plate within about a flow-through and barely changes; smoke held in the gap
spreads into a dim cloud, so the stalled front is never the brightest thing on the
plate. Each thread's front also fades over 25 px. Once the flow has passed six
times, the plate reads the solver's speed three fifths of the way along the gap,
halfway down (1.7% of the free stream on the default run), and an italic note
inside the body, with a hairline leader to that point, says so and that the flow
there leaves the centre plane sideways. Only the Ahmed preset carries the note,
since only its gap has been examined.

Dropping an STL, 3MF or OBJ anywhere on the plate replaces the body in place and
the smoke develops again around it.

The rake has 36 threads. Each is a tube about 40% of the rake's spacing wide,
with a weight that varies from half to one and a half times the mean from thread
to thread, a brightness that varies from about half to full as if the threads sat
at different depths across the span (port dye keeps full light), a diffuse flank,
a specular crest and a light halation. A crest
narrower than a pixel aliases into moiré across the rake, so thin tubes get a
broader crest. Threads take the brightest light at each pixel rather than the
sum, so smoke that piles against a wall or circles in a corner eddy stays one tube
bright; near the body the light is also capped, and halation is fed no more than
a lit crest's worth by any pixel. Within about ten CSS pixels of the body the
light is capped lower and the halation cut, so threads squeezed over a convex crest
read as a soft boundary layer rather than a bright burr. The stilts stand behind
the plane of smoke as a dimmer card with a faint rim, so they read as stilts
whether smoke covers them or not.

Implementation, all on the solver's WebGPU device with no second renderer:

| Stage | File |
|---|---|
| Release and RK2 advection on the centre plane | `src/render/shaders/plate_smoke.wgsl` |
| Lit tube ribbons, tapered and thinned by stretch | `src/render/shaders/plate_threads.wgsl` |
| Body and stilt mask | `src/render/shaders/plate_body.wgsl` |
| Halation, velvet ground, card, tone and grain | `src/render/shaders/plate_post.wgsl` |
| Pipelines, frame loop, exposures, still mode | `src/render/plate.ts` |
| Fitting the centre plane to the viewport, rake and dye ports | `src/render/plate-layout.ts` |
| Figure grade and verdict | `src/app/figure-grade.ts` |
| Caption and exposure labels | `src/app/plate-caption.ts` |

The older orbit view of the 3D streamlines remains available with `?cam=` in the
hash, for example `#/?cam=rearquarter`.

## Tokens

All colours, sizes, spacing and motion live in `src/app/styles/tokens.css`;
`npm run check` rejects any other stylesheet that sets them literally.

| Token | Value | Use |
|---|---|---|
| `--velvet`, `--pwt-ground` | `#050505` | Plate and page ground |
| `--floor` | `#0b0b0a` | Tunnel floor below the ground line |
| `--pwt-smoke` | `#ece8de` | Smoke, a warm silver |
| `--pwt-body` | `#2c2a27` | The body card |
| `--silver` | `#e9e5dc` | Text, 16.2:1 on the ground |
| `--silver-2` | `#a9a59c` | Secondary text, 8.3:1 |
| `--silver-3` | `#8a867e` | Notes and labels, 5.6:1 |
| `--rule`, `--rule-strong` | `#2a2927`, `#4a4843` | Hairlines and control borders |
| `--focus` | `#ffffff` | Focus ring |

## Type

One family: Redaction (SIL OFL 1.1, see `CREDITS.md`). Regular and italic for
text, grade 10 for the drag figure only. Titles and section captions are
italic; plate numbers are small capitals with wide tracking.

## Below the plate

Each tunnel chapter opens on a hairline with an italic heading; the validation
page's sections use upright headings, so the device is not repeated. Only the experiment has
a line under its heading, saying what a change does; the record explains itself in
its caption and the keep actions need none. Actions are words on a hairline, not
boxes, except Choose a model, the action the page exists for, which is set solid.
The form runs in two columns: the body's preset, size and speed down the left, the
comparison, Advanced and Check grid down the right. The keep actions sit in one row with even gaps (an empty status line
takes no room). The drop target is a line of italic text, not a box. A checkbox is
drawn as the speed slider's hairline and thumb, and the speed sits beside its
slider. Advanced opens across the form. The drag record is 180 to 240 px tall,
with a log time axis in flow-throughs from the point where the record comes into
the scale. Its Cd scale runs from zero to a round number above the settled
record and the reference, so the run's own figure sits well clear of the
reference line; the start-up spike is clipped at the top and labelled with its
value from the run ("↑ 33 at start") at the left end of the line. The settled line is labelled with the run's
figure ("2.27 this run") and the dashed reference with its value ("0.285 wind
tunnel"), both read from the data. It has hairline axes rather than a box, and the
window the figure averages is a tinted band under a bracket labelled "averaged
over the last 1 flow-through". On the log scale that window would be a few pixels
wide, so it keeps 56 px on a linear scale of its own at the right, as the caption
says. The plate's lighter floor ends on a rule. The page closes
on a colophon in prose rather than a row of links, with no more than the page's
bottom margin after it.

Under the plate, the right column holds only the figure, the measured value and
the status line; the note on why the figure differs from the measurement sits on
the left beside the full-scale reference. On a phone the plate frames the nose of
the body and the gap under it, with every other rake thread (18) at twice the
width, since 36 threads in 150 px fuse into moiré; the plate's number and title sit above the
picture, the measured value sits under the figure as one unit, and the masthead
keeps "How accurate is this?".

The validation page is a plate in two columns: the saved Ahmed rows by grid
against 0.285 and its pass band, beside which run they are, the blockage they
carry and where to trust them. The record follows in two balanced columns, with
every group not yet run in one list, each with its reason. Columns of figures are
right-aligned in tabular lining figures with true minus signs, each error column
names its measure (amplitude error, peak speed error, Cd error), all in percent,
and the page works out the Taylor-Green order of accuracy from the saved errors.
A shape class run only on other grids says "Not run" for tier L. The other
tiers' errors have a column of their own, "n/a" where there are none. The bars of
the Ahmed figure leave the right of the plot to the measurement's label. Rows are named for what they vary
("Regularized, 16-bit storage", "Larger domain, 4.5% blockage"), built from the
row's own fields rather than its id in results.json, and an empty cell reads "n/a".
A sensitivity row that reproduces the default's drag is labelled "(default)". The BGK row's note says in one sentence
that the row shows the check can see a known error, with the row's own offset.
The band label sits inset from the end of the band, and the figure caption names
body length as the length behind Re 2.8 million.

## Motion

- The smoke itself is the only continuous motion.
- Each exposure line fades in over 900 ms as the smoke front reaches it; links
  and borders change over 160 ms.
- With reduced motion the plate shows one still: the bare plate, then the
  developed plate once the flow has passed six times, with no animation between.
- Rendering stops when the plate is off-screen or the tab is hidden. Space pauses.
- Pixel ratio is capped at 2, and at 1 on touch devices.

## Every number and where it comes from

| On the page | Source |
|---|---|
| Cd, the sampling band and the steady verdict | The live run: `src/forces/drag-stats.ts` over the solver's force readings; a band under 1% is written as such |
| Re (on body length), domain cells, speed and length | The live run: `src/app/run.ts` with `src/lbm/units.ts` (viscosity floor `NU_MIN_LU`) |
| Full-scale reference: 40 m/s, 1044 mm, Re 2.8 million | The run's settings; Re from `NU_AIR` in `src/lbm/units.ts` |
| Blockage on the plate | The live run: frontal cells over the tunnel's cross-section, `src/app/run.ts` |
| Blockage effect on the validation page (18% lower in the larger domain) | The `sensitivity-domain` and default tier L rows of `public/validation/results.json` |
| Exposure times in ms | `src/render/plate.ts`: lattice steps times `secondsPerStep` in `src/render/plate-layout.ts`, at the reference speed |
| 0.285 at Re 4.3 million, Ahmed and colleagues, 1984 | `AHMED_25_REFERENCE_CD` and `AHMED_25_REFERENCE_RE` in `src/validation/cases.ts` |
| Ahmed's tunnel at 60 m/s | `src/app/plate-caption.ts`: the reference Re times `NU_AIR` over the 1044 mm body length gives 61.6 m/s, rounded to 5 m/s |
| Record chart labels ("33 at start", "2.27 this run") | The live run's drag history and summary, `src/app/force-plot.ts` |
| Validation figure: 0.791 (L) and 0.730 (XL) at Re 2.8 million | `public/validation/results.json`, written by `npm run validate` at commit 4685209 |
| Cd 2.27 at Re 320 in the README hero and social card | `npm run stills` (`scripts/plate-stills.ts`, 20 flow-throughs), which prints the caption it captured |
| Gap flow on the plate (1.7% on the default run) | The live run: `src/render/plate.ts` reads the solver's velocity in the gap after six flow-throughs and divides by `U_LU` |
| Taylor-Green ratios 4.02 and 4.00, order 2.01 and 2.00 | `taylorGreenOrder` in `src/app/validate-page.ts`, from the saved amplitude errors |

The default run is tier S (128 × 64 × 64), where the viscosity floor holds the
Ahmed body at Re 320. Tier M (`#/?t=M`) runs it at Re 480 and reports about 1.88.
Neither is the full-scale Re 2.8 million at 40 m/s, nor the measurement's 4.3
million at 60 m/s; the caption says so and links to the validation page. The
validation rows run at the full-scale Re 2.8 million with the
regularized collision and wall function: 0.791 at tier L and 0.730 at XL in the
saved results, and 0.817 at tier M in `docs/adr/013-high-reynolds-walls.md`, whose
M run was not saved, so the page shows convergence as not yet run.

## What must not change

- The threads are streaklines from the solver's field, never a drawn or scripted
  path, and never decoration on a page without a live run.
- One renderer: the solver's GPU device and stack.
- The figure's grade only ever reflects its uncertainty.
- No number appears without its body, tier and Reynolds number beside it.
- Black plate, silver smoke, one serif. No accent colour.
- No force in newtons for a run at the viscosity floor: its Cd belongs to a slower,
  more viscous flow, and the full-scale dynamic pressure would turn it into a
  number with no meaning.
