# Controlled Documents (Policy · SOP · Machine Work Instruction) — Product and Architecture Plan

> **Status:** Approved direction, 2026-09-21. The user chose the structured builder and accepted the recommended answers to D1–D14, with one change: D3 now includes floor-device reading in v1 (§12). The plan was revised the same day to close four gaps: a recorded review, visibility of reused images, PDF cache identity, and stable machine IDs.
>
> - **Decision:** ADR-008, `docs/decisions/controlled-documents-boundary.md`
> - **Audit:** `docs/audits/controlled-documents-existing-vs-missing.md`
> - **Roadmap:** `docs/tasks/controlled-documents-roadmap.md`
>
> This plan does **not** replace `docs/tasks/current-task.md`, which holds Image Studio slice 0.

## 1. Outcome

GRAV can write, review, approve, publish, revise, retire, search, print and import three kinds of written business document:

- **Policies**
- **Standard Operating Procedures (SOPs)**
- **Machine Work Instructions (MWIs)**

This happens in one controlled app inside the shared CMS top bar. Every reader sees the version currently in force. Authorised people can see the history. A worker at a machine can open that machine's current approved instruction on a paired floor device without a personal login.

Points rules and HR calculations keep working exactly as they do today. They may carry a link to the document that *explains* them.

## 2. Ownership boundary

**The Controlled Documents app owns:**
- Document identity and numbering.
- Templates.
- Structured content.
- Assets (images and attachments).
- The review, approval, effective and retire lifecycle.
- Version history and audit.
- PDF rendering.
- Search.
- Legacy import.
- Links from other records to a document.
- Floor-device pairing for read-only instruction display.

**It does not own:**
- Points and deduction rules or their calculations: SOP points, C1–C4, Timer-SOP, and the attendance, salary, payroll and leave settings. It also does not own the security of the CoWork scoring settings, which is a separate task (see §13).
- Help articles, which stay in `grav-cms/content/help/`.
- HR letters issued to one employee, which stay in `EmployeeDocument`.
- The shared File Manager and its permissions.
- IE standards and physical machine assignment. The machine register stays owned by Production and Maintenance.
- Barcode generation, scanning and production events.
- Training records, read acknowledgements and e-signature.

**In one sentence:** a controlled document says what must be done and who approved it. A rule decides what a breach costs. A link records that a document explains a rule; it never proves what the rule's values were at a past date.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Document** | The stable identity: document ID (e.g. `SOP-PRD-0012`), type, owning department, owner and audience. It is never deleted. |
| **Version** | One numbered revision (`v1`, `v2`…) holding the full content and metadata. Only drafts can be edited. |
| **Template** | A section schema for each document type, defined in code and stamped on every version as `templateKey@templateVersion`. |
| **Asset** | An image or file that belongs to a document. Versions refer to assets; assets are never copied. |
| **Effective version** | The approved version in force at a given instant. It is worked out from the dates and is never stored as a flag. |
| **Link** | A record tying a GRAV rule or a physical machine to a document. |
| **Floor device** | A shared terminal paired by a controller. It can read only the effective instructions for the machines assigned to it. |

## 4. Templates

Templates are code constants in `services/controlledDocs/templates.js`. Each template carries a version, and a template is never edited in place. Each section declares:

- `key`
- `title`
- `required`
- the block kinds it allows
- minimum counts

Every required section must be non-empty before a version can be submitted.

| Policy (`POLICY@1`) | SOP (`SOP@1`) | Machine Work Instruction (`MWI@1`) |
|---|---|---|
| Purpose* | Purpose* | Machine & operation* (description, optional IE operation code, attachments/folders) |
| Scope* | Scope* | Safety & PPE* (≥1 item) |
| Policy statement* | Responsibilities* | Pre-start checks* (numbered steps) |
| Definitions | Definitions | Setup (numbered steps, images) |
| Responsibilities* | Prerequisites, materials & PPE | Operating steps* (≥1 numbered step, images per step) |
| Compliance & consequences* | Procedure* (≥1 numbered step) | Quality checkpoints* |
| Exceptions | Quality checks & records | Faults & stoppage response* |
| Related documents | Safety | Cleaning & operator maintenance |
| References | Exceptions & escalation | Related documents |
| | Related documents | |

