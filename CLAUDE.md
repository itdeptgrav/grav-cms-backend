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

`NODE_ENV=production` flips cookies to `secure: true, sameSite: "none"` — cross-site auth silently breaks in production if it isn't set.

## Integrations

LiveKit (meetings, audio calls, `livekit-server-sdk` token minting), Gemini via `@google/genai` (meeting transcript summarisation, `askAI.routes.js`), Google Drive / Tasks / Workspace (service account + OAuth refresh token), Cloudinary (media), Brevo (transactional email), three push transports — FCM (`services/fcmPush.service.js`), web-push (`utils/sendWebPush.js`), Expo (`utils/sendExpoPush.js`), Tally Prime import (Excel/CSV/XML/JSON → vouchers, `services/tally*.service.js`), TeamOffice biometric attendance (`services/BiometricSyncService.js`), Setu account aggregator (`services/setuAA.service.js`).

## Domain notes

- **C1 / C2 / PMP** are employee scoring systems (`services/c1Service.js`, `services/pmpService.js`, `routes/task_routes/c1Routes.js`, `c2Band.routes.js`). Band thresholds live in Firestore `bandconfigs`, not in code — the interactive testers load config from Firestore at startup.
- **Timer-SOP** applies daily "bleach" penalties for SOP violations (`services/timerSop.service.js`), finalized by the ~00:15 IST cron. All SOP and attendance date logic is IST-based, computed as `Date.now() + 5.5h` and then read with `getUTC*` — follow that pattern rather than introducing a timezone library.
- **Salary fields are encrypted at rest** via `utils/salaryEncryption.js` keyed on `SALARY_ENCRYPTION_KEY`; rotating the key without re-encrypting orphans existing payroll records.
