"""Minimal static-graph IndicTrans2 inference.

The ONNX bundle is data-only. This adapter intentionally does not import or
execute Python supplied by a model repository. Its greedy decoding follows the
MIT-licensed indictrans2-onnx-export reference implementation.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from huggingface_hub import snapshot_download
from IndicTransToolkit import IndicProcessor
from tokenizers import Tokenizer


def _past_feed(values: list[np.ndarray], layers: int) -> dict[str, np.ndarray]:
    feed: dict[str, np.ndarray] = {}
    for index in range(layers):
        offset = index * 4
        feed[f"past_key_values.{index}.decoder.key"] = values[offset]
        feed[f"past_key_values.{index}.decoder.value"] = values[offset + 1]
        feed[f"past_key_values.{index}.encoder.key"] = values[offset + 2]
        feed[f"past_key_values.{index}.encoder.value"] = values[offset + 3]
    return feed


class IndicTransOnnx:
    def __init__(self, model_path: str) -> None:
        path = Path(model_path)
        if not path.is_dir():
            path = Path(snapshot_download(repo_id=model_path))
        self.processor = IndicProcessor(inference=True)
        self.source_tokenizer = Tokenizer.from_file(str(path / "tokenizer_src.json"))
        self.target_tokenizer = Tokenizer.from_file(str(path / "tokenizer_tgt.json"))
        self.metadata = json.loads((path / "tokenizer_meta.json").read_text(encoding="utf-8"))
        generation = json.loads((path / "generation_config.json").read_text(encoding="utf-8"))
        self.decoder_start_id = int(generation.get("decoder_start_token_id", 2))
        self.eos_id = int(generation.get("eos_token_id", 2))
        providers = ["CPUExecutionProvider"]
        self.encoder = ort.InferenceSession(str(path / "encoder_model.onnx"), providers=providers)
        self.decoder = ort.InferenceSession(str(path / "decoder_model.onnx"), providers=providers)
        self.decoder_with_past = ort.InferenceSession(
            str(path / "decoder_with_past_model.onnx"),
            providers=providers,
        )
        self.layers = (len(self.decoder.get_outputs()) - 1) // 4

    def translate(self, text: str, target_language: str, max_new_tokens: int = 128) -> str:
        placeholder_maps = getattr(self.processor, "_placeholder_entity_maps", None)
        if placeholder_maps is not None:
            placeholder_maps.queue.clear()
        prepared = self.processor.preprocess_batch(
            [text],
            src_lang="eng_Latn",
            tgt_lang=target_language,
        )[0]
        encoded = self.source_tokenizer.encode(prepared)
        source_size = int(self.metadata["src_dict_size"])
        unknown = int(self.metadata["unk_id"])
        input_ids = np.array(
            [[token if token < source_size else unknown for token in encoded.ids]],
            dtype=np.int64,
        )
        attention_mask = np.array([encoded.attention_mask], dtype=np.int64)
        encoder_output = self.encoder.run(
            ["last_hidden_state"],
            {"input_ids": input_ids, "attention_mask": attention_mask},
        )[0]
        decoder_input = np.array([[self.decoder_start_id]], dtype=np.int64)
        output_ids = [self.decoder_start_id]
        past: list[np.ndarray] | None = None
        for step in range(max_new_tokens):
            if step == 0:
                outputs = self.decoder.run(
                    None,
                    {
                        "input_ids": decoder_input,
                        "encoder_hidden_states": encoder_output,
                        "encoder_attention_mask": attention_mask,
                    },
                )
            else:
                outputs = self.decoder_with_past.run(
                    None,
                    {
                        "input_ids": decoder_input,
                        "encoder_attention_mask": attention_mask,
                        **_past_feed(past or [], self.layers),
                    },
                )
            next_token = int(np.argmax(outputs[0][0, -1, :]))
            past = list(outputs[1:])
            output_ids.append(next_token)
            if next_token == self.eos_id:
                break
            decoder_input = np.array([[next_token]], dtype=np.int64)
        target_size = int(self.metadata["tgt_dict_size"])
        safe_ids = [token if token < target_size else unknown for token in output_ids]
        decoded = self.target_tokenizer.decode(safe_ids, skip_special_tokens=True)
        return self.processor.postprocess_batch([decoded], lang=target_language)[0]
