# R&D — the 3D garment workspace (Phase 1)

> **Status:** Phase 1 implemented, 1 Oct 2026.
> **Owner:** R&D. **Consumer, later:** Industrial Engineering.
> **Backend:** `routes/CMS_Routes/RnD/garmentModelRoute.js`,
> `services/rnd/garmentModel.service.js`, `utils/glbInspect.js`.
> **Frontend:** `grav-cms` `app/research-development/styles/[id]/workspace-3d`,
> `components/rnd/workspace3d/**`.

---

## 1. Audit — what already existed

Read from code on 1 Oct 2026, before anything was written.

| # | Area | What is there | Verdict |
|---|---|---|---|
| 1 | R&D routes | `/api/cms/rnd/technical-records/styles/:styleId` — read, start, refresh, save, submit, return a material, revisions, publication. `EmployeeAuthMiddleware` → `rndCompanyMiddleware` → live `research-development` grant | **Reusable as-is.** The new router is the second on the same mount with the same three gates |
| 2 | Tenancy | `styleForCompany()` proves a style through its journey or enquiry; `resolveCompanyForActor` resolves the acting company from `SpCompanyMembership` | **Reusable as-is** |
| 3 | Roles | `services/rnd/access.service.js` — viewer/editor/approver/owner, capabilities re-read per request | **Extended**, five new model capabilities |
| 4 | Private assets | `routes/Access/files.js` + `services/companyDrive.service.js` + `utils/letterDownloadToken.js`: upload to PRIVATE Drive, return a URL **back into this service** carrying a short-lived HMAC token, re-check session and row on every byte | **Reusable, and reused.** This is the signed-URL convention the brief asked for; it already existed |
| 5 | Public assets | `lib/driveImage.js` → Cloudinary / `lh3.googleusercontent.com`. Permanent, unauthenticated, PDF+JPG+PNG+WEBP only, 10 MB | **Unusable here.** No GLB, no ZPRJ, and a permanent public URL for an unreleased garment is exactly what the brief forbids |
| 6 | Object storage | No S3, no GCS, no presigning anywhere in the backend | **None to adopt.** The Drive + HMAC pattern above is the house convention |
| 7 | 3D libraries | `three@0.182.0` already a dependency; `FloorScene3D` and `StoreScene3D` establish raw three.js + `next/dynamic({ssr:false})`, scene built once and mutated | **Reused exactly**, including the disposal discipline |
| 8 | Revision lifecycle | R&D technical revisions are frozen, maker/checker separated, superseded on approval | **Mirrored**, not shared — a model has its own lifecycle |
| 9 | Model-version / annotation API | Nothing. No record, no route, no contract | **Missing. Built here** |

### Does GLB metadata survive upload?

Yes, and it is now read server-side rather than assumed. `uploadCompanyFile` stores the
buffer byte-for-byte, and `utils/glbInspect.js` parses the JSON chunk at publish time to
recover node names, hierarchy, materials, triangle counts and the exporter string. The
file's SHA-256 is stored, so "is this the model that was approved" is answerable.

### Can a marker be anchored stably? — **Yes, and it is proved**

A marker stores the **node** it is on and a point in **that node's own coordinate frame**.
The server names every node `n<index>` from the glTF node array; the browser recovers the
same identity from `GLTFLoader`'s `parser.associations`. Neither half depends on a camera,
a viewport size or a reader. An anchor naming a node the publication does not contain is
refused at the API rather than stored.

**The limitation that is real, and is reported rather than hidden:** anchoring is stable,
but *naming* is only as good as the export. An exporter that writes `Object_2` publishes no
pattern-piece identity, and the workspace says so — in the menu strip, on the row, in the
properties panel and in a stored `NO_NAMED_PIECES` warning. The sample model used to build
this (a real wild export) is exactly that case.

---

## 2. Route and ownership

```
/research-development/styles/[id]/workspace-3d
```

Under the style, because a published model is a fact about one style beside its technical
record. It does **not** render `ResearchDevelopment_DashboardLayout`: the garment has to be
the largest thing on screen, and a sidebar plus page gutter take a third of a laptop. The
entry is `Open 3D workspace` on the style header, shown only when a publication exists or
the viewer may create one.

**R&D owns it** because every fact anchored to the surface is R&D's: construction, seams and
stitch class, measurement points and tolerances, approved-sample evidence, clarifications.
**IE consumes** an approved publication and writes its operation mapping in IE's own
records. There is no route in this slice that lets IE edit a marker or replace a model, and
none that writes an IE mapping.