`*` marks a required section.

**Block kinds.** Blocks are typed JSON and never HTML:

- `paragraph`
- `list`: ordered or unordered.
- `step`: numbered automatically within its section. Fields are `text`, an optional `keyPoint`, `reason`, `flag` (`safety|quality|none`) and `imageAssetIds[]`.
- `callout`: `warning`, `caution` or `note`.
- `table`: small, with plain cells.
- `image`: an asset plus a caption.
- `attachment`: an asset plus a label.
- `docRef`: another controlled document, referenced by its document ID.

Inline text allows the Help parser's limited subset (bold, italic and links) and is escaped on render.

## 5. Canonical records (MongoDB, `models/CMS_Models/ControlledDocs/`)

### 5.1 `CdDocument` (`cd_documents`)

- **Identity:** `companyId`; `docNumber` (unique per company); `type` (`POLICY|SOP|MWI`).
- **Ownership:** `departmentId` plus a `departmentCode` and `departmentName` snapshot; `ownerEmployeeId`.
- **Audience:** `{ kind: ALL | DEPARTMENTS | ROLES, departmentIds[], roleKeys[] }`.
- **Tags:** `tags[]`.
- **Origin:** `origin` (`AUTHORED|LEGACY_IMPORT`) and `legacyDocNumber`.
- **Retirement:** `retirement` (`{ effectiveAt, byActor, reason }` or null).
- **Housekeeping:** `latestVersionNumber`, `createdByActor`, timestamps.

It is mutable only through service calls that also write a `CdEvent`.

### 5.2 `CdVersion` (`cd_versions`)

| Field | Notes |
|---|---|
| `documentId`, `companyId`, `versionNumber` | Unique on `{documentId, versionNumber}`. |
| `status` (stored) | `DRAFT`, `IN_REVIEW`, `REVIEWED`, `APPROVED`, `DISCARDED`. |
| `templateKey`, `templateVersion` | Frozen at creation. |
| `title`, `summary`, `sections[]` | Typed blocks as described in §4. |
| `assetIds[]` | **Computed by the server** from the blocks on every save. It is part of the content and frozen with it. |
| `changeSummary` | Required. Defaults to "Initial issue" for v1. |
| `basedOnVersionNumber` | The approved version this draft was revised from. |
| `authorEmployeeId`, `reviewerEmployeeId`, `approverEmployeeId` | Named at submit. The reviewer and approver must not be the author. |
| `submittedAt/By` | |
| `review` | `{ reviewerEmployeeId, decision: "ENDORSED", comment, at, contentHash }`. Written only by the named reviewer's endorsement, and cleared when the version is returned. |
| `returnedAt/By/comment` | The most recent return. Every return is also recorded as a `CdEvent`. |
| `approvedAt/By`, `effectiveDate`, `reviewDueDate` | Set at approval. |
| `contentHash` | SHA-256 over the canonical JSON of the content plus the `sha256` of every referenced asset. Computed at submit and re-verified at review and at approval. |
| `revision` | Optimistic-concurrency counter for draft saves. |
| `searchText` | Denormalised plain text used for search. |
| `legacy` | `{ sourceAssetId, originalApprovedOn, originalApprover }`, for imported documents only. |

**Partial unique indexes:**
- One open version per document, where `status ∈ {DRAFT, IN_REVIEW, REVIEWED}`.
- One approved version per `{documentId, effectiveDate}`.

### 5.3 `CdAsset` (`cd_assets`) — document-scoped and immutable

**Fields:**
- **Identity:** `companyId`, `documentId`, `uploadedInVersionId` (provenance only, never used to authorise).
- **Storage:** `driveFileId`, `sha256`, `bytes`.
- **File details:** `mimeType` (sniffed from magic bytes), `originalName`, `kind` (`IMAGE|ATTACHMENT|LEGACY_SOURCE`).
- **Actor:** `uploadedBy`.

**Storage.** Bytes are stored through `services/companyDrive.service.js` in a **dedicated** Drive folder. Assets never become `Doc_File` rows.

