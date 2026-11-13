# Architecture

The static browser application separates geometry, GPU simulation and interface
state. Mesh import and the f32 solver exist; force reporting, visualization and
full physical validation remain incomplete. [Numerics](numerics.md) describes the
implemented solver contract and its known limitations.

## Runtime boundaries

The application is a static browser site. `app/` owns DOM access, controls,
dropzone, routes, readouts and exports. Routes are `#/` for the tunnel,
`#/validate` for validation and `#/bench` for performance results. Validation
content must remain accessible without WebGPU. User-facing errors live in
`app/messages.ts` as a description and an actionable next step.

The geometry worker parses models and builds the voxel grid. Its typed result
contains flags, wall masks, wall-link fractions, body boundary cells, frontal
area and blockage. Parsing and geometry mathematics do not access the DOM or GPU.
See [ADR-004](adr/004-worker-voxelization-and-wall-links.md).

`gpu/` owns device acquisition, feature and limit detection, and error scopes.
`lbm/gpu-solver.ts` and `render/` receive GPU resources without reading the DOM.
Compute and rendering share one device. Unsupported devices receive browser
next steps; allocation failures use scoped errors and tier step-down.

## Simulation and render flow

The app sends a model and placement parameters to the geometry worker, then
uploads the returned geometry to the GPU. The solver initializes shifted
populations and runs pull streaming followed by collision. Population storage
uses separate input and output sets, each split into direction groups; the sets
swap after every step. Precomputed wall masks avoid neighbour-flag reads.
See [ADR-001](adr/001-lattice-and-collision.md),
[ADR-002](adr/002-shifted-storage-and-buffer-split.md) and
[ADR-003](adr/003-pull-streaming-and-wall-mask.md).

Each rendered frame advances an adaptive number of solver steps. The final step
writes macroscopic density and velocity for rendering. Particles read that
field; render passes draw the mesh, particles, outlines, floor and optional
slice. Render-loop resources are allocated ahead of time.
See [ADR-007](adr/007-rendering-without-threejs.md).

At the force sampling interval, a kernel evaluates body links in boundaryCells,
reduces partial forces and copies the result into staging storage. CPU readback
does not overlap a pending map. Pure `forces/` modules compute statistics,
reference-area conversions, physical units and grid convergence. Readouts carry
status and grid; comparisons use CdA or force.
See [ADR-006](adr/006-drag-reporting-and-reference-areas.md).

## Verification and local execution

`lbm/reference/` provides a CPU solver for verification, using the same lattice
and mathematics with double-precision arithmetic. Unit tests cover the pure
core. Browser checks cover shaders, GPU agreement, rendering and interaction.
Validation results and performance measurements are produced by scripts rather
than inferred from adapter availability.
See [ADR-011](adr/011-validation-and-gci.md).

The dependency-free local CLI is intended to serve built assets on loopback.
CLI messages live in `bin/messages.mjs`.
The site and CLI run simulation locally without uploading models or requiring
accounts or paid services.

## Decision records and pending evidence

The [ADR collection](adr/) records design choices and their consequences.
[ADR-005](adr/005-boundary-conditions.md) tracks boundary experiments;
[ADR-008](adr/008-tooling-and-pins.md) records dependency constraints;
[ADR-009](adr/009-device-tiers-and-time-to-answer.md) defines tier selection;
[ADR-010](adr/010-interpolated-walls.md) covers interpolated walls; and
[ADR-012](adr/012-precision-modes.md) defines precision gating.

Final operator, wall and precision defaults require measured validation.
I have not yet established whether full validation justifies retaining the solver;
[ADR-001](adr/001-lattice-and-collision.md) records that uncertainty.