---

## 3. The backend contract

All under `/api/cms/rnd`, all behind employee auth → company → live R&D grant.

| Method | Path | Capability |
|---|---|---|
| GET | `/garment-models/styles/:styleId` | `rnd.model.read` |
| POST | `/garment-models/styles/:styleId` (multipart: `webModel`, `source`, `preview`) | `rnd.model.publish` |
| GET | `/garment-models/:publicationId` | `rnd.model.read` |
| GET | `/garment-models/:publicationId/asset/:kind?t=` | `rnd.model.read` (+ `rnd.model.source.download` for `source`) |
| POST | `/garment-models/:publicationId/submit` | `rnd.model.submit` |
| POST | `/garment-models/:publicationId/approve` \| `/return` | `rnd.model.approve` |
| GET/POST | `/garment-models/:publicationId/annotations` | read / `rnd.model.annotate` |
| PATCH | `/garment-models/annotations/:annotationId` | `rnd.model.annotate` |
| POST | `/garment-models/annotations/:annotationId/replies` | `rnd.model.annotate` |
| GET | `/garment-models/:publicationId/timeline` | `rnd.model.read` |

**Capabilities** (`services/rnd/access.service.js`): `model.read` → viewer;
`model.annotate`, `model.publish`, `model.submit` → editor; `model.approve`,
`model.source.download` → approver. Downloading the CLO project is deliberately separate
from reading the workspace: whoever holds the `.zprj` can reproduce the style anywhere.

**Records** (`models/CMS_Models/RnD/GarmentModel.js`): `GarmentModelPublication` and
`GarmentModelAnnotation`, in separate collections — a publication stops changing, a marker
discussion does not.

**Lifecycle:** `DRAFT → IN_REVIEW → APPROVED | RETURNED`; approving supersedes the previous
approved model so "the current approved model" has one answer. The publisher may not
approve their own model. An approved publication stops accepting markers.

**Business language:** `3D model N` per style, plus `publicationRef` (`GM-…`) and
`markerRef` (`MK-…`). No storage id and no filename is ever shown as a version.

### Limits, enforced server-side and reported to the screen

| Thing | Limit |
|---|---|
| Web model (GLB) | 60 MB |
| CLO source | 120 MB |
| Preview still | 8 MB, PNG/JPEG/WebP |
| Triangles | 1,500,000 refuse · 600,000 warn |
| Nodes | 5,000 |

### Refusals, each with its own code and a sentence naming the fix

`MODEL_UNREADABLE` (not a GLB, wrong version, truncated), `MODEL_TOO_COMPLEX`,
`MODEL_FILE_TOO_LARGE`, `MODEL_SOURCE_UNSUPPORTED`, `MODEL_PREVIEW_UNSUPPORTED`,
`MODEL_WEB_FILE_REQUIRED`, `MODEL_ANCHOR_UNKNOWN`, `MODEL_ANCHOR_INVALID`,
`MODEL_STATE_CONFLICT`, `MODEL_SELF_APPROVAL`, `REVISION_CONFLICT`.

### Warnings — accepted, and labelled

`NO_NAMED_PIECES`, `SINGLE_MESH`, `MATERIALS_NOT_AS_EXPORTED`, `HEAVY_MODEL`,
`LARGE_DOWNLOAD`, `NO_CLO_SOURCE`. Stored on the publication, not only returned at upload:
the person who publishes is rarely the person who later wonders why the fabric looks grey.

---

## 4. Security

* **No public URL exists for an unreleased garment, anywhere.** The API returns a path back
  into this service with a 10-minute HMAC token; the stream route requires that token **and**
  a live session, and re-reads the company and the row before a byte moves. Revoking an R&D
  grant takes effect on the reader's next frame.
* The token scope is `rnd-garment-model`, structurally unable to open a drive document, and
  a drive token cannot open a model.
* Drive object ids never leave the server.
* `X-Content-Type-Options: nosniff`, `Cache-Control: private`, and only an image is ever
  served inline.
* Company isolation on every query; missing and foreign are one answer.
* Annotation text is stripped of control characters and length-capped at the schema.
* File type is validated from the **bytes**, not the filename or the browser's MIME guess.
* No CLO-SET iframe, and no third-party viewer.

## 5. Performance

* The engine is `next/dynamic({ssr:false})`, so three.js and the loader are fetched on this
  route only. The rest of R&D does not download them.
