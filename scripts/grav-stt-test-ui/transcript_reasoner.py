#!/usr/bin/env python3
"""Optional private semantic verifier for ASR utterances.

The verifier classifies evidence only.  It is forbidden from rewriting the raw
transcript or supplying replacement words.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request


SYSTEM_PROMPT = """You are a transcript evidence verifier, not an editor.
For every supplied utterance, use its surroundingRawTranscript and
meetingContext to classify the
raw ASR text as coherent, uncertain, or gibberish. An incomplete but plausible
backchannel is uncertain, not gibberish. Mixed Hindi-English or Odia-English is
normal. A candidateTranscript is another ASR decode of the same bounded audio;
you may select its id when one candidate is clearly more coherent in context.
The raw ASR candidate is the default. Do not select another candidate merely
because it is shorter, differently spelled, or acoustically similar. Select an
alternative only when it repairs a specific incoherent raw phrase and is
materially clearer in the supplied meeting context.
Check whether a business phrase makes semantic sense in its bounded meeting
context. If
an entity conflicts with a neighbouring candidate, or a phrase is implausible
for the business context, list the applicable semanticIssues and set
recoveryRequired true. DomainTerms are only hints for deciding whether to ask
for acoustic recovery: they are never transcript evidence and must never be
inserted into the transcript. A selectedCandidateId must always name an exact
ASR candidate supplied for this utterance.
If numericEvidence has a flag, classify the utterance uncertain unless one exact
candidate is independently supported; never infer a missing digit or quantity.
Never correct, translate, complete, combine, or invent transcript words.
Return strict JSON: {"reviews":[{"id":"...","state":"coherent|uncertain|gibberish","selectedCandidateId":"raw_turn_concat|contextual_redecode|null","semanticIssues":["business_phrase_incoherent|cross_span_entity_conflict|numeric_ambiguity"],"recoveryRequired":true,"reason":"short evidence-based reason"}]}.
Return one review for every input id and no other keys."""

ALLOWED_SEMANTIC_ISSUES = {
    "business_phrase_incoherent",
    "cross_span_entity_conflict",
    "numeric_ambiguity",
}


def _json_object(value: str) -> dict:
    value = value.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", value, re.DOTALL)
    if fenced:
        value = fenced.group(1)
    return json.loads(value)


class TranscriptReasoner:
    def __init__(self, domain_terms: list[str] | None = None) -> None:
        self.url = os.environ.get("GRAV_TRANSCRIPT_REASONER_URL", "").rstrip("/")
        self.key = os.environ.get("GRAV_TRANSCRIPT_REASONER_KEY", "")
        self.protocol = os.environ.get("GRAV_TRANSCRIPT_REASONER_PROTOCOL", "openai")
        self.model = os.environ.get("GRAV_TRANSCRIPT_REASONER_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
        self.timeout = float(os.environ.get("GRAV_TRANSCRIPT_REASONER_TIMEOUT_SECONDS", "30"))
        self.domain_terms = domain_terms if domain_terms is not None else _domain_terms(
            os.environ.get("GRAV_TRANSCRIPT_DOMAIN_TERMS", "")
        )

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def review(self, utterances: list[dict]) -> list[dict]:
        if not self.enabled or not utterances:
            return []
        if self.protocol == "grav-native":
            endpoint = "/v1/transcript-review"
            payload = {"utterances": utterances}
        else:
            endpoint = "/v1/chat/completions"
            payload = {
                "model": self.model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps({"utterances": utterances}, ensure_ascii=False)},
                ],
            }
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        request = urllib.request.Request(
            f"{self.url}{endpoint}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        # A locally-hosted model can take longer for one dense, code-switched
        # window.  A transient timeout must not discard a complete recording
        # after earlier windows were already reviewed.
        last_error: Exception | None = None
        body = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = json.loads(response.read().decode("utf-8"))
                break
            except (TimeoutError, urllib.error.URLError, urllib.error.HTTPError) as error:
                last_error = error
                # Client-side contract failures are deterministic; a 5xx from
                # the local model gateway is transient (for example, malformed
                # JSON from one decode) and is safe to retry unchanged.
                if isinstance(error, urllib.error.HTTPError) and error.code < 500:
                    raise
                if attempt == 2:
                    # A malformed multi-utterance completion is not evidence
                    # against the underlying audio. Split it into bounded
                    # single-window requests rather than dropping the entire
                    # transcript batch. A persistently failing single window
                    # remains raw and auditable.
                    if len(utterances) > 1:
                        reviews: list[dict] = []
                        for utterance in utterances:
                            reviews.extend(self.review([utterance]))
                        return reviews
                    return []
                time.sleep(attempt + 1)
        if body is None:
            raise RuntimeError("Transcript verifier returned no response") from last_error
        if self.protocol == "grav-native":
            parsed = body
        else:
            content = body["choices"][0]["message"]["content"]
            parsed = _json_object(content)
        reviews = parsed.get("reviews", [])
        allowed = {utterance["id"] for utterance in utterances}
        accepted = []
        for review in reviews:
            if review.get("id") not in allowed or review.get("state") not in {"coherent", "uncertain", "gibberish"}:
                continue
            review = dict(review)
            review["semanticIssues"] = [
                issue for issue in review.get("semanticIssues", [])
                if issue in ALLOWED_SEMANTIC_ISSUES
            ]
            review["recoveryRequired"] = bool(review.get("recoveryRequired", False))
            accepted.append(review)
        return accepted


def _domain_terms(value: str) -> list[str]:
    """Parse optional, tenant-controlled vocabulary without making it truth."""
    if not value.strip():
        return []
    try:
        parsed = json.loads(value)
        values = parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        values = value.split(",")
    return [str(term).strip() for term in values if str(term).strip()]


def reasoner_packets(
    windows: list[dict], batch_size: int = 8, selected_ids: set[str] | None = None,
    domain_terms: list[str] | None = None, context_radius: int = 3,
    meeting_context: str = "",
) -> list[list[dict]]:
    """Give the verifier bounded meeting context without sending the whole meeting."""
    packets: list[dict] = []
    for index, window in enumerate(windows):
        if selected_ids is not None and window["id"] not in selected_ids:
            continue
        packets.append({
            "id": window["id"],
            "speaker": window["speaker"],
            "startSeconds": window["startSeconds"],
            "endSeconds": window["endSeconds"],
            "rawRomanText": window["rawRomanText"],
            "candidateTranscripts": window.get("candidateTranscripts", []),
            "numericEvidence": window.get("numericEvidence", {}),
            "previousRawText": windows[index - 1]["rawRomanText"] if index else "",
            "nextRawText": windows[index + 1]["rawRomanText"] if index + 1 < len(windows) else "",
            "meetingContext": meeting_context,
            "surroundingRawTranscript": [
                {
                    "id": item["id"],
                    "speaker": item["speaker"],
                    "startSeconds": item["startSeconds"],
                    "endSeconds": item["endSeconds"],
                    "rawRomanText": item["rawRomanText"],
                }
                for item in windows[max(0, index - context_radius):min(len(windows), index + context_radius + 1)]
            ],
            # Timestamp-only consistency detection may attach compact literal
            # variants observed elsewhere.  This is context for evaluating an
            # existing ASR candidate, never replacement text to apply.
            "crossTranscriptEvidence": window.get("crossTranscriptEvidence", []),
            "deterministicFlags": window["qualityFlags"],
            "domainTerms": domain_terms or [],
        })
    return [packets[index:index + batch_size] for index in range(0, len(packets), batch_size)]

