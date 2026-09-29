# OpenJev CCTV activity-monitoring pilot

Status: proposed, non-production pilot.  
Date: 27 September 2026.

## 28 September 2026 experiment amendment

The current executable pilot uses `Qwen/Qwen2.5-VL-3B-Instruct`, not OpenJev,
for observable activity classification. OpenJev remains the historical product
proposal below and is not in the live experiment path.

The first Qwen run showed that independent single-frame decisions over-call
conversation and miss some sustained phone use. The next evaluation therefore
uses a delayed four-second observation window:

- one anonymous tracked-person crop per second;
- four chronological crops combined into one fixed-size 2x2 contact sheet;
- one Qwen decision over the complete contact sheet;
- two consistent window decisions required before emitting or changing a stable
  label;
- an incomplete first window is `UNCERTAIN / warming_up`, not a forced label;
- a stable label may survive at most two uncertain windows before returning to
  `UNCERTAIN`.

This creates an expected three-to-five-second decision delay. It does not support
the earlier goal of a new definitive activity answer on every video frame. Person
detection and box display may remain sub-second while the activity label updates
on the temporal cadence.

## Purpose

Evaluate whether the image-capable `openjev/openjev` decision model can classify
observable activities from one authorised live CCTV camera. The first vocabulary
is deliberately small:

- `PHONE_USE` — a person is visibly interacting with or speaking on a phone;
- `LAPTOP_USE` — a person is visibly interacting with a laptop;
- `CONVERSATION` — a person appears engaged with another person;
- `NO_OBSERVABLE_ACTIVITY` — no listed activity is visible in this observation;
- `UNCERTAIN` — the image is too small, obstructed or ambiguous.

The pilot must not call conversation "gossip", infer intent, identify a person,
score employee performance, or take an employment action. Those conclusions are
not supported by the pixels and would turn a technical evaluation into workplace
surveillance policy.

## Existing GRAV boundary

GRAV CMS no longer serves CCTV video. `server.js` authorises the user and redirects
to the separately hosted CCTV application through `routes/cctvSso.js`. The old
`routes/cctv.js` and `services/cctv/*` RTSP-to-HLS implementation remain on disk but
are deliberately unmounted.

Therefore the vision pilot belongs beside the externally hosted CCTV application
or in an isolated worker reachable by it. It must not remount the old streaming
router in the CMS merely to obtain frames.

The existing `services/ai/openJev/*` code is also the wrong integration point. It
is a historical text-routing pilot for the central assistant, which now uses Qwen
as its sole live language planner. CCTV observations must use a new client and
configuration boundary; enabling the old assistant flags must not enable video
analysis.

## Model assumption that must be pinned

This proposal means the current image-capable Hugging Face release
`openjev/openjev`, not the older `Zefan-Cai/Open-Jev` checkpoint already evaluated
for text routing in GRAV. The chosen repository, exact revision, checkpoint hash,
serving image and helper hash must be recorded before evaluation.

The current model contract accepts one PNG or JPEG image per decision request. It
does not consume RTSP, HLS or a video file. The application must sample the live
feed and maintain all temporal state outside the model.

## Proposed data flow

```text
authorised RTSP substream
        |
        v
isolated ingest worker ---- health only ----> CCTV operations UI
        |
        v
frame sampler (initially 1 frame every 2 seconds)
        |
        v
person detector/tracker --> one crop + anonymous track id per person
        |
        v
OpenJev image decision API
        |
        v
schema/probability validation
        |
        v
temporal aggregator --> observation/event store --> review UI
```

The ingest worker reads credentials from a secret store or injected environment,
never from source, a browser response, logs or an OpenJev request. Use the NVR's
low-resolution substream for the connectivity test, but confirm that the phone is
large enough in a person crop before accepting it for evaluation.

## Required components

### 1. Camera access

- One read-only RTSP account restricted to the pilot camera where the NVR permits
  it.
- Host/domain, external or internal port, channel/path and transport mode.
- A defined network route from the ingest worker: same LAN, VPN or an approved
  private tunnel. Public unauthenticated RTSP is prohibited.
- A connectivity check from the eventual worker host, not merely from an
  engineer's laptop.

### 2. Ingest worker

- Reconnect with bounded exponential backoff.
- RTSP-over-TCP first; UDP may be evaluated only if the route supports it.
- Decode the substream without publishing a new public playback endpoint.
- Hold only the small in-memory buffer needed for analysis unless the explicit
  evidence-retention option below is approved.
- Redact credentials and query parameters from diagnostics.
- Per-camera circuit breaker so a dead feed does not create an infinite retry or
  inference loop.

### 3. Person localisation and tracking

