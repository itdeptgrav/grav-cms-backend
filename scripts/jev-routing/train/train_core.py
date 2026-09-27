"""The step, checkpoint and determinism core shared by grav_jev_train.py and its tests.

Why this module exists (RunPod smoke, 25 Sep 2026): the resume-from-step-50 run
reproduced step 51's LOSS bit for bit (identical weights, data and forward pass)
but not its GRADIENT NORM (14.5248 vs 14.5188). The backward pass itself was not
deterministic: the trainer set no deterministic CUDA execution, so SDPA's
flash/memory-efficient attention backward (atomic accumulation) and cuBLAS
workspace-dependent reductions were free to reorder floating-point sums. The
restored state was complete; the arithmetic was not repeatable.

Everything that decides the next step lives here, is saved at an optimizer
boundary, and is verified on restore:
  * trainable parameters (LoRA A/B + scalar head) — the frozen base is rebuilt
    from pinned weights and the hash-verified release package
  * AdamW state (moments and step counts); there is no LR scheduler (constant
    LR) and no GradScaler (bf16 weights, no autocast) — both recorded as absent
  * Python, NumPy, torch CPU and every CUDA device RNG state
  * the data cursor: the row for (step, micro) is a pure function of
    (seed, step * accumulation + micro), and the snapshot records the next index
  * the determinism settings, which must be identical on resume

Torch is passed in, never imported at module load, so the pure parts can be
unit-tested without it.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import tempfile
from pathlib import Path

CUBLAS_WORKSPACE = ":4096:8"


# ── pure helpers ─────────────────────────────────────────────────────────────
def json_sha256(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def file_sha256(path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def epoch_order(n_rows, seed, epoch) -> list[int]:
    order = list(range(n_rows))
    random.Random(json_sha256([seed, "epoch", epoch])).shuffle(order)
    return order


def row_for_step(order_cache, n_rows, seed, index):
    """Row for global micro-batch `index`. Pure in (seed, index); the cache is only a speed-up."""
    epoch, offset = divmod(index, n_rows)
    if epoch not in order_cache:
        order_cache.clear()
        order_cache[epoch] = epoch_order(n_rows, seed, epoch)
    return order_cache[epoch][offset]


def rows_for_training_step(train_rows, *, step, accumulation, seed, route_rows_per_step, order_cache,
                           route_sampling="proportional"):
    """Select a deterministic optimizer step, optionally stratified by decision kind.

    A zero route quota preserves the original global shuffle exactly.  A positive
    quota draws independently shuffled route and argument streams, so routing can
    receive more training weight without duplicating or inspecting locked data.
    """
    if type(route_rows_per_step) is not int or not 0 <= route_rows_per_step < accumulation:
        raise ValueError("route_rows_per_step must be an integer in [0, accumulation)")
    if route_sampling not in {
        "proportional", "label_balanced", "safety_balanced", "safety_reason_balanced",
        "safety_reason_and_label_balanced",
    }:
        raise ValueError(
            "route_sampling must be proportional, label_balanced, safety_balanced, "
            "safety_reason_balanced or safety_reason_and_label_balanced"
        )
    if route_rows_per_step == 0:
        if route_sampling != "proportional":
            raise ValueError("balanced route sampling requires a positive route_rows_per_step")
        return [train_rows[row_for_step(order_cache, len(train_rows), seed, step * accumulation + m)]
                for m in range(accumulation)]

    route_rows = [row for row in train_rows if row["metadata"]["question_id"] == "route"]
    argument_rows = [row for row in train_rows if row["metadata"]["question_id"] != "route"]
    if not route_rows or not argument_rows:
        raise ValueError("stratified training requires both route and argument rows")

    route_cache = order_cache.setdefault("route", {})
    argument_cache = order_cache.setdefault("argument", {})
    argument_rows_per_step = accumulation - route_rows_per_step
    if route_sampling == "proportional":
        selected = [
            route_rows[row_for_step(route_cache, len(route_rows), f"{seed}:route",
                                    step * route_rows_per_step + m)]
            for m in range(route_rows_per_step)
        ]
    elif route_sampling == "label_balanced":
        by_label = {}
        for row in route_rows:
            label = row.get("metadata", {}).get("grav", {}).get("gold")
            if not isinstance(label, str) or not label:
                raise ValueError("label-balanced routing requires metadata.grav.gold on every route row")
            by_label.setdefault(label, []).append(row)
        labels = sorted(by_label)
        label_cache = order_cache.setdefault("route_labels", {})
        bucket_caches = order_cache.setdefault("route_buckets", {})
        selected = []
        for m in range(route_rows_per_step):
            route_index = step * route_rows_per_step + m
            cycle, offset = divmod(route_index, len(labels))
            label_order = epoch_order(len(labels), f"{seed}:route-labels", cycle)
            label = labels[label_order[offset]]
            bucket = by_label[label]
            bucket_cache = bucket_caches.setdefault(label, {})
            selected.append(bucket[row_for_step(bucket_cache, len(bucket), f"{seed}:route:{label}", cycle)])
    elif route_sampling == "safety_balanced":
        # Half of every route quota remains dedicated to abstention.  Within
        # that half, unsupported receives two turns for every clarify turn;
        # this preserves the safety-heavy mix while the other half balances
        # the executable tools that proportional training under-exposes.
        if route_rows_per_step < 4 or route_rows_per_step % 2:
            raise ValueError("safety_balanced requires an even route_rows_per_step of at least 4")
        by_label = {}
        for row in route_rows:
            label = row.get("metadata", {}).get("grav", {}).get("gold")
            if not isinstance(label, str) or not label:
                raise ValueError("safety-balanced routing requires metadata.grav.gold on every route row")
            by_label.setdefault(label, []).append(row)
        abstention_labels = {"unsupported", "clarify"}
        if not abstention_labels.issubset(by_label):
            raise ValueError("safety-balanced routing requires unsupported and clarify rows")
        executable_labels = sorted(set(by_label) - abstention_labels)
        if not executable_labels:
            raise ValueError("safety-balanced routing requires executable route rows")
        bucket_caches = order_cache.setdefault("route_buckets", {})
        safety_per_step = route_rows_per_step // 2
        executable_per_step = route_rows_per_step - safety_per_step
        safety_pattern = ("unsupported", "unsupported", "clarify")
        selected = []
        for m in range(safety_per_step):
            stream_index = step * safety_per_step + m
            full_patterns, pattern_offset = divmod(stream_index, len(safety_pattern))
            label = safety_pattern[pattern_offset]
            label_index = (full_patterns * safety_pattern.count(label)
                           + safety_pattern[:pattern_offset].count(label))
            bucket = by_label[label]
            bucket_cache = bucket_caches.setdefault(label, {})
            selected.append(bucket[row_for_step(bucket_cache, len(bucket), f"{seed}:route:{label}",
                                                label_index)])
        for m in range(executable_per_step):
            stream_index = step * executable_per_step + m
            cycle, offset = divmod(stream_index, len(executable_labels))
            label_order = epoch_order(len(executable_labels), f"{seed}:route-executable-labels", cycle)
            label = executable_labels[label_order[offset]]
            bucket = by_label[label]
            bucket_cache = bucket_caches.setdefault(label, {})
            selected.append(bucket[row_for_step(bucket_cache, len(bucket), f"{seed}:route:{label}", cycle)])
    else:
        # Correction fine-tunes need to revisit every *reason* for abstention
        # without flattening the executable-tool distribution that the source
        # model already learned. Half of the route quota rotates evenly through
        # training-only safety reasons; the other half follows a deterministic
        # proportional stream over executable routes. Locked rows are never
        # read or consulted by this sampler.
        if route_rows_per_step < 4 or route_rows_per_step % 2:
            raise ValueError("safety_reason_balanced requires an even route_rows_per_step of at least 4")
        safety_rows = []
        executable_rows = []
        for row in route_rows:
            grav = row.get("metadata", {}).get("grav", {})
            label = grav.get("gold")
            if not isinstance(label, str) or not label:
                raise ValueError("safety-reason-balanced routing requires metadata.grav.gold on every route row")
            if label in {"unsupported", "clarify"}:
                reason = grav.get("reason")
                if not isinstance(reason, str) or not reason:
                    raise ValueError("safety-reason-balanced routing requires metadata.grav.reason on every abstention row")
                safety_rows.append(row)
            else:
                executable_rows.append(row)
        if not safety_rows or not executable_rows:
            raise ValueError("safety-reason-balanced routing requires abstention and executable route rows")

        by_reason = {}
        for row in safety_rows:
            reason = row["metadata"]["grav"]["reason"]
            by_reason.setdefault(reason, []).append(row)
        reasons = sorted(by_reason)
        reason_bucket_caches = order_cache.setdefault("route_reason_buckets", {})
        executable_cache = order_cache.setdefault("route_executable", {})
        executable_by_label = {}
        for row in executable_rows:
            label = row["metadata"]["grav"]["gold"]
            executable_by_label.setdefault(label, []).append(row)
        executable_labels = sorted(executable_by_label)
        executable_bucket_caches = order_cache.setdefault("route_executable_buckets", {})
        safety_per_step = route_rows_per_step // 2
        executable_per_step = route_rows_per_step - safety_per_step
        selected = []
        for m in range(safety_per_step):
            stream_index = step * safety_per_step + m
            cycle, offset = divmod(stream_index, len(reasons))
            reason_order = epoch_order(len(reasons), f"{seed}:route-reasons", cycle)
            reason = reasons[reason_order[offset]]
            bucket = by_reason[reason]
            bucket_cache = reason_bucket_caches.setdefault(reason, {})
            selected.append(bucket[row_for_step(bucket_cache, len(bucket), f"{seed}:route:reason:{reason}", cycle)])
        if route_sampling == "safety_reason_balanced":
            selected.extend(
                executable_rows[row_for_step(executable_cache, len(executable_rows), f"{seed}:route:executable",
                                             step * executable_per_step + m)]
                for m in range(executable_per_step)
            )
        else:
            # Generalisation correction: rare executable tools receive the same
            # number of turns as common tools while abstention remains balanced
            # by *reason*. This uses training metadata only; it never reads or
            # adapts to an individual locked example.
            for m in range(executable_per_step):
                stream_index = step * executable_per_step + m
                cycle, offset = divmod(stream_index, len(executable_labels))
                label_order = epoch_order(
                    len(executable_labels), f"{seed}:route-executable-labels", cycle
                )
                label = executable_labels[label_order[offset]]
                bucket = executable_by_label[label]
                bucket_cache = executable_bucket_caches.setdefault(label, {})
                selected.append(bucket[row_for_step(
                    bucket_cache, len(bucket), f"{seed}:route:executable:{label}", cycle
                )])
    selected.extend(
        argument_rows[row_for_step(argument_cache, len(argument_rows), f"{seed}:argument",
                                   step * argument_rows_per_step + m)]
        for m in range(argument_rows_per_step)
    )
    return selected


# ── determinism ──────────────────────────────────────────────────────────────
def set_determinism_env():
    """Must run before the first CUDA call in the process (cuBLAS reads it at handle creation)."""
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = CUBLAS_WORKSPACE


def configure_determinism(torch):
    """Strict: an operation with no deterministic implementation raises instead of drifting."""
    set_determinism_env()
    torch.use_deterministic_algorithms(True, warn_only=False)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    # SDPA: flash and memory-efficient backward accumulate with atomics; the
    # math kernel is a plain matmul/softmax chain. Sequences here are ≤ 246 tokens.
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    if hasattr(torch.backends.cuda, "enable_cudnn_sdp"):
        torch.backends.cuda.enable_cudnn_sdp(False)
    torch.backends.cuda.enable_math_sdp(True)
    return determinism_settings(torch)


def determinism_settings(torch) -> dict:
    cuda = torch.backends.cuda
    return {
        "use_deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        "deterministic_warn_only": torch.is_deterministic_algorithms_warn_only_enabled(),
        "cudnn_deterministic": torch.backends.cudnn.deterministic,
        "cudnn_benchmark": torch.backends.cudnn.benchmark,
        "matmul_allow_tf32": cuda.matmul.allow_tf32,
        "cudnn_allow_tf32": torch.backends.cudnn.allow_tf32,
        "sdp_flash": cuda.flash_sdp_enabled(),
        "sdp_mem_efficient": cuda.mem_efficient_sdp_enabled(),
        "sdp_cudnn": cuda.cudnn_sdp_enabled() if hasattr(cuda, "cudnn_sdp_enabled") else None,
        "sdp_math": cuda.math_sdp_enabled(),
        "cublas_workspace_config": os.environ.get("CUBLAS_WORKSPACE_CONFIG"),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "lr_scheduler": None,
        "grad_scaler": None,
    }


# ── RNG ──────────────────────────────────────────────────────────────────────
def capture_rng(torch) -> dict:
    try:
        import numpy as np
        np_state = np.random.get_state()
    except ImportError:
        np_state = None
    return {"python": random.getstate(), "numpy": np_state, "torch_cpu": torch.get_rng_state(),
            "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []}


def restore_rng(torch, rng):
    random.setstate(rng["python"])
    if rng.get("numpy") is not None:
        import numpy as np
        np.random.set_state(rng["numpy"])
    torch.set_rng_state(rng["torch_cpu"])
    visible = torch.cuda.device_count() if torch.cuda.is_available() else 0
    if len(rng["torch_cuda"]) != visible:
        raise ValueError(f"snapshot holds {len(rng['torch_cuda'])} CUDA RNG states, {visible} devices are visible")
    if visible:
        torch.cuda.set_rng_state_all(rng["torch_cuda"])


# ── parameters ───────────────────────────────────────────────────────────────
def trainable_state(model) -> dict:
    return {k: v.detach().cpu().clone() for k, v in model.named_parameters() if v.requires_grad}


def load_trainable(model, state, torch):
    live = {k: v for k, v in model.named_parameters() if v.requires_grad}
    if set(live) != set(state):
        raise ValueError("trainable parameter names differ")
    with torch.no_grad():
        for k, v in live.items():
            if state[k].shape != v.shape or state[k].dtype != v.dtype:
                raise ValueError(f"trainable parameter shape/dtype differs: {k}")
            v.copy_(state[k].to(v.device))


# ── one optimizer step ───────────────────────────────────────────────────────
def compute_gradients(model, rows_for_step, *, brier_weight, torch):
    """Forward + backward over one optimizer step's micro-batches. Returns (loss, tokens)."""
    accumulation = len(rows_for_step)
    loss_sum, tokens = 0.0, 0
    for row in rows_for_step:
        logits = model([row])[0].float()
        tokens += int(getattr(model, "last_input_tokens", 0))
        target = torch.tensor(row["target"], device=logits.device, dtype=torch.float32)
        loss = -(target * logits.log_softmax(-1)).sum() + brier_weight * ((logits.softmax(-1) - target) ** 2).sum()
        if not torch.isfinite(loss):
            raise FloatingPointError("non-finite loss; run invalid")
        (loss / accumulation).backward()
        loss_sum += loss.item() / accumulation
    return loss_sum, tokens


