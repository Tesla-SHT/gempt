"""Execution errors shared by the Codex app-server transports."""


class CodexExecError(RuntimeError):
    """A Codex workspace turn could not start or complete."""
