# Claude Code prompt — Project Manager Lane B, Chunk B1

Use `/Users/risheeray/grav-cms` as the frontend repository and
`/Users/risheeray/grav-cms-backend` only for the Lane B planning/handoff docs.

## Goal

Implement **Project Manager Lane B — Chunk B1: Requests desk truth and
responsive worklist**.

This is frontend-only visible work. Lane A is concurrently changing backend
manufacturing, production-dashboard, access and audit code. Do not touch Lane A
files or backend application code.

## Required reading

- `/Users/risheeray/grav-cms-backend/AGENTS.md`
- `/Users/risheeray/grav-cms-backend/docs/product/project-manager-professionalization.md`
- `/Users/risheeray/grav-cms-backend/docs/tasks/project-manager-lane-b.md`
- `/Users/risheeray/grav-cms/app/project-manager/dashboard/requests/page.js`
- `/Users/risheeray/grav-cms/app/project-manager/dashboard/requests/[type]/[id]/page.js`
- `/Users/risheeray/grav-cms/components/pm/RequestActionSlider.js`
- `/Users/risheeray/grav-cms/components/access/RoleGate.js`
- `/Users/risheeray/grav-cms/components/ceo/ui/Primitives.tsx`
- `/Users/risheeray/grav-cms/components/DashboardLayout.js`
- `/Users/risheeray/grav-cms/app/grav-ui.css`

Read the backend PM request router for behavior only; do not edit it:

- `/Users/risheeray/grav-cms-backend/routes/CMS_Routes/pm/pmRequestsRoutes.js`

## Pre-flight and concurrency boundary

1. Run `git status --short` in both repositories.
2. Preserve every uncommitted change and untracked directory.
3. Lane A currently owns backend PM/manufacturing/access files and these
   frontend Chunk 1 files:
   - `app/project-manager/dashboard/page.js`
   - `app/project-manager/dashboard/production/manufacturing-orders/page.js`
   - `components/manufacturing/moStatus.js`
   - `components/manufacturing/moStatus.test.mjs`
4. Do not edit any file above.
5. Do not edit `docs/handoff/latest-implementation.md`; Lane A uses it. Record
   Lane B completion in a separate Lane B handoff section/file.
6. If one of the three intended B1 frontend files has new changes not present
   when this prompt began, stop and report the overlap rather than overwriting it.

## Existing business rule to present

The backend already says:

- MO request: Project Manager may approve or reject it.
- MRF: Project Manager has view-only oversight.
- MRF approval belongs to the requester's Primary Manager/TL in CoWork.
- The MRF approve/reject endpoints deliberately return 403.

Do not change or reinterpret this rule.

## Current visible contradictions

The Requests list currently:

- runs every record through `pmStateOf`, so an MRF without PM flags becomes
  “Pending PM”;
- includes MRFs in PM pending/approved/rejected totals;
- applies the PM-status filter to MRFs;
- renders approve/reject actions for MRF rows;
- can open `RequestActionSlider` for an MRF even though the server must refuse;
- describes all MOs and MRFs as awaiting PM decision.

The detail page mostly hides MRF actions correctly, but still contains copy such
as “If you approve this MRF,” which contradicts its own view-only banner.

`RequestActionSlider` still contains MRF approval/rejection consequences that
are no longer true.

## Implementation requirements

### 1. Separate Decisions from Oversight

On `/project-manager/dashboard/requests`, give the user two explicit views:

- **Decisions** — manufacturing-order requests governed by PM status.
- **MRF oversight** — material requests governed by TL status and shown
  read-only.

Use the existing response from `GET /api/cms/pm/requests`. Do not add a request,
endpoint, field or query parameter.

The default view should be Decisions with pending PM decisions visible. A clear
MRF oversight tab/count must remain available; do not hide MRFs behind the PM
pending filter.

### 2. Use type-correct state vocabulary

For MO requests:

- Pending PM
- PM Approved
- PM Rejected

For MRFs:

- Awaiting TL
- TL Approved
- TL Rejected

Use `tlApproved`, `tlRejected`, and related fields already returned by the API.
Do not derive an MRF state from PM fields.

KPI totals and filter labels must state their scope. An MRF must never
contribute to Pending PM, PM Approved or PM Rejected.

### 3. Remove impossible MRF actions

- Do not render an approve/reject menu on an MRF row.
- Keep the read/view action.
- Preserve `RoleGate min="approver"` for MO approve/reject actions.
- Add a quiet “View only” or “TL decision” explanation where it helps.
- Make the action function defensively refuse to issue an MRF mutation even if
  a future UI regression tries to open it.

