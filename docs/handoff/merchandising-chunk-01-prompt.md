# Claude Code Prompt — Merchandising C1

Implement **Merchandising C1: truthful shell and Style Work queue foundation**
across these two repositories:

- Backend: `/Users/risheeray/grav-cms-backend`
- Frontend: `/Users/risheeray/grav-cms`

Read these sources completely before changing anything:

1. `/Users/risheeray/grav-cms-backend/AGENTS.md`
2. `/Users/risheeray/grav-cms-backend/docs/product/garment-manufacturer-app-architecture.md`
3. `/Users/risheeray/grav-cms-backend/docs/product/merchandising-app-professionalisation.md`
4. `/Users/risheeray/grav-cms-backend/docs/tasks/current-task.md` only to understand
   existing completed Packaging/Development contracts; do not expand this chunk
   into Central Costing work.

Both worktrees already contain substantial uncommitted work belonging to the
user. Preserve it. Do not reset, revert, delete, mass-format or rewrite unrelated
files. Inspect the current diff before editing and keep your changes narrowly
attributable to this chunk.

## Outcome

When C1 is finished, `/merchandiser` must visibly be a Merchandising application,
not a second address for Sales and Store screens.

The first release has exactly three primary destinations:

```text
Overview | My Work | Styles
```

The Overview and My Work pages must be driven by a new, company-scoped,
Merchandising-owned read API over existing style facts. Do not create fake
assignments, dates, SLAs, buyer context, T&A milestones or readiness facts that
the current records do not hold. Those belong to later chunks.

## Non-negotiable ownership boundary

Merchandising works from a Style and has no Sales Journey workspace.

No C1 response or rendered page may publish or derive:

- Journey or enquiry identity;
- customer/account/contact data;
- quotation, selling price, supplier, rate, cost, margin, tax or policy value;
- R&D consumption, evidence or technical measurements;
- warehouse, stock quantity, machine or production-plan data.

Company ownership may be proved through Sales parents internally, as the current
`ownershipProofFor` contract does, but the proof and parent identifiers must not
leave the service boundary.

Merchandising may see only its own facts plus a safe handoff result it must act
on, such as “R&D returned this material selection” and the stated correction
reason.

Do not add links to Sales, R&D, Store, Costing or Production screens. A cross-app
blocker names the responsible app but does not navigate a merchandiser into that
app.

## Current code to preserve

Preserve and continue using the existing:

- `/merchandiser/styles` and `/merchandiser/styles/[id]` pages;
- company-safe Merchandising style allowlist;
- Packaging selection lifecycle and safe `merchandisingHandoff` projection;
- Development/Tooling requirement boundary;
- viewer/editor/approver/owner UI vocabulary;
- `FrostShell`, `AutoDashboardLayout` and shared visual primitives;
- legacy/deep-link pages until a later approved retirement chunk.

Do not alter the Packaging ownership contract, Development ownership contract,
R&D technical editor, Sales Journey, Central Costing, supplier registers or
Product/Stock Item BOM behaviour.

## Current defects C1 must close

1. `app/merchandiser/dashboard/page.js` still reads Sales overview, Sales
   customer-request and Sales customer endpoints and presents Purchase Orders,
   Customers and commercial statuses as Merchandising work.
2. `components/Merchandiser_DashboardLayout.js` still exposes Products & BOM,
   warehouse, units, operations, machines, size configuration and Sales settings.
3. There is no factual Merchandising work queue.
4. Merchandising-specific style reads live inside the shared Sales
   `sampleStyles.js` router and use its broad role allowlist. C1 must establish a
   narrow Merchandising-owned read door for the new dashboard/work queue. Do not
   migrate the existing style write endpoints in this chunk.
5. The seeded Merchandising department description still says Purchase Orders,
   customers and Products & BOM.

## Backend scope

Create a narrow Merchandising API mounted once at:

```text
/api/cms/merchandising
```

Use a dedicated router under `routes/CMS_Routes/Merchandising/` and business
logic under `services/merchandising/`. Keep aggregation and response-shape logic
out of `server.js` and out of the route handler.

### Authentication and company scope

Follow the strict pattern used by
`routes/CMS_Routes/Manufacturing/productionStyleRoute.js`:

- authenticate with the shared employee/department session middleware;
- resolve company from the authenticated actor, never from a body field or a
  style record;
- require a live `merchandiser` department role on every request;
- viewer and above may read;
- platform administrators may read while acting in the app;
- fail closed when company or role cannot be proved;
- do not widen the Sales CRM role allowlist.