**Rules:**
1. An asset belongs to one document, and its bytes and metadata never change after upload.
2. **Read access is decided by reference, not by who uploaded it.** A caller may read asset *A* if and only if the caller may read some version *V* of the same document where `V.assetIds` contains *A*:
   - a reader needs the effective version;
   - `cdoc.history.read` covers any version;
   - a floor device needs the effective MWI for one of its machines.

   So an image uploaded in v1 and still used in v3 stays visible to readers of v3 after v1 is retired.
3. A draft may only reference assets of its own document.
4. "Removing" an image from a draft only removes the reference. Bytes can be deleted only if no `IN_REVIEW`, `REVIEWED` or `APPROVED` version has ever referenced the asset. A test asserts this.

### 5.4 `CdLink` (`cd_links`)

**Fields:**
- `companyId`, `documentId`.
- `versionId`: required for `PINNED_VERSION`; null for `FOLLOW_EFFECTIVE`.
- `mode`: `PINNED_VERSION|FOLLOW_EFFECTIVE`.
- `relation`: `EXPLAINS|INSTRUCTS`.
- `targetKind` and `targetId`.
- `targetSnapshot`: a display snapshot, e.g. the machine's name and serial number at link time.
- `createdBy`, `removedAt/By` (soft removal).

| `targetKind` | `targetId` | Mode | Relation |
|---|---|---|---|
| `SOP_RULE` | `Sop._id` | `PINNED_VERSION` (must be an `APPROVED` version) | `EXPLAINS` |
| `C4_POLICY` | HR `Policy._id` | `PINNED_VERSION` | `EXPLAINS` |
| `SYSTEM_RULE` | Stable key, e.g. `C1.deadline`, `TIMER.idlePool` | `PINNED_VERSION` | `EXPLAINS` |
| `MACHINE` | `Machine._id` (the same identity that production scans already use) | `FOLLOW_EFFECTIVE` | `INSTRUCTS` |

**`EXPLAINS` links.** These state only that the document explains the rule. The rule rows and the CoWork settings are mutable and unversioned, so a link can never prove which point values applied on a past date. UI and API copy must say "Explained by POL-HR-0003 v2". It must never say "enforced by", "governed by" or show historical values.

**Machine identity.**
- The link key is `Machine._id`, never the machine name, serial number or free-text `type`.
- `Machine.type` is free text with no reference to `MachineType`, and machines have no `companyId`. Links by machine type are therefore **deferred** until the company-scoped machine identity contract in the IE plan (§3.1) exists.
- To apply one instruction to many machines, the author selects the machines explicitly. The UI may filter the list by type text as a convenience, but one link row is stored per machine.
- Machines can be hard-deleted. A link whose machine no longer exists resolves to `CD_MACHINE_NOT_FOUND` and is listed as an orphan for controllers. It is never re-pointed automatically.
- At most one active `INSTRUCTS` link per machine, enforced by a partial unique index on `{targetKind: MACHINE, targetId}` where `removedAt` is null.

### 5.5 `CdFloorDevice` (`cd_floor_devices`)

**Fields:**
- **Identity:** `companyId`, `label`.
- **Scope:** `machineIds[]` (explicit `Machine._id` values).
- **Pairing:** `pairingCodeHash`, `pairingExpiresAt`.
- **Token:** `tokenHash`, `tokenIssuedAt`, `lastSeenAt`.
- **Revocation:** `revokedAt/By`.
- **Audit:** `createdBy`.

Tokens and pairing codes are stored only as SHA-256 hashes. See §12.

### 5.6 `CdEvent` (`cd_events`) — append-only

**Fields:** `companyId`, `documentId`, `versionId`, `action`, `actor` (an employee, or `{ kind: "floor_device", deviceId }`), `at`, `details`.

**Actions:**
- Lifecycle: `CREATED`, `DRAFT_SAVED`, `SUBMITTED`, `REVIEW_ENDORSED`, `RETURNED`, `APPROVED`, `DISCARDED`, `REVISED`, `RETIRED`, `RETIREMENT_CANCELLED`.
- Assets: `ASSET_ADDED`, `ASSET_UNREFERENCED`.
- Links: `LINKED`, `UNLINKED`.
- Other: `IMPORTED`, `PDF_EXPORTED`, `OWNER_CHANGED`.
- Floor devices: `DEVICE_REGISTERED`, `DEVICE_PAIRED`, `DEVICE_REVOKED`.