def train_step(model, optimizer, train_rows, *, step, accumulation, seed, brier_weight, order_cache, torch,
               route_rows_per_step=0, route_sampling="proportional"):
    """Optimizer step `step` (0-based) → record for step + 1."""
    optimizer.zero_grad(set_to_none=True)
    rows = rows_for_training_step(train_rows, step=step, accumulation=accumulation, seed=seed,
                                  route_rows_per_step=route_rows_per_step, order_cache=order_cache,
                                  route_sampling=route_sampling)
    loss, tokens = compute_gradients(model, rows, brier_weight=brier_weight, torch=torch)
    norm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
    if not torch.isfinite(norm):
        raise FloatingPointError("non-finite gradient; run invalid")
    optimizer.step()
    return {"step": step + 1, "loss": loss, "gradient_norm": norm.item(), "input_tokens": tokens}


def score_rows(model, rows, *, batch_rows, torch):
    """Inference-only scoring (validation, calibration). Uses no RNG and leaves the model in train mode."""
    model.eval()
    out = []
    with torch.inference_mode():
        for i in range(0, len(rows), batch_rows):
            for lg in model(rows[i:i + batch_rows]):
                out.append([float(x) for x in lg.float().cpu()])
    model.train()
    return out


def routing_safety_metrics(rows, logits):
    """Return aggregate validation abstention safety without exposing examples.

    An unsafe argmax is a routing row whose gold decision is ``unsupported``
    or ``clarify`` but whose predicted option is an executable tool. These
    validation-only metrics never replace the locked release gate.
    """
    abstentions = {"unsupported", "clarify"}
    safety_total = safety_correct = unsafe_argmax = 0
    reason_totals = {}
    reason_correct = {}
    for row, row_logits in zip(rows, logits):
        metadata = row.get("metadata", {})
        grav = metadata.get("grav", {})
        if metadata.get("question_id") != "route" or grav.get("gold") not in abstentions:
            continue
        safety_total += 1
        predicted_index = max(range(len(row_logits)), key=row_logits.__getitem__)
        predicted = row["options"][predicted_index].split(":", 1)[0].strip()
        correct = predicted == grav["gold"]
        safety_correct += int(correct)
        unsafe_argmax += int(predicted not in abstentions)
        reason = grav.get("reason")
        if isinstance(reason, str) and reason:
            reason_totals[reason] = reason_totals.get(reason, 0) + 1
            reason_correct[reason] = reason_correct.get(reason, 0) + int(correct)
    return {
        "validation_safety_rows": safety_total,
        "validation_safety_accuracy": safety_correct / max(1, safety_total),
        "validation_unsafe_argmax_routes": unsafe_argmax,
        "validation_safety_reason_accuracy": {
            reason: reason_correct.get(reason, 0) / total
            for reason, total in sorted(reason_totals.items())
        },
    }


