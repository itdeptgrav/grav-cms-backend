# GRAV Help — Product and Implementation Plan

> **Status:** Proposed product and architecture plan. No application code has
> been changed by this plan.
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Backend and durable product documents:** `/Users/risheeray/grav-cms-backend`
>
> **Scheduling note:** This plan does not replace the active implementation
> scope in `docs/tasks/current-task.md`. Make one approved chunk below the active
> task only when the owner explicitly switches scope.

## 1. Outcome

Build one authenticated **GRAV Help** application that teaches employees how to
complete real work across GRAV, from both a central searchable library and the
screen where the work happens.

It must answer five questions quickly:

1. Where am I?
2. What is this screen for?
3. What should I do, in what order?
4. What does a successful result look like?
5. If I am blocked, who owns the missing decision or data?

The Help application is an operating manual, not merely a list of frontend
routes and not a second copy of the product UI.

## 2. Findings from the current codebase

### 2.1 Scale and application shape

The frontend is one Next.js application with approximately 457 page routes and
603 component files. The largest route families are Accounting, Store, Sales,
HR, CEO and Project Manager. Many routes are detail, edit, print, legacy or
shared wrappers, so route count must not be mistaken for the number of guides.

The backend is one Express/Mongoose service with approximately 291 route files,
186 model files and 395 service files. Business ownership crosses application
boundaries: for example, Sales creates the commercial commitment, Project
Manager plans it, Store fulfils material demand, Production executes it, QC
inspects it, Dispatch ships it, and Accounting owns the financial posting.

Help therefore needs both:

- **application guides** for the screen a user is operating; and
- **end-to-end process guides** that explain hand-offs between departments.

### 2.2 Existing help foundations to reuse

- Sales Journey already has a canonical stage playbook and a collapsible
  `StageGuide` on every stage.
- Store & Purchase already has a searchable interactive Quick Tour, real-screen
  spotlight anchors, and complete/quick Word manuals with annotated UI images.
- Project Manager already exposes a Support Center route, but it is a
  placeholder.
- The shared application shell already knows the authenticated user's granted
  departments and current route.
- GRAV already has one route-aware, read-only assistant. It currently has
  permission-gated business-data tools for selected domains, but no canonical
  Help knowledge retrieval tool.
- Durable product rules already live in `docs/product/` and architecture rules
  in `docs/decisions/`. These are essential authoring evidence, but most are not
  suitable employee-facing prose without adaptation.

### 2.3 Constraints the Help design must respect

- A user must not discover screens, commercial information or instructions for
  applications they are not authorised to use.
- Current routes contain legacy, prototype and hidden surfaces. Help must label
  them honestly and must not train users to begin new work in a legacy screen.
- Several frontend areas are actively changing. Screenshots and selectors can
  drift faster than written business steps.
- One record can have different owners at different lifecycle stages. Help must
  name the owner of the next action rather than implying the current viewer may
  perform it.
- Existing uncommitted work in both repositories must be preserved.

## 3. Product boundary

### In scope

- Searchable help home and per-application libraries.
- Task-based, role-aware operating guides.
- End-to-end process maps and hand-off guides.
- Contextual “Help for this page” entry from the shared application shell.
- Reusable short guidance embedded in complex screens.
- Interactive tours only where a real action sequence benefits from them.
- Glossary, status explanations, troubleshooting and “what changed” notices.
- Version, ownership and verification metadata for every published article.
- Permission-filtered Help answers through the existing GRAV assistant.
- Feedback on whether an article solved the problem.

### Out of scope for the first release

- Letting Help perform business mutations on the user's behalf.
- Copying every API field or database model into employee documentation.
- Publishing unfinished product specifications as user guidance.
- A separate deployment, separate login or separate employee directory.
- A general-purpose learning-management system, exams or certification.
- A database-backed WYSIWYG editor before the content workflow is proven.
- Recording sensitive field values, record IDs or free-text business content in
  Help analytics.

## 4. Information architecture

### 4.1 Primary entry points

1. **Help home** — global search, “continue learning”, recently updated, and
   application cards filtered to the user's grants.
2. **Application hub** — purpose, common jobs, navigation map, roles, concepts,
   troubleshooting and related end-to-end processes.
3. **Task guide** — one employee outcome, not one page. Example: “Receive goods
   against a purchase order”.
4. **Process guide** — a cross-application journey such as lead-to-delivery,
   request-to-stock/purchase, order-to-production, hire-to-payroll, or
   transaction-to-financial-report.
