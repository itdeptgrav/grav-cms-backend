#!/usr/bin/env python3
"""Attach diarizer activity to already-decoded context windows.

This never reallocates words between speakers: the ASR text remains the exact
context-window output.  It reports which speakers were active in the window so
the document is useful without pretending word-level speaker alignment exists.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("contextual", type=Path)
    parser.add_argument("diarization", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    contextual = json.loads(args.contextual.read_text(encoding="utf-8"))
    diarization = json.loads(args.diarization.read_text(encoding="utf-8"))
    turns = diarization.get("speakerTurns", [])
    for window in contextual.get("windows", []):
        durations: dict[str, float] = defaultdict(float)
        for turn in turns:
            overlap = max(0.0, min(float(window["endSeconds"]), float(turn["endSeconds"])) - max(float(window["startSeconds"]), float(turn["startSeconds"])))
            if overlap:
                durations[str(turn["speaker"])] += overlap
        active = [speaker for speaker, duration in sorted(durations.items(), key=lambda item: (-item[1], item[0])) if duration >= 1.0]
        window["speakerActivity"] = " + ".join(active) if active else "No diarizer speech detected"
        window["speakerAttributionPolicy"] = "activity only; no word-level speaker assignment"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(contextual, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
