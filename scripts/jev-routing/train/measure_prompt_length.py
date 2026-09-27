"""Report only aggregate token lengths across named dataset directories."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True); p.add_argument("--revision", required=True)
    p.add_argument("--open-jev", required=True); p.add_argument("--data", action="append", required=True)
    args = p.parse_args()
    sys.path.insert(0, args.open_jev)
    from transformers import AutoTokenizer
    from jev.api import candidate_prompts
    tokenizer = AutoTokenizer.from_pretrained(args.model, revision=args.revision)
    maximum = 0; rows = 0; candidates = 0
    for directory in args.data:
        for path in sorted(Path(directory).glob("*.jsonl")):
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line); rows += 1
                for prompt in candidate_prompts(row):
                    rendered = tokenizer.apply_chat_template(
                        [{"role": "user", "content": prompt}], tokenize=False,
                        add_generation_prompt=True, enable_thinking=False)
                    maximum = max(maximum, len(tokenizer(rendered, add_special_tokens=False)["input_ids"]))
                    candidates += 1
    print(json.dumps({"rows": rows, "candidates": candidates, "maximum_tokens": maximum}))


if __name__ == "__main__":
    main()
