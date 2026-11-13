# 010: Interpolated walls

Status: accepted design; validation evidence remains pending.

## Context

Halfway bounce-back represents curved geometry with a staircase boundary.

## Decision

Use linear Bouzidi interpolation as an extension, with geometry-thread-computed q links. Use halfway bounce-back when the short-link interpolation neighbour is not fluid. Use the same wall reconstruction for streaming and momentum exchange.

## Consequences

Wall-link storage and CPU/GPU comparison tests are required. Record missing triangle intersections through missedLinks. Final wall defaults await measured validation. Halfway bounce-back remains the implemented GPU boundary.
