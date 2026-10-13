"""HMAC workload authentication shared by the API and CMS client."""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass


class AuthenticationError(ValueError):
    pass


@dataclass(frozen=True)
class WorkloadIdentity:
    service: str
    company_id: str


def canonical_message(
    method: str,
    path: str,
    timestamp: str,
    service: str,
    company_id: str,
    body: bytes,
) -> bytes:
    digest = hashlib.sha256(body).hexdigest()
    return "\n".join(
        [method.upper(), path, timestamp, service, company_id, digest]
    ).encode("utf-8")


def sign(
    secret: str,
    method: str,
    path: str,
    timestamp: str,
    service: str,
    company_id: str,
    body: bytes,
) -> str:
    value = hmac.new(
        secret.encode("utf-8"),
        canonical_message(method, path, timestamp, service, company_id, body),
        hashlib.sha256,
    ).hexdigest()
    return f"v1={value}"


def verify(
    *,
    secret: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: str | None,
    service: str | None,
    company_id: str | None,
    signature: str | None,
    now: int | None = None,
    tolerance_seconds: int = 300,
) -> WorkloadIdentity:
    if not secret:
        raise AuthenticationError("GRAV_SPEECH_SHARED_SECRET is not configured")
    if not timestamp or not service or not company_id or not signature:
        raise AuthenticationError("Missing GRAV Speech workload headers")
    if not service.replace("-", "").replace("_", "").isalnum():
        raise AuthenticationError("Invalid workload service")
    if len(company_id) > 128 or any(ch.isspace() for ch in company_id):
        raise AuthenticationError("Invalid company identity")
    try:
        issued_at = int(timestamp)
    except ValueError as error:
        raise AuthenticationError("Invalid workload timestamp") from error
    current = int(time.time()) if now is None else now
    if abs(current - issued_at) > tolerance_seconds:
        raise AuthenticationError("Expired workload signature")
    expected = sign(secret, method, path, timestamp, service, company_id, body)
    if not hmac.compare_digest(expected, signature):
        raise AuthenticationError("Invalid workload signature")
    return WorkloadIdentity(service=service, company_id=company_id)