Every mutating hook is blocked, following `SpActionHistory`.

### 5.7 `CdSequence`, `CdGrant`, `CdPdfCache`

- **`CdSequence`:** `{ companyId, prefix }` maps to `next` through an atomic `$inc`.
- **`CdGrant`:** `{ companyId, employeeId, role: AUTHOR|REVIEWER|APPROVER|CONTROLLER, departmentIds[] | allDepartments, grantedBy, revokedAt }`.
- **`CdPdfCache`:** `{ cacheKey (unique), documentId, versionId, renderInput (canonical JSON), driveFileId, sha256, bytes, createdAt }`, with a 30-day TTL. See §10.

## 6. Lifecycle and versioning rules

```
DRAFT ─submit─▶ IN_REVIEW ─reviewer endorses─▶ REVIEWED ─approver approves─▶ APPROVED ─(effectiveDate)─▶ EFFECTIVE ─(successor effective | retired)─▶ RETIRED
  ▲                 │                              │
  └────return───────┴────────────return────────────┘           DRAFT ─discard─▶ DISCARDED
```

**Stored statuses:** `DRAFT`, `IN_REVIEW`, `REVIEWED`, `APPROVED`, `DISCARDED`. The user-facing "Review" stage covers `IN_REVIEW` (awaiting review) and `REVIEWED` (awaiting approval).

**Derived states.** `lifecycleOf(version, document, asOf)` works out the rest:
- `APPROVED` with `effectiveDate > asOf` is **Approved (scheduled)**.
- The approved version with the latest `effectiveDate ≤ asOf`, while the document is not retired at `asOf`, is **Effective**.
- Any other approved version whose date has passed, or the effective version once `retirement.effectiveAt ≤ asOf`, is **Retired**. It is labelled "Retired — superseded by vN" or "Retired — withdrawn: <reason>".

This is the pattern from `board-policy-lifecycle.md`: no cron, no rewriting of rows, and point-in-time queries.

**Rules:**
1. **Editing.** Only `DRAFT` content can be edited. Saves use `If-Match: <revision>`; a stale save returns 409 `CD_DRAFT_STALE`.
2. **Submit.** Submitting validates the template and requires a named reviewer and approver, neither of whom is the author. It computes `contentHash` and freezes the content. From `IN_REVIEW` onward the content fields are immutable at the schema level (CostingVersion-style hooks plus a lifecycle token).
3. **Review.** Moving from `IN_REVIEW` to `REVIEWED` requires all of the following:
   - The actor is the named reviewer and holds `cdoc.review` for the department.
   - The actor is not the author.
   - The recomputed hash equals `contentHash`.

   The review is recorded on the version with a comment, so an unrecorded review cannot be approved.
4. **Return.** The reviewer or the approver may return an `IN_REVIEW` or `REVIEWED` version to `DRAFT`, with a required comment. Returning clears `review`, so a resubmission needs a fresh review.
5. **Approve** is allowed **only from `REVIEWED`**. It runs as one guarded lifecycle save under optimistic concurrency (`optimisticConcurrency: true`): load the version, check `status === REVIEWED` and both hashes, arm the lifecycle token, then save. A concurrent transition fails with 409 `CD_CONCURRENT_TRANSITION`. All of the following must hold:
   - The actor is the named approver and holds `cdoc.approve`.
   - The actor is not the author or the submitter.
   - `review.contentHash === contentHash`.

   Approval records `effectiveDate`, `reviewDueDate` and the approver. When the reviewer and approver are the same person (D6), review and approval are still two separate recorded acts. Missing review returns 409 `CD_REVIEW_NOT_RECORDED`; a hash mismatch returns 409 `CD_CONTENT_CHANGED`.
