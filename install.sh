#!/usr/bin/env bash
set -euo pipefail

magpie_bin=${MAGPIE_BIN:-magpie}
if [[ -z ${MAGPIE_BIN:-} ]] && ! command -v magpie >/dev/null && [[ -x "$HOME/.local/opt/magpie/magpie" ]]; then
    magpie_bin="$HOME/.local/opt/magpie/magpie"
fi

hydrogen=${GEMPT_HYDROGEN:-agy-cli/gemini-4-hydrogen}
neon=${GEMPT_NEON:-agy-cli/gemini-4-neon}
argon=${GEMPT_ARGON:-agy-cli/gemini-4-argon}
sol=codex/gpt-6.2-sol
astra=codex/gpt-6.2-astra
flash=${DEEPSEEK_FLASH-workbuddy/deepseek-v4.1-flash}
if [[ $flash == off ]]; then
    flash=''
fi
tiers=(gempt-sonnet gempt-opus gempt-fable)
host_models=("$hydrogen" "$neon" "$argon")
levels=low,medium,high,xhigh
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
codex_dir=${CODEX_HOME:-"$HOME/.codex"}
instructions_heading='## GemPT 主持与派单'

if (( $# > 1 )); then
    printf 'Usage: bash install.sh [--apply|--update]\n' >&2
    exit 2
fi

case ${1:-} in
    '') apply=no ;;
    --apply|--update) apply=yes ;;
    *)
        printf 'Usage: bash install.sh [--apply|--update]\n' >&2
        exit 2
        ;;
esac

run_magpie() {
    printf '%q ' "$magpie_bin" "$@"
    printf '\n'
    if [[ $apply == yes ]]; then
        "$magpie_bin" "$@"
    fi
}

model_available() {
    awk -v model="$1" '$1 == model { found = 1 } END { exit !found }' <<< "$catalog"
}

if [[ $apply == yes ]]; then
    catalog=$("$magpie_bin" models)
    for model in "${host_models[@]}" "$sol" "$astra"; do
        if ! model_available "$model"; then
            printf 'Model not found in Magpie: %s\n' "$model" >&2
            exit 1
        fi
    done
    if [[ -n $flash ]] && ! model_available "$flash"; then
        if [[ -n ${DEEPSEEK_FLASH+x} ]]; then
            printf 'DEEPSEEK_FLASH model not found in Magpie: %s\n' "$flash" >&2
            exit 1
        fi
        printf 'DeepSeek Flash not found in Magpie: %s. Keeping compaction on Gemini.\n' "$flash" >&2
        flash=''
    fi

    if [[ $1 == --apply ]]; then
        for tier in "${tiers[@]}"; do
            if "$magpie_bin" group "$tier" >/dev/null 2>&1; then
                printf 'Routing group already exists: group/%s. Use --update to replace the GemPT preset.\n' "$tier" >&2
                exit 1
            fi
        done
    fi

    mkdir -p "$codex_dir/agents"
    for role in gempt-sol gempt-astra; do
        if [[ -e $codex_dir/agents/$role.toml ]] && ! cmp -s "$source_dir/codex/$role.toml" "$codex_dir/agents/$role.toml"; then
            printf 'Codex agent already has different settings: %s\n' "$codex_dir/agents/$role.toml" >&2
            exit 1
        fi
    done
    for role in gempt-sol gempt-astra; do
        if [[ ! -e $codex_dir/agents/$role.toml ]]; then
            cp "$source_dir/codex/$role.toml" "$codex_dir/agents/$role.toml"
        fi
    done
    if ! grep -qxF "$instructions_heading" "$codex_dir/AGENTS.md" 2>/dev/null; then
        printf '\n' >> "$codex_dir/AGENTS.md"
        cat "$source_dir/codex/instructions.md" >> "$codex_dir/AGENTS.md"
    fi
fi

for tier_index in "${!tiers[@]}"; do
    tier=${tiers[$tier_index]}
    models=${host_models[$tier_index]}
    if [[ -n $flash ]]; then
        models+=",$flash"
    fi
    run_magpie group add "$tier" "models=$models" routing=order stays=turn "levels=$levels"
    if [[ -n $flash ]]; then
        run_magpie group rule add "$tier" "use=$flash" compact
    fi
done
