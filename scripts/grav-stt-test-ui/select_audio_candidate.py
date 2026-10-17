#!/usr/bin/env python3
"""Select an audio-backed recovery candidate with no domain vocabulary.

The reasoner receives the target's raw ASR reading, independently re-decoded
audio candidates, and bounded neighbouring transcript.  It can select an exact
candidate id or leave the span uncertain.  It never receives a desired word,
industry glossary, or free-text correction target.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from transcript_quality import deterministic_flags, numeric_evidence
from transcript_reasoner import TranscriptReasoner, reasoner_packets


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("windows", type=Path, help="overlapping-context ASR result")
    parser.add_argument("candidates", type=Path, help="audio-candidate-redecode-v1 result")
    parser.add_argument("output", type=Path)
    parser.add_argument("--window-index", type=int, required=True)
    parser.add_argument("--context-radius", type=int, default=4)
    parser.add_argument("--meeting-context", default="")
    args = parser.parse_args()

    source = json.loads(args.windows.read_text(encoding="utf-8"))
    raw_windows = list(source.get("windows") or [])
    if not 0 <= args.window_index < len(raw_windows):
        raise ValueError("window index is outside the supplied transcript")
    recovered = json.loads(args.candidates.read_text(encoding="utf-8"))
    target_start = float(recovered["targetStartSeconds"])
    target_end = float(recovered["targetEndSeconds"])

    windows: list[dict] = []
    for index, item in enumerate(raw_windows):
        raw = str(item.get("romanText") or "").strip()
        start = float(item.get("startSeconds") or 0)
        end = float(item.get("endSeconds") or start)
        candidates = [{
            "id": "raw_context_window",
            "romanText": raw,
            "source": "original ASR context window",
        }]
        if index == args.window_index:
            candidates.extend(recovered.get("candidates") or [])
        windows.append({
            "id": f"context-window-{index:04d}",
            "speaker": "Unattributed contextual audio",
            "startSeconds": start,
            "endSeconds": end,
            "rawRomanText": raw,
            "candidateTranscripts": candidates,
            "qualityFlags": deterministic_flags(raw, max(0.1, end - start)),
            "numericEvidence": numeric_evidence(candidates),
        })

    target = windows[args.window_index]
    reasoner = TranscriptReasoner(domain_terms=[])
    if not reasoner.enabled:
        raise RuntimeError("GRAV_TRANSCRIPT_REASONER_URL is not configured")
    packets = reasoner_packets(
        windows,
        selected_ids={target["id"]},
        domain_terms=[],
        context_radius=args.context_radius,
        meeting_context=args.meeting_context,
    )
    reviews = reasoner.review(packets[0])
    review = next((item for item in reviews if item.get("id") == target["id"]), None)
    selected_id = review.get("selectedCandidateId") if review else None
    candidate_ids = {item.get("id") for item in target["candidateTranscripts"]}
    if selected_id not in candidate_ids:
        selected_id = None
    selected = next((item for item in target["candidateTranscripts"] if item.get("id") == selected_id), None)
    result = {
        "schemaVersion": "audio-candidate-selection-v1",
        "sourceWindowIndex": args.window_index,
        "sourceSpan": {"startSeconds": target_start, "endSeconds": target_end},
        "rawRomanText": target["rawRomanText"],
        "candidates": target["candidateTranscripts"],
        "semanticReview": review,
        "selectedCandidateId": selected_id,
        "selectedRomanText": selected.get("romanText") if selected else None,
        "authority": "context selects only an exact audio-backed candidate; no vocabulary or free-text correction was supplied",
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"selectedCandidateId": selected_id, "state": (review or {}).get("state")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
