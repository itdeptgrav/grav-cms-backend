#!/usr/bin/env python3
"""Meeting-aware, evidence-gated transcript repair.

This is intentionally not a domain glossary or a phrase-replacement system.
It first asks the private model to infer a temporary context model from the
meeting itself, then asks it to propose narrow repairs and a separate pass to
verify each proposal.  The raw ASR is always retained next to any accepted
revision so a reviewer can audit every change.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any


NUMBER_TOKEN = re.compile(r"(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w.])")
WORD_TOKEN = re.compile(r"[\w']+", re.UNICODE)


def post(base_url: str, api_key: str, path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    """Retry transient malformed model responses without changing the prompt."""
    last_error: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}{path}",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:800]
            last_error = RuntimeError(f"{path} returned HTTP {error.code}: {detail}")
            if error.code < 500 or attempt == 2:
                raise last_error from error
            time.sleep(attempt + 1)
    raise last_error or RuntimeError(f"{path} failed")


def words(text: str) -> list[str]:
    return [token.casefold() for token in WORD_TOKEN.findall(text)]


def numeric_tokens(text: str) -> list[str]:
    """Numbers may not be altered by an automatic semantic pass."""
    return NUMBER_TOKEN.findall(text)


def change_is_narrow(raw: str, revised: str) -> bool:
    """Reject paraphrases while allowing a few phonetic/ASR word repairs."""
    raw_words, revised_words = words(raw), words(revised)
    if not raw_words or not revised_words:
        return False
    # Context may disambiguate a word, but it may never complete a sentence
    # from the next overlapping ASR window. Automatic repair is substitution
    # only; insertions and deletions need a new bounded audio decode.
    if len(raw_words) != len(revised_words):
        return False
    if numeric_tokens(raw) != numeric_tokens(revised):
        return False
    # A repair must retain most of the utterance.  This accepts e.g. one
    # acoustically-confused business term but rejects regenerated summaries.
    ratio = difflib.SequenceMatcher(a=raw_words, b=revised_words).ratio()
    edits = sum(1 for opcode, i1, i2, j1, j2 in difflib.SequenceMatcher(
        a=raw_words, b=revised_words
    ).get_opcodes() if opcode != "equal")
    return ratio >= 0.72 and edits <= max(3, len(raw_words) // 4) and len(revised_words) <= len(raw_words) + 3


def spans_match_proposal(raw: str, revised: str, spans: Any) -> bool:
    """The model's declared edits must actually describe the returned text."""
    if not isinstance(spans, list):
        return False
    changed = False
    for span in spans:
        if not isinstance(span, dict):
            return False
        before = str(span.get("before", "")).strip()
        after = str(span.get("after", "")).strip()
        if not before or not after or before not in raw or after not in revised:
            return False
        if len(words(before)) != len(words(after)):
            return False
        changed = changed or before != after
    return changed


def compact_window(window: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": window["id"],
        "speaker": window.get("speaker", ""),
        "startSeconds": window.get("startSeconds"),
        "endSeconds": window.get("endSeconds"),
        "rawRomanText": window.get("rawRomanText", ""),
    }


def meeting_model(base_url: str, api_key: str, windows: list[dict[str, Any]], timeout: float) -> dict[str, Any]:
    """Map/reduce raw transcript so the model sees the full meeting without a huge prompt."""
    batches = [windows[index:index + 6] for index in range(0, len(windows), 6)]
    batch_models: list[dict[str, Any]] = []
    for index, batch in enumerate(batches, 1):
        result = post(base_url, api_key, "/v1/transcript-meeting-model", {
            "utterances": [compact_window(window) for window in batch],
        }, timeout)
        model = result.get("meetingModel")
        if not isinstance(model, dict):
            raise RuntimeError(f"Context map {index} did not return a meeting model")
        batch_models.append({"segment": index, "meetingModel": model})

    # A final model sees all independently derived evidence, not a selected
    # domain or any preconfigured vocabulary.
    def compact_model(model: dict[str, Any]) -> dict[str, Any]:
        # Preserve model evidence but bound the reduce prompt.  This is not a
        # glossary and never contributes replacement words on its own.
        return {
            "topic": str(model.get("topic", ""))[:300],
            "purpose": str(model.get("purpose", ""))[:300],
            "domainSignals": list(model.get("domainSignals", []))[:12],
            "workingVocabulary": list(model.get("workingVocabulary", []))[:24],
            "summary": str(model.get("summary", ""))[:700],
            "confidence": model.get("confidence", 0),
        }

    # The editing model consumes the evidence from every map segment directly.
    # This avoids asking a small model to serialise a second, lossy summary of
    # its own work.  It still has the meeting-wide evidence, while the raw ASR
    # remains the sole source for proposed wording.
    return {
        "model": {"segmentEvidence": [compact_model(item["meetingModel"]) for item in batch_models]},
        "segments": batch_models,
        "synthesis": "editor receives all segment evidence",
    }


def edit_packet(windows: list[dict[str, Any]], index: int) -> dict[str, Any]:
    window = windows[index]
    return {
        **compact_window(window),
        "candidateTranscripts": window.get("candidateTranscripts", []),
        "surroundingRawTranscript": [
            compact_window(item) for item in windows[max(0, index - 4):min(len(windows), index + 5)]
        ],
    }


