# Controlled Documents Sequential Implementation Roadmap

> **Status:** Approved plan, 2026-09-21; sequencing updated at the user's request on 2026-09-22. F-0's document-page direction was accepted by the user on 2026-09-22. **CD-1 is next; no backend chunk is active yet.**
> This roadmap does **not** replace `docs/tasks/current-task.md`, which still tracks Image Studio work in the main checkout. Activate CD-1 in an isolated backend worktree when implementation begins; keep the main checkout's active task and unrelated changes untouched. The implementation brief is `docs/tasks/controlled-documents-cd-1.md`.
>
> - **Product plan:** `docs/product/controlled-documents.md`
> - **Decision:** ADR-008 (`docs/decisions/controlled-documents-boundary.md`)
> - **Audit:** `docs/audits/controlled-documents-existing-vs-missing.md`

## Sequencing rule

- Work on one chunk at a time. When it is done, stop, record the actual verification in `docs/handoff/latest-implementation.md`, and wait for the next chunk to be activated.
- Keep all unrelated uncommitted work in both repositories. Do not commit unless asked.
- **Frontend first:** complete F-0 below as a synthetic-data design prototype before CD-1. It has no API integration and makes no claim that document control works. After F-0 is reviewed, build CD-1 through CD-7 before connecting the frontend in CD-8 through CD-10. Keep the floor viewer tied to CD-13/CD-14.
- Run the **protection gate** at the end of every chunk.
- Test commands:
  - Backend: `npx jest test/controlled-docs`. This uses `MongoMemoryReplSet` via `test/setup.js`, and mocks Drive and puppeteer with `jest.mock`.
  - Frontend: `npm test` (`node --test` over `*.test.mjs`), plus a real-browser check where the chunk says so.

---

## F-0 — Frontend-first controlled-documents prototype (`grav-cms`) ✅

**Brief:** `docs/tasks/controlled-documents-f-0.md` (the complete prompt).

**Goal:** Make the library, structured builder, reader and review screens visible and usable with clearly labelled synthetic data, so the product flow can be reviewed before backend work.

**Boundary:** Preview-only, no API calls or real data, no app switcher registration or production route, no floor-device pairing, and no backend changes. After review, reuse the approved presentation components in CD-8 through CD-10 rather than maintaining a second implementation.

**Review outcome (2026-09-22):** The user accepted the formal document-page direction. The preview remains sample-data-only. The final page refinements are still uncommitted in the F-0 worktree; preserve them before removing that worktree.

---

## CD-0 — Audit, plan and decisions ✅

**Delivered:** the audit, the product plan, ADR-008, this roadmap and the CD-1 brief. Decisions D1–D14 are resolved (plan §16). The four plan gaps are closed:

- a recorded review
- asset visibility by reference
- PDF cache identity
- stable machine IDs

---

## CD-1 — Backend records, templates, content hashing and lifecycle core (no routes)

**Brief:** `docs/tasks/controlled-documents-cd-1.md` (the complete prompt).

**Goal:** Build the persistence and pure rules that everything else depends on. This includes a review gate and immutability that are enforced at the model and service layer, not only in routes.

**Scope:**
- **Models:** `CdDocument`, `CdVersion`, `CdAsset` (schema only), `CdEvent`, `CdSequence`.
- **Services:** `constants/controlledDocs.js`, and the templates, content, lifecycle, transitions and numbering services.

**Out of scope:** `CdLink`, `CdGrant`, `CdFloorDevice`, `CdPdfCache`, any route, and `server.js`.

**Acceptance and tests:** see the brief.

---

## CD-2 — Capabilities, access resolution, grants, `/access`

**Work:**
- `services/controlledDocs/capabilities.js`, containing the catalogue and role templates from plan §8, including `cdoc.floor.manage`.
- The `CdGrant` model.
- `services/controlledDocs/access.js`, which resolves in this order: actor, company via `resolveCompanyForActor` (fail closed), grants, capabilities per department.
- `Middlewear/controlledDocsContract.js`. Any route not declared in the contract returns 403 `CD_ROUTE_NOT_DECLARED`.
- Router `routes/CMS_Routes/ControlledDocs/index.js` with only `GET /access`, mounted once in `server.js` at `/api/controlled-docs`.
- A grant administration service.

**Must not:** change `DepartmentRole`, the HR contract, or login.

**Acceptance:**
- An unknown user gets no capabilities.
- A reader gets only `cdoc.read`.
- An author in department A has no rights in department B.
- An actor with no company membership fails closed.
- A platform admin can bootstrap the first controller.

