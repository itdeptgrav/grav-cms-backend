# CD-1 — Controlled Documents: records, templates, content hashing and lifecycle core

> **Status:** Ready to activate in an isolated backend worktree after the user's F-0 review on 2026-09-22. **Not active yet.** The main checkout's `docs/tasks/current-task.md` still holds Image Studio work. Keep that file and checkout untouched; the CD-1 implementer may set the active task inside their isolated worktree only.
>
> - **Roadmap:** `docs/tasks/controlled-documents-roadmap.md`
> - **Plan:** `docs/product/controlled-documents.md` §4–§6, §10
> - **ADR:** ADR-008

---

## Implementation prompt

You are implementing **Chunk CD-1** of Controlled Documents from `/Users/risheeray/grav-cms-backend` in an isolated backend worktree. The frontend repo is not touched. Read the approved planning files from the main backend checkout if they are not yet tracked in the worktree; do not lose or rewrite them.

**Before writing code:**
1. Read these files:
   - `docs/product/controlled-documents.md`, especially §4, §5.1–5.3, §5.6, §5.7 (`CdSequence`), §6 and §10
   - `docs/decisions/controlled-documents-boundary.md`
   - `docs/tasks/controlled-documents-roadmap.md`, including its protection gate
   - this brief
2. Run `git status --porcelain > "$SCRATCH/cd1-before.txt"`. Many unrelated files are already modified or untracked. Leave every one of them exactly as it is.
3. Run the existing Jest suite once, `npx jest 2>&1 | tail -40`, and record the pass/fail baseline.
4. Report your file-level plan before you start writing.

### Scope

Build persistence and pure logic only. There are **no routes and no `server.js` changes**. Capabilities, grants, links, floor devices, the PDF cache and Drive I/O belong to later chunks. Transition functions in this chunk enforce the **actor invariants** (named reviewer or approver, not the author, not the submitter) and the **state and hash invariants**. They do **not** check capabilities; CD-2 and CD-4 add those in front.

### Files to create

