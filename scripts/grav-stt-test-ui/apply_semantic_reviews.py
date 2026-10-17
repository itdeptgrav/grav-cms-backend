#!/usr/bin/env python3
"""Attach private evidence-only semantic reviews to an existing ASR run.

This is useful when acoustic candidates have already been generated. It never
changes candidate text: the verifier may only select an exact candidate id.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from transcript_reasoner import TranscriptReasoner, reasoner_packets


def main(source: Path, destination: Path) -> None:
    result = json.loads(source.read_text(encoding="utf-8"))
    windows = result["utteranceReviews"]
    reasoner = TranscriptReasoner()
    if not reasoner.enabled:
        raise RuntimeError("Semantic verifier is not configured")
    reviews: dict[str, dict] = {}
    # Keep each local-Qwen request short enough to return promptly on the
    # shared GPU while still giving each span immediate neighbours.
    for packet in reasoner_packets(windows, batch_size=4, domain_terms=reasoner.domain_terms):
        for review in reasoner.review(packet):
            reviews[review["id"]] = review

    # A constrained JSON generation can occasionally omit an item from a
    # multi-utterance response.  Do not silently turn that transport/model
    # omission into a transcript judgement: retry each missing item alone with
    # the same bounded context and no additional vocabulary.
    missing_ids = {window["id"] for window in windows} - set(reviews)
    for packet in reasoner_packets(
        windows, batch_size=1, selected_ids=missing_ids,
        domain_terms=reasoner.domain_terms,
    ):
        for review in reasoner.review(packet):
            reviews[review["id"]] = review
    recovery_ids = {
        window["id"] for window in windows
        if len(window.get("candidateTranscripts", [])) > 1
        or window.get("qualityFlags")
        or reviews.get(window["id"], {}).get("recoveryRequired")
    }
    for packet in reasoner_packets(
        windows, batch_size=4, selected_ids=recovery_ids, domain_terms=reasoner.domain_terms
    ):
        for review in reasoner.review(packet):
            reviews[review["id"]] = review
    for window in windows:
        review = reviews.get(window["id"])
        candidates = {item["id"]: item for item in window["candidateTranscripts"]}
        selected_id = review.get("selectedCandidateId") if review else None
        if selected_id not in candidates:
            selected_id = min(
                candidates,
                key=lambda candidate_id: (
                    len(candidates[candidate_id].get("qualityFlags", [])),
                    candidate_id != "contextual_redecode",
                ),
            )
        window["semanticReview"] = review or {
            "state": "uncertain", "selectedCandidateId": None,
            "semanticIssues": [], "recoveryRequired": False,
            "reason": "Private verifier returned no review.",
        }
        window["qualityState"] = window["semanticReview"]["state"]
        window["selectedCandidateId"] = selected_id
        window["selectedRomanText"] = candidates[selected_id]["romanText"]
        window["trustedForReadableTranscript"] = (
            window["qualityState"] == "coherent"
            and window["numericEvidence"]["safeForStructuredFacts"]
        )
        window["safeForStructuredFacts"] = window["trustedForReadableTranscript"]
    result["semanticReasoner"]["status"] = "completed"
    result["semanticReasoner"]["errorClass"] = None
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