5. **Context panel** — the guides mapped to the user's current route, opened
   without losing the page.
6. **Interactive tour** — a short walkthrough of stable, high-value controls on
   the real screen.
7. **Ask GRAV** — a Help retrieval answer that links back to the exact approved
   guide and never invents steps.

### 4.2 Library taxonomy

Organise by employee language:

- Getting started
- Daily work
- Create or request
- Review and approve
- Track and resolve
- Reports and audit
- Settings and master data
- Troubleshooting
- End-to-end processes
- What's new

Do not expose the repository folder tree as navigation.

### 4.3 Canonical article types

| Type | Purpose |
|---|---|
| Quick answer | One definition, status or short decision |
| Task guide | A repeatable job with prerequisites, steps and outcome |
| Screen guide | Orientation to a dense workspace and its controls |
| Process guide | Ownership and hand-offs across applications |
| Troubleshooting | Symptom, checks, safe resolution and escalation owner |
| Policy/concept | Business meaning that should not be inferred from UI labels |
| Change note | A user-visible workflow or vocabulary change |

## 5. Content contract

Keep employee-facing content in version control as structured MDX/Markdown plus
validated front matter. Each article must carry at least:

```yaml
id: store.receive-goods
title: Receive goods against a purchase order
app: store
audience: [store_editor, store_approver]
capabilities: [store.receipt.create]
routes:
  - /store/dashboard/operations/goods-receipts
  - /store/dashboard/operations/purchase-order/:id/receive
kind: task
status: published
owner: Store
reviewers: [Finance, Quality]
last_verified: 2026-09-06
source_refs: []
keywords: [GRN, delivery, receipt, quarantine, put-away]
```

Every task guide uses the same visible structure:

1. **Use this when**
2. **Before you start**
3. **Steps**
4. **Done when**
5. **If blocked**
6. **Who acts next**
7. **Related guides**

`source_refs` point to the relevant product decision, application route,
service or test used to verify the instruction. They are maintainer evidence,
not links shown to ordinary employees.

### Content truth states

- `draft` — visible only to authors/reviewers.
- `published` — verified against the live workflow.
- `needs_review` — still readable, visibly dated, but a source changed.
- `retired` — searchable only through redirects/history; it must name the
  replacement.
- `legacy` — read-only historical instructions; never offered as the way to
  start new work.

Prototype screens must be labelled as previews. Missing business decisions must
remain explicit gaps; Help must not turn them into invented policy.

## 6. Technical architecture

### 6.1 Placement

Build Help inside `grav-cms`, initially at `/help`, and reuse the existing
authenticated shell, theme, session and app switcher. It should appear as a
direct, capability-aware application like Costing rather than inventing a
department solely for navigation.

Add a Help icon to the shared shell so every authenticated application can open
`/help?from=<current-route>` or a right-side contextual Help panel. The current
route is a lookup input, never an authorisation input.

### 6.2 Content and search

- Store the canonical content under one dedicated tree, grouped by application
  and process rather than by UI folder.
- Validate article metadata at build/test time.
- Generate a compact search index from published content.
- Search title, aliases, task outcome, keywords, screen labels and body text.
- Rank an exact current-route match first, then task-title matches, then full
  text.
- Support synonyms used in this codebase, for example MRF/material request,
  GRN/goods receipt, customer request/manufacturing order, and
  quotation/proforma invoice where the product documents say they are valid.
- Keep the first release server-independent for content reads if the filtered
  static index remains small. Add a backend search service only when content
  volume, analytics or authoring makes it necessary.

### 6.3 Permission filtering

1. Verify the session using the current shared mechanism.
2. Resolve department grants and capability-gated applications on the server.
3. Filter article metadata before results, related links or AI context are
   returned.
4. Apply finer capability tags for sensitive subjects such as costing policy,
   margin, payroll, salary and accounting actions.
5. Treat hidden navigation as an affordance, not protection; direct Help URLs
   must apply the same filter.

The initial policy should be conservative: users see general process context
and detailed operating instructions only for applications/capabilities they
hold. Cross-department guides may describe the existence and owner of the next
step without revealing restricted screen details.

### 6.4 Context mapping

Use normalised route patterns rather than exact URLs containing record IDs.
Maintain one tested registry:

```text
/store/dashboard/operations/purchase-order/:id/receive
  -> store.receive-goods
  -> store.inspect-delivery
  -> process.request-to-purchase
```

Unknown routes fall back to their application hub. A missing mapping must never
break the application page.

### 6.5 Tours and embedded guidance

