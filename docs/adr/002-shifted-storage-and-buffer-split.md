# 002: Shifted storage and buffer split

Status: accepted design; validation evidence remains pending.

## Context

Population storage must preserve small flow deviations and fit default WebGPU storage-buffer limits.

## Decision

Store g_i = f_i - w_i in structure-of-arrays layout. Split directions into A (0 to 6), B (7 to 12), and C (13 to 18), with separate input and output sets. Bind geometry and macroscopic fields alongside these sets.

## Consequences

The stream-collide pipeline fits the default storage-binding count for S, M and L. Population conversion stays at load/store boundaries. The [numerical reference](../numerics.md#population-storage) gives indexing and byte counts derived from the allocation formulas; these counts do not establish allocation success on a particular device.
