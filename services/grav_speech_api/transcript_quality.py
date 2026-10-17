"""Evidence-only transcript quality and semantic recovery helpers.

These helpers never author or replace transcript text.  They decide which
bounded audio must be decoded again and may select only a recorded ASR result.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request


WORD_RE = re.compile(r"[\w']+", re.UNICODE)
ALLOWED_ISSUES = {"business_phrase_incoherent", "cross_span_entity_conflict", "numeric_ambiguity"}
SYSTEM_PROMPT = """You verify ASR evidence, not edit a transcript. Use bounded
meeting context (surrounding transcript plus a meeting profile when present) to
classify each utterance coherent, uncertain, or gibberish. Flag a
business phrase that makes no sense in context, or an entity that conflicts
with neighbouring ASR evidence. Domain terms are recovery hints only, never
words to insert. You may select only an exact candidateTranscript id. Never
translate, complete or invent words. Return JSON only: {\"reviews\":[{\"id\":\"...\",\"state\":\"coherent|uncertain|gibberish\",\"selectedCandidateId\":null,\"semanticIssues\":[\"business_phrase_incoherent|cross_span_entity_conflict|numeric_ambiguity\"],\"recoveryRequired\":true,\"reason\":\"...\"}]}"""


def flags(text: str, duration: float) -> list[str]:
    words = [value.casefold() for value in WORD_RE.findall(text or "")]
    result: list[str] = []
    if duration < 0.8:
        result.append("audio_span_too_short")
    if not words:
        return result + ["empty_transcript"]
    if duration < 1.5 and len(words) <= 1:
        result.append("isolated_micro_utterance")
    if len(words) / max(duration, 0.1) > 5.5:
        result.append("implausible_word_rate")
    if len(words) >= 12 and len(set(words)) / len(words) < 0.28:
        result.append("low_lexical_diversity")
    return result


def windows(turns: list[dict]) -> list[dict]:
    """Group adjacent same-speaker turns for review while retaining originals."""
    result: list[dict] = []
    current = None
    for turn in turns:
        gap = float(turn["startSeconds"]) - float(current["endSeconds"]) if current else 999
        combined = float(turn["endSeconds"]) - float(current["startSeconds"]) if current else 999
        if not current or turn["speaker"] != current["speaker"] or gap > 2 or combined > 18:
            if current:
                result.append(current)
            current = {"id": f"utterance-{len(result)+1:04d}", "speaker": turn["speaker"],
                       "startSeconds": turn["startSeconds"], "endSeconds": turn["endSeconds"],
                       "turnIndexes": [turn["index"]], "rawRomanText": turn["rawRomanText"],
                       "qualityFlags": list(turn["qualityFlags"])}
        else:
            current["endSeconds"] = turn["endSeconds"]
            current["turnIndexes"].append(turn["index"])
            current["rawRomanText"] += " " + turn["rawRomanText"]
            current["qualityFlags"].extend(turn["qualityFlags"])
    if current:
        result.append(current)
    for item in result:
        item["qualityFlags"] = sorted(set(item["qualityFlags"] + flags(
            item["rawRomanText"], float(item["endSeconds"]) - float(item["startSeconds"])
        )))
    return result


def deoverlap_presentation(reviews: list[dict], *, minimum_words: int = 3, maximum_words: int = 18) -> None:
    """Derive display text without repeating an adjacent contextual decode.

    Contextual recovery intentionally expands audio on both sides of a turn.
    It can therefore contain the exact last words presented by the preceding
    turn.  The evidence candidates must stay untouched for audit; this adds a
    separate presentation field and removes only an exact, normalised
    word-boundary suffix/prefix overlap.
    """
    previous_words: list[str] = []
    for review in reviews:
        source = str(review.get("selectedRomanText") or "").strip()
        words = source.split()
        normalised_previous = [re.sub(r"[^\\w']+", "", word.casefold()) for word in previous_words]
        normalised_current = [re.sub(r"[^\\w']+", "", word.casefold()) for word in words]
        overlap = 0
        for length in range(min(len(normalised_previous), len(normalised_current), maximum_words), minimum_words - 1, -1):
            if normalised_previous[-length:] == normalised_current[:length]:
                overlap = length
                break
        review["presentationRomanText"] = " ".join(words[overlap:])
        review["presentationOverlapRemovedWords"] = overlap
        # Preserve the untrimmed selected candidate as evidence and use it to
        # compare later windows, so a chain of overlap never hides words.
        previous_words.extend(words)


class SemanticReasoner:
    def __init__(self) -> None:
        self.url = os.environ.get("GRAV_TRANSCRIPT_REASONER_URL", "").rstrip("/")
        self.key = os.environ.get("GRAV_TRANSCRIPT_REASONER_KEY", "")
        raw_terms = os.environ.get("GRAV_TRANSCRIPT_DOMAIN_TERMS", "")
        self.domain_terms = [term.strip() for term in raw_terms.split(",") if term.strip()]
        self.model = os.environ.get("GRAV_TRANSCRIPT_REASONER_MODEL", "Qwen/Qwen3-4B-Instruct-2507")

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def review(self, items: list[dict], meeting_context: str = "", context_radius: int = 3) -> dict[str, dict]:
        if not self.enabled or not items:
            return {}
        payload_items = []
        for index, item in enumerate(items):
            payload_items.append({
                "id": item["id"], "rawRomanText": item["rawRomanText"],
                "candidateTranscripts": item.get("candidateTranscripts", []),
                "previousRawText": items[index - 1]["rawRomanText"] if index else "",
                "nextRawText": items[index + 1]["rawRomanText"] if index + 1 < len(items) else "",
                "meetingContext": meeting_context,
                "surroundingRawTranscript": [{
                    "id": neighbour["id"], "speaker": neighbour["speaker"],
                    "startSeconds": neighbour["startSeconds"], "endSeconds": neighbour["endSeconds"],
                    "rawRomanText": neighbour["rawRomanText"],
                } for neighbour in items[max(0, index - context_radius):min(len(items), index + context_radius + 1)]],
                "deterministicFlags": item["qualityFlags"], "domainTerms": self.domain_terms,
            })
        request = urllib.request.Request(
            f"{self.url}/v1/transcript-review",
            data=json.dumps({"utterances": payload_items}).encode(),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {self.key}"} if self.key else {})},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            parsed = json.loads(response.read())
        valid = {item["id"] for item in items}
        return {review["id"]: {**review, "semanticIssues": [issue for issue in review.get("semanticIssues", []) if issue in ALLOWED_ISSUES]}
                for review in parsed.get("reviews", [])
                if review.get("id") in valid and review.get("state") in {"coherent", "uncertain", "gibberish"}}
