# 006: Drag reporting and reference areas

Status: accepted design; validation evidence remains pending.

## Context

Drag must use a stated area definition and distinguish physical fluctuations from uncertainty of the mean.

## Decision

Compute momentum exchange only on SOLID body links in boundaryCells. Presets use literature reference areas; custom models use frontal SOLID cells. Report Cd with status and grid, and compare shapes using CdA or physical force.

## Consequences

SUPPORT and FLOOR links contribute neither body force nor frontal area. Batch means estimate sampling uncertainty separately from fluctuation. Literature reference-area definitions and full force-statistics validation remain pending. The CPU halfway-wall force expression and its sign convention are derived in [Numerics](../numerics.md#momentum-exchange).