**Tests:**
- `cd-access.test.js`: the full matrix.
- `cd-route-coverage.test.js`
- `cd-access.route.test.js`: real JWTs over HTTP.

---

## CD-3 — Authoring API

**Work:**
- `POST /documents`
- `PUT /versions/:id`, using `If-Match` and recomputing `assetIds` on the server
- `POST /documents/:id/revisions`, which copies content and asset references
- `POST /versions/:id/discard`
- `PATCH /documents/:id`, controller only
- A `CdEvent` for every write, plus `recordChange`

**Acceptance:**
- A stale draft returns 409 `CD_DRAFT_STALE`.
- A second open version returns 409 `CD_OPEN_DRAFT_EXISTS`.
- A revision leaves the source's `contentHash` unchanged.
- A client-supplied `assetIds` is ignored and recomputed.
- A document outside the caller's scope returns the same 404 as a missing one.

**Tests:** `cd-authoring.route.test.js`

---

## CD-4 — Review, approval, effective resolution, retirement

**Work:**
- Routes over the CD-1 transitions: `submit`, `review` (endorse, comment required), `return`, `approve`, `retire`, `retire/cancel`.
- Capability checks added on top of the actor invariants already enforced in CD-1.
- Read routes: `GET /documents/:id/effective?asOf=`, `versions[/:n]`, `events`, `compare`, and `GET /due`.

**Acceptance:**
- Approving from `IN_REVIEW` returns 409 `CD_REVIEW_NOT_RECORDED`.
- Approval succeeds only after the named reviewer has endorsed the same `contentHash`.
- A reviewer who is also the approver needs two separate calls.
- A return clears the review, and a resubmitted version needs a fresh review.
- A future-dated approval is shown as scheduled, and the previous version stays effective until that date.
- A reader never receives a draft.

**Tests:**
- `cd-workflow.route.test.js`
- `cd-effective-resolution.test.js`
- `cd-compare.test.js`

---

## CD-5 — Assets

**Work:**
- `POST /versions/:id/assets`, drafts only:
  - magic-byte check for PNG, JPEG, WebP and PDF; DOCX and XLSX are allowed only as attachments
  - 10 MB limit for images, 25 MB for attachments
  - sha256 recorded
  - stored in the Drive folder `GOOGLE_DRIVE_CDOCS_FOLDER_*`
- `DELETE` removes the reference only. Bytes are deleted only if the asset was never referenced by a submitted version.
- `GET /assets/:id` is **authorised by reference** (plan §5.3). It sets `nosniff` and never exposes the provider URL.

**Must not:** create `Doc_File` rows or change `routes/Access/files.js`.

**Acceptance:**
- An image uploaded in v1, reused in v3, and still present after v1 is retired can be fetched by a reader of the effective v3.
- An image removed in a v4 draft is still fetchable while v3 is effective.
- An asset referenced only by a draft returns 404 to readers.
- An asset belonging to another document can never be referenced by this document.
- A spoofed MIME type is rejected.

**Tests:** `cd-assets.route.test.js`, with Drive mocked. It covers all of the scenarios above.

---

## CD-6 — Library listing and search

**Work:**
- `GET /documents` with filters and `q`.
- Search uses an escaped regex over `docNumber`, `title`, `tags` and `searchText`.
- Scope filters are applied inside the query.

**Acceptance:**
- Documents outside the caller's audience are never listed.
- Regex metacharacters in `q` are treated as literal text.

**Tests:** `cd-search.route.test.js`

---

## CD-7 — PDF export with an identity-safe cache

**Work:**
- `services/controlledDocs/renderHtml.js`: escapes all content and is a pure function.
- `services/controlledDocs/pdfRenderInput.js`: builds the canonical render input and its `cacheKey` (plan §10).
- The `CdPdfCache` model.
- `GET /versions/:id/pdf` via `htmlToPdf`.
- A `PDF_EXPORTED` event recording the printer and time.
- `CD_PDF_CACHE=0` turns the cache off.

**Acceptance:**
- Two documents with identical content, titles, numbers and asset hashes produce **different** keys, and each PDF shows its own header.
- When a version moves from Effective to Retired, the key changes and the new PDF shows "Retired — superseded by vN".
- A cache row whose stored identity does not match the request is treated as a miss and logged.
- Drafts and scheduled versions are never cached.
- Script or HTML inside content renders as plain text.
- If the renderer is unavailable, the route returns 503.

**Tests:**
- `cd-render-html.test.js`
- `cd-pdf-render-input.test.js`: every printed field changes the key, and the print actor or time never does
- `cd-pdf.route.test.js`: puppeteer mocked

---