| File | Contents |
|---|---|
| `constants/controlledDocs.js` | Frozen vocabularies:<br>• `DOC_TYPES` (`POLICY`, `SOP`, `MWI`) and their number prefixes (`POL`, `SOP`, `MWI`)<br>• `VERSION_STATUS` (`DRAFT`, `IN_REVIEW`, `REVIEWED`, `APPROVED`, `DISCARDED`)<br>• `DERIVED_STATE` (`DRAFT`, `IN_REVIEW`, `REVIEWED`, `SCHEDULED`, `EFFECTIVE`, `RETIRED`, `DISCARDED`)<br>• `RETIRED_REASON` (`SUPERSEDED`, `WITHDRAWN`)<br>• `BLOCK_KINDS`<br>• `EVENT_ACTIONS` (the full list in plan §5.6)<br>• `ACTOR_TYPES`<br>• `ORIGINS`<br>• `ERROR_CODES`: `CD_TEMPLATE_INVALID`, `CD_VERSION_IMMUTABLE`, `CD_INVALID_TRANSITION`, `CD_REVIEW_NOT_RECORDED`, `CD_CONTENT_CHANGED`, `CD_SELF_REVIEW`, `CD_SELF_APPROVAL`, `CD_NOT_NAMED_REVIEWER`, `CD_NOT_NAMED_APPROVER`, `CD_BACKDATED_EFFECTIVE`, `CD_OPEN_DRAFT_EXISTS`, `CD_CONCURRENT_TRANSITION`, `CD_FOREIGN_ASSET` |
| `models/CMS_Models/ControlledDocs/CdDocument.js` | Fields from plan §5.1:<br>• unique index `{companyId, docNumber}`<br>• index `{companyId, type, departmentId}`<br>• `actor` sub-schema `{ type, id, employeeCode, name }` |
| `models/CMS_Models/ControlledDocs/CdVersion.js` | Fields from plan §5.2, with `optimisticConcurrency: true`.<br>**Indexes:**<br>• unique `{documentId, versionNumber}`<br>• partial unique `{documentId}` where `status ∈ {DRAFT, IN_REVIEW, REVIEWED}`; name it `one_open_version_per_document`<br>• partial unique `{documentId, effectiveDate}` where `status: APPROVED`<br>**Immutability**, modelled on `CostingVersion.js` (~L1260–1436):<br>• a module-private `LIFECYCLE_TOKEN` Symbol<br>• an exported `beginLifecycleTransition(doc)`<br>• `CONTENT_PATHS`: `title`, `summary`, `sections`, `assetIds`, `templateKey`, `templateVersion`, `changeSummary`, `basedOnVersionNumber`, `documentId`, `companyId`, `versionNumber`<br>• `LIFECYCLE_PATHS` per transition<br>**Rules:**<br>• a `DRAFT` may change content only through a save that bumps `revision`<br>• from `IN_REVIEW` onward, content paths are refused<br>• an `APPROVED` or `DISCARDED` version refuses **every** path except `updatedAt`/`__v`<br>• every query-level update, replace and delete is refused for non-draft rows; for simplicity, refuse them for all rows and make drafts save through documents<br>• document-level `deleteOne` is refused too (register with `{ document: true, query: true }`) |
| `models/CMS_Models/ControlledDocs/CdAsset.js` | Fields from plan §5.3. Append-only for metadata: every update door is refused and non-new `save` is refused. **Deletion is refused in CD-1**; CD-5 adds the guarded unreferenced-draft delete. Index `{documentId, sha256}`. |
| `models/CMS_Models/ControlledDocs/CdEvent.js` | Append-only, copying `SpActionHistory.js` L96–117. Also block document-level `deleteOne`. Indexes `{documentId, at}` and `{companyId, at}`. |
| `models/CMS_Models/ControlledDocs/CdSequence.js` | `{companyId, prefix}` unique, and `next: Number`. |
| `services/controlledDocs/templates.js` | Frozen `POLICY@1`, `SOP@1` and `MWI@1`, exactly as in plan §4. Exports `getTemplate(key, version)`, `listTemplates()`, and `validateAgainstTemplate(version)`, which returns `{ ok, errors: [{ sectionKey, code, message }] }`. It checks:<br>• required sections are present and non-empty<br>• minimum step and item counts<br>• block kinds are allowed per section<br>• no unknown section keys<br>• no unknown block kinds<br>• inline text within length limits |
| `services/controlledDocs/content.js` | Pure functions:<br>• `normaliseSections` (trim, number steps per section, drop empty blocks)<br>• `computeAssetIds(sections)` (deduplicated and sorted, from `step.imageAssetIds`, `image` and `attachment`)<br>• `toSearchText`<br>• `canonicalJson` (sorted keys, no `undefined`)<br>• `contentHash(version, assetsById)`: SHA-256 over canonical `{templateKey, templateVersion, title, summary, sections, changeSummary}` plus the sorted `[assetId, sha256]` pairs; throws `CD_FOREIGN_ASSET` if an asset is missing or belongs to another document |
| `services/controlledDocs/lifecycle.js` | Pure `lifecycleOf(version, document, asOf, { latestEffectiveVersionId, supersededBy })` returning `{ state, retiredReason, supersededByVersionNumber }`, plus `resolveEffective(documentId, asOf)`. The query takes the `APPROVED` version with the greatest `effectiveDate ≤ asOf` and returns null if `document.retirement?.effectiveAt ≤ asOf`. There is no cron and nothing is written. Use the IST pattern in `CLAUDE.md` for "approval day" comparisons. |
| `services/controlledDocs/transitions.js` | `createDocumentWithDraft`, `saveDraft` (revision check → `CD_DRAFT_STALE`, recomputes `assetIds` server-side), `reviseFromApproved`, `submit`, `endorseReview`, `returnToDraft`, `approve`, `discard`, `retireDocument`, `cancelRetirement`. Each one loads, checks invariants, arms the token where needed, saves, and writes a `CdEvent` in the same Mongo transaction. Mongo `VersionError` or `E11000` on the open-version index is mapped to `CD_CONCURRENT_TRANSITION` / `CD_OPEN_DRAFT_EXISTS`. |
| `services/controlledDocs/numbering.js` | `allocateDocNumber({ companyId, type, departmentCode, session })` uses `findOneAndUpdate({$inc:{next:1}}, {upsert:true, new:true})` on `CdSequence` and formats `POL-HR-0001`. `departmentCode` must be uppercase A–Z/0–9, 2–6 characters. |
| `test/controlled-docs/*.test.js` | See the tests section below. |

### Transition invariants (enforced in `transitions.js` and proven by tests)

1. `submit(versionId, actor, { reviewerEmployeeId, approverEmployeeId })`:
   - Only from `DRAFT`.
   - The template validates.
   - Neither the reviewer nor the approver is the author.
   - Computes `contentHash`, sets `submittedAt/By`, and moves the version to `IN_REVIEW`.
2. `endorseReview(versionId, actor, { comment })`:
   - Only from `IN_REVIEW`.
   - The actor must be `reviewerEmployeeId` (`CD_NOT_NAMED_REVIEWER`) and must not be the author (`CD_SELF_REVIEW`).
   - A non-empty comment is required.
   - Recomputes the hash, which must equal `contentHash` (`CD_CONTENT_CHANGED`).
   - Writes `review = { reviewerEmployeeId, decision: "ENDORSED", comment, at, contentHash }` and moves the version to `REVIEWED`.
3. `returnToDraft(versionId, actor, { comment })`:
   - From `IN_REVIEW` or `REVIEWED`.
   - The actor must be the named reviewer or the named approver.
   - A comment is required.
   - **Clears `review`** and `contentHash`, then moves the version to `DRAFT`.
