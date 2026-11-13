#!/bin/sh
# Print the SHA-256 of the solver sources that decide the numbers, for VITE_NUMERICS_HASH.
# The hash covers a manifest of "<file digest>  <path>" lines, so a rename changes it too.
set -eu

root=${NUMERICS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
export LC_ALL=C

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum | cut -d ' ' -f 1; }
else
  digest() { shasum -a 256 | cut -d ' ' -f 1; }
fi

cd "$root"
manifest=
for file in $(find src/lbm src/geometry src/forces src/gpu -type f \( -name '*.ts' -o -name '*.wgsl' \) 2>/dev/null | sort) src/app/run.ts src/app/run-plan.ts src/app/store.ts src/app/case-run.ts src/app/grid-check.ts src/app/params.ts src/app/solver-slot.ts src/validation/cases.ts; do
  [ -f "$file" ] || continue
  manifest="$manifest$(digest <"$file")  $file
"
done

if [ -z "$manifest" ]; then
  echo "numerics-hash: no solver sources under $root" >&2
  exit 1
fi
printf '%s' "$manifest" | digest
