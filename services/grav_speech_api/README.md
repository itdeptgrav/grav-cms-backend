# GRAV Speech API

Private central inference service for GRAV applications. It serves the locally
preserved Indic-Transcribe Flex model and optional NVIDIA Sortformer speaker
diarization. It is not a public or browser API.

## Required environment

```text
GRAV_SPEECH_SHARED_SECRET       long shared workload secret
GRAV_SPEECH_STATE_DIR          durable state directory, outside ephemeral pod disk
GRAV_SPEECH_AUDIO_ROOT          mounted private audio-object root
GRAV_SPEECH_MODEL_DIR           Indic-Transcribe Flex directory
GRAV_SPEECH_DIARIZER_PATH       verified .nemo checkpoint
GRAV_SPEECH_DIARIZER_SHA256     expected checkpoint digest
```

Start inside the CUDA image:

```sh
python -m uvicorn services.grav_speech_api.app:app --host 127.0.0.1 --port 8097
```

Use `services/ai/gravSpeechClient.js` from Node applications. The client signs
the exact body, HTTP method, path, calling service, company and timestamp.

Health endpoints are deliberately unauthenticated for private orchestrator
probes. Every inference and job endpoint requires the HMAC workload headers.

The SQLite job store makes restarts safe for a single first deployment. Put
`GRAV_SPEECH_STATE_DIR` on persistent storage. Before horizontal scaling,
replace its adapter with the agreed external queue/job database; application
contracts do not change.
