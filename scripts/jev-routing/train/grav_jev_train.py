"""GRAV accounting-routing LoRA fine-tune from a verified initialization.

One GPU, one process. Built from Open-Jev's own parts, so the trained adapter
is the same kind of object the released package is and `jev.server
--checkpoint` serves it unchanged:

  * jev.model.DecisionModel          bf16 Qwen3.5-2B, LoRA rank 8, scalar head,
                                     gradient checkpointing (enabled by the class)
  * initialization                  either a hash-verified released warm start,
                                     or a cryptographically bound fresh model
  * jev.metrics.fit_temperature      calibration temperature, calibration split only
  * the loss of jev.train            soft cross-entropy + 0.1 x Brier

Why a wrapper at all: `jev.train` can only start from the base model, and
`jev.train_distributed` (the path that can warm-start from a release package)
is hard-wired to four GPUs. Nothing here changes Open-Jev.

What this script refuses to do
  * read a directory that contains locked evaluation files (test/ood) or any
    file its manifest does not list
  * start without a COMPLETE, full-set evaluation of the untrained released
    model on the locked set (the before-report must exist first)
  * warm-start from a package whose manifest hash differs from the pinned one
  * select a checkpoint with anything but the validation split, or fit the
    temperature with anything but the calibration split
  * run on CPU unless --dry-run-cpu is given (a code-path check, 2 steps)
  * quantize: the released head was trained against bf16 weights; a 4-bit base
    would silently change what the warm start means (see docs)

Usage: see scripts/jev-routing/RUNBOOK-runpod.md. Every run writes to a fresh
directory; completed runs are never overwritten.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRAIN_VIEW_FILES = {"train.jsonl", "calibration.jsonl", "validation.jsonl", "manifest.json"}
LOCKED_NAMES = {"test.jsonl", "ood.jsonl"}
CONFIG_KEYS = {
    "name", "base_model", "base_revision", "init_package_repo", "init_package_revision",
    "init_manifest_sha256", "open_jev_commit", "data_generator_version", "train_view_manifest_sha256",
    "lora_rank", "max_length", "steps", "accumulation", "lr", "head_lr", "brier_weight", "seed",
    "eval_every", "patience", "checkpoint_every", "max_wall_hours", "eval_batch_rows", "precision",
    "quantization", "selection_metric", "validation_rows", "route_rows_per_step", "route_sampling",
    "initialization_mode", "activation_checkpointing",
}
OPTIONAL_CONFIG_KEYS = {"route_sampling", "initialization_mode", "activation_checkpointing"}


# ── pure helpers (unit-tested without torch) ─────────────────────────────────
sys.path.insert(0, str(HERE))
from train_core import (  # noqa: E402  (shared with the deterministic-resume test)
    json_sha256, file_sha256, epoch_order, row_for_step, set_determinism_env, configure_determinism,
    train_step, score_rows, trainable_state, load_trainable, save_training_state, load_training_state,
    determinism_preflight, rows_for_training_step, routing_safety_metrics,
)


def load_config(path) -> dict:
    config = json.loads(Path(path).read_text())
    missing, extra = (CONFIG_KEYS - OPTIONAL_CONFIG_KEYS) - set(config), set(config) - CONFIG_KEYS
    if missing or extra:
        raise ValueError(f"config keys differ: missing {sorted(missing)} extra {sorted(extra)}")
    config.setdefault("route_sampling", "proportional")
    config.setdefault("initialization_mode", "warm_start")
    config.setdefault("activation_checkpointing", False)
    if config["initialization_mode"] not in {"warm_start", "fresh"}:
        raise ValueError("initialization_mode must be warm_start or fresh")
    if type(config["activation_checkpointing"]) is not bool:
        raise ValueError("activation_checkpointing must be boolean")
    if config["precision"] != "bf16":
        raise ValueError("precision must be bf16")
    if config["quantization"] != "none":
        raise ValueError("quantization must be none: the warm-start head was trained on bf16 weights")
    if config["selection_metric"] not in {
        "validation_mean_route_and_argument_accuracy",
        "validation_safety_adjusted_accuracy",
        "validation_proxy_ood_robustness",
    }:
        raise ValueError("checkpoint selection may only use an approved validation-only metric")
    for key in ("steps", "accumulation", "eval_every", "patience", "checkpoint_every", "eval_batch_rows", "lora_rank", "max_length"):
        if type(config[key]) is not int or config[key] < 1:
            raise ValueError(f"{key} must be a positive integer")
    if type(config["route_rows_per_step"]) is not int or not 0 <= config["route_rows_per_step"] < config["accumulation"]:
        raise ValueError("route_rows_per_step must be an integer in [0, accumulation)")
    if config["route_sampling"] not in {
        "proportional", "label_balanced", "safety_balanced", "safety_reason_balanced",
        "safety_reason_and_label_balanced",
    }:
        raise ValueError(
            "route_sampling must be proportional, label_balanced, safety_balanced, "
            "safety_reason_balanced or safety_reason_and_label_balanced"
        )
    if config["route_sampling"] != "proportional" and config["route_rows_per_step"] == 0:
        raise ValueError("balanced route sampling requires a positive route_rows_per_step")
    if config["route_sampling"] in {
        "safety_balanced", "safety_reason_balanced", "safety_reason_and_label_balanced"
    } and (
        config["route_rows_per_step"] < 4 or config["route_rows_per_step"] % 2
    ):
        raise ValueError(f"{config['route_sampling']} requires an even route_rows_per_step of at least 4")
    if not (0 < config["max_wall_hours"] <= 48):
        raise ValueError("max_wall_hours must be in (0, 48]")
    return config


def guard_training_view(data_dir, expected_manifest_sha256) -> dict:
    """The training view may hold exactly its three splits and a manifest."""
    data = Path(data_dir)
    names = {p.name for p in data.iterdir()}
    if names & LOCKED_NAMES:
        raise ValueError(f"refusing: {sorted(names & LOCKED_NAMES)} are locked evaluation files and may not sit in a training directory")
    if names != TRAIN_VIEW_FILES:
        raise ValueError(f"refusing: training directory must contain exactly {sorted(TRAIN_VIEW_FILES)}, found {sorted(names)}")
    if any(p.is_symlink() for p in data.iterdir()):
        raise ValueError("refusing: symlinks in the training directory")
    manifest_sha = file_sha256(data / "manifest.json")
    if manifest_sha != expected_manifest_sha256:
        raise ValueError(f"training-view manifest {manifest_sha} differs from the pinned {expected_manifest_sha256}")
    manifest = json.loads((data / "manifest.json").read_text())
    if set(manifest["files_sha256"]) != {"train.jsonl", "calibration.jsonl", "validation.jsonl"}:
        raise ValueError("training-view manifest must list exactly train, calibration and validation")
    for name, digest in manifest["files_sha256"].items():
        if file_sha256(data / name) != digest:
            raise ValueError(f"{name} does not match its manifest")
    return manifest


def read_split(data_dir, split) -> list[dict]:
    rows = [json.loads(line) for line in (Path(data_dir) / f"{split}.jsonl").read_text().splitlines() if line.strip()]
    for row in rows:
        if row["split"] != split:
            raise ValueError(f"row {row['id']} in {split}.jsonl has split {row['split']}")
    return rows


def check_baseline_report(path, config, locked_manifest_sha256=None, attestation_sha256=None) -> dict:
    """The reference model must have been evaluated on the full locked set first — on THIS runtime."""
    report = json.loads(Path(path).read_text())
    if attestation_sha256 is not None:
        bound = Path(path).with_name("runtime-attestation.sha256")
        if not bound.exists() or bound.read_text().strip() != attestation_sha256:
            raise ValueError("baseline report is not bound to this runtime attestation; run Stage 1 on this GPU first")
    if report.get("schema") != "grav.jev.routing-eval/1":
        raise ValueError("baseline report is not a grav.jev.routing-eval/1 report")
    if report["locked"]["generator_version"] != config["data_generator_version"]:
        raise ValueError("baseline report was produced on a different dataset version")
    if not report["completeness"]["complete"]:
        raise ValueError("baseline report is incomplete or a subset; evaluate the untrained model on the FULL locked set first")
    if locked_manifest_sha256 and report["locked"]["manifest_sha256"] != locked_manifest_sha256:
        raise ValueError("baseline report locked manifest differs")
    if config.get("initialization_mode", "warm_start") == "fresh":
        bound = Path(path).with_name("initialization-manifest.sha256")
        if not bound.exists() or bound.read_text().strip() != config["init_manifest_sha256"]:
            raise ValueError("baseline report is not bound to the pinned fresh initialization")
        reported = report.get("model_reported", {})
        if reported.get("model") != config["base_model"]:
            raise ValueError("baseline report model differs from the fresh initialization")
    return {"sha256": file_sha256(path), "label": report["label"], "device": report["device"],
            "locked_manifest_sha256": report["locked"]["manifest_sha256"], "runtime_attestation_sha256": attestation_sha256}


def full_training_guard(config, environ) -> None:
    """Full training never starts as a side effect: it needs an explicit, separate approval."""
    if config["steps"] > 100 and environ.get("JEV_FULL_TRAINING_APPROVED") != "yes-full-training-approved":
        raise PermissionError(f"config {config['name']} is a full training run; it requires JEV_FULL_TRAINING_APPROVED=yes-full-training-approved")


def selection_score(route_acc, arg_acc, *, metric="validation_mean_route_and_argument_accuracy",
                    safety_accuracy=None, unsafe_routes=None, safety_rows=None) -> float:
    """A validation-only checkpoint score; locked evaluation never participates.

    The safety-adjusted metric retains ordinary route and argument quality but
    explicitly penalises executable decisions on validation abstention rows.
    It strengthens, rather than replaces, the unchanged zero-unsafe release gate.
    """
    if metric == "validation_mean_route_and_argument_accuracy":
        return 0.5 * route_acc + 0.5 * arg_acc
    if metric != "validation_safety_adjusted_accuracy":
        raise ValueError("unknown validation selection metric")
    if safety_accuracy is None or unsafe_routes is None or not safety_rows:
        raise ValueError("safety-adjusted selection requires validation safety metrics")
    unsafe_rate = unsafe_routes / safety_rows
    return 0.4 * route_acc + 0.3 * arg_acc + 0.3 * safety_accuracy - unsafe_rate


def proxy_ood_selection_metrics(original: dict, proxy: dict, *, route_floor=0.90, argument_floor=0.96) -> dict:
    """Select on the weaker of ordinary validation and validation-only paraphrases.

    The proxy rows are generated from validation language only and carry the
    same frozen targets. They are not locked rows and may never replace the
    final locked evaluation. A checkpoint is ready for that one final
    evaluation only when both views clear the declared floors with zero unsafe
    argmax routes.
    """
    required = {
        "route_accuracy", "argument_accuracy", "validation_safety_accuracy",
        "validation_unsafe_argmax_routes", "validation_safety_rows", "n",
    }
    for name, metrics in (("original", original), ("proxy", proxy)):
        missing = required - set(metrics)
        if missing:
            raise ValueError(f"{name} validation metrics missing {sorted(missing)}")
        if not metrics["n"] or not metrics["validation_safety_rows"]:
            raise ValueError(f"{name} validation view must contain rows and abstention safety rows")
    min_route = min(original["route_accuracy"], proxy["route_accuracy"])
    min_argument = min(original["argument_accuracy"], proxy["argument_accuracy"])
    min_safety = min(original["validation_safety_accuracy"], proxy["validation_safety_accuracy"])
    unsafe = original["validation_unsafe_argmax_routes"] + proxy["validation_unsafe_argmax_routes"]
    # One unsafe argmax must dominate any possible accuracy gain. Otherwise a
    # numerically higher but unsafe checkpoint could win checkpoint selection
    # even though the unchanged release contract requires exactly zero.
    score = 0.45 * min_route + 0.35 * min_argument + 0.20 * min_safety - unsafe
    return {
        "score": score,
        "proxy_ood_success": min_route >= route_floor and min_argument >= argument_floor and unsafe == 0,
        "min_route_accuracy": min_route,
        "min_argument_accuracy": min_argument,
        "min_safety_accuracy": min_safety,
        "combined_unsafe_argmax_routes": unsafe,
        "route_floor": route_floor,
        "argument_floor": argument_floor,
    }


def source_commit(open_jev: Path) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(open_jev), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unverified-no-git"


def rss_peak_mib() -> float | None:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) / 1024
    except OSError:
        return None
    return None


def export_manifest(package_dir: Path, model: str, revision: str) -> dict:
    files = {}
    for p in sorted(package_dir.rglob("*")):
        if p.is_file() and p.name != "manifest.json":
            rel = p.relative_to(package_dir).as_posix()
            files[rel] = {"sha256": file_sha256(p), "bytes": p.stat().st_size}
    manifest = {"schema_version": 1, "kind": "local_inference_weight_package", "weights_license": "Apache-2.0",
                "model": model, "revision": revision, "files": files,
                "scope": "LoRA adapter, scalar head, calibration temperature and configuration only. Base weights are NOT included and must be fetched at the pinned revision."}
    (package_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


# ── torch path ───────────────────────────────────────────────────────────────
def run(args):
    config = load_config(args.config)
    open_jev = Path(args.open_jev).resolve()
    sys.path.insert(0, str(open_jev))
    commit = source_commit(open_jev)
    if commit != config["open_jev_commit"] and not args.dry_run_cpu:
        raise ValueError(f"Open-Jev checkout is at {commit}, config pins {config['open_jev_commit']}")

    full_training_guard(config, os.environ)
    attestation_sha = None
    if not args.dry_run_cpu:
        if not args.runtime_attestation:
            raise ValueError("--runtime-attestation is required: training is bound to the captured runtime")
        from runtime_attest import bound_changes, capture, attestation_sha256
        bound = json.loads(Path(args.runtime_attestation).read_text())
        if not bound.get("accepted"):
            raise ValueError("runtime attestation was not accepted")
        changes = bound_changes(bound["runtime"], capture())
        if changes:
            raise RuntimeError(f"runtime changed since attestation: {changes}")
        attestation_sha = attestation_sha256(bound["runtime"])
    manifest = guard_training_view(args.data, config["train_view_manifest_sha256"])
    if manifest.get("generator_version") != config["data_generator_version"]:
        raise ValueError("training view generator version differs from the config")
    if args.preflight_only:
        baseline = {"skipped": "preflight-only"}
    elif args.dry_run_cpu:
        baseline = {"skipped": "dry-run-cpu"}
    else:
        baseline = check_baseline_report(args.baseline_report, config, attestation_sha256=attestation_sha)

    out = Path(args.output)
    if (out / "summary.json").exists():
        raise ValueError("output already holds a completed run; use a fresh directory")
    out.mkdir(parents=True, exist_ok=True)

    set_determinism_env()  # before torch touches CUDA: cuBLAS reads it at handle creation
    import torch
    from jev.model import DecisionModel
    from jev.inference_initialization import read_inference_initialization_package, initialize_inference_weights
    from jev.metrics import fit_temperature, softmax

    device = "cpu" if args.dry_run_cpu else args.device
    if not args.dry_run_cpu:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is not available; refusing to train on CPU (use --dry-run-cpu only for a code-path check)")
        torch.cuda.reset_peak_memory_stats()
    steps = 2 if args.dry_run_cpu else config["steps"]
    accumulation = 1 if args.dry_run_cpu else config["accumulation"]

    determinism = configure_determinism(torch)
    random.seed(config["seed"])
    torch.manual_seed(config["seed"])
    try:
        import numpy as np
        np.random.seed(config["seed"] % 2**32)
    except ImportError:
        pass

    train = read_split(args.data, "train")
    calibration = read_split(args.data, "calibration")
    validation = read_split(args.data, "validation")
    if args.dry_run_cpu:
        # smallest route rows, so the CPU code-path check finishes
        train = sorted(train, key=lambda r: (len(r["options"]), r["id"]))[:4]
        calibration = sorted(calibration, key=lambda r: (len(r["options"]), r["id"]))[:2]
        validation = sorted(validation, key=lambda r: (len(r["options"]), r["id"]))[:2]
    elif config["selection_metric"] == "validation_proxy_ood_robustness" and (
        config["validation_rows"] and config["validation_rows"] < len(validation)
    ):
        raise ValueError("proxy-OOD selection requires the complete original and proxy validation views")
    elif config["validation_rows"] and config["validation_rows"] < len(validation):
        validation = sorted(validation, key=lambda r: json_sha256([config["seed"], "val", r["id"]]))[: config["validation_rows"]]

    runtime = {"torch": torch.__version__, "cuda": torch.version.cuda, "python": sys.version.split()[0]}
    try:
        from importlib.metadata import version
        runtime.update(transformers=version("transformers"), peft=version("peft"))
    except Exception:  # noqa: BLE001 — recorded, not fatal
        pass
    identity = {"config_sha256": json_sha256(config), "config": config, "open_jev_commit": commit,
                "data_manifest_sha256": config["train_view_manifest_sha256"], "baseline": baseline,
                "trainer_sha256": file_sha256(__file__), "dry_run_cpu": bool(args.dry_run_cpu),
                "effective_steps": steps, "effective_accumulation": accumulation, "determinism": determinism,
                "trainer_core_sha256": file_sha256(HERE / "train_core.py"),
                "runtime_attestation_sha256": attestation_sha}
    identity_sha = json_sha256(identity)
    (out / "run.json").write_text(json.dumps({"identity": identity, "identity_sha256": identity_sha, "runtime": runtime,
                                              "device": device, "gpu": torch.cuda.get_device_name() if device.startswith("cuda") else None,
                                              "started_at": time.time()}, indent=2) + "\n")

    print(json.dumps({"event": "load", "device": device}), flush=True)
    t_load = time.perf_counter()
    model = DecisionModel(config["base_model"], config["base_revision"], device=device,
                          lora_rank=config["lora_rank"], max_length=config["max_length"])
    if config["initialization_mode"] == "warm_start":
        metadata, provenance = read_inference_initialization_package(
            args.init_package, config["init_manifest_sha256"], config["base_model"], config["base_revision"], config["lora_rank"])
        initialize_inference_weights(model, args.init_package, metadata, provenance)
        # A cryptographically verified package is not necessarily released:
        # correction experiments may intentionally warm-start from a rejected
        # candidate. Keep the provenance factual and let the gate decide release.
        initialization_kind = "verified_inference_package"
    else:
        from fresh_init import read_fresh_initialization_package, trainable_digest
        provenance = read_fresh_initialization_package(
            args.init_package, config["init_manifest_sha256"], config["base_model"],
            config["base_revision"], config["lora_rank"], config["max_length"], config["seed"])
        live_digest = trainable_digest(model, torch)
        if live_digest != provenance["trainable_sha256"]:
            raise ValueError("fresh model trainable tensors differ from the cryptographically bound initialization")
        initialization_kind = "fresh_base_model"
    if config["activation_checkpointing"]:
        # Recompute forward activations during backward instead of retaining
        # them. This is mathematically the same bf16 model and is still
        # required to pass the bit-identical gradient preflight below.
        model.backbone.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False}
        )
    load_seconds = time.perf_counter() - t_load
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(json.dumps({"event": "initialization", "kind": initialization_kind,
                      "trainable_parameters": trainable, "load_seconds": load_seconds}), flush=True)

    optimizer = torch.optim.AdamW([
        {"params": [p for p in model.backbone.parameters() if p.requires_grad], "lr": config["lr"]},
        {"params": model.head.parameters(), "lr": config["head_lr"]},
    ], weight_decay=0.01, betas=(0.9, 0.999), eps=1e-8)

    def score(rows):
        return score_rows(model, rows, batch_rows=config["eval_batch_rows"], torch=torch)

    def validation_metrics(rows):
        logits = score(rows)
        route = [(r, lg) for r, lg in zip(rows, logits) if r["metadata"]["question_id"] == "route"]
        args_ = [(r, lg) for r, lg in zip(rows, logits) if r["metadata"]["question_id"] != "route"]
        acc = lambda pairs: sum(r["target"][max(range(len(lg)), key=lg.__getitem__)] == 1 for r, lg in pairs) / max(1, len(pairs))
        nll = sum(-math.log(max(1e-12, softmax(lg)[r["target"].index(1)])) for r, lg in zip(rows, logits)) / len(rows)
        route_accuracy, argument_accuracy = acc(route), acc(args_)
        safety = routing_safety_metrics(rows, logits)
        return {"route_accuracy": route_accuracy, "argument_accuracy": argument_accuracy,
                "nll": nll, "n": len(rows), **safety}

    def validate(rows):
        if config["selection_metric"] == "validation_proxy_ood_robustness":
            original_rows = [r for r in rows if not r.get("metadata", {}).get("grav", {}).get("proxy_ood")]
            proxy_rows = [r for r in rows if r.get("metadata", {}).get("grav", {}).get("proxy_ood") is True]
            if not original_rows or not proxy_rows:
                raise ValueError("proxy-OOD selection requires both original and proxy validation rows")
            original = validation_metrics(original_rows)
            proxy = validation_metrics(proxy_rows)
            robust = proxy_ood_selection_metrics(original, proxy)
            return {
                **robust,
                "n": len(rows),
                "nll": max(original["nll"], proxy["nll"]),
                "original_validation": original,
                "proxy_ood_validation": proxy,
            }
        metrics = validation_metrics(rows)
        metrics["score"] = selection_score(
            metrics["route_accuracy"], metrics["argument_accuracy"], metric=config["selection_metric"],
            safety_accuracy=metrics["validation_safety_accuracy"],
            unsafe_routes=metrics["validation_unsafe_argmax_routes"],
            safety_rows=metrics["validation_safety_rows"],
        )
        return metrics

    # resume
    start_step, best, evals_without_gain, history = 0, None, 0, []
    elapsed_before = 0.0
    if args.resume:
        start_step, extra = load_training_state(args.resume, accumulation=accumulation, model=model, optimizer=optimizer,
                                                identity_sha=identity_sha, determinism=determinism, torch=torch)
        best, evals_without_gain, history, elapsed_before = extra["best"], extra["evals_without_gain"], extra["history"], extra["elapsed_seconds"]
        log_lines = [l for l in (out / "training.jsonl").read_text().splitlines() if l.strip()] if (out / "training.jsonl").exists() else []
        (out / "training.jsonl").write_text("".join(l + "\n" for l in log_lines if json.loads(l).get("step", 0) <= start_step))
        print(json.dumps({"event": "resumed", "step": start_step}), flush=True)

    # Fail closed before any step if this machine cannot repeat a backward pass
    # bit for bit: that is exactly what broke the first RunPod resume check.
    first_rows = rows_for_training_step(train, step=start_step, accumulation=accumulation, seed=config["seed"],
                                        route_rows_per_step=config["route_rows_per_step"], order_cache={},
                                        route_sampling=config["route_sampling"])
    preflight = determinism_preflight(model, first_rows, brier_weight=config["brier_weight"], torch=torch)
    print(json.dumps({"event": "determinism_preflight", "identical": preflight["identical"], "losses": preflight["losses"],
                      "gradient_sha256": [d[:16] for d in preflight["gradient_sha256"]]}), flush=True)
    (out / "determinism_preflight.json").write_text(json.dumps({"settings": determinism, **preflight}, indent=2) + "\n")
    if not preflight["identical"]:
        raise RuntimeError("determinism preflight failed: the same backward pass gave different gradients; refusing to train")
    if args.preflight_only:
        print(json.dumps({"event": "preflight_only_done", "identical": True}), flush=True)
        return

    if not args.resume:
        v0 = validate(validation)
        best = {"step": 0, **v0, "state": trainable_state(model)}
        history.append({"step": 0, **v0})
        print(json.dumps({"event": "validation", "step": 0, **v0}), flush=True)

    def snapshot(step, elapsed):
        save_training_state(out / "training-checkpoints", step=step, accumulation=accumulation, model=model, optimizer=optimizer,
                            extra={"best": best, "evals_without_gain": evals_without_gain, "history": history, "elapsed_seconds": elapsed},
                            identity_sha=identity_sha, determinism=determinism, torch=torch)

    order_cache = {}
    completed = start_step
    started = time.perf_counter()
    status = "complete"
    model.train()
    with (out / "training.jsonl").open("a") as log:
        for step in range(start_step, steps):
            elapsed = elapsed_before + time.perf_counter() - started
            if elapsed > config["max_wall_hours"] * 3600:
                status = "stopped_wall_clock"
                snapshot(step, elapsed)
                break
            t0 = time.perf_counter()
            record = train_step(model, optimizer, train, step=step, accumulation=accumulation, seed=config["seed"],
                                brier_weight=config["brier_weight"], order_cache=order_cache, torch=torch,
                                route_rows_per_step=config["route_rows_per_step"], route_sampling=config["route_sampling"])
            completed = step + 1
            record.update(step_seconds=time.perf_counter() - t0, elapsed_seconds=elapsed_before + time.perf_counter() - started)
            if device.startswith("cuda"):
                record.update(peak_allocated_gib=torch.cuda.max_memory_allocated() / 2**30,
                              peak_reserved_gib=torch.cuda.max_memory_reserved() / 2**30)
            record["peak_rss_mib"] = rss_peak_mib()
            log.write(json.dumps(record) + "\n")
            log.flush()
            print(json.dumps(record), flush=True)

            if (step + 1) % config["eval_every"] == 0 or step + 1 == steps:
                v = validate(validation)
                history.append({"step": step + 1, **v})
                improved = v["score"] > best["score"] + 1e-9 or (abs(v["score"] - best["score"]) <= 1e-9 and v["nll"] < best["nll"])
                if improved:
                    best = {"step": step + 1, **v, "state": trainable_state(model)}
                    evals_without_gain = 0
                else:
                    evals_without_gain += 1
                print(json.dumps({"event": "validation", "step": step + 1, "improved": improved, **v}), flush=True)
                if evals_without_gain >= config["patience"]:
                    status = "early_stopped"
            if (step + 1) % config["checkpoint_every"] == 0 or status == "early_stopped" or step + 1 == steps:
                snapshot(step + 1, elapsed_before + time.perf_counter() - started)
            if status == "early_stopped":
                break

    # select by validation only, then calibrate on calibration only
    load_trainable(model, best["state"], torch)
    model.save(out / "checkpoint")
    cal_logits = score(calibration)
    temperature = fit_temperature(cal_logits, [r["target"] for r in calibration])
    (out / "checkpoint" / "temperature.json").write_text(json.dumps({
        "temperature": temperature, "split": "calibration", "n": len(calibration),
        "ids_sha256": hashlib.sha256(json.dumps([r["id"] for r in calibration]).encode()).hexdigest()}, indent=2) + "\n")

    reference = score(validation[:2])
    peak = {"cuda_peak_allocated_gib": torch.cuda.max_memory_allocated() / 2**30 if device.startswith("cuda") else None,
            "cuda_peak_reserved_gib": torch.cuda.max_memory_reserved() / 2**30 if device.startswith("cuda") else None,
            "process_peak_rss_mib": rss_peak_mib()}
    del optimizer, model
    import gc
    gc.collect()
    if device.startswith("cuda"):
        torch.cuda.empty_cache()
    reloaded = DecisionModel.load(out / "checkpoint", device=device)
    with torch.inference_mode():
        check = [[float(x) for x in lg.float().cpu()] for lg in reloaded(validation[:2])]
    reload_error = max(abs(a - b) for r, c in zip(reference, check) for a, b in zip(r, c))
    if reload_error > 0.05:
        raise ValueError(f"checkpoint reload mismatch {reload_error}")

    # compact export: adapter + head + temperature + config + licences. No optimizer, no base weights.
    package = out / "export" / config["name"]
    if package.exists():
        shutil.rmtree(package)
    (package / "checkpoint" / "adapter").mkdir(parents=True)
    for name in ("model.json", "head.pt", "temperature.json"):
        shutil.copyfile(out / "checkpoint" / name, package / "checkpoint" / name)
    for name in ("adapter_config.json", "adapter_model.safetensors"):
        shutil.copyfile(out / "checkpoint" / "adapter" / name, package / "checkpoint" / "adapter" / name)
    shutil.copyfile(open_jev / "third_party" / "qwen" / "LICENSE", package / "LICENSE")
    shutil.copyfile(open_jev / "LICENSE", package / "LICENSE-CODE")
    best_public = {k: v for k, v in best.items() if k != "state"}
    provenance_out = {
        "schema_version": 1, "weights_license": "Apache-2.0", "code_license": "MIT",
        "model": config["base_model"], "revision": config["base_revision"],
        "training": {"steps": best["step"], "planned_steps": steps, "completed_steps": completed,
                     "accumulation": accumulation, "max_length": config["max_length"],
                     "lora_rank": config["lora_rank"], "lr": config["lr"], "head_lr": config["head_lr"],
                     "brier_weight": config["brier_weight"], "seed": config["seed"],
                     "route_rows_per_step": config["route_rows_per_step"], "route_sampling": config["route_sampling"],
                     "status": status,
                     "selected_step": best["step"], "code_commit": commit, "run_identity_sha256": identity_sha,
                     "initialization": {"kind": initialization_kind, **provenance}},
        "data": {"name": config["data_generator_version"], "train_view_manifest_sha256": config["train_view_manifest_sha256"],
                 "locked_evaluation_read_by_training": False},
        "selection": {"split": "validation+proxy_ood_validation" if config["selection_metric"] == "validation_proxy_ood_robustness" else "validation",
                      "metric": config["selection_metric"], "best": best_public, "history": history},
        "calibration": {"split": "calibration", "temperature": temperature, "n": len(calibration)},
    }
    (package / "provenance.json").write_text(json.dumps(provenance_out, indent=2) + "\n")
    (package / "README.md").write_text(
        f"# {config['name']}\n\nLoRA adapter + scalar decision head for {config['base_model']} @ {config['base_revision']}, "
        f"fine-tuned from a verified {initialization_kind.replace('_', ' ')} on GRAV's synthetic accounting-routing dataset.\n\n"
        "Base weights are not included. Serve with `python -m jev.server --checkpoint <this>/checkpoint` from Open-Jev "
        f"commit {config['open_jev_commit']}.\n\nThis adapter is NOT approved for users until scripts/jev-routing/gate.js "
        "accepts it against the untrained baseline on the same locked set, and a separate deployment decision is made.\n\n"
        "Weights: Apache-2.0 (Qwen base terms; see LICENSE). Modified from Qwen/Qwen3.5-2B via LoRA. Code: MIT (LICENSE-CODE).\n")
    export = export_manifest(package, config["base_model"], config["base_revision"])
    archive = shutil.make_archive(str(package), "gztar", root_dir=package.parent, base_dir=package.name)

    summary = {"status": status, "completed_steps": completed, "selected_step": best["step"], "validation_best": best_public, "temperature": temperature,
               "checkpoint_reload_max_error": reload_error, "load_seconds": load_seconds,
               "elapsed_seconds": elapsed_before + time.perf_counter() - started, "trainable_parameters": trainable,
               "resources": peak, "export": {"directory": str(package), "archive": archive, "archive_sha256": file_sha256(archive),
                                             "manifest_sha256": file_sha256(package / "manifest.json"),
                                             "files": export["files"]},
               "identity_sha256": identity_sha, "dry_run_cpu": bool(args.dry_run_cpu),
               "determinism": determinism, "determinism_preflight_identical": preflight["identical"],
               "next": "Serve export/<name>/checkpoint and run scripts/jev-routing/evaluate.js on the FULL locked set, then gate.js."}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"event": "done", **{k: summary[k] for k in ("status", "selected_step", "temperature", "checkpoint_reload_max_error")}}), flush=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", required=True)
    p.add_argument("--data", required=True, help="the train-view directory; never the locked one")
    p.add_argument("--open-jev", required=True, help="Open-Jev git checkout at the pinned commit")
    p.add_argument("--init-package", required=True, help="verified inference package directory (the one holding manifest.json)")
    p.add_argument("--baseline-report", help="report.json of the reference model on the FULL locked set")
    p.add_argument("--output", required=True)
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--resume", help="training-checkpoints/step-* directory of THIS run")
    p.add_argument("--dry-run-cpu", action="store_true", help="2-step CPU code-path check; never a training run")
    p.add_argument("--runtime-attestation", help="accepted runtime_attest.py capture; the run is bound to it")
    p.add_argument("--preflight-only", action="store_true", help="load, warm-start, run the determinism preflight, exit; trains nothing")
    args = p.parse_args(argv)
    if not args.dry_run_cpu and not args.preflight_only and not args.baseline_report:
        p.error("--baseline-report is required: evaluate the untrained model first")
    run(args)


if __name__ == "__main__":
    main()
