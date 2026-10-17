"""Auditable, glossary-only contextual transcript normalisation.

This is deliberately not an LLM transcript rewriter.  A model can nominate an
existing glossary id for one literal raw phrase after reading broader meeting
context.  This module accepts that nomination only when deterministic evidence
also supports it, then writes a separate readable-view annotation.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import re
from typing import Any


WORDISH = re.compile(r"[^a-z0-9]+", re.IGNORECASE)
FORBIDDEN_TERM_TYPES = {
    "amount", "date", "dimension", "identifier", "name", "number", "quantity",
}


def _key(value: str) -> str:
    return WORDISH.sub("", value.casefold())


def phonetic_score(raw_phrase: str, term: dict[str, Any]) -> float:
    """Return best conservative character/alias similarity for a catalog term."""
    raw = _key(raw_phrase)
    choices = [str(term.get("canonicalText") or ""), *term.get("aliases", [])]
    return max((SequenceMatcher(None, raw, _key(choice)).ratio() for choice in choices if _key(choice)), default=0.0)


def term_index(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(term["id"]): term for term in catalog.get("terms", [])
        if isinstance(term, dict) and term.get("id") and term.get("canonicalText")
    }


def wider_context_packet(
    windows: list[dict[str, Any]], index: int, catalog: dict[str, Any], *, radius: int = 4,
    meeting_context: str = "",
) -> dict[str, Any]:
    """Prepare a bounded approximately 2-4 minute context horizon for Qwen."""
    target = windows[index]
    start = max(0, index - radius)
    end = min(len(windows), index + radius + 1)
    surrounding = []
    for item in windows[start:end]:
        surrounding.append({
            "id": item["id"],
            "startSeconds": item.get("startSeconds"),
            "endSeconds": item.get("endSeconds"),
            "speaker": item.get("speaker"),
            "rawRomanText": item.get("selectedRomanText") or item.get("rawRomanText") or "",
        })
    terms = [
        {"id": term["id"], "canonicalText": term["canonicalText"], "type": term.get("type", "domain_term"),
         "aliases": term.get("aliases", [])}
        for term in term_index(catalog).values()
    ]
    return {
        "id": target["id"],
        "targetRawText": target.get("selectedRomanText") or target.get("rawRomanText") or "",
        "meetingContext": meeting_context,
        "surroundingTranscript": surrounding,
        "termCatalog": terms,
    }


def validate_proposal(
    window: dict[str, Any], proposal: dict[str, Any], catalog: dict[str, Any], *,
    minimum_confidence: float = 0.78, minimum_phonetic_score: float = 0.70,
) -> dict[str, Any] | None:
    """Accept only closed-catalog, literal-span, non-structured corrections."""
    terms = term_index(catalog)
    term = terms.get(str(proposal.get("canonicalTermId") or ""))
    if not term or str(term.get("type", "domain_term")) in FORBIDDEN_TERM_TYPES:
        return None
    try:
        confidence = float(proposal.get("confidence", 0))
    except (TypeError, ValueError):
        return None
    if confidence < minimum_confidence:
        return None
    raw_text = str(window.get("selectedRomanText") or window.get("rawRomanText") or "")
    raw_phrase = str(proposal.get("rawPhrase") or "").strip()
    if not raw_phrase or not re.search(re.escape(raw_phrase), raw_text, re.IGNORECASE):
        return None
    score = phonetic_score(raw_phrase, term)
    if score < minimum_phonetic_score:
        return None
    return {
        "rawPhrase": raw_phrase,
        "canonicalTermId": term["id"],
        "canonicalText": term["canonicalText"],
        "termType": term.get("type", "domain_term"),
        "glossaryVersion": str(catalog.get("version") or "unversioned"),
        "confidence": round(confidence, 3),
        "phoneticScore": round(score, 3),
        "reason": str(proposal.get("reason") or "")[:240],
    }


def apply_normalizations(result: dict[str, Any], proposals: list[dict[str, Any]], catalog: dict[str, Any]) -> int:
    """Add enhanced display fields while retaining raw and ASR candidate fields."""
    by_id = {str(item.get("id")): item for item in result.get("utteranceReviews", [])}
    accepted = 0
    for proposal in proposals:
        window = by_id.get(str(proposal.get("id") or ""))
        if not window:
            continue
        normalized = validate_proposal(window, proposal, catalog)
        if not normalized:
            continue
        # Multiple independently validated aliases can occur in one window.
        # Apply each proposal to the already-derived display text, while every
        # validation above continues to use the immutable raw ASR evidence.
        source = str(
            window.get("contextualNormalizedRomanText")
            or window.get("selectedRomanText")
            or window.get("rawRomanText")
            or ""
        )
        enhanced, replacements = re.subn(
            re.escape(normalized["rawPhrase"]), normalized["canonicalText"], source,
            count=1, flags=re.IGNORECASE,
        )
        if replacements != 1:
            continue
        window.setdefault("contextualNormalizations", []).append(normalized)
        window["contextualNormalizedRomanText"] = enhanced
        accepted += 1
    if accepted:
        result["contextualTermNormalization"] = {
            "enabled": True,
            "normalizationsAccepted": accepted,
            "policy": "closed glossary ids plus literal-span and phonetic validation; raw ASR unchanged",
            "glossaryVersion": str(catalog.get("version") or "unversioned"),
        }
    return accepted
