# Latest implementation — the employee home on /onboarding

10 Oct 2026, later. Built on the actionables dashboard below. Owner's brief:
"Employee Home Dashboard", plus "make sure the UI matches our apps, it
shouldn't look alien". The owner chose to **only show what exists**: no
company pulse, announcements, kudos, events, training or tickets, and no
sample content. The people directory exposes name, role, department and photo
only. Leave and payslip drawers are offered to employee logins.

## Work first, personal second (owner, 10 Oct 2026, later still)

"Less personal … more about actionables and tasks and data about the role",
then "don't completely remove personal data, keep it secondary".

- **Backend:** `/api/me/home` gains `tasks` (Firestore `cowork_tasks`,
  keyed on the Cowork id).
  - `items` are the person's open / in-progress tasks (`assigneeIds`), minus
    finally-approved ones. Overdue come first; each carries progress, due,
    `sentBack` and `inReview`.
  - The counts are open, overdue, dueToday and sentBack.
  - `toReview` / `reviewItems` are `pending_tl_review` submissions on tasks
    this person approves (`approverId`) or assigned (`assignedBy`).
  - It uses the same queries the workload route and cowork.service already
    run, so no new Firestore index is needed.
- **Work, at the top:**
  - The hero's dial is the workload by urgency (items, the same counting rule
    as the urgency figures).
  - "Needs your attention" lists Cowork, planner and application queues only.
    The person's own leave and attendance corrections moved to the personal
    card (`personalItems`).
  - "Your tasks" (`TasksPanel.js`).
  - "Your work by application", with the role in each and its queue lines
    (`RolesPanel.js`, from `/api/me/actionables` `apps`).
  - Today's schedule and quick actions.
- **Personal, under a quiet "Personal" heading:**
  - "You": attendance, a thin shift bar, small leave rings, your requests,
    and Time off / Payslips.
  - The calendar, which now also marks Cowork task deadlines.
  - "Around GRAV": who is away, and a compact celebrations list.

## Rebuilt the same evening (owner: "not even close to the reference … boring")

The layout now follows the reference pack's structure, using only real data:

- **Hero** (`HomeHero.js`): the app's own stepped slab (`SlabCard`), with the
  person in its tab, the greeting, three clickable figures, the search, and a
  **shift clock**. The clock is an arc from shift start to end with the "now"
  sun and the punch-in mark. It uses the day's attendance row, else
  `home.shift`, the factory hours from `shiftHours.js`. A woven texture is
  drawn in the slab's ink at 5%.
- **App dock** (`AppDock.js`): large plates with queue counts, overlapping the
  hero's edge. "All N" opens the full pin/reorder launcher in a drawer.
- **Needs your attention**: three figures (Urgent / Needs action / To do) that
  filter the list. Each row has an urgency rail and its own action button.
  The all-clear state has a drawn spool.
- **Profile card** (`ProfileCard.js`): today's standing, then Request time off
  and Payslips (employee login) or Raise a request and Planner (anyone else).
  Leave left is shown as the kit's `Ring`s.
- **Your day** (`DayPanel.js`): a timeline with a live "now" line and Join
  links, then planner tasks due today, then who is away as an avatar stack.
- **Calendar** (`CalendarPanel.js`): this month and next, with holidays,
  approved and waiting leave marked, and today ringed. The next holidays are
  listed as date tiles.
- **Celebrations** (`PeoplePanel.js`): cards with a mark per kind, today's
  first, and a kind filter.
- **Backend:** `/api/me/home` adds `shift`, `holidays.month` / `range` (this
  month and next) and `attendance.late` / `workedMins`.
- **Checks:** desktop, tablet and phone, light and dark; no horizontal
  overflow; keyboard paths checked.
- **Motion:** a 520 ms rise and a slow pulse, both off under
  `prefers-reduced-motion`.

## Backend

- `GET /api/me/home` (`routes/Access/meHome.js`, mounted in `server.js`
  right after `/api/me/actionables`). Behind `authenticateCmsSession`,
  `Cache-Control: private, no-store`.
