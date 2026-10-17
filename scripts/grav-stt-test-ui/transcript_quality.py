#!/usr/bin/env python3
"""Evidence-preserving quality checks for speaker-labelled transcripts.

These checks never rewrite ASR output.  They decide whether a raw span is safe
to present as readable prose, needs another decode, or must remain visibly
uncertain.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict

WORD_RE = re.compile(r"[\w']+", re.UNICODE)
DIGIT_NUMBER_RE = re.compile(r"(?<![\w.])(-?\d+(?:,\d{3})*(?:\.\d+)?)(?![\w.])")
BARE_DECIMAL_RE = re.compile(r"\bpoint\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b", re.I)
WORD_DECIMAL_RE = re.compile(
    r"\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+point\s+"
    r"(zero|one|two|three|four|five|six|seven|eight|nine)\b", re.I
)
NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


def _words(text: str) -> list[str]:
    return [word.casefold() for word in WORD_RE.findall(text or "")]


def deterministic_flags(text: str, duration_seconds: float) -> list[str]:
    """Return reproducible warnings without guessing replacement words."""
    words = _words(text)
    flags: list[str] = []

    if duration_seconds < 0.8:
        flags.append("audio_span_too_short")
    if not words:
        flags.append("empty_transcript")
        return flags
    if duration_seconds < 1.5 and len(words) <= 1:
        flags.append("isolated_micro_utterance")

    word_rate = len(words) / max(duration_seconds, 0.1)
    if word_rate > 5.5:
        flags.append("implausible_word_rate")

    if len(words) >= 12:
        lexical_diversity = len(set(words)) / len(words)
        if lexical_diversity < 0.28:
            flags.append("low_lexical_diversity")

    if len(words) >= 12:
        fourgrams = [tuple(words[index:index + 4]) for index in range(len(words) - 3)]
        counts = Counter(fourgrams)
        repeated = sum(count - 1 for count in counts.values() if count > 1)
        if repeated / max(len(fourgrams), 1) >= 0.35:
            flags.append("decoder_repetition_loop")

    return flags


def numeric_evidence(candidates: list[dict]) -> dict:
    """Extract number evidence and conflicts without changing any transcript.

    A bare phrase such as ``point five`` is deliberately not silently promoted
    to ``one point five``.  It is an ambiguous acoustic claim until another ASR
    candidate or an authorised human establishes the missing whole number.
    """
    evidence: list[dict] = []
    all_flags: set[str] = set()
    canonical_sets: list[set[str]] = []
    for candidate in candidates:
        text = str(candidate.get("romanText", ""))
        values: list[str] = []
        flags: list[str] = []
        for match in DIGIT_NUMBER_RE.findall(text):
            values.append(str(float(match.replace(",", ""))).rstrip("0").rstrip("."))
        for whole, decimal in WORD_DECIMAL_RE.findall(text):
            values.append(f"{NUMBER_WORDS[whole.casefold()]}.{NUMBER_WORDS[decimal.casefold()]}")
        for match in BARE_DECIMAL_RE.finditer(text):
            preceding = text[:match.start()].strip().casefold().split()
            # Do not misclassify the tail of "one point five" as a bare value.
            if preceding and preceding[-1] in NUMBER_WORDS:
                continue
            flags.append("ambiguous_bare_decimal")
            values.append(f"0.{NUMBER_WORDS[match.group(1).casefold()]}")
        evidence.append({"candidateId": candidate.get("id"), "values": sorted(set(values)), "flags": flags})
        canonical_sets.append(set(values))
        all_flags.update(flags)

    populated = [values for values in canonical_sets if values]
    if len(populated) >= 2 and any(values != populated[0] for values in populated[1:]):
        all_flags.add("numeric_candidate_conflict")

    return {
        "candidates": evidence,
        "flags": sorted(all_flags),
        "safeForStructuredFacts": not all_flags,
    }


def add_speaker_evidence(turns: list[dict]) -> dict[str, dict]:
    """Attach channel-support warnings; a diarizer channel is not an identity."""
    totals: dict[str, dict] = defaultdict(lambda: {"turnCount": 0, "durationSeconds": 0.0})
    for turn in turns:
        evidence = totals[turn["speaker"]]
        evidence["turnCount"] += 1
        evidence["durationSeconds"] += float(turn["durationSeconds"])

    for speaker, evidence in totals.items():
        evidence["durationSeconds"] = round(evidence["durationSeconds"], 3)
        evidence["reliableChannel"] = not (
            evidence["turnCount"] <= 1 or evidence["durationSeconds"] < 2.0
        )

    for turn in turns:
        if not totals[turn["speaker"]]["reliableChannel"]:
            turn.setdefault("qualityFlags", []).append("speaker_channel_weak_evidence")
            turn["qualityState"] = "uncertain"
    return dict(totals)


def build_utterance_windows(
    turns: list[dict], *, maximum_gap_seconds: float = 2.0, maximum_duration_seconds: float = 18.0
) -> list[dict]:
    """Group context for judging meaning without erasing raw turn boundaries."""
    windows: list[dict] = []
    current: dict | None = None
    for turn in turns:
        if current is not None:
            gap = float(turn["startSeconds"]) - float(current["endSeconds"])
            combined_duration = float(turn["endSeconds"]) - float(current["startSeconds"])
            can_extend = (
                turn["speaker"] == current["speaker"]
                and 0 <= gap <= maximum_gap_seconds
                and combined_duration <= maximum_duration_seconds
            )
        else:
            can_extend = False

        if not can_extend:
            if current is not None:
                windows.append(current)
            current = {
                "id": f"utterance-{len(windows) + 1:04d}",
                "speaker": turn["speaker"],
                "startSeconds": turn["startSeconds"],
                "endSeconds": turn["endSeconds"],
                "turnIndexes": [turn["index"]],
                "rawRomanText": turn.get("rawRomanText", ""),
                "qualityFlags": list(turn.get("qualityFlags", [])),
            }
            continue

        current["endSeconds"] = turn["endSeconds"]
        current["turnIndexes"].append(turn["index"])
        current["rawRomanText"] = " ".join(
            part for part in (current["rawRomanText"], turn.get("rawRomanText", "")) if part
        )
        current["qualityFlags"].extend(turn.get("qualityFlags", []))

    if current is not None:
        windows.append(current)

    for window in windows:
        duration = float(window["endSeconds"]) - float(window["startSeconds"])
        window["qualityFlags"] = sorted(set(
            window["qualityFlags"] + deterministic_flags(window["rawRomanText"], duration)
        ))
        window["qualityState"] = "uncertain" if window["qualityFlags"] else "unverified"
    return windows