Generalise the proven Store pattern, but do not attach a tour to every screen.
Use a tour when:

- the task crosses multiple stable screens;
- controls are difficult to discover; or
- a safe training sequence materially reduces mistakes.

Tour steps reference stable `data-help` anchors and are validated against the
declared routes. They must support pause, skip, resume and missing-target
fallback. Tours should explain and navigate; they must not submit irreversible
actions automatically.

Extract Sales' stage playbook and Store's Quick Tour content into, or adapt them
behind, the canonical Help content registry so the same instruction is not
maintained in two places.

### 6.6 GRAV assistant integration

Add a permission-gated, read-only Help retrieval tool to the existing central
assistant:

- input: question, current route and optional application;
- retrieval: only published, authorised Help content;
- output: short answer, article IDs/titles and in-app Help links;
- behaviour: cite the guide used, distinguish product instruction from live
  record state, and say when no verified instruction exists.

Do not paste the whole Help corpus into every assistant prompt. Retrieve a
small authorised set per question. Help content and business-data tools remain
separate sources, even when one answer uses both.

### 6.7 Analytics and privacy

Record only operational Help events: article viewed, search query after safe
normalisation, no-result search, tour started/completed/skipped, and
helpful/not-helpful. Do not capture record IDs, form values, message bodies or
page screenshots. Aggregate by application and article so owners can find
documentation gaps.

## 7. Coverage map

Documentation should be built around these jobs, not around all 457 pages one
by one.

| Area | First coverage |
|---|---|
| Getting started | Sign in, choose/switch app, navigation, permissions, profile, common statuses |
| Sales / Merchandiser | Prospect and lead, customer setup, Journey stages, enquiry, sample, price/PI, order confirmation, production visibility, closing |
| Costing | Start costing, technical inputs, scenarios, source gaps, review/approval, quotation and procurement hand-off |
| R&D | Style, tech sheet, materials/BOM, sampling, approvals, production route and shipment facts |
| Requests / Budget | Raise request, manager review, Finance decision, classification, commitment and exceptions |
| Store & Purchase | Request desk, reserve/issue, source/order, receive/inspect/put-away, return, stock count, movements, masters, reports |
| Project Manager | Manufacturing-order intake, work-order planning, release, schedule, execution exceptions and closeout |
| Production floor | Cutting, Production Supervisor, Embroidery, QC, Packaging and Dispatch role-specific daily flows |
| HR / Employee | Employee setup, attendance, leave, documents, payroll boundaries, recruitment and performance |
| Accounting | Companies, chart/ledgers, vouchers, receivables/payables, bank reconciliation, budgets, tax and reports |
| CEO | Read-only dashboards, source/drill-down meaning, approval boundaries and unavailable data |
| Shared tools | Files, CoWork, Planner, barcode devices, measurements, settings, Developer operations where authorised |

## 8. Sequential delivery plan

### Chunk 0 — inventory and governance

- Produce an application/role/capability/route matrix.
- Mark routes canonical, shared, hidden, prototype, legacy or public.
- Define article owners and review cadence by department.
- Define the glossary and canonical synonyms.
- Select the first 20 high-frequency/high-risk employee tasks from usage and
  business-owner input.
- Record explicit gaps where the code and durable product documents conflict.

**Exit:** every planned guide has an owner, audience, source and truth state;
no application route is silently assumed canonical.

### Chunk 1 — Help foundation

- Add `/help`, Help home, application hub and task-guide rendering.
- Add validated content schema and a small fixture corpus.
- Add search, route normalisation and contextual article matching.
- Add authenticated permission filtering.
- Add loading, empty, forbidden, no-result and stale-content states.
- Add accessibility and responsive coverage from 375 px upward.

**Exit:** a user can search, browse only permitted content and open the correct
guide from a mapped route.

### Chunk 2 — Store and Sales pilot

- Import/adapt the existing Store manual and six-step Quick Tour without
  duplicating their wording.
- Import/adapt the Sales stage playbook and map every Journey stage.
- Add the first cross-app guides: lead-to-order and request-to-stock/purchase.
- Test links, route patterns and tour anchors.
- Run five real employee tasks with one Store user and one Sales user.

**Exit:** the two most mature help sources work through the common platform,
and user testing proves whether the content contract is understandable.

### Chunk 3 — operational lifecycle

- Document Costing, R&D, Requests/Budget and Project Manager.
- Add order-to-production and costing-to-procurement process guides.
- Map blockers to their actual owning department.
- Replace the Project Manager Support placeholder with the common Help
  experience or redirect it compatibly.