def process(
    base_url: str, api_key: str, data: dict[str, Any], timeout: float, limit: int | None,
    edit_ids: set[str] | None = None, meeting_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output = copy.deepcopy(data)
    windows = output.get("utteranceReviews")
    if not isinstance(windows, list) or not windows:
        raise ValueError("Input must contain a non-empty utteranceReviews list")
    scoped = windows[:limit] if limit else windows
    context = meeting_context or meeting_model(base_url, api_key, scoped, timeout)
    accepted = 0
    audit: list[dict[str, Any]] = []

    for index, window in enumerate(scoped):
        if edit_ids is not None and window["id"] not in edit_ids:
            continue
        raw = str(window.get("rawRomanText", "")).strip()
        if not raw:
            continue
        packet = edit_packet(scoped, index)
        try:
            proposed = post(base_url, api_key, "/v1/transcript-context-edit", {
                "meetingModel": context["model"], "utterances": [packet],
            }, timeout).get("edits", [])
        except RuntimeError as error:
            audit.append({
                "id": window["id"], "rawRomanText": raw,
                "outcome": "model_response_unavailable", "error": str(error),
            })
            continue
        proposal = next((item for item in proposed if isinstance(item, dict) and item.get("id") == window["id"]), None)
        if not proposal:
            continue
        revised = str(proposal.get("revisedRomanText", "")).strip()
        confidence = float(proposal.get("confidence") or 0)
        record: dict[str, Any] = {
            "id": window["id"], "rawRomanText": raw, "proposedRomanText": revised,
            "proposalConfidence": confidence, "proposalReason": str(proposal.get("reason") or "")[:400],
            "changedSpans": proposal.get("changedSpans", []),
        }
        if revised == raw:
            record["outcome"] = "unchanged"
            audit.append(record)
            continue
        if (
            confidence < 0.82
            or not change_is_narrow(raw, revised)
            or not spans_match_proposal(raw, revised, proposal.get("changedSpans"))
        ):
            record["outcome"] = "rejected_by_local_guard"
            audit.append(record)
            continue

        try:
            verification = post(base_url, api_key, "/v1/transcript-context-verify", {
                "meetingModel": context["model"],
                "proposals": [{
                    **record, "surroundingRawTranscript": packet["surroundingRawTranscript"],
                }],
            }, timeout).get("verdicts", [])
        except RuntimeError as error:
            record["outcome"] = "verification_response_unavailable"
            record["error"] = str(error)
            audit.append(record)
            continue
        verdict = next((item for item in verification if isinstance(item, dict) and item.get("id") == window["id"]), {})
        record["verification"] = verdict
        verified_confidence = float(verdict.get("confidence") or 0)
        if verdict.get("accept") is True and verified_confidence >= 0.82:
            window["selectedRomanText"] = revised
            window["displayRomanText"] = revised
            window["contextualMeetingEdit"] = record
            record["outcome"] = "accepted"
            accepted += 1
        else:
            record["outcome"] = "rejected_by_verifier"
        audit.append(record)

    output["meetingAwareCorrection"] = {
        "architecture": "transcript-derived context model -> narrow proposal -> independent verification",
        "meetingModel": context,
        "acceptedEditCount": accepted,
        "audit": audit,
        "policy": "No fixed domain glossary, phrase replacement, or hardcoded meeting vocabulary was used.",
    }
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--profile-only", action="store_true")
    parser.add_argument(
        "--meeting-profile", type=Path,
        help="Previously generated read-only meeting-context JSON; avoids recomputing the context map.",
    )
    parser.add_argument(
        "--edit-ids",
        help="Comma-separated existing window IDs for a bounded evaluation; absent means review every window.",
    )
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    base_url = os.environ.get("GRAV_TRANSCRIPT_REASONER_URL", "").strip()
    api_key = os.environ.get("GRAV_TRANSCRIPT_REASONER_KEY", "").strip()
    if not base_url or not api_key:
        raise SystemExit("Set GRAV_TRANSCRIPT_REASONER_URL and GRAV_TRANSCRIPT_REASONER_KEY")
    windows = data.get("utteranceReviews", [])
    scoped = windows[:args.limit] if args.limit else windows
    if args.profile_only:
        result = {"meetingAwareCorrection": {"meetingModel": meeting_model(base_url, api_key, scoped, args.timeout)}}
    else:
        selected_ids = {item.strip() for item in (args.edit_ids or "").split(",") if item.strip()} or None
        prior_context = None
        if args.meeting_profile:
            profile = json.loads(args.meeting_profile.read_text())
            prior_context = profile.get("meetingAwareCorrection", {}).get("meetingModel")
            if not isinstance(prior_context, dict) or not isinstance(prior_context.get("model"), dict):
                raise ValueError("Meeting profile does not contain a usable meeting model")
        result = process(base_url, api_key, data, args.timeout, args.limit, selected_ids, prior_context)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "output": str(args.output),
        "windows": len(scoped),
        "acceptedEditCount": result.get("meetingAwareCorrection", {}).get("acceptedEditCount", 0),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
