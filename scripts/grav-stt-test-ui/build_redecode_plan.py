#!/usr/bin/env python3
"""Create a timestamp-only recovery plan from generic review evidence."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(source: Path, destination: Path, neighbour_radius: int = 1) -> None:
    reviewed = json.loads(source.read_text(encoding="utf-8"))
    windows = list(reviewed.get("utteranceReviews", []))
    seeds = {
        index for index, window in enumerate(windows)
        if window.get("semanticReview", {}).get("recoveryRequired")
    }
    # Overlapping context windows can place the faulty word just before or
    # after the window Qwen marked incoherent.  Expand by timestamp adjacency,
    # never by a phrase, product name, or tenant vocabulary.
    selected = {
        index + delta
        for index in seeds
        for delta in range(-neighbour_radius, neighbour_radius + 1)
        if 0 <= index + delta < len(windows)
    }
    plan = [{
        "id": window["id"],
        "startSeconds": window["startSeconds"],
        "endSeconds": window["endSeconds"],
    } for index, window in enumerate(windows) if index in selected]
    destination.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"spans": len(plan)}))


if __name__ == "__main__":
    radius = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    main(Path(sys.argv[1]), Path(sys.argv[2]), radius)
