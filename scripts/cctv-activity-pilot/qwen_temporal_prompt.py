#!/usr/bin/env python3
"""Four-frame contact-sheet contract for Qwen CCTV activity decisions."""

from __future__ import annotations

from collections.abc import Sequence

from PIL import Image, ImageDraw


PROMPT_VERSION = "qwen-cctv-activity-v4-hand-evidence"

PROMPT = """The image is an evidence panel for ONE tracked CCTV person.
The large left panel shows the full person. The two right panels are enlarged views of that same person's left and right wrist/hand areas. A missing or unreliable hand crop is blank.

Follow this decision order strictly:
1. Choose USING PHONE only when a physical rectangular phone body, screen, or edges are clearly visible in a hand crop and the person is visibly holding or operating it.
2. A hand near the face, an empty hand, a pen, cup, watch, keyboard, laptop, or a phone lying on the desk is NEVER phone use.
3. If no held phone is clearly visible, classify the person's other visible activity.

Return exactly one digit and nothing else:
1 = USING PHONE: a phone is clearly visible in the person's hand and is being used.
2 = WORKING: the person visibly uses a laptop, keyboard, paper, pen, document, tool, or machine.
3 = TALKING OR INTERACTING: the person is visibly engaged with another person, not merely near them.
4 = NO OBSERVABLE TASK: none of the listed activities is visibly occurring. This includes walking, standing, looking around, or waiting.
5 = UNCERTAIN: the person or relevant object is too small, blocked, ambiguous, or inconsistent to decide safely.

Do not infer intent, productivity, conversation content, or identity.
"""


def build_contact_sheet(
    frames: Sequence[Image.Image],
    *,
    tile_size: tuple[int, int] = (224, 224),
) -> Image.Image:
    """Create one fixed-size image so four-frame context does not quadruple tokens."""
    if not 1 <= len(frames) <= 4:
        raise ValueError("contact sheet requires between one and four frames")

    tile_width, tile_height = tile_size
    canvas = Image.new("RGB", (tile_width * 2, tile_height * 2), "#111827")
    draw = ImageDraw.Draw(canvas)

    for index, frame in enumerate(frames):
        tile = frame.convert("RGB")
        tile.thumbnail((tile_width, tile_height))
        x = (index % 2) * tile_width + (tile_width - tile.width) // 2
        y = (index // 2) * tile_height + (tile_height - tile.height) // 2
        canvas.paste(tile, (x, y))
        draw.rectangle(
            [index % 2 * tile_width, index // 2 * tile_height,
             index % 2 * tile_width + 74, index // 2 * tile_height + 24],
            fill="#111827",
        )
        draw.text(
            (index % 2 * tile_width + 6, index // 2 * tile_height + 5),
            f"Frame {index + 1}",
            fill="white",
        )

    return canvas
