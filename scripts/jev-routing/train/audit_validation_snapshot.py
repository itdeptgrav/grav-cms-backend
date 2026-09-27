"""Audit one deterministic training snapshot on the validation split only.

This is deliberately separate from the trainer: it can compare intermediate
snapshots for abstention safety without changing a live run, selecting on the
locked set, or exposing individual validation examples.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from grav_jev_train import (  # noqa: E402
    file_sha256,
    guard_training_view,
    json_sha256,
    load_config,
    read_split,
    source_commit,
)
from train_core import (  # noqa: E402
    configure_determinism,
    load_trainable,
    routing_safety_metrics,
    score_rows,
    set_determinism_env,
)


def verify_snapshot_binding(snapshot: Path, run_dir: Path, config: dict) -> tuple[dict, dict]:
    """Verify the snapshot belongs to the exact run/config being audited."""
    run = json.loads((run_dir / "run.json").read_text())
    resume = json.loads((snapshot / "resume.json").read_text())
    if run.get("identity_sha256") != resume.get("identity_sha256"):
        raise ValueError("snapshot identity differs from its run")
    identity = run.get("identity", {})
    if identity.get("config_sha256") != json_sha256(config) or identity.get("config") != config:
        raise ValueError("audit config differs from the snapshot run config")
    state_path = snapshot / "training_state.pt"
    if file_sha256(state_path) != resume.get("training_state_sha256"):
        raise ValueError("snapshot tensor file checksum differs")
    return run, resume


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--open-jev", required=True)
    parser.add_argument("--init-package", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--runtime-attestation", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="cuda")
    args = parser.parse_args()

    config = load_config(args.config)
    open_jev = Path(args.open_jev).resolve()
    if source_commit(open_jev) != config["open_jev_commit"]:
        raise ValueError("Open-Jev checkout differs from the pinned commit")
    guard_training_view(args.data, config["train_view_manifest_sha256"])

    from runtime_attest import attestation_sha256, bound_changes, capture

    attestation = json.loads(Path(args.runtime_attestation).read_text())
    if not attestation.get("accepted"):
        raise ValueError("runtime attestation was not accepted")
    changes = bound_changes(attestation["runtime"], capture())
    if changes:
        raise RuntimeError(f"runtime changed since attestation: {changes}")

    snapshot = Path(args.snapshot).resolve()
    run, resume = verify_snapshot_binding(snapshot, Path(args.run_dir).resolve(), config)
    expected_runtime_sha = run["identity"].get("runtime_attestation_sha256")
    live_runtime_sha = attestation_sha256(attestation["runtime"])
    if expected_runtime_sha != live_runtime_sha:
        raise ValueError("snapshot run and audit use different runtime attestations")

    set_determinism_env()
    import torch

    sys.path.insert(0, str(open_jev))
    from jev.inference_initialization import (
        initialize_inference_weights,
        read_inference_initialization_package,
    )
    from jev.metrics import softmax
    from jev.model import DecisionModel

    determinism = configure_determinism(torch)
    if json_sha256(determinism) != resume.get("determinism_sha256"):
        raise ValueError("audit determinism settings differ from the snapshot")

    model = DecisionModel(
        config["base_model"],
        config["base_revision"],
        device=args.device,
        lora_rank=config["lora_rank"],
        max_length=config["max_length"],
    )
    if config["initialization_mode"] != "warm_start":
        raise ValueError("snapshot audit currently requires a warm-start run")
    metadata, provenance = read_inference_initialization_package(
        args.init_package,
        config["init_manifest_sha256"],
        config["base_model"],
        config["base_revision"],
        config["lora_rank"],
    )
    initialize_inference_weights(model, args.init_package, metadata, provenance)

    state = torch.load(snapshot / "training_state.pt", map_location="cpu", weights_only=False)
    if state.get("step") != resume.get("step"):
        raise ValueError("snapshot step metadata differs")
    if state.get("next_row_index") != state.get("step") * config["accumulation"]:
        raise ValueError("snapshot is not at an optimizer boundary")
    load_trainable(model, state["trainable"], torch)

    validation = read_split(args.data, "validation")
    if config["validation_rows"] and config["validation_rows"] < len(validation):
        validation = sorted(
            validation,
            key=lambda row: json_sha256([config["seed"], "val", row["id"]]),
        )[: config["validation_rows"]]
    logits = score_rows(model, validation, batch_rows=config["eval_batch_rows"], torch=torch)
    route = [(row, values) for row, values in zip(validation, logits)
             if row["metadata"]["question_id"] == "route"]
    arguments = [(row, values) for row, values in zip(validation, logits)
                 if row["metadata"]["question_id"] != "route"]

    def accuracy(pairs):
        return sum(row["target"][max(range(len(values)), key=values.__getitem__)] == 1
                   for row, values in pairs) / max(1, len(pairs))

    nll = sum(
        -math.log(max(1e-12, softmax(values)[row["target"].index(1)]))
        for row, values in zip(validation, logits)
    ) / len(validation)
    result = {
        "schema": "grav.jev.validation-snapshot-audit/1",
        "snapshot": snapshot.name,
        "step": state["step"],
        "rows": len(validation),
        "route_accuracy": accuracy(route),
        "argument_accuracy": accuracy(arguments),
        "nll": nll,
        **routing_safety_metrics(validation, logits),
        "bindings": {
            "run_identity_sha256": resume["identity_sha256"],
            "training_state_sha256": resume["training_state_sha256"],
            "runtime_attestation_sha256": live_runtime_sha,
            "data_manifest_sha256": config["train_view_manifest_sha256"],
            "init_manifest_sha256": config["init_manifest_sha256"],
        },
    }
    output = Path(args.output)
    if output.exists():
        raise ValueError("output already exists")
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
