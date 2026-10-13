# CMS development Qwen runtime

Date: 3 October 2026

## Decision

The CMS development backend uses `qwen3:32b` through Ollama on the development
RunPod. Ollama listens only on the pod loopback address. The backend reaches it
through a local SSH tunnel on `127.0.0.1:11435`; the model API is not published
to the internet.

This changes runtime placement only. The semantic catalogue, tool permissions,
exact database reads, result validation and deterministic renderers remain the
authority for CMS facts. Qwen interprets requests; it is not a database and is
not trained on employee or accounting records.

## Development operation

Start and verify the tunnel before the backend:

```sh
npm run dev:qwen
npm run dev
```

`npm run dev:qwen` first checks the pod-loopback Ollama API. Because RunPod
containers do not run systemd, it starts the installed runtime against the
persistent `/workspace/ollama-models` store when necessary, then creates the
private SSH tunnel. It never binds the model API to a public interface.

Check or stop it with `npm run dev:qwen:status` and
`npm run dev:qwen:stop`. The RunPod address and ports are overridable through
the `RUNPOD_QWEN_*` environment variables in the tunnel script.

The ignored local `.env` points both the central assistant and the optional
accounting Qwen reviewer at `http://127.0.0.1:11435`. The rejected Open-Jev
pilot remains outside the live central-assistant path.

The current development pod was replaced on 3 October 2026. The tunnel script
now targets its SSH endpoint by default; the endpoint remains replaceable via
`RUNPOD_QWEN_HOST` and `RUNPOD_QWEN_SSH_PORT` because RunPod addresses are
ephemeral. The remote Ollama API is still bound only to pod loopback.

## Boundaries

- Development only; no production traffic is changed.
- The RunPod must be running, Ollama must be running there, and the tunnel must
  be healthy before the CMS starts.
- The SSH endpoint is operational configuration, not a stable production
  deployment address.
- Changing model tags requires a new compatibility and routing evaluation.

## Verification evidence

- Active model: `qwen3:32b`, 32.8B parameters, `Q4_K_M`.
- Verified model-layer digest:
  `3291abe70f16ee9682de7bfae08db5373ea9d6497e614aaad63340ad421d6312`.
- Runtime after real structured requests: 100% GPU on the RunPod A40, about
  28 GB VRAM resident at a 32,768-token runtime context. The retained 8B model
  uses about 10 GB when it is also warm; both fit on the 46 GB A40 for this
  development comparison.
- An identical eight-question HR routing sample improved from 6/8 on
  `qwen3:8b` to 7/8 on `qwen3:32b`. The 32B model fixed the released-document
  and salary-register routes; one audit request selected the correct tool but
  failed closed because its arguments did not satisfy the registered schema.
- Warm 32B planning took about 4.0–7.6 seconds per sampled request. The first
  cold request took 69 seconds while the model loaded into GPU memory.
- The development tunnel now verifies `qwen3:32b`, and the local CMS `.env`
  selects it for the central assistant and optional accounting reviewer.
- Replacement-pod verification on 3 October 2026: Ollama `0.35.1`; model tag
  reports 32.8B / `Q4_K_M`; the full 20.2 GB model layer passed SHA-256; the
  warm structured health request completed successfully; and all five
  Store & Purchase live routing probes passed after server reconciliation.
  The first request required more than five minutes to load tensors from the
  persistent volume, while the immediately repeated structured request took
  about 1.9 seconds. The pod should therefore be warmed before interactive
  acceptance testing.
- Assistant regression: 71/71 focused tests passed after the typed salary
  concept and hard context-reset contract were added.
- Semantic-catalogue audit: HR and Accounting clean; 27 tools registered.
- Restarted development backend: database connected and socket running.

## 10 October 2026 AI-interview probe

The replacement RunPod retained the model store and A40 GPU but lost the
ephemeral Ollama executable. With product-owner approval, Ollama was restored
and kept private on pod loopback; the local backend connection remained an SSH
tunnel bound to local loopback.

The restored runtime reports `qwen3:32b`, 32.8B parameters and `Q4_K_M`. A
synthetic Chartered Accountant interview probe showed a warm 1.46-second short
follow-up, but also showed that non-thinking scoring can reward a mentioned
document despite contradictory meaning. A contradiction-aware thinking prompt
corrected that example, but does not establish production reliability. Qwen is
therefore a development candidate for controlled follow-ups and advisory
rubric scoring only. It is not approved to reject candidates or make hiring
decisions. Full evidence and release conditions are in
`docs/audits/ai-interview-qwen32-probe-2026-10-10.md`.