6. **Immutable once approved.** An approved version cannot change, including its metadata. A correction is a new draft, `POST …/revisions`, copied from the latest approved version and carrying `basedOnVersionNumber` and the same asset references.
7. **One open version.** A document can have only one version that is `DRAFT`, `IN_REVIEW` or `REVIEWED` at a time.
8. **No backdating.** A new approval must have `effectiveDate` on or after the current effective version's `effectiveDate`, and on or after the approval day in IST.
9. **Retirement.** Retiring is a document-level act requiring `cdoc.retire`, with a reason and an instant that may be in the future. It can be cancelled before it takes effect. A retired document comes back only when a new version is approved.
10. **No hard deletes.** Drafts are discarded, links are soft-removed and devices are revoked.
11. **Controller changes.** Only controllers may change the owner, audience or department of a document. Every change is logged and never alters approved content.

## 7. Information architecture (frontend `grav-cms`)

The new app is **Controlled Documents**:
- Slug `controlled-docs`, route prefix `/controlled-docs`.
- Rendered through `FrostShell variant="top" appSlug="controlled-docs"`, so it uses the shared CMS top bar and app switcher.
- Visible to every active employee for reading (D1).
- Navigation lives in `components/controlledDocs/controlledDocsNavigation.js`, which contains no React.

| Screen | Route | Who can use it |
|---|---|---|
| Library | `/controlled-docs` | All readers |
| Document reader (effective version, metadata header, PDF, related links) | `/controlled-docs/d/[docId]` | Readers in the audience |
| Version view (with a "Not in force" banner) | `/controlled-docs/d/[docId]/v/[n]` | `cdoc.history.read` |
| History and audit timeline | `/controlled-docs/d/[docId]/history` | `cdoc.history.read` |
| Compare | `/controlled-docs/d/[docId]/compare?a=&b=` | `cdoc.history.read` |
| New document | `/controlled-docs/new` | `cdoc.author` |
| Draft editor | `/controlled-docs/d/[docId]/v/[n]/edit` | Author for the department |
| Review and approval inbox | `/controlled-docs/reviews` | Reviewers and approvers |
| Review due / overdue | `/controlled-docs/due` | Owners and controllers |
| Import | `/controlled-docs/import` | `cdoc.import` |
| Machine links and floor devices | `/controlled-docs/floor-devices` | `cdoc.floor.manage` |
| Settings (numbering, grants) | `/controlled-docs/settings` | Controllers and platform admins |
| **Floor instruction viewer** | `/floor-docs` (see below) | Paired floor devices only |

**Shell registration.** These are additive only:
- `components/shell/activeApplication.js`
- `components/onboarding/DepartmentIcon.js`
- `middleware.js` `PROTECTED_PREFIXES` gets `/controlled-docs`.
- `components/shell/useMyApps.js` gets a capability-gated tile via `GET /api/controlled-docs/access`.

**Floor viewer exception.** `/floor-docs` is added to `AppShell` `BARE_PATHS`, following the `/costing-approval` precedent. The device has no user session, so it gets no rail or top bar and it is **not** in `PROTECTED_PREFIXES`. It is authorised by the device token instead (§12). The viewer shows large type, one step per screen with its images, and next/previous controls. It never offers search, history or other documents.

**Rendering.** One shared renderer maps typed blocks to React elements and contains no React-specific logic of its own. It never uses `dangerouslySetInnerHTML`.

**Read-only chips elsewhere.** These are display only and change no behaviour:
- `app/hr/dashboard/sop/policies/page.js` and `app/ceo/dashboard/sop/page.js`: "Explained by POL-HR-0003 v2".
- The machine master detail page (`app/sales/dashboard/inventory-configurations/devices-machines/page.js` and its re-exports): "Current work instruction".

## 8. Roles and permissions

`services/controlledDocs/capabilities.js` holds a frozen catalogue of capability names, which are never renamed. A route contract refuses any route that is not declared in it.

