#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
src_dir="$script_dir/src"
if command -v cygpath >/dev/null 2>&1; then
    src_dir=$(cygpath -am "$src_dir")
fi
bootstrap='import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("gempt",run_name="__main__")'

if [[ -n ${PYTHON_BIN:-} ]]; then
    exec "$PYTHON_BIN" -I -c "$bootstrap" "$src_dir" install "$@"
fi
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -I -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
        exec "$candidate" -I -c "$bootstrap" "$src_dir" install "$@"
    fi
done
if command -v uv >/dev/null 2>&1; then
    exec uv run --no-project --python '>=3.10' python -I -c "$bootstrap" "$src_dir" install "$@"
fi
printf 'Python 3.10+ or uv is required. Set PYTHON_BIN to use a specific Python.\n' >&2
exit 1
