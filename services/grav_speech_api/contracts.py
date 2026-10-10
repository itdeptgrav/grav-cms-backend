"""Strict request validation without allowing callers to select models."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")


class ContractError(ValueError):
    pass


def _required_text(value: Any, field: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} is required")
    result = value.strip()
    if len(result) > maximum or not VALUE.fullmatch(result):
        raise ContractError(f"{field} is invalid")
    return result


def _audio_object(value: Any) -> str:
    result = _required_text(value, "source.audioObject", 512)
    if "://" in result or result.startswith(("/", "\\")):
        raise ContractError("source.audioObject must be a private relative object key")
    parts = result.replace("\\", "/").split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ContractError("source.audioObject contains an unsafe path segment")
    return result


@dataclass(frozen=True)
class Source:
    application: str
    kind: str
    source_id: str
    audio_object: str


@dataclass(frozen=True)
class CreateJob:
    source: Source
    diarization: bool
    idempotency_key: str


def parse_create_job(payload: Any) -> CreateJob:
    if not isinstance(payload, dict):
        raise ContractError("JSON object required")
    allowed = {"source", "features", "idempotencyKey"}
    extra = set(payload) - allowed
    if extra:
        raise ContractError(f"Unknown fields: {', '.join(sorted(extra))}")
    source = payload.get("source")
    if not isinstance(source, dict):
        raise ContractError("source is required")
    source_allowed = {"application", "kind", "id", "audioObject"}
    if set(source) - source_allowed:
        raise ContractError("source contains unknown fields")
    features = payload.get("features") or {}
    if not isinstance(features, dict):
        raise ContractError("features must be an object")
    feature_allowed = {"diarization"}
    if set(features) - feature_allowed:
        raise ContractError("features contains unknown fields")
    diarization = features.get("diarization", False)
    if not isinstance(diarization, bool):
        raise ContractError("features.diarization must be boolean")
    return CreateJob(
        source=Source(
            application=_required_text(source.get("application"), "source.application", 64),
            kind=_required_text(source.get("kind"), "source.kind", 64),
            source_id=_required_text(source.get("id"), "source.id"),
            audio_object=_audio_object(source.get("audioObject")),
        ),
        diarization=diarization,
        idempotency_key=_required_text(payload.get("idempotencyKey"), "idempotencyKey"),
    )
