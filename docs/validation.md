# Validation

The validation run compares the browser solver with analytic solutions and
published drag measurements. Drag accuracy is validated only for the laminar sphere at Re 100 with TRT at M and L. Ahmed and other bluff vehicle bodies are experimental flow visualisations: the browser grids miss the 10% reference band. The failing rows stay visible; see [ADR 013](adr/013-high-reynolds-walls.md). Every reported coefficient is computed from the
mean force over the last two of six flow-throughs; grid convergence uses the
three finest default-operator grids.

The default operator follows the regime, in the app and here alike: TRT with the
sub-grid model off, the regularized collision with it on (ADR-013). A default
row is therefore TRT for the laminar sphere and regularized for every LES row.

## Reference values

| Case | Reference | Basis |
| --- | --- | --- |
| Ahmed body at 25° | Cd = 0.285 | Ahmed et al. (1984), based on the 0.112 m² frontal area |
| Sphere at Re 100 | Cd = 1.09 | Schiller-Naumann correlation, 24/Re (1 + 0.15 Re^0.687) |
| Cube and sphere shape classes | none | The shape-class rows record raw drag; they make no accuracy claim |

A row passes when the signed reference error is within 10%. Rows without a
reference pass when the force record is finite. Sampling fluctuation and grid
sensitivity remain separate from the reference comparison.

