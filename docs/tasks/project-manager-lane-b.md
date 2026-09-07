# Project Manager professionalisation — Lane B

> **Status:** Ready for frontend implementation.
>
> **Purpose:** Deliver visible, frontend-only usability and presentation
> improvements while Lane A owns backend contracts, endpoint access,
> authorisation, audit, status integrity and cross-application architecture.
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Planning docs:** `/Users/risheeray/grav-cms-backend/docs`

## 1. Lane ownership

### Lane A owns

- backend routers, middleware, models and services;
- authentication, authorisation and approval enforcement;
- API response and URL contracts;
- status-transition and data-integrity decisions;
- cross-application endpoint inventory;
- database/query/index work;
- backend integration and route tests.

### Lane B owns

- Project Manager page structure and information hierarchy;
- responsive behavior and accessibility;
- honest loading, empty, error, forbidden and read-only presentation;
- shared GRAV component adoption;
- removal of fictional or contradictory frontend affordances;
- small pure presentation helpers and their frontend tests;
- browser verification of visible states.

### Merge rule

Lane B must not change backend code or infer a new business rule. It projects
the behavior the current backend already declares. If a visible fix requires a
new field, new endpoint, changed permission or changed status meaning, Lane B
records the dependency for Lane A and stops that part.

Before every chunk, compare `git status --short` in both repositories with the
chunk's proposed file list. A file currently being changed by Lane A is not a
Lane B file for that chunk.

## 2. Lane B sequence

### B1 — Requests desk truth and responsive worklist

Make the Requests screen express the authority already enforced by the server:

- manufacturing-order requests are PM decisions;
- material requests are PM oversight only;
- MRF approval belongs to the requester's Primary Manager/TL in CoWork;
- no MRF control should imply that PM can approve or reject it.

Files are limited to the PM Requests list, detail, action slider and a small
pure presentation helper/test if useful. No backend or shared shell work.

### B2 — Manufacturing-order register usability

Improve filter clarity, deadline/risk scanning, responsive list behavior and
empty/error states on the existing register. Reuse the live APIs and
`components/manufacturing/moStatus.js`; do not change either contract.

### B3 — Manufacturing-order detail hierarchy

Decompose the visible detail experience into clear order identity, work-order
planning, production execution and exception areas. Preserve every tab,
deep-link and downstream component. Coordinate with Lane A before touching any
file in its future manufacturing-order read-projection work.

### B4 — Planning interaction

Improve the existing planning drawer/page flow, validation presentation,
partial-failure clarity, keyboard behavior and mobile layout. Do not change the
three backend mutations or claim atomicity that Lane A has not implemented.

### B5 — Schedule interaction

Improve calendar navigation, capacity explanations, drag/move feedback,
responsive behavior, undo honesty and error recovery using the existing
schedule contract. Backend concurrency and idempotency remain Lane A work.

### B6 — execution and exception presentation

Once Lane A establishes the authoritative progress projection, turn production,
cutting, QC, packaging and dispatch data into one clear exception-led view.
Until then, do not visually reconcile conflicting sources by guessing.

## 3. Lane B Chunk B1 acceptance criteria

- MRFs never contribute to a “Pending PM” count.
- MRF rows never expose PM approve/reject actions.
- MRF status uses TL vocabulary: awaiting TL, TL approved or TL rejected.
- MO rows retain PM pending/approved/rejected vocabulary and actions.
- Default filters do not hide read-only MRF oversight accidentally.
- The page clearly separates “Decisions” from “Oversight.”
- The detail page contains no text suggesting PM can approve an MRF.
- The action slider cannot present MRF approval/rejection consequences.
- Loading, empty, error and refresh behavior remain intact.
- Mobile users do not depend on a horizontally scrolled desktop action table.
- Existing URLs, API calls and response fields remain unchanged.
- Viewer/approver affordances remain aligned with `RoleGate`; backend remains
  authoritative.
- No Lane A or Store/Purchase file is touched.

