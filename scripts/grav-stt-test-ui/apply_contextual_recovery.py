#!/usr/bin/env python3
"""Apply evidence-bound semantic and glossary recovery to context ASR windows.

This transforms a raw contextual-window run into an auditable readable-view
result. It never changes the raw window text. The private reasoner may only
classify evidence, and glossary normalisation may only replace an exact,
phonetic-supported raw span with a term from the supplied closed catalog.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from apply_contextual_terms import request_proposals
from contextual_terms import apply_normalizations, wider_context_packet
from contextual_terms import term_index
from transcript_quality import deterministic_flags, numeric_evidence
from transcript_reasoner import TranscriptReasoner, reasoner_packets


def _reviews(raw_windows: list[dict]) -> list[dict]:
    recovered = []
    for index, window in enumerate(raw_windows, start=1):
        raw = str(window.get("romanText") or "").strip()
        start = float(window.get("startSeconds") or 0)
        end = float(window.get("endSeconds") or start)
        candidate = {
            "id": "raw_context_window",
            "romanText": raw,
            "source": "original overlapping model-safe context window",
            "qualityFlags": deterministic_flags(raw, max(0.1, end - start)),
        }
        recovered.append({
            "id": f"context-window-{index:04d}",
            "speaker": "Unattributed contextual audio",
            "startSeconds": start,
            "endSeconds": end,
            "rawRomanText": raw,
            "candidateTranscripts": [candidate],
            "qualityFlags": list(candidate["qualityFlags"]),
            "numericEvidence": numeric_evidence([candidate]),
            "selectedCandidateId": "raw_context_window",
            "selectedRomanText": raw,
        })
    return recovered


def _focused_alias_packets(
    windows: list[dict], catalog: dict, *, meeting_context: str, radius: int,
) -> list[dict]:
    """Ask about one exact suspicious alias at a time.

    A 34-second window can contain both the correct word and its bad ASR
    variant.  Asking the terminology verifier about the whole window invites it
    to nominate the already-correct occurrence.  This focuses it on each exact
    non-canonical alias while preserving surrounding evidence and the closed
    catalog restriction.
    """
    packets: list[dict] = []
    for index, window in enumerate(windows):
        raw = str(window.get("selectedRomanText") or "")
        for term in term_index(catalog).values():
            canonical = str(term["canonicalText"])
            aliases = [str(alias).strip() for alias in term.get("aliases", [])]
            for alias in aliases:
                if not alias or alias.casefold() == canonical.casefold():
                    continue
                for match in re.finditer(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", raw, re.I):
                    packet = wider_context_packet(
                        windows, index, {"version": catalog.get("version"), "terms": [term]},
                        radius=radius, meeting_context=meeting_context,
                    )
                    packet["targetRawText"] = match.group(0)
                    packet["focusedRawSpan"] = match.group(0)
                    packets.append(packet)
    return packets


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--meeting-context", default="")
    parser.add_argument("--radius", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()

    source = json.loads(args.source.read_text(encoding="utf-8"))
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    windows = _reviews(list(source.get("windows") or []))
    reasoner = TranscriptReasoner()
    if not reasoner.enabled:
        raise RuntimeError("GRAV_TRANSCRIPT_REASONER_URL is not configured")

    semantic: dict[str, dict] = {}
    for packet in reasoner_packets(
        windows,
        batch_size=args.batch_size,
        domain_terms=reasoner.domain_terms,
        context_radius=args.radius,
        meeting_context=args.meeting_context,
    ):
        for review in reasoner.review(packet):
            semantic[str(review["id"])] = review

    for window in windows:
        review = semantic.get(str(window["id"]))
        window["semanticReview"] = review or {
            "state": "uncertain",
            "selectedCandidateId": None,
            "semanticIssues": [],
            "recoveryRequired": True,
            "reason": "No semantic review returned.",
        }
        window["qualityState"] = window["semanticReview"]["state"]

    packets = [
        wider_context_packet(
            windows, index, catalog, radius=args.radius, meeting_context=args.meeting_context,
        )
        for index in range(len(windows))
    ]
    proposals = []
    for start in range(0, len(packets), args.batch_size):
        proposals.extend(request_proposals(packets[start:start + args.batch_size]))

    focused_packets = _focused_alias_packets(
        windows, catalog, meeting_context=args.meeting_context, radius=args.radius,
    )
    # Focused packets are intentionally one-at-a-time: each must nominate the
    # exact source alias, rather than a different, already-correct word from
    # the same long context window.
    for packet in focused_packets:
        proposals.extend(request_proposals([packet]))

    result = {"utteranceReviews": windows}
    accepted = apply_normalizations(result, proposals, catalog)
    result_windows = []
    for raw, reviewed in zip(source.get("windows") or [], windows):
        result_windows.append({
            **raw,
            "rawRomanText": reviewed["rawRomanText"],
            "displayRomanText": reviewed.get("contextualNormalizedRomanText") or reviewed["selectedRomanText"],
            "semanticReview": reviewed["semanticReview"],
            "qualityState": reviewed["qualityState"],
            "qualityFlags": reviewed["qualityFlags"],
            "numericEvidence": reviewed["numericEvidence"],
            "contextualNormalizations": reviewed.get("contextualNormalizations", []),
        })

    output = {
        "schemaVersion": "contextual-recovery-v1",
        "source": str(args.source),
        "complete": bool(source.get("complete")),
        "manualOrLlmEditing": False,
        "meetingContext": args.meeting_context,
        "semanticReasoner": {
            "enabled": True,
            "model": reasoner.model,
            "authority": "classifies evidence only and never writes transcript text",
        },
        "contextualTermNormalization": {
            "enabled": True,
            "glossaryVersion": str(catalog.get("version") or "unversioned"),
            "proposalsReceived": len(proposals),
            "focusedAliasChecks": len(focused_packets),
            "normalizationsAccepted": accepted,
            "policy": "closed glossary, literal source span, model nomination and phonetic guard; raw ASR unchanged",
        },
        "windows": result_windows,
    }
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "windows": len(result_windows),
        "semanticReviews": len(semantic),
        "proposalsReceived": len(proposals),
        "normalizationsAccepted": accepted,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
