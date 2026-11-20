"""gempt — Gemini × GPT dual-mode orchestrator via local Magpie gateway."""

from pathlib import Path

__version__ = "0.1.0"

DEFAULT_MAGPIE_URL = "http://127.0.0.1:3425"
CONFIG_DIR = Path.home() / ".config" / "gempt"
DEFAULT_CONFIG_PATH = CONFIG_DIR / "config.json"
SESSIONS_DIR = CONFIG_DIR / "sessions"

TIER_ORDER = ("sonnet", "opus", "fable")
CONSULT_TIERS = ("chore", "sonnet", "opus", "fable")
TIER_ALIASES = {
    "lite": "sonnet",
    "mid": "opus",
    "max": "fable",
    "utility": "chore",
    "fast": "chore",
    "free": "chore",
}

VALID_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
RECOMMENDED_EFFORTS = ("medium", "high", "xhigh")
EFFORT_RANK = {name: idx for idx, name in enumerate(VALID_EFFORTS)}
VALID_SANDBOXES = ("read-only", "workspace-write", "danger-full-access")
VALID_FAILOVER_MODES = ("subscription_only",)
VALID_GROUP_STRATEGIES = ("order", "smart", "rotate", "pace", "drain", "usage")