Do not treat frontend hiding as security; the backend remains authoritative.

### 4. Correct detail-page copy

On the MRF detail page:

- preserve the existing view-only banner and TL status;
- remove every sentence implying PM can approve or reject the MRF;
- explain shortages as information for coordination, not a PM approval action;
- keep all current stock, requester, item and context information;
- do not link to a new Store or CoWork action unless an existing correct URL is
  already present and verified.

MO detail actions and wording must remain unchanged unless needed for consistent
labels.

### 5. Make the list genuinely usable on mobile

Keep the compact table at desktop widths. At narrow widths, render a proper
stacked request-row/card presentation instead of requiring horizontal scrolling
to discover identity, state or the primary action.

Each mobile row must show:

- request type and number;
- requester/customer;
- correct PM or TL state;
- useful quantity/item summary;
- date;
- View action;
- MO approve/reject actions only for approver+ users.

Reuse GRAV primitives and tokens. Do not create a new design system or use raw
Tailwind palette colors.

### 6. Simplify the action slider to its real responsibility

`components/pm/RequestActionSlider.js` should describe MO approval/rejection
only. Remove obsolete MRF consequence text and UI branches.

Add a defensive behavior for an MRF input: render nothing or refuse to confirm
without calling the supplied mutation callback. Pick the behavior that is most
consistent with existing component patterns and test it.

### 7. Add pure presentation coverage

Extract the smallest dependency-free helper only if useful, for example:

- request kind classification;
- MO decision state;
- MRF TL state;
- whether PM actions are allowed;
- KPI grouping/filter behavior.

Add `node:test` coverage proving at minimum:

- MRFs never enter PM decision counts;
- MO and MRF labels come from different fields;
- an MRF is never PM-actionable;
- a pending MO remains actionable for approver UI;
- default Decisions filtering does not mix in MRFs;
- MRF oversight includes awaiting, approved and rejected TL states;
- missing fields produce an honest unknown/read-only presentation, not a fake
  PM-pending state.

Do not add a new test framework.

## Allowed files

Intended application files:

- `/Users/risheeray/grav-cms/app/project-manager/dashboard/requests/page.js`
- `/Users/risheeray/grav-cms/app/project-manager/dashboard/requests/[type]/[id]/page.js`
- `/Users/risheeray/grav-cms/components/pm/RequestActionSlider.js`
- one small new helper under `/Users/risheeray/grav-cms/components/pm/`
- its adjacent `*.test.mjs`

Lane B may add a separate completion record such as:

- `/Users/risheeray/grav-cms-backend/docs/handoff/project-manager-lane-b-latest.md`

Do not expand beyond these files without first reporting why.

## Explicitly out of scope

Do not change:

- any backend application or test file;
- API calls, URLs, response fields or authentication behavior;
- PM approval semantics for manufacturing orders;
- TL approval semantics for MRFs;
- CustomerRequest, WorkOrder or MRF models;
- Lane A dashboard, register, status helper or access work;
- shared shell or global design tokens;
- Pipeline, scheduling, planning, barcode or production tracking;
- Store/Purchase files;
- `docs/tasks/current-task.md`;
- navigation labels or routes outside the Requests screen.

## Verification

1. Run the focused new helper tests.
2. Run the full frontend `npm test` command.
3. Run parse/static checks for each changed frontend file.
4. Run the frontend build and report the known unrelated Accountant duplicate
   `splitGstByRate` failure honestly if it remains.
5. Browser-check at approximately 375 px, tablet and desktop.
6. Verify these states with fixtures/stubs, without live backend writes:
   - pending/approved/rejected MO;
   - awaiting/approved/rejected MRF;
   - mixed list;
   - empty Decisions;
   - empty MRF oversight;
   - loading and API failure;
   - viewer and approver affordances.
7. Confirm no MRF interaction sends PATCH.
8. Confirm MO approve/reject still calls the unchanged endpoint.
9. Run `git diff --check` in both repositories.
10. Review the final diff against the allowed-file list.

## Completion report

Report:

- files changed;
- visible behavior before and after;
- how Decisions and MRF oversight are counted and filtered;
- proof that MRF actions cannot be sent;
- responsive/browser checks;
- frontend test/build results;
- concurrent Lane A and Store files preserved;
- any dependency Lane A must handle;
- exact recommendation for Lane B Chunk B2 without starting it.