- `services/home/employeeHome.service.js`:
  - It resolves the session to its HR `Employee`. An employee login by `_id`.
    A department account by `employeeRef`, then badge → `biometricId`, then
    email. An accountant by email.
  - It reads nine sections side by side. Each has a 6 s timeout and answers
    `ok`, `none` (nothing to read for this person) or `unavailable`, never a
    fake zero.
  - The sections:
    - today's attendance (`DailyAttendance`);
    - the person's open and coming leave;
    - pending regularizations and document requests;
    - planner tasks overdue or due today;
    - today's interviews (`EmployeeTask`);
    - today's Cowork meetings (Firestore `cowork_scheduled_meets`,
      `participants` array-contains);
    - the next holidays (`CompanyHoliday`);
    - who is on approved leave today;
    - birthdays, work anniversaries and new joiners (company people memoised
      10 min; the birth year is never sent).
  - The answer is memoised per identity for `HOME_CACHE_MS` (30 s);
    `?fresh=1` skips it.
  - `me.selfService` is true only for an employee login. The
    `/api/employee/**` routes read the token id as the Employee `_id`, so
    leave and payslips from the home work only there.
- `GET /api/me/people?q=` searches colleagues: at least 2 characters, every
  word must match, at most 8 results, `{id, name, role, department, photo}`
  only.
- `services/home/homeDates.js` (pure): IST day arithmetic (the
  `Date.now() + 5.5h` / `getUTC*` pattern) and `peopleMoments`, which handles
  the year-end wrap and Feb 29 shown on Feb 28.
- Tests: `homeDates.test.js` (8) and `employeeHome.service.test.js` (5), all
  passing. `npm test`: 2308 / 2309. The one failure is
  `agedBillsForLedger … pre-migration inline output`, and it fails identically
  without these changes.
- No new collection (the cluster is at its cap) and no write anywhere.

## Frontend (grav-cms, `components/home/`)

- `HomeDashboard.js` lays out:
  - a greeting, date and context line;
  - a search pill (Ctrl/⌘K);
  - a 12-column bento from `deck`: attention 8 | today 4, apps 8 | quick
    actions 4, people full width;
  - two columns on a tablet, and one column on a phone in priority order.
- The sections:
  - `AttentionPanel`: own items plus every application's queue, urgent first,
    6 rows then "Show all".
  - `TodayPanel`: attendance, schedule, holidays, away.
  - `AppLauncher`: pin, reorder and recent apps, kept in localStorage.
  - `QuickActionsPanel`: only actions that exist, plus the leave balance for
    an employee login.
  - `PeoplePanel`.
  - `CommandPalette`: cmdk, covering applications, actions and people.
  - `LeaveDrawer`: the app's own `POST /api/employee/leave-applications` and
    withdraw.
  - `PayslipDrawer`: the app's own history and PDF.
- The rules are in `homeModel.mjs` (9 tests).
- Every request sends the session as `Authorization: Bearer` (`authHeaders`).
  `/api/employee/**` does not read the CMS `auth_token` cookie.
- Built on the `.grav-ui` tokens, `components/marketing/ui` and the CEO
  primitives. The header wears the shared `AccountMenu`. The old
  `ActionablesDashboard.js` was removed (nothing referenced it).
- The launcher's tile grid and the leave-balance row use
  `grid-cols-[repeat(3,minmax(0,1fr))]` on purpose: `globals.css` folds any
  plain `grid-cols-3` to one column under 768 px.
- Checked rendered at 1440, 820 and 390 px with stubbed APIs. No horizontal
  overflow, every control has an accessible name, Ctrl+K focuses the search,
  Escape closes it and returns focus. Not yet seen against the live backend in
  a browser.

## Not built, because nothing stores it

Announcements, kudos, events, training, tickets, room booking, expenses and a
notification inbox. Regularization and HR-document requests are counted but
are worked in the GRAV app. Leave and payslips stay in the app for
non-employee logins.

---

# Earlier the same day — the /onboarding launcher as an actionables dashboard

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
