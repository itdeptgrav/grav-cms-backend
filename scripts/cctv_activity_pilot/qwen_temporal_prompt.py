"""Import the temporal Qwen prompt implementation used by pilot scripts."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_SOURCE = Path(__file__).parents[1] / "cctv-activity-pilot" / "qwen_temporal_prompt.py"
_SPEC = importlib.util.spec_from_file_location("cctv_activity_qwen_temporal_prompt", _SOURCE)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Could not load Qwen temporal prompt from {_SOURCE}")
_MODULE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)

PROMPT = _MODULE.PROMPT
PROMPT_VERSION = _MODULE.PROMPT_VERSION
build_contact_sheet = _MODULE.build_contact_sheet

__all__ = ["PROMPT", "PROMPT_VERSION", "build_contact_sheet"]