The Ahmed rows do not repeat the reference experiment's Reynolds number. Ahmed
et al. measured at 4.29e6 on the body length (abstract of
[doi:10.4271/840300](https://doi.org/10.4271/840300)); these rows run at 2.78e6.
The comparison therefore assumes that the drag coefficient changes little
between the two, and the 10% band has to absorb whatever change there is.

## Case list

- Analytic verification on the CPU reference solver: Taylor-Green observed order
  and the Poiseuille profile, speed and force errors.
- Laminar sphere at Re 100 with LES off at S, M and L, where the diameter is one
  eighth of the streamwise length, once per solver operator.
- Ahmed body at 25° at 40 m/s at S, M, L and XL. Tier L also flips one factor at
  a time from the defaults; a flip runs only when the factor has two levels on
  the adapter. The 35° body runs at tier L once a reference value for it is
  recorded above; until then the run lists it as skipped.
- Grid convergence of the default Ahmed rows over M, L and XL, and of the laminar
  sphere over S, M and L for each operator.
- Shape classes at floor off and LES on: a face-on cube and a sphere at
  Re 20000. The cube side is 0.2 of the cross-stream cells and the sphere
  diameter is 0.226, so frontal blockage is 4%.
- Confinement rows on the XL grid, keeping the tier-L body size in cells so that
  blockage falls by 2.25×, for the cube and the laminar sphere once per operator.
- Sensitivity rows at tier L: a larger domain, a shorter body, a doubled inlet
  speed at tier M, and stilts included in or excluded from the force sum.
- A grid check for each shipped preset over S, M and L, holding the effective Reynolds number of the
  S run constant by scaling lattice viscosity with body length in cells. This does not reapply the
  viscosity floor independently on finer tiers. JSON records that Reynolds number and the per-tier
  means. The band applies to L and is recorded separately from reference error and sampling
  uncertainty.

## Case kit

The kit lets another solver run the same cases and be scored against the same
reference values. The geometry files are in `public/validation/geometry`; the SHA-256 of
each is its line in `public/validation/geometry/CHECKSUMS.txt`, which `npm run geometry`
writes and `sh scripts/checksums.sh --verify` compares. Blockage is frontal area over the tunnel
cross-section; voxel rounding can change it slightly across tiers.

Generation requires Node.js 20+ and `npm ci` (the pinned `tsx` dependency); no OpenSCAD installation
is needed for this kit. `npm run geometry` exports the exact built-in browser triangles and
regenerates the checksums. `assets/scad` contains separate design sources, which require OpenSCAD to
render and are not the runtime tessellation. The unimplemented 35° body is excluded from the kit and
remains skipped.

| Case | Geometry file | Orientation | Speed or Re | Floor | Blockage | Averaging window | Reference | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ahmed-25` | `ahmed-25.stl` with `stilts.stl` | Nose to the inlet, 25° rear slant, upright | 40 m/s, Re 2.78e6 on the 1044 mm length | on, 50 mm stilts | 10.3% | last 2 of 6 flow-throughs | Cd 0.285 | Ahmed, Ramm and Faltin (1984), SAE 840300, doi:10.4271/840300, Fig. 4 (drag versus slant angle); 0.285 is the adopted benchmark value, not a newly digitised measurement |
| `ahmed-35` | not shipped (skipped) | Nose to the inlet, 35° rear slant, upright | 40 m/s, Re 2.78e6 on the 1044 mm length | on, 50 mm stilts | 10.3% | last 2 of 6 flow-throughs | none | none; the case is skipped |
| `sphere-re-100` | `sphere.stl` | Symmetric | Re 100 on the diameter | off | 4.9% | last 2 of 6 flow-throughs | Cd 1.09 | Schiller and Naumann (1933), Z. Ver. Dtsch. Ing. 77, pp. 318–320; correlation as implemented in [OpenFOAM](https://cpp.openfoam.org/v13/classFoam_1_1SchillerNaumannDrag.html) |
| `cube` | `cube.stl` | One face normal to the flow | 40 m/s | off | 4% | last 2 of 6 flow-throughs | none | none; raw drag only |
| `sphere` | `sphere.stl` | Symmetric | Re 20000 on the diameter | off | 4% | last 2 of 6 flow-throughs | none | none; raw drag only |

The sphere is scaled to its Reynolds number, so the speed follows from the
diameter and the kinematic viscosity of air, 1.5e-5 m²/s. The Ahmed, cube and
sphere rows run with LES on, as the tunnel does; the laminar sphere at Re 100
runs with it off.

### Results row format

A foreign solver reports one row per run, in this document:

```json
{ "solver": "<name and version>", "rows": [ { "case": "ahmed-25", "tier": "L", "cd": 0.3, "relStdPct": 1.2, "steps": 4000 } ] }
```

| Field | Meaning |
| --- | --- |
| `case` | The case id from the table |
| `tier` or `cells` | The grid, as a tier name or a cell count |
| `cd` | Drag coefficient from the mean force over the averaging window |
| `relStdPct` | Standard deviation of the force in the window, as a percentage of its mean |
| `steps` | Time steps the run took |

`node scripts/score-results.mjs <file>` (`npm run score -- <file>`) accepts this
format or this repository's `results.json`. From `results.json` it reads the
`isDefault` rows of the `laminar` and `validation` sections, which include the
shape-class rows, so rows that repeat a case for another operator are not
counted twice. It matches rows to cases by `case`, prints `case, cd, reference,
error %` for each matched row, with `-` where the case has no reference value,
then `unmatched: <n>` for the rows whose case is not in the table. It never runs
a solver, and it exits 1 for a file it cannot read or a row without a `case` or
a finite `cd`.

## Results

The checked-in table is written by `npm run validate`, which writes
`public/validation/results.json` and the marked blocks here and in the README.
Browser rows need a headed Chromium with a WebGPU adapter. A run takes only
these flags:

- `--only=<group>[,<group>...]` with `smoke`, `verification`, `laminar`,
  `validation`, `shape-classes`, `confinement`, `convergence`, `sensitivity` and
  `grid-check`. A partial run replaces only the rows of the groups it ran, and
  the top-level commit reads `mixed` when the rows differ. `smoke` is a
  two-flow-through tier-S plumbing check with no reference value and is never
  marked as a default row.
- `--tiers=S,M,L,XL` restricts the tiers inside the selected groups; the
  confinement rows always use the XL grid.
- `--remote=<url>` drives a deployed site instead of the local preview.
- `--out-cross-device` writes the run to
  `public/validation/cross-device/<adapter>.json`; the rows of every file there
  are folded into `crossDevice` on the next run, keeping the commit and date
  they were measured on.
- `--resume` reuses completed GPU cases from the ignored `.validation-progress.local`
  checkpoint after an interruption. It requires the same local source and machine;
  unfinished and errored runs are retried. Without this flag a run starts a fresh checkpoint.

`node scripts/validate-schema.mjs <file>` checks that the rows are well formed.
`--require-all` also demands every case or a recorded skip reason and the full
set of tier-L Ahmed variants, `--require-operators` the laminar and confinement
rows for every operator, and `--require-cross-device` at least one non-Apple
adapter. Every required set is read from the file's own `factors`.

<!-- validation:start -->
Measured 2026-11-12T11:54:42.155Z at commit c9bf1a3.
Adapter: apple metal-3 (unknown); user agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36.
Factors: operators trt, reg; walls bb; storage f32, f16.

Cases: 26 run: 17 pass, 9 fail; 3 skipped. Analytic verification passed.

### Analytic verification

Taylor-Green observed order: 2.008, 2.001; decay error 0.01%.

| Case | Steps | Error | Result |
| --- | --- | --- | --- |
| Taylor-Green 16 | 50 | 2.395e-3 | pass |
| Taylor-Green 32 | 200 | 5.953e-4 | pass |
| Taylor-Green 64 | 800 | 1.487e-4 | pass |
| Poiseuille tau0 0.6 | 12777 | -0.339% | pass |
| Poiseuille tau0 0.8 | 4541 | -0.234% | pass |
| Poiseuille tau0 1.5 | 1441 | 0.130% | pass |
| Poiseuille tau0 3 | 562 | 0.911% | pass |
| Poiseuille tau0 3 (BGK) | 673 | 13.54% | expected offset |

### Grid convergence

- ahmed-25, reg, tiers M, L, XL: not estimated, divergent.
- sphere-re-100, trt, tiers S, M, L: monotone, observed order 1.344, extrapolated Cd 1.1762, fine-grid GCI 0.96%.
- sphere-re-100, reg, tiers S, M, L: monotone, observed order 2.025, extrapolated Cd 1.1855, fine-grid GCI 1.75%.

### Cases

| Case | Group | Tier | Grid | Cells | Operator | Walls | Storage | Variant | Cd | Cd voxel | Reference Cd | Error % | relStd % | Drift % | ms/step | Default | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphere-re-100 | laminar | L | 256×128×128 | 4194304 | reg | bb | f32 | n/a | 1.2024 | 1.2194 | 1.0900 | 10.3 | 0.08 | 0.00 | 8.39 | no | fail: reference error 10.3% exceeds 10% |
| sphere-re-100 | laminar | L | 256×128×128 | 4194304 | trt | bb | f32 | n/a | 1.1853 | 1.2021 | 1.0900 | 8.7 | 0.07 | 0.00 | 8.52 | yes | pass |
| sphere-re-100 | laminar | M | 192×96×96 | 1769472 | reg | bb | f32 | n/a | 1.2157 | 1.2585 | 1.0900 | 11.5 | 0.07 | 0.00 | 3.73 | no | fail: reference error 11.5% exceeds 10% |
| sphere-re-100 | laminar | M | 192×96×96 | 1769472 | trt | bb | f32 | n/a | 1.1896 | 1.2315 | 1.0900 | 9.1 | 0.06 | 0.00 | 3.75 | yes | pass |
| sphere-re-100 | laminar | S | 128×64×64 | 524288 | reg | bb | f32 | n/a | 1.2542 | 1.3065 | 1.0900 | 15.1 | 0.07 | 0.00 | 1.15 | no | fail: reference error 15.1% exceeds 10% |
| sphere-re-100 | laminar | S | 128×64×64 | 524288 | trt | bb | f32 | n/a | 1.1993 | 1.2494 | 1.0900 | 10.0 | 0.06 | 0.00 | 1.28 | yes | fail: reference error 10.0% exceeds 10% |
| ahmed-25 | smoke | S | 128×64×64 | 524288 | reg | bb | f32 | n/a | 1.1008 | 1.1191 | n/a | n/a | 2.86 | 0.61 | 1.38 | no | pass |
| cube | shape-class | L | 256×128×128 | 4194304 | reg | bb | f32 | n/a | 0.8728 | 0.9152 | n/a | n/a | 4.10 | 0.66 | 8.66 | yes | pass |
| cube | shape-class | M | 192×96×96 | 1769472 | reg | bb | f32 | n/a | 0.8916 | 0.9104 | n/a | n/a | 2.90 | 1.63 | 3.89 | yes | pass |
| cube | shape-class | S | 128×64×64 | 524288 | reg | bb | f32 | n/a | 0.9576 | 0.9284 | n/a | n/a | 2.14 | 1.07 | 1.27 | yes | pass |
| sphere | shape-class | L | 256×128×128 | 4194304 | reg | bb | f32 | n/a | 0.6149 | 0.6114 | n/a | n/a | 2.61 | 1.25 | 8.48 | yes | pass |
| sphere | shape-class | M | 192×96×96 | 1769472 | reg | bb | f32 | n/a | 0.6498 | 0.6440 | n/a | n/a | 3.39 | 2.03 | 3.76 | yes | pass |
| sphere | shape-class | S | 128×64×64 | 524288 | reg | bb | f32 | n/a | 0.7058 | 0.7028 | n/a | n/a | 2.47 | 1.11 | 1.13 | yes | pass |
| ahmed-25 | validation | L | 256×128×128 | 4194304 | reg | bb | f32 | default | 0.7890 | 0.8076 | 0.2850 | 176.9 | 2.00 | 1.03 | 8.23 | yes | fail: reference error 176.9% exceeds 10% |
| ahmed-25 | validation | L | 256×128×128 | 4194304 | reg | bb | f16 | flip-storage | 0.7884 | 0.8069 | 0.2850 | 176.6 | 1.68 | 1.67 | 5.63 | no | fail: reference error 176.6% exceeds 10% |
| ahmed-25 | validation | M | 192×96×96 | 1769472 | reg | bb | f32 | n/a | 0.8104 | 0.8434 | 0.2850 | 184.4 | 1.97 | 1.56 | 3.67 | yes | fail: reference error 184.4% exceeds 10% |
| ahmed-25 | validation | S | 128×64×64 | 524288 | reg | bb | f32 | n/a | 0.8541 | 0.8684 | 0.2850 | 199.7 | 2.93 | 2.00 | 1.27 | yes | fail: reference error 199.7% exceeds 10% |
| ahmed-25 | validation | XL | 384×192×192 | 14155776 | reg | bb | f32 | n/a | 0.7254 | 0.7302 | 0.2850 | 154.5 | 1.25 | 0.58 | 28.96 | yes | fail: reference error 154.5% exceeds 10% |
| cube-confinement | confinement | XL | 384×192×192 | 14155776 | reg | bb | f32 | n/a | 0.8159 | 0.8555 | n/a | n/a | 3.56 | 1.09 | 36.17 | yes | pass |
| sphere-confinement | confinement | XL | 384×192×192 | 14155776 | reg | bb | f32 | n/a | 1.1401 | 1.1563 | 1.0900 | 4.6 | 0.02 | 0.00 | 33.24 | no | pass |
| sphere-confinement | confinement | XL | 384×192×192 | 14155776 | trt | bb | f32 | n/a | 1.1253 | 1.1413 | 1.0900 | 3.2 | 0.02 | 0.00 | 30.02 | yes | pass |
| ahmed-25 | sensitivity | L | 256×128×128 | 4194304 | reg | bb | f32 | body-length | 0.7045 | 0.7012 | n/a | n/a | 1.61 | 0.47 | 8.93 | no | pass |
| ahmed-25 | sensitivity | XL | 384×192×192 | 14155776 | reg | bb | f32 | domain | 0.6522 | 0.6675 | n/a | n/a | 1.74 | 1.68 | 31.90 | no | pass |
| ahmed-25 | sensitivity | L | 256×128×128 | 4194304 | reg | bb | f32 | stilts | 0.7890 | 0.8076 | n/a | n/a | 2.00 | 1.03 | 9.34 | no | pass |
| ahmed-25 | sensitivity | L | 256×128×128 | 4194304 | reg | bb | f32 | stilts | 0.8709 | 0.8722 | n/a | n/a | 1.86 | 0.94 | 9.15 | no | pass |
| ahmed-25 | sensitivity | M | 192×96×96 | 1769472 | reg | bb | f32 | inlet-speed | 0.7509 | 0.7814 | n/a | n/a | 2.26 | 0.34 | 3.71 | no | pass |

### Grid check

| Preset | Effective Re (fixed) | Result | GCI % | Extrapolated Cd | Reason |
| --- | --- | --- | --- | --- | --- |
| ahmed-25 | 320.0 | no-band | n/a | n/a | oscillatory |
| sphere | 90.0 | no-band | n/a | n/a | oscillatory |

### Skipped

- ahmed-35 at L: No reference value for the 35 degree body is recorded in docs/validation.md.
- cube-confinement at XL: The force was not finite at step 616 of 46080.
- ahmed-25 at L: The force was not finite at step 552 of 30720.

### Cross-device

No cross-device rows yet.
<!-- validation:end -->

## Limitations

The tunnel has periodic sides rather than solid walls, so the Maskell correction
overstates confinement. The corrected value is an upper bound on the free-air
drag coefficient, not a replacement for the measured value. Sphere shape rows at
40 m/s fall in the drag crisis and are reported without a reference comparison.
