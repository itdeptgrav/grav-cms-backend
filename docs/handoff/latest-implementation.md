# Latest implementation — the /onboarding launcher as an actionables dashboard

10 Oct 2026. **Committed and pushed on `NEW_CMS_BRANCH` in both repositories**
(owner's request: "the onboarding page should look like a proper dashboard,
the actionables of the entire CMS — if a person has access to five apps, that
should be the screen for their actionables").

The previous handoff (the CLO T-shirt drape, 2 Oct 2026) is in git history.

## What it does

`/onboarding` (frontend `components/onboarding/DepartmentPortal.js`) used to be
a grid of application tiles. It is now a dashboard for every application the
person holds:

- greeting, date and a one-line summary ("13 items need your attention in 2
  applications, 1 of them urgent"), with a Refresh button and an updated time;
- four summary figures: waiting on you, urgent, applications with work, all clear;
- **Needs your attention**: one ranked list across all applications (urgent →
  needs action → to do, then by count). A line switches into the application
  the way a tile always has (`switch-department`) and lands on the page that
  lists those records;
- **By application**: the busiest applications, each with a bar;
- **Your applications**: one card per tile with its role, up to three to-do
  lines, and a real state: loading, all clear, couldn't check, or "open to see
  its work" for an application with no to-do list on the dashboard.

## Backend

`GET /api/me/actionables` (`routes/Access/actionables.js`, mounted in
`server.js` beside `/api/department-team`; it reads its own session through
`services/cmsSession`).

- `services/actionables/actionables.service.js`: the applications counted are
  exactly `listAccessibleApps` (the tiles' own resolver). All applications are
  asked at once, each provider under `ACTIONABLES_PROVIDER_TIMEOUT_MS` (6 s).
  A failure is "unavailable", never "all clear". The answer is memoised per
  identity + token version for `ACTIONABLES_CACHE_MS` (30 s; 0 disables), and
  `?fresh=1` skips the memo.
- `actionablesSummary.js` (pure) ranks the items, drops zero counts, keeps only
  in-app paths (never a URL) and builds the totals.
- `actionableProviders.js` holds one provider per department slug. Each filter
  is the one the department's own list or overview uses, cited in the file.
  Role rules:
  - a viewer is shown nothing to act on;
  - work to do needs write;
  - a decision needs approve;
  - the approval queue (`ChangeRequest`) shows an approver the department's
    pending holds, and an editor only their own.

  Company-stamped models read the canonical (primary) company **or** no
  company: the non-strict read-through. Demo companies are never counted.
- No provider yet for CEO, the finishing stages or embroidery: none has a
  stored, countable queue. Their cards say "open to see its work".

| App | Counts |
|---|---|
| HR | leave and regularizations to decide, document requests, held changes |
| Sales | your overdue follow-ups, customer requests pending, held changes |
| Merchandising | new developments, awaiting approval, clarifications |
| Accounting (approver) | approval requests, spend at finance review |
| Store | overdue POs, MRFs to review, requests to classify, approved purchases to order, draft POs, deliveries expected |
| MPC | measurements still collecting people |
| Cutting | work orders to cut (Cutting's own `workOrderScope`) |
| QC | pieces waiting for re-inspection (`pendingReworkSnapshot`) |
| Packaging | packed cartons not dispatched, cartons to weigh |
| PPC | orders not yet planned, held changes (`project-manager` slug) |
| IE | method studies and bulletins in review (approver), held changes |
| Maintenance | overdue jobs, repairs awaiting a report, open jobs (only where `maintenance_orders` exists) |
| Marketing | enquiries held for review, handovers returned |
| Board (approver) | policy drafts |
| Developer | new alerts, acknowledged unresolved alerts |

## Also in this change: the app-access resolver restored

`ab4dc21` (9 Oct, "maintenance reports …") deleted
`services/access/appAccess.service.js` while `routes/auth/deptAuth.js` still
requires it, so `/api/auth/login` and `/verify` threw MODULE_NOT_FOUND on this
branch. It was restored from `main`'s 8 Oct version (the one-read grant index).

**Not fixed — the owner's call.** The same commit also:

- deleted `services/access/accessGrantAdmin.service.js`, which
  `routes/Access/departmentTeam.js` and `routes/Accountant_Routes/Acc_team.js`
  still require;
- deleted `services/cctv/{cctvLink,config,manager}.js`;
- removed 89 `app.use` lines from `server.js` and added 7.

Unmounted at HEAD as a result:

- the `hrContract()` guards;
- `/api/cms/ppc`, `/api/cms/ie`, `/api/cms/merchandising`, `/api/cms/marketing`,
  `/api/cms/maintenance`, `/api/cms/board/policies`, `/api/costings`;
- QC raw items, finishing, carton dispatch, and more.

See `git show ab4dc21 -- server.js`. The dashboard's counts read the models
directly and work either way, but the pages its lines open call those APIs.

## Verification

- `node --test services/actionables/*.test.js`: 15/15. That is 5 for the pure
  summary, 3 for the service wiring with a stubbed resolver (only allowed apps
  asked, timeout means unavailable, memo, refusal), and 7 for the providers
  against recording stand-ins (role rules, company read-through, filters).
- Every provider filter was cast against its real Mongoose schema, with no
  database. Every path exists and every value casts; the checker was confirmed
  to catch a misspelled path.
- `npm test`: 2201 pass, 1 fail. The failure is
  `services/openItems.test.js` (`agedBillsForLedger`), which this change does
  not touch.
- Frontend: `components/onboarding/actionables.test.mjs` passes 6/6 under the
  repo's runner. Both changed components parse, and the dashboard
  server-renders without error in the data, loading and failed states.
- **Not done:** no run against a live database (no `.env` in this
  environment), so no real counts were seen, and nothing was viewed in a
  browser.
