"""Runtime attestation for the RTX PRO 4500 Blackwell experiment.

    python runtime_attest.py capture --profile HARDWARE_PROFILE.json --out attestation.json
    python runtime_attest.py verify  --bound attestation.json

`capture` records the exact runtime, checks it against the hardware profile and
runs a small deterministic CUDA self-test (forward + backward twice, bit-identical)
so an unsupported Blackwell / driver / PyTorch / CUDA combination stops before any
model is loaded. `verify` re-captures and refuses if any bound field changed —
every later phase calls it, and the attestation's SHA-256 is part of the
training run identity, so snapshots are bound to it as well.

Identity is decided by the NVIDIA device name AND the compute capability AND the
visible memory, never by a display name alone. The pure functions (name
normalisation, profile checks, bound-field comparison) import nothing heavy and
are unit-tested locally; capture needs torch, CUDA and nvidia-smi and fails
closed without them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BOUND_FIELDS = (
    "gpu_count", "gpu_name", "gpu_uuid", "driver_version", "compute_capability", "vram_total_mib",
    "torch", "torch_cuda", "cudnn", "arch_list", "transformers", "peft",
    "triton", "fla_core", "flash_linear_attention", "causal_conv1d",
)


# ── pure ─────────────────────────────────────────────────────────────────────
def normalise_name(name: str) -> str:
    s = re.sub(r"[^A-Z0-9]+", " ", str(name).upper()).strip()
    s = re.sub(r"^NVIDIA ", "", s)
    return re.sub(r"\s+", " ", s)


def name_problems(name: str, profile: dict) -> list[str]:
    norm = normalise_name(name)
    for bad in profile["reject_name_tokens"]:
        if re.search(rf"(^| ){re.escape(bad)}( |$)", norm):
            return [f"hardware: GPU '{name}' is rejected ({bad}): this experiment is only for {profile['display_name']}"]
    if not any(re.fullmatch(p, norm) for p in profile["accept_name_patterns"]):
        return [f"hardware: GPU '{name}' is not an accepted {profile['display_name']} name"]
    return []


def driver_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:2]) or (0,)


def profile_problems(att: dict, profile: dict) -> list[str]:
    p = []
    if att.get("gpu_count") != 1 or att.get("torch_device_count") != 1:
        p.append(f"hardware: exactly one GPU required; nvidia-smi sees {att.get('gpu_count')}, torch sees {att.get('torch_device_count')}")
    p += name_problems(att.get("gpu_name", ""), profile)
    if att.get("torch_device_name") and normalise_name(att["torch_device_name"]) != normalise_name(att.get("gpu_name", "")):
        p.append(f"hardware: torch and nvidia-smi disagree on the device: {att['torch_device_name']} vs {att.get('gpu_name')}")
    if att.get("compute_capability") != profile["compute_capability"]:
        p.append(f"hardware: compute capability {att.get('compute_capability')} is not {profile['compute_capability']} (Blackwell sm_120)")
    if (att.get("vram_total_mib") or 0) < profile["min_vram_mib"]:
        p.append(f"hardware: visible VRAM {att.get('vram_total_mib')} MiB is below {profile['min_vram_mib']} MiB")
    if driver_tuple(att.get("driver_version", "")) < tuple(profile["min_driver"]):
        p.append(f"runtime: driver {att.get('driver_version')} is older than {'.'.join(map(str, profile['min_driver']))}: unsupported Blackwell runtime for CUDA {profile['torch_cuda']}")
    if profile["required_arch"] not in (att.get("arch_list") or []):
        p.append(f"runtime: PyTorch build {att.get('torch')} has no {profile['required_arch']} kernels (arch list {att.get('arch_list')}): unsupported Blackwell runtime")
    for k in ("torch", "torch_cuda", "transformers", "peft"):
        if att.get(k) != profile[k]:
            p.append(f"runtime: {k} {att.get(k)} differs from the pinned {profile[k]}; dependencies are never upgraded silently")
    for k, expected in profile.get("pinned_packages", {}).items():
        if att.get(k) != expected:
            p.append(f"runtime: {k} {att.get(k)} differs from the pinned {expected}; fused kernels are never upgraded silently")
    st = att.get("cuda_self_test") or {}
    if not st.get("ok"):
        p.append(f"runtime: CUDA self-test failed: {st.get('error', 'not run')}")
    elif not st.get("bit_identical"):
        p.append("runtime: CUDA self-test: two deterministic backward passes differed")
    return p


def bound_view(att: dict) -> dict:
    return {k: att.get(k) for k in BOUND_FIELDS}


def bound_changes(bound: dict, live: dict) -> dict:
    return {k: (bound.get(k), live.get(k)) for k in BOUND_FIELDS if bound.get(k) != live.get(k)}


def attestation_sha256(att: dict) -> str:
    return hashlib.sha256(json.dumps(bound_view(att), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ── capture (needs the pod) ──────────────────────────────────────────────────
def _smi(query: str) -> list[list[str]]:
    out = subprocess.check_output(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"], text=True, timeout=60)
    return [[c.strip() for c in line.split(",")] for line in out.strip().splitlines() if line.strip()]


def cuda_self_test(torch) -> dict:
    """Tiny deterministic forward/backward twice on the GPU under the trainer's settings."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from train_core import configure_determinism
        configure_determinism(torch)
        digests = []
        for _ in range(2):
            g = torch.Generator(device="cuda").manual_seed(1)
            x = torch.randn(64, 128, device="cuda", dtype=torch.bfloat16, generator=g, requires_grad=True)
            w = torch.randn(128, 128, device="cuda", dtype=torch.bfloat16, generator=g, requires_grad=True)
            q = (x @ w).float().view(1, 1, 64, 128)
            y = torch.nn.functional.scaled_dot_product_attention(q, q, q, is_causal=True).sum()
            y.backward()
            torch.cuda.synchronize()
            digests.append(hashlib.sha256(w.grad.float().cpu().numpy().tobytes() + x.grad.float().cpu().numpy().tobytes()).hexdigest())
        return {"ok": True, "bit_identical": digests[0] == digests[1], "gradient_sha256": digests}
    except Exception as err:  # noqa: BLE001 — any failure here is the finding
        return {"ok": False, "error": f"{type(err).__name__}: {err}"[:500]}