Return the existing structured Store/Purchase-style errors where practical.

### Endpoints

Implement:

```text
GET /api/cms/merchandising/overview
GET /api/cms/merchandising/work
```

`overview` returns factual, style-level counts and a generated-at timestamp.
Count styles, not raw subdocument rows, so one style with three proposed package
components is one affected style.

Required counts:

- active styles;
- materials not yet selected/answered;
- packaging requiring Merchandising approval;
- development/tooling unanswered or incomplete;
- selections returned to Merchandising for correction;
- styles with any current Merchandising action.

Use the current model's real semantics. Inspect the existing constants, services
and UI helpers before defining a condition. Reuse the Packaging and Development
gap/status functions rather than reimplementing their rules. If a requested
count cannot be derived truthfully from existing records, document that fact and
omit it instead of guessing.

`work` returns one row per style with one or more current Merchandising actions.
It supports:

- `q` — server-side search by product name, style code or style reference;
- `kind` — an allowlisted work-kind filter;
- `limit` — bounded with a conservative default and maximum;
- an opaque cursor for stable server-side pagination using a deterministic sort
  such as `updatedAt` plus `_id`.

Use stable work-kind codes. At minimum represent, where the stored facts support
them:

- materials unanswered;
- packaging approval required;
- development/tooling unanswered or incomplete;
- material selection returned for correction;
- BOM approval rejected and requiring Merchandising correction.

Do not label a style “overdue,” “assigned,” “at risk” or “ready” in C1 unless a
real authoritative field and rule supports that exact statement.

### Response allowlist

Build every response field by field. A work row may contain only:

- style ID;
- internal style reference/code;
- product name;
- variant label;
- last-updated time;
- an array of current Merchandising actions containing stable kind, concise
  label/state and, only where already recorded for Merchandising, a correction
  reason;
- pagination metadata.

Never spread a Mongoose style, ownership proof, parent or technical row into a
response.

### Query and scale requirements

- no unbounded collection scan;
- no N+1 parent/company query per result;
- bound styles by company-owned indexed parent IDs before aggregation until
  direct company stamps arrive in a later chunk;
- projection must request only fields needed for the allowlist and derivation;
- pagination must occur on the server;
- escape search expressions;
- foreign and missing styles/data must not be distinguishable through the API.

If reusing `ownershipProofFor` would reintroduce N+1 reads, first bound by company
parents and prove in batches or through a service-level ownership map. Do not
weaken isolation for performance.

### Department description

Change the system default description to something truthful, for example:

> Style execution, component selection and development coordination.

Because `ensureAccessDepartments` is intentionally additive, do not turn it into
an unconditional updater. Provide an idempotent, narrowly targeted metadata
migration that updates only the exact old system-supplied Merchandising
description. Preserve any administrator-customised description. Include dry-run
output and tests for “old default changes / custom value remains.” Do not run the
migration against production as part of this task.

## Frontend scope

### Navigation

Extract a pure Merchandising navigation configuration/resolver that can be
tested without React. The visible top-level navigation must be exactly:

1. Overview — `/merchandiser/dashboard`
2. My Work — `/merchandiser/work`
3. Styles — `/merchandiser/styles`

Remove from visible Merchandising navigation:

- Products & BOM;
- Customers and Purchase Orders/PI;
- size configuration;
- units and conversions;
- operations;
- warehouses;
- devices and machines;
- the re-exported Sales settings page.

Do not delete their route files in C1. They are compatibility surfaces pending
the later route-classification and retirement decision. They must not appear in
navigation, dashboard cards, quick actions, empty-state links or breadcrumbs.

Route resolution must light exactly one correct entry for dashboard, work list,
style list and nested style detail pages. Unknown/legacy routes should not light
a misleading item.

### Overview page

Replace the current Sales-derived dashboard completely. It must fetch only the
new Merchandising overview/work APIs.

Visible content:

- page title and a short ownership-accurate description;
- factual count cards for the backend counts that exist;
- “Needs attention” list using the first page of Style Work;
- clear loading, empty, error, forbidden and retry states;
- links only to `/merchandiser/work` or `/merchandiser/styles`.

Every count card must open My Work with the corresponding `kind` filter, except
the all-active-styles count, which may open Styles. Do not show a card before its
destination and filter work.

Do not invent percentage trends, risk colours, customer names, currency values,
PO statuses or deadlines.