| Capability | Grants |
|---|---|
| `cdoc.read` | Library, search, effective versions in the reader's audience, and the PDF of an effective version. |
| `cdoc.history.read` | All versions, drafts, compare and audit events for the granted departments. |
| `cdoc.author` | Create, edit drafts, revise, discard, upload assets and submit. |
| `cdoc.review` | Record a review (endorse) or return. |
| `cdoc.approve` | Approve, only as the named approver and never on your own work. |
| `cdoc.retire` | Retire or cancel a retirement. |
| `cdoc.import` | Import legacy documents. |
| `cdoc.link` | Create or remove links. Also needs write rights in the target domain, e.g. HR `COMPLIANCE_MANAGE` for C4 and SOP rules. |
| `cdoc.floor.manage` | Register, pair and revoke floor devices, and assign machines to them. |
| `cdoc.admin` | Numbering prefixes, grants and owner changes. |

**Role templates** (D2, backed by `CdGrant`, not `DepartmentRole`):
- `reader`: every active employee of the company, filtered by audience.
- `author`
- `reviewer`
- `approver`: includes reviewer.
- `controller`: everything above plus retire, import, link, floor.manage and admin.
- `platform_admin`: bootstrap only.

**Scope** is the company, resolved through `resolveCompanyForActor` and failing closed, combined with the departments in `CdGrant`.

**Denials** return the same 404 whether the document exists outside the caller's scope or does not exist at all.

**Floor devices** have no capabilities in this catalogue. Their token is accepted only by the floor router (§12).

## 9. API (`/api/controlled-docs`, CMS JWT unless marked)

| Method and path | Purpose |
|---|---|
| `GET /access` | The caller's capabilities. |
| `GET /templates` | Template definitions. |
| `GET /documents?q&type&departmentId&status&due&mine&page` | Library. Readers get effective versions only. |
| `POST /documents` | Create a document and a v1 draft. |
| `GET /documents/:docId`, `PATCH /documents/:docId` | Read identity and the effective version; change metadata (controller). |
| `GET /documents/:docId/effective?asOf=` | Point-in-time resolution. |
| `GET /documents/:docId/versions`, `…/versions/:n`, `…/compare`, `…/events` | History. |
| `POST /documents/:docId/revisions` | New draft from the latest approved version. |
| `PUT /versions/:versionId` | Save a draft (`If-Match`). |
| `POST /versions/:versionId/{submit,review,return,approve,discard}` | Lifecycle acts. `review` takes `{ comment }` and records the endorsement. |
| `POST /documents/:docId/retire`, `…/retire/cancel` | Retirement. |
| `POST /versions/:versionId/assets`, `DELETE /versions/:versionId/assets/:assetId` | Upload to a draft; remove a reference. |
| `GET /assets/:assetId` | Stream, authorised by reference (§5.3). |
| `GET /versions/:versionId/pdf` | PDF (§10). |
| `POST /imports`, `POST /imports/from-file/:docFileId` | Legacy import. |
| `GET/POST/DELETE /links`, `GET /links/resolve?targetKind=MACHINE&targetId=` | Links. |
| `GET /due?within=30` | Review-due list. |
| `GET/POST /floor-devices`, `POST /floor-devices/:id/pairing-code`, `PUT /floor-devices/:id/machines`, `POST /floor-devices/:id/revoke` | Device administration (`cdoc.floor.manage`). |
| `POST /floor/pair` *(no JWT; pairing code)* | Exchange a one-time code for a device token. |
| `GET /floor/machines` *(device token)* | The device's machines and whether each has an effective instruction. |
| `GET /floor/machines/:machineId/instruction` *(device token)* | The current effective MWI for that machine, if the machine is assigned to the device. |
| `GET /floor/assets/:assetId` *(device token)* | Only assets referenced by an instruction this device can currently see. |

The router is mounted once in `server.js`. It is **not** under `/api/hr`, `/api/ceo` or `/api/barcode-devices`.

## 10. PDF export

**Rendering.** PDFs are rendered on the server by `services/pdfRender.service.js` `htmlToPdf`, from an HTML renderer that escapes every typed block. Every page shows:
- the document ID, title, version and derived status label;
- the effective date and review date;
- "Page X of Y";
- the footer "Printed copies are uncontrolled. Check GRAV for the current version. Status as of <IST date>."

Drafts and versions that are not in force carry a watermark. If the renderer is unavailable, the endpoint returns 503 `RENDERER_UNAVAILABLE` and never a partial file. Who printed the file, and when, is recorded in a `PDF_EXPORTED` event rather than printed on the page, so the bytes can be cached.

