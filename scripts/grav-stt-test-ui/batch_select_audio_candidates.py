#!/usr/bin/env python3
"""Select generic audio-backed recovery candidates for a reviewed transcript."""

from __future__ import annotations

import json
import argparse
import sys
from pathlib import Path

from transcript_quality import numeric_evidence
from transcript_reasoner import TranscriptReasoner, reasoner_packets


def consistent_audio_candidate(window: dict, additions: list[dict]) -> str | None:
    """Return a narrowly audio-backed candidate supported across windows.

    A repeated spoken-form variant becomes actionable only when at least two
    separate windows contain the alternate compact phrase *and* the candidate
    itself is an exact same-source audio decode containing that phrase.  This
    never maps a phrase to a replacement vocabulary item.
    """
    evidence = window.get("crossTranscriptEvidence") or []
    for candidate in additions:
        if not candidate.get("crossTranscriptEvidenceMatch"):
            continue
        text = str(candidate.get("romanText") or "").casefold()
        support: dict[str, set[str]] = {}
        for item in evidence:
            left = str(item.get("leftPhrase") or "").casefold()
            right = str(item.get("rightPhrase") or "").casefold()
            raw = str(window.get("rawRomanText") or "").casefold()
            # Candidate must switch away from the raw compact phrase towards
            # its independently recurring counterpart.
            if left in raw and right in text and left not in text:
                support.setdefault(right, set()).add(str(item.get("otherWindowId") or ""))
            if right in raw and left in text and right not in text:
                support.setdefault(left, set()).add(str(item.get("otherWindowId") or ""))
        if any(len(ids - {""}) >= 2 for ids in support.values()):
            return str(candidate["id"])
    return None


def meeting_context_from(path: Path | None) -> str:
    """Return transcript-derived meeting context, never tenant vocabulary.

    The context is deliberately read from a prior model profile produced from
    the same recording.  It lets the verifier recognise that, for example, an
    acoustically attested candidate fits the current meeting better than a
    similarly sounding word, but it cannot supply replacement text itself.
    """
    if path is None:
        return ""
    payload = json.loads(path.read_text(encoding="utf-8"))
    context = payload.get("meetingAwareCorrection", {}).get("meetingModel", {})
    if not isinstance(context, dict):
        raise ValueError("meeting context does not contain a transcript-derived meeting model")
    return json.dumps(context.get("model", context), ensure_ascii=False)