**Exit:** one commercial requirement can be followed from qualification through
release to production without an undocumented hand-off.

### Chunk 4 — factory-floor roles

- Add short, device-friendly guides for Cutting, Production Supervisor,
  Embroidery, QC, Packaging and Dispatch.
- Prefer one-job quick guides, large tap targets and minimal prose.
- Add barcode/scan troubleshooting without teaching bypasses.
- Verify on the actual screen sizes and input devices used on the floor.

**Exit:** each floor role has a daily-start guide, its primary transaction
guides and safe exception handling.

### Chunk 5 — HR, Employee, Accounting and CEO

- Cover sensitive workflows with capability filtering down to article level.
- Separate “how the report is calculated/read” from “what this company's
  current numbers are”.
- Add hire-to-attendance/leave/payroll and spend-to-posting/payment process
  guides.
- Review all wording with the owning business function.

**Exit:** restricted topics cannot leak through search, related articles,
direct links or assistant retrieval.

### Chunk 6 — assistant, feedback and change management

- Add the Help retrieval tool to GRAV.
- Add article feedback and privacy-safe search/tour analytics.
- Add “What's new” entries linked to changed guides.
- Add source-change detection and review queues.
- Decide from real author behaviour whether a controlled browser editor is
  justified; keep Git-reviewed content if it is not.

**Exit:** GRAV answers Help questions from authorised sources with links, and
owners can see missing or stale coverage.

## 9. Verification strategy

### Automated

- Front-matter/schema validation.
- Unique article IDs and valid related-article references.
- Declared route patterns resolve to known application families.
- No retired article appears in normal search.
- Permission matrix tests for search, direct URL, related links and assistant
  retrieval.
- Context lookup tests for static and parameterised routes.
- Link checks for every “open this screen” action.
- Tour-step tests for declared anchors and safe missing-target behaviour.
- Search relevance fixtures for canonical terms and synonyms.
- Accessibility checks for keyboard, focus, landmarks and screen-reader labels.

### Human

- The departmental owner completes the procedure from a clean account.
- A new employee follows it without verbal help.
- A restricted employee confirms that sensitive guides are absent.
- A mobile/floor-device pass verifies size, scrolling and scan workflows.
- A reviewer confirms “done when”, blocker and next-owner wording.

## 10. Definition of done for one guide

A guide is publishable only when:

- it teaches one recognisable employee outcome;
- its prerequisites and required permission are stated;
- every instruction is verified against the current UI and business rule;
- it identifies the successful result;
- it explains safe handling of the common blocker;
- the next owner is named where work crosses departments;
- its route links and optional anchors pass automated checks;
- sensitive visibility has been tested;
- an owner and verification date are recorded;
- it does not depend on an unlabelled prototype or legacy route.

## 11. Product success measures

- At least 90% of top-task searches return a useful first-page result.
- At least 80% of pilot users complete the selected task without IT assistance.
- No permission leakage in automated and role-based manual tests.
- Published-guide stale rate stays below 10% after source-change detection is
  enabled.
- No-result searches and “not helpful” feedback decline release over release.
- Support questions are categorised by missing guide, unclear guide, product
  defect or permission/policy issue so documentation is not blamed for product
  faults.

## 12. Recommended first release

Do not wait to document every application before releasing. Ship a useful
authenticated foundation with:

- Help home and contextual Help;
- global getting-started material;
- Store & Purchase content adapted from the existing manuals/tour;
- Sales Journey stage guidance;
- the two cross-app guides `lead -> order` and
  `request -> stock or purchase`;
- about 20 verified task guides;
- permission-filtered search;
- feedback, but no AI retrieval or authoring CMS yet.

This first release validates discovery, content structure, permissions and
maintenance cost before the remaining application families are added.

## 13. Fast-track delivery mode

Use this path when delivery speed matters more than a full professionalisation
programme. It supersedes the broader chunk sequence for the MVP, but not the
security boundary or content truth rules.

### Fast Chunk 1 — structure and content format

- Add `/help` inside the existing frontend.
- Use repository-managed Markdown rather than building an authoring database.
- Implement three screens only: Help home, application page and article page.
- Define the article metadata, route mapping and application catalogue.
- Add one shared Help button that sends the current route to `/help`.

### Fast Chunk 2 — useful starting content

- Adapt the existing Store Quick Tour/manual into the first articles.
- Adapt the existing Sales Journey playbook.
- Add Getting Started, Project Manager and Request/Budget essentials.
- Publish approximately 20 high-value task guides.
- Use text and direct screen links first. Add screenshots only where text cannot
  explain the control clearly.