* The scene is built once and mutated; React owns the container element and nothing inside it.
* Disposal releases geometries, materials, textures **and** the WebGL context.
* Marker projection runs at ~30 Hz rather than per frame.
* The preview still is shown while the canvas warms up; real progress is reported from the
  loader's own byte counts.

### Measured, on the real 39.5 MB export

| | |
|---|---|
| Transfer / decoded | 41,165,678 B / 41,465,692 B |
| Cold load (cache-busted), 3 runs | 1,007 / 1,535 / 1,104 ms |
| Warm load (disk cache), 3 runs | 1,099 / 1,143 / 1,183 ms |
| Headless capture machine | 387–491 ms |
| Mesh / nodes / triangles | 1 / 3 / 7,424 |

Warm ≈ cold, so the second is **parse and GPU upload, not network**. Compressing the asset
would buy almost nothing; the 39.5 MB is texture resolution, and reducing it is what would
make this open faster. No compression or transcoding is claimed, because the pipeline does
not do any.

---

## 6. What Phase 1 deliberately does not do

* **No CLO plugin.** Publishing is a browser upload. The export automation is the next task.
* **No annotation carry-forward.** A marker belongs to the publication it was made on and
  never appears on another; carry forward / remap / retire is a later flow. Phase 1's job
  was to make the wrong behaviour impossible, which it does by making the binding immutable.
* **No IE mapping.** The boundary is explicit and unimplemented.
* **No avatar control unless the file genuinely contains a separately identifiable one.**
* **No animation timeline.** The same area carries the development sequence instead.

## 6b. Phase 2 — the workflow, walked for real (1 Oct 2026)

Phase 1 was accepted from tests. Phase 2 was not: the whole point of this pass
was to open the thing, turn a garment, drop notes on it, reload and see them
come back. Everything below was done in a browser against the real routes.

### How it was run

`scripts/dev/rnd3dWorkspaceHarness.js` boots the real routers, the real auth
and the real services against an **in-memory replica set** and a **local folder
standing in for Drive**, with every live credential deleted from the
environment before a single application module is required. Nothing in this
pass touched Atlas, Firestore or the company's Drive. The frontend ran as a
second `next dev` on :3002 pointed at it (`NEXT_DIST_DIR` makes two instances
possible from one checkout).

### The fourteen steps

| # | Step | Result |
|---|---|---|
| 1 | Open an R&D style | The real style page renders, with `Open 3D workspace 1` in the header |
| 2 | Open its 3D workspace | Loads at `/research-development/styles/:id/workspace-3d` |
| 3 | Open the draft publication | `3D model 1`, DRAFT, created by the real multipart upload route |
| 4 | Load the sweater GLB | Streamed from the signed asset route; 293–436 ms |
| 5 | Rotate, pan, zoom, reset | All four move the camera; reset re-frames |
| 6 | Three markers on different areas | Neck, left cuff and hem, each on a distinct surface point |
| 7 | Title, category, note on each | Plus priority and department relevance |
| 8 | Save | `Note N saved` on each |
| 9 | Reload the page | — |
| 10 | Markers return to the same surface | **World delta 0.000000 m on all three.** Same node, same local point, to the last decimal |
| 11 | Edit one | Tolerance and note changed; events `created, edited` |
| 12 | Resolve one | Status `resolved`; events `created, status:resolved`; note, author and replies intact |
| 13 | Open as a viewer | Add-marker disabled, no submit, no status buttons, no reply box, all 9 inspector inputs disabled; server answers 403 to create, edit, resolve, reply, submit and publish |
| 14 | Submit and approve | DRAFT → IN_REVIEW → APPROVED by a second person; the publisher's own approval is refused; a later marker is refused with `MODEL_STATE_CONFLICT` |

### Two defects the live pass found, and the tests did not

1. **The viewport emptied silently on a layout change.** The engine is rebuilt
   whenever its host element changes — which happens on every switch between
   the desktop and narrow layouts, because they render the canvas in different
   places in the tree. `engineReady` was a boolean, so the second engine set it
   to `true` when it was already `true`, React bailed out, the model-loading
   effect never re-ran, and the garment was simply gone with no error anywhere.
   It is a counter now, and every piece of viewer state re-applies after a
   rebuild.