def capture() -> dict:
    fake = os.environ.get("JEV_TEST_FAKE_RUNTIME")  # test seam: the local stop-condition suite has no GPU
    if fake:
        return json.loads(Path(fake).read_text())
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from train_core import set_determinism_env
    set_determinism_env()  # cuBLAS reads CUBLAS_WORKSPACE_CONFIG when CUDA first initialises
    import torch
    from importlib.metadata import PackageNotFoundError, version
    def package_version(name):
        try:
            return version(name)
        except PackageNotFoundError:
            return None
    rows = _smi("name,uuid,driver_version,memory.total")
    att = {
        "gpu_count": len(rows),
        "gpu_name": rows[0][0] if rows else None,
        "gpu_uuid": rows[0][1] if rows else None,
        "driver_version": rows[0][2] if rows else None,
        "vram_total_mib": int(float(rows[0][3])) if rows else None,
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else None,
        "arch_list": torch.cuda.get_arch_list() if torch.cuda.is_available() else [],
        "transformers": version("transformers"),
        "peft": version("peft"),
        "triton": package_version("triton"),
        "fla_core": package_version("fla-core"),
        "flash_linear_attention": package_version("flash-linear-attention"),
        "causal_conv1d": package_version("causal-conv1d"),
        "python": sys.version.split()[0],
        "torch_device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }
    if torch.cuda.is_available() and torch.cuda.device_count() >= 1:
        props = torch.cuda.get_device_properties(0)
        att["torch_device_name"] = props.name
        att["compute_capability"] = f"{props.major}.{props.minor}"
        att["torch_total_memory_mib"] = props.total_memory // 2**20
        att["cuda_self_test"] = cuda_self_test(torch)
    else:
        att["compute_capability"] = None
        att["cuda_self_test"] = {"ok": False, "error": "torch.cuda.is_available() is False"}
    return att


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("capture")
    c.add_argument("--profile", required=True)
    c.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--bound", required=True)
    a = ap.parse_args(argv)
    try:
        live = capture()
    except Exception as err:  # noqa: BLE001 — no nvidia-smi / torch / CUDA: fail closed
        print(json.dumps({"attestation": "failed", "error": f"{type(err).__name__}: {err}"[:500]}))
        return 3
    if a.cmd == "capture":
        profile = json.loads(Path(a.profile).read_text())
        problems = profile_problems(live, profile)
        doc = {"profile": profile["id"], "runtime": live, "bound_fields": list(BOUND_FIELDS),
               "bound_sha256": attestation_sha256(live), "problems": problems, "accepted": not problems}
        Path(a.out).write_text(json.dumps(doc, indent=2) + "\n")
        print(json.dumps({"accepted": not problems, "problems": problems, "gpu": live.get("gpu_name"),
                          "compute_capability": live.get("compute_capability"), "bound_sha256": doc["bound_sha256"]}))
        return 0 if not problems else 2
    bound = json.loads(Path(a.bound).read_text())
    if not bound.get("accepted"):
        print(json.dumps({"verified": False, "error": "bound attestation was never accepted"}))
        return 2
    changes = bound_changes(bound["runtime"], live)
    print(json.dumps({"verified": not changes, "changed": changes}))
    return 0 if not changes else 4


if __name__ == "__main__":
    sys.exit(main())
