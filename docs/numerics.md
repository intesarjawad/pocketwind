# Numerics

This reference describes the equations and data contracts in `src/lbm/`.
The implemented GPU solver uses f32 arithmetic over D3Q19 with regularized
collision by default, TRT as the alternative, optional Smagorinsky viscosity
with a wall function, and halfway bounce-back. Populations may be stored as f32
or as scaled f16. Interpolated walls remain an extension, as recorded in the
decision records. Physical validation is
incomplete. Wall cells are storage for the rest state, not samples of the
interior flow.

## Units and relaxation

One lattice spacing and one solver step are the units of length and time:
Δx_lu = Δt_lu = 1. `SolverParams.uIn` is the x-directed inlet velocity in cells
per solver step, not metres per second. The other prescribed inlet components
are zero. Density is normalized to a reference value of 1, not expressed in
kg/m³. The isothermal sound speed satisfies c_s² = 1/3.

`SolverParams.tau0` is the dimensionless baseline even-mode relaxation time:

```text
ν_lu = c_s² (tau0 - 1/2) = (tau0 - 1/2) / 3
tau0 = 1/2 + 3 ν_lu,     tau0 > 1/2.
```

Derivation given here: Taylor-expand the discrete streaming equation through
second order. The leading nonequilibrium stress is
Π_αβ^neq = -2 ρ c_s² tau0 S_αβ, where
S_αβ = (∂_α u_β + ∂_β u_α)/2. The second-order streaming term multiplies
that stress by (1 - 1/(2 tau0)), giving the viscous stress
-2 ρ c_s² (tau0 - 1/2) S_αβ. Matching -2 ρ ν S_αβ gives the relation above.
This is a low-Mach, long-wavelength relation, not an exact identity at arbitrary
flow speed. Hou et al.'s 1994 preprint explicitly uses the same viscosity versus
relaxation relation in its subgrid construction.
[Primary preprint](https://arxiv.org/abs/comp-gas/9401004)

`units.ts` fixes `U_LU = 0.05`, giving Mach number 0.05√3 ≈ 0.0866.
For physical reference length L_m and its lattice length L_cells,
Δx_m = L_m/L_cells and Δt_s = U_LU Δx_m/U_mps. Thus
u_mps = u_lu Δx_m/Δt_s and ν_lu = ν_m2ps Δt_s/Δx_m².
Equating physical and lattice Reynolds numbers gives the implemented conversion:

```text
Re = U_mps L_m / NU_AIR
ν_lu = max(1e-6, U_LU L_cells / Re).
```

The floor is a numerical choice that keeps tau0 above 1/2. When it is active,
the realized molecular Reynolds number is U_LU L_cells/ν_lu, below the requested
value; the returned `re` still contains the requested value. With LES enabled,
local effective viscosity also includes the eddy viscosity.

### Air property

`NU_AIR = 1.5e-5 m²/s` is a rounded approximation for dry air at **20°C
(293.15 K) and 101.325 kPa absolute pressure**. ASHRAE (2021), *Handbook:
Fundamentals*, SI chapter 1, “Psychrometrics,” Table 5, gives
ν_da = 15.11 × 10⁻⁶ m²/s at that state. The constant is approximately 0.73%
lower, calculated as 100(15.00/15.11 - 1). It does not model humidity,
temperature changes or pressure changes. The publisher table's temperature,
pressure, dry-air column and units were independently read on 2026-11-05.
[ASHRAE publisher table](https://handbook.ashrae.org/Handbooks/F21/SI/F21_Ch01/F21_Ch01_si.aspx)

## Lattice, shifted equilibrium and moments

The direction numbers below are local conventions shared by `lattice.ts`,
`reference/collision.ts` and `shaders/common.wgsl`. A population travels along
c_i; pull streaming reads its source at x - c_i.

| i | c_i | Opposite |
| --- | --- | --- |
| 0 | (0, 0, 0) | 0 |
| 1, 2 | (1, 0, 0), (-1, 0, 0) | 2, 1 |
| 3, 4 | (0, 1, 0), (0, -1, 0) | 4, 3 |
| 5, 6 | (0, 0, 1), (0, 0, -1) | 6, 5 |
| 7, 8 | (1, 1, 0), (-1, -1, 0) | 8, 7 |
| 9, 10 | (1, 0, 1), (-1, 0, -1) | 10, 9 |
| 11, 12 | (0, 1, 1), (0, -1, -1) | 12, 11 |
| 13, 14 | (1, -1, 0), (-1, 1, 0) | 14, 13 |
| 15, 16 | (1, 0, -1), (-1, 0, 1) | 16, 15 |
| 17, 18 | (0, 1, -1), (0, -1, 1) | 18, 17 |

Weights are w_0 = 1/3, w_1…6 = 1/18 and w_7…18 = 1/36.
Derivation given here: let the three shell weights be a, b and d. Normalization,
second-order isotropy and mixed fourth-order isotropy require

```text
a + 6b + 12d = 1
2b + 8d = c_s² = 1/3
4d = c_s⁴ = 1/9.
```

These give the stated weights. Odd moments vanish by opposite-pair symmetry.
The pure fourth moment equals the second moment because c_ix⁴ = c_ix²,
consistent with 3c_s⁴ = 1/3. The weights therefore reproduce the required
second and fourth moments, without attributing this direction ordering to a paper.

Storage subtracts the density-one rest equilibrium: g_i = f_i - w_i.
Expanding the second-order isothermal equilibrium and subtracting w_i gives
exactly the formula in `reference/collision.ts`:

```text
f_i^eq = w_i ρ [1 + 3(c_i·u) + (9/2)(c_i·u)² - (3/2)|u|²]
g_i^eq = w_i [(ρ - 1) + ρ {3(c_i·u) + (9/2)(c_i·u)² - (3/2)|u|²}]
ρ = 1 + Σ_i g_i
ρ u = Σ_i c_i g_i.
```

Derivation given here: Σw_i = 1 restores the missing unit density, while
Σw_i c_i = 0 makes the momentum invariant under the shift. Substituting the
isotropic second and fourth moments into the equilibrium gives density ρ,
momentum ρu and equilibrium stress ρc_s²I + ρuu. The GPU keeps ρ - 1 separate
through equilibrium evaluation to reduce cancellation in f32.

## Population storage

Let N = nx ny nz and n = x + nx(y + ny z), for zero-based coordinates.
The CPU `populations` getter exposes a Float64Array with
`populations[i*N + n] = g_i(n)` in 19 direction-major planes.

The GPU `populationBuffers` getter returns three direction-major f32 buffers
for the latest **encoded** post-collision state:

| Buffer | Directions | Scalar index | Byte offset |
| --- | --- | --- | --- |
| A | 0…6 | i N + n | 4(i N + n) |
| B | 7…12 | (i - 7) N + n | 4((i - 7) N + n) |
| C | 13…18 | (i - 13) N + n | 4((i - 13) N + n) |

Two complete sets alternate after every encoded step; the getter changes at
encoding time, before device execution. Submit encoders in order and wait for
completion before interpreting a readback. State 0 is selected after initialization.
`reset(encoder)` reinitializes both sets, selects state 0 and resets the encoded step
count. Both population sets are initialized on creation and reset, so either
output set has defined wall values. A zero-step batch performs no dispatch and
changes no buffer.

One f32 set occupies 19 N × 4 bytes. `bytesForLayout` counts both sets plus
8 N geometry bytes and 16 N macro bytes, giving 176 N bytes for f32 or
100 N bytes for f16 storage. These totals exclude wall-link arrays, particles,
uniforms and other resources; they are allocation formulas, not measurements
of total resident memory.

## Macro buffer, update cadence and walls

`GpuSolver.macroBuffer` is `array<vec4f>` in the same cell order n. Its byte
stride is 16. A Float32Array readback has

```text
macro[4*n + 0] = ρ
macro[4*n + 1] = u_x
macro[4*n + 2] = u_y
macro[4*n + 3] = u_z.
```

Velocities use cells per solver step and density uses the normalization above.
Initialization and reset write macros. In `step(encoder, count, true)`, only the
last dispatch of a nonempty batch writes macros. Passing false leaves them
unchanged, even while populations advance. There is no automatic per-frame or
fixed-step cadence inside the solver. Fluid macros are recovered after pull
streaming and before collision; the unforced GPU collision conserves those
moments. EQ cells receive (ρ, u) = (1, (uIn, 0, 0)), except on the last x
plane, which takes ρ = 1 with the velocity of its upstream neighbour from the
previous step: a pressure outlet rather than a velocity outlet (ADR-013).

The stationary-wall storage convention is the **rest state**: wall cells hold
ρ = 1, u = (0, 0, 0), and g_i = 0. SOLID, SUPPORT and FLOOR are wall types;
they are excluded from fluid collision and are not interior flow samples.
Halfway bounce-back reconstructs an incoming fluid population from the opposite
post-collision population at the same fluid cell, not from the wall cell's
stored populations. The wall-mask bit for incoming i is `1 << (3 + i)`.

The GPU initializer classifies walls and writes their zero velocity and unit
density into both population sets and the macro buffer. Stepping skips wall
cells, preserving this rest state regardless of ping-pong parity. Fluid and EQ
cells start at the inlet equilibrium. The CPU initializer leaves both wall
population sets zero, overriding non-rest initial-state values there; its
macroscopic getter consequently also returns the rest state for walls.

## TRT and the wall parameter

`reference/collision.ts` and `shaders/collide-trt.wgsl` split each opposite pair
into even and odd parts, g_i^± = (g_i ± g_opp(i))/2. Their collision is

```text
g_i* = g_i - ω+ (g_i+ - g_i^eq,+) - ω- (g_i- - g_i^eq,-)
ω+ = 1/tau
(tau - 1/2)(tau_minus - 1/2) = Λ = 3/16
ω- = 1 / [1/2 + Λ/(tau - 1/2)].
```

The last line is algebraically derived from the preceding product. Without
LES, tau = tau0; with LES it is the local effective value below. CPU BGK uses
ω- = ω+ instead. The GPU has no body-force term.

Ginzburg and d'Humières (2003), *Multireflection boundary conditions for lattice
Boltzmann models*, is the relevant boundary-analysis reference. Its authors,
title, publication year and DOI were confirmed on the APS page. That abstract
does not establish the particular 3/16 value for this force discretization.
[APS / DOI](https://doi.org/10.1103/PhysRevE.68.066614)

The implementation's comment claiming that Λ fixes the wall location is broader
than the evidence confirmed here. Applicability must distinguish stationary,
planar, lattice-aligned halfway walls with a specified forcing rule from curved
walls, interpolated links and spatially varying LES relaxation. The CPU channel
uses uniform acceleration added after collision, periodic streamwise directions,
stationary halfway walls and midpoint-corrected comparison velocity. A general
wall-location guarantee, or its transfer to every such configuration, is not
independently confirmed. No equation number is asserted for it.

## Smagorinsky viscosity

`reference/collision.ts` and its GPU counterpart use C_s = 0.1 and a lattice
filter width Δ = 1. C_s is a model choice, not an air property or a universally
validated constant. Define the symmetric nonequilibrium momentum-flux tensor

```text
Π_αβ = Σ_i c_iα c_iβ (g_i - g_i^eq)
Q = Π_xx² + Π_yy² + Π_zz² + 2(Π_xy² + Π_xz² + Π_yz²).
```

The doubled off-diagonal terms count both entries of each symmetric pair:
Q = Π_αβ Π_αβ. The shift cancels in g_i - g_i^eq.
Hou, Sterling, Chen and Doolen's 1994 preprint, *A Lattice Boltzmann Subgrid
Model for High Reynolds Number Flows*, confirms the nonequilibrium-tensor
construction and |S| = √(2 S_αβ S_αβ). It writes eddy viscosity as
C Δ² |S|; here C = C_s² = 0.01. Its cavity examples include C = 0.01,
which does not validate that choice for this three-dimensional tunnel.
The title page and model formulas were read directly in the preprint.
[Primary preprint](https://arxiv.org/abs/comp-gas/9401004)

Derivation given here under these conventions: the leading-order stress relation
Π = -2ρ c_s² tau S gives |S| = 3√(2Q)/(2ρ tau).
With ν_eff = ν_0 + C_s² |S| and tau = tau0 + 3 C_s² |S|,

```text
tau² - tau0 tau - 9√2 C_s² √Q/(2ρ) = 0
tau = [tau0 + √(tau0² + 18√2 C_s² √Q/ρ)] / 2.
```

The positive root recovers tau0 at Q = 0 and reproduces the code's `18√2`
factor. This derivation uses the low-Mach stress approximation; it does not
establish turbulence accuracy for a particular mesh or boundary.

### Wall function

With the sub-grid model on, a fluid cell with at least one wall link sets its
post-collision stress from a wall law instead of relaxing it (ADR-013). The
first fluid node of a halfway wall sits y = 1/2 from it. Werner and Wengle's
power law u⁺ = 8.3 y⁺^(1/7), joined to u⁺ = y⁺ at y⁺ = 11.81, gives the
friction velocity u_τ from the slip speed |u_t| there, where u_t is the cell
velocity minus its component along the wall normal n = Σ w_i c_i over the
cell's wall links.

Derivation given here: with t = u_t/|u_t| and outgoing link j = opp(i), the
bounce-back flux along t that the wall receives is
F = Σ 2 (c_j·t)(g*_j + w_j) over the cell's wall links. A post-collision state
g* = g^eq + (9/2) w_j c_j c_j : Π, with Π traceless in the sense of the
regularized collision, changes F linearly in Π. The smallest such Π that sets
F to 6 Σw ρ u_τ² is Π = μ B with

```text
B = Σ_links 9 w_j (c_j·t)(c_j c_j - I/3)
μ = (6 Σw ρ u_τ² - F^eq) / |B|²,
```

where F^eq is the flux of g^eq. A flat face has Σw = 1/6 and |B|² = 1/2, so
its wall receives ρ u_τ² per unit area. Mass and momentum are untouched, and
the flux normal to the wall is not constrained, which keeps the wall
impermeable. A cell without slip, or with |B|² under a tenth of a flat face's,
keeps the plain collision. `collideWall` in `reference/collision.ts` and
`collide_wall` in `stream_collide.wgsl` implement the same step.

## Analytic CPU cases and forcing

### Taylor–Green vortex

Derivation given here for `reference/cases.ts`: let k = 2π/n and
A(t) = (0.01 × 32/n) exp(-2ν k²t), with tau0 = 0.8 and ν = (0.8 - 0.5)/3.
The prescribed velocity is

```text
u_x = -A cos(kx) sin(ky)
u_y =  A sin(kx) cos(ky),    u_z = 0.
```

Its divergence is zero and ∇²u = -2k²u, so the viscous term gives
A' = -2νk²A. Direct differentiation gives
(u·∇)u = -(A²k/2)(sin(2kx), sin(2ky), 0).
The incompressible pressure per reference density is therefore
p' = -(A²/4)[cos(2kx) + cos(2ky)], since ∇p' cancels this acceleration.
The isothermal relation δρ = p'/c_s² = 3p' produces exactly the density
`1 - 0.75*A*A*(cos(2*k*x) + cos(2*k*y))` in the source. This is an
incompressible analytic comparison with a weak-compressibility density seed,
not an exact finite-Mach solution of the discrete solver. The amplitude decay
rate is 2νk²; kinetic energy decays at twice that rate.

### Forced channel and half-force velocity

The CPU adds `3 ρ w_i (c_i·a)` after collision. Derivation given here:
weight symmetry makes its zeroth moment zero and its first moment
3ρ Σ_i w_i c_i c_i·a = ρa. It is a simple uniform-acceleration impulse,
not a claim to implement a more general forcing scheme.

`CpuSolver.macroscopic` returns post-impulse momentum divided by density.
For constant acceleration, the mean of the velocities immediately before and
after that impulse is u_mid = u_post - a/2. This accounts for the minus sign
in `runPoiseuille.centeredProfile`. Ladd's primary preprint explicitly discusses
measuring channel velocity after half the uniform force has been applied;
its forcing convention is relevant here. It does not validate arbitrary
space-dependent or time-dependent forcing.
[Primary preprint](https://arxiv.org/abs/comp-gas/9306004)

For height H = nz - 2 = 16, solving ν u'' + a = 0 with zero velocity at both
walls gives u(d) = a d(H - d)/(2ν). Fluid cell centers lie at d = j + 1/2
for j = 0…H-1. Hence a = 8ν U_max/H² for prescribed U_max = 0.01.
The continuum maximum lies between centers when H is even; it is not exactly
the largest sampled cell velocity.

## Momentum exchange

`GpuSolver.encodeForce(encoder)` samples the mean of the two latest encoded
post-collision states, one from each ping-pong buffer. Near-wall populations at
high Reynolds numbers oscillate with period two steps; a single state sampled
every eighth step sees only one phase of it (ADR-013). Submit that encoder before calling `readForce()`, which returns
`{ step, fx, fy, fz }` in lattice units. The caller schedules samples every
`FORCE_EVERY_STEPS = 8` steps; the solver does not insert them into step batches.
A single staging slot is reserved from encoding until readback completes.
Further encodes are skipped while that slot is occupied, and `readForce()`
returns `'busy'` if no unread sample exists or a map is pending. The step stamp
belongs to the sampled state even if more steps are encoded during readback.
Reset discards an unread sample; a map already in flight keeps its original stamp.
Mapping errors propagate and release the slot for reuse.

Each boundary cell contributes in a 64-thread workgroup reduction. Linear
dispatches use at most 256 workgroups per row, bounded further by the device
limit, so 70,000 boundary entries use multiple rows. Every dispatched group,
including padding, writes a partial. A single 256-thread workgroup then strides
over all partials before reducing to one `vec4f`; this supports more than 256
partials without another reduction allocation. The fourth component is zero.

Derivation given here for `reference/cpu-solver.ts`: incoming i points from wall
to fluid, and j = opp(i) points from fluid to wall. A stationary halfway wall
reverses incident momentum c_j f_j* to -c_j f_j*. Fluid momentum changes by
-2c_j f_j*, so the equal and opposite force on the body per unit lattice step is

```text
F_link = 2 c_j f_j* = 2 c_j (g_j* + w_j).
```

The 2 c_j w_j part is the reference pressure ρ = 1. Over a closed surface it
sums to zero, but a body cut by its support stilts is not closed: the cut faces
have no links, and the reference pressure there produced a spurious lift
(ADR-013). The force kernel therefore sums the gauge part 2 c_j g_j* only. Only SOLID links enter this body
force; SUPPORT and FLOOR links are omitted. Summing link exchanges is the
momentum-transfer construction described in Ladd's primary preprint, whose
boundary-force discussion was read directly. The local derivation specifies
this solver's sign, shift and exterior-fluid convention; it does not equate the
whole implementation to Ladd's particle-shell model.
[Primary preprint](https://arxiv.org/abs/comp-gas/9306004)

Anthony J. C. Ladd (1994), *Numerical simulations of particulate suspensions via
a discretized Boltzmann equation. Part 1. Theoretical foundation*, is the journal
publication. Cambridge's publisher page confirms author, title, 1994 volume date
and DOI. The accessible preprint is dated 1993; its equation numbering is not
asserted to match the journal version.
[Journal DOI](https://doi.org/10.1017/S0022112094001771)

## Limits and precision

### Closed-tunnel correction

Blockage changes the measured drag when a body occupies a large share of the
working section. The validation rows apply Maskell's correction (1963, ARC R&M
3400) as

```text
cdMaskell = cdRaw / (1 + 2.5 cdRaw blockage).
```

The 2.5 coefficient comes from the cited closed-tunnel treatment of bluff
bodies. The tunnel's sides are periodic rather than solid, so the real
confinement is weaker than the correction assumes. `cdMaskell` is therefore an
upper bound on the free-air value, not a measured replacement for `cdRaw`.
Both values are reported side by side.

The versioned W3C *WebGPU* draft of 15 September 2026 lists default
`maxStorageBuffersPerShaderStage = 8`, `maxStorageBufferBindingSize = 134217728`
bytes and `maxBufferSize = 268435456` bytes. Its editors are Kai Ninomiya,
Brandon Jones and Jim Blandy. The published limit table and document metadata
were read directly. The solver uses eight storage bindings: six population
buffers, geometry and macros, plus one uniform binding.
[Versioned WebGPU specification](https://www.w3.org/TR/2026/CRD-webgpu-20260915/)

Derivation given here for ADR-002: the largest population group has 7N entries,
so an f32 binding needs 28N bytes. S, M and L need respectively 14680064,
49545216 and 117440512 bytes, all below 128 MiB. XL needs 396361728 bytes,
exceeding both defaults. These limits do not guarantee enough total device
memory, and storage splitting does not prove successful allocation.

ADR-012 selects f16 storage with f32 arithmetic and scale
2¹⁵ = 32768. The versioned W3C *WebGPU Shading Language* draft of
26 October 2026, edited by Alan Baker, Mehmet Oguz Derin and David Neto,
confirms binary16's smallest positive normal 2⁻¹⁴, smallest positive subnormal
2⁻²⁴ and maximum finite value 65504. Its floating-point representation and
extreme-value tables were read directly.
[Versioned WGSL specification](https://www.w3.org/TR/2026/CRD-WGSL-20261026/)

Derivation given here: storing h = f16(2¹⁵g) and loading g ≈ f32(h)/2¹⁵
moves the smallest normal g magnitude to 2⁻²⁹, the smallest representable
subnormal magnitude to 2⁻³⁹ and the largest finite magnitude to
65504/32768 = 1.9990234375. Normal-range relative precision is unchanged;
scaling moves the exponent range and does not add significand bits. Subnormal
preservation is not an accuracy guarantee. Overflow, rounding and device
behavior still need measured validation. `prelude-f16.wgsl` implements that
scale with `POP_SCALE = 32768`; `prelude-f32.wgsl` keeps `POP_SCALE = 1`. The
automatic storage choice uses f16 where shader-f16 is advertised after the Ahmed
tier-L comparison passed the 2% precision gate; see [ADR-012](adr/012-precision-modes.md).

## Provenance map

| Implementation fact | Basis and confirmation |
| --- | --- |
| `lattice.ts`, `reference/collision.ts`: weights, shifted equilibrium, moments | Derivation given here from isotropic moments; direction ordering copied explicitly from the local arrays. No external equation number claimed. |
| `reference/collision.ts`: TRT 3/16 and wall location | Constant and relaxation algebra checked in CPU/GPU source; Ginzburg and d'Humières metadata confirmed at APS. The universal wall-location claim is not independently confirmed. |
| `reference/collision.ts`: C_s, tensor norm, 18√2 | Hou et al. primary preprint confirms the closure and norm conventions; coefficient conversion and quadratic derivation given here. C_s = 0.1 is a local choice. |
| `reference/cases.ts`: vortex and half-force correction | Analytic derivations given here; Ladd's primary preprint confirms the uniform-force midpoint convention. |
| `reference/cpu-solver.ts`: shifted momentum exchange | Ladd's primary preprint confirms the momentum-transfer basis; local shift and force sign derived here. |
| `units.ts`: air viscosity | ASHRAE publisher Table 5 confirms 20°C, 101.325 kPa, dry-air ν = 15.11 × 10⁻⁶ m²/s. The code rounds it to 1.5 × 10⁻⁵. |
| ADR-002, ADR-012: binding limits and f16 scale | Versioned W3C tables confirm limits and binary16 values; buffer-fit and exponent-range derivations given here. |

## Not independently confirmed

- An exact equation number and applicable forcing assumptions in the final
  Ginzburg and d'Humières article for Λ = 3/16. The publisher abstract was
  accessible, but the final PDF was not. The broad wall-location comment in
  the source must not be treated as a general validated result.
- The AMS publication metadata for the Hou text. Only the 1994 arXiv preprint
  and its formulas are cited here; the attempted publisher DOI retrieval failed.
- Full physical validation of C_s = 0.1, the final collision and wall defaults,
  and f16 drag accuracy. None follows from agreement with a transcribed formula.

## Run provenance and comparison

The compatibility hash includes geometry, force statistics, lattice solvers and shaders,
GPU allocation/orchestration, and the app’s placement and viscosity choices. A styling-only
change does not alter it. Saved comparisons check the measured grid dimensions after
allocation, including fallback, rather than trusting the requested tier.

Sampling comparisons combine each CdA’s absolute standard error in quadrature, multiply
by two, and divide by the first CdA to express the band and difference on the same base.
This is sampling uncertainty, not grid error or a validation of vehicle drag.

Run JSON and image cards state effective Reynolds number and whether the viscosity floor
was active. The additive schema-3 JSON fields are `effectiveRe` and `viscosityFloor`;
older files load them as `null` (unknown), never as proof that the floor was inactive.
Opening a file retains the saved measurements and provenance unchanged for JSON re-export.
A file alone carries no rendered frame, so saving a new image needs a live view.
