# Controlled Documents — Existing-versus-Missing Audit

- **Date:** 2026-09-21
- **Scope:** read-only inspection of `grav-cms-backend` and `grav-cms` (both on `MAIN_SUB_BRANCH`, both carrying large amounts of unrelated uncommitted work that this pass did not touch).
- **Purpose:** separate what already exists (SOP points, HR C4 policies, File Manager, Help, employee documents, auth, approvals) from the new **controlled-document builder** (Policy / SOP / Machine Work Instruction), so the new feature neither duplicates nor silently changes the existing ones.
- **Product plan:** `docs/product/controlled-documents.md` · **Decision:** `docs/decisions/controlled-documents-boundary.md` (ADR-008) · **Roadmap:** `docs/tasks/controlled-documents-roadmap.md`

Line numbers are as inspected on 2026-09-21 and will drift.

## 1. Headline

Nothing in either repository stores a *written, approved, versioned business document*. Everything named "SOP" or "Policy" today is a **points/deduction rule** or a **calculation setting**. The builder is therefore net-new; the reusable parts are patterns (immutable versions, append-only history, effective-date resolution, capability contracts, Drive storage, puppeteer PDF) rather than a module to extend.

## 2. Existing features — what they are, and what they are not

| Area | What exists | Files | Is it a controlled document? |
|---|---|---|---|
| **SOP points (C3 custom rules)** | Mongo `Sop` rows: `name`, short `description`, `department`, `percent`/`points`, `severity`, folder, pending/approved/rejected by the creator's manager. Identified by `_id` only; edits overwrite in place. | `models/sopmodel/sop_model.js` (L7–60), `models/sopmodel/sop_folder_model.js`, `routes/soproutes/soproute.js` (`/cowork/sop`, create L325, approve/reject L558/L568, bleach L605), `routes/HrRoutes/hrSopRoutes.js` (`/api/hr/sop`), `routes/CEO_Routes/ceoSopRoutes.js` (`/api/ceo/sop`) | **No.** A deduction rule with a one-line description. |
| **SOP penalties ("bleach")** | Per-employee yearly `sopPoints[].bleaches[]` with `sopId`/`policyId`, `type` C1–C4, copied `sopName`/`points`, `cutBy*`, recheck. No rule/document version stamped. | `models/Employee.js` L404–478 | No. Calculation ledger. |
| **Timer-SOP** | Daily idle-pool (C3) / overtime (C4) rules hard-coded; thresholds in Firestore `cowork_sop_settings/task_events`. | `services/timerSop.service.js` (L136–155, L347–385), `routes/task_routes/timerSop.routes.js`, cron in `server.js` | No. |
| **C1/C2/PMP scoring** | Band values in Mongo `bandconfigs` (`{award|deduction, desc}`), mirrored from Firestore. | `models/BandConfig.js` L15–29, `services/c1Service.js`, `services/pmpService.js`, `routes/task_routes/c2Band.routes.js` | No. |
| **HR C4 policies** | Mongo `Policy`: `name`, `description`, `category` locked to `"C4"` (L45), `points`, `bleachType`, scope, `triggerKey`, `isActive`. `C4Config` singleton. No version, effective date or approver. | `models/HR_Models/Policy.js`, `models/HR_Models/C4Config.js`, `routes/HrRoutes/policyRoutes.js` (`/api/hr/policy`), contract `services/access/hrRouteContract.js` L397–425 | **No.** Attendance-deduction rules. |
| **C4/SOP UI** | "Policies & Attendance Deductions (C4)" page, SOP points dashboard, CEO SOP approvals. No SOP *authoring* page in this repo (authoring lives in the separate Coworking repo). | `grav-cms/app/hr/dashboard/sop/policies/page.js`, `grav-cms/app/hr/dashboard/sop/page.js`, `grav-cms/app/ceo/dashboard/sop/page.js` | No. |
| **Other HR calculation settings** | Attendance, salary, payroll, leave settings, each a mutable singleton with `updatedBy`. | `models/HR_Models/Attendancesettings.js`, `models/Salaryconfig.js`, `models/HR_Models/Payrollsettings.js`, `models/HR_Models/LeaveManagement.js` L7–28 | No. |
| **Board policies** | Versioned, approval-gated **costing methodology** per company. Stored `DRAFT`/`BOARD_APPROVED`; `EFFECTIVE`/`SUPERSEDED` derived from `effectiveFrom`; consumers copy the resolved version. | `models/CMS_Models/Board/BoardPolicy.js`, `services/board/boardPolicy.service.js` (`lifecycleOf` L78, `resolveEffective` L100), `docs/decisions/board-policy-lifecycle.md` | Not a document, but **the lifecycle pattern to reuse**. |
| **File Manager** | Company drive: `Doc_File`/`Doc_Folder`, bytes in one private Google Drive folder via service account. `restricted` flag (L69). `mayRead`/`mayWrite` = any session for unrestricted, owner/admin for restricted; "no ACLs yet". **No revisions**, soft-delete only, 25 MB multer limit, browser MIME trusted on upload. | `models/Files/Doc_File.js`, `models/Files/Doc_Folder.js`, `routes/Access/files.js` (`mayRead` L116), `services/companyDrive.service.js` (upload L99, stream L130); UI `grav-cms/app/files/**` | No. Storage we can reuse; permission model we must **not** rely on (any employee may trash an unrestricted file). |
| **Help app** | Frontend-only Markdown under `grav-cms/content/help/`, front matter with owner/status, git-versioned, metadata-only search, typed-block parser (never HTML). Explains how to use GRAV screens. | `grav-cms/lib/help/content.js`, `grav-cms/components/help/*`, `grav-cms/app/help/**`, `docs/product/help-app-plan.md` | No. The plan forbids Help from inventing business policy (help-app-plan L203–204). Its **typed-block parser and safe rendering** are the model to copy. |
| **Employee documents (HR letters)** | `EmployeeDocument` — appointment/offer/warning/etc., `generated`/`released`, request queue, embedded history; file replaced in place. pdf-lib letter renderer on the frontend. | `models/HR_Models/EmployeeDocument.js`, `routes/HrRoutes/EmployeeDocuments_section.js`, `routes/Employee_Routes/documents.js`, `grav-cms/app/hr/dashboard/documents/{documentKit.js,letterPdf.js}` | No. Per-employee issued letters. |
| **Cowork docs** | Yjs collaborative documents with restorable Firestore snapshots. | `services/documentCollab.service.js`, `routes/task_routes/coworkDocs.routes.js` | No — mutable and restorable by design. |

