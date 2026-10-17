#!/usr/bin/env python3
"""Find compact near-duplicate phrases that deserve source-audio recovery.

The detector intentionally produces timestamps, never suggested transcript
text.  It looks for two-word phrases occurring in different transcript windows
where one token is identical and the other differs by a small spelling edit.
Such pairs are common ASR failure signatures: the clearer occurrence gives the
reviewer context, but the original audio must still supply the replacement.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path


WORD = re.compile(r"[^\W_]+", re.UNICODE)


def normalise_words(text: str) -> list[str]:
    return [word.casefold() for word in WORD.findall(text or "")]


def edit_distance_at_most_one(left: str, right: str) -> bool:
    """Return whether two tokens differ by one insertion, deletion or swap."""
    if left == right or abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right)) == 1
    if len(left) > len(right):
        left, right = right, left
    index = 0
    while index < len(left) and left[index] == right[index]:
        index += 1
    return left[index:] == right[index + 1:]


def consonant_skeleton(token: str) -> str:
    """A lightweight spelling-independent phonetic proxy for romanised speech.

    Romanised ASR regularly varies vowel spelling (for example a short spoken
    syllable versus an English-looking spelling).  We use this only to *flag*
    a source-audio recovery opportunity; it never supplies a replacement.
    """
    value = token.casefold()
    # In ordinary Latin spellings, terminal "aw"/"ow" often represents one
    # vowel sound (rather than a pronounced final consonant).  Treating that
    # spelling as one vowel keeps this detector useful for ASR romanisation
    # without asserting what the word should be.
    value = re.sub(r"[aeiouy]w$", "", value)
    return re.sub(r"[aeiouy]+", "", value)


def near_spoken_variant(left: str, right: str) -> bool:
    if edit_distance_at_most_one(left, right):
        return True
    left_skeleton, right_skeleton = consonant_skeleton(left), consonant_skeleton(right)
    return bool(left_skeleton) and left_skeleton == right_skeleton


def main(source: Path, destination: Path) -> None:
    reviewed = json.loads(source.read_text(encoding="utf-8"))
    windows = list(reviewed.get("utteranceReviews", []))
    phrases: list[dict] = []
    for index, window in enumerate(windows):
        words = normalise_words(str(window.get("selectedRomanText") or window.get("rawRomanText") or ""))
        seen = set()
        for ordinal in range(len(words) - 1):
            pair = tuple(words[ordinal:ordinal + 2])
            if pair not in seen:
                phrases.append({"windowIndex": index, "pair": pair})
                seen.add(pair)

    # Index only the shared side of a two-token phrase.  The other token is
    # compared by edit distance; no vocabulary, tenant terms or topic hints are
    # used here.
    shared: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for phrase in phrases:
        first, second = phrase["pair"]
        if len(second) >= 4:
            shared[(0, second)].append(phrase)
        if len(first) >= 4:
            shared[(1, first)].append(phrase)

    flagged: dict[int, list[dict]] = defaultdict(list)
    for (changing_position, anchor), group in shared.items():
        for left_index, left in enumerate(group):
            for right in group[left_index + 1:]:
                if left["windowIndex"] == right["windowIndex"]:
                    continue
                differing_left = left["pair"][changing_position]
                differing_right = right["pair"][changing_position]
                if not near_spoken_variant(differing_left, differing_right):
                    continue
                evidence = {
                    "type": "cross_window_near_variant",
                    "sharedToken": anchor,
                    "leftPhrase": " ".join(left["pair"]),
                    "rightPhrase": " ".join(right["pair"]),
                    "otherWindowId": windows[right["windowIndex"]]["id"],
                }
                flagged[left["windowIndex"]].append(evidence)
                flagged[right["windowIndex"]].append({
                    **evidence,
                    "otherWindowId": windows[left["windowIndex"]]["id"],
                })

    plan = []
    for index, window in enumerate(windows):
        if index not in flagged:
            continue
        plan.append({
            "id": window["id"],
            "startSeconds": window["startSeconds"],
            "endSeconds": window["endSeconds"],
            "recoveryReason": "cross-transcript spelling-variant evidence",
            "evidence": flagged[index],
        })
    destination.write_text(json.dumps({
        "schemaVersion": "cross-window-recovery-plan-v1",
        "spans": plan,
        "authority": "timestamp-only detector; it never proposes or applies transcript wording",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"spans": len(plan), "variantPairs": sum(len(item["evidence"]) for item in plan) // 2}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
