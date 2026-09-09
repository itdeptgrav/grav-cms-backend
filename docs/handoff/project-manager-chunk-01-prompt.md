# Claude Code prompt — Project Manager professionalisation, Chunk 1

Use `/Users/risheeray/grav-cms` as the frontend repository and
`/Users/risheeray/grav-cms-backend` as the backend repository.

## Goal

Implement **Chunk 1 only** of the Project Manager professionalisation plan:
replace the fictional `/project-manager/dashboard` landing page with a
trustworthy live production overview, and add contract coverage around the
existing APIs it uses.

This is an incremental safety-and-trust change. It is not permission overhaul,
status migration, schedule rewrite, design-system rewrite or broad cleanup.

## Required reading before editing

Read these files completely before changing code:

- `/Users/risheeray/grav-cms-backend/AGENTS.md`
- `/Users/risheeray/grav-cms-backend/docs/product/project-manager-professionalization.md`
- `/Users/risheeray/grav-cms-backend/docs/tasks/current-task.md`
- `/Users/risheeray/grav-cms-backend/server.js` around the manufacturing and PM mounts
- `/Users/risheeray/grav-cms-backend/routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js`
- `/Users/risheeray/grav-cms-backend/routes/CMS_Routes/pm/pmRequestsRoutes.js`
- `/Users/risheeray/grav-cms-backend/models/Customer_Models/CustomerRequest.js`
- `/Users/risheeray/grav-cms-backend/models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`
- `/Users/risheeray/grav-cms/components/DashboardLayout.js`
- `/Users/risheeray/grav-cms/components/shell/FrostShell.js`
- `/Users/risheeray/grav-cms/components/ceo/ui/Primitives.tsx`
- `/Users/risheeray/grav-cms/app/grav-ui.css`
- `/Users/risheeray/grav-cms/app/project-manager/dashboard/page.js`
- `/Users/risheeray/grav-cms/app/project-manager/dashboard/production/manufacturing-orders/page.js`
- `/Users/risheeray/grav-cms/lib/session.js`

## Pre-flight

1. Run `git status --short` in both repositories.
2. Preserve every existing uncommitted file and change. The repositories are
   already dirty with unrelated Store/Purchase and access-control work.
3. Inspect the current implementation and tests before deciding filenames.
4. Do not update `docs/tasks/current-task.md`; Store & Purchase remains the
   recorded active scope until the user explicitly switches it.

## Scope

### A. Characterize and cover the existing stats endpoint

The manufacturing-order router declares:

```text
GET /api/cms/manufacturing/manufacturing-orders/stats/overview
```

after a dynamic `GET /:id` route. Do not assume this is shadowed: the stats path
has two segments and normal Express route matching should still reach it. Write
the route-level characterization test first. If the endpoint already reaches
the correct handler, preserve the ordering and avoid a no-value production-code
edit. If the actual Express version/test harness proves it is captured or
otherwise unreachable, make the smallest routing-order correction.

Requirements:

- Preserve the URL exactly.
- Preserve the existing `{ success, stats }` response envelope and every field
  inside `stats`: `totalMO`, `totalWO`, `ongoingWO`, `completedWO`, `pendingWO`,
  `forwardedWO`, `newMOThisMonth`, `completedWOThisMonth`.
- Keep the route behind `EmployeeAuthMiddleware`.
- Add route-level tests proving:
  - an unauthenticated request is refused;
  - an authenticated request reaches the stats handler;
  - the response shape remains compatible;
  - empty collections return zeroes, not an error or invented data.
- Do not change the meaning of the existing counts in this chunk. If a count is
  semantically questionable, document it as a follow-up instead of silently
  redefining it.
- Do not add a second competing overview endpoint.

### B. Replace the hard-coded Project Manager dashboard

Rewrite only the page body in:

```text
/Users/risheeray/grav-cms/app/project-manager/dashboard/page.js
```

Use live reads from the existing APIs:

- `/api/cms/manufacturing/manufacturing-orders/stats/overview`
- `/api/cms/manufacturing/manufacturing-orders?page=1&limit=5`

