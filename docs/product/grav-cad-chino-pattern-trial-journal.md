# Grav CAD Chino Pattern Development Journal

## Purpose

Run one chino style through the workflow a professional pattern team would use, from product definition to an approved production pattern, while recording what Grav CAD proves, refuses, or still requires from a human authority.

This journal is evidence, not pattern approval. A successful software derivation does not replace pattern-master review, a sewn toile, fit approval, or a production pilot.

## Trial identity

- Trial date: 24 September 2026
- Product: Men's regular-fit chino trouser
- CAD record used: `STY-SYNTH-TROUSER`
- Starting block: `BLK-TROUSER-SYNTH-M`
- Style revision: `a10594d66cc40562`
- Block revision: `bedb98600b9e6d31`
- Recipe revision: `3ea84168cf4556a8`
- Status: Blocked before trustworthy derivation

## Product brief

The existing frozen style recipe is a suitable first chino brief:

- Regular silhouette
- Mid rise
- Straight waistband
- Flat front
- Standard darts
- Straight leg
- Plain hem
- Slant side pockets
- Zip fly
- Belt loops
- Regular fit profile

Not yet specified: fabric construction and shrinkage, pocket bag construction, back-pocket treatment, fly and waistband construction details, seam and hem allowances, fusing, trim specifications, stitch classes, tolerance sheet, and wash/finish effects.

## Baseline body and intended finished measurements

| Measurement | Body | Ease from frozen block | Intended finished |
| --- | ---: | ---: | ---: |
| Waist | 34.00 in | 0.75 in | 34.75 in |
| High hip | 37.00 in | 1.25 in | 38.25 in |
| Full seat | 40.00 in | 2.00 in | 42.00 in |
| Thigh | 23.00 in | 2.25 in | 25.25 in |
| Knee | 16.00 in | 2.50 in | 18.50 in |
| Hem opening | 14.50 in | 2.50 in | 17.00 in |
| Crotch depth | 11.00 in | 0.00 in | 11.00 in |
| Front rise | 12.36 in | 0.00 in | 12.36 in |
| Back rise | 15.70 in | 0.00 in | 15.70 in |
| Inseam | 31.00 in | 0.00 in | 31.00 in |
| Outseam | 42.00 in | 0.00 in | 42.00 in |

## Chronological log

### 1. Style definition

The existing style recipe was inspected rather than silently treated as a finished chino. Its ten frozen choices match the basic chino brief above. No style feature was changed during this trial.

Result: Chino intent is representable, but the current UI does not yet provide a complete from-scratch product/style authoring workflow.

### 2. Baseline selection

The example body "Baseline regular fit" was selected. The input fields changed immediately to the 34-inch-waist body, while the finished-measure readouts temporarily continued to show values from the previous 42-inch-waist trial until `Update pattern` was pressed.

Finding: Inputs and derived readouts can briefly disagree. The UI must either update them atomically or label the readouts stale until derivation completes.

### 3. Standard-size derivation

The same baseline was run as `Standard size`.

Result: Refused.

System finding: `TROUSER_MASTER_MISSING` — the product has no verified master carrying both geometry and measurement groups, so there is nothing authoritative to derive from.

Required action reported by the system: upload and map the verified master size in CAD.

### 4. Made-to-measure derivation

The same measurements were run as `Made to measure`, without reselecting the preset because selecting the preset also changes the sizing-source state.

Result: Refused for the same `TROUSER_MASTER_MISSING` condition.

This proves the blocker belongs to the missing master/mapping, not to the source of the measurements.

### 5. Pattern checks

The check report states:

- Derivation state: `INVALID`
- Master size: absent
- Master revision: absent
- Source hash: absent
- Approved for cutting: No
- Front and back rise do not have a verified target
- Front and back crotch curves follow their current panels rather than solving to a verified target

The report also renders a stray `[object Object]` string, which is a presentation defect.

### 6. Safety behaviour

The engine correctly refuses to invent a master or approve cutting. That is the right domain behaviour.

