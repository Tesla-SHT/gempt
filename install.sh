#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! command -v node >/dev/null 2>&1 ||
    ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 20 || (major === 20 && minor < 11) ? 1 : 0)' >/dev/null 2>&1; then
    printf 'Node.js 20.11.0 or later is required.\n' >&2
    exit 1
fi

case "${1:-}" in
    --preview|--apply) set -- presets "$@" ;;
    --print-mcp) shift; set -- print-mcp "$@" ;;
    -h|--help) set -- --help ;;
    *) set -- install-agy "$@" ;;
esac
exec node "$script_dir/bin/gempt.mjs" "$@"