**Cache identity.** This is what stops one document's PDF being served for another. `cacheKey = sha256(canonicalJson(renderInput))`, and `renderInput` is **everything printed on the page**:

- **Identity:** `documentId`, `versionId`, `docNumber`, `versionNumber`, `title`.
- **Status:** the derived status label and superseding version number, the retirement reason, and the watermark kind.
- **Dates:** `effectiveDate`, `reviewDueDate`, and the IST "status as of" date.
- **Content:** `templateKey@templateVersion`, `contentHash`, and the sha256 of every asset.
- **Renderer:** the renderer version constant.

Rules:
- Only versions that are `APPROVED` and not scheduled are cached. Drafts, versions in review and scheduled versions are rendered fresh every time.
- On a cache hit the service compares the stored `documentId`, `versionId` and `renderInput` with the request. Any difference counts as a miss and is logged as an error.
- The cache can be switched off with `CD_PDF_CACHE=0`.
- When a version's status label changes, for example from Effective to Retired, its key changes, so the old PDF is never served.

## 11. Search

**v1.** Search uses an escaped, case-insensitive regex over `docNumber`, `title`, `tags` and `searchText`, limited to versions the caller can see. The company and audience filters are applied inside the query. This follows the `Acc_search.js` precedent.

**Later.** Move to `$text` or Atlas Search when the collection passes about 2,000 versions (D9).

## 12. Floor devices: machine instruction on the machine screen (v1)

**Goal.** A worker standing at a machine can open that machine's current approved instruction on a shared floor device, such as a tablet or screen at the line, without a personal login. The documents do not become public.

**Pairing:**
1. A user with `cdoc.floor.manage` registers a device with a label and an explicit list of `Machine._id` values.
2. They generate a one-time pairing code: 8 characters from an unambiguous alphabet, valid for 10 minutes, usable once, and stored only as a hash.
3. On the device, someone opens `/floor-docs` and enters the code. `POST /floor/pair` returns a random 256-bit device token, stored only as a SHA-256 hash.
4. The device keeps the token in its own localStorage key (`cd_floor_token`) and sends it as `X-Cd-Floor-Token`.

**Scope:**
- The token is **not a JWT**. Only the floor router accepts it; every other API ignores the header.
- The device can read, and only read:
  - the list of its assigned machines;
  - for each of those machines, the current effective MWI (content and referenced assets).
- It cannot read drafts, history, other document types, search results, employee data or the PDF cache.

**Revocation:**
- The device is looked up on every request through an indexed `tokenHash` lookup. Revoking, or removing machines from the device, takes effect on the very next request.
- Re-pairing a device replaces its token.

**Abuse controls:**
- `/floor/pair` is rate-limited per IP and per device.
- An unknown or revoked token returns an identical 401 `CD_FLOOR_UNAUTHORISED`.
- `lastSeenAt` is updated at most once a minute.

**Audit:** device registration, pairing and revocation are recorded as `CdEvent` rows. Per-view logging is off by default to limit write volume.

**Boundary.**
- The floor viewer and floor API are a separate route and router. Barcode-device pages, `/api/barcode-devices`, scan endpoints, production tracking and Socket.IO rooms are neither used nor changed.
- `Machine._id` is read from the machine register only to validate an assignment and to show a name.

## 13. Links to rules; CoWork settings

- **SOP points rules, C4 policies and system rules** get `PINNED_VERSION` + `EXPLAINS` links to one exact approved version (§5.4). No field is added to `Sop`, `Policy`, `C4Config`, `BandConfig` or `Employee`, and no calculation or bleach endpoint changes.
- **When a newer version takes effect**, the link shows "Newer version in force — confirm link". It is never moved automatically.
- **Links do not prove historical point values.** SOP and C4 rule rows are edited in place. The C1, C2 and Timer-SOP values in Firestore `cowork_sop_settings/task_events` can currently be written by any logged-in CoWork user and have no history (audit §6).
- **Securing those settings is a separate task** in the CoWork repo and Firestore rules. This programme neither depends on it nor does it.

## 14. Migration and import

