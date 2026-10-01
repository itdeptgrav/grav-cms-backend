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
