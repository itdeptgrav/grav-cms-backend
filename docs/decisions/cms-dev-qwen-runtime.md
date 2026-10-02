# CMS development Qwen runtime

Date: 2 October 2026

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

Check or stop it with `npm run dev:qwen:status` and
`npm run dev:qwen:stop`. The RunPod address and ports are overridable through
the `RUNPOD_QWEN_*` environment variables in the tunnel script.

The ignored local `.env` points both the central assistant and the optional
accounting Qwen reviewer at `http://127.0.0.1:11435`. The rejected Open-Jev
pilot remains outside the live central-assistant path.

## Boundaries

- Development only; no production traffic is changed.
- The RunPod must be running, Ollama must be running there, and the tunnel must
  be healthy before the CMS starts.
- The SSH endpoint is operational configuration, not a stable production
  deployment address.
- Changing model tags requires a new compatibility and routing evaluation.

## Verification evidence

- Active model: `qwen3:32b`, 32.8B parameters, `Q4_K_M`.
- Ollama digest:
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
- Assistant regression: 68/68 focused tests passed.
- Semantic-catalogue audit: HR and Accounting clean; 27 tools registered.
- Restarted development backend: database connected and socket running.
