"""Create and verify a truthful, deterministic fresh Open-Jev initialization.

This is deliberately not an Open-Jev inference warm start.  It records step
zero, saves exactly the freshly constructed LoRA/head tensors, and binds their
digest to the pinned base model, immutable revision, runtime and source code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from train_core import configure_determinism, file_sha256, json_sha256, set_determinism_env  # noqa: E402


def source_commit(path: Path) -> str:
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()


def trainable_digest(model, torch) -> str:
    """Hash names and exact bytes of every trainable tensor in stable order."""
    h = hashlib.sha256()
    found = 0
    for name, value in sorted(model.named_parameters()):
        if not value.requires_grad:
            continue
        found += 1
        tensor = value.detach().cpu().contiguous()
        header = json.dumps({"name": name, "shape": list(tensor.shape), "dtype": str(tensor.dtype)},
                            sort_keys=True, separators=(",", ":")).encode()
        h.update(len(header).to_bytes(8, "big")); h.update(header)
        raw = tensor.view(torch.uint8).numpy().tobytes()
        h.update(len(raw).to_bytes(8, "big")); h.update(raw)
    if not found:
        raise ValueError("fresh initialization has no trainable tensors")
    return h.hexdigest()


def package_manifest(package: Path, identity: dict) -> dict:
    files = {}
    for path in sorted(package.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            rel = path.relative_to(package).as_posix()
            files[rel] = {"sha256": file_sha256(path), "bytes": path.stat().st_size}
    manifest = {"schema_version": 1, "kind": "fresh_open_jev_initialization",
                "identity": identity, "files": files}
    (package / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def read_fresh_initialization_package(package, expected_manifest_sha256, model, revision,
                                      lora_rank, max_length, seed) -> dict:
    package = Path(package)
    manifest_path = package / "manifest.json"
    if file_sha256(manifest_path) != expected_manifest_sha256:
        raise ValueError("fresh initialization manifest differs from the pinned hash")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema_version") != 1 or manifest.get("kind") != "fresh_open_jev_initialization":
        raise ValueError("not a fresh Open-Jev initialization package")
    expected = {"model": model, "revision": revision, "lora_rank": lora_rank,
                "max_length": max_length, "seed": seed}
    identity = manifest.get("identity", {})
    for key, value in expected.items():
        if identity.get(key) != value:
            raise ValueError(f"fresh initialization {key} differs")
    required = {"checkpoint/model.json", "checkpoint/head.pt",
                "checkpoint/adapter/adapter_config.json", "checkpoint/adapter/adapter_model.safetensors",
                "checkpoint/temperature.json", "provenance.json"}
    if not required.issubset(manifest.get("files", {})):
        raise ValueError("fresh initialization package is incomplete")
    for rel, entry in manifest["files"].items():
        path = package / rel
        if not path.is_file() or file_sha256(path) != entry.get("sha256") or path.stat().st_size != entry.get("bytes"):
            raise ValueError(f"fresh initialization file differs: {rel}")
    provenance = json.loads((package / "provenance.json").read_text())
    if provenance.get("initialization", {}).get("kind") != "fresh_base_model" or provenance.get("training_steps") != 0:
        raise ValueError("fresh initialization provenance is not truthful step-zero provenance")
    if provenance.get("identity_sha256") != json_sha256(identity):
        raise ValueError("fresh initialization identity digest differs")
    if provenance.get("trainable_sha256") != identity.get("trainable_sha256"):
        raise ValueError("fresh initialization tensor digest differs")
    return provenance


def run(args):
    out = Path(args.output)
    if out.exists() and any(out.iterdir()):
        raise ValueError("fresh initialization output must be empty")
    open_jev = Path(args.open_jev).resolve()
    commit = source_commit(open_jev)
    if commit != args.open_jev_commit:
        raise ValueError(f"Open-Jev checkout is {commit}, expected {args.open_jev_commit}")
    if os.environ.get("JEV_LOAD_4BIT") or os.environ.get("JEV_LOAD_8BIT"):
        raise ValueError("fresh initialization refuses quantization")
    from runtime_attest import bound_changes, capture, attestation_sha256
    attestation = json.loads(Path(args.runtime_attestation).read_text())
    if not attestation.get("accepted"):
        raise ValueError("runtime attestation was not accepted")
    changes = bound_changes(attestation["runtime"], capture())
    if changes:
        raise RuntimeError(f"runtime changed since attestation: {changes}")
    attestation_sha = attestation_sha256(attestation["runtime"])

    set_determinism_env()
    import torch
    sys.path.insert(0, str(open_jev))
    from jev.model import DecisionModel
    determinism = configure_determinism(torch)
    random.seed(args.seed); torch.manual_seed(args.seed)
    try:
        import numpy as np
        np.random.seed(args.seed % 2**32)
    except ImportError:
        pass
    torch.cuda.reset_peak_memory_stats()
    model = DecisionModel(args.model, args.revision, device=args.device,
                          lora_rank=args.lora_rank, max_length=args.max_length)
    digest = trainable_digest(model, torch)
    checkpoint = out / "checkpoint"
    model.save(checkpoint)
    (checkpoint / "temperature.json").write_text(json.dumps({
        "temperature": 1.0, "split": "unfitted_baseline", "n": 0,
    }, indent=2) + "\n")
    identity = {"model": args.model, "revision": args.revision, "lora_rank": args.lora_rank,
                "max_length": args.max_length, "seed": args.seed, "trainable_sha256": digest,
                "open_jev_commit": commit, "runtime_attestation_sha256": attestation_sha,
                "determinism": determinism, "creator_sha256": file_sha256(__file__),
                "trainer_core_sha256": file_sha256(HERE / "train_core.py")}
    provenance = {"schema_version": 1, "initialization": {"kind": "fresh_base_model"},
                  "training_steps": 0, "identity_sha256": json_sha256(identity),
                  "trainable_sha256": digest, "runtime_attestation_sha256": attestation_sha,
                  "peak_allocated_gib": torch.cuda.max_memory_allocated() / 2**30,
                  "peak_reserved_gib": torch.cuda.max_memory_reserved() / 2**30}
    (out / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    for source, target in ((open_jev / "third_party" / "qwen" / "LICENSE", out / "LICENSE"),
                           (open_jev / "LICENSE", out / "LICENSE-CODE")):
        shutil.copyfile(source, target)
    manifest = package_manifest(out, identity)
    print(json.dumps({"event": "fresh_initialization_complete", "manifest_sha256": file_sha256(out / "manifest.json"),
                      "trainable_sha256": digest, "peak_allocated_gib": provenance["peak_allocated_gib"],
                      "peak_reserved_gib": provenance["peak_reserved_gib"], "files": len(manifest["files"])}))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True); p.add_argument("--revision", required=True)
    p.add_argument("--open-jev", required=True); p.add_argument("--open-jev-commit", required=True)
    p.add_argument("--runtime-attestation", required=True); p.add_argument("--output", required=True)
    p.add_argument("--lora-rank", type=int, default=8); p.add_argument("--max-length", type=int, required=True)
    p.add_argument("--seed", type=int, required=True); p.add_argument("--device", default="cuda:0")
    run(p.parse_args(argv))


if __name__ == "__main__":
    main()
