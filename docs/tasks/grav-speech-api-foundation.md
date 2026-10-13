# GRAV Speech API — Foundation task

**Status:** DEVELOPMENT GPU DEPLOYMENT IN PROGRESS; CONSUMER WIRING PENDING  
**Sequence:** GS-01  
**Decision:** `docs/decisions/central-grav-speech-service.md`

## Goal

Replace the pod-only transcription runner with one private, reusable service
that keeps the accepted models warm and exposes a stable API to GRAV backend
applications.

GS-01 proves the shared service with two consumers only:

- GRAV Voice recorded calls;
- CoWork meeting recordings.

Store voice commands and other applications join after the shared boundary is
proven; they must not create a second model service.

## Implemented foundation — 10 October 2026

- `services/grav_speech_api/` provides the private FastAPI service, HMAC
  workload authentication, strict request contract, SQLite-backed durable
  first-deployment queue, restart recovery, cancellation, health/readiness,
  local-object confinement and the preserved GPU inference pipeline.
- `services/ai/gravSpeechClient.js` is the one Node client for all CMS
  applications. It signs the exact body, path, service, company and timestamp.
- `docs/handoff/grav-speech-api-consumer.md` is the consumer handoff.
- Unit checks pass for signature binding, URL/model-selection refusal,
  company isolation and idempotency. An HTTP smoke test passed for liveness,
  signed creation (`202`), duplicate recovery (`200` with the same job ID),
  and signed retrieval.
- The API does not accept a caller-supplied expected speaker count. Sortformer
  decides speaker count from the recording.

The development service is now installed on the existing private RunPod and is
reachable from this Mac through a loopback SSH tunnel. The workload secret is
stored only in ignored local/pod runtime files. Model artifacts live on the
persistent volume; the container runtime dependencies must be recreated after
a RunPod image migration. This remains a development deployment, not the final
production origin. Voice / CoWork consumer wiring and the source-storage
adapter remain pending.

## Deliverables

### 1. Service package

Create a dedicated Python service package, separate from the Node CMS process.
It owns:

- HTTP request validation and workload authentication;
- a durable job adapter;
- audio normalisation;
- the preserved Sortformer + Indic-Transcribe Flex inference pipeline;
- structured health/readiness and stable error codes;
- deletion of temporary media in success, failure and cancellation paths.

Move reusable inference logic out of the localhost UI script. Keep the script
as a diagnostic caller, not a second implementation.

### 2. Versioned API

Implement:

```text
POST /v1/transcription-jobs
GET  /v1/transcription-jobs/{jobId}
POST /v1/transcription-jobs/{jobId}/cancel
POST /v1/utterances:transcribe
GET  /health/live
GET  /health/ready
```

Recording jobs are asynchronous. The utterance endpoint is bounded and
low-latency, has no diarization, and uses reserved capacity.

### 3. Job state

Use a durable state machine:

```text
queued -> fetching -> diarizing -> transcribing -> succeeded
                                              \-> failed
queued | fetching -> cancelled
```

Each transition is timestamped. A terminal job is immutable. Uncertain worker
ownership is recovered by lease expiry; it does not create a second job.

Unique identity is `(company, source application, source kind, source id,
audio fingerprint, requested feature version)`.

### 4. CMS gateway

Add one Node client/service used by every application. It:

- accepts a trusted company/service context, never a browser tenant field;
- proves source audio access before submission;
- converts the source into a private object reference;
- signs the internal request;
- maps service failures to stable CMS errors;
- records an audit event for submission, completion, failure and cancellation.

Application routes call this gateway. They do not know the pod URL, checkpoint
path, GPU type or model loading details.

### 5. Initial consumers

#### GRAV Voice

After a recording is imported into GRAV-controlled storage, submit a
diarization-enabled job keyed by the `CallEvent` and recording fingerprint.
Persist only the accepted result/source reference under existing Voice access.

#### CoWork meetings

After meeting audio is final, submit the same job contract keyed by meeting ID
and recording fingerprint. Existing CoWork organiser/participant authorization
continues to govern transcript reads.

No transcript is copied into Sales merely because a conversation link exists.

## Tests

- valid internal workload accepted; browser/JWT-only request refused;
- company mismatch and arbitrary URL refused;
- duplicate create returns the original job;
- model checksum mismatch makes readiness fail;
- two-speaker and three-speaker preserved fixtures match expected speaker
  counts and raw transcript structure;
- no LLM/manual edit flag is always false;
- retry after worker death resumes or safely retries one job;
- temporary audio is removed after success, failure and cancellation;
- recording jobs cannot consume reserved command capacity;
- Voice and CoWork permissions remain the authority for result reads;
- transcript text and signed media locations do not appear in logs.

## Release gates

- private service origin and workload secret/identity configured;
- durable queue/job store configured outside the GPU pod;
- model artifacts pinned by revision/checksum;
- one warm-worker restart drill completed;
- operational limits and retention values approved;
- metrics and alerting visible before more applications join.

## Explicitly out of scope

- transcript summarisation, translation or correction;
- speaker identity recognition;
- customer/lead matching from speech;
- autonomous business actions;
- exposing the GPU service to browsers;
- migrating every historical recording in GS-01.