2. **An accepted model still offered the marker tool.** The server refused with
   a 409, so the failure mode was placing a pin, typing a requirement and
   losing it. The tool rail now takes the publication state, and the marker
   tool disarms itself when a model stops being a workspace.

### What changed for Phase 2

* **Ten categories**, the words a sampling room uses: construction,
  measurement, stitch/seam, material, printing/embroidery, trim, fit, quality
  concern, IE consideration, general note.
* **Optional priority and department relevance.** Optional because most notes
  are neither urgent nor anybody else's, and a required priority turns into
  everything being "normal". Relevance is never an assignment and never a
  permission.
* **Saving / Saved / Failed, said in words.** A failure stays on screen, keeps
  what was typed, and carries its own retry.
* **A model-health panel**, collapsed to one line, naming what this export
  cannot be trusted for.
* **A versions strip replaces the timeline.** An earlier pass borrowed the
  reference's ruler, keyframe diamonds and playhead; it looked right and was a
  lie, because a published garment has no frames. The bottom is now model
  versions on the left and the open publication's history on the right.
* **"Unlabelled model part"**, everywhere the export named nothing. The raw
  identifier is kept beside it as the technical reference it is.
* **Plain labels**: "3D model version 1", "Published 1 Oct 2026",
  "3 notes open", "Based on R&D technical pack …".

### Keyboard and pointer

The canvas is not focusable and takes no key handlers: Tab, Escape, the arrows
and ordinary letters all pass through, 37 controls are reachable in order, the
exit link is one of them, and a pointer released outside the canvas does not go
on orbiting. Guarded by source-level tests in
`components/rnd/workspace3d/workspaceLabels.test.mjs`.

### Limitations that remain, and are the export's rather than the workspace's

* **One merged mesh, named `Object_2`.** Markers hold position perfectly — the
  anchor is a node index and a local point, neither of which needs a name — but
  nothing can say which pattern piece a note is on, and there is nothing to
  isolate or hide. Only a CLO re-export with pattern names fixes this.
* **`KHR_materials_pbrSpecularGlossiness`.** three.js removed it, so the
  garment draws in a finish it was not authored in. **Colour and sheen must be
  judged from the technical pack or the approved sample, not from this
  viewport.**
* **39.5 MB for 7,424 triangles.** Warm load matches cold, so it is parse and
  GPU upload rather than network; the size is texture resolution. Server-side
  downscaling on ingest is the fix and is not built.
* **No annotation carry-forward.** A new model version starts with no notes and
  says so. Carry forward / remap / retire is a later flow; what is guaranteed
  today is that the wrong behaviour is impossible.

---

## 7. Next task — CLO publishing automation

1. A CLO Python plugin (`Publish to GRAV CMS`) that, from an open project: exports GLB with
   pattern-piece names switched on, renders the preview still, reads the CLO version and the
   project's unit and axis convention, and POSTs all of it to
   `POST /api/cms/rnd/garment-models/styles/:styleId` with a device token.
2. A **device-token grant** for that plugin — the current routes authenticate a person. This
   is the one piece of the contract that does not exist yet.
3. Server-side texture downscaling on ingest, so a 39.5 MB export becomes a ~5 MB web model
   while the full-resolution source stays as evidence. Only then may any compression claim
   be made.
4. A re-export flow that offers carry-forward of markers whose `rowRef`-equivalent node
   survived, and marks the rest unresolved.

---

# Phase 3 — the flat pattern, and which piece is which component (1 Oct 2026)

> **Backend:** `utils/dxfInspect.js`, `utils/bundleFileTypes.js`,
> `services/rnd/patternBundle.service.js`, `services/rnd/patternMapping.service.js`,
> plus the pattern half of `garmentModel.service.js` and `GarmentModel.js`.
> **Frontend:** `grav-cms` `components/rnd/workspace3d/patterns/**`.

Phase 1 published a garment. Phase 2 proved somebody could work on it. Phase 3
adds the other half of a technical pack — the flat pattern — and makes the
system state which flat piece is which 3D component, or say that it cannot.

## 1. The DXF parser, and the conventions it implements

Apparel CAD does not use DXF the way a mechanical drawing does. It uses the AAMA
layer assignment, standardised as **ASTM D6673**, where the LAYER NUMBER carries
the semantics and the drawing says nothing else about what any entity means.