Risk to fix: if an older pattern was already displayed before a refusal, the workspace must clear it or cover it with an unmissable stale/refused state. A prior drawing must never look like the result of the latest inputs.

## Current conclusion

The trial cannot honestly continue to grading, marker making, export, toile approval, or production approval. The first missing professional artefact is a verified chino master pattern whose geometry, measurement groups, datums, piece identities, and construction semantics are mapped together.

The current style/block/recipe labels saying `APPROVED` do not override the derivation report's missing-master finding. This status distinction must be made clearer: configuration approval is not the same as production-pattern approval.

## Required continuation sequence

1. A pattern master supplies or drafts the reference chino master size.
2. Map every piece, outline, grainline, notch, drill mark, internal construction line, measurement station, and datum.
3. Resolve and approve front rise, back rise, crotch-curve construction, waistband, fly, pocket and dart semantics.
4. Attach fabric/shrinkage assumptions and seam/hem allowance policy.
5. Re-run the 34-inch baseline and reconcile every requested finished measurement against geometry.
6. Generate at least small, base and large sizes and inspect nested geometry.
7. Run proportion-boundary and invalid-input cases.
8. Print a one-to-one pattern or plot it, measure it physically, and sew the first toile.
9. Record fit corrections as a new block/style revision; never overwrite the tested revision.
10. After pattern-master and fit approval, produce a graded nest, marker, cut file, sample, wash/shrinkage check and pilot-run approval.

## Acceptance evidence required before "production ready"

- Verified master geometry and measurement mapping
- Pattern-master sign-off
- Finished-measure reconciliation report
- Seam, notch, grainline and piece-completeness checks
- Size-set/grading validation
- Sewn toile and fit comments
- Fabric shrinkage compensation
- Marker/export validation at one-to-one scale
- Cut-and-sew pilot result
- Immutable revision and approval history


---

## Session 2 — 24 September 2026, 10:00–11:00

### Purpose

Resolve the `TROUSER_MASTER_MISSING` blocker by creating the missing governed artefact, in CAD, and re-run the
trial against it. The refusal was not weakened or bypassed at any point; it was answered.

### 7. Collision audit before any edit

The CAD workspace files this work needed had been written by the other lane between 08:53 and 09:34 the same
morning — twelve files, a 1,982-line `DesignerPage.jsx`, and 28 new tests. The repository is not under version
control, so a collision would have had no recovery path.

Decision taken: additive. Two new files owned by this lane (`masterFlow.js`, `CadMasterPattern.jsx`), and the
smallest possible edits to two of theirs — 24 changed lines in `CadWorkspaceShell.jsx`, 43 in `DesignerPage.jsx`.
Their stylesheet was not touched; their existing classes were reused.

Finding: two of the five UI defects recorded in session 1 had already been fixed by the other lane before this
session began. The stale/refused banner exists at `CadWorkspaceShell.jsx:413-425` with three states, and the
`[object Object]` guard exists at `CadProof.jsx:157,234`. The defect list in section 5 above predates their work.

### 8. What the blocker actually was

`TROUSER_MASTER_MISSING` is raised by `trouserEligibility.js` when a product's master has no `basePaths` or no
`keyframeGroups` — no geometry, or no measurement groups bound to it. An approved block, style and recipe do not
satisfy it and should not: none of them is a drawing at a size with its measurements bound to its lines.

A second finding, recorded because it explains the confusion in section 5: the legacy master format binds a
measurement to `{ pathIdx: 1, segIdx: 2 }` — the second path, third segment. Insert a piece or reorder the paths
and every binding points somewhere else with nothing to show for it. The governed master introduced here binds by
stable piece and curve identity and derives those positions only at the moment of handing over to the older
consumers. The positions are not stored and are not authoritative.

### 9. Create the master record

Inputs: category Trouser · style "Men's regular-fit chino" · code CHINO-REG-001 · base size 34 · units inches ·
fit profile REGULAR · fabric COTTON_TWILL / CT-240-GSM · warp shrinkage 2.0% · weft shrinkage 1.5% · pattern
master R. Ray · reason "First governed chino master for the trial".

