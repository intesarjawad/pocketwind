#!/bin/sh
# Write public/validation/geometry/CHECKSUMS.txt, or with --verify compare the STL files to it.
set -eu

dir=${GEOMETRY_DIR:-$(cd "$(dirname "$0")/.." && pwd)/public/validation/geometry}
file=$dir/CHECKSUMS.txt
export LC_ALL=C

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi

list() {
  cd "$dir"
  for stl in *.stl; do
    [ -e "$stl" ] || continue
    printf '%s  %s\n' "$(digest "$stl")" "$stl"
  done
}

case "${1:-}" in
  '')
    list >"$file"
    ;;
  --verify)
    if [ ! -f "$file" ]; then
      echo "checksums: $file is missing" >&2
      exit 1
    fi
    list | diff - "$file" >&2 || {
      echo "checksums: the STL files do not match CHECKSUMS.txt" >&2
      exit 1
    }
    ;;
  *)
    echo "Usage: checksums.sh [--verify]" >&2
    exit 2
    ;;
esac
