#!/bin/sh
# Report the source revision stamped into generated artifacts.
if [ -n "${VITE_COMMIT:-}" ]; then
  printf '%s\n' "$VITE_COMMIT"
  exit 0
fi
git rev-parse --short HEAD 2>/dev/null || printf 'unknown\n'
