# 009: Device tiers and time to answer

Status: accepted design; validation evidence remains pending.

## Context

A device tier must balance memory pressure with time to a useful drag sample.

## Decision

Use S, M and L with default device limits. Probe S first, then probe M only when predicted time permits; choose by predicted time to two flow-throughs. Keep XL manual and request its larger limits only when explicitly selected.

## Consequences

Scoped allocation failures step down to a smaller tier. A small-grid timing alone cannot establish large-grid performance. No tier-performance result is recorded here. The selection budget is 60 seconds for two flow-throughs; probe timing excludes initialization and includes encoding, submission and completion of 30 steps.
