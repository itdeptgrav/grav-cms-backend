#!/usr/bin/env python3
"""Deterministic temporal smoothing for the CCTV activity pilot."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
from typing import Iterable


LABELS = {
    "using_phone",
    "working",
    "talking_or_interacting",
    "no_observable_task",
    "uncertain",
}


@dataclass
class TrackState:
    emitted_label: str = "uncertain"
    candidate_label: str | None = None
    candidate_count: int = 0
    uncertain_count: int = 0


@dataclass(frozen=True)
class SmoothedDecision:
    track_id: int
    raw_label: str
    emitted_label: str
    decision_status: str
    supporting_windows: int

    def to_dict(self) -> dict:
        return asdict(self)


class TemporalPolicy:
    """Require repeated four-second-window decisions before changing a label.

    Qwen receives one four-frame contact sheet per tracked person. This class
    smooths the resulting once-per-second window decisions. It intentionally
    does not infer a label during the first incomplete four-second window.
    """

    def __init__(self, *, confirmations: int = 2, uncertain_hold: int = 2):
        if confirmations < 1:
            raise ValueError("confirmations must be at least 1")
        if uncertain_hold < 0:
            raise ValueError("uncertain_hold cannot be negative")
        self.confirmations = confirmations
        self.uncertain_hold = uncertain_hold
        self._states: dict[int, TrackState] = defaultdict(TrackState)

    def observe(self, track_id: int, raw_label: str, *, window_complete: bool) -> SmoothedDecision:
        if raw_label not in LABELS:
            raise ValueError(f"unknown activity label: {raw_label}")

        state = self._states[track_id]
        if not window_complete:
            return SmoothedDecision(track_id, raw_label, "uncertain", "warming_up", 0)

        if raw_label == "uncertain":
            state.candidate_label = None
            state.candidate_count = 0
            state.uncertain_count += 1
            if state.emitted_label != "uncertain" and state.uncertain_count <= self.uncertain_hold:
                return SmoothedDecision(
                    track_id,
                    raw_label,
                    state.emitted_label,
                    "held_during_uncertainty",
                    state.uncertain_count,
                )
            state.emitted_label = "uncertain"
            return SmoothedDecision(track_id, raw_label, "uncertain", "uncertain", state.uncertain_count)

        state.uncertain_count = 0
        if raw_label == state.emitted_label:
            state.candidate_label = None
            state.candidate_count = 0
            return SmoothedDecision(track_id, raw_label, state.emitted_label, "confirmed", self.confirmations)

        if raw_label == state.candidate_label:
            state.candidate_count += 1
        else:
            state.candidate_label = raw_label
            state.candidate_count = 1

        if state.candidate_count >= self.confirmations:
            state.emitted_label = raw_label
            state.candidate_label = None
            supporting = state.candidate_count
            state.candidate_count = 0
            return SmoothedDecision(track_id, raw_label, state.emitted_label, "changed", supporting)

        return SmoothedDecision(
            track_id,
            raw_label,
            state.emitted_label,
            "candidate",
            state.candidate_count,
        )

    def remove_missing_tracks(self, active_track_ids: Iterable[int]) -> None:
        active = set(active_track_ids)
        for track_id in list(self._states):
            if track_id not in active:
                del self._states[track_id]

