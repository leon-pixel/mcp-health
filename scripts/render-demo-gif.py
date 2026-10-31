#!/usr/bin/env python3
"""Render docs/demo.gif from a real `mcp-health check` run.

The GIF shows the CLI stdout for fixtures/issues and fixtures/healthy.
Absolute checkout paths are rewritten to the repo-relative fixture path
so the image is not tied to one machine. Finding text is unchanged.
Long lines wrap so the hint stays readable; the GIF comment stores the
unwrapped text. The cast of the same commands is recorded with:

    python3 scripts/record-demo-cast.py

Neither command uses the network. Rebuild the GIF, after `npm run build`,
with `python3 scripts/render-demo-gif.py` (needs Pillow and a monospace font).
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from demo_lib import scenes

ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf"
OUT = ROOT / "docs" / "demo.gif"
COLUMNS = 100

BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (230, 237, 243)
DIM = (139, 148, 158)
FAIL = (248, 81, 73)
WARN = (210, 153, 34)
OK = (63, 185, 80)


def wrap(body: str, columns: int = COLUMNS) -> str:
    """Wrap long lines on a space, keeping the line's indent on the next row."""
    wrapped: list[str] = []
    for line in body.split("\n"):
        if len(line) <= columns:
            wrapped.append(line)
            continue
        indent = line[: len(line) - len(line.lstrip(" "))]
        rest = line
        while rest:
            if len(rest) <= columns:
                wrapped.append(rest)
                break
            cut = rest.rfind(" ", 0, columns + 1)
            if cut <= len(indent):
                cut = columns
            wrapped.append(rest[:cut].rstrip())
            rest = indent + rest[cut:].lstrip()
    return "\n".join(wrapped)


def line_color(line: str) -> tuple[int, int, int]:
    if line.startswith("[FAIL]") or " FAIL " in line:
        return FAIL
    if line.startswith("[WARN]") or " WARN " in line:
        return WARN
    if line.startswith("[OK]") or " OK " in line:
        return OK
    if line.startswith("      "):
        return DIM
    if (
        line.startswith("mcp-health")
        or line.startswith("files:")
        or line.startswith("Configs:")
        or line.startswith("  - ")
    ):
        return DIM
    return FG


def render(
    title: str,
    body: str,
    width: int,
    height: int,
    font: ImageFont.FreeTypeFont,
    line_h: int,
) -> Image.Image:
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, 36), fill=BAR)
    for idx, color in enumerate(((248, 81, 73), (210, 153, 34), (63, 185, 80))):
        x = 14 + idx * 16
        draw.ellipse((x, 12, x + 10, 22), fill=color)
    draw.text((70, 8), title, font=font, fill=DIM)
    y = 50
    for line in body.split("\n"):
        draw.text((18, y), line, font=font, fill=line_color(line))
        y += line_h
    return image


def main() -> None:
    captured = scenes()
    shown = [(command, wrap(body)) for _fixture, command, body in captured]
    comment = json.dumps(
        {fixture: body for fixture, _command, body in captured},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    font = ImageFont.truetype(FONT_PATH, 15)
    line_h = 22
    pad_x = 18
    longest = max(font.getlength(line) for _, body in shown for line in body.split("\n"))
    longest = max(longest, max(font.getlength(title) for title, _ in shown) + 70)
    width = int(pad_x * 2 + longest + 8)
    height = 50 + max(body.count("\n") + 1 for _, body in shown) * line_h + 16
    frames = [render(title, body, width, height, font, line_h) for title, body in shown]
    palette = frames[0].quantize(colors=32, method=Image.Quantize.MEDIANCUT)
    quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=[4200, 2800],
        loop=0,
        optimize=True,
        disposal=2,
        comment=comment,
    )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {width}x{height})")


if __name__ == "__main__":
    main()
