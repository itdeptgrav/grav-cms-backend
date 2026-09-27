"""Deterministic-resume test: an interrupted-and-resumed run must equal an uninterrupted one.

    python -m unittest scripts/jev-routing/train/test_resume_equivalence.py     (needs torch; CPU is enough)

Every run is a separate Python process, so an "interruption" really ends the
process and the resumed run starts from nothing but its snapshot — exactly the
RunPod situation. The model is tiny but uses what the real trainer's state has
to survive: frozen base weights, LoRA-style trainable matrices and a scalar head,
dropout (torch RNG), a NumPy-random token drop (NumPy RNG), SDPA attention, two
AdamW parameter groups, gradient accumulation across an epoch boundary, and
validation passes between steps. Steps, snapshot, restore and the training step
itself are the production functions in train_core.py.

Equivalence is BITWISE: every per-step loss and gradient norm, the final
trainable parameters and the optimizer state must be identical — far inside the
runbook's 0.005 loss gate. Two negative controls prove the test can fail.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import torch
except ImportError:  # the pure-Python suite runs without torch; this one cannot
    torch = None

import train_core as core  # noqa: E402

N_ROWS, ACCUM, SEED = 23, 3, 20260925  # 23 rows / 3 per step → epochs end mid-step


def synthetic_rows(n=N_ROWS):
    rows = []
    for i in range(n):
        k = 3 + i % 4
        opts = [f"option {i} {j} {'alpha beta gamma'.split()[j % 3]}" for j in range(k)]
        target = [0.0] * k
        target[(i * 7) % k] = 1.0
        rows.append({"id": f"r{i}", "state": {"question": f"question number {i} about ledger {i % 5} and period {i % 3}"},
                     "question": "choose", "kind": "choice", "options": opts, "target": target})
    return rows


def build(dropout=0.1, nondeterministic=False):
    nn = torch.nn
    F = torch.nn.functional

    class Tiny(nn.Module):
        def __init__(self):
            super().__init__()
            g = torch.Generator().manual_seed(7)
            self.embed = nn.Embedding(512, 16)
            self.base = nn.Linear(16, 16)
            with torch.no_grad():
                self.embed.weight.copy_(torch.randn(512, 16, generator=g) * 0.5)
                self.base.weight.copy_(torch.randn(16, 16, generator=g) * 0.3)
                self.base.bias.zero_()
            self.embed.requires_grad_(False)
            self.base.requires_grad_(False)
            self.lora_A = nn.Parameter(torch.randn(4, 16, generator=g) * 0.1)
            self.lora_B = nn.Parameter(torch.randn(16, 4, generator=g) * 0.01)
            self.head = nn.Linear(16, 1)
            with torch.no_grad():
                self.head.weight.copy_(torch.randn(1, 16, generator=g) * 0.1)
                self.head.bias.zero_()
            self.drop = nn.Dropout(dropout)
            self.last_input_tokens = 0

        def forward(self, records):
            import numpy as np
            outs, tokens = [], 0
            for r in records:
                scores = []
                for opt in r["options"]:
                    words = (r["state"]["question"] + " | " + opt).split()
                    if self.training:  # NumPy RNG in the forward, as a data-side augmentation would use it
                        words = [w for w in words if np.random.rand() > 0.1] or words
                    ids = torch.tensor([zlib.crc32(w.encode()) % 512 for w in words])
                    tokens += len(words)
                    x = self.embed(ids)
                    h = self.base(x) + (x @ self.lora_A.T) @ self.lora_B.T
                    h = F.scaled_dot_product_attention(h[None], h[None], h[None], is_causal=True)[0]
                    h = self.drop(h)
                    s = self.head(h[-1]).squeeze(-1)
                    if nondeterministic:  # stands in for an atomic-add kernel: noise no seed controls
                        s = s * (1 + int.from_bytes(os.urandom(2), "little") * 1e-9)
                    scores.append(s)
                outs.append(torch.stack(scores))
            self.last_input_tokens = tokens
            return outs

    return Tiny()


def optimizer_for(model):
    return torch.optim.AdamW([
        {"params": [model.lora_A, model.lora_B], "lr": 5e-3},
        {"params": model.head.parameters(), "lr": 1e-2},
    ], weight_decay=0.01, betas=(0.9, 0.999), eps=1e-8)


def digest_state(model, optimizer):
    h = hashlib.sha256()
    for k, v in sorted(core.trainable_state(model).items()):
        h.update(k.encode())
        h.update(v.numpy().tobytes())
    for pid, st in sorted(optimizer.state_dict()["state"].items()):
        for k in sorted(st):
            v = st[k]
            h.update(f"{pid}.{k}".encode())
            h.update(v.detach().cpu().numpy().tobytes() if hasattr(v, "numpy") else repr(v).encode())
    return h.hexdigest()


def worker(spec):
    """One process: fresh start or resume, run to `stop`, maybe snapshot, write a log."""
    import numpy as np
    determinism = core.configure_determinism(torch)
    torch.manual_seed(SEED)
    np.random.seed(SEED % 2**32)
    import random
    random.seed(SEED)
    rows, val = synthetic_rows(), synthetic_rows(5)
    model = build()
    optimizer = optimizer_for(model)
    identity = core.json_sha256({"test": "resume-equivalence", "accum": ACCUM, "seed": SEED})
    start = 0
    if spec.get("resume"):
        start, _ = core.load_training_state(spec["resume"], accumulation=ACCUM, model=model, optimizer=optimizer,
                                            identity_sha=identity, determinism=determinism, torch=torch)
        if spec.get("skip_rng"):  # negative control: pretend RNG was not restored
            torch.manual_seed(12345)
            np.random.seed(12345)
        if spec.get("skip_optimizer"):  # negative control: pretend optimizer state was not restored
            optimizer = optimizer_for(model)
    model.train()
    order_cache, log = {}, []
    for step in range(start, spec["stop"]):
        rec = core.train_step(model, optimizer, rows, step=step, accumulation=ACCUM, seed=SEED,
                              brier_weight=0.1, order_cache=order_cache, torch=torch)
        log.append(rec)
        if (step + 1) % 4 == 0:  # validation between steps must not disturb anything
            core.score_rows(model, val, batch_rows=2, torch=torch)
        if spec.get("snapshot_at") == step + 1:
            core.save_training_state(spec["snapdir"], step=step + 1, accumulation=ACCUM, model=model, optimizer=optimizer,
                                     extra={"note": "test"}, identity_sha=identity, determinism=determinism, torch=torch)
            if spec.get("exit_after_snapshot"):
                break
    Path(spec["out"]).write_text(json.dumps({"log": log, "digest": digest_state(model, optimizer)}))


def run_worker(spec):
    subprocess.run([sys.executable, __file__, "worker", json.dumps(spec)], check=True, env={**os.environ, "PYTHONHASHSEED": "0"})
    return json.loads(Path(spec["out"]).read_text())


@unittest.skipIf(torch is None, "torch not installed; run inside the Open-Jev image or on the pod")
class ResumeEquivalence(unittest.TestCase):
    TOTAL = 14

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="jev-resume-"))

    def uninterrupted(self):
        return run_worker({"stop": self.TOTAL, "out": str(self.tmp / "full.json")})

    def interrupted(self, cuts, **flags):
        """Run to each cut, snapshot, EXIT the process; resume in a new process; repeat."""
        log, resume = [], None
        for i, cut in enumerate(cuts + [self.TOTAL]):
            spec = {"stop": cut, "out": str(self.tmp / f"part{i}.json"), "snapdir": str(self.tmp / "ckpt")}
            if resume:
                spec["resume"] = resume
                spec.update(flags)
            if cut != self.TOTAL:
                spec.update(snapshot_at=cut, exit_after_snapshot=True)
            part = run_worker(spec)
            log += part["log"]
            resume = str(self.tmp / "ckpt" / f"step-{cut:08d}")
        return {"log": log, "digest": part["digest"]}

    def assertIdentical(self, a, b):
        self.assertEqual(len(a["log"]), len(b["log"]))
        for x, y in zip(a["log"], b["log"]):
            self.assertEqual(x["input_tokens"], y["input_tokens"], x["step"])
            self.assertEqual(x["loss"], y["loss"], f"loss differs at step {x['step']}")
            self.assertEqual(x["gradient_norm"], y["gradient_norm"], f"gradient norm differs at step {x['step']}")
        self.assertEqual(a["digest"], b["digest"], "final parameters/optimizer state differ")

    def test_uninterrupted_runs_are_bitwise_repeatable(self):
        self.assertIdentical(self.uninterrupted(), run_worker({"stop": self.TOTAL, "out": str(self.tmp / "again.json")}))

    def test_resume_mid_epoch_equals_uninterrupted(self):
        self.assertIdentical(self.uninterrupted(), self.interrupted([5]))

    def test_resume_across_epoch_boundary_equals_uninterrupted(self):
        self.assertIdentical(self.uninterrupted(), self.interrupted([8]))

    def test_two_interruptions_equal_uninterrupted(self):
        self.assertIdentical(self.uninterrupted(), self.interrupted([4, 10]))

    def test_meets_runbook_gate(self):
        a, b = self.uninterrupted(), self.interrupted([7])
        diff = max(abs(x["loss"] - y["loss"]) for x, y in zip(a["log"], b["log"]))
        self.assertLess(diff, 5e-3)
        self.assertEqual(diff, 0.0)

    def test_negative_control_rng_not_restored_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assertIdentical(self.uninterrupted(), self.interrupted([5], skip_rng=True))

    def test_negative_control_optimizer_not_restored_is_detected(self):
        with self.assertRaises(AssertionError):
            self.assertIdentical(self.uninterrupted(), self.interrupted([5], skip_optimizer=True))


@unittest.skipIf(torch is None, "torch not installed")
class SnapshotGuards(unittest.TestCase):
    def setUp(self):
        core.configure_determinism(torch)
        self.model, self.tmp = build(), Path(tempfile.mkdtemp(prefix="jev-guard-"))
        self.opt = optimizer_for(self.model)
        self.det = core.determinism_settings(torch)
        self.snap = core.save_training_state(self.tmp, step=3, accumulation=ACCUM, model=self.model, optimizer=self.opt,
                                             extra={}, identity_sha="a" * 64, determinism=self.det, torch=torch)

    def test_other_identity_refused(self):
        with self.assertRaisesRegex(ValueError, "different run identity"):
            core.load_training_state(self.snap, accumulation=ACCUM, model=self.model, optimizer=self.opt, identity_sha="b" * 64, determinism=self.det, torch=torch)

    def test_other_determinism_refused(self):
        with self.assertRaisesRegex(ValueError, "determinism settings differ"):
            core.load_training_state(self.snap, accumulation=ACCUM, model=self.model, optimizer=self.opt, identity_sha="a" * 64, determinism={**self.det, "sdp_flash": True}, torch=torch)

    def test_tampered_snapshot_refused(self):
        with open(self.snap / "training_state.pt", "ab") as fh:
            fh.write(b"x")
        with self.assertRaisesRegex(ValueError, "checksum"):
            core.load_training_state(self.snap, accumulation=ACCUM, model=self.model, optimizer=self.opt, identity_sha="a" * 64, determinism=self.det, torch=torch)

    def test_other_accumulation_refused(self):
        with self.assertRaisesRegex(ValueError, "optimizer boundary"):
            core.load_training_state(self.snap, accumulation=ACCUM + 1, model=self.model, optimizer=self.opt, identity_sha="a" * 64, determinism=self.det, torch=torch)

    def test_settings_record_what_was_enforced(self):
        self.assertTrue(self.det["use_deterministic_algorithms"])
        self.assertFalse(self.det["deterministic_warn_only"])
        self.assertFalse(self.det["sdp_flash"])
        self.assertFalse(self.det["sdp_mem_efficient"])
        self.assertTrue(self.det["sdp_math"])
        self.assertEqual(self.det["cublas_workspace_config"], ":4096:8")


@unittest.skipIf(torch is None, "torch not installed")
class SnapshotMetadata(unittest.TestCase):
    def test_metadata_describes_without_shipping_values(self):
        core.configure_determinism(torch)
        m, tmp = build(), Path(tempfile.mkdtemp(prefix="jev-meta-"))
        opt = optimizer_for(m)
        core.train_step(m, opt, synthetic_rows(), step=0, accumulation=ACCUM, seed=SEED, brier_weight=0.1, order_cache={}, torch=torch)
        snap = core.save_training_state(tmp, step=1, accumulation=ACCUM, model=m, optimizer=opt, extra={"best": {"step": 0}, "history": []},
                                        identity_sha="a" * 64, determinism=core.determinism_settings(torch), torch=torch)
        out = subprocess.run([sys.executable, str(HERE / "snapshot_meta.py"), str(snap)], check=True, capture_output=True, text=True).stdout
        meta = json.loads(out)
        self.assertEqual(meta["step"], 1)
        self.assertEqual(meta["next_row_index"], ACCUM)
        self.assertEqual(set(meta["trainable"]), set(core.trainable_state(m)))
        self.assertTrue(all(len(v["sha256"]) == 64 for v in meta["trainable"].values()))
        self.assertTrue(meta["optimizer"]["state"])
        self.assertLess(len(out), 20000, "metadata must stay small: digests, not tensors")
        self.assertNotIn("tensor(", out)


@unittest.skipIf(torch is None, "torch not installed")
class Preflight(unittest.TestCase):
    def test_deterministic_model_passes(self):
        core.configure_determinism(torch)
        m = build()
        m.train()
        res = core.determinism_preflight(m, synthetic_rows()[:ACCUM], brier_weight=0.1, torch=torch)
        self.assertTrue(res["identical"], res)
        self.assertTrue(all(p.grad is None for p in m.parameters()))

    def test_nondeterministic_backward_is_caught(self):
        core.configure_determinism(torch)
        m = build(nondeterministic=True)
        m.train()
        res = core.determinism_preflight(m, synthetic_rows()[:ACCUM], brier_weight=0.1, torch=torch)
        self.assertFalse(res["identical"], res)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "worker":
        worker(json.loads(sys.argv[2]))
    else:
        unittest.main()
