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
       -> overlapping-context bodhan-ai/indic-transcribe-flex Romanized ASR
       -> optional speaker-activity layer
       -> evidence-preserving transcript quality gate
  -> versioned machine result
  -> source application stores result/reference under its own permissions
```

Browsers never call GRAV Speech directly.

## Model runtime

The accepted transcription model is
`bodhan-ai/indic-transcribe-flex`, producing raw Romanized multilingual text for
English, Hindi and Odia without a language router or LLM rewrite.

Recorded meetings and calls use **overlapping-context ASR first**: Flex decodes
bounded 34-second windows with a two-second overlap, then the service removes
only exact word-boundary overlap. This is the approved readable-transcript
path because it preserves acoustic context for code-switched business names,
phrases and quantities. A language model never rewrites this text.

Recorded meetings and calls may additionally request
`nvidia/diar_sortformer_4spk-v1`. Diarization is a second, independent layer
for anonymous speaker activity (`Speaker 1`, `Speaker 2`, and so on); it must
not cut audio before ASR or determine the words displayed in the readable
transcript. Until word-level alignment is separately validated, a context
window that spans speakers displays each active speaker rather than falsely
assigning individual words to one speaker.

Long recordings are processed in bounded three-minute batches for memory and
delivery progress. Every batch contains overlapping ASR windows whose original
timestamps are preserved. Diarization may use matching bounded windows;
speaker labels remain local evidence, so a label is not presented as a stable
identity across batch boundaries.

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

## Transcript evidence and quality gate

ASR output is evidence, not automatically trustworthy prose. The service must
preserve every raw turn and its exact timestamps, then evaluate a separate
utterance view before a consumer may render it as a normal paragraph.

The first gate is deterministic and checks audio duration, isolated
micro-utterances, implausible word rate, collapsed lexical diversity, decoder
repetition and weakly supported diarizer channels. A diarizer channel is an
anonymous acoustic hypothesis, not proof of another person. Long turns must use
the model's pause-aware safe chunker; a decoder pass may not exceed the model's
trained context window.

Numbers, dates, quantities, amounts and dimensions are additionally treated as
high-risk evidence. A fragment such as `point five` must never be silently
expanded to `one point five`. Competing ASR candidates are retained and compared
as exact values; disagreement or a structurally incomplete number blocks that
utterance from structured facts until contextual re-decode or authorised review
resolves it.

An optional private text reasoner may classify an utterance plus its immediate
neighbours as `coherent`, `uncertain` or `gibberish`. Its authority stops there:
it cannot rewrite, translate, complete or replace ASR words. A failed span is
first re-cut and decoded as one contextual audio window instead of isolated
micro-turns, then may use a versioned specialist fallback. The reasoner may
select one verbatim ASR candidate, but cannot combine them. If the candidates
still disagree, the readable view says `[unclear audio]` and exposes the
preserved raw candidates for authorised review.

The semantic check must also catch phrases that are syntactically plausible but
illogical in the local business conversation. It receives a bounded meeting
context (the target utterance, surrounding transcript window and an inferred
meeting/topic profile), not just one sentence on either side. This lets it
recognise an incoherent phrase in any kind of discussion without the product
having to supply vocabulary in advance. The complete recording is
not repeatedly placed in a prompt: batch/topic context plus a roughly
two-to-four-minute local transcript window is the bounded context horizon.

The baseline recovery loop is domain-neutral and does not accept product,
industry, acronym or tenant keywords. First, the reasoner identifies a span as
incoherent *without proposing a replacement*. The service then re-decodes the
same source audio with several context paddings and, where necessary, a
different ASR architecture. The reasoner receives those recorded candidates
plus bounded context and may choose exactly one candidate ID. It must return
`uncertain` if no candidate is adequately supported. Thus context can decide
that a phrase such as an impossible inventory expression needs recovery, but
the replacement still has to have been spoken and emitted by ASR.

A tenant-controlled domain term may be an optional, customer-configured extra
signal after the domain-neutral loop has run. It is never a prerequisite for
quality or a hidden product-specific rule, and it cannot silently alter ASR
evidence. There is one narrow exception for the *derived readable view*:
`contextualTermNormalization`. It can display a canonical catalog term such as
`polyester` for a raw span such as `Police star` only when all of these are
true:

1. the term comes from a versioned, source-domain-owned glossary and is not
   generated by Qwen;
2. Qwen selects only that glossary ID after receiving the bounded meeting
   context and target raw span; it never returns a replacement sentence;
3. a deterministic guard verifies the exact source span, a configured alias or
   phonetic similarity threshold, confidence, and a permitted term type; and
4. the change is not a number, amount, date, dimension, identifier, person or
   other structured business fact.

Every accepted normalisation records its raw phrase, canonical term ID,
glossary version, phonetic evidence, model decision and contextual window.
`rawRomanText`, ASR candidates and structured facts remain untouched. Consumers
must be able to reveal the original reading next to the enhanced display.

When a longer context window contains both a correct catalog term and a
phonetic variant, terminology review must additionally receive a focused packet
for each literal non-canonical alias. It may not nominate the already-correct
occurrence elsewhere in the same window. The focused proposal still passes the
same source-span, glossary and phonetic checks. Multiple independently
validated occurrences are applied in source order to the derived display text;
they never alter the underlying raw ASR value.
The resulting `semanticIssues` and `recoveryRequired` fields retain the reason
for any second acoustic decode.

The permanent implementation is the private `/v1/transcript-review` endpoint
in the existing bounded Qwen worker. The central speech service sends raw
utterance evidence, bounded meeting context, recorded candidate decodes and
tenant vocabulary hints to that endpoint. It validates the returned utterance
ids and issue enum, re-cuts only requested spans with padded source audio, and
accepts a readable candidate only if the selected candidate id was actually
produced by ASR. A separate `/v1/transcript-term-normalize` route can return
only a closed glossary ID plus a raw span; it cannot submit replacement prose.

This distinction is mandatory:

- `rawRomanText` is immutable model evidence;
- `qualityState`, `qualityFlags` and `semanticReview` are derived annotations;
- `selectedCandidate` is allowed only after a recorded, reproducible selection
  rule; and
- `contextualNormalizations` are optional, auditable display annotations that
  replace only a validated glossary span in `contextualNormalizedRomanText`;
  they never alter raw evidence or structured facts; and
- no derived sentence may be merged across a flagged micro-turn as though it
  were confidently spoken.

## Result contract

Every result is versioned and preserves raw machine output:

```json
{
  "schemaVersion": "2",
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
      "rawRomanText": "raw model output",
      "qualityState": "unverified | coherent | uncertain | gibberish",
      "qualityFlags": []
    }
  ],
  "utteranceReviews": [
    {
      "id": "utterance-0001",
      "turnIndexes": [0],
      "rawRomanText": "raw model output",
      "candidateTranscripts": [
        {"id": "raw_turn_concat", "romanText": "raw model output"},
        {"id": "contextual_redecode", "romanText": "second raw ASR output"}
      ],
      "selectedCandidateId": "contextual_redecode",
      "numericEvidence": {
        "flags": ["numeric_candidate_conflict"],
        "safeForStructuredFacts": false
      },
      "qualityState": "uncertain",
      "semanticReview": {
        "state": "uncertain",
        "reason": "short evidence-based reason; never replacement text"
      },
      "contextualNormalizations": [
        {
          "rawPhrase": "Police star",
          "canonicalTermId": "material.polyester",
          "canonicalText": "polyester",
          "glossaryVersion": "garment-v1",
          "phoneticScore": 0.82
        }
      ],
      "contextualNormalizedRomanText": "... polyester ..."
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
- **Free-form LLM cleanup inside the service:** changes evidence and makes
  output non-reproducible. A reasoner may classify quality but cannot supply
  transcript prose. The only permitted enhancement is a visibly derived,
  glossary-ID-only contextual normalisation with the source span and evidence
  retained.

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
8. micro-turn hallucinations, repetition loops, over-context decoder calls and
   weak diarizer channels cannot silently become trusted readable prose;
9. semantic verification never changes `rawRomanText`, even when it classifies
   a span as gibberish; a contextual normalisation is permitted only as a
   separately-audited glossary display annotation.
10. flagged micro-turn collections are re-decoded as bounded contextual audio,
    and any selected text exactly matches one recorded ASR candidate.
11. conflicting or incomplete numeric evidence cannot populate a business fact,
    quantity, amount, date or dimension.
12. the baseline quality path uses no tenant, product or industry vocabulary;
    such vocabulary is an explicit optional configuration layer only.
