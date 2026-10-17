#!/usr/bin/env python3
"""Build neutral, local ASR-lattice candidates from independently decoded audio.

This tool does not know product terms, entities, or preferred spellings.  It
aligns token sequences from the raw ASR window and independently decoded
versions of the same source audio.  Each candidate changes one bounded token
span only, so semantic review can choose an acoustically attested local change
without being forced to adopt an otherwise worse full-window decode.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path


TOKEN = re.compile(r"\S+")
MAX_EDIT_TOKENS = 6


def tokens(value: str) -> list[str]:
    return TOKEN.findall(value)


def make_lattice_candidates(
    raw: str, alternatives: list[dict], protected_phrases: set[str] | None = None,
) -> list[dict]:
    base = tokens(raw)
    protected_phrases = {phrase.casefold() for phrase in (protected_phrases or set())}
    # Respect the ASR model's own language-identification evidence when it is
    # decisive.  This is not a vocabulary rule: it only prevents a forced
    # language variant from outranking the model's better-supported acoustic
    # decode of the same audio.
    preferred = []
    for item in alternatives:
        topk = (item.get("modelLanguageDecision") or {}).get("topk") or []
        if not topk:
            continue
        top_lang, top_score = topk[0]
        runner_score = topk[1][1] if len(topk) > 1 else 0.0
        if item.get("forcedLanguage") == top_lang and top_score >= 0.2 and top_score >= runner_score * 2:
            preferred.append(item)
    if preferred:
        alternatives = preferred
    emitted: list[dict] = []
    seen = {" ".join(base).casefold()}
    for alternative in alternatives:
        variant = tokens(str(alternative.get("romanText") or ""))
        matcher = SequenceMatcher(None, [item.casefold() for item in base], [item.casefold() for item in variant], autojunk=False)
        compatible_edits: list[tuple[int, int, list[str]]] = []
        for ordinal, (kind, a0, a1, b0, b1) in enumerate(matcher.get_opcodes()):
            if kind == "equal" or not (a1 - a0 or b1 - b0):
                continue
            # Wide contexts often differ at their start/end.  A local recovery
            # candidate is only useful when both sides contain a small acoustic
            # span rather than a paragraph-scale rephrasing.
            if max(a1 - a0, b1 - b0) > MAX_EDIT_TOKENS:
                continue
            updated = base[:a0] + variant[b0:b1] + base[a1:]
            text = " ".join(updated)
            identity = text.casefold()
            if not text or identity in seen:
                continue
            seen.add(identity)
            evidence_match = any(
                phrase in identity and phrase not in raw.casefold()
                for phrase in protected_phrases
            )
            emitted.append({
                "id": f"lattice_{alternative['id']}_{ordinal}",
                "romanText": text,
                "source": "one aligned token span from an independently decoded source-audio candidate; no text was generated",
                "derivedFromCandidateId": alternative["id"],
                "audioStartSeconds": alternative.get("audioStartSeconds"),
                "audioEndSeconds": alternative.get("audioEndSeconds"),
                "crossTranscriptEvidenceMatch": evidence_match,
            })
            # Equal-sized, short substitutions can be applied together without
            # changing the surrounding segmentation.  This lets the reviewer
            # select repeated acoustic fixes from one decode as a single,
            # auditable lattice path rather than forcing a hand-authored patch.
            if a1 - a0 == b1 - b0 and 0 < a1 - a0 <= 2:
                compatible_edits.append((a0, a1, variant[b0:b1]))
        if 1 < len(compatible_edits) <= 6:
            updated = list(base)
            for a0, a1, replacement in reversed(compatible_edits):
                updated[a0:a1] = replacement
            text = " ".join(updated)
            identity = text.casefold()
            if text and identity not in seen:
                # A complete compatible path from this one ASR decode dominates
                # its individual partial paths.  Keeping those partial paths
                # makes a selector choose an arbitrary half-correction even
                # though the source audio supplied a consistent fuller path.
                emitted = [
                    item for item in emitted
                    if item.get("derivedFromCandidateId") != alternative["id"]
                    or item.get("crossTranscriptEvidenceMatch")
                ]
                seen.add(identity)
                emitted.append({
                    "id": f"lattice_bundle_{alternative['id']}",
                    "romanText": text,
                    "source": "compatible aligned token spans from one independently decoded source-audio candidate; no text was generated",
                    "derivedFromCandidateId": alternative["id"],
                    "audioStartSeconds": alternative.get("audioStartSeconds"),
                    "audioEndSeconds": alternative.get("audioEndSeconds"),
                    "crossTranscriptEvidenceMatch": any(
                        phrase in identity and phrase not in raw.casefold()
                        for phrase in protected_phrases
                    ),
                })
    return emitted


def main(
    reviewed_path: Path, decoded_path: Path, output_path: Path,
    consistency_plan_path: Path | None = None,
) -> None:
    reviewed = json.loads(reviewed_path.read_text(encoding="utf-8"))
    decoded = json.loads(decoded_path.read_text(encoding="utf-8"))
    alternatives = {item["id"]: item.get("candidates", []) for item in decoded.get("candidates", [])}
    evidence_by_id: dict[str, set[str]] = {}
    if consistency_plan_path:
        plan = json.loads(consistency_plan_path.read_text(encoding="utf-8"))
        for span in plan.get("spans", []):
            phrases = set()
            for evidence in span.get("evidence", []):
                phrases.add(str(evidence.get("leftPhrase") or ""))
                phrases.add(str(evidence.get("rightPhrase") or ""))
            evidence_by_id[str(span.get("id"))] = {phrase for phrase in phrases if phrase}
    lattice = []
    for window in reviewed["utteranceReviews"]:
        candidates = make_lattice_candidates(
            window["rawRomanText"], alternatives.get(window["id"], []),
            evidence_by_id.get(window["id"], set()),
        )
        if candidates:
            lattice.append({"id": window["id"], "candidates": candidates})
    output_path.write_text(json.dumps({
        "schemaVersion": "audio-lattice-candidates-v1",
        "candidates": lattice,
        "authority": "every replacement token originates from a same-source ASR candidate; no vocabulary or generated text is used",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"windows": len(lattice), "candidates": sum(len(item["candidates"]) for item in lattice)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reviewed_path", type=Path)
    parser.add_argument("decoded_path", type=Path)
    parser.add_argument("output_path", type=Path)
    parser.add_argument("--cross-window-plan", type=Path)
    args = parser.parse_args()
    main(args.reviewed_path, args.decoded_path, args.output_path, args.cross_window_plan)