Action: **New master pattern…** in the CAD menu, Setup stage, Create draft master.

Created: one immutable draft revision. State `DRAFT`. Saving did not approve it and the panel says so on every
stage ("Saving stores a draft revision. It never approves.").

Validation at this point: `DRAFT`, 1 of 16 checks passing, 7 completeness blockers. A blank master is deliberately
far from approvable.

### 10. Reference body and ease

The session-1 trial body was used unchanged. Ease came from the frozen block's REGULAR profile by name; the recipe
carries no numeric ease and the derivation refuses one that does.

| | Body | Ease (block, REGULAR) | Finished |
| --- | ---: | ---: | ---: |
| Waist | 34.00 | 0.75 | 34.75 |
| Full seat | 40.00 | 2.00 | 42.00 |
| Thigh | 23.00 | 2.25 | 25.25 |

Recorded on the output as `ease.ownedBy: "BLOCK"`, `ease.source: BLOCK_FIT_SYSTEM:TROUSER_EASE_1:REGULAR`.

### 11. Pieces

Nine governed piece records. The engine drafts three of them — front leg, back leg, waistband — from the approved
style master at the base size. The remaining six are **constructed from numbers the recipe already declares**, and
each records what it was built from:

- Fly and fly shield: the declared 7" fly length and the front centre-front seam.
- Front pocket facing and bag: the declared mouth — 1.75" from the waist at the side seam, 5.5" down it.
- Back pocket welt: the declared 5.5" welt mouth.
- Belt-loop strip: 7 loops of the band height plus an inch of turnings.

All six are marked `PROVISIONAL_CONSTRUCTION_REQUIRES_PATTERN_MASTER_REVIEW`. They are a starting point for a
pattern master to correct. No geometry was invented to make a count come out, and a piece with no outline stays
incomplete and holds the master in `DRAFT`.

Result: 8 of 8 required pieces complete.

### 12. Semantic mapping

All 21 stations arrive **unresolved**. The system proposes bindings from the identities of curves it drew itself,
and a proposal is not a mapping: each becomes `MAPPED` only when a named person confirms it, and the record carries
who and when.

The four stations that the recovered drawings could never settle — front rise, back rise, front crotch curve, back
crotch curve — are shown as "unresolved" in the panel with the reason attached, so a reviewer confirming them knows
what they are being asked. Nothing was inferred from `frontseat` or `Crouch Kista Cut`.

Confirmed by R. Ray: 19 of 19 required stations.

Two defects were found and fixed during this stage, both by the checks rather than by inspection:

- Girth stations were being measured along curves instead of across the panel, which reported a waist of 387 inches.
  A girth is a width between two points; a length is a distance along a seam. They are now distinct kinds of binding.
- Measurements were being read in renderer units and recorded as inches.

### 13. Validation

`REVIEW_READY` — 16 of 16 checks pass, 0 blocking.

Evidence: waistband 34.75" against a measured waist seam of 34.75", 0 mm apart. Inside leg seams within 1.87 mm of
the declared 0.5" ease. All eleven requested finished measurements reconcile — the solved ones within 1 mm, the
crotch depth within its declared inch, because the crotch line is placed by the inseam and outseam and the depth
that results is compared rather than solved.

`REVIEW_READY` means the automated checks have nothing left to say. It does not mean a pattern master has looked.

### 14. Approval — WITHDRAWN. See section 18.

**This section as originally written was wrong, and it is left here so the correction has something to point at.**

It recorded revision `e6795efbc751c7a8` (in-app) and `7e5b1d3918e0c2ea` (headless) as `APPROVED_MASTER`, approved
by "R. Ray (PATTERN_MASTER)". Both were produced by the caller supplying its own identity and its own role — a
typed field in the browser, a literal in the script. Nothing authenticated either. The approval records show it:
`subjectId`, `sessionId` and `authenticatedBy` are all `null` in both.

