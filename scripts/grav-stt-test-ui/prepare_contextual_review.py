#!/usr/bin/env python3
"""Prepare overlapping ASR windows for generic semantic review.

No vocabulary or product metadata is read.  This is intentionally the baseline
for a portable transcript service.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from transcript_quality import deterministic_flags, numeric_evidence


def main(source: Path, destination: Path) -> None:
    raw = json.loads(source.read_text(encoding="utf-8"))
    windows = []
    for index, item in enumerate(raw.get("windows") or []):
        text = str(item.get("romanText") or "").strip()
        start = float(item.get("startSeconds") or 0)
        end = float(item.get("endSeconds") or start)
        candidate = {
            "id": "raw_context_window",
            "romanText": text,
            "source": "original overlapping ASR context window",
            "qualityFlags": deterministic_flags(text, max(0.1, end - start)),
        }
        windows.append({
            "id": f"context-window-{index:04d}",
            "speaker": "Unattributed contextual audio",
            "startSeconds": start,
            "endSeconds": end,
            "rawRomanText": text,
            "candidateTranscripts": [candidate],
            "qualityFlags": candidate["qualityFlags"],
            "numericEvidence": numeric_evidence([candidate]),
        })
    result = {
        "schemaVersion": "generic-context-review-v1",
        "complete": bool(raw.get("complete")),
        "manualOrLlmEditing": False,
        "semanticReasoner": {"status": "pending", "authority": "classifies evidence only"},
        "utteranceReviews": windows,
    }
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"windows": len(windows)}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
