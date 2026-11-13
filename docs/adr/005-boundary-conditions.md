# 005: Boundary conditions

Status: accepted design; validation evidence remains pending.

## Context

The tunnel needs defined inlet, outlet, floor and lateral treatment before validation can distinguish boundary effects from collision errors.

## Decision

Use an equilibrium inlet plane and an equilibrium outlet plane at reference density that carries the upstream velocity (ADR-013). Keep y periodic. With the floor enabled, use a floor wall and an equilibrium top plane; otherwise z is periodic. Floor classification wins at inlet and outlet corners.

## Consequences

Add a sponge or enlarge the domain only when measured boundary effects justify the change. Time to steady is measured below for one body and tier; sponge and domain comparisons remain unmeasured, so neither a sponge nor a domain correction is established here.

## Stability and settling check

Sponge: off. The solver has no sponge layer. The measurements below predate the pressure outlet of ADR-013, when the outlet was an equilibrium plane at the inlet velocity.

`npm run stability -- --preset=ahmed-25 --tier=M --flowthroughs=6` runs the Ahmed body at tier M for six flow-throughs in each operator (`trt`, `reg`) and each wall mode (`bb`, `bouzidi`) on a headed Chromium with a WebGPU adapter. Narrow a run with `--operator=` and `--walls=`. Each flow-through prints its mean Cd and relative deviation, and each combination ends with one `steady=` line. The line applies the same rule as the readout: a window of one flow-through is steady when its relative deviation is under 3% and its first-to-second-half drift is under 1%, and no report is made before two flow-throughs. Time to steady is the first sample after which every later sample is steady; `steady=no` means the run ended unsteady.

Measured time to steady, Ahmed 25 degree body at tier M, Apple M5 (10-core GPU), commit 2f262b9, no sponge (the app has none):

| Operator | Walls | Steady after (flow-throughs) | Mean Cd over flow-through 6 |
| --- | --- | ---: | ---: |
| trt | bb | 2.42 | 1.903 |
| trt | bouzidi | 2.01 | 2.017 |
| reg | bb | 2.41 | 1.942 |
| reg | bouzidi | 2.00 | 2.019 |

Every run stayed finite for six flow-throughs. Steady state arrives well inside the six flow-throughs the run averages over, so no sponge or domain change is justified yet. These are low-Reynolds numbers at the viscosity floor (ADR-001), not road-speed drag.
