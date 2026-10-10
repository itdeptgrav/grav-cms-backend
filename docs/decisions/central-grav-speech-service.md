# Central GRAV Speech Service

**Decision status:** Approved direction — 10 October 2026  
**Scope:** Shared transcription for every GRAV application

## Decision

GRAV will run the tested speech models once behind a private, versioned service
called **GRAV Speech**. Meetings, Sales calls, Voice commands, Store and future
applications consume its API; they do not install models, load checkpoints or
connect directly to a GPU pod.

The service centralises inference, not business ownership. Source applications
remain responsible for deciding who may read an audio recording, requesting a
transcription, and storing or exposing the accepted result in their own
authorised domain.

```text
authorised GRAV application
  -> CMS backend proves actor + company + source access
  -> private GRAV Speech API
  -> durable job queue
  -> warm GPU worker
       -> optional NVIDIA Sortformer speaker diarization
       -> bodhan-ai/indic-transcribe-flex Romanized ASR
  -> versioned machine result
  -> source application stores result/reference under its own permissions
```

Browsers never call GRAV Speech directly.

## Model runtime

The accepted transcription model is
`bodhan-ai/indic-transcribe-flex`, producing raw Romanized multilingual text for
English, Hindi and Odia without a language router or LLM rewrite.

Recorded meetings and calls may additionally request
`nvidia/diar_sortformer_4spk-v1`. The diarizer identifies speaker turns first;
Flex transcribes each turn, and the service merges them only by timestamp. The
speaker labels are anonymous (`Speaker 1`, `Speaker 2`, and so on); diarization
does not identify a person.

Model artifacts are immutable deployment inputs identified by model ID,
revision and checksum. The current verified local copies are:

- `.local-models/indic-transcribe-flex/`;
- `.local-models/diar-sortformer-4spk-v1/diar_sortformer_4spk-v1.nemo`;
- Sortformer SHA-256
  `bc74dfd8ca314240abcdc7e2949901eeaa72947a04ce1fab893e373d81f1e689`.

Production images or a private model volume may contain these artifacts. A
worker must refuse readiness if the configured revision/checksum is absent or
different.

## Two API modes

### Recording mode

For calls, meetings and uploaded audio. This is asynchronous and may include
speaker diarization.

```http
POST /v1/transcription-jobs
GET  /v1/transcription-jobs/{jobId}
POST /v1/transcription-jobs/{jobId}/cancel
```

The create request contains a server-resolved source reference, requested
features and an idempotency key. It never contains an arbitrary public URL,
`companyId` supplied by a browser, or a model name chosen by an end user.

### Command mode

For short voice-assistant utterances. This is a separate low-latency endpoint
and queue, uses the already-warm Flex model, and does not run diarization.

```http
POST /v1/utterances:transcribe
```

Its output is transcription only. Converting “MacBook ka stock kitna hai” into
a Store query or English intent belongs to the authorised Store command layer,
not the speech service.

Command traffic has reserved capacity so a long meeting cannot make a voice
assistant wait behind the batch queue. A later streaming transport may be
added behind the same contract, without changing application ownership.

## Job request contract

The CMS backend constructs the trusted request:

```json
{
  "source": {
    "application": "voice",
    "kind": "call_event",
    "id": "server-owned-source-id",
    "audioObject": "private-storage-object-reference"
  },
  "features": {
    "diarization": true
  },
  "callback": {
    "application": "voice",
    "event": "transcription.completed"
  },
  "idempotencyKey": "stable-source-and-audio-version-key"
}
```

The gateway derives and signs the company, requesting service and source
authorization. An application cannot use the speech API to escape its existing
recording permissions.

The API does not accept an expected speaker count. Sortformer must infer the
speaker count from the recording; applications cannot use a UI field as a
correction knob.

## Result contract

Every result is versioned and preserves raw machine output:

```json
{
  "schemaVersion": "1",
  "jobId": "stt_...",
  "status": "succeeded",
  "model": {
    "asr": "bodhan-ai/indic-transcribe-flex",
    "diarizer": "nvidia/diar_sortformer_4spk-v1"
  },
  "manualOrLlmEditing": false,
  "detectedSpeakerCount": 2,
  "durationSeconds": 65.0,
  "processingSeconds": 0.0,
  "speakerTurns": [
    {
      "speaker": "Speaker 1",
      "startSeconds": 0.0,
      "endSeconds": 1.5,
      "romanText": "raw model output"
    }
  ],
  "romanTranscript": "raw timestamp-ordered transcript"
}
```

Failure results use stable codes such as `AUDIO_UNREADABLE`,
`SOURCE_FETCH_FAILED`, `MODEL_UNAVAILABLE`, `CAPACITY_EXCEEDED` and
`PROCESSING_FAILED`. They do not return checkpoint paths, stack traces or
credentials.

## Ownership, security and privacy

- The service is private-network only and accepts workload authentication from
  approved GRAV backend services. There is no browser CORS surface.
- The CMS backend proves actor access and derives company scope before enqueue.
- The speech service validates the signed service claim and records company,
  application, source identity, model version and lifecycle timestamps for
  audit. It does not trust a tenant identifier in an end-user payload.
- Audio is fetched through a short-lived server credential or private object
  reference. Provider and Drive URLs are never persisted as public links.
- Temporary audio and clips are deleted after the job. Results have a bounded
  delivery retention; the source application remains the long-term authority.
- Logs contain IDs and timings, never raw transcript text or audio URLs.
- Retry uses the same idempotency key and returns the same job/result rather
  than running a second chargeable inference.

## Capacity and deployment

The logical service is central even when it later scales to several workers.
The first deployment may use one CUDA worker and a durable queue, processing
GPU stages serially. Production readiness requires:

- models preloaded before the worker becomes ready;
- separate interactive and batch queues;
- bounded upload/duration limits;
- queue depth, wait time, processing time, GPU memory and failure metrics;
- graceful worker restart without losing accepted jobs;
- autoscaling or a second worker when recorded p95 queue wait breaches the
  agreed target.

The API gateway, job store and queue must survive replacement of a temporary
RunPod. A pod is compute, not the system of record.

## Rejected alternatives

- **One model copy per application:** wastes VRAM, produces version drift and
  duplicates security-sensitive audio handling.
- **Browser-to-pod calls:** exposes infrastructure and bypasses source access.
- **A shared transcript database as the first step:** weakens source-domain
  permissions. Central inference does not require centralising all transcript
  ownership.
- **LLM cleanup inside the service:** changes evidence and makes output
  non-reproducible. Any later interpretation is a separate, visibly derived
  artifact.

## Acceptance

The central service is accepted when:

1. one warm deployment serves at least Voice calls and CoWork meetings through
   the same API and result schema;
2. repeated submission of the same source/audio version returns one job;
3. an unauthorised application, company mismatch and arbitrary audio URL are
   refused;
4. a worker restart does not lose queued or completed work;
5. command transcription is not blocked behind a long recording;
6. the two preserved benchmark files reproduce the validated two-speaker and
   three-speaker results without manual or LLM editing;
7. source applications expose results only through their existing permission
   boundaries.
