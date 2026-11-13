#!/bin/sh
# Export the browser's meshes, rather than separately tessellating the SCAD design sources.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
tsx scripts/export-geometry.ts
