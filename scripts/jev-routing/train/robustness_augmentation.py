"""Build frozen, training-only semantic paraphrase rows for Jev.

The language model that proposes paraphrases is never allowed to assign a
label.  Every label, option list and target is copied from the source row, and
only train-view rows may be used.  Teacher output is accepted only when it is
bound to immutable model/prompt revisions and an independent semantic judge
has approved it.  Locked rows are deliberately not an input to this module.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path


ALLOWED_SOURCE_SPLITS = {"train", "validation"}
LOCKED_SPLITS = {"test", "ood"}
FORBIDDEN_TEACHER_DECISION_KEYS = {
    "gold",
    "label",
    "labels",
    "options",
    "reason",
    "route",
    "target",
}
SPEC_KEYS = {
    "schema", "seed", "source_train_view_manifest_sha256", "source_splits",
    "teacher", "judge", "validation_role", "locked_rows_read", "minimum_acceptance_rate",
}
MODEL_KEYS = {"model", "revision", "prompt", "prompt_sha256", "do_sample", "max_new_tokens"}


def canonical_sha256(value) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def load_augmentation_spec(path) -> dict:
    """Load the immutable teacher/judge contract and verify prompt bytes."""
    spec_path = Path(path).resolve()
    spec = json.loads(spec_path.read_text())
    if set(spec) != SPEC_KEYS:
        raise ValueError("augmentation spec keys differ from the closed schema")
    if spec["schema"] != "grav.jev.semantic-augmentation/1":
        raise ValueError("unsupported augmentation spec schema")
    if spec["source_splits"] != ["train", "validation"] or spec["locked_rows_read"] is not False:
        raise ValueError("augmentation spec may use only train and validation, never locked rows")
    if spec["validation_role"] != "proxy_ood_only":
        raise ValueError("validation paraphrases must remain a separate proxy-OOD view")
    if type(spec["seed"]) is not int or spec["seed"] < 0:
        raise ValueError("augmentation seed must be a non-negative integer")
    if not isinstance(spec["minimum_acceptance_rate"], (int, float)) or not 0.5 <= spec["minimum_acceptance_rate"] <= 1:
        raise ValueError("minimum_acceptance_rate must be between 0.5 and 1")
    if not re.fullmatch(r"[0-9a-f]{64}", spec["source_train_view_manifest_sha256"]):
        raise ValueError("source training-view manifest must be pinned by SHA-256")
    for role in ("teacher", "judge"):
        model = spec[role]
        if set(model) != MODEL_KEYS:
            raise ValueError(f"{role} keys differ from the closed schema")
        if not isinstance(model["model"], str) or not re.fullmatch(r"[0-9a-f]{40}", model["revision"]):
            raise ValueError(f"{role} model and immutable revision are required")
        if model["do_sample"] is not False:
            raise ValueError(f"{role} must use deterministic greedy decoding")
        if type(model["max_new_tokens"]) is not int or not 1 <= model["max_new_tokens"] <= 256:
            raise ValueError(f"{role} max_new_tokens is invalid")
        prompt = (spec_path.parent.parent / model["prompt"]).resolve()
        prompt.relative_to(spec_path.parent.parent)
        if hashlib.sha256(prompt.read_bytes()).hexdigest() != model["prompt_sha256"]:
            raise ValueError(f"{role} prompt bytes differ from the pinned SHA-256")
    if (spec["teacher"]["model"], spec["teacher"]["revision"]) == (
        spec["judge"]["model"], spec["judge"]["revision"]
    ):
        raise ValueError("teacher and judge must be independently pinned")
    return spec


def utterance_key(row: dict) -> str:
    """Return the stable rendered-utterance prefix shared by route/arg rows."""
    row_id = row.get("id")
    if not isinstance(row_id, str):
        raise ValueError("every source row requires a string id")
    match = re.match(r"^(.*?):(?:route|arg):", row_id)
    if not match:
        raise ValueError(f"row id has no route/arg boundary: {row_id}")
    return match.group(1)


def question_of(row: dict) -> str:
    state = row.get("state")
    question = state.get("question") if isinstance(state, dict) else None
    if not isinstance(question, str) or not question.strip():
        raise ValueError("every source row requires state.question")
    return question.strip()


def protected_tokens(text: str) -> tuple[str, ...]:
    """Protect numbers and explicit dates; the teacher may not alter facts."""
    return tuple(re.findall(r"\b\d[\d,./:-]*\b", text))


def build_augmented_rows(
    source_rows: list[dict],
    teacher_records: list[dict],
    *,
    teacher_model: str,
    teacher_revision: str,
    judge_model: str,
    judge_revision: str,
    generation_prompt_sha256: str,
    judge_prompt_sha256: str,
) -> list[dict]:
    """Return deterministic paraphrase rows, failing closed on provenance.

    ``teacher_records`` contain no labels.  A record names an utterance key,
    the SHA-256 of its exact source question, one paraphrase, immutable teacher
    and judge identities, prompt hashes, and ``judge_passed: true``.
    """
    groups: dict[str, list[dict]] = defaultdict(list)
    seen_source_questions: dict[str, str] = {}
    for row in source_rows:
        split = row.get("split")
        if split in LOCKED_SPLITS or split not in ALLOWED_SOURCE_SPLITS:
            raise ValueError(f"augmentation source split is forbidden: {split}")
        key = utterance_key(row)
        question = question_of(row)
        previous = seen_source_questions.setdefault(key, question)
        if previous != question:
            raise ValueError(f"utterance group has inconsistent questions: {key}")
        groups[key].append(row)

    expected = {
        "teacher_model": teacher_model,
        "teacher_revision": teacher_revision,
        "judge_model": judge_model,
        "judge_revision": judge_revision,
        "generation_prompt_sha256": generation_prompt_sha256,
        "judge_prompt_sha256": judge_prompt_sha256,
    }
    if teacher_model == judge_model and teacher_revision == judge_revision:
        raise ValueError("teacher and semantic judge must be independently pinned")
    if any(not isinstance(v, str) or len(v.strip()) < 8 for v in expected.values()):
        raise ValueError("teacher, judge and prompt identities must be pinned")

    source_norm = {question_of(row).casefold().strip() for row in source_rows}
    emitted_norm: set[str] = set()
    output: list[dict] = []
    for record in sorted(teacher_records, key=lambda r: (str(r.get("source_key")), str(r.get("paraphrase")))):
        forbidden = FORBIDDEN_TEACHER_DECISION_KEYS.intersection(record)
        if forbidden:
            raise ValueError(
                "teacher records may provide language only, not decision fields: "
                + ", ".join(sorted(forbidden))
            )
        if any(record.get(k) != v for k, v in expected.items()):
            raise ValueError("teacher record provenance does not match the pinned experiment")
        if record.get("judge_passed") is not True:
            raise ValueError("semantic judge did not approve the paraphrase")
        key = record.get("source_key")
        if key not in groups:
            raise ValueError(f"teacher record references an unknown train-view utterance: {key}")
        source_question = seen_source_questions[key]
        if record.get("source_question_sha256") != canonical_sha256(source_question):
            raise ValueError("teacher record is not bound to the exact source question")
        paraphrase = record.get("paraphrase")
        if not isinstance(paraphrase, str) or not paraphrase.strip():
            raise ValueError("teacher paraphrase must be non-empty text")
        paraphrase = " ".join(paraphrase.split())
        norm = paraphrase.casefold()
        if norm in source_norm or norm in emitted_norm:
            raise ValueError("duplicate or unchanged paraphrase")
        if protected_tokens(source_question) != protected_tokens(paraphrase):
            raise ValueError("paraphrase changed a protected number or date")
        emitted_norm.add(norm)
        variant = canonical_sha256({"source": key, "paraphrase": paraphrase})[:16]
        for source in sorted(groups[key], key=lambda r: r["id"]):
            row = copy.deepcopy(source)
            row["id"] = f"{source['id']}:semantic-paraphrase:{variant}"
            row["state"]["question"] = paraphrase
            row["source"] = "grav-acc-routing-v3/semantic-paraphrase"
            row["metadata"]["provenance"] = {
                **row["metadata"].get("provenance", {}),
                "type": "synthetic_semantic_paraphrase",
                "source_id": source["id"],
                "source_question_sha256": record["source_question_sha256"],
                **expected,
            }
            row["metadata"]["grav"] = {
                **row["metadata"].get("grav", {}),
                "proxy_ood": source.get("split") == "validation",
            }
            output.append(row)
    return output
