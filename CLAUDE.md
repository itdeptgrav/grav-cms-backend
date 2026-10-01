# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shared AI collaboration workflow

Claude Code is responsible for:

- Reading the relevant documents under `docs/product/` and `docs/decisions/`, plus `docs/tasks/current-task.md`, before coding.
- Implementing only the work defined in `docs/tasks/current-task.md`.
- Reusing the existing architecture and established project patterns.
- Preserving unrelated and uncommitted changes.
- Running the verification relevant to the active task, subject to the repository safety guidance below.
- Updating `docs/handoff/latest-implementation.md` with the implementation and verification results.
- Stopping after the active task instead of starting the next task.
- Not committing changes unless the user explicitly requests a commit.

If the active task conflicts with durable product or architecture guidance, stop and report the conflict rather than expanding scope.

## What this is

The single Express backend for the whole GRAV Clothing platform. Everything else talks to it:

| Repo | Deployed as | Talks to this on |
|---|---|---|
| `grav-cms` | `cms.grav.in` | `/api/**` (JWT) |
| `grav-CoworkSpace` (folder `Coworking`) | `cowork.grav.in` | `/cowork/**` (Firebase ID token) |
| customer / vendor portals | `customer.grav.in`, `crm.grav.in` | `/api/customer/**`, `/api/vendor/**` |
| mobile app | — | `/api/employee/**` (Expo push) |

Those are separate git repos, typically cloned as siblings under one workspace folder. Nothing is shared as a package — a contract change here needs a matching change in each consumer.

## Commands

```bash
npm run dev        # nodemon server.js → http://localhost:5000
npm start          # node server.js
```

`npm run verify` runs the verification harnesses — the hand-written end-to-end checks in the repo root. Two tiers, and the split matters: the default set touches no data (pure business rules, plus read-only checks against the dev database) and takes seconds; `npm run verify:all` adds the ones that WRITE throwaway rows to the shared dev database and delete them again. `node verify.js --list` shows what exists; `node verify.js salary` runs one subject. Add a new harness to the right tier in `verify.js` or nobody will ever run it.

`npm test` runs the node:test files under `services/` and `middleware/`. Coverage is thin — a handful of pure services plus the three `middleware/bandwidth*.test.js` suites. **Most of the codebase has no tests.** The root-level `*_test.js`, `verify*.js`, `fix-*.js`, `backfill_*.js`, and `seed*.js` files are hand-run interactive scripts that read and write the **live dev MongoDB and Firestore**:

```bash
node -r dotenv/config c1_interactive_test.js      # C1 scoring engine tester (prompts interactively)
node -r dotenv/config c2_interactive_test.js      # C2 band tester
node -r dotenv/config p1_conflict_test.js
node -r dotenv/config verifyTimerSop.js
node -r dotenv/config cleanup_test_data.js        # deletes test tasks, resets employee sopPoints
```

Read the header comment of a script before running it — most declare hardcoded test employee IDs (e.g. `GR0067`) they will mutate. Run `cleanup_test_data.js` afterwards.

## server.js is the wiring hub

~2300 lines, and almost entirely wiring rather than logic:

- `dns.setServers(["8.8.8.8","8.8.4.4"])` on line 1 — overrides system DNS, which matters if Mongo Atlas SRV lookups fail on a restricted network.
- `allowedOrigins` array near the top — gates **both** the CORS middleware and the Socket.IO handshake. A frontend origin missing from this list fails with an opaque `Not allowed by CORS`. Add new deploy previews / dev tunnels / LAN IPs here.
- `express.json({ limit: "50mb" })` — raised for Tally XML and base64 media uploads.
- Two separate `io.on("connection")` handlers (see below).
- `connectDB()` then seeding of default department users (`createDefaultCuttingMaster`, `seedQCUser`, `seedCEOUser`).
- ~200 `require` + `app.use()` route-mount pairs. Adding a feature normally means one new file under `routes/` plus one pair here.
- Inside `server.listen()`: a **one-time repair block that reads the entire `cowork_tasks` collection on every boot** to backfill `approverId`/`isSelfAssigned`/`visibleTo`. It is idempotent but costs a full collection read per restart — relevant when chasing Firestore bandwidth.
- Two crons registered as `setInterval`, not `node-cron`: meeting 15-minute reminders (every 5 min), and Timer-SOP daily finalize (fires in the 00:15–00:25 IST window, guarded by a last-run-date variable).

## Two datastores, split by domain

- **MongoDB (Mongoose)** — the ERP: employees, HR/payroll/attendance, inventory, manufacturing, work orders, sales/CRM, customers, vendors, and the entire accountant/Tally module. `models/` mirrors `routes/`.
- **Firestore + Firebase RTDB** — everything Cowork: `cowork_employees`, `cowork_tasks`, `cowork_groups`, `cowork_direct_messages`, `cowork_conversations`, `cowork_scheduled_meets`, `cowork_notifications`, `cowork_task_timers`, `cowork_timer_events`, `cowork_work_commits`, `cowork_sop_*`, `bandconfigs`, `meeting_*`. Accessed via `config/firebaseAdmin.js`.

The join key across both is `employeeId` (e.g. `GR0067`, `E000`) — the biometric ID from the HR Mongo collection, reused as the Firestore document ID in `cowork_employees`. There is no foreign-key enforcement; code that spans both stores looks the employee up twice.

Firestore calls are instrumented for bandwidth accounting via `middleware/firestoreBandwidth.js` (`instrumentFirestore` wraps the admin SDK at boot); stats at `GET /cowork/admin/bandwidth-stats`. A second, independent meter — `middleware/bandwidthTracker.js` — runs alongside it measuring wire bytes rather than document counts; see **Bandwidth accounting** below.

## Bandwidth accounting

There are **two** meters and they answer different questions. Neither replaces
the other:

| File | Counts | Which bill |
|---|---|---|
| `middleware/firestoreBandwidth.js` | Firestore document reads/writes per route | the Firestore bill |
| `middleware/bandwidthTracker.js` | bytes on the wire, plus distributions | the Render bill |

The older one is unchanged and still serves `GET /cowork/admin/bandwidth-stats`.
The two use separate instrumentation flags (`__bandwidthInstrumented` vs
`__bandwidthTrackerInstrumented`) so both wrap the Firestore prototypes; giving
them one shared flag would make whichever loaded second silently report zero.
`middleware/coexistence.test.js` pins that.

Render bills in three buckets and the tracker measures all three under Render's
own names, so the dashboard can be read against the billing page without
translating:

| Render bucket | Scope | Means |
|---|---|---|
| HTTP Responses | `route` | bytes sent to browsers/apps, post-gzip |
| Websocket Responses | `socket` | socket.io packet bytes, split by event name |
| Service-Initiated | `outbound` | bytes **we** pull from Drive, googleapis, Firestore REST, biometric devices |