Use `credentials: "include"` and the repository's established session/auth
helpers where appropriate. Do not introduce a new auth store.

The page should provide:

1. A compact live stat strip using useful existing counts. Prefer:
   - manufacturing orders;
   - work orders awaiting/under planning (`pendingWO`, labelled honestly);
   - work orders in progress;
   - work orders completed this month.
2. A “Needs attention / recent manufacturing orders” operational list using
   the five returned manufacturing orders. Show only fields already returned by
   the API, such as MO number, customer, priority, display status, progress and
   delivery deadline.
3. Clear links to:
   - `/project-manager/dashboard/production/manufacturing-orders`
   - `/project-manager/dashboard/production/schedule`
   - `/project-manager/dashboard/requests`
   - `/project-manager/dashboard/journeys`
4. Real loading skeletons.
5. A retryable error state that does not erase successfully loaded sections if
   only one request fails.
6. An honest empty state for no manufacturing orders.
7. A manual refresh action.
8. Responsive behavior from 375 px through desktop.

Use the existing GRAV language and components from
`components/ceo/ui/Primitives.tsx`: `PageHead`, `Panel`, `PanelHead`, `Chip`,
`Button`, `EmptyState`, `InlineError`, `SkeletonRows`, `Meter` or the smallest
appropriate subset. Reuse the status vocabulary already used on the
manufacturing-order register. Do not create a parallel card, badge, button or
color system.

Remove all hard-coded dashboard counts, fake recent activity, fake alerts,
sample product names and 2024 work-order examples from the rendered landing
page. Do not substitute different sample data.

### C. Small shared extraction only if justified

If the dashboard and manufacturing-order register need identical status labels,
tones, date-risk logic or formatting, extract the smallest pure shared module
and add focused tests for it. Do not restructure the 456-line register page or
move unrelated components during this chunk.

## Explicitly out of scope

Do not change:

- MongoDB schemas or stored status values;
- CustomerRequest-to-WorkOrder generation;
- PM approve/reject semantics;
- MRF approval behavior;
- work-order planning or raw-material allocation;
- production scheduling behavior;
- barcode formats, scan ingestion or progress aggregation;
- Socket.IO behavior;
- Sales Journey, Store, R&D, Cutting, Production Supervisor, QC, Packaging,
  Dispatch, Vendor or CEO application code;
- Products & BOM or configuration wrappers;
- visible Project Manager navigation;
- hidden/legacy PM routes;
- global design tokens or FrostShell;
- the active Store/Purchase implementation and docs.

Do not “fix” the broader production-dashboard authentication finding in this
chunk; it belongs to Chunk 2 and needs a cross-consumer access matrix first.

## Compatibility rules

- No existing route, link, response field or query parameter may be removed or
  renamed.
- Do not create a ProjectManager-only copy of CustomerRequest, WorkOrder or any
  shared component.
- No write request is needed to render the dashboard.
- A failed stats request and a failed recent-orders request must be distinguishable.
- Never present a missing response as zero unless the server explicitly returned
  a successful zero.
- Do not report `npm run build` as passing if it fails for any reason; separate
  pre-existing failures from introduced failures with evidence.

## Verification

At minimum:

1. Run the focused backend route tests added for the stats endpoint.
2. Run syntax/static checks for every changed backend file.
3. Run the frontend test command and production build.
4. If the full build fails in unrelated existing code, prove that the changed
   files parse and report the exact pre-existing failure without modifying it.
5. Browser-check the dashboard at approximately 375 px, tablet and desktop
   widths, covering loading, live-data, empty and error states where practical.
6. Verify every dashboard link stays in the Project Manager shell.
7. Run `git diff --check` in both repositories.
8. Review the final diff for accidental edits outside this chunk.

## Completion report

When finished, report:

- files changed;
- live sources used for every displayed figure;
- route-contract tests and their results;
- frontend tests/build and browser checks;
- links and cross-application behavior preserved;
- pre-existing failures or risks not changed;
- exact recommendation for Chunk 2, without starting it.