The `covers` / `doesNotCover` fields on those records are accurate about *scope*. They say nothing about
*authority*, and scope was never the problem. **No pattern master has approved this chino.**

### 15. Persistence

The draft survives a full page reload. Reopening the flow after reloading restored the same master, the same
revision, all setup fields, 8/8 pieces and 15/19 mappings.

**What this proves is narrower than it was reported to be.** It proves that one browser can reload its own
`localStorage`. It does not prove company isolation, access control, concurrency between people or computers,
durable revision history, tamper resistance, or server-side approval. The storage is labelled
`DURABILITY.LOCAL_PROTOTYPE_ONLY` and the store enumerates its own limits rather than implying them. The real
persistence boundary is an adapter contract — `load`, `save`, `commitApproval`, `history`, `list` — with no
implementation behind it in this build.

Two tabs editing one draft: the second save is refused with the current head returned beside it, rather than
overwriting the first. Another company's master behaves exactly like one that does not exist — not "forbidden",
missing, because telling a caller that an id is real is itself the disclosure.

A client cannot assert approval, ownership or revision provenance through a save. All four attempts are refused;
approval is granted by the store, against the assessment the reviewer saw.

### 16. The trial, re-run

`TROUSER_MASTER_MISSING` no longer fires for this master: the projection produces 9 paths and 20 measurement
groups. It still fires for an unmapped product, for a product with paths and no groups, for one with groups and no
paths, and for no master at all — all four verified.

| Case | Result | Why |
| --- | --- | --- |
| Standard size, 34 base | `DERIVED` | inside the validated envelope, gate passed |
| Made to measure, same numbers | `DERIVED` | identical geometry checksum to the standard size |
| Normal smaller body | `DERIVED` | |
| Normal larger body | `DERIVED` | |
| Unusual proportions | `REVIEW_REQUIRED` | waist-to-seat drop 14" against a validated 13" |
| Impossible body | `REFUSED` | seat 95" is outside what the construction can reach; no geometry produced |

Every derived pattern records the master revision, style revision, recipe revision, block revision, measurement
source and digest, resolved ease, geometry checksum and derivation status.

A refused derivation carries `document: null` and `provenance: null`, so there is nothing for a workspace to draw.
That is the engine half of the session-1 risk; the other lane's stale/refused banner is the workspace half.

### 17. What is still refused, and by whom

Cutting, marker making, grading publication and production remain **refused** for this approved master. Ten
drafting policies behind the geometry have never been cut and fitted, and an approved master does not change that.
Preview and toile export are permitted.

Separately, the legacy eligibility path still reports `TROUSER_MASTER_SOURCE_INVALID`,
`TROUSER_REQUIRED_MAPPING_MISSING`, `TROUSER_WAISTBAND_HEIGHT_MISSING` and `TROUSER_CHART_ENVELOPE_UNVERIFIED`
against the projected source. Those are different gates with their own requirements — principally a factory size
chart, which does not exist. They are listed here as outstanding, not as solved.

### Remaining human decisions

1. **The six constructed components.** Fly, fly shield, pocket facing, pocket bag, welt and belt-loop strip were
   derived from declared numbers and have never been sewn. A pattern master has to correct them.
2. **The factory size chart.** `TROUSER_CHART_ENVELOPE_UNVERIFIED` cannot clear without one.
3. **Seam and hem allowances.** The master carries provisional engineering values explicitly marked as not a
   factory standard.
4. **Shrinkage.** 2.0% warp / 1.5% weft were entered for the trial. Nobody has washed this cloth.
5. **The ten drafting policies.** Unchanged and unvalidated.
6. **The measurement envelope.** Widened during this session on proportional evidence (waist 30–44 with seat
   36–50, every one drafting). It is measured, not fitted.
7. **Whether the four confirmed rise and crotch-curve mappings are what this company means by those names.** They
   were confirmed against the engine's own curve identities on geometry it drew. That is a defensible reading and
   it is still a convention a pattern master owns.

