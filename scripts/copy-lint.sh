#!/bin/sh
# Scan public-facing copy for email addresses. COPY_LINT_ROOT points the scan
# at another tree.
set -eu

root=${COPY_LINT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
export LC_ALL=C
cd "$root"

email='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'

files() {
  [ -f README.md ] && echo README.md
  for dir in docs src/app .github/ISSUE_TEMPLATE; do
    [ -d "$dir" ] || continue
    case $dir in
      src/app) find "$dir" -type f -name '*.ts' ;;
      *) find "$dir" -type f ;;
    esac
  done
  for file in docs/media/*.txt; do
    [ -f "$file" ] && echo "$file"
  done
}

status=0
list=$(files | sort -u)

check() {
  label=$1
  shift
  hits=$(printf '%s\n' "$list" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -n "$@" -- "$file" 2>/dev/null | sed "s|^|$file:|" || true
  done)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed "s|\$|  [$label]|" >&2
    status=1
  fi
}

check 'email address' -E "$email"

if [ "$status" -ne 0 ]; then
  echo "copy-lint: email address found" >&2
fi
exit "$status"