Whole-camera classification is not sufficient when multiple people are visible.
A deterministic vision component must create anonymous track IDs and person
crops. A track ID is session-local and must not become a biometric identity.

The detector supplies geometry and continuity only. OpenJev classifies each crop;
it does not decide who the person is. If the pilot starts with a single-person
camera view, localisation may be deferred for the first connectivity spike but is
required before multi-person claims.

### 4. OpenJev serving

- Image-capable checkpoint; text-only MLX/GGUF variants are unsuitable.
- A pinned Linux/CUDA serving host sized for the chosen checkpoint. The upstream
  reference measurement uses an 80 GB H100; different hardware requires its own
  latency and capacity measurement.
- vLLM bound to loopback/private networking only.
- The OpenJev helper protected by a long random bearer token and TLS if traffic
  crosses an untrusted network.
- One image and one typed `choice` question per observation.
- Model version, checkpoint hash, question version and latency attached to every
  stored decision.

### 5. Decision contract

GRAV supplies the five labels and descriptions in every request. OpenJev returns
only a typed choice and probability distribution. The adapter must reject:

- a label not offered by GRAV;
- missing, non-finite or out-of-range probabilities;
- a chosen label that is not the maximum probability;
- a response for the wrong question key;
- a response after the observation deadline;
- an unavailable or changed model version during a pinned evaluation run.

`UNCERTAIN` is a normal answer, not a failure. Low-confidence results are converted
to `UNCERTAIN`; they are never silently promoted to an activity.

### 6. Temporal aggregation

One frame cannot establish duration. The worker keeps a small state machine per
anonymous track. Initial evaluation values, to be tuned only on a development
set, are:

- sample interval: 2 seconds;
- start an event after three consistent observations;
- end an event after three inconsistent or missing observations;
- `NO_OBSERVABLE_ACTIVITY` is merely an observation until a separately configured
  duration is reached;
- never infer conversation content or purpose.

Raw probabilities and transitions must be retained for evaluation so smoothing
does not conceal high-confidence errors.

### 7. Storage and review

The default pilot stores metadata, not continuous video:

```text
cameraRef, anonymousTrackId, observedAt, label, probabilities,
decisionStatus, model/checkpoint, questionVersion, inferenceLatencyMs
```

Whether to retain a small evidence frame for human review is a product/privacy
decision. If approved, it needs encryption, an explicit retention period, access
logging and deletion. Do not reuse CCTV login access as automatic permission to
export or retain AI evidence.

## Security prerequisite

The inactive legacy `services/cctv/config.js` currently contains NVR credential
defaults in source. Treat those values as exposed: rotate them, remove the source
defaults, move all secrets to the deployment secret store, and verify that no
logs or repository history are being used as a credential source. This is a
prerequisite to connecting the pilot, even though that legacy router is unmounted.

Also replace the static fallback in `routes/cctvSso.js` with a required deployment
secret before treating the redirect as a security boundary. This pilot does not
authorise those application-code changes; they are called out for the responsible
implementation owner.

## Evaluation plan

### Phase A — offline image check

Use consented still images representing the actual camera height, distance and
lighting. Establish whether a phone or laptop is visually resolvable before
building streaming infrastructure.

### Phase B — live shadow mode

Connect one camera, create decisions without alerts, identity or employee-facing
records, and have an authorised reviewer label a bounded sample. Report precision,
recall, uncertainty rate, high-confidence errors, end-to-end latency and model
availability separately for each class.

### Phase C — event evaluation

Enable temporal aggregation in shadow mode and measure event-level false alarms,
missed events, duration error and duplicate-event rate. Frame-level accuracy alone
is not an adoption result.

## Adoption gates

The pilot does not advance unless all of the following are true:

1. Camera access uses rotated read-only credentials and an approved network path.
2. The camera produces enough pixels per person/phone for useful review.
3. `UNCERTAIN` and low-confidence behaviour are safe and measurable.
4. Multi-person observations are isolated by anonymous tracking.
5. No face recognition, identity inference or employment action exists in the
   data flow.
6. Privacy notice, access, retention and deletion are approved by the business.
7. A held-out, camera-matched evaluation meets thresholds fixed before that run.
8. The OpenJev non-commercial model licence is resolved before commercial use.

## Decisions still required

- Which exact camera/channel is the pilot source?
- Where does the externally hosted CCTV application run, and can an isolated
  worker be deployed on that host/network?
- Which exact OpenJev repository and checkpoint is intended?
- Is short-lived evidence-frame retention allowed, and for how long?
- What measured threshold would make `PHONE_USE` useful without unacceptable
  false accusations?
- Who may see live decisions and evaluation evidence?
