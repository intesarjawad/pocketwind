# 011: Validation and GCI method

Status: accepted design; validation evidence remains pending.

## Context

A browser simulation needs reproducible verification, reference comparisons and a stated treatment of grid sensitivity.

## Decision

Keep a CPU reference solver, automated validation cases and schema-checked result files. Compute grid convergence using the Celik et al. procedure. Publish case definitions, reference areas and per-tier results alongside grid bands.

## Consequences

Sampling uncertainty, grid sensitivity and reference error remain separate quantities. GCI implementation, reference-case provenance and full validation remain pending; this record establishes no accuracy claim.
