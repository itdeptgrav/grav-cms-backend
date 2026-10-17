#!/usr/bin/env python3
"""Create an auditable enhanced transcript view from closed glossary terms."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import urllib.request

from contextual_terms import apply_normalizations, wider_context_packet


def request_proposals(packets: list[dict]) -> list[dict]:
    url = os.environ.get("GRAV_TRANSCRIPT_REASONER_URL", "").rstrip("/")
    key = os.environ.get("GRAV_TRANSCRIPT_REASONER_KEY", "")
    if not url:
        raise RuntimeError("GRAV_TRANSCRIPT_REASONER_URL is not configured")
    request = urllib.request.Request(
        f"{url}/v1/transcript-term-normalize",
        data=json.dumps({"packets": packets}, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return list(json.loads(response.read().decode("utf-8")).get("proposals", []))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("catalog", type=Path, help="versioned tenant-owned JSON term catalog")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--meeting-context", default="")
    parser.add_argument("--radius", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=6)
    args = parser.parse_args()

    result = json.loads(args.source.read_text(encoding="utf-8"))
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    windows = result.get("utteranceReviews", [])
    packets = [
        wider_context_packet(windows, index, catalog, radius=args.radius, meeting_context=args.meeting_context)
        for index in range(len(windows))
    ]
    proposals = []
    for start in range(0, len(packets), args.batch_size):
        proposals.extend(request_proposals(packets[start:start + args.batch_size]))
    accepted = apply_normalizations(result, proposals, catalog)
    result["contextualTermNormalization"] = {
        **result.get("contextualTermNormalization", {}),
        "enabled": True,
        "proposalsReceived": len(proposals),
        "normalizationsAccepted": accepted,
        "meetingContext": args.meeting_context,
    }
    args.destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"proposalsReceived": len(proposals), "accepted": accepted}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
