# Qwen CCTV temporal-window decision

Status: accepted for the next non-production evaluation run.  
Date: 28 September 2026.

## Decision

Replace independent single-frame Qwen activity decisions with one fixed-size
four-second contact sheet per anonymous person track. Run classification once per
second after the first complete window and smooth the window decisions with a
deterministic two-confirmation state machine.

## Why

The reviewed clip exposed two repeatable errors:

- proximity and isolated gestures were sometimes labelled as conversation;
- phone use visible across adjacent frames was sometimes labelled as working.

A single frame does not contain enough evidence to distinguish those cases
reliably. Combining four small crops preserves temporal evidence while keeping
one image input and a bounded visual-token budget.

## Observable-label rules

1. `using_phone`: phone visibly held and actively viewed, tapped, typed on or
   used for a call in at least two frames.
2. `working`: visible use of a laptop, keyboard, document, pen, tool or machine
   in at least two frames. Working remains the label during casual speech if the
   task continues.
3. `talking_or_interacting`: reciprocal engagement with another person sustained
   in at least two frames. Proximity alone is insufficient.
4. `no_observable_task`: none of the listed activities is sustained.
5. `uncertain`: evidence is small, blocked, inconsistent or ambiguous.

The system does not infer conversation content, intent, productivity or identity.

## Latency and display consequence

The first activity decision is delayed until a complete window exists. A live UI
may show immediate YOLO boxes, but the activity value must display
`warming_up`/`uncertain` until temporal evidence is available. Stable labels then
change only after two matching window decisions.

## Evaluation boundary

The five reviewer corrections are development cases, not held-out evidence. The
next GPU run must report them separately, measure changes to labels that were
previously accepted, and retain raw Qwen window decisions alongside smoothed
labels.

## RunPod evaluation note — 28 September 2026

The current non-production preview uses Qwen2.5-VL-7B-Instruct once per tracked
person per second, with four raw decisions retained as the rolling temporal
window. YOLO is limited to anonymous person tracking and wrist-region crop
placement; no trained or generic phone detector participates in the phone
decision.

After the ID 16 review, the primary activity pass also receives the previous
three one-second evidence panels. Laptop/keyboard engagement has priority over
talking, looking aside or gesturing, so a person continuing laptop work is
`WORKING`. A targeted replay of the 20–42 second segment changed the reviewed
person from the false `PHONE`/`NO TASK` outcome to `WORKING`; the anonymous track
number changed in the excerpt because tracking restarted.

Phone classification now has two Qwen passes. The first pass proposes the
activity from a full-person crop plus enlarged hand regions. The second pass is
an open-description grounding check over only the hand regions. It asks Qwen to
name the physically visible held object without offering phone as a binary
choice. The deterministic gate accepts `PHONE` only when that independent
description explicitly names a smartphone/cell phone/mobile phone and is not
negated. This change removed the observed raised-finger/pen false positive while
retaining the corrected phone label for track 5 in the same comparison scene.

This is a development observation on the supplied clip, not an accuracy claim.
The 7B two-pass path is materially slower than real time with several visible
people and therefore does not satisfy the sub-second production target. It is a
quality reference for the next profiling/architecture decision.

Further review found a hard Qwen-only trade-off on the supplied camera. Keeping
the original 672x448 evidence panels across three seconds corrected the standing
track from `WORKING` to `NO TASK` and retained laptop work, but the model did not
reliably recognise a phone resting on papers under the user's hand. Relaxing the
prompt to accept that case failed to recover it consistently and introduced a
false `PHONE` on another track, so that experiment was rolled back. The
conservative version is retained. Reliable resolution of this case requires a
grounded phone-localisation stage or labelled training evidence; additional
activity-prompt wording is not an adequate mitigation.

## Grounded phone-verification refinement — 28 September 2026

The non-production RunPod preview now adds the generic
`IDEA-Research/grounding-dino-tiny` zero-shot checkpoint. It does not load either
project-specific phone model and it was not fine-tuned on this camera. Grounding
DINO proposes phone regions; it is not allowed to set the activity label by
itself.

An audit of seconds 20–42 showed why localization alone was insufficient. The
model found the reviewed lit-screen phone, but also correctly found multiple
real phones lying unused on the crowded desks and proposed a raised-hand object.
Detection confidence did not separate use from proximity. The accepted
development pipeline therefore requires all of the following before `PHONE` can
override Qwen's activity proposal:

1. overlapping text-prompt boxes are deduplicated;
2. one proposed handset is assigned to at most one anonymous person track;
3. the phone centre lies inside that person's box and near a pose wrist;
4. the phone region contains visible active-screen texture/edges; and
5. Qwen confirms the marked, zoomed phone is an on-screen handset directly in
   front of that person.

On the targeted replay, the reviewed seated phone user alone changed to `PHONE`
at excerpt second 13.0. The standing track remained `NO TASK`, the laptop user
remained `WORKING`, and no overlapping person inherited the same desk phone.
This is a corrected development case, not a held-out accuracy result. The full
clip still needs reviewer inspection and the added verification pass makes the
7B reference path slower, not suitable for the sub-second production target.

Later review of the same fixed camera added three development corrections. A
phone may pass the grounded gate either through visible active-screen evidence
or through strict contact with a pose wrist, followed by Qwen confirmation of
the marked object; this recovers a dark handset visibly held in the lap without
accepting dark unattended desk phones. Two narrow camera-perspective ownership
safeguards prevent a far/top standing person resting a hand on papers and the
bottom-left foreground seat overlapping a neighbour's laptop from inheriting
`WORKING`. In the focused 52–68 second replay, the reviewed phone user was
`PHONE` while the red-shirt standing person and foreground plaid person were
both `NO TASK`. These are camera-specific development rules and must be replaced
or separately calibrated before evaluating a different camera view.

## Rollback outcome — 28 September 2026

The grounded and camera-specific refinement above is rejected as the active
preview. Although it corrected selected development frames, reviewer inspection
found broader label regressions and judged the original Qwen-only output more
accurate overall. The full grounded run was stopped. Its implementation is
preserved separately as `live_preview_server_grounded_experiment.py` on the
ephemeral evaluation pod for diagnosis only.

The active comparison baseline is restored to the untouched
`live_preview_server.py`: YOLO person tracking plus Qwen2.5-VL-3B-Instruct on
independent one-second person crops. It has no Grounding DINO checkpoint, pose
gate, temporal override, or camera-zone rule. Further changes require a scored
comparison set rather than additional frame-by-frame patches.