| Layer | Meaning | In the test export |
|---|---|---|
| 1 | piece boundary (closed) | ✅ 5 pieces |
| 2 | turn points | ✅ 62 |
| 3 | curve points | ✅ 484 |
| 4 | notches | ❌ absent |
| 5 | grade points | ❌ absent |
| 6 | mirror / fold line | ❌ absent |
| 7 | grainline | ✅ 1 per piece |
| 8 | internal construction lines | ✅ 12 |
| 9 / 10 | stripe / plaid reference | ❌ absent |
| 11 | internal cutout | ❌ absent |
| 13 | drill holes | ❌ absent |
| 14 | sew line | ❌ absent |
| 15 | annotation | (CLO writes its text on layer 1) |

Entity support: `POLYLINE`+`VERTEX` (the form apparel CAD actually writes),
`LWPOLYLINE`, `LINE`, `ARC`, `CIRCLE`, `POINT`, `TEXT`/`MTEXT`, `INSERT`, and
`SPLINE` read as its control hull **with a warning**, because evaluating a NURBS
curve subtly wrongly produces a curve that looks plausible and measures wrong.
Bulges are tessellated properly: ignoring them makes every curve its own chord,
so an armhole measures short — a small error per segment, always in the same
direction, accumulating into a pattern that consumes less cloth than it does.

Hand-written for the same reasons `glbInspect.js` is: no new dependency, no new
attack surface, and refusals that arrive as a sentence rather than a blank view.

## 2. What a real CLO file taught us that a fixture could not

The fixture is a genuine CLO 7.1.178 export (`test/fixtures/rnd/`). Four defects
exist only because it is real — three found by parsing it, one by opening it:

1. **`$EXTMAX` is a placeholder.** The header claims `1000,1000` while the
   geometry lives between X −35…17. A viewer framing on it draws the pattern in
   the corner of an empty sheet. Extents are computed from geometry and the
   placeholder is reported.
2. **Internal lines overshoot their piece by exactly 20.0 mm.** CLO extends them
   past the edge as cutter guides, and publishes the hem allowance just outside
   the cut line. A stray-mark check written against a tidy fixture flagged three
   of five pieces. It now measures distance normalised by piece size: adjacent is
   a convention, a piece-width away is a mark on the wrong block.
3. **Trim meshes are named `BindedTrim_57204`.** `_` is a word character, so the
   `\b` in the trim regex never fired and nineteen trims were offered as
   candidate matches for a front bodice.
4. **`Number("")` is `0`.** An absent `$MEASUREMENT` matched the imperial branch,
   so every DXF stating no unit silently reported inches — out by 25.4, with
   nothing on screen to reveal it.

## 3. Absent is absent

The single most important property. No quantity is `null`, not `1`. No grainline
is `null`, not vertical. No sew line means the seam allowance is **unpublished**,
not zero — and the inspector says so in those words. One size is a sample
pattern, not a grading with one step. Every one of those defaults would be a
statement somebody could cut cloth against, attributed to a patternmaker who
never made it.

## 4. Classification from the bytes

`utils/bundleFileTypes.js` identifies a GLB by its magic, a glTF by its JSON, a
DXF by its group codes and a CLO source by exclusion — and refuses a file whose
contents contradict the card it arrived on. A `.gltf` whose geometry lives in
files beside it is refused outright: it would store cleanly and render as an
empty viewport.

`POST /garment-models/classify` answers **before** anything is stored, which is
what makes "the classification is visible before publishing" a fact rather than a
label applied afterwards. It writes nothing and creates nothing.

The `.zprj` check is honest about its own limit: CLO's container has no published
specification, so a source file is accepted by **exclusion** — it must not be a
format this server can positively identify as something else, and must not be
text — and `signatureVerified` records which of the two it was.

## 5. The mapping ladder

Six rungs, strongest first. Only the top one is accepted without a person.

| Rung | Confidence | Settled by |
|---|---|---|
| An identifier **both files publish** | 1.00 | the files themselves |
| The same name, exactly | 0.90 | **a person** |
| The same name, normalised | 0.70 | **a person** |
| Size and material | 0.55 | **a person** |
| Shape similarity | 0.40 | *never a mapping* |
| A person | 1.00 | them |

Below 0.50 nothing is proposed at all: a piece showing "Needs mapping" is one
somebody will look at; a piece showing a wrong 41% suggestion is one somebody
will accept. A stated side is never crossed — a piece saying "left" is not
matched to a component saying "right" at any similarity, which is the single
most likely wrong answer and the hardest to spot on screen. Shape similarity is
offered as a labelled suggestion to shorten a manual search and is deliberately
incapable of becoming a mapping on its own.

