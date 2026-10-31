#!/usr/bin/env python3
"""Record docs/demo.cast from the current offline demo commands.

After `npm run build`:

    python3 scripts/record-demo-cast.py

The cast is the same two runs as docs/demo.gif: `fixtures/issues` (exit 2)
and `fixtures/healthy` (exit 0). Paths are repo-relative. Nothing is uploaded
and the script does not use the network. Play it with
`asciinema play docs/demo.cast`.
"""

from __future__ import annotations

import json
from pathlib import Path

from demo_lib import scenes

OUT = Path(__file__).resolve().parents[1] / "docs" / "demo.cast"
# Fixed so a rebuild does not churn the header when the output is unchanged.
TIMESTAMP = 1761900000


def terminal(text: str) -> str:
    """Carriage return plus line feed, so a player does not staircase."""
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def main() -> None:
    captured = scenes()
    width = 40
    height = 8
    events: list[tuple[float, str]] = []
    clock = 0.0
    for _fixture, command, body in captured:
        events.append((clock, terminal(f"$ {command}\n")))
        clock += 0.4
        events.append((clock, terminal(body + "\n\n")))
        clock += 1.2
        width = max(width, len(command) + 2)
        width = max(width, *(len(line) + 1 for line in body.split("\n")))
        # Prompt, body, the blank line after it, and a cursor row.
        height = max(height, body.count("\n") + 6)

    header = {
        "version": 2,
        "width": width,
        "height": height,
        "timestamp": TIMESTAMP,
        "title": "mcp-health check --no-user",
        "env": {"SHELL": "/bin/sh", "TERM": "xterm-256color"},
    }
    lines = [json.dumps(header, ensure_ascii=False, separators=(", ", ": "))]
    for time, data in events:
        lines.append(
            json.dumps([round(time, 6), "o", data], ensure_ascii=False, separators=(", ", ": "))
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {width}x{height})")


if __name__ == "__main__":
    main()