## CD-8 — Frontend app shell, library and reader (`grav-cms`)

**Work:**
- `components/ControlledDocs_DashboardLayout.js`, using `FrostShell variant="top" appSlug="controlled-docs"`.
- A navigation module with no React in it.
- Additive registrations in `activeApplication.js`, `DepartmentIcon.js`, `middleware.js` `PROTECTED_PREFIXES` and `useMyApps.js` (a capability tile).
- Pages: `/controlled-docs` and `/controlled-docs/d/[docId]`.
- `lib/controlledDocs/blocks.js`: a shared block renderer with no React in it.

**Must not:** change the behaviour of `TopBar`, `FrostShell` or `AppShell`.

**Acceptance:**
- The app appears in the shared top bar and switcher only for users with `cdoc.read`.
- The reader shows the document ID, version, effective date, review date, owner and approver.

**Tests:**
- Navigation, blocks and `activeApplication` `.test.mjs` files.
- A browser check with synthetic data.

---

## CD-9 — Frontend editor and create flow

**Work:**
- The create wizard.
- Template-driven section forms with a validation checklist.
- Steps: add, reorder and delete, each with a key point, a flag and images.
- Autosave using the draft's revision.
- A submit panel that picks the reviewer and approver from users who hold the right capabilities.

**Acceptance:**
- Missing required sections are listed by name and block submission.
- Steps renumber when reordered.
- A conflicting edit from a second tab gets a stale-draft message.

**Tests:**
- `lib/controlledDocs/editorModel.test.mjs`
- A source-text endpoint test.
- A browser check authoring one document of each type.

---

## CD-10 — Frontend review, approval, history, compare, due list

**Work:**
- The reviews inbox, split into "Awaiting my review" (Endorse or Return) and "Awaiting my approval" (Approve or Return).
- An approve dialog that asks for the effective date and review date.
- History with derived states and an event timeline, a version view, compare, retire, and the due list.

**Acceptance:**
- The approve button appears only on `REVIEWED` versions where the viewer is the named approver.
- The author never sees Approve.
- History is hidden from plain readers.

**Tests:**
- `lifecycleLabels.test.mjs`
- A browser run through: draft → submit → endorse → approve (future-dated) → effective → revise → return → resubmit → endorse → approve → the old version shows as retired.

---

## CD-11 — Import of existing documents

**Work:**
- `POST /imports` and `POST /imports/from-file/:docFileId`. The latter checks the drive's `mayRead` and copies the bytes; it never modifies the `Doc_File`.
- Each import creates a `LEGACY_IMPORT` draft, which then follows the normal submit → review → approve path.
- `/controlled-docs/import`: single or batch upload, a metadata mapping table, and a picker for existing files.

**Acceptance:**
- An imported document becomes effective only after a recorded review and approval.
- The original file can be downloaded.
- A restricted file the importer cannot read is refused.

**Tests:**
- `cd-import.route.test.js`
- A browser import of two synthetic PDFs.

---

## CD-12 — Links to rules and machines

**Work:**
- The `CdLink` model, `GET/POST/DELETE /links` and `GET /links/resolve`.
- `EXPLAINS` links (to `SOP_RULE`, `C4_POLICY` and `SYSTEM_RULE`) must pin an `APPROVED` version. Creating one also requires write rights in the target domain.
- `INSTRUCTS` links (to `MACHINE`) are keyed on `Machine._id`, which must exist when the link is created. A partial unique index allows only one active link per machine.
- Orphaned links are listed.
- Links show a "newer version in force" flag.
- Frontend chips reading "Explained by …" on the C4 page and the CEO SOP page, and a "Current work instruction" item on the machine master page.

**Must not:**
- Add fields to `Sop`, `Policy`, `C4Config`, `BandConfig`, `Employee` or `Machine`.
- Change any calculation, bleach, machine write or scan path.

**Acceptance:**
- A chip still shows v2 after v3 takes effect, and flags the change.
- Every link response and chip uses the word "explains". None mention point values.
- A deleted machine leaves an orphaned link, not an error.
- The existing `/api/hr/policy`, `/api/hr/sop` and `/api/cms/machines` responses are unchanged.

**Tests:**
- `cd-links.route.test.js`
- An unchanged-response snapshot test.
- A frontend source-text test.

---

## CD-13 — Floor devices (backend)

**Work:**
- The `CdFloorDevice` model.
- Device administration routes (`cdoc.floor.manage`):
  - register a device
  - issue a pairing code: 8 characters, 10 minutes, single use, stored hashed
  - assign machines by `Machine._id`
  - revoke a device