## 6. The bundle, and files that must agree

The publication **is** the bundle. A 3D model, a pattern and a source describing
one revision are one thing in the sampling room's language, they are approved by
one person and superseded together, and giving them a parent record would create
a second identity for the same fact. The consequence that matters: there is no
reachable state in which an approved model sits beside an unapproved pattern.

| Finding | Severity | Why |
|---|---|---|
| The files name different revisions | **blocking** | every number is a mix of two garments |
| The units disagree | **blocking** | every cross-check is out by the ratio |
| The model's size is not in the pattern | needs review | nothing to check a measurement against |
| One file replaced long after the others | needs review | they may not be one export |
| A revision nobody stated | informational | the mismatch cannot be detected, and that is worth saying |

Absent optional metadata is **never** blocking. That is the brief's rule and it
is also the only way the workspace can hold the commonest artifact R&D produces.

## 7. What is measured, and what it must never be called

`totalNetArea` is **not fabric consumption**, is never labelled as such, and
carries its own disclaimer in the payload so that a consumer reading the API
cannot mistake it either. The net area of the drafted pieces is a lower bound no
cutting operation achieves; the gap is the marker, the fabric width, grain and
nap, matching, spacing, shrinkage, defects and end loss. Consumption is the
marker-making system's answer, computed from this geometry as its **input**.

A quantity-weighted total exists only where every piece published a quantity —
never an assumed one-of-each.

## 8. The 2D viewer

SVG, not the three.js scene, and the brief is right to require it: a pattern is
read by clicking small things and SVG hit-tests them exactly; a pattern must be
accessible and a canvas is one opaque rectangle; and line weights carry meaning,
so pan and zoom drive the **viewBox** rather than a transform — a CSS `scale()`
would scale the strokes with it.

DXF measures Y upwards and SVG downwards. The flip lives in one function and the
cursor conversion undoes the same one, asserted by a test: if they disagreed, a
measurement taken at the hem would be recorded at the neck and the number would
look perfectly reasonable.

Beyond 24,000 drawing nodes the viewer says so and asks for a size filter rather
than simplifying. A pattern viewer that quietly dropped detail is one whose
notches cannot be trusted.

## 9. What the live pass found that the tests did not

Run against the real routes on :3001, the real dev database and the real Drive.

1. **A draft with no pattern could never get one.** `readPatternSet` returned
   `editable` only on the branch that HAS a pattern, so the control that attaches
   one never rendered — in exactly the case that needs it, which is the normal
   order of work. Every route test passed throughout, because they all attached
   the pattern first.
2. **An approved bundle could not start a revision.** "Publish a new bundle" was
   gated on the current bundle being editable. Publishing creates a new record;
   approval is precisely when somebody wants one.
3. **The pattern sheet asked for the 3D model** — a file that sheet has no card
   for.
4. **Five piece labels overlapped into a smear at 375px.** Labels are a constant
   screen size so they stay readable at any zoom, which at phone width is
   unreadable. Only the selected piece is labelled on a narrow viewport.
5. **A screen reader heard "5 pieces in in".**
6. **`{ ...mongooseSubdoc }` copies the document's internals, not its fields** —
   so every confirmed mapping read back from the database arrived blank. Invisible
   to the unit tests, which pass plain objects in.
7. **Eight new refusal codes were all arriving as `VALIDATION`,** because an
   unregistered code silently becomes it — as the errors table's own comment warns.

## 10. Limitations that remain, and whose they are

* **The test DXF publishes no notches, no drill holes, no sew line, no grading
  and no chosen piece names.** Every one is the file's silence, reported as such.
  The notch, drill-point, mirror-line, grade-point and seam-allowance paths are
  implemented and exercised by synthetic fixtures; they have not been run against
  a genuine export that contains them.
* **No genuine `.zprj` was available**, so the source path is verified with a
  ZIP-signature fixture and by refusing every other format. The exclusion check
  is what the format honestly allows.
* **A fully graded production pattern has not been run.** The storage ceiling
  (250,000 points) and the draw ceiling (24,000 nodes) are enforced and tested,
  and no real file has yet reached either.
* **The CLO export merges the whole garment into one mesh called `Cloth`**,
  surrounded by nineteen trims and a 94-node avatar skeleton. So the pattern
  pieces cannot be highlighted individually, and the workspace says so in the
  brief's own words rather than claiming a collar it does not contain.
