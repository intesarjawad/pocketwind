# Engineering standards

I use these standards to keep the project readable, reproducible and suitable
for independent use.

## Code

- Prefer clarity over cleverness. Name domain quantities precisely and include
  units in names or types when they would otherwise be ambiguous.
- Keep functions focused and modules small. Separate pure computation from I/O;
  pass clocks, randomness, network and filesystem access explicitly.
- Keep types strict and honest. Represent states explicitly; avoid `any`,
  unchecked assertions and casts that conceal errors.
- Validate input at trust boundaries. Return actionable errors without swallowing
  failures or duplicating checks for states that types already exclude.
- Name non-obvious constants and record their units and sources.
- Avoid global mutable state and unnecessary singletons.
- Keep dependencies few, version-pinned, compatible with the license and justified
  by behavior that the existing stack cannot reasonably provide.
- Derive performance claims from reproducible measurements.

## Comments and structure

Comments explain reasons, constraints and sources. Public interfaces document
units, indexing and state semantics. Avoid comments that narrate statements,
forwarding-only wrappers, premature abstractions and duplicated logic.

Keep formatting consistent. Remove dead code, debug output and stale comments.
Errors and logs should carry useful context without unnecessary repetition.
Use plain language without promotional claims or invented measurements.

## Verification

Tests cover behavior with deterministic inputs and tolerances appropriate to the
numerics. Use analytic cases, reference calculations and property checks where
they distinguish meaningful failures. Coverage is evidence about exercised code,
not proof of correctness. Do not conceal failures by removing tests, weakening
tolerances or suppressing diagnostics.

TypeScript uses strict checking, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Formatting, linting, type checks and tests must
agree on the same committed configuration.

## Documentation and reproducibility

The README describes the project's capabilities and limitations. Architecture
and decision records explain consequential choices and the evidence behind them.
Numerical references distinguish derived formulas, external sources and unverified
claims. Dependencies and runtime requirements are explicit in package metadata.
Model downloads, if any, require checksums. No secrets belong in repository files.

Keep license, contribution, security and release information accurate. Retain
small, coherent changes with descriptions that explain their purpose.

## Accessibility and interaction

Controls are keyboard reachable, visibly focused, semantically labelled and
usable with assistive technology. Maintain WCAG 2.2 AA contrast, respect
`prefers-reduced-motion` and convey state through more than color. Simulation
resources and model processing remain local without accounts or paid services.