def main(
    reviewed_path: Path, candidates_path: Path, output: Path,
    consistency_plan_path: Path | None = None, meeting_context_path: Path | None = None,
) -> None:
    reviewed = json.loads(reviewed_path.read_text(encoding="utf-8"))
    decoded = json.loads(candidates_path.read_text(encoding="utf-8"))
    consistency_by_id = {}
    if consistency_plan_path:
        plan = json.loads(consistency_plan_path.read_text(encoding="utf-8"))
        consistency_by_id = {
            str(item.get("id")): list(item.get("evidence") or [])
            for item in plan.get("spans", [])
        }
    by_id = {item["id"]: item["candidates"] for item in decoded.get("candidates") or []}
    windows = reviewed["utteranceReviews"]
    meeting_context = meeting_context_from(meeting_context_path)
    recovery_ids = set()
    for window in windows:
        if window["id"] in consistency_by_id:
            window["crossTranscriptEvidence"] = consistency_by_id[window["id"]]
        additions = by_id.get(window["id"], [])
        if additions:
            window["candidateTranscripts"].extend(additions)
            window["numericEvidence"] = numeric_evidence(window["candidateTranscripts"])
            recovery_ids.add(window["id"])

    reasoner = TranscriptReasoner(domain_terms=[])
    if not reasoner.enabled:
        raise RuntimeError("GRAV_TRANSCRIPT_REASONER_URL is not configured")
    reviews: dict[str, dict] = {}
    for packet in reasoner_packets(
        # Two adjacent windows preserve conversational continuity while keeping
        # the candidate comparison small enough for predictable local-model
        # latency.  One-at-a-time review was needlessly slow; larger batches
        # make a noisy code-switched meeting harder to audit.
        windows, batch_size=2, selected_ids=recovery_ids, domain_terms=[], context_radius=4,
        meeting_context=meeting_context,
    ):
        for review in reasoner.review(packet):
            reviews[review["id"]] = review

    selected_count = 0
    provisional_ids: set[str] = set()
    for window in windows:
        if window["id"] not in recovery_ids:
            continue
        review = reviews.get(window["id"])
        additions = by_id.get(window["id"], [])
        candidate_ids = {item["id"] for item in window["candidateTranscripts"]}
        selected_id = review.get("selectedCandidateId") if review else None
        consistency_selected_id = consistent_audio_candidate(window, additions)
        if consistency_selected_id:
            selected_id = consistency_selected_id
        if selected_id not in candidate_ids:
            selected_id = "raw_context_window"
        selected = next(item for item in window["candidateTranscripts"] if item["id"] == selected_id)
        # A replacement that changes numeric evidence is unsafe even if it
        # sounds more fluent.  Leave the original evidence visible instead.
        if selected_id != "raw_context_window":
            raw_candidate = next(item for item in window["candidateTranscripts"] if item["id"] == "raw_context_window")
            comparison = numeric_evidence([raw_candidate, selected])
            if comparison["flags"]:
                selected_id = "raw_context_window"
                selected = raw_candidate
        window["semanticReview"] = review or window["semanticReview"]
        window["selectedCandidateId"] = selected_id
        window["selectedRomanText"] = selected["romanText"]
        window["displayRomanText"] = selected["romanText"]
        if selected_id != "raw_context_window":
            selected_count += 1
            provisional_ids.add(window["id"])

    # Selection is not acceptance.  Re-review the proposed readable text in
    # its final local context; only a coherent, numerically safe candidate may
    # replace the raw display.  This catches a fluent-looking but degraded
    # alternate decode without relying on any product vocabulary.
    validation_windows = []
    for window in windows:
        selected = window["selectedRomanText"]
        validation_windows.append({
            **window,
            "rawRomanText": selected,
            "candidateTranscripts": [{"id": "selected", "romanText": selected}],
            "numericEvidence": numeric_evidence([{"id": "selected", "romanText": selected}]),
        })
    validation: dict[str, dict] = {}
    for packet in reasoner_packets(
        validation_windows, batch_size=2, selected_ids=provisional_ids,
        domain_terms=[], context_radius=4, meeting_context=meeting_context,
    ):
        for review in reasoner.review(packet):
            validation[review["id"]] = review
    for window in windows:
        if window["id"] not in provisional_ids:
            continue
        check = validation.get(window["id"])
        if not check or check.get("state") != "coherent":
            raw_candidate = next(item for item in window["candidateTranscripts"] if item["id"] == "raw_context_window")
            window["selectedCandidateId"] = "raw_context_window"
            window["selectedRomanText"] = raw_candidate["romanText"]
            window["displayRomanText"] = raw_candidate["romanText"]
            window["postSelectionValidation"] = check or {"state": "uncertain", "reason": "No validation review."}
            selected_count -= 1
        else:
            window["postSelectionValidation"] = check
    reviewed["schemaVersion"] = "generic-context-recovery-v1"
    reviewed["audioRecovery"] = {
        "mode": "domain-neutral",
        "selectedAudioCandidates": selected_count,
        "meetingContext": bool(meeting_context),
        "authority": "meeting context selected exact source-audio ASR candidates; no vocabulary or free-text replacement was supplied",
    }
    output.write_text(json.dumps(reviewed, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"recovered": len(recovery_ids), "selectedAudioCandidates": selected_count}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reviewed_path", type=Path)
    parser.add_argument("candidates_path", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cross-window-plan", type=Path)
    parser.add_argument(
        "--meeting-context", type=Path,
        help="A transcript-derived meeting profile; it can rank exact audio candidates but cannot generate text.",
    )
    args = parser.parse_args()
    main(args.reviewed_path, args.candidates_path, args.output, args.cross_window_plan, args.meeting_context)
