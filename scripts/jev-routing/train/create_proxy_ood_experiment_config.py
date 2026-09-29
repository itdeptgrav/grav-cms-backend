"""Create the immutable fresh-9B proxy-OOD experiment config after data build."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from grav_jev_train import file_sha256, load_config


def create_config(base_path, train_view_manifest_sha256: str, output_path) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", train_view_manifest_sha256):
        raise ValueError("augmented training-view manifest must be a SHA-256")
    base = load_config(base_path)
    if base["base_model"] != "Qwen/Qwen3.5-9B" or base["initialization_mode"] != "fresh":
        raise ValueError("proxy-OOD experiment must use the pinned fresh 9B initialization")
    config = {
        **base,
        "name": "grav-acc-routing-v9-qwen35-9b-proxy-ood",
        "train_view_manifest_sha256": train_view_manifest_sha256,
        "route_sampling": "proportional",
        "selection_metric": "validation_proxy_ood_robustness",
        "validation_rows": 0,
    }
    output = Path(output_path)
    if output.exists():
        raise ValueError("experiment config already exists; immutable configs are never overwritten")
    output.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")
    load_config(output)
    return {"config": config, "config_sha256": file_sha256(output)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--train-view-manifest-sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    result = create_config(args.base, args.train_view_manifest_sha256, args.output)
    print(json.dumps({"name": result["config"]["name"], "config_sha256": result["config_sha256"]}, sort_keys=True))


if __name__ == "__main__":
    main()

