"""Generate language-only paraphrases and judge semantic equivalence on CUDA.

Only the question text, split name and opaque source key enter this pipeline.
Routes, labels, options, targets and accounting data never enter either model
prompt. The output is not itself a training set; build_augmented_training_view
copies frozen decisions from the independently pinned source view afterward.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path

from grav_jev_train import file_sha256, guard_training_view, read_split
from robustness_augmentation import canonical_sha256, load_augmentation_spec, protected_tokens, utterance_key


def parse_json_object(text: str, expected_keys: set[str]) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```json") and cleaned.endswith("```"):
        cleaned = cleaned[7:-3].strip()
    value = json.loads(cleaned)
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError(f"model JSON keys must be exactly {sorted(expected_keys)}")
    return value


def source_utterances(rows: list[dict]) -> list[dict]:
    groups = {}
    for row in rows:
        if row.get("split") not in {"train", "validation"}:
            raise ValueError("paraphrase generation accepts only train and validation")
        key = utterance_key(row)
        question = row.get("state", {}).get("question")
        if not isinstance(question, str) or not question.strip():
            raise ValueError("source question is missing")
        value = {"source_key": key, "split": row["split"], "question": question.strip()}
        if key in groups and groups[key] != value:
            raise ValueError(f"inconsistent source utterance group {key}")
        groups[key] = value
    return [groups[key] for key in sorted(groups)]


def generate_records(utterances, spec, teacher, judge):
    """Run injected teacher/judge functions; useful for both CUDA and tests."""
    accepted, rejected, candidates = [], [], []
    pins = {
        "teacher_model": spec["teacher"]["model"],
        "teacher_revision": spec["teacher"]["revision"],
        "judge_model": spec["judge"]["model"],
        "judge_revision": spec["judge"]["revision"],
        "generation_prompt_sha256": spec["teacher"]["prompt_sha256"],
        "judge_prompt_sha256": spec["judge"]["prompt_sha256"],
    }
    for source in utterances:
        # Deliberately closed payload: no label, option, target, reason or tool.
        teacher_payload = {"source_question": source["question"]}
        try:
            proposed = parse_json_object(teacher(teacher_payload), {"paraphrase"})["paraphrase"]
            if not isinstance(proposed, str) or not proposed.strip():
                raise ValueError("empty paraphrase")
            proposed = " ".join(proposed.split())
            if proposed.casefold() == source["question"].casefold():
                raise ValueError("unchanged paraphrase")
            if protected_tokens(proposed) != protected_tokens(source["question"]):
                raise ValueError("protected number or date changed")
            candidates.append({**source, "paraphrase": proposed})
            judge_payload = {"source_question": source["question"], "proposed_paraphrase": proposed}
            verdict = parse_json_object(judge(judge_payload), {"equivalent", "reason"})
            if verdict["equivalent"] is not True:
                raise ValueError("independent judge rejected semantic equivalence")
            accepted.append({
                "source_key": source["source_key"],
                "source_question_sha256": canonical_sha256(source["question"]),
                "paraphrase": proposed,
                "judge_passed": True,
                "judge_reason_sha256": canonical_sha256(verdict["reason"]),
                **pins,
            })
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            rejected.append({"source_key": source["source_key"], "reason": str(exc)})
    rate = len(accepted) / max(1, len(utterances))
    if rate < spec["minimum_acceptance_rate"]:
        raise ValueError(f"accepted paraphrases {rate:.4f} below pinned minimum {spec['minimum_acceptance_rate']:.4f}")
    return accepted, rejected, candidates


def model_generator(model_spec: dict, system_prompt: str, device: str):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if not device.startswith("cuda") or not torch.cuda.is_available():
        raise RuntimeError("teacher and judge inference require CUDA")
    tokenizer = AutoTokenizer.from_pretrained(model_spec["model"], revision=model_spec["revision"])
    model = AutoModelForCausalLM.from_pretrained(
        model_spec["model"], revision=model_spec["revision"], torch_dtype=torch.bfloat16,
        device_map={"": device}, attn_implementation="sdpa",
    )
    model.eval()

    def run(payload: dict) -> str:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, sort_keys=True)},
        ]
        rendered = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = tokenizer(rendered, return_tensors="pt").to(device)
        with torch.inference_mode():
            output = model.generate(
                **inputs, do_sample=False, max_new_tokens=model_spec["max_new_tokens"],
                pad_token_id=tokenizer.eos_token_id,
            )
        return tokenizer.decode(output[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    return run, model, tokenizer


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args(argv)
    output = Path(args.output).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("output directory must be absent or empty")
    output.mkdir(parents=True, exist_ok=True)
    spec = load_augmentation_spec(args.spec)
    guard_training_view(args.source, spec["source_train_view_manifest_sha256"])
    rows = read_split(args.source, "train") + read_split(args.source, "validation")
    utterances = source_utterances(rows)
    prompt_root = Path(args.spec).resolve().parent.parent
    teacher_prompt = (prompt_root / spec["teacher"]["prompt"]).read_text()
    judge_prompt = (prompt_root / spec["judge"]["prompt"]).read_text()

    teacher, teacher_model, teacher_tokenizer = model_generator(spec["teacher"], teacher_prompt, args.device)
    candidate_text = [(source, teacher({"source_question": source["question"]})) for source in utterances]
    del teacher, teacher_model, teacher_tokenizer
    gc.collect()
    import torch
    torch.cuda.empty_cache()
    candidate_by_key = {source["source_key"]: text for source, text in candidate_text}
    teacher_replay = lambda payload: candidate_by_key[next(
        source["source_key"] for source in utterances if source["question"] == payload["source_question"]
    )]

    judge, judge_model, judge_tokenizer = model_generator(spec["judge"], judge_prompt, args.device)
    accepted, rejected, candidates = generate_records(utterances, spec, teacher_replay, judge)
    del judge, judge_model, judge_tokenizer
    gc.collect()
    torch.cuda.empty_cache()
    write_jsonl(output / "accepted-records.jsonl", accepted)
    write_jsonl(output / "rejected-records.jsonl", rejected)
    write_jsonl(output / "teacher-candidates.jsonl", candidates)
    report = {
        "schema": "grav.jev.semantic-augmentation-report/1",
        "spec_sha256": file_sha256(args.spec),
        "source_train_view_manifest_sha256": spec["source_train_view_manifest_sha256"],
        "utterances": len(utterances), "accepted": len(accepted), "rejected": len(rejected),
        "acceptance_rate": len(accepted) / max(1, len(utterances)),
        "accepted_records_sha256": file_sha256(output / "accepted-records.jsonl"),
        "locked_rows_read": False,
    }
    (output / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

