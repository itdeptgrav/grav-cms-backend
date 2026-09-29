"""Describe a training snapshot for diagnosis without shipping its weights.

    python snapshot_meta.py <training-checkpoints/step-XXXXXXXX> > meta.json

Emits names, shapes, dtypes and SHA-256 digests of every trainable tensor and
optimizer moment, per-parameter optimizer step counts, learning rates, digests of
each RNG state, the data cursor, the determinism settings and the resume.json
binding. Digests let two snapshots be compared bit for bit (e.g. the original and
resumed run at step 100) while no tensor value leaves the pod.
"""
import hashlib
import json
import sys
from pathlib import Path


def digest(t) -> str:
    return hashlib.sha256(t.detach().cpu().contiguous().numpy().tobytes()).hexdigest()


def main(path):
    import torch
    snap = Path(path)
    info = json.loads((snap / "resume.json").read_text())
    state = torch.load(snap / "training_state.pt", map_location="cpu", weights_only=False)
    trainable = {k: {"shape": list(v.shape), "dtype": str(v.dtype), "sha256": digest(v)} for k, v in sorted(state["trainable"].items())}
    opt = state["optimizer"]
    moments = {}
    for pid, st in sorted(opt["state"].items()):
        moments[str(pid)] = {k: ({"shape": list(v.shape), "dtype": str(v.dtype), "sha256": digest(v)} if hasattr(v, "shape") and v.dim() > 0
                                 else float(v)) for k, v in sorted(st.items())}
    rng = state["rng"]
    rng_digest = {
        "python": hashlib.sha256(repr(rng["python"]).encode()).hexdigest(),
        "numpy": hashlib.sha256(repr(rng["numpy"]).encode()).hexdigest() if rng.get("numpy") is not None else None,
        "torch_cpu": digest(rng["torch_cpu"]),
        "torch_cuda": [digest(x) for x in rng["torch_cuda"]],
    }
    whole = hashlib.sha256()
    for k in sorted(trainable):
        whole.update(trainable[k]["sha256"].encode())
    out = {"snapshot": snap.name, "resume_json": info, "step": state["step"], "next_row_index": state["next_row_index"],
           "determinism": state["determinism"], "trainable_parameters": len(trainable),
           "trainable_digest": whole.hexdigest(), "trainable": trainable,
           "optimizer": {"param_groups": [{k: v for k, v in g.items() if k != "params"} | {"n_params": len(g["params"])} for g in opt["param_groups"]],
                         "state": moments},
           "rng_sha256": rng_digest,
           "extra": {"best_step": (state["extra"].get("best") or {}).get("step"), "evals_without_gain": state["extra"].get("evals_without_gain"),
                     "history": state["extra"].get("history"), "elapsed_seconds": state["extra"].get("elapsed_seconds")}}
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main(sys.argv[1])
