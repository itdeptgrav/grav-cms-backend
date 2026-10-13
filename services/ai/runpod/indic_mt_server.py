#!/usr/bin/env python3
"""
GRAV voice translation on the RunPod GPU — IndicTrans2 (AI4Bharat),
Indic → English, distilled 200M. Runs beside the speech server
(indic_stt_server.py) so a spoken Hindi or Odia command can be answered by
Cmd/Ctrl K, which reads English.

  GET  /health     -> {"ok": true, "model": "indictrans2-indic-en-dist-200M"}
  POST /translate  -> {"english": "..."}
       body JSON: {"text": "रवि कुमार की छुट्टी कितनी बची है", "lang": "hi"}
       lang: "hi" (Hindi, Devanagari) or "or" (Odia)

127.0.0.1 ONLY — the speech server calls it on the pod; nothing is exposed.
Lives in /root/grav-voice-mt (venv there: transformers 4.46 for the model's
own code, IndicTransToolkit for its pre/post-processing); weights in
/workspace/hf-cache.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_CACHE", "/workspace/hf-cache/hub")  # NOT HF_HOME: that also moves the sign-in token

import torch  # noqa: E402
from IndicTransToolkit.processor import IndicProcessor  # noqa: E402
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer  # noqa: E402

MODEL = "ai4bharat/indictrans2-indic-en-dist-200M"
PORT = int(os.environ.get("GRAV_MT_PORT", "19058"))
SRC = {"hi": "hin_Deva", "or": "ory_Orya"}

print(f"[grav-indic-mt] loading {MODEL} ...", flush=True)
t0 = time.time()
TOK = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
NET = AutoModelForSeq2SeqLM.from_pretrained(MODEL, trust_remote_code=True, torch_dtype=torch.float16).to("cuda").eval()
IP = IndicProcessor(inference=True)
LOCK = threading.Lock()


def translate(text: str, lang: str) -> str:
    src = SRC[lang]
    batch = IP.preprocess_batch([text], src_lang=src, tgt_lang="eng_Latn")
    enc = TOK(batch, truncation=True, padding="longest", return_tensors="pt", return_attention_mask=True).to("cuda")
    with LOCK, torch.inference_mode():
        out = NET.generate(**enc, use_cache=True, min_length=0, max_length=128, num_beams=4, num_return_sequences=1)
    decoded = TOK.batch_decode(out.detach().cpu().tolist(), skip_special_tokens=True, clean_up_tokenization_spaces=True)
    return IP.postprocess_batch(decoded, lang="eng_Latn")[0].strip()


translate("नमस्ते", "hi")  # warm before ready
print(f"[grav-indic-mt] ready in {time.time() - t0:.1f}s on 127.0.0.1:{PORT}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("[grav-indic-mt] " + (fmt % args) + "\n")
        sys.stdout.flush()

    def _json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": "indictrans2-indic-en-dist-200M"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/translate":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            text, lang = str(body.get("text") or "").strip(), str(body.get("lang") or "")
            if not text or lang not in SRC:
                return self._json(400, {"error": "text and lang (hi|or) are required"})
            t = time.time()
            english = translate(text[:500], lang)
            return self._json(200, {"english": english, "ms": int((time.time() - t) * 1000)})
        except Exception as err:  # noqa: BLE001
            print(f"[grav-indic-mt] error: {err!r}", flush=True)
            return self._json(500, {"error": "translation failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