## 3. Cross-cutting patterns available for reuse

| Need | Existing pattern | Files |
|---|---|---|
| Immutable approved version | Content frozen after creation; transition allowlist; save/update/replace/delete hooks; lifecycle token | `models/CMS_Models/Costing/CostingVersion.js` (L1269–1436), `models/CMS_Models/IndustrialEngineering/IeBulletinVersion.js` (L3–23, L463–486), `IeRelease.js` |
| Append-only event ledger | Every mutating hook blocked, non-new `save` refused | `models/CMS_Models/StorePurchase/SpActionHistory.js` L96–117, `CostingTransition.js` |
| Effective-dated resolution without cron | Store real acts only; derive EFFECTIVE/SUPERSEDED | `services/board/boardPolicy.service.js` |
| Maker/checker approval | Approver ≠ author/submitter | ADR-005 rule 5; board-policy-lifecycle §3.1; IE plan L316 |
| Capability catalogue + route contract | Dotted capability strings, frozen catalogue, `requireCapability`, undeclared routes refused | `services/access/hrCapabilities.js`, `services/access/hrRouteContract.js`, `Middlewear/hrContract.js`, `services/storePurchase/capabilities.js`, `Middlewear/storePurchaseTenant.js` |
| Company scope, fail-closed | `resolveCompanyForActor` | `services/companyContext/companyMembership.service.js` L98 |
| Department roles | viewer < editor < approver < owner; **fails open when a department has no rows** | `models/Access/DepartmentRole.js`, `services/departmentRoles.js` L360–371 |
| Drive byte storage | Service-account upload/stream, short-lived HMAC preview token | `services/companyDrive.service.js`, `utils/letterDownloadToken.js` |
| Server PDF | Warm puppeteer `htmlToPdf` | `services/pdfRender.service.js` L110 |
| Audit | `recordChange` + mount-level fallback | `services/changeLog.js` L297, `Middlewear/auditTrail.js` |
| Tests | Jest + `MongoMemoryReplSet` (transactions work), router on bare express + `fetch`, Drive via `jest.mock` | `jest.config.js`, `test/setup.js`, `test/accountant/files.route.test.js` |
| Shared CMS top bar | `AppShell` → `FrostShell` → `TopBar`/`AppSwitcherNav`; nav in React-free module for node tests | `grav-cms/components/shell/*`, `grav-cms/components/Ppc_DashboardLayout.js`, `grav-cms/components/ppc/ppcNavigation.js` |
| Capability-gated app tile | Costing tile via `GET /api/costings/access` | `grav-cms/components/shell/useMyApps.js` L77–94 |
| Frontend tests | `node --test` over `*.test.mjs` (309 files; source-text assertions) | `grav-cms/package.json` `test` script (note: `grav-cms/CLAUDE.md` wrongly says there is no test framework) |

