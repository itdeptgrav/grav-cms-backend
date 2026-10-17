# CCTV twin face-identity boundary

**Status:** Accepted for the one-camera administrator pilot  
**Date:** 15 October 2026

## Decision

The factory twin may reuse the proven `PHONE_DETC` person detector, tracking
configuration and trusted employee face gallery, but the repositories remain
separate deployable components. The twin consumes them through a narrow vision
adapter rather than importing the old monolithic tracker application.

Identity is an optional enrichment of a camera-local person track. It is not a
prerequisite for occupancy, spatial mapping, posture, objects or activity.

## Required gates

- Person boxes use the existing `yolov8m.pt` checkpoint.
- Track continuity uses the CCTV-tuned BoT-SORT configuration. Appearance ReID
  may preserve a transient track but can never assign a name.
- A name requires a direct InsightFace `buffalo_l` match against an employee
  whose gallery metadata is both `READY` and `trusted_for_live`.
- The nearest-person distance must be at most 0.38 and beat the next person by
  at least 0.06; two consistent direct-face hits are required.
- A confirmed name may be held only briefly on the same camera-local track. A
  conflicting face immediately removes the old name while the new candidate
  is re-confirmed.
- The adapter is read-only: it never enrols, appends embeddings, writes the
  `PHONE_DETC` face database, or stores CCTV frames.
- The backend accepts only `CONFIRMED_FACE` claims from
  `PHONE_DETC_GALLERY`. All other identity sources fail closed.
- Identity is removed from ordinary CCTV responses. Only a re-verified
  platform administrator receives it.
- Identity must not be used to infer phone use, productivity, intent,
  discipline or any employment decision. Activity remains a separately
  calibrated evidence problem.

## Operational consequence

If the face model, gallery or identity adapter fails, the detector continues
publishing anonymous occupancy. If the person turns away or the face is too
small, the UI shows the camera-local track rather than guessing a name.