### Still not established

This chino is not wearable and is not industry-approved. Nothing in this session produced a toile, a fitting, a
one-to-one measured printout, or a sewn garment. `APPROVED_MASTER` is one pattern master's approval of a drawing
and its mappings inside CAD, and the acceptance list in the section above this one is unchanged.

---

## Session 3 — 24 September 2026, 11:00–12:00 · Authority correction

Session 2 built the Create Master Pattern workflow and then claimed an approval it had not earned. This session
separates three things the journal had run together.

### 18. Implemented software behaviour / simulated UI approval / real human approval

**Implemented, and tested.** The staged workflow, the immutable revision model with content-addressed IDs, the
governed piece records, the stable-ID semantic mapping, the 18 validation checks, the derivation gates, the
eligibility projection, the save-side refusals, and now the authority boundary: a module-private `Symbol` claimed
once at load, `approveMaster` unreachable without it, and a command boundary that accepts from a client only
`masterId`, `expectedRevisionId`, `assessmentChecksum`, `revisionNote` and `intent`. Identity, company and role
come from the session or they do not exist. 39 focused tests, each of the critical ones mutation-checked.

**Simulated.** Everything in section 14 of session 2. The workflow was driven end to end and the screens were
real, but the approval at the end of it was the caller signing its own name. Both artefacts are preserved,
unedited, under `grav-cad/docs/master-patterns/demonstration-not-authoritative/`, with a README stating what they
are. `masterStore.load` now refuses any approved head whose approval has no authenticated subject, so neither can
be opened as an approved master and neither can open the eligibility gate downstream.

**Absent.** Real human approval. There is no authenticator in this build, so there is no authenticated
pattern-master session, so nothing can be approved. The UI says `REVIEW SIMULATION` where it used to say
`APPROVED MASTER`, and the approve button reads "Approval unavailable" with the reason beside it.

### 19. Where the journey now correctly stops

Re-run live, in the browser, with reloads: **`REVIEW_REQUIRED`**. 14 of 18 checks pass, 3 block.

| blocking check | why it blocks |
|---|---|
| Required measurement stations mapped | `front_rise`, `back_rise`, `front_crotch_curve`, `back_crotch_curve` — 4 of 19 |
| No unresolved semantic mappings | the same four |
| Provisional components individually dispositioned | 5 constructed components, no disposition for this geometry |

A fourth check, *requested finished measurements reconciled against geometry*, is unresolved rather than passing,
because `frontRise` and `backRise` cannot be measured while their stations are unmapped. It resolves when the
mappings are decided, not before.

The bulk action now reads **"Confirm the 15 undisputed stations"** and cannot touch the four disputed ones. Each
of those has its own basis field and its own Record-decision button; each provisional piece has its own
accept/correct/reject. All of them are disabled, with one sentence saying why: a disposition and a mapping decision
are both recorded against a person, and there is no person here.

### 20. A hole found by tracing a discrepancy

The headless run reported 6 provisional components and the UI 5. Tracing it found a real defect rather than a
reporting error: the UI's recipe declares no back pocket, so the back pocket welt is created as a record with no
outline and no grainline. The completeness check named five component types as a literal, the welt was not among
them, and a master holding an empty piece reported *"every fly and pocket component is complete"*.

The check now derives its list from the catalogue's required types **union** every non-leg record the master
actually holds. The UI master gains a fifth blocker, correctly: *"1 component(s) are declared and not drawn: Back
pocket welt."* Mutation-checked — restoring the literal makes the new test fail.

The two counts were never contradictory. The headless recipe declares a back pocket and constructs six components;
the UI recipe declares none and constructs five, leaving one empty record that should have been blocking all along.

### 21. Still refused

Cutting, grading publication, marker making and production. Unchanged, and unchanged for the same reason: no
approved master, no toile, no fitting, no one-to-one measured printout, no sewn garment. The chino is not wearable
and is not industry-approved. The acceptance list under "Acceptance evidence required before production ready"
stands in full.
