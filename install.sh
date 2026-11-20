#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: bash install.sh [--apply | --plugin | --print-mcp | --all | --help]
  (no args)    Preview Magpie CLI commands for group/gempt-{sonnet,opus,fable}
  --apply      Create group/gempt-{sonnet,opus,fable} in Magpie
  --plugin     Install the Antigravity gempt plugin (MCP + rules + skills)
  --print-mcp  Print standard MCP JSON config for Magpie Library / external clients
  --all        Run --apply followed by --plugin
EOF
}

resolve_python_bin() {
    if [[ -n ${PYTHON_BIN:-} ]]; then
        printf '%s\n' "$PYTHON_BIN"
        return 0
    fi
    local cand
    for cand in python3 python; do
        if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
            command -v "$cand"
            return 0
        fi
    done
    printf 'Python 3.10+ not found (set PYTHON_BIN or install python3).\n' >&2
    return 1
}

run_gempt_python() {
    local python_bin script_dir src_dir
    python_bin=$(resolve_python_bin)
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    src_dir="$script_dir/src"
    if command -v cygpath >/dev/null 2>&1; then
        src_dir=$(cygpath -w "$src_dir")
    fi
    PYTHONPATH="$src_dir" "$python_bin" -m gempt "$@"
}

if (( $# > 1 )); then
    usage >&2
    exit 2
fi

mode=${1:-preview}
case "$mode" in
    -h|--help)
        usage
        exit 0
        ;;
    --plugin)
        run_gempt_python install-agy
        exit 0
        ;;
    --print-mcp)
        run_gempt_python print-mcp
        exit 0
        ;;
    preview|--apply|--all)
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

magpie_bin=${MAGPIE_BIN:-}
if [[ -z $magpie_bin ]]; then
    if found=$(command -v magpie.com 2>/dev/null); then
        magpie_bin=$found
    elif found=$(command -v magpie 2>/dev/null); then
        magpie_bin=$found
    else
        for cand in \
            "$HOME/.local/opt/magpie/magpie" \
            "$HOME/apps/magpie/magpie.com" \
            "${LOCALAPPDATA:+$LOCALAPPDATA/Programs/magpie/magpie.com}"; do
            if [[ -n $cand && -x $cand ]]; then
                magpie_bin=$cand
                break
            fi
        done
    fi
fi
: "${magpie_bin:=magpie}"

exec_magpie() {
    env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
        NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 \
        "$magpie_bin" "$@"
}

normalize_group_member() {
    local model=$1
    if [[ $model == auto/* ]]; then
        local slug=${model#auto/}
        printf 'group/auto-%s\n' "${slug//./-}"
    else
        printf '%s\n' "$model"
    fi
}

strip_model_modifiers() {
    local base=${1%%#*}
    base=${base%:fast}
    case $base in
        *:none|*:minimal|*:low|*:medium|*:high|*:xhigh|*:max|*:ultra)
            base=${base%:*}
            ;;
    esac
    printf '%s\n' "$base"
}

catalog_has_model() {
    awk -v model="$1" '$1 == model { found = 1; exit } END { exit !found }' <<< "$catalog"
}

model_exists() {
    local raw=$1
    if catalog_has_model "$raw"; then
        return 0
    fi
    if [[ $raw == auto/* || $raw == group/* ]]; then
        local norm
        norm=$(normalize_group_member "$raw")
        exec_magpie group show "${norm#group/}" >/dev/null 2>&1
        return $?
    fi
    local base
    base=$(strip_model_modifiers "$raw")
    [[ $base != "$raw" ]] && catalog_has_model "$base"
}

hydrogen=${GEMPT_HYDROGEN:-antigravity/gemini-4-hydrogen}
neon=${GEMPT_NEON:-antigravity/gemini-4-neon}
argon=${GEMPT_ARGON:-antigravity/gemini-4-argon}
terra=${GEMPT_TERRA:-${GEMPT_SOL:-codex/gpt-6.1-terra}}
sol=${GEMPT_SOL:-codex/gpt-6.2-sol}
astra=${GEMPT_ASTRA:-codex/gpt-6.2-astra}
flash=${DEEPSEEK_FLASH:-workbuddy/deepseek-v4.1-flash}
tiers=(gempt-sonnet gempt-opus gempt-fable)

hydrogen_m=$(normalize_group_member "$hydrogen")
neon_m=$(normalize_group_member "$neon")
argon_m=$(normalize_group_member "$argon")
terra_m=$(normalize_group_member "$terra")
sol_m=$(normalize_group_member "$sol")
astra_m=$(normalize_group_member "$astra")
flash_m=$(normalize_group_member "$flash")

apply=no
if [[ $mode == --apply || $mode == --all ]]; then
    apply=yes
    catalog=$(exec_magpie models | tr -d '\r')
    if [[ -z ${GEMPT_TERRA:-} ]] && ! model_exists "$terra"; then
        terra=$sol
        terra_m=$sol_m
    fi
    for model in "$hydrogen" "$neon" "$argon" "$terra" "$sol" "$astra" "$flash"; do
        if ! model_exists "$model"; then
            printf 'Model not found in Magpie: %s\n' "$model" >&2
            exit 1
        fi
    done

    exec_magpie groups >/dev/null
    for tier in "${tiers[@]}"; do
        if exec_magpie group "$tier" >/dev/null 2>&1; then
            printf 'Routing group already exists: group/%s\n' "$tier" >&2
            exit 1
        fi
    done
fi

run_magpie() {
    printf '%q ' "$magpie_bin" "$@"
    printf '\n'
    if [[ $apply == yes ]]; then
        exec_magpie "$@"
    fi
}

run_magpie group add gempt-sonnet "models=$hydrogen_m,$terra_m,$flash_m" routing=order stays=turn
run_magpie group rule add gempt-sonnet "use=$flash_m" compact
run_magpie group rule add gempt-sonnet "use=$flash_m" "classifier=$flash_m" \
    'intent=simple formatting, adding comments, renaming, translating, writing boilerplate, or trivial quick questions'
run_magpie group rule add gempt-sonnet "use=$terra_m" when=subagent
run_magpie group rule add gempt-sonnet "use=$terra_m" \
    'intent=writing code, editing files, running tests, or fixing bugs'

run_magpie group add gempt-opus "models=$neon_m,$sol_m,$astra_m,$flash_m" routing=order stays=turn
run_magpie group rule add gempt-opus "use=$flash_m" compact
run_magpie group rule add gempt-opus "use=$astra_m" "classifier=$flash_m" \
    'intent=debugging hard bugs, complex algorithms, math/physics derivations, or critical architecture changes'
run_magpie group rule add gempt-opus "use=$sol_m" when=subagent
run_magpie group rule add gempt-opus "use=$sol_m" \
    'intent=writing code, editing files, implementing features, or writing tests'

run_magpie group add gempt-fable "models=$argon_m,$astra_m,$flash_m" routing=order stays=turn
run_magpie group rule add gempt-fable "use=$flash_m" compact
run_magpie group rule add gempt-fable "use=$astra_m" when=subagent
run_magpie group rule add gempt-fable "use=$astra_m" "classifier=$flash_m" \
    'intent=writing code, editing files, debugging, or executing tasks'

if [[ $mode == --all ]]; then
    run_gempt_python install-agy
fi
