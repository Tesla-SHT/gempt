#!/usr/bin/env bash
set -euo pipefail

magpie_bin=${MAGPIE_BIN:-magpie}
if [[ -z ${MAGPIE_BIN:-} ]] && ! command -v magpie >/dev/null && [[ -x "$HOME/.local/opt/magpie/magpie" ]]; then
    magpie_bin="$HOME/.local/opt/magpie/magpie"
fi

hydrogen=${GEMPT_HYDROGEN:-antigravity/gemini-4-hydrogen}
neon=${GEMPT_NEON:-antigravity/gemini-4-neon}
argon=${GEMPT_ARGON:-antigravity/gemini-4-argon}
sol=${GEMPT_SOL:-codex/gpt-6.2-sol}
astra=${GEMPT_ASTRA:-codex/gpt-6.2-astra}
flash=${DEEPSEEK_FLASH:-workbuddy/deepseek-v4.1-flash}
tiers=(gempt-sonnet gempt-opus gempt-fable)

if (( $# > 1 )) || [[ ${1:-} != '' && ${1:-} != --apply ]]; then
    printf 'Usage: bash install.sh [--apply]\n' >&2
    exit 2
fi

if [[ ${1:-} == --apply ]]; then
    catalog=$("$magpie_bin" models)
    for model in "$hydrogen" "$neon" "$argon" "$sol" "$astra" "$flash"; do
        if ! awk -v model="$model" '$1 == model { found = 1 } END { exit !found }' <<< "$catalog"; then
            printf 'Model not found in Magpie: %s\n' "$model" >&2
            exit 1
        fi
    done

    "$magpie_bin" groups >/dev/null
    for tier in "${tiers[@]}"; do
        if "$magpie_bin" group "$tier" >/dev/null 2>&1; then
            printf 'Routing group already exists: group/%s\n' "$tier" >&2
            exit 1
        fi
    done
fi

run_magpie() {
    printf '%q ' "$magpie_bin" "$@"
    printf '\n'
    if [[ $apply == yes ]]; then
        "$magpie_bin" "$@"
    fi
}

apply=no
if [[ ${1:-} == --apply ]]; then
    apply=yes
fi

run_magpie group add gempt-sonnet "models=$hydrogen,$sol,$flash" routing=order stays=turn
run_magpie group rule add gempt-sonnet "use=$flash" compact
run_magpie group rule add gempt-sonnet "use=$flash" "classifier=$flash" \
    'intent=simple formatting, adding comments, renaming, translating, writing boilerplate, or trivial quick questions'
run_magpie group rule add gempt-sonnet "use=$sol" when=subagent
run_magpie group rule add gempt-sonnet "use=$sol" \
    'intent=writing code, editing files, running tests, or fixing bugs'

run_magpie group add gempt-opus "models=$neon,$sol,$astra,$flash" routing=order stays=turn
run_magpie group rule add gempt-opus "use=$flash" compact
run_magpie group rule add gempt-opus "use=$astra" "classifier=$flash" \
    'intent=debugging hard bugs, complex algorithms, math/physics derivations, or critical architecture changes'
run_magpie group rule add gempt-opus "use=$sol" when=subagent
run_magpie group rule add gempt-opus "use=$sol" \
    'intent=writing code, editing files, implementing features, or writing tests'

run_magpie group add gempt-fable "models=$argon,$astra,$flash" routing=order stays=turn
run_magpie group rule add gempt-fable "use=$flash" compact
run_magpie group rule add gempt-fable "use=$astra" when=subagent
run_magpie group rule add gempt-fable "use=$astra" "classifier=$flash" \
    'intent=writing code, editing files, debugging, or executing tasks'