## 4. Missing — what the builder must add

1. A document identity (document ID/number, type, owning department, owner, audience) separate from its versions.
2. Structured, template-driven content (required sections, numbered steps, images/attachments) — there is **no rich-text editor** installed and no `contentEditable` anywhere; only the Help Markdown subset.
3. Draft → Review → Approved → Effective → Retired with immutable approved versions and revision-by-new-draft.
4. Reader view of the current effective version; authorised history, compare, and audit trail.
5. Document-controlled attachments whose permissions follow the document, not the shared drive.
6. PDF export of a controlled version with controlled header/footer.
7. Search over document content (no `$text`/Atlas search exists; only escaped-regex precedent in `routes/Accountant_Routes/Acc_search.js`).
8. Import of existing documents (from upload or from the File Manager).
9. Links from SOP/C4 rules to an exact approved version, and from a machine (by `Machine._id`) to its current instruction, readable on a paired floor device.
10. Review-due tracking.

## 5. Protected areas (must not change)

Barcode generation, scanning and production events — per `docs/product/production-floor-ppc-integration-plan.md` §4.4 and §6:

- Backend: `/api/barcode-devices`, `/api/cms/production/tracking/*`, `ProductionTracking`, `ProductionCompletionScanRecord`, production Socket.IO rooms, `activeOps` snapshots.
- Frontend: `lib/barcodeSticker.js`, `components/inventory/GenerateBarcodeModal.js`, `app/store/dashboard/operations/barcode-generator/`, `app/barcode-scanner-device/`, `app/grav-production/barcode-scanner-device/`, `app/embroidery/dashboard/{scan,queue}/`, `app/production-supervisor/dashboard/production-record/`, `app/production-supervisor/dashboard/tracker/hooks/useProductionSocket.js`, `app/contexts/WebSocketContext.js`, `app/project-manager/dashboard/production/work-orders/[id]/components/BarcodeGenerator.js`, `app/qrgenerator/`, `app/id-print/`, `lib/qcOffline*.js`, `lib/qcSession.js`.

Also unchanged: SOP/C4 calculation code and models (`Sop`, `Policy`, `C4Config`, `BandConfig`, `Employee.sopPoints`, `timerSop.service.js`, Firestore `cowork_sop_*`), the Help content pipeline, HR letters, and File Manager permissions.

## 6. Finding: the C1/C2/Timer-SOP settings have no access control

- The C1, C2 and Timer-SOP scoring values live in Firestore `cowork_sop_settings/task_events`. No backend route writes to that document.
- The CoWork frontend (`Desktop/Cowork`) writes it directly from the browser, under the signed-in user's own Firebase credentials:
  - `app/admin/scoring-rules/page.tsx`
  - `components/features/admin/sections/PriorityScoringSection.tsx`
  - `lib/legacy/settings.ts` L203
- CoWork's `app/api/admin/settings/route.ts` checks for `system_admin`, but its header comment (L21–34) records two things:
  - The check is not in the write path.
  - No Firestore security rule protects `cowork_sop_settings/task_events` or `cowork_settings/office`.
- As a result, any authenticated employee can change these values. The values also have no version history.

**What this means for the builder:**
- A `SYSTEM_RULE` link can say which document explains a rule. It cannot prove which rule *values* were in force.
- Plan decision D14 therefore keeps `SYSTEM_RULE` links informational only.
- Securing these settings belongs in the CoWork and Firestore-rules repository, not in this builder.
- `grav-cms-store-merch` also holds copies of the SOP services. I have not checked whether they match the originals.

## 7. Naming collisions to avoid

- `/api/hr/policy`, `/api/hr/sop`, `/api/ceo/sop`, `/cowork/sop`, `/api/hr/documents` are taken.
- Model names `Policy`, `Sop`, `SopFolder`, `EmployeeDocument`, `Doc_File` are taken. New models use the `Cd` prefix (`CdDocument`, `CdVersion`, …).
- In UI copy, existing features are **"SOP points rules"** and **"C4 attendance policies"**; the new items are **"SOP documents"**, **"Policy documents"**, **"Machine work instructions"**.
