# MRF LiveKit voice worker

This is a deterministic, self-hosted speech worker for MRF approvals. LiveKit
carries WebRTC audio only. It does not dial a phone number and it does not use
Plivo or an LLM.

The browser's authenticated session remains the approval authority. The worker
classifies a fixed set of phrases through the backend, asks for an explicit
second-turn confirmation, and then the browser submits the existing
`tl-approve` or `tl-reject` command. “Later”, uncertainty, disconnects and no
answer never mutate the MRF.

## Pod processes

1. `speech_gateway.py` serves the existing GRAV Speech / Indic-Transcribe Flex
   STT engine and Kokoro English TTS on pod-local port 8890. It proxies Hindi
   synthesis to the private Chatterbox gateway and Odia synthesis to Indic
   Parler. The OpenAI-shaped
   endpoints are only a compatibility boundary for the LiveKit SDK; Whisper is
   not downloaded or used.
2. `indic_gateway.py` serves AI4Bharat Indic Parler-TTS on pod-local port 8892
   in an isolated virtual environment. It streams 24 kHz PCM as OpenAI-style
   SSE audio deltas so LiveKit can begin playout before the sentence finishes.
   for Odia with the Debjani voice.
3. `hindi_gateway.py` serves Resemble AI's dedicated Hindi Chatterbox V3 model
   on pod-local port 8894 with its native-Hindi female reference voice.
4. `dialog_gateway.py` serves a pod-private 4-bit Qwen3 4B Instruct model for
   greetings, bounded questions and interruption recovery. It returns spoken
   text only and has no MRF mutation capability.
5. `worker.py start` registers the named LiveKit worker and joins only explicit
   MRF dispatches.

Copy `.env.example` to a private environment file, fill the LiveKit/backend
values, then run:

```bash
uvicorn speech_gateway:app --host 127.0.0.1 --port 8890
python worker.py start
```

On the GRAV RunPod, `runpod-start.sh` recreates the disposable `/tmp` main and
Indic Parler virtual environments when necessary and starts all processes. The
GRAV Speech checkout, Indic-Transcribe model, Parler weights, Hugging Face
cache and configuration remain under `/workspace`.

Do not expose port 8890 publicly. Model caches and reference clips belong on
the pod's persistent `/workspace` volume.

For a localhost-only CMS test, `scripts/mrf-voice-local-relay.js` may be placed
behind a temporary tunnel. The relay accepts only the authenticated worker
`context`, `turn`, `no-answer`, synthetic-test `speech`, and synthetic-test
`dialog` diagnostic paths; it cannot proxy browser, login,
MRF-decision or any other CMS route. Do not tunnel port 5050 directly.

Indic Parler model weights are gated by AI4Bharat. They must be downloaded once with
an approved Hugging Face account before Hindi or Odia synthesis can start; an
access token must never be committed or retained in the worker environment.
English Kokoro and GRAV Speech STT do not depend on that approval.

Hindi and Odia input is normalized to conversational office speech before it
reaches its TTS engine. Common English loanwords are retained when natural, but their
pronunciation is written in Devanagari or Odia script. English-dominant dynamic
CMS copy is localized by the private dialogue gateway; output that still
contains Latin prose is rejected rather than synthesized incorrectly.

Hindi uses the dedicated Chatterbox V3 Hindi checkpoint and its native-Hindi
female reference voice. Completed WAVs are cached persistently and the worker
pre-renders its bounded response bank outside the audible decision path. Odia
continues to use Indic Parler's `Debjani` voice until
an equally fast native Odia engine is qualified. Its description requests fluid
phrasing and only brief sentence-boundary pauses without increasing speaking
speed. `GRAV` is a wordmark, not an initialism: the speech gateway always renders
it as one spoken brand name.