1. **Inventory, read-only.** A script lists every `Sop` rule, C4 `Policy`, `BandConfig` key and Timer-SOP system rule to CSV, so owners can map each rule to a document. It also lists machines, keyed by `_id`, so owners can plan MWI coverage.
2. **Legacy documents.**
   - Each one is imported as a document plus a version with `origin: LEGACY_IMPORT`. The original file becomes a `LEGACY_SOURCE` asset, and the body holds one "Imported source" section.
   - It then goes through the normal submit → review → approve path (D7). The original approver and date are recorded in `legacy`. The effective date is not earlier than the import date.
   - A structured v2 follows later as a normal revision.
3. **Rules are not migrated or altered.** Owners add `EXPLAINS` links after the documents take effect.
4. **Machines.** Controllers add `INSTRUCTS` links per `Machine._id` and then pair floor devices.
5. **Numbering.** Legacy numbers are kept in `legacyDocNumber`. New numbers use `{POL|SOP|MWI}-{DEPTCODE}-{NNNN}` per company (D5).

## 15. Acceptance criteria (programme)

**Readers and versions:**
- A reader sees exactly one effective version per document, or none. They never see a draft.
- An approved version cannot be changed through any door (API, mongoose method or re-save).
- A revision creates a new draft, and the previous approved version is unchanged, byte for byte, according to its `contentHash`.

**Review and approval:**
- Approval is impossible unless the named reviewer has recorded a review of the exact content hash being approved.
- The approver is never the author or the submitter.

**Assets and PDFs:**
- An image reused from v1 in v3 stays visible to readers of v3 after v1 is retired.
- An asset referenced only by a draft is never visible to readers or floor devices.
- A PDF is never served for a different document or version, or with a stale title or status. This is proven by a test with two documents whose content is identical and by a test covering a status transition.

**Machines and floor devices:**
- MWI links key on `Machine._id`, and a deleted machine shows up as an orphan.
- A paired floor device can open the current MWI for its own machines only.
- A revoked device is refused on its very next request.
- An unpaired browser gets nothing.

**Rules:**
- Rule links read "Explained by …" and never show historical values.
- Existing SOP and C4 endpoints return byte-identical responses.

**Protection and shell:**
- No diff touches the protected barcode, scan, production or points-calculation files (roadmap gate).
- The app renders inside the shared CMS top bar. The floor viewer is the documented bare-path exception.

## 16. Decisions (resolved 2026-09-21)

| # | Decision |
|---|---|
| D1 | The app is "Controlled Documents" at `/controlled-docs`, readable by every active employee. |
| D2 | Grants use a new `CdGrant` model (company × department × role), not `DepartmentRole`. |
| D3 | **Changed by the user.** In v1, CMS users read in the app, and workers read the current MWI on **paired, read-only floor devices** (§12). Documents are not public. Operator logins and QR codes are not part of v1. |
| D4 | The machine master detail page shows the current instruction, and the floor viewer is the worker's machine screen. Links key on `Machine._id`. Machine-type links are deferred (§5.4). |
| D5 | Numbering is `{POL\|SOP\|MWI}-{DEPTCODE}-{NNNN}`, per company. |
| D6 | A reviewer is required and must be someone other than the author. The review must be **recorded** before approval. The approver may be the same person as the reviewer (still two recorded acts), but not the author or submitter. |
| D7 | Legacy documents are imported and then attested through the normal review and approval path, flagged `LEGACY_IMPORT`, with no backdating before the import date. They are re-authored as v2 later. |
| D8 | The review period is 12 months for Policies and SOPs and 6 months for MWIs. v1 has a due list only, with no notifications. |
| D9 | Search uses an escaped regex in v1. Revisit above about 2,000 versions. |
| D10 | Documents belong to one company (`companyId` is required). |
| D11 | Read acknowledgements and training sign-off are not in v1. |
| D12 | The document version is not stamped on penalty records (`sopPoints.bleaches`). |
| D13 | Old versions are shown as "Retired — superseded by vN". |
| D14 | `SYSTEM_RULE` links are allowed with the relation `EXPLAINS` only, and never claim historical values. The CoWork settings access issue is a separate task. |