Beyond totals it records, per key: a log2 **histogram** of response size and of
latency (so p50/p95/p99 can be computed over any window at query time, and an
endpoint that is cheap 99 times and enormous once cannot hide behind its mean),
**peaks** merged with `$max`, the **status mix**, the **content-type mix**, and
**duplicate responses** — each JSON body is hashed and compared with the previous
response on the same route to the same class of caller, so "this endpoint
re-sent 6.2 GB the client already had" is measured rather than inferred from a
polling interval.

Read it at `GET /api/admin/bandwidth/{summary,routes,route,outbound,consumers,sockets,timeline,heatmap,insights,live}`
(behind `requirePlatformAdmin`), or in the CMS at **/ceo/dashboard/bandwidth**.
`?hours=` selects the window. Counters are folded into hourly `bandwidth_samples`
documents once a minute via `$inc`/`$max`, so a deploy loses at most one interval
and two instances add up rather than overwrite; rows expire after 90 days.

Percentiles are approximate — a log2 bucket knows a value only to within a
factor of two — and every surface that shows them says so. `maxBytes`/`maxMs`
are exact, and are what to reach for when the question is "how bad did it ever
get".

Four wiring constraints, all in the first 120 lines of `server.js`:

- `instrumentOutbound()` patches `http/https.request`, so it must run before any
  client library caches a reference to them. That module-level patch is what
  catches axios, gaxios, firebase-admin and bare `fetch` in one place, instead
  of four client-specific hooks that would each miss the other three.
- `mongoMeter()` registers a global mongoose plugin, and a plugin only applies to
  schemas compiled *after* it — `productionSyncService` compiles three a few
  lines below, so it cannot move down.
- `app.use(bw.middleware)` sits **above** `compression` and above `express.json`.
  Whichever wrapper is installed first ends up nearest the socket, so this
  ordering is what makes the meter see post-gzip bytes. It reads request size
  from `Content-Length` rather than counting chunks, deliberately: consuming the
  request stream above the body parser would silently truncate every POST.
- The `/api/admin/bandwidth` mount comes **before** the broader `/api/admin` one,
  or every request falls through `accessAdminRoutes` first and pays for a second
  `requirePlatformAdmin` database read.

MongoDB is the one thing not measured. The driver speaks raw TCP, so the https
hook is blind to it even though on Atlas it is real Service-Initiated egress —
document counts are exact, the bytes beside them are sampled and are labelled
"estimated" wherever they surface.

**This is observation only.** The tracker measures; it changes no response and no
route. The one behaviour change it makes available — gzip, which measurement
puts at ~90% off JSON — ships **disabled**, behind `BANDWIDTH_ENABLE_GZIP=1`, so
responses stay byte-for-byte what they are today until someone decides
otherwise. `compression` is in package.json but inert while that is unset.

`BANDWIDTH_LOG=1` prints one line per request. Leave it off in production.
`BANDWIDTH_TZ` (default `Asia/Kolkata`) sets the timezone the heatmap buckets by.

## Three auth systems

**`Middlewear/` (misspelled) holds the auth middlewares.** The correctly-spelled `middleware/` contains only the two bandwidth meters. Both directories exist; don't "fix" the typo without updating every import.

### 1. `/api/**` — JWT

`routes/login.js` probes each department Mongo collection in sequence (HR → project manager → sales → measurement → cutting master → accountant → packaging-dispatch → production-supervisor → QC → CEO → store), bcrypt-compares, then signs a JWT carrying `{ id, role, employeeId, userType, name, email }` into the `auth_token` HttpOnly cookie (7d) **and** returns it in the response body. It also returns `redirectTo`, derived from `user.role` — this map is the source of truth for the frontend's per-role routing:

```
hr_manager → /hr/dashboard          ceo → /ceo/dashboard
project_manager → /project-manager/dashboard
sales → /sales/dashboard            accountant → /accountant/
mpc-measurement, cutting_master, packaging_dispatch,
production_supervisor, quality_control, store_manager → their own dashboards
```

Per-audience middlewares: `EmployeeAuthMiddlewear.js`, `SalesAuthMiddlewear.js`, `CustomerAuthMiddleware.js`, `VendorAuthMiddleware.js`, `AllEmployeeAppMiddleware.js`.

The token is returned in the body (not cookie-only) on purpose: Chrome refuses to store cross-origin cookies for `localhost:3000` → `localhost:5000`, so the frontend stores it and sends `Authorization: Bearer`. `extractToken()` checks the header **before** cookies so the Bearer path always wins. Keep both paths working.

### 2. `/cowork/**` — Firebase ID token

`Middlewear/coworkAuth.js` verifies the Bearer ID token, resolves the employee from `cowork_employees` by `authUid` and falls back to `email`, caches the result in-process for 5 minutes, and sets:

```js
req.coworkUser = { authUid, employeeId, role, name, employeeData }
```

Roles are `ceo` | `tl` | `employee`. Guards: `verifyCeoToken`, `verifyCeoOrTL`, `verifyEmployeeToken`. A user holding the `ceo` custom claim with no Firestore doc is auto-provisioned as `E000`. Call `invalidateEmployeeCache(uid)` after mutating an employee's role or status, or the change won't take effect for up to 5 minutes.

The frontend's `lib/coworkAuth.js` mirrors this lookup order client-side — change one, change both.

### 3. `/api/accountant/**` — layered legacy ↔ org

Two middlewares that must coexist:

- `AccountantAuthMiddleware.js` — legacy. Accepts CMS-issued JWTs from `auth_token` / `token` / `jwt` cookies or Bearer, with its own cookie parser that works without `cookie-parser`. Honours `ACCOUNTANT_AUTH_BYPASS=true` as a **dev-only** bypass that injects a fake admin.
- `AccountantOrgAuthMiddleware.js` — the newer multi-tenant model: `organizationId` + roles `owner` / `approver` / `editor` / `viewer`, in the `accountant_token` cookie, with a `permissions` object attached to `req.user`.

A legacy token (no `organizationId`) hitting an accountant route triggers a `/sync-legacy` upgrade that mints an org token. Existing accountant routes import the legacy `accountantAuth` and were deliberately not rewritten.

Accountant models and routes are prefixed `Acc_` (`Acc_VoucherModels.js`, `Acc_reports.js`, …), renamed from an older `Tally*` / `Accountant*` scheme. `grav-cms/utils/README.md` in the frontend repo documents this module's design well but predates the rename — its filenames are stale, its behaviour description is not.

## Route and model organisation

`routes/` and `models/` share a shape. Mount prefixes:

```
/api/auth                 login.js
/api/hr/**, /hr/**        HrRoutes/
/api/employees, /api/employee/**   HrRoutes/Employee-Section, Employee_Routes/
/api/ceo/**               CEO_Routes/          (hr, production, qc, dispatch, cutting,
                                                inventory, accounting, merchandiser, overview, sop)
/api/cms/**               CMS_Routes/          (Inventory, Manufacturing, Sales, Store,
                                                Measurement, Configurations, pm)
/api/customer/**          Customer_Routes/
/api/vendor/**            Vendor_Routes/
/api/accountant/**        Accountant_Routes/   (~35 routers)
/api/barcode-devices      Barcode_Scanner_Device/
/cowork/**                task_routes/ + soproutes/
```

