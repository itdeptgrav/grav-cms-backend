# CCTV hybrid event-driven architecture

Status: proposed for the carton-loading pilot.  
Date: 13 October 2026.

## Decision

Use a model-independent, tiered video-analysis architecture:

1. an on-site edge worker continuously performs bounded deterministic
   perception on a low-resolution stream;
2. a temporal event engine converts tracks and line crossings into candidate
   events;
3. a vision-language model is invoked only for configured ambiguous or
   review-worthy evidence;
4. GRAV validates and stores typed business events, not frames or an RTSP
   stream; and
5. a human reviewer remains authoritative during the pilot.

## Placement

```text
NVR read-only substream
  -> isolated edge ingest and short ring buffer
  -> detector/tracker
  -> versioned line-crossing and temporal rules
  -> optional constrained VLM verification
  -> signed GRAV vision-event adapter
  -> company-scoped event/review record
  -> existing GRAV notification/WebSocket boundary
```

RTSP ingest and model inference do not run in the monolithic CMS process. The
old `routes/cctv.js` path remains unmounted. The existing SSO redirect to the
separate CCTV application remains the viewing boundary.

## Processing semantics

- One in-flight analysis item per camera/track; obsolete frames are discarded.
- Backpressure never creates an unbounded frame queue.
- Track IDs are session-local and non-biometric.
- Crossing events are deterministic and replayable from recorded observations.
- The VLM receives selected evidence and a typed question with an allowlisted
  answer vocabulary. Free-form prose is explanatory only.
- Missing, late, invalid or low-confidence model responses become `UNCERTAIN`.
- Every event includes idempotency key, source time, configuration version and
  component/model versions.

## Storage boundary

GRAV stores event metadata and protected evidence locators. Continuous video is
not persisted by GRAV. If clips are approved, the edge/evidence service writes
encrypted objects with a TTL and returns short-lived authorised references.

## Integration shape

The first pilot uses authenticated HTTPS delivery with idempotent retries. A
message broker is not required for one camera. The envelope is broker-ready so
multiple factories can later introduce a durable event transport without
changing the GRAV business contract.

Minimum event envelope:

```json
{
  "eventId": "source-generated-idempotency-key",
  "eventType": "CARTON_COUNT_VERIFICATION",
  "companyRef": "company-owned-reference",
  "siteRef": "factory-owned-reference",
  "cameraRef": "non-secret-camera-reference",
  "sessionRef": "dispatch-verification-session",
  "occurredAt": "ISO-8601 timestamp",
  "observation": {
    "expectedCount": 20,
    "observedCount": 18,
    "outcome": "SHORT",
    "quality": "REVIEWABLE"
  },
  "versions": {
    "zone": "loading-zone-v1",
    "detector": "pinned-model-revision",
    "tracker": "pinned-config-revision",
    "rule": "carton-crossing-v1",
    "vlm": null
  },
  "evidenceRef": null
}
```

The real API uses canonical GRAV IDs derived server-side or resolved through a
company-scoped mapping; opaque browser-supplied IDs never grant authority.

## Why not continuous VLM inference

Continuous VLM inference costs more, queues stale work and is less reliable for
counting and geometry. Deterministic tracking handles the common path. A VLM is
reserved for occlusion, overlap, ambiguous objects and human-readable
explanations where its additional cost can change a review decision.

## Supersession and coexistence

This decision does not activate or select OpenJev, Qwen or another checkpoint.
The employee-activity experiments remain historical evaluation evidence. The
carton pilot must pin its own detector, optional VLM, prompts and thresholds and
must not inherit camera-specific employee-activity rules.