- `POST /floor/pair`, rate-limited.
- A separate floor router that accepts only `X-Cd-Floor-Token` (256-bit random, stored as a sha256 hash, looked up on every request) and serves:
  - `GET /floor/machines`
  - `GET /floor/machines/:machineId/instruction`
  - `GET /floor/assets/:assetId`
- `CdEvent` records for registration, pairing and revocation.

**Must not:**
- Touch `/api/barcode-devices`, scan endpoints, production tracking, Socket.IO, `extractToken`, or the JWT middlewares.

**Acceptance:**
- A paired device can read the effective MWI only for its assigned machines.
- For a machine not assigned to the device, it gets the same 404 as for a missing machine.
- The device token is refused on every non-floor route. A JWT is refused on floor routes.
- A revoked token, or a machine removed from the device, fails on the very next request.
- A pairing code works once, expires, and survives a brute-force burst thanks to the rate limit.
- A draft, a scheduled version, a history entry, a non-MWI document, or an asset not referenced by the current instruction is never returned.

**Tests:**
- `cd-floor-pairing.test.js`
- `cd-floor.route.test.js`
- `cd-floor-isolation.test.js`: the token is replayed against every other controlled-docs route and a sample of other `/api` routes, and each returns 401 or 403.

---

## CD-14 — Floor viewer and device administration (frontend)

**Work:**
- `/floor-docs`: a bare route added to `AppShell` `BARE_PATHS`, **not** added to `PROTECTED_PREFIXES`. It has:
  - a pairing screen
  - a machine picker
  - a step-by-step, large-type instruction view with images and next/previous controls
  - an "Unpaired / revoked" state
- `/controlled-docs/floor-devices`: register a device, show the pairing code, assign machines, revoke, and see last seen.

**Must not:** change any barcode-scanner-device page or the production pages.

**Acceptance:**
- A tablet paired with a code shows only its machines' current instructions.
- After revocation, the next navigation shows the unpaired state.
- An unpaired browser sees only the pairing screen.

**Tests:**
- `lib/controlledDocs/floorViewerModel.test.mjs`
- A source-text test that `/floor-docs` calls only `/api/controlled-docs/floor/*`.
- A browser test at tablet size.

---

## CD-15 — Migration inventory and rollout runbook

**Work:**
- `scripts/controlledDocs/inventory.js`: a **read-only** CSV export of:
  - `Sop` rules
  - C4 `Policy` rows
  - `BandConfig` keys
  - Timer-SOP system rules
  - machines, keyed by `_id`
- The runbook `docs/guides/controlled-documents-rollout.md`, covering:
  1. Bootstrap the controller.
  2. Set up grants.
  3. Set numbering prefixes.
  4. Import documents.
  5. Link rules.
  6. Link machines.
  7. Pair devices.
  8. Train reviewers.

**Acceptance:**
- A test spies on the model write methods and shows the script writes nothing.
- The runbook has been walked through on dev with synthetic data.

---

## Protection gate (every chunk)

1. `git diff --stat` in both repositories shows **no** changes to:
   - The barcode, scan and production files listed in audit §5, including `/api/barcode-devices`, the production tracking routes and models, and the Socket.IO wiring.
   - `models/sopmodel/*`, `models/HR_Models/Policy.js`, `C4Config.js`, `models/BandConfig.js`, `models/Employee.js`.
   - `models/CMS_Models/Inventory/Configurations/Machine.js` and `routes/CMS_Routes/Inventory/Configurations/machines.js`.
   - `services/timerSop.service.js`, `services/c1Service.js`, `services/pmpService.js`.
   - `routes/soproutes/*`, `routes/HrRoutes/policyRoutes.js`, `hrSopRoutes.js`, `routes/CEO_Routes/ceoSopRoutes.js`, `routes/task_routes/c2Band.routes.js`.
   - `routes/Access/files.js`, `grav-cms/content/help/**`, `docs/tasks/current-task.md`.

   The only exceptions are the named chunk-specific frontend additions: the display chips in CD-12 and the shell registrations in CD-8 and CD-14.
2. Pre-existing uncommitted changes in both repositories are still present and unmodified. Compare against a `git status --porcelain` snapshot taken before the chunk.
3. The existing Jest baseline fails the same set of tests as before the chunk.

## Explicit non-goals

- Read acknowledgements, training sign-off, e-signature, and external distribution.
- Personal operator logins, public or QR-only access, and links by machine type (these wait for the machine identity contract).
- Automatic conversion from legacy formats, and admin-editable templates.
- Notifications for due reviews.
- Stamping document versions on penalty records.
- Any change to points calculations, the CoWork scoring settings (a separate task), Help content or HR letters.
