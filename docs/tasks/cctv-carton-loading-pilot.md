# CCTV carton-loading verification — sequential pilot task

Status: planned; not the active `docs/tasks/current-task.md` scope.  
Date: 13 October 2026.  
Product: `docs/product/cctv-carton-loading-verification.md`.  
Decision: `docs/decisions/cctv-hybrid-event-architecture.md`.

This task does not authorise changes in the dirty CMS worktree. Implementation
belongs first in the separately hosted CCTV repository/worker after its owner,
host and checkout are confirmed.

## CV-00 — ownership and security gate

- Identify the external CCTV repository, deployment host and responsible owner.
- Select one factory, loading bay, camera and read-only NVR account.
- Rotate any camera credentials previously stored as source defaults.
- Confirm the CMS SSO secret has no production fallback.
- Name the business reviewer and evidence-retention decision owner.

Exit: no implementation begins with an unknown repository, exposed credential,
public RTSP endpoint or unnamed reviewer.

## CV-01 — business contract and fixtures

- Identify the canonical GRAV dispatch/shipment record and expected-count field.
- Freeze the four outcomes and `CARTON_COUNT_VERIFICATION` envelope.
- Create consented fixture clips for single carton, overlap, trolley, reversal,
  partial visibility, occlusion, person-only and camera-loss cases.
- Separate development and untouched held-out sessions.

Exit: the pilot can be evaluated without a live camera or invented CMS records.

## CV-02 — camera connectivity probe

- Validate RTSP-over-TCP from the intended edge host.
- Record codec, substream resolution, frame rate, reconnect behaviour and
  time-to-first-frame without printing the secret URL.
- Verify carton pixels are sufficient at the crossing boundary.
- Persist no video during this step.

Exit: a non-secret health report proves the intended worker can reach the feed.

## CV-03 — offline counter

- Pin the detector/tracker runtime and licence disposition.
- Configure a versioned polygon/line for the loading boundary.
- Count a carton only after a direction-aware, hysteresis-protected crossing.
- Handle duplicate tracks, track loss, reversal and overlapping cartons.
- Emit replayable observations and deterministic unit tests.

Exit: fixture replay produces the same count and transitions on every run.

## CV-04 — live edge worker

- Add bounded RTSP decoding, reconnect backoff, deadlines and health.
- Use a low-resolution analysis stream and one-in-flight/latest-frame semantics.
- Maintain only an in-memory ring buffer unless evidence retention is approved.
- Expose no unauthenticated playback or inference endpoint.

Exit: slow inference and camera loss cannot cause unbounded memory or a stale
work queue.

## CV-05 — optional VLM escalation

- Define the exact ambiguity conditions that invoke the VLM.
- Send only selected frames/short clips and one typed question.
- Pin model, runtime, prompt and response schema.
- Reject invalid, late or version-drifted responses to `UNCERTAIN`.
- Measure whether the VLM materially improves held-out mismatch decisions over
  the deterministic counter.

Exit: keep the VLM only if it improves the predetermined metric enough to
justify latency and cost.

## CV-06 — GRAV adapter, after isolated worker proof

- Add a narrow authenticated ingestion boundary owned by the operational
  decision, not by a generic camera router.
- Resolve company/site/session authority server-side.
- Enforce idempotency, schema bounds, source timestamps and version fields.
- Store metadata and protected evidence references only.
- Add company-scoped read/review endpoints and audit events.

Exit: replayed delivery cannot duplicate a verification event and cross-company
references fail closed.

## CV-07 — shadow review UI

- Show expected/observed count, outcome, timestamps, quality and versions.
- Provide confirm, dismiss and correct-to-uncertain actions with reason.
- Deep-link to the canonical dispatch record.
- Do not create shipment mutations, employee records or customer notifications.

Exit: the named reviewer can evaluate sessions without changing operational
truth.

## CV-08 — held-out report and adoption decision

- Report exact-count accuracy, mismatch precision/recall, false matches,
  duplicate/missed crossings, uncertainty, availability, latency and cost.
- Separate development fixtures from untouched factory sessions.
- Recommend stop, revise or advance; do not silently enable production alerts.