### My Work page

Create `/merchandiser/work/page.js`.

It must provide:

- search;
- work-kind filter chips/select;
- paginated results from the server;
- style identity and explicit actions required;
- link to `/merchandiser/styles/[id]` only;
- URL query parameters for `q` and `kind` so dashboard links are reproducible;
- loading, empty, filtered-empty, error, forbidden and retry states.

Do not call this “My assigned work”: assignments do not exist yet. “Style Work”
or “Needs Attention” is truthful for C1.

### Styles page

Keep its existing responsibility and boundary. Only change it if necessary to
share safe presentation helpers or correct navigation highlighting. Do not add
commercial context or cross-department links.

### API client

Add dedicated Merchandising read functions under a Merchandising module or a
clearly named section. Do not make the new dashboard call Sales overview/customer
APIs through `lib/rnd/api.js` merely because that file currently contains style
helpers. Preserve existing style calls unless moving them is necessary and fully
covered by tests.

## Tests

Add focused automated tests in both repositories.

### Backend tests must prove

- unauthenticated request is refused;
- a user without a Merchandising role is refused even if they can access Sales,
  R&D, Store or Project Manager;
- viewer can read; editor/approver/owner can read; platform admin can read;
- unresolved company context is refused;
- cross-company styles never appear or influence counts;
- counts are per style and match each real stored state;
- multi-action style appears once with all applicable actions;
- `q`, `kind`, `limit` and cursor pagination work deterministically;
- malformed filters/cursors are rejected without leaking information;
- exact response allowlists exclude journey, enquiry, customer, commercial,
  supplier, rate, cost, margin, tax, consumption, evidence and technical fields;
- empty database/company returns truthful zero counts and empty work;
- department-description migration changes only the exact old default and is
  idempotent.

### Frontend tests must prove

- navigation is exactly Overview, My Work and Styles, in that order;
- every navigation href resolves to a real page;
- nested style routes highlight Styles and work filters highlight My Work;
- no removed/foreign destination remains in visible nav or dashboard source;
- dashboard calls no Sales overview/customer/request endpoint;
- every card links to a working filtered destination;
- My Work preserves `q`/`kind` in the URL and sends them to the API;
- rows link only to Merchandising style detail;
- forbidden/error/empty states do not masquerade as zero work;
- no Journey, customer, quotation, supplier, price, cost, margin or cross-app
  route appears in rendered source after comments are stripped.

Update stale source-contract tests that currently assume only Packaging is
editable on the Style BOM; Development is already implemented and the test must
describe the current truth. Do not weaken a boundary assertion merely to make a
test pass.

## Verification

Run the smallest relevant suites first, then:

- all Merchandising-related backend tests;
- backend tenancy/security guards relevant to the new route;
- all Merchandising frontend tests;
- the existing Packaging and Development frontend/backend suites;
- frontend lint for changed files;
- `git diff --check` in both repositories.

If broader suites have pre-existing unrelated failures, record the exact command,
failure and evidence that it is unrelated. Do not fix outside this chunk.

Perform an authenticated browser walkthrough when credentials/session are
available:

1. open Overview as a Merchandising viewer;
2. follow every card to its filtered Style Work list;
3. search and filter;
4. open a style and return;
5. verify editor controls on the existing style page remain role-correct;
6. verify a non-Merchandising user is refused;
7. verify no removed nav item appears at desktop or narrow width.

Do not use production credentials or mutate production data. If no authenticated
session exists, state that limitation; do not claim browser acceptance passed.

## Explicitly out of scope

- organisational hierarchy and assignment model;
- versioned Sales requirement intake;
- Style Execution File creation;
- Time-and-Action;
- sample coordination board;
- readiness engine;
- change control;
- reports and bulk operations;
- completing the Materials editor;
- moving Packaging or Development storage;
- deleting legacy/re-export routes;
- changes to Sales, R&D, Store, Production, Quality, Logistics, Accounting or
  Central Costing behaviour.

## Completion report

At the end, provide:

1. outcome first;
2. exact backend and frontend files changed;
3. API response contract and work-kind definitions;
4. visible UI changes;
5. migration behaviour and whether it was run (it must not be run on production);
6. tests and checks run with totals/results;
7. browser walkthrough result or explicit limitation;
8. pre-existing failures left untouched;
9. remaining risks;
10. the recommended scope of C2, without implementing it.

Do not commit or push unless the user explicitly asks.
