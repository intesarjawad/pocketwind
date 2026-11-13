# 003: Pull streaming and wall mask

Status: accepted design; validation evidence remains pending.

## Context

The per-cell kernel needs wall information without loading neighbouring flags for every population.

## Decision

Pull direction i from n - c_i, apply the precomputed wall mask, collide, then write the output cell. Swap input and output populations after each step. Start with halfway bounce-back.

## Consequences

The geometry worker owns wall-mask construction. CPU and GPU tests must cover direction and opposite-direction conventions. Interpolated walls extend this contract in ADR-010.
