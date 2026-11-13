# 001: Lattice and collision operators

Status: accepted design; validation evidence remains pending.

## Context

The solver needs a GPU-suitable lattice and collision operators whose accuracy can be checked against CPU verification and reference cases.

## Decision

Use D3Q19 with shifted populations and optional Smagorinsky viscosity. Regularized BGK is the default collision and TRT the alternative; BGK stays for CPU sensitivity tests. The default follows the measured validation results in ADR-013: only the regularized collision stays finite on the road-speed bluff-body cases, while TRT is the more accurate of the two on the laminar sphere.

## Consequences

CPU and GPU implementations must share lattice ordering and collision mathematics. I have not yet established whether the full validation results justify retaining the solver. The implemented equations and their provenance are recorded in [Numerics](../numerics.md).

## Viscosity floor

Measured on an Apple M5 GPU with `npm run stability -- --operator=trt --tier=M --flowthroughs=6`
on the Ahmed preset at 40 m/s, where the nominal lattice viscosity is about 2e-6:

| `NU_MIN_LU` | Result |
| --- | --- |
| 1e-6 | not finite at step 528 |
| 1e-5 | not finite at step 552 |
| 1e-4 | not finite at step 640 |
| 1e-3 | not finite at step 664 |
| 1e-2 | finite for six flow-throughs; Cd 1.90, fluctuation below 0.1% |

The floor is therefore `1e-2`. With the preset at tier M that is a Reynolds number of about 480,
not the nominal 2.8 million, so the live readout states the Reynolds number it simulates whenever
the floor applies. The validation cases set their viscosity from their own Reynolds number and do
not use this floor.

## Walls

Stored populations are deviations g = f - w, and every wall link reconstructs the incoming
population from post-collision values at the fluid cell. With `walls=bb` that value is the
opposite population at the same cell (halfway bounce-back). With `walls=bouzidi` it is linear
Bouzidi interpolation with the link fraction q packed by the geometry thread: for q < 1/2,
2q g*_j(x) + (1 - 2q) g*_j(x + c_i); for q ≥ 1/2, (g*_j(x) + (2q - 1) g*_i(x)) / 2q. The
coefficients sum to one, so the formulas hold for deviations unchanged. A short link whose
second node is not fluid, or a cell without packed fractions, keeps halfway bounce-back.

The body force is the momentum exchange c_j (f*_j + f_i) summed over solid links (Mei et al.
2002), where f_i is the population the next step reconstructs. For halfway links this is
2 c_j (g*_j + w_i); the force kernel drops the reference-pressure part 2 c_j w_i and averages
the two latest states (ADR-013). The CPU reference, `walls.wgsl` and the force kernel share the same
reconstruction. TRT keeps Λ = 3/16 for both wall modes, so q = 1/2 reproduces halfway
bounce-back exactly; at other q the planar-channel wall position is accurate to second order,
not exact. The GPU still defaults to halfway walls; interpolated walls become a selectable mode
once the GPU-vs-CPU comparison has passed on a GPU browser.