def gradient_digest(model, torch) -> str:
    h = hashlib.sha256()
    for name, p in sorted(model.named_parameters()):
        if p.requires_grad and p.grad is not None:
            h.update(name.encode())
            h.update(p.grad.detach().float().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()


def determinism_preflight(model, rows, *, brier_weight, torch, repeats=3):
    """Run the same forward+backward `repeats` times from the same state and compare
    gradients bit for bit. Changes no weight and no RNG state. On CUDA this is the
    direct test of the failure the RunPod smoke run exposed."""
    rng = capture_rng(torch)
    losses, digests = [], []
    for _ in range(repeats):
        restore_rng(torch, rng)
        for p in model.parameters():
            p.grad = None
        loss, _ = compute_gradients(model, rows, brier_weight=brier_weight, torch=torch)
        losses.append(loss)
        digests.append(gradient_digest(model, torch))
    for p in model.parameters():
        p.grad = None
    restore_rng(torch, rng)
    return {"repeats": repeats, "rows": len(rows), "losses": losses, "gradient_sha256": digests,
            "identical": len(set(digests)) == 1 and len(set(losses)) == 1}


# ── snapshots ────────────────────────────────────────────────────────────────
def save_training_state(directory, *, step, accumulation, model, optimizer, extra, identity_sha, determinism, torch, keep=2):
    """Atomic snapshot at an optimizer boundary. Returns its path."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".incomplete-", dir=directory))
    try:
        state = {"step": step, "next_row_index": step * accumulation, "trainable": trainable_state(model),
                 "optimizer": optimizer.state_dict(), "rng": capture_rng(torch), "determinism": determinism, "extra": extra}
        torch.save(state, tmp / "training_state.pt")
        (tmp / "resume.json").write_text(json.dumps({
            "kind": "grav_training_resume_only", "inference_ready": False, "step": step,
            "next_row_index": step * accumulation, "identity_sha256": identity_sha,
            "determinism_sha256": json_sha256(determinism),
            "training_state_sha256": file_sha256(tmp / "training_state.pt")}, indent=2) + "\n")
        final = directory / f"step-{step:08d}"
        if final.exists():
            shutil.rmtree(final)
        os.replace(tmp, final)
        for old in sorted(directory.glob("step-*"))[:-keep]:
            shutil.rmtree(old)
        return final
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def load_training_state(snapshot, *, accumulation, model, optimizer, identity_sha, determinism, torch):
    """Verify, then restore parameters, optimizer and RNG. Returns (step, extra)."""
    snapshot = Path(snapshot)
    info = json.loads((snapshot / "resume.json").read_text())
    if info["identity_sha256"] != identity_sha:
        raise ValueError("resume snapshot belongs to a different run identity")
    if file_sha256(snapshot / "training_state.pt") != info["training_state_sha256"]:
        raise ValueError("resume snapshot tensor file checksum differs")
    if info.get("determinism_sha256") != json_sha256(determinism):
        raise ValueError("determinism settings differ from the run that wrote this snapshot")
    state = torch.load(snapshot / "training_state.pt", map_location="cpu", weights_only=False)
    if state["next_row_index"] != state["step"] * accumulation:
        raise ValueError("snapshot data cursor is not at an optimizer boundary")
    load_trainable(model, state["trainable"], torch)
    optimizer.load_state_dict(state["optimizer"])
    restore_rng(torch, state["rng"])
    return state["step"], state["extra"]
