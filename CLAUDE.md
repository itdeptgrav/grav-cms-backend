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
