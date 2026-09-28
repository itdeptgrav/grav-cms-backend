"""Import the implementation kept in the operator-facing pilot directory."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_SOURCE = Path(__file__).parents[1] / "cctv-activity-pilot" / "temporal_policy.py"
_SPEC = importlib.util.spec_from_file_location("cctv_activity_temporal_policy", _SOURCE)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Could not load temporal policy from {_SOURCE}")
_MODULE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)

LABELS = _MODULE.LABELS
SmoothedDecision = _MODULE.SmoothedDecision
TemporalPolicy = _MODULE.TemporalPolicy
TrackState = _MODULE.TrackState

__all__ = ["LABELS", "SmoothedDecision", "TemporalPolicy", "TrackState"]