4. `approve(versionId, actor, { effectiveDate, reviewDueDate })`:
   - From `IN_REVIEW`, fail with `CD_REVIEW_NOT_RECORDED`. From any other non-`REVIEWED` status, fail with `CD_INVALID_TRANSITION`.
   - The actor must be `approverEmployeeId` and must not be the author or submitter (`CD_SELF_APPROVAL`).
   - `review.decision === "ENDORSED"` and `review.contentHash === contentHash === recomputed hash`.
   - `effectiveDate ≥` the IST approval day **and** `≥` the current effective version's `effectiveDate` (`CD_BACKDATED_EFFECTIVE`).
   - `reviewDueDate > effectiveDate`.
   - On success the status is `APPROVED`. If the reviewer is also the approver, this is still a separate call after `endorseReview`.
5. `reviseFromApproved(documentId, actor)`:
   - Fails with `CD_OPEN_DRAFT_EXISTS` if an open version exists.
   - Copies the content and the **same `assetIds`** from the latest approved version into `versionNumber = latest + 1`, with `basedOnVersionNumber` set.
   - The source version is untouched.
6. Every transition writes exactly one `CdEvent` with the matching action.

### Must not

- Add routes, touch `server.js`, add npm dependencies, or call Drive or puppeteer.
- Touch any file in the roadmap's protection gate, including `models/sopmodel/*`, `models/HR_Models/Policy.js`, `C4Config.js`, `BandConfig.js`, `Employee.js`, `Machine.js`, every barcode, scan and production file, and `docs/tasks/current-task.md`.
- Touch any unrelated modified or untracked file.
- Commit.

### Acceptance checks

1. `npx jest test/controlled-docs` passes. The full `npx jest` run has the same failing set as the baseline.
2. An `APPROVED` version refuses every mutation door. Each door is asserted separately:
   - `doc.save()` after a field change
   - `updateOne`, `updateMany`, `findOneAndUpdate`, `findOneAndReplace`, `replaceOne`
   - `deleteOne` at query level and at document level, `deleteMany`, `findOneAndDelete`
   
   An `IN_REVIEW` or `REVIEWED` version refuses content changes but accepts its legal transitions.
3. Approval without a recorded endorsement fails, and so does approval after the content was altered through any path. A return followed by a resubmit requires a new endorsement.
4. Reviewer-as-approver works only as two calls. An author can never endorse or approve their own version, and a submitter can never approve.
5. `reviseFromApproved` produces a draft whose `assetIds` equal the source's. The source's `contentHash` and `updatedAt` are unchanged.
6. `lifecycleOf` / `resolveEffective` return the correct states for draft, in review, reviewed, scheduled, effective, superseded (with the `supersededByVersionNumber`), withdrawn (retired) and discarded, including `asOf` on exact boundary instants.
7. 50 concurrent `allocateDocNumber` calls return 50 unique numbers, `0001` to `0050`.
8. Two concurrent `approve` calls on the same version end with one success and one `CD_CONCURRENT_TRANSITION`. Two concurrent `reviseFromApproved` calls end with one success and one `CD_OPEN_DRAFT_EXISTS`.
9. Protection gate: `git status --porcelain` minus `cd1-before.txt` lists only the new CD-1 files and the handoff file. `git diff` on every pre-existing modified file is byte-identical to before.

### Tests to write (`test/controlled-docs/`)

- `cd-version-immutability.test.js`: the door matrix × status (`DRAFT`, `IN_REVIEW`, `REVIEWED`, `APPROVED`, `DISCARDED`), plus proof that the lifecycle token is single-use and cannot carry content changes.
- `cd-event-append-only.test.js`: every door refused, including a re-save.
- `cd-asset-append-only.test.js`: metadata doors refused, and delete refused in CD-1.
- `cd-templates.test.js`: each template's required sections, minimum counts, block-kind rules, unknown keys, and stamped template version.
- `cd-content.test.js`: `computeAssetIds`, canonical JSON stability under key reordering, the hash changing with any content or asset sha256 change and not with metadata-only fields, and `CD_FOREIGN_ASSET`.
- `cd-transitions.test.js`: every invariant above, the happy path through all transitions, the event row for each, and the concurrency cases.
- `cd-lifecycle.test.js`: a table of dates × statuses × retirement × `asOf`.
- `cd-numbering.test.js`: concurrency and formatting.

Use `test/setup.js` (`MongoMemoryReplSet`) with no live database, no Firestore and no Drive. Create synthetic ObjectIds for the company, department and employees.

### Finish

Update `docs/handoff/latest-implementation.md` with the following. Prepend a new section and do not delete the history.
- The files created.
- The exact test commands and their counts.
- The baseline comparison.
- The protection-gate evidence.
- Any deviation from this brief, with the reason.

Then stop. Do not start CD-2.