### Fast Chunk 3 — search and access

- Add simple local search over article title, summary, keywords and body.
- Show only applications granted to the signed-in employee.
- Apply article-level restrictions only to sensitive Costing, salary, payroll
  and Accounting topics.
- Fall back from an unmapped route to its application's Help page.

### Fast Chunk 4 — remaining applications

- Add short guides in this order: Costing/R&D, Project Manager, factory-floor
  roles, HR, Accounting, CEO, then lower-use shared tools.
- Start each application with five guides: overview, daily work, main creation
  flow, main approval/review flow and common blockers.
- Expand based on actual employee questions rather than attempting complete
  page-by-page coverage upfront.

### Fast Chunk 5 — assistant, later

- Add Help retrieval to GRAV only after the written guides and search are
  reliable.
- Do not make AI a dependency for the first Help release.

### Checks retained in fast mode

Skip broad visual-regression suites, exhaustive browser combinations, formal
training studies and a full analytics system. Retain only:

- content metadata can be read;
- article and screen links are not broken;
- an unauthorised user cannot open a restricted guide;
- route-to-guide lookup works for one static and one ID-based route per app;
- Help opens on desktop and a phone-sized viewport.

These are release checks, not a large testing programme.

## 14. Keeping Help current when the UI changes

### 14.1 One canonical content location

Keep all Help articles in one frontend directory, proposed as:

```text
content/help/
  getting-started/
  sales/
  store/
  costing/
  project-manager/
  production/
  hr/
  accounting/
  processes/
```

Do not bury instructions inside page components. Inline tips, Sales stage
guidance, Help pages and tours should eventually read from the same content
record or shared content module. This prevents four copies of one instruction
from drifting.

### 14.2 Source-to-guide ownership map

Each article records the application source areas that can invalidate it:

```yaml
source_refs:
  - app/store/dashboard/operations/goods-receipts
  - components/store/goods-receipts
owner: Store
last_verified: 2026-09-06
```

Maintain one small application map that connects source folders to Help
folders. For example:

```text
app/store/** or components/store/**       -> content/help/store/**
app/sales/** or components/sales/**       -> content/help/sales/**
app/project-manager/** or components/pm/** -> content/help/project-manager/**
```

When code changes under a mapped source, the related Help is flagged for review.
For speed, the first version may print a warning rather than blocking a build.

### 14.3 UI-change checklist

Every user-visible change should answer four short questions:

1. Did a screen name, button, field, route, status or sequence change?
2. Which existing Help article references it?
3. Does the article need new wording, a new link or a new screenshot?
4. Has `last_verified` been updated after opening the real screen?

Add these questions to the normal implementation-task template. The developer
making the UI change updates the associated guide in the same change. A product
owner reviews business meaning only when the workflow or responsibility changed.

### 14.4 Update procedure

For an ordinary UI change:

1. Find the guide by its route or source reference.
2. Change the smallest affected step or screen label.
3. Open the target screen and follow the guide once.
4. Update `last_verified`.
5. Add a short What's New entry only if employees will notice the change.

For a workflow change:

1. Update the durable product/decision document first.
2. Update every affected task and cross-app process guide.
3. Confirm the owner of each hand-off and blocker.
4. Retire old guidance with a replacement link; do not silently delete it.
5. Update tours and screenshots last, after the workflow is stable.

### 14.5 Screenshot policy

Screenshots are expensive to maintain. Use them only for dense screens or
controls that are difficult to locate. Prefer cropped, annotated images over a
full-page capture. Every screenshot belongs to one article and carries the same
verification date. A changed layout does not require recapturing an image unless
the annotation, control location or visible instruction became misleading.

### 14.6 Simple stale-content dashboard

The Help home can later show maintainers, not ordinary employees:

- articles whose source folders changed after `last_verified`;
- broken route links;
- articles not verified for 90 days;
- Help searches with no result;
- articles repeatedly marked unhelpful.

This should remain a small maintenance view, not a full documentation CMS.

## 15. Immediate implementation scope

The first implementation task should contain only:

1. `/help` home with application cards and search;
2. Markdown article loader and validated metadata;
3. application and article pages;
4. current-route Help link;
5. permission-aware application visibility;
6. five Getting Started articles;
7. ten Store articles adapted from the current manual;
8. five Sales Journey articles adapted from the current playbook;
9. the five retained fast-mode checks.

Do not include the assistant, analytics, browser editor, automated screenshot
generation or every application in this first task.
