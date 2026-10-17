# Fabric Roll CV Data Collection Protocol

## Minimum feasibility set

Collect at least five physically distinct rolls. Do not treat multiple photos of
one roll as independent rolls. Reserve at least one complete roll for a first
unseen-roll check.

For each roll, capture checkpoints at full, approximately 75%, 50%, 25% and near
empty where practical. Establish remaining-length truth with a calibrated
length counter; supplier nominal length is metadata, not truth.

## Required at every checkpoint

- Stable `roll_id`, fabric SKU/type, supplier and batch when known.
- Exact remaining metres from the calibrated counter.
- Fabric width in centimetres.
- Full-resolution front-on photograph of each accessible roll end.
- Known-size ArUco marker or rigid scale in the same plane as the roll face and
  beside, not across, the roll.
- Roll face fully visible, unsupported by hands, against a dark background.
- Four lighting variants: light from top, right, bottom and left while camera,
  roll and scale remain fixed.
- Direct horizontal/vertical outer diameter and core diameter measurements in
  millimetres for audit comparison.
- Capture timestamp, camera/device identity and operator.

## Useful optional fields

- Gross roll weight and empty-core weight.
- GSM samples and their positions if available.
- Winding machine, tension setting, supplier roll number and rest time before
  capture.
- Fabric composition, construction, pile/nap and finish.
- Notes for folds, telescoping, loose wraps, damage or moisture.

## Suggested record shape

```json
{
  "rollId": "ROLL-001",
  "checkpointId": "ROLL-001-P050",
  "fabricSku": "example",
  "supplier": "example",
  "batch": "example",
  "remainingLengthM": 73.42,
  "truthMeterId": "METER-01",
  "fabricWidthCm": 147,
  "outerDiameterHorizontalMm": 150.2,
  "outerDiameterVerticalMm": 147.9,
  "coreDiameterHorizontalMm": 40.1,
  "coreDiameterVerticalMm": 40.0,
  "scaleMarkerSizeMm": 50,
  "images": {
    "leftLight": "...",
    "topLight": "...",
    "rightLight": "...",
    "bottomLight": "..."
  },
  "capturedAt": "2026-10-14T12:00:00+05:30",
  "operator": "example",
  "notes": ""
}
```

## Validation separation

Split by physical `roll_id`, never by image. Images or checkpoints from one roll
must not appear in both development and validation. A first feasibility result
may use four development rolls and one unseen roll, but a sub-1% product claim
requires a substantially larger representative held-out set agreed before
evaluation.
