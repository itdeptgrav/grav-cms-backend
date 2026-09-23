# ADR-008: Controlled documents are a separate versioned record; rules link to them, never embed them

- **Decision ID:** ADR-008
- **Date:** 2026-09-21
- **Status:** Approved on 2026-09-21. The user chose the structured builder and accepted the recommended answers to D1–D14, amending D3 so that paired floor devices can read machine instructions in v1. Four plan gaps were closed the same day.
- **Context:** GRAV wants a structured builder for three kinds of document: Policy, SOP and Machine Work Instruction. The audit (`docs/audits/controlled-documents-existing-vs-missing.md`) found that nothing named "SOP" or "Policy" today is a written document:
  - `Sop` (C3) and HR `Policy` (C4) rows are points rules. They are identified only by `_id` and edited in place.
  - The C1/C2/Timer-SOP values in Firestore are mutable, unversioned and writable by any logged-in CoWork user.
  - The File Manager has no revisions and no per-department ACLs.
  - Help is git-versioned Markdown that explains how to use GRAV screens.
  - HR letters are files issued to one employee.
  - `Machine._id` is the stable identity that production scans already use. But `Machine.type` is free text, and machines carry no `companyId`.

  Existing patterns to build on:
  - Board policies are effective-dated without a cron.
  - `CostingVersion`, `IeBulletinVersion` and `SpActionHistory` enforce immutability and append-only history at the schema level.
  - `/costing-approval` shows how to add a bare route that has no session.
- **Decision:**
  1. **A new domain.** Controlled documents get their own records:
     - `CdDocument` for identity and `CdVersion` for content.
     - `CdAsset`, `CdLink`, `CdEvent`, `CdSequence`, `CdGrant`, `CdFloorDevice` and `CdPdfCache` alongside them.

     The domain has its own API at `/api/controlled-docs` and its own app at `/controlled-docs` inside the shared CMS top bar.
  2. **Lifecycle.** The stored statuses are `DRAFT`, `IN_REVIEW`, `REVIEWED`, `APPROVED` and `DISCARDED`. **Effective** and **Retired** are derived from the dates and from document retirement.
  3. **Recorded review.**
     - The named reviewer must record an endorsement (`IN_REVIEW → REVIEWED`) against the exact `contentHash`.
     - Approval is allowed only from `REVIEWED`, in one guarded lifecycle save that re-checks both hashes under optimistic concurrency.
     - Approver ≠ author and approver ≠ submitter.
     - If the reviewer and approver are the same person, review and approval are still two separate recorded acts.
     - A return clears the review.
  4. **Immutability.**
     - Content is frozen from the moment of submit.
     - Everything is frozen once approved.
     - Changes are always a new draft, revised from the latest approved version.
  5. **Assets.**
     - Assets are document-scoped and immutable.
     - Read access is decided by **reference**: a caller may read an asset if they can see any version of that document whose server-computed `assetIds` includes it.
     - Bytes referenced by any submitted or approved version are never deleted.
     - Assets are stored in a dedicated Drive folder and never as `Doc_File` rows.
  6. **PDF cache.**
     - The cache key is a hash of the complete render input: document and version identity, title, version number, derived status label, dates, watermark, template, content and asset hashes, and the renderer version.
     - A cache hit is re-verified against the stored identity.
     - Only approved versions that are not scheduled are cached.
     - The printer and print time are recorded as events, not printed on the page.
  7. **Rule links.**
     - Rules are **not modified**.
     - A rule relates to a document only through a `PINNED_VERSION` + `EXPLAINS` link to an exact approved version.
     - A link explains a rule. It never claims or proves historical point values, and it never moves automatically.
  8. **Machine links.**
     - Machines relate to their instruction through `FOLLOW_EFFECTIVE` + `INSTRUCTS` links keyed on `Machine._id`, with at most one active link per machine.
     - Machine-type links are deferred until the company-scoped machine identity contract in IE plan §3.1 exists.
     - A deleted machine becomes an orphan link. It is never re-pointed.
  9. **Floor devices.** Workers read on paired shared floor devices:
     - Pairing uses a one-time, hashed, 10-minute code issued by `cdoc.floor.manage`.
     - It returns a random device token, stored hashed and revocable, which is checked on every request.
     - Only the floor router accepts the token. It can read only the current effective MWI, and its referenced assets, for the machines assigned to that device.
     - The viewer is at `/floor-docs`, a bare route like `/costing-approval`, outside the top bar and outside the session-cookie gate.
     - Documents are never public.
  10. **Boundaries.**
     - Barcode generation, scanning, production events and points calculations are out of bounds.
     - Securing the CoWork scoring settings is a separate task.
     - Help, HR letters and the File Manager keep their current roles.
- **Alternatives considered:**
  - *Add text and version fields to `Sop`/`Policy`.* Rejected. It would mix calculations with governed text and change models the Coworking repo writes.
  - *Store documents as File Manager files.* Rejected. The File Manager has no revisions and no approval step, and any employee can trash an unrestricted file.
  - *Extend Help.* Rejected. Help is operating guidance and has no approval authority.
  - *Rich text, HTML or Yjs editing.* Rejected for v1. None of these can enforce the required sections or numbered steps, and they widen the sanitisation surface.
  - *Stored EFFECTIVE flags flipped by a cron.* Rejected. This would rewrite approved rows.
  - *Treat submission as the review.* Rejected. The user requires a recorded review, and a submission is not evidence that anyone reviewed the content.
  - *Authorise assets by the version that uploaded them.* Rejected. A retired v1 would hide images still used by the effective v3.
  - *Key the PDF cache by `contentHash`.* Rejected. Two documents with identical content, or one version before and after supersession, would share a PDF that shows the wrong title, number or status.
  - *Link by machine name, serial number or `type` text.* Rejected. These are mutable or free text. `Machine._id` is the identity production already uses.
  - *Make MWIs public, or reachable by an unauthenticated QR URL.* Rejected by the user.
  - *Reuse the barcode-device registration for floor devices.* Rejected. It sits in the protected barcode area.
  - *Give each operator a personal CMS login.* Not required for v1. It may be added later.
  - *Reuse `DepartmentRole`.* Rejected. It fails open for departments that have no role rows.
- **Consequences:**
  - The capability catalogue and route contract must exist before any write route.
  - Floor devices form a second credential type with their own router, revocation and rate limits. This needs a security test in its chunk.
  - One instruction applied to many machines means one link row per machine.
  - Machine-type links, and the automatic coverage of new machines, wait for the upstream machine identity contract.
  - Rule links provide explanation, not evidence.
  - Four shared shell files get additive entries. `AppShell` `BARE_PATHS` gains `/floor-docs`.
  - A PDF cache hit costs one extra comparison.
- **Related task/files:**
  - Docs: `docs/product/controlled-documents.md`, `docs/tasks/controlled-documents-roadmap.md`, `docs/audits/controlled-documents-existing-vs-missing.md`, `docs/decisions/board-policy-lifecycle.md`, `docs/product/industrial-engineering-app-plan.md` §3.1.
  - Models: `models/CMS_Models/Costing/CostingVersion.js`, `models/CMS_Models/StorePurchase/SpActionHistory.js`, `models/CMS_Models/Inventory/Configurations/Machine.js`.
  - Services: `services/companyDrive.service.js`, `services/pdfRender.service.js`.
