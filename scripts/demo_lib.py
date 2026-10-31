"""Offline capture shared by the README demo GIF and asciinema cast.

Both artifacts run `mcp-health check --no-user` on fixtures/issues (exit 2)
and fixtures/healthy (exit 0). Absolute checkout paths are rewritten to the
repo-relative fixture directory. The commands do not use the network.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ["node", str(ROOT / "dist" / "cli.js"), "check", "--no-user"]

# fixture, expected exit, command shown in the demo
SCENES = (
    ("issues", 2, "mcp-health check --no-user fixtures/issues"),
    ("healthy", 0, "mcp-health check --no-user fixtures/healthy"),
)

FORBIDDEN = ("/home/", "/Users/", "YOUR_KEY_HERE")


def capture(fixture: str, expected: int) -> str:
    target = (ROOT / "fixtures" / fixture).resolve()
    proc = subprocess.run(
        [*CLI, str(target)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != expected:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"{fixture} exited {proc.returncode}, expected {expected}")
    if proc.stderr.strip():
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"{fixture} wrote to stderr")
    prefix = str(target)
    relative = f"fixtures/{fixture}"
    if prefix not in proc.stdout:
        raise SystemExit(f"CLI output did not contain {prefix}")
    text = proc.stdout.replace(prefix, relative).rstrip("\n")
    if prefix in text or str(ROOT.resolve()) in text:
        raise SystemExit("absolute checkout path remained in the demo output")
    for marker in FORBIDDEN:
        if marker in text:
            raise SystemExit(f"demo output contains {marker}")
    return text


def scenes() -> list[tuple[str, str, str]]:
    """Return (fixture, command, rewritten stdout) for the two demo runs."""
    captured: list[tuple[str, str, str]] = []
    for fixture, expected, command in SCENES:
        captured.append((fixture, command, capture(fixture, expected)))
    return captured