Several `/cowork` routers are factory functions taking `io` — e.g. `require("./routes/task_routes/audioRecording.routes")(io)`.

## Socket.IO

`io` is shared with routes via `app.set("io", io)` and `config/socketInstance.js`. Rooms:

- `workorder-<id>` — production sync (`join-workorder` / `leave-workorder`)
- `<employeeId>` — per-user room, joined via `join_cowork`; also broadcasts `workspace-member-status`
- `group_<groupId>`, `dm_<chatId>` where `chatId = [senderId, receiverId].sort().join("_")`
- `meeting_<meetId>` — late joiners are auto-sent `recording_started` from the in-memory `activeMeetingRecordings` map

That map is process-local, so recording state does not survive a restart or scale-out.

## Environment

`.env` is untracked. Required: `MONGODB_URI` (defaults to `mongodb://localhost:27017/grav_clothing`), `PORT` (5000), `JWT_SECRET`, `JWT_EXPIRE`, `NODE_ENV`, `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_DATABASE_URL` / `FIREBASE_STORAGE_BUCKET`, `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY` / `GOOGLE_DRIVE_FOLDER_ID` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`, `BREVO_API_KEY` / `ENABLE_EMAILS` / `CUSTOMER_SENDER_EMAIL`, `TEAMOFFICE_*` (biometric sync), `SALARY_ENCRYPTION_KEY`, `COWORK_FRONTEND_URL`, `PM_APPROVAL_FOR_MRF`.

Face biometrics adds `FACE_PYTHON`, `FACE_BIOMETRIC_ROOT`,
`FACE_BIOMETRIC_SERVICE_URL` and `FACE_ENGINE_KEY`, all explained in
`docs/face-biometric-deployment.md`. On GravServer the engine runs as its own
PM2 process on the **same host**, so the service URL this backend uses stays
loopback. The one that will bite you is `FACE_BIOMETRIC_ROOT`: it must point
OUTSIDE any app directory, or a deployment that replaces the working tree takes
the registration photos with it.

**One path is now public.** `POST /verify` is reachable from the internet
through the existing Cloudflare tunnel, on a hostname carried in
`FACE_PUBLIC_VERIFY_URL`, so a sign-in page can stream frames straight to the
engine instead of relaying every one through Express. That is the only path
routed: `/health` (which lists the enrolled gallery), `/register/*`, `/reset`
and `/reload` are refused at the edge and again by the engine.

It needs two more variables, and they are not interchangeable:

| Variable | Who holds it | Scope |
|---|---|---|
| `FACE_ENGINE_KEY` | this backend only, server to server | everything, no expiry |
| `FACE_BROWSER_TOKEN_SECRET` | signs tokens handed to browsers | `POST /verify`, 120 s, one session |

`FACE_ENGINE_KEY` must never reach a browser — not as `NEXT_PUBLIC_*`, not in
a response body, not in a log. `GET /hr/face-registration/verify-token` mints
the browser's token; the engine verifies it independently. `FACE_ALLOWED_ORIGINS`
(on the engine) is the exact CORS allow-list for that path — never `*`.

The engine still binds `127.0.0.1` only. The tunnel is the transport; nothing
is exposed on the network interface.

`NODE_ENV=production` flips cookies to `secure: true, sameSite: "none"` — cross-site auth silently breaks in production if it isn't set.

## Integrations

LiveKit (meetings, audio calls, `livekit-server-sdk` token minting), Gemini via `@google/genai` (meeting transcript summarisation, `askAI.routes.js`), Google Drive / Tasks / Workspace (service account + OAuth refresh token), Cloudinary (media), Brevo (transactional email), three push transports — FCM (`services/fcmPush.service.js`), web-push (`utils/sendWebPush.js`), Expo (`utils/sendExpoPush.js`), Tally Prime import (Excel/CSV/XML/JSON → vouchers, `services/tally*.service.js`), TeamOffice biometric attendance (`services/BiometricSyncService.js`), Setu account aggregator (`services/setuAA.service.js`).

## Domain notes

- **C1 / C2 / PMP** are employee scoring systems (`services/c1Service.js`, `services/pmpService.js`, `routes/task_routes/c1Routes.js`, `c2Band.routes.js`). Band thresholds live in Firestore `bandconfigs`, not in code — the interactive testers load config from Firestore at startup.
- **Timer-SOP** applies daily "bleach" penalties for SOP violations (`services/timerSop.service.js`), finalized by the ~00:15 IST cron. All SOP and attendance date logic is IST-based, computed as `Date.now() + 5.5h` and then read with `getUTC*` — follow that pattern rather than introducing a timezone library.
- **Salary fields are encrypted at rest** via `utils/salaryEncryption.js` keyed on `SALARY_ENCRYPTION_KEY`; rotating the key without re-encrypting orphans existing payroll records.

## PPC order targets — 24 Sep 2026

`PpcOrderTarget` (`ppc_order_targets`) is the piece-completion number PPC asks
a department for on ONE manufacturing order — per day, per hour (between two
clock times) or a total by a date, over working days. Against the whole order's
quantity, never a work order. One active target per order + department; a new
one marks the old `replaced`, nothing is deleted.

`services/ppc/orderTargets.evaluate.js` is the arithmetic (pure, tested):
expected vs done per day, today's figure (an hourly target's expectation grows
with the clock), short days/hours, the pace needed to recover, one sentence of
advice. `orderTargets.service.js` reads what each department actually DID from
that department's own book — cutting records, finishing scans, the production
mark-done ledger, passed QC inspections, `WorkOrder.packagingRecords`,
dispatch challans — so nothing is ever typed in. Routes:
`routes/CMS_Routes/PPC/orderTargetsRoute.js` (PPC doors need a PPC role +
company; `GET /targets/department/:dept` needs only a session and is what
every department overview shows). This is NOT the planning-file stage
schedule/publication chain; it sits beside it.

**IE department standards** (`IeDepartmentStandard`, `ie_department_standards`;
`services/industrialEngineering/departmentStandards.service.js`; routes on
`/api/cms/ie/department-standards`): per department, SAM minutes a piece,
operators, hours a day and planned efficiency → capacity a day. The evaluator's
`assessTarget` uses it for the PPC form's feasibility check (minimum working
days, over-capacity, generous dates, other commitments on the same dates) and
`efficiencyOf` for the overview's efficiency (earned = pieces × SAM, available
= operators × elapsed hours). The assessment is snapshotted onto the target at
save time. The per-style technical standard IE freezes into a release
(`processRoute.schema.js`) is a different, richer thing — do not merge them.

## PPC control center — 25 Sep 2026

PPC is the production control center: every production-management READ
(orders, work orders, bulk and person-wise, departments, hour by hour, day by
day, target vs achievement, efficiency, delays, eleven reports, search, the
assistant) lives in `services/ppc/control/` behind
`routes/CMS_Routes/PPC/controlRoute.js` (`/api/cms/ppc/control/*`, PPC
PLANNING_READ + company, read-only; writes stay on the targets router).

- `ledger.service.js` is the ONE read of "done": `woIndex(companyId)` (the
  company's order-linked work orders, via `packagingAccess.findWorkOrders`;
  a stored `WO-<24 hex>` number is shown as `WO-<last 8>` because that is the
  barcode form) and `readEvents(index, {start, end})` → per department
  `{at, qty, moId, woId, unit, personKey, personName, beyond}` from the same
  six books `orderTargets.service.doneEvents` reads. Two rules the department
  screens also follow: a unit is distinct PER WORK ORDER, and a unit numbered
  above the work order's quantity is `beyond` — counted apart, never as done.
  A production barcode is accepted in both printed forms (8 and 24 hex).
- `orders.service.js` is the normalised view: `snapshot()` (one read of the
  company), `summariseOrders`, `listOrders` (server-side filters), `orderDetail`
  (header → products → variants → work orders → per-department, targets, IE
  standard), `listWorkOrders`, `workOrderDetail`, `personWise` (each person's
  unit range on a WO, per department, from EmployeeProductionProgress + the
  ledger's units), `search`. The header resolves PO from
  `quotations[].poProof.poNumber`, delivery from `customerInfo.deliveryDeadline`
  and the type from `requestType === "measurement_conversion" || measurementId`.
  "Furthest stage" = last applicable department with activity; "earliest stage
  still short" = first applicable one below the quantity; a finishing stage is
  applicable only if it has events or a target on that order.
- `reports.service.js`: `hourly` (shift buckets; a per-day target is spread
  over its window, rounded on the cumulative line), `daily`, `departmentPage`,
  `range` (a precise date-time window), `achievement`, `efficiency` (IE
  standards), `delays` (furthest-behind stage, never a "cause"),
  `productVariant`, and `report(type)` for the catalogue `REPORTS`.
- `assistant/intents.js` (pure, tested) + `engine.js`: deterministic
  question → `{intent, entities}` → the services above → structured blocks.
  No model is called; a model later produces the same intent shape.

Parity (25 Sep 2026, live data): sewing, QC, packing and dispatch counts equal
the department portals' own endpoints for every order. Cutting is read from
`CuttingMasterRecord` entries, which agree with `WorkOrder.cuttingProgress` on
bulk orders and differ where the desktop sync or `update-cutting` wrote only
the work order — the work-order detail shows both.

The Production Manager portal folded into PPC the same day: its planning
pages moved under `/ppc/planning`, `/ppc/schedule`, `/ppc/requests`,
`/ppc/approvals`, `/ppc/settings`; `routes/login.js` and `deptAuth.js` now
send `project_manager` to `/ppc`. NOT changed, deliberately: the
`departmentWrites("project-manager")` gates on work orders, manufacturing
orders, production dashboard, schedule and closeout, `productionTargetAccess`,
and the `project-manager` `access_departments` row — re-homing those to the
`ppc` grant changes who may write and is the owner's call. The scanner floor
routers (`Production/Scanner/*`, assistant, targets) were re-mounted in
`server.js`: the merge `fdeea4a` had dropped the block and the whole
supervisor floor answered 404.

**Trimming and Ironing are always in the pipeline (26 Sep 2026).** `ledger.CORE`
now holds them beside cutting, sewing, QC, packaging and dispatch; only the
`OPTIONAL` stages (embroidery, printing, washing) wait for recorded work or a
target before an order counts them. Every `applicable` check in
`orders.service.js` reads `OPTIONAL`, so an order page, work-order detail and
person-wise view show Trimming and Ironing from the start instead of greyed.

## The customer's PO number — 26 Sep 2026

`services/customerRequestPo.js` is the ONE reader and writer. Sales files the PO
on the approved quotation (`quotations[].poProof`); a request with no quotation
(measurement conversion, internal order) now carries a root `poProof` — strict
mode silently dropped that write before the schema field existed. `poOf(mo)`
answers from whichever holds one; `PO_SELECT` is what a query must select.
Packaging's carton label, carton list, carton report and the dispatch overview
used to read the root only and printed "not recorded" for orders Sales HAD
filed. PPC records one with `POST /api/cms/ppc/targets/orders/:moId/po`
(PLANNING_WRITE; empty number clears), written where the upload writes.

## Finishing stages (Embroidery, Printing, Washing, Trimming, Ironing) and the shift clock — 24 Sep 2026

Embroidery is a finishing stage too (first in order), recording into
`finishingscans` like the rest. Its department row predates this and is not
re-seeded; its older routes (`routes/CMS_Routes/Manufacturing/Embroidery/`) are
still mounted for the design catalogue, but no page records pieces through them.

`routes/CMS_Routes/Manufacturing/Finishing/finishingRoutes.js` serves both
departments under `/api/cms/manufacturing/finishing/:stage/…`
(`services/manufacturing/finishingStages.js` names the stages). One model,
`FinishingScan` (`finishingscans` — one collection for both, the cluster is near
its 500-collection cap), unique on `{stage, workOrderId, unitNumber}`, so
`POST /:stage/done` is idempotent and safe to receive an offline queue's retry.
`doneAt` is the device's scan moment, bounds-checked (nothing from the future,
nothing older than 30 days → server time); `doneBy` is the session, never the
body. Access: `finishingAccess.js` — the stage's own DepartmentRole grant to
record; Production Supervisor / PM / CEO may read; work-order scoping is
Packaging's, reused (including the legacy-window stand-down).

`services/manufacturing/shiftHours.js` is the ONE definition of the factory's
hours (09:30–18:30 IST, nine buckets plus before/after). Packaging's `/hourly`
and the finishing `/overview` both bucket with it. Do not add another
hour-bucketing helper.

The departments are seeded by `ensureAccessDepartments.js` (slugs `printing`,
`washing`, `trimming`, `ironing`; no legacy collection). Adding a stage: add it
IN PRODUCTION ORDER to `finishingStages.js` (Find Piece walks that order), seed
it, mirror it in the CMS's `lib/finishing/stages.js`, and give it a glyph in
`components/finishing/DeptMark.js`. People reach them through a
DepartmentRole grant or an employee's department assignment.

## The physical store — racks, bins, location QR, put/transfer, 3D (25 Sep 2026)

An extension of Warehouse Stock V1, not a second inventory. `RawItem`
on-hand stays the only company truth; `LocationBalance` (guarded projection
+ the assigned-total sentinel) and the immutable `LocationMovement` ledger
say WHERE it sits; located + unallocated = on hand, always. Every existing
line started UNALLOCATED — the migration placed nothing.

- `Warehouse.locations[]` gained a structural `kind` (AREA ZONE AISLE RACK
  BAY LEVEL SHELF DRAWER BIN SLOT FLOOR — `LOCATION_KINDS`), `sequence`,
  `qrToken` (`LOC-` + 8 chars, no 0/O/1/I), `layout` (cm; x/z are the MIN
  CORNER in the PARENT's frame, rotation about it) and `capacity`; the
  warehouse gained `floorPlan` (size, walls, fixtures, `layoutVersion`).
  Racks/shelves/bins are `type: USABLE_STOCK` — reservation and put-away
  only accept that type — with `kind` telling them apart. A container kind
  (ZONE AISLE RACK BAY LEVEL) never holds stock; `holdsStockError` refuses it.
- `LocationMovement` gained `barcodeId`/`barcodeLabel`: the Product Marking
  sticker the stock moved under. Marking-grain balances are DERIVED from the
  ledger (`markingBalances`, `markingsAt`), never a second projection; the
  item-grain guards stay the atomic ones.
- `services/storePurchase/storeLocations.service.js` is the domain: scan
  parsing (`parseScan` — a `loc=` label vs an `itemid=` sticker; the client
  `storeLocations.mjs` mirrors it), addresses, the tree, world boxes,
  `rackPlan` (R04-L01-B01[-P01], ≤16 chars), `putStock` / `unassignStock` /
  `transferStock` (all through `locationStock.service`'s guards) and
  `assertMarkingAt`.
- `routes/CMS_Routes/Inventory/Operations/storeLocationRoutes.js` on
  `/api/cms/inventory/store-locations`: reads (dashboard, tree, resolve,
  location, find, item/marking positions, unallocated, put-away queue,
  reconciliation, movements, 8 reports) and writes (rack wizard = ONE
  structural `$push` under the structure version; layout save = ONE write
  under `floorPlan.layoutVersion`, never a movement; QR mint/backfill; `/put`,
  `/remove` (back to Unassigned), `/transfer`, `/transfer-all`). Writes use
  the full chain (capability → refuseLegacyWrite → withIdempotency →
  unitOfWork). New capability `LOCATION_OPERATE` (store editor+). A TAKE that
  CONSUMES is NOT here — it is `stock-adjustments /issue` (which now accepts
  an optional per-line `barcodeId` and guards the sticker's balance at that
  shelf) and MRF issue (item grain only, unchanged).
- **Saved layouts (30 Sep 2026)** — `services/storePurchase/savedLayouts.js`
  (pure; `savedLayouts.test.js`). A warehouse can hold several named layouts
  of the same store. The LIVE one stays in `floorPlan` + root
  `locations[].layout` (every reader unchanged) and `floorPlan.activeLayoutId`
  names it; the others are snapshots in `warehouse.layouts[]` (plan fields +
  root positions). `POST /warehouses/:id/layouts` starts a blank room (every
  root `placed: false`) and makes it live; `POST …/layouts/:lid/activate`
  swaps a saved one in; both are ONE write guarded by the layout AND
  structure versions and bump `layoutVersion`, so a builder open elsewhere
  gets the stale-version conflict instead of saving its old arrangement over
  the new one. `PATCH …/layouts/:lid` renames without bumping ("current" =
  the implicit layout of a warehouse that never had a second). A snapshot
  records `placed` as the map read it (only an explicit false is off), because
  a record older than the flag has none. `GET /tree` returns
  `warehouse.layouts`.
- The layout PUT (30 Sep 2026): `floorPlan.walls[].base` is where a wall
  starts above the floor (a beam over an opening), refused when not below its
  `height` (the top); a fixture's `facingDeg: null` stays null ("derive from
  the wall") instead of becoming 0 through `Number(null)`.
- `worldBoxOf` folds a child's offset into its parent's frame CLOCKWISE with
  z down (lx·cos − lz·sin, lx·sin + lz·cos), the SVG/plan convention the CMS's
  `worldBox` and the 3D room use. It was the mirror image until 25 Sep 2026,
  which drew every shelf of a turned rack beside its posts instead of inside.
- Two guards learned that version 0 also means "absent": a warehouse created
  before the location layer has no `structureVersion`/`floorPlan` on disk, and
  `structureVersion: 0` matched nothing (`versionGuard` in both routers).
  `usableLocationError` accepts a `companyId:null` warehouse while the
  TEMPORARY legacy read-through is on — reads already showed it, writes
  refused it.
- Migration: `scripts/migrations/store-location-qr-tokens.js` (dry run by
  default, `--apply` writes) mints tokens/kinds and the defaults. Tests:
  `storeLocations.service.test.js`, `storeLocationRoutes.test.js` (node:test,
  no DB).

## The customer's delivery deadline is mandatory — 26 Sep 2026

`customerInfo.deliveryDeadline` on the CustomerRequest is the one date every
department plans against (PPC targets and verdicts, the department queues'
due ordering). Half the orders on the board had none. `services/sales/
deliveryDeadlineGate.js` is now the one check on every door that turns a
request into production — quotation `sales-approve`, `approve-on-behalf`,
`mark-internal-order` and a sample style's `production/submit`: a date
handed in the body (`deliveryDeadline`, or `customerInfoOverride.
deliveryDeadline` on the on-behalf door) is recorded first; a request that
still has none is refused 400 with `code: "DELIVERY_DEADLINE_REQUIRED"`
before anything changes. The finishing `/:stage/orders` list now carries
`deliveryDeadline`; Packaging, QC, Production and Cutting already did.

An approved order reaches PPC and every department the moment
`createWorkOrdersAndProgress` creates its work orders inside the approval
— visibility everywhere is "has a work order of this company (or an unlinked
one while the legacy window is open)", never the request's own status.

## Issuing from a shelf — 26 Sep 2026

The canonical `POST /api/cms/inventory/stock-adjustments/issue` has taken an
optional per-line `warehouseId` + `locationId` (+ `barcodeId`) since
Warehouse Stock V1 and drops that shelf's balance in the same unit of work
— but no screen sent them, so a sticker scanned off a shelf left the shelf's
quantity untouched. The Store's Issue Stock drawer now finds the shelf
(`/markings/:barcodeId` for a scanned sticker, else
`/items/:id/locations` for the chosen variant), shows it on the line, lets
the person pick another or "not from a shelf", and sends it.

`locationStock.locationVariantFor` is the write-side twin of the routes'
`variantKeyOf`: stock put away before a variant was chosen sits at item
grain (`variantId: null`), which reads already attribute to a one-variant
item's lone variant — the location debit/credit now keys the same way, so
"R01-L01-B01 holds 20 of X" and "issue 1 of X from R01-L01-B01" agree.

## Cutting's work-order scope — 26 Sep 2026

`cuttingAccess.workOrderScope` now admits unlinked work orders
(`salesLineLink.companyId` null or absent) while
`tenantContext.legacyWindowOpen()` is true, exactly as Packaging's and
Finishing's scopes do. It admitted linked work only — the comment said
otherwise — and since 151 of 152 work orders carry no company link, the
Cutting queue listed one order while every other department listed thirteen.
`STORE_PURCHASE_STRICT_TENANCY=1` closes the window for all of them at once.

## Cutting seasons — 25 Sep 2026

`CuttingSeason` (`models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason.js`,
collection `cutting_seasons`) is the fabric a cutting master was given and the
pieces cut from it: `draft` (stickers scanned in) → `active` (Start froze the
list and opened one `Barcode.cuttingSessions` entry per sticker) → `closed`
(Close settled each session's `endQty`/`barcode.quantity` from the leftover
the person entered, blank = 0, and summarised pieces per work order with
photos). Stock consumption is still recorded on the sticker's own session, as
the old tracker did — the season only remembers which session it opened.
Routes: `routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingSeasonRoutes.js`
mounted inside `cuttingMasterRoutes` before the `:moId` routes
(`/seasons/*` and `/find-piece`, Cutting department guard + company). A piece
resolves against this company's work orders by short id exactly as the
finishing router does; a duplicate within a season is refused, one scanned in
another season is accepted with a warning. `/find-piece` answers the finishing
router's shape plus a leading `cutting` step.

**The cluster is at its 500-collection cap** (across all databases; this
database reports 409). Creating `cutting_seasons` failed with
"already using 500 collections of 500", so the empty, model-less orphan
`vehicles` collection was RENAMED to `cutting_seasons` (rename keeps the
count). Any further new collection needs a drop first — the owner's call.
Offline batches: `POST /seasons/:id/raw-items/batch` and `/pieces/batch` take
`{scans:[{code|barcode, at}]}` and answer every input by name (saved / already
/ invalid) with the device's `at` bounds-checked like the finishing scans;
`GET /seasons/ping` is what the device queue probes. Declared before
`/seasons/:id` so "ping" is never read as an id.

## Dispatch by carton scan — 25 Sep 2026

`routes/CMS_Routes/Manufacturing/Packaging/cartonDispatchRoutes.js` on
`/api/cms/manufacturing/carton-dispatch/manufacturing-orders/:id/{overview,resolve,dispatch}`
(Packaging access: readers read, the editor dispatches; company from
`packagingCompany`). The only way a piece leaves is inside a `PackingCarton`
whose label was scanned: `dispatch` takes `cartonNumbers[]` (+ optional
`notes`, `transport{vehicleNumber,driverName,driverPhone,transporter,lrNumber}`),
re-reads every carton INSIDE one transaction (this company, this order,
still `packed` — one that is not refuses the whole request), creates ONE
`DispatchChallan` (`source: "carton"`, `cartons[]` with each box's lines as
they were, `cartonCount`, `transport`; `persons`/`bulkProducts` still filled
from the same lines because the PPC ledger, order-target reader, closing
verdict and CEO dispatch view read them), marks each carton `dispatched`
(`dispatchChallanNumber`, `dispatchedBy`), bumps each work order's
`dispatchedQuantity` with a dispatchRecord naming `cartonNumbers` and
`challanNumber`, and marks person-wise progress docs dispatched. The challan
number is an atomic counter in `crm_sequences` (`dispatchChallan:<IST day>`),
seeded past the day's legacy count.

RETIRED (410 `USE_CARTON_DISPATCH`): `POST packaging-dispatch-view/dispatch/bulk`
and `/dispatch/person-wise`, `POST /dispatch-challans` (the free-form challan)
and `POST manufacturing/dispatch/bulk`. `POST manufacturing/dispatch/employee`
stays — the PPC person-wise tracking tab still calls it.

## Store & Purchase request cost — 26 Sep 2026

`tenantContext.resolveForActor` is cached per actor + requested company for
`STORE_TENANT_CACHE_MS` (default 60 000; 0 disables) and hands back a copy.
It was six or seven sequential Atlas reads on EVERY Store request, 300–400 ms
before the route's own query. A membership or capability change reaches an
open session within a minute; `invalidateActor(userId)` makes it immediate.
`storeLocations.service.markingBalancesMany` is one aggregate for many
stickers (the locator looped one query per sticker); the dashboard and
reconciliation rows read side by side.

## The PPC target calendar — 26 Sep 2026

`services/ppc/control/calendar.service.js` behind
`GET /api/cms/ppc/control/calendar?month=YYYY-MM`: one month, day by day.
For each day, every active target that covers it (`targetDays`), what it
asks (`expectedPerDay`), what was recorded inside its clock window
(`doneOn`, now exported from orderTargets.evaluate.js), per-department
load against IE's capacity (`capacityAt` of `standardsFor`), the day's
pressure (busiest department's asked ÷ capacity: light <60%, normal ≤100%,
heavy ≤120%, overloaded above; "unknown" when IE has set no standard) and
achievement (achieved ≥100%, on_track ≥85%, behind, missed, planned for a
future day), plus the orders whose delivery deadline falls that day. Month
totals, per-department totals and `orders` (the active orders, for the day
drawer's target picker — 27 Sep 2026) ride along. It reads the same
`orders.snapshot` the rest of the control center reads.

## IE may write the floor — 27 Sep 2026

`ieOrDepartmentWrites(inner)` in server.js wraps the mount-level write gates
of `/api/cms/production/dashboard` (was `pmWrites`) and
`/api/cms/production/canvas-layout` (was `productionSupervisorWrites`):
reads pass to the inner gate untouched; a write by an IE editor (or owner /
approver — `departmentRoles.getEffectiveRole("ie")`) commits directly, as on
IE's own routes; while IE has no roles configured, a session whose
`deptSlug` is `ie` counts (the same fail-open rule every department guard
applies to itself); everyone else goes through the original department gate
and its approval queue. `departmentWriteGuard` exports `seedIdentity` for
it, because the wrapper runs before the router's own auth. The machine
register (`/api/cms/machines`) and the registered-operations routes need
only a session and were never department-gated.

## PPC targets: rules, the day board, speed — 27 Sep 2026

**What a target may ask** — `orderTargets.service.checkTarget(companyId, moId,
body)` is the ONE check, used by `previewTarget` (the form, before saving)
and `setTarget` (the save). ERRORS block and a refused save writes nothing
(409, `errors[]` + `facts` in the body): the department already finished
the order; the target asks for more than the department has LEFT
(order quantity − what it has recorded, read from the same ledger the
pipeline shows); the first date is before today or the last date has
passed. WARNINGS are shown and allowed: ends after the delivery date or the
order has none; replaces the department's current target; leaves pieces
with no target; IE's capacity / busy warnings. `previewTarget` now answers
`{ok, errors, warnings, facts: {orderQuantity, done, left, asked, …}}`.
Target sentences print dates as "3 Oct 2026" (`dayWords` in the evaluator).

**Reads** — `services/ppc/control/targetBoard.service.js`:
`GET /api/cms/ppc/control/targets` (every target, one plain `state`:
upcoming | on_track | behind | done | missed | stopped, with `say`, asked /
done / left, from / to, delivery) and `GET /control/day?date=` (the PPC
overview's day: running targets by department, starting soon, ending soon,
just ended, active orders with no target, deliveries due; a future day is
judged by TODAY's standing). `GET /targets/department/:dept` also returns
`upcoming` (targets starting in the next 14 days) — the department panels
show them — and reads its orders side by side.

**Speed** — `orders.snapshot` is shared: identical concurrent calls wait on
one computation and a result is reused for `PPC_SNAPSHOT_CACHE_MS` (20 s; 0
disables). Target, cancel and PO writes call `invalidateSnapshots`. One
page used to fire the orders read four times at once, each rebuilding the
whole company (1–3 s each); warm reads are now ~0.2 s. The snapshot is
SHARED: never mutate it. `orderDetail` reads the ten departments' books
side by side.

## The Store keeps no company or budget gate — 29 Sep 2026 (owner's request)

The owner asked for the company and budget concepts to leave the Store
side: they refused real work ("That supplier was not found in this
company" on every item save, because not one supplier in this database
carries a company) and nagged every item ("Need budget mapping 307"). The
tenancy layer is NOT torn out — it stays for the day the data is
company-stamped — but while `STORE_PURCHASE_STRICT_TENANCY` is unset:
`supplierScope` (rawItemPayload.service) admits legacy suppliers,
conversion targets resolve against the whole unit list, and
`tenantContext.ownedOnly()` is `{}` (the choice its old comment deferred to
the owner). `materialSetup` no longer counts budget at all unless
`STORE_BUDGET_SETUP=1`: `budgetUnmapped` is always false,
`needBudgetMapping` 0, `budgetAvailable` true, so "needs setup" means
category, intended use or base unit only. The budget-head resolver and the
requests desk's budget review are untouched.

## Receiving: a label printed elsewhere, scanned into the count — 30 Sep 2026

`POST /api/cms/inventory/operations/purchase-orders/:id/labels/adopt`
`{ barcodeId, lineId? }` → `receivingSession.adoptLabel`. The Material labels
screen prints raw-item stickers with no receipt behind them (identityState
ACTIVATED, no session, no GRN); a delivery often arrives with those already
on the goods. The receiver scans one on the receiving screen and it is taken
INTO the matching line's count: the line is found by the label's `rawItem`
and `variantId` (a no-variant label on a one-variant line matches; `lineId`
narrows it; the first line with something outstanding wins), the line's
count is opened or resumed (`COUNT_AND_LABEL`; a count with no tracking
level is set to PACKAGE with the reason on record), the label becomes
APPLIED with `quantityMeasured: true`, its own `quantity`, the next
`sessionSequence`, this PO / line / vendor / unit price and the company
stamped on it, and `adoptedAt` set. From there it is an ordinary counted
label: its quantity is in the line's received figure, and recording the
receipt activates it and stamps the GRN (`activateForReceipt`, unchanged).
Refused with the reason: a voided label, one with a `goodsReceiptId`, one
in any count (this order's or another's), a material or variant not on the
order, a fully received line, a unit that differs from the line's, an
INDIVIDUAL count for a label whose quantity is not 1, a second label on a
LOT count, a TOTAL_ONLY line. **`adoptedAt` is what `cancel` and `undoLast`
read**: an adopted label is RELEASED (back to ACTIVATED, detached from the
count, `adoptedAt` cleared) rather than voided or sent to PRINTED, because
it existed before the count. `labelView` carries `adopted`. Smoke-tested on
PO26094229 (label 6aaa2c29ab80cd1e40036a76, 11 Pcs): adopted → counted →
second scan refused → count cancelled → label back to ACTIVATED.

### …and neither does the Requests desk — 30 Sep 2026

The same switch now decides whether a REQUEST carries a budget head at all.
`services/requests/budgetGate.js` (`budgetEnabled()` =
`STORE_BUDGET_SETUP === "1"`) is read by `intakeRequests.js`,
`spendRequests.js` and `spendFinanceDecision.service.js`. Off (the
default): `GET /api/requests/intake/me` answers `budgetEnabled: false` and
`GET …/budget-heads` answers `enabled: false, heads: []` (not "no approved
heads"); the create route neither requires nor resolves `ledgerId` (a
posted one is ignored, `headPatch` carries no ledger, plan row or
snapshot); the approver's route does not refuse a request with no head;
`readyToClassify` gets `hasApprovedHead: true`; the spend conversion makes
the spend request with `ledger: null`, which `spendRequestCreate.matchBudget`
already records as an unbudgeted one (`budgetMatchStatus` none), so finance
still sees and approves it; the purchase door (`POST /api/requests/spend`)
accepts no `ledgerId`; and at the finance decision a service master's
suggested head cannot turn a head-less request into a
`SUGGESTED_HEAD_UNAVAILABLE` refusal — the lines are recorded unbudgeted.
Requests raised while budget was on keep their head. Smoke-tested 30 Sep
2026: a SERVICE request with no head was accepted (`budgetHead: null`) and
deleted again.

## Raw items: product type, and the list read once — 30 Sep 2026

`RawItem.productType` exists now. The item form had offered "Product
Type" since the start and the list filtered on it, but the field was never
on the schema, so every save dropped it and the edit form came back
empty. Create (rawItemCreation.service) and `PUT /:id` persist it.

`GET /api/cms/raw-items` read every item IN FULL (variants, aliases,
people populated) to page twenty in memory, then read them all again for
the figures — 1–4 s a request. It now makes ONE light read (name, code,
classification, unit, quantities) to filter, count and page, reads only
the page's rows in full, reuses the light rows for the catalogue figures
when nothing narrowed the list, and reads the unit map beside them. Warm:
~0.45 s for 20 rows, the same for 40. Budget is no longer computed here.

## Raw items: the trash, and variant renames — 29 Sep 2026

`RawItem` has a TRASH instead of a delete: `DELETE /api/cms/raw-items/:id`
sets `deletedAt` / `deletedBy` / `deletedByName` (the same refusals as
before — an item a PO, request, return, movement or balance still names is
not removed either way); `GET /raw-items/trash` lists them, `POST
/raw-items/:id/restore` puts one back (409 `SKU_IN_USE` if its code was
reused meanwhile), `DELETE /raw-items/:id/permanent` destroys a trashed
one. Query middleware on the schema (`find`, `findOne`, `findOneAndUpdate`,
`countDocuments`, `updateOne/Many`, `distinct`, `aggregate`) adds
`deletedAt: null` to EVERY read unless the query sets the option
`withDeleted: true` (an aggregate: in its options), so to the rest of the
system a trashed item is gone — pickers, stock views, the code's
uniqueness — until restored. The routes are declared before `/:id`.

Renaming an attribute VALUE on the edit form used to be refused as a
variant removal (rows are regenerated by exact combination). The CMS form
now carries the rename into the variants built from that value before
regenerating, so the row keeps its `_id` and `PUT /:id` (which matches by
id first) updates the combination in place with stock, aliases and
conversions intact.

## QC raw item checking — 28 Sep 2026

QC's SECOND book, for the raw material a job-work customer sends, kept
entirely apart from the per-piece product inspection:
`routes/CMS_Routes/Manufacturing/QC/qcRawItemRoutes.js` on
`/api/cms/manufacturing/qc/raw-items` (mounted above the inspection
router, auth inside), `QCRawItemInspection` (one record per STICKER checked
against ONE order: quantity, passedQuantity, defectiveQuantity, defects[],
checker; a re-check supersedes the earlier record) and `QCRawItemSetting`
(kind "defect" = the rejection reasons, kind "checker" = who may check, by
email; the QC owner always may). Nothing in the product check reads these,
and this reads nothing of the product check's.

Flow: the checker picks the ORDER first (`GET /orders`, every live order,
job-work first — `fulfilmentModel === "JOB_WORK"` on the order or any line),
`POST /lookup {code, moId}` reads the Store's `itemid=<24 hex>` sticker
(name, variant, quantity, unit from the Barcode) and reports a prior verdict
on this order or another, `POST /save` records passed (whole quantity) or
defective (reasons from the setup, a defective quantity ≤ the sticker's,
the rest passes; 409 `ALREADY_CHECKED` unless `recheck`).
`GET /orders/:moId` answers raw item by raw item. "To check" (`expected`,
`expectedFrom`) is what the Store RECEIVED for the order — `CustomerMaterialLot`
by `orderRef` (the request id or MO number) or a movement on this MO — when
any lot was recorded, else what the work orders' `rawMaterials` REQUIRE (the
same source the Store's requirement reads); checked / passed / defective /
remaining come from the standing records, plus by-defect, by-checker and
every record. The lot model exports `{ CustomerMaterialLot }` — a bare
require of it is not a model, and the first version crashed the detail on
exactly that. `GET /my-day?date=` is the
checker's day on the shift clock (`shiftHours` buckets; the owner may pass
`email=` or `all`); `GET /report?from&to` the owner's range.

**29 Sep 2026.** A checker row carries `productCheck` (default true): the
owner unticks it on Raw item setup (`PATCH /checkers/:id`) to keep a raw
item checker OFF the product piece station; `/config` answers `me.productCheck`
and the CMS shell hides Inspect piece on false (the station also refuses in
words). `dayShape` groups each order's records into `byOrder[].items[]`, ONE
row per raw item + variant whatever the number of labels ("12 + 10 = 22");
the flat `recent` list stays for the rail. The word "sticker" is gone from
every message ("raw item" / "label"); the JSON keys (`stickers`, the
`NOT_A_STICKER` code) are unchanged. In qcRoutes.js,
`computeWorkOrderQcStats` reads the inspections ONCE with the fields
`buildPieceProgress` needs (it read 2 300 rows twice, ~3 s) and caches the
result for `QC_ORDERS_CACHE_MS` (15 s; 0 disables).

**Job work only, and the GRN — never the bill of material (29 Sep 2026).**
`GET /orders` lists only the orders Sales marked JOB_WORK on the PI/order
line (plus any order that already has checks, so records are never
orphaned); scopes `jobwork` (default) | `checked`. `GET /orders/:moId`
frames each raw item with two figures: ASKED = the ISSUED
`CustomerMaterialExpectation` for the order (`orderRef` = the request id;
Merchandising's material request to the customer, latest revision) and
RECEIVED = the Store's CUSTOMER_MATERIAL `GoodsReceipt` lines against the
order (`customerMaterial.orderRef`, base quantity; the ownership lots are
the fallback when no receipt names the order). "To check" IS received;
remaining = received − checked; `shortOfAsked` = asked − received; state
`awaiting` = asked but nothing received. Company purchase orders carry no
order link (`sourceMrfId` only) and are not read. `GET /report` now takes
`moId` (one order, all time) and `email`, and answers `days[]` (each day's
shift-hour buckets, totals and byOrder), `records` (≤5000) beside byDay /
byChecker / byOrder / byRawItem / byDefect — the CMS builds the Excel
from it (`lib/reports/rawItemQcWorkbook.js`).

**Two collections came from renaming empty, unreferenced orphans** (the
cluster is at its 500-collection cap): `trips` → `qc_raw_item_inspections`,
`helpers` → `qc_raw_item_settings`. A rename keeps the old indexes — the
first save failed on an inherited unique `tripNumber_1` — so every
inherited index was dropped and the models' own built (`syncIndexes`). Do
the same for any future rename.
## MRF budget & Finance review is PAUSED — 30 Sep 2026

**`RequestsSettings.mrfBudgetEnabled` is `false` in the live database.** MRF
purchasing currently runs with no Finance review and no budget commitment.

One document holds it: collection `requestssettings`, `{ key: "requests" }`,
model `models/CMS_Models/Configurations/RequestsSettings.js`. Not an env var,
not a constant, not a commented-out branch. It is read fresh on every request
(no cache) in `mrfRoutes.js`'s `/:id/budget-head` and `/:id/fulfilment-decision`,
so a change takes effect on the next request with no restart.

While paused, an MRF that needs buying spins off a SpendRequest at `approved`
instead of `pending_finance`, stamped `budgetApprovalMode: "BUDGET_PAUSED"` —
which is what lets `governedPurchaseOrder.service.js` waive the commitment
check for it. Everything that is not budget still applies: TL approval, the
issue-or-buy decision, supplier, rate, tax, quantities, tenancy, and the PO's
proof of its source MRF, lines, quantities and totals.

**To restore: set `mrfBudgetEnabled` back to `true`.** That is the whole action
— the CEO settings screen, `PUT /api/cms/requests/settings`, or
`node -r dotenv/config scripts/migrations/pause-mrf-budget.js --restore --apply`.
**No code was deleted, disabled or stubbed, so nothing has to be recovered.**

Two things that are load-bearing and easy to get wrong:

- **It only decides the NEXT request.** `budgetApprovalMode` is stamped at
  creation, so flipping the switch cannot rewrite what an existing request was
  approved under, and anything at `pending_finance` stays there. There were 0
  such requests when it was paused; if there ever are, they are a separate
  decision.
- **Do not backfill `budgetApprovalMode`.** It has no default on purpose. An
  absent marker means "raised before the field existed", and
  `governedPurchaseOrder.service.js` fails closed on it and demands a
  commitment. Only an explicit `BUDGET_PAUSED` waives that.

Full note: `docs/decisions/mrf-budget-paused.md`. Both paths are covered by
`test/requests/store-fulfilment.route.test.js`.

## The Purchase workspace lists purchasing records only — 30 Sep 2026

`GET /purchase-orders/workspace` no longer returns `recordType: "need"` rows,
and `summarise()` no longer returns `needCount`. An approved SpendRequest is a
PRE-purchase record: nobody has ordered anything, so a row reading "Approved,
not yet ordered" in a table of purchase orders described a document that did
not exist, and a buyer could not tell it from one that did.

Removed from `services/storePurchase/purchaseWorkspace.service.js`:
`readApprovedNeeds()`, `needRow()`, `RECORD.NEED`, `NEED_STATUS`, `NEED_TYPE`,
`ACTION.RAISE_ORDER`, the `needCount` summary field and the `approvedNeeds`
source entry. On the frontend the matching labels, row branches, detail fields
and the "Approved needs" summary item went from
`components/store/purchase-workspace/workspace.mjs` and the Purchase page.

**Nothing about the governed chain changed, and no MRF or SpendRequest was
touched.** The buying balance still lives in Store › Requests; the approved
request's own page still carries **Create purchase order**
(`/store/dashboard/order-requests/quote/:id` →
`POST /api/requests/spend/:id/purchase-order`), which is the same governed flow
the removed row merely linked to. `/purchase-orders/source-mrfs` and its
`/provenance` endpoint, `governedPurchaseOrder.service.js` and the New Purchase
Order form's MRF selector are all unchanged. A record appears in the Purchase
workspace once an actual purchase order exists.
