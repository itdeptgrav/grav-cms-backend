# CCTV carton-loading verification pilot

Status: proposed, non-production shadow-mode pilot.  
Date: 13 October 2026.

## Product outcome

Evaluate whether one authorised dispatch/loading camera can provide useful,
reviewable evidence that the number of cartons crossing a configured loading
boundary agrees with the expected dispatch quantity recorded by GRAV.

The pilot answers a narrow operational question:

> Did the expected number of visible cartons cross the configured loading
> boundary during this dispatch session?

It does not identify employees, infer intent, score productivity, prove carton
contents, replace barcode/dispatch controls, or automatically post a dispatch.

## First supported result

Each completed session produces one of:

- `MATCH` — observed and expected counts agree;
- `SHORT` — fewer cartons were observed than expected;
- `EXCESS` — more cartons were observed than expected;
- `UNCERTAIN` — the view, tracking continuity or evidence quality is not
  sufficient for a reliable comparison.

`UNCERTAIN` is a valid outcome and must never be converted to a match.

## System boundary

The separately hosted CCTV application or an isolated worker on its network
owns RTSP ingest, decoding, tracking and any evidence clip. GRAV CMS remains the
business system of record and receives authenticated, typed event metadata and
protected evidence references. The legacy CMS RTSP/HLS routes remain unmounted.

The worker uses a low-resolution NVR substream for continuous analysis. A
high-resolution frame or short clip may be retained only after the retention,
access and deletion policy is approved. Continuous footage is not copied into
GRAV.

## Required business linkage

A verification session must be opened against a company-scoped dispatch
reference before it can produce a business event. The worker may not guess the
manufacturing order, shipment or expected quantity from video.

Minimum linkage:

- company and factory/site;
- camera reference and versioned zone configuration;
- dispatch/shipment reference;
- expected carton quantity and its source record/version;
- session start/end and initiating actor;
- observed count, outcome and confidence/quality status;
- detector, tracker, rule and optional VLM versions.

## Human workflow

The first release is shadow mode. An authorised reviewer can inspect the event,
confirm it, dismiss it or mark it uncertain. No alert, inventory movement,
shipment status change, employee record or customer notification is created by
the pilot.

If the pilot advances, a confirmed mismatch may create a dispatch review task.
It still may not mutate shipment truth automatically.

## Acceptance measures

Measure on untouched sessions that were not used to tune the camera or rules:

- exact count accuracy;
- mismatch precision and recall;
- duplicate- and missed-crossing rates;
- uncertainty rate;
- camera/feed availability;
- event latency and compute cost;
- reviewer agreement and review time.

Adoption thresholds must be fixed before the held-out run. A useful aggregate
accuracy cannot compensate for an unacceptable false `MATCH` rate.

## Privacy and security boundaries

- Read-only, camera-restricted NVR credentials supplied through a secret store.
- No face recognition, biometric template or cross-session person identity.
- Anonymous track/object IDs expire with the analysis session.
- Evidence access is company/site scoped and audited.
- Retention is explicit and automatically enforced.
- Camera loss and low-quality evidence fail to `UNCERTAIN`.

## Decisions required before live connection

1. Pilot factory, loading bay and exact NVR channel.
2. Correct externally hosted CCTV repository, host and deployment owner.
3. Dispatch record that owns the expected carton quantity.
4. Whether evidence clips may be retained, for how long and who may view them.
5. Fixed held-out acceptance thresholds and named operational reviewer.

