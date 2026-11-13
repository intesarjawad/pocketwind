# 013: High-Reynolds walls, outlet and drag sampling

Status: accepted; the Ahmed rows miss the 10% band, and the browser grids cannot reach it
(see [Grid limit](#grid-limit)).

## Context

The Ahmed body runs at Re 2.78e6 with a lattice viscosity near 1e-6, so the relaxation time
sits within a few millionths of 1/2. There the TRT default stopped within the first
flow-through, and the regularized collision stayed finite only long enough to report drag
that swung by several times its own size between samples. Four causes were separated by
switching one change at a time on the Ahmed rows:

1. **Period-two oscillation.** Near walls the populations alternate from one step to the next.
   Forces were sampled every eighth step, always on the same phase, so a single sample read one
   half of the oscillation. Odd-step and even-step samples gave drag of opposite sign.
2. **Unresolved boundary layer.** Halfway bounce-back assumes the first fluid node resolves the
   viscous sublayer. At this viscosity it lies hundreds of wall units out, and the wall
   exchanges momentum as if the velocity fell to zero across half a cell. The friction this
   produces dwarfs the pressure drag: the pressure part alone was near the reference while the
   full momentum exchange was several times it.
3. **Reference pressure on an open surface.** The momentum exchange carried the 2 c_j w_j term
   of the reference density. A body cut by its stilts has no links on the cut faces, so the term
   does not cancel and gave a lift several times the drag.
4. **Velocity outlet half a body length behind the base.** An equilibrium plane at the inlet
   velocity forces the wake back to free stream, which confines it and raises base pressure
   drag.

TRT diverges independently of all four: with Λ = 3/16 its odd-moment rate goes to zero as the
even rate goes to 2, and nothing damps the resulting modes.

## Decision

- **Pair the force samples.** The force kernel averages the momentum exchange over both
  ping-pong states, the two latest steps, so a period-two oscillation cancels in every sample.
- **Gauge pressure.** The momentum exchange drops the reference-pressure term. A closed body
  loses nothing; a cut body loses only the spurious part.
- **Wall function.** With the sub-grid model on, a cell with wall links sets its
  post-collision stress so the wall receives the shear of Werner and Wengle's power law at
  half a cell, with the smallest stress that does so; the derivation is in
  [Numerics](../numerics.md#wall-function). This is the stress-imposing family of LBM wall
  models that Malaspinas and Sagaut (2014) build on the regularized collision. The normal flux
  stays with bounce-back, so the wall remains impermeable.
- **Pressure outlet.** The last x plane takes reference density with the velocity of its
  upstream neighbour, so the wake leaves at its own speed.
- **Default operator follows the regime.** With the sub-grid model on, the default is the
  regularized collision: it is the only operator that stays finite on the road-speed rows
  (Latt and Chopard, 2006). With it off, the default is TRT, the more accurate operator on the
  laminar sphere, where its wall location does not depend on viscosity: at Re 100 the
  regularized default read 10.3% error at tier L, outside the 10% band, where TRT reads 8.7%.
  One function, `defaultOperator(les)`, serves the app and the validation, so a default row
  is what a user gets. The app always runs with the sub-grid model on.

Rejected:

- A wall function that also fixed the normal flux. It made the floor-stilt corner diverge,
  because it lets mass through the wall.
- Interpolated walls with the wall function. The wall function sets the post-collision stress
  that cancels the bounce-back flux of the equilibrium, which holds only when the population
  returned by the wall is the cell's own g*_j. Linear Bouzidi interpolation mixes in the next
  node's population (q < 1/2) or g*_i (q > 1/2), so the cancellation fails and every wall cell
  takes a momentum kick the size of that stress on every step; the Ahmed rows stopped within the
  first hundred steps. Interpolated walls are also not yet a validated GPU factor (ADR-010).
- Running the Ahmed rows at a lower Reynolds number and arguing Re-independence. At 25° the
  drag comes from the slant's partly separated flow and its side vortices, which depend on the
  state of the boundary layer, and the viscosity floor that keeps TRT finite gives a Reynolds
  number in the hundreds (ADR-001), far from any range where that argument holds.

## Evidence

`npm run validate -- --only=laminar,validation,shape-classes --tiers=S,M,L` on an Apple M5:

| Case | Tier | Operator | Cd | Reference | Error |
| --- | --- | --- | ---: | ---: | ---: |
| Ahmed 25° | S | reg | 0.851 | 0.285 | +199% |
| Ahmed 25° | M | reg | 0.817 | 0.285 | +187% |
| Ahmed 25° | L | reg | 0.791 | 0.285 | +177% |
| Ahmed 25° | L | reg, f16 storage | 0.784 | 0.285 | +175% |
| Ahmed 25° | L | trt | not finite at step 560 | 0.285 | n/a |
| Cube, LES | S / M / L | reg | 0.964 / 0.890 / 0.877 | none | n/a |
| Sphere at Re 2e4, LES | S / M / L | reg | 0.688 / 0.649 / 0.619 | none | n/a |
| Sphere at Re 100 | S / M / L | trt | 1.199 / 1.190 / 1.185 | 1.09 | +10.0 / +9.1 / +8.7% |
| Sphere at Re 100 | S / M / L | reg | 1.254 / 1.216 / 1.202 | 1.09 | +15.1 / +11.5 / +10.3% |

Every regularized Ahmed row is now finite and steady (relative fluctuation under 3%, drift
under 2%), and drag falls monotonically with refinement. The band is still missed by a factor
of about 2.8. The laminar sphere runs with the sub-grid model off, so the wall function does
not touch it; TRT still passes there at M and L.

`npm run validate -- --only=validation,sensitivity --tiers=L,XL` on the same machine, at
commit 4685209:

| Case | Grid | Body length in cells | Blockage | Cd |
| --- | --- | ---: | ---: | ---: |
| Ahmed 25°, default | L | 128 | 10.0% | 0.791 |
| Ahmed 25°, default | XL | 192 | 10.2% | 0.730 |
| Ahmed 25°, larger domain | XL | 128 | 4.5% | 0.648 |
| Ahmed 25°, shorter body | L | 77 | 3.7% | 0.708 |
| Ahmed 25°, stilts in the force | L | 128 | 10.3% | 0.873 |
| Ahmed 25°, inlet speed 0.1 | M | 96 | 9.9% | 0.757 |

`npm run validate -- --only=laminar,verification --tiers=M` at the same commit repeats the
laminar rows above (TRT 1.190, regularized 1.216) and passes every analytic case.

## Remaining limits

- **The Ahmed rows fail**, by more than the grids here can close; see
  [Grid limit](#grid-limit).
- **The wall law assumes an attached, turbulent, equilibrium boundary layer.** It is wrong on
  a subcritical sphere, whose boundary layer is laminar until it separates, and in separated
  regions. The Re 2e4 sphere's drag sits above the 0.4 to 0.5 commonly tabulated for
  subcritical spheres, and the cube's below the 1.05 usually quoted for a face-on cube; neither
  row has a recorded reference, so neither is a pass.
- **TRT is still not finite at road speed**, with or without the wall function.
- **Not measured here:** the confinement group.

## Grid limit

The committed validation and sensitivity runs establish that these uniform browser grids miss the
Ahmed reference band. They do not isolate a single cause for the excess drag.

Exploratory free-slip, per-column force-binning and interpolated-wall experiments were not preserved
with scripts and raw data. The earlier claims that the excess is inviscid, concentrated in the first
two nose columns, independent of wall treatment, or improved by a particular interpolated closure
are therefore unverified hypotheses. They must not be used as evidence for accuracy or as grounds to
rule out wall-model error. Repeating them requires committing the solver changes, geometry, run
parameters and force records first.

The domain and shorter-body sensitivity cases are reproducible with `npm run validate --
--only=validation,sensitivity --tiers=M,L,XL`; their measured rows remain in
`public/validation/results.json`. They change confinement and inlet distance together, so they
demonstrate sensitivity without separating those mechanisms.

Local refinement is a candidate, rather than a demonstrated fix for this implementation. SimScale's
validation of the same 25° body
with its lattice Boltzmann solver, in a 6 × 5 × 13.5 m tunnel, reports Cd 0.388 (+32.5%) with
5 mm cells on the body surface, 0.310 (+7.7%) with 2 mm and 0.300 (+4.7%) with 0.8 mm. The tiers
here use uniform cells of 16.3, 10.9, 8.2 and 5.4 mm, so XL matches that study's coarsest mesh,
which also misses the band in that different solver and setup (60 m/s, Re 4.29e6, reference Cd
0.2875). These figures are not a validation of this solver. A uniform 2 mm grid in the present box
is 1044 × 522 × 522 cells;
`bytesForLayout` gives 50.1 GB at f32 and 28.4 GB at f16, and the largest f32 population buffer
alone, 8.0 GB, is nearly twice the 4.3 GB `maxBufferSize` Chromium reports on the M5
([Browser support](../browser-support.md)). Local refinement would reduce the memory needed near the
body, but whether it closes this solver’s error remains untested. Until then the
Ahmed rows record the drag the browser grids give, and they fail.

## References

- S. R. Ahmed, G. Ramm and G. Faltin (1984), *Some salient features of the time-averaged
  ground vehicle wake*, SAE Technical Paper 840300.
- J. Latt and B. Chopard (2006), *Lattice Boltzmann method with regularized pre-collision
  distribution functions*, Mathematics and Computers in Simulation 72, 165–168.
- O. Malaspinas and P. Sagaut (2014), *Wall model for large-eddy simulation based on the
  lattice Boltzmann method*, Journal of Computational Physics 275, 25–40.
- SimScale, *Validation case: aerodynamics of the Ahmed body (LBM)*,
  https://www.simscale.com/docs/validation-cases/aerodynamics-ahmed-body-lbm/, read 2026-11-11.
- H. Werner and H. Wengle (1993), *Large-eddy simulation of turbulent flow over and around a
  cube in a plate channel*, Turbulent Shear Flows 8, 155–168.

Publication metadata for the four papers was confirmed through Semantic Scholar. The wall-model full
texts were not read here, so the wall-law constants follow their standard statement rather than a
quoted
equation, and no claim is made that this solver reproduces either wall model's published
results.
