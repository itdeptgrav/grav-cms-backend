// test/project-manager/pm-access-boundary.route.test.js
//
// Project Manager professionalisation — Chunk 2. The access boundary.
//
// WHAT THIS COVERS
// ----------------
// The two production routers the Project Manager dashboard reads that were
// reachable with no session at all, and the one Project-Manager-owned mutation
// on the shared manufacturing-order router.
//
// The real middleware chain is mounted exactly as server.js mounts it —
// `departmentWrites` outside, the router's own `EmployeeAuthMiddleware` inside
// — against the in-memory Mongo from test/setup.js. Nothing is stubbed: the
// guard whose behaviour these tests exist to prove is the guard that runs.
//
// WHY THE MOUNTS ARE COPIED RATHER THAN IMPORTED
// ----------------------------------------------
// server.js is ~2300 lines of wiring that connects Mongo, Firestore, Socket.IO
// and two cron timers on require. It cannot be loaded in a test. The mounts
// below are transcribed from it line by line, with the server.js line numbers
// beside each, so a divergence is visible in review rather than silent.
//
// A NOTE ON THE ROLE MODEL
// ------------------------
// `requireDepartmentRole` and `requireApproval` both FAIL OPEN for a department
// with no roles configured — a deliberate migration decision documented in
// services/departmentRoles.js. Several tests below assert that open behaviour
// on purpose. It is the current contract, not an oversight, and a test that
// pinned the opposite would be pinning a change nobody has approved.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
/* Pinned BEFORE config/jwt is required, so the guard's seedIdentity and the
   router's EmployeeAuthMiddleware resolve the same secret. They agree anyway —
   this value is on config/jwt's LEGACY_SECRETS list — but relying on the legacy
   fallback would make these tests pass for the wrong reason. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const departmentWrites = require("../../Middlewear/departmentWriteGuard");
const { decideChangeRequest, REPLAY_HEADER } = require("../../services/changeRequests");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const ChangeRequest = require("../../models/Access/ChangeRequest");
const ChangeLog = require("../../models/Access/ChangeLog");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Vendor = require("../../models/Vendor_Models/vendor");

/* The same value config/jwt resolves, because JWT_SECRET is pinned above
   before that module loads. Tokens signed here therefore verify in both the
   guard and the router, and a replay claim minted here is indistinguishable
   from one services/changeRequests would mint. */
const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  const pmWrites = (entity, extra = {}) =>
    departmentWrites("project-manager", { entity, ...extra });
  const productionSupervisorWrites = (entity, extra = {}) =>
    departmentWrites("production-supervisor", { entity, ...extra });

  // server.js:1631
  app.use(
    "/api/cms/production/dashboard",
    pmWrites("production dashboard"),
    require("../../routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes"),
  );
  // server.js:1648
  app.use(
    "/api/cms/production/canvas-layout",
    productionSupervisorWrites("machine layout"),
    require("../../routes/CMS_Routes/Production/Dashboard/canvasLayoutRoutes.js"),
  );
  // server.js:1528-1532 — no department guard, by design: cutting, QC,
  // packaging and the production supervisor all write through this prefix.
  app.use(
    "/api/cms/manufacturing/manufacturing-orders",
    require("../../routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes"),
  );

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  /* So decideChangeRequest's loopback replay lands on THIS app rather than a
     real server on :5000. That is what lets the approval path below be the
     genuine one — approver decides, the service mints its own token and calls
     back in — instead of a hand-built imitation of it. */
  process.env.INTERNAL_API_ORIGIN = base;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", token, body, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
  }));

/* ── Identities ─────────────────────────────────────────────────────────── */

/**
 * A CMS session. `role` is the legacy token role from routes/login.js; `grant`
 * is the DepartmentRole this person also holds, which is the thing the guards
 * actually read. The two are independent on purpose — that gap is the legacy
 * ProjectManager question this chunk documents.
 */
async function person({
  role = "employee",
  grant = null,
  grantRole = "editor",
  slug = "project-manager",
  isAdmin = false,
} = {}) {
  const n = ++seq;
  const email = `pm${n}@test.example`;
  if (grant) {
    await DepartmentRole.create({
      departmentSlug: slug, email, role: grantRole, isActive: true, name: `P${n}`,
    });
  }
  return {
    email,
    token: jwt.sign(
      {
        id: String(new mongoose.Types.ObjectId()),
        email, name: `P${n}`, role, employeeId: `E${n}`,
        ...(isAdmin ? { isAdmin: true } : {}),
      },
      SECRET,
      { expiresIn: "10m" },
    ),
  };
}

const expiredToken = () =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "project_manager" }, SECRET, {
    expiresIn: -10,
  });

/** Somebody must hold a role or the department counts as "not configured". */
const configureDepartment = (slug = "project-manager") =>
  DepartmentRole.create({
    departmentSlug: slug, email: `owner${++seq}@test.example`, role: "owner", isActive: true,
  });

/* ══ 1 · PRODUCTION DASHBOARD — AUTHENTICATION ═════════════════════════════
 *
 * productionDashboardRoutes.js requires EmployeeAuthMiddleware on line 5 and
 * never installs it. The outer pmWrites mount lets every GET straight through,
 * so before this chunk each of these answered 200 to a caller with no session.
 */

const DASHBOARD_READS = [
  "/api/cms/production/dashboard/operations",
  "/api/cms/production/dashboard/machine-status",
  "/api/cms/production/dashboard/current-production",
  "/api/cms/production/dashboard/all-machines",
  "/api/cms/production/dashboard/employees-today",
  "/api/cms/production/dashboard/find-piece?barcode=WO-abcdef12-001",
];

describe("production dashboard — authentication", () => {
  for (const path of DASHBOARD_READS) {
    test(`anonymous is refused: GET ${path.split("?")[0]}`, async () => {
      const res = await call(path);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  }

  test("a junk token is refused", async () => {
    const res = await call("/api/cms/production/dashboard/all-machines", { token: "not-a-jwt" });
    expect(res.status).toBe(401);
  });

  test("an expired session is refused", async () => {
    const res = await call("/api/cms/production/dashboard/all-machines", { token: expiredToken() });
    expect(res.status).toBe(401);
  });

  test("the POST cache-refresh is refused anonymously too", async () => {
    // This one is a POST, but "/refresh" is on departmentWriteGuard's
    // READ_SHAPED list, so the write guard waves it through without asking for
    // a role. Its only protection is the router's own authentication.
    const res = await call("/api/cms/production/dashboard/operations/refresh-cache", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("an authenticated ordinary employee still reaches the handler", async () => {
    // The fix must not turn a read the Production Supervisor's tracker depends
    // on into a Project-Manager-only read. No department role is granted here.
    const p = await person({ role: "production_supervisor" });
    const res = await call("/api/cms/production/dashboard/all-machines", { token: p.token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("a legacy ProjectManager session still reaches the handler", async () => {
    const p = await person({ role: "project_manager" });
    const res = await call("/api/cms/production/dashboard/operations", { token: p.token });
    expect(res.status).toBe(200);
  });

  test("authentication does not become a department gate", async () => {
    // Production roles configured, and this reader holds none of them. A read
    // must still succeed: departmentWrites never touches GET, and the fix adds
    // authentication only.
    await configureDepartment("project-manager");
    const stranger = await person({ role: "employee" });
    const res = await call("/api/cms/production/dashboard/employees-today", {
      token: stranger.token,
    });
    expect(res.status).toBe(200);
  });
});

/* ══ 2 · CANVAS LAYOUT — AUTHENTICATION ════════════════════════════════════
 *
 * The same defect, one folder over, and worse: this router has a POST and a
 * DELETE. departmentWrites passes an anonymous caller through deliberately
 * ("let the router's own auth middleware refuse it" — departmentWriteGuard.js),
 * and this router had none to do it, so the machine layout could be rewritten
 * or deleted with no session.
 */

describe("canvas layout — authentication", () => {
  test("anonymous GET is refused", async () => {
    const res = await call("/api/cms/production/canvas-layout");
    expect(res.status).toBe(401);
  });

  test("anonymous POST cannot rewrite the machine layout", async () => {
    const res = await call("/api/cms/production/canvas-layout", {
      method: "POST",
      body: { machinePositions: [{ machineId: String(new mongoose.Types.ObjectId()), x: 1, y: 1 }], orgId: "default" },
    });
    expect(res.status).toBe(401);
  });

  test("anonymous DELETE cannot drop the machine layout", async () => {
    const res = await call("/api/cms/production/canvas-layout", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("an expired session is refused", async () => {
    const res = await call("/api/cms/production/canvas-layout", { token: expiredToken() });
    expect(res.status).toBe(401);
  });

  test("the production supervisor's own save still works", async () => {
    // The layout belongs to the Production Supervisor's floor. Authentication
    // must not hand it to Project Manager, and with no production-supervisor
    // roles configured the write guard still fails open, as it does today.
    const ps = await person({ role: "production_supervisor" });
    const res = await call("/api/cms/production/canvas-layout", {
      method: "POST",
      token: ps.token,
      body: { machinePositions: [{ machineId: String(new mongoose.Types.ObjectId()), x: 2, y: 2 }], orgId: "default" },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("a Project Manager can still read it", async () => {
    const pm = await person({ role: "project_manager" });
    const res = await call("/api/cms/production/canvas-layout", { token: pm.token });
    expect(res.status).toBe(200);
  });
});

/* ══ 3 · SHARE-TO-VENDOR — THE ONE PM-OWNED MUTATION GUARDED HERE ══════════
 *
 * Forwarding work orders to an outside vendor is a Project Manager decision,
 * is called only from the PM manufacturing-order detail page, and — uniquely
 * among the planning mutations — is a single idempotent `updateMany` with a
 * status filter. That combination is what makes it safe to put behind the
 * existing held-change queue; the allocation and planning routes are not, and
 * are deliberately left alone (see the audit).
 */

async function forwardable() {
  const n = ++seq;
  const vendor = await Vendor.create({
    name: `Vendor ${n}`, vendorCode: `V${n}`, status: "active", isDeleted: false,
    contactPerson: `Contact ${n}`, phone: `900000${n}`, password: "x".repeat(12),
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-SV-${n}`, quantity: 5, status: "pending",
  });
  return { vendor, wo };
}

/**
 * The log entry the ROUTE wrote, as opposed to the submission and decision
 * entries services/changeRequests writes under the same entity name. Selected
 * by the route's own summary wording rather than by "the first one", which
 * silently picks the submission once approval is involved.
 */
const forwardingLog = () =>
  ChangeLog.findOne({ entity: "vendor forwarding", summary: /^Forwarded/ }).lean();

/** A real ObjectId — ChangeLog casts actorId, so a label breaks the entry. */
const approverActor = (email) => ({
  id: String(new mongoose.Types.ObjectId()),
  email,
  name: "Approver",
});

const shareToVendor = (token, { vendor, wo }, extra = {}) =>
  call("/api/cms/manufacturing/manufacturing-orders/share-to-vendor", {
    method: "POST",
    token,
    body: { workOrderIds: [String(wo._id)], vendorId: String(vendor._id) },
    ...extra,
  });

describe("share-to-vendor — authentication", () => {
  test("anonymous is refused", async () => {
    const f = await forwardable();
    const res = await call("/api/cms/manufacturing/manufacturing-orders/share-to-vendor", {
      method: "POST",
      body: { workOrderIds: [String(f.wo._id)], vendorId: String(f.vendor._id) },
    });
    expect(res.status).toBe(401);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("a junk token is refused", async () => {
    const f = await forwardable();
    const res = await shareToVendor("not-a-jwt", f);
    expect(res.status).toBe(401);
  });

  test("an expired session is refused", async () => {
    const f = await forwardable();
    const res = await shareToVendor(expiredToken(), f);
    expect(res.status).toBe(401);
  });
});

describe("share-to-vendor — department authorisation", () => {
  test("with NO production roles configured, an ordinary session still writes", async () => {
    // The migration contract: mounting a guard changes nothing until an
    // administrator grants the first role. Pinned so a future change to that
    // rule has to be deliberate.
    const p = await person({ role: "project_manager" });
    const f = await forwardable();
    const res = await shareToVendor(p.token, f);

    expect(res.status).toBe(200);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
  });

  test("a viewer is refused once roles exist", async () => {
    await configureDepartment();
    const viewer = await person({ grant: true, grantRole: "viewer" });
    const f = await forwardable();
    const res = await shareToVendor(viewer.token, f);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("somebody with no role in the department is refused once roles exist", async () => {
    await configureDepartment();
    const stranger = await person({ role: "employee" });
    const f = await forwardable();
    const res = await shareToVendor(stranger.token, f);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_DEPARTMENT_ROLE");
  });

  test("an editor's forward is HELD at 202, not applied", async () => {
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();
    const res = await shareToVendor(editor.token, f);

    expect(res.status).toBe(202);
    expect(res.body.held).toBe(true);
    expect(res.body.code).toBe("PENDING_APPROVAL");
    // The decision has NOT happened — this is the whole point of 202.
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");

    const cr = await ChangeRequest.findOne({ departmentSlug: "project-manager" }).lean();
    expect(cr).toBeTruthy();
    expect(cr.status).toBe("pending");
    expect(cr.intent.path).toContain("/share-to-vendor");
    // The queue must carry enough to replay it, and no more.
    expect(cr.intent.body.vendorId).toBe(String(f.vendor._id));
    expect(JSON.stringify(cr)).not.toContain(editor.token);
  });

  test("an approver's real decision applies the held change", async () => {
    // The genuine path, end to end: an editor is held, an approver decides, and
    // decideChangeRequest mints its own replay token and calls back into this
    // app. Nothing here hand-builds a replay — if the hardening broke real
    // approvals, this is the test that would say so.
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const approver = await person({ grant: true, grantRole: "approver" });
    const f = await forwardable();

    const held = await shareToVendor(editor.token, f);
    expect(held.status).toBe(202);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");

    const cr = await ChangeRequest.findOne({ status: "pending" });
    const result = await decideChangeRequest({
      id: cr._id,
      decision: "approve",
      actor: approverActor(approver.email),
    });

    expect(result.ok).toBe(true);
    expect((await ChangeRequest.findById(cr._id)).status).toBe("approved");
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
  });

  test("a genuine replay is audited as approval, naming the approver", async () => {
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const approver = await person({ grant: true, grantRole: "approver" });
    const f = await forwardable();

    await shareToVendor(editor.token, f);
    const cr = await ChangeRequest.findOne({ status: "pending" });
    await decideChangeRequest({
      id: cr._id,
      decision: "approve",
      actor: approverActor(approver.email),
    });

    const logged = await forwardingLog();
    expect(logged.origin).toBe("approval");
    expect(logged.changeRequestId).toBe(String(cr._id));
    expect(logged.approvedByEmail).toBe(approver.email);
    // The change itself is still authored by the person who asked for it.
    expect(logged.actorEmail).toBe(editor.email);
  });
});

/* ══ 5 · THE REPLAY HEADER IS NOT A PASSWORD ═══════════════════════════════
 *
 * `requireApproval` used to read
 *
 *     if (req.headers[REPLAY_HEADER]) return next();
 *
 * and that header is chosen by the caller. Any editor could send their ordinary
 * mutation with `x-grav-change-request: anything` and skip the approval they
 * were subject to — the whole "not alone" rule, gone, with no trace in the
 * queue because no ChangeRequest was ever created.
 *
 * The bypass now requires the header to match a `replayOf` claim inside the
 * caller's VERIFIED token, and that claim is minted only by
 * services/changeRequests, only after an approver has decided, into a token
 * that travels loopback and never reaches a browser.
 */

describe("share-to-vendor — replay cannot be forged", () => {
  /** A token carrying whatever `replayOf` the test wants to claim. */
  const tokenClaiming = (replayOf, email) =>
    jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email, name: "R", role: "employee", replayOf },
      SECRET,
      { expiresIn: "2m" },
    );

  test("an editor with an arbitrary replay header is still held at 202", async () => {
    // THE EXPLOIT, as it was. 200 and a forwarded work order here would mean
    // the approval gate is decorative.
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();

    const res = await shareToVendor(editor.token, f, {
      headers: { [REPLAY_HEADER]: "totally-made-up" },
    });

    expect(res.status).toBe(202);
    expect(res.body.code).toBe("PENDING_APPROVAL");
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("naming a REAL pending request with an ordinary token does not apply it", async () => {
    // The sharper version: the id is genuine, so nothing about the header looks
    // invented. The token is the editor's own, and that is what fails.
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();

    await shareToVendor(editor.token, f);
    const cr = await ChangeRequest.findOne({ status: "pending" });

    const res = await shareToVendor(editor.token, f, {
      headers: { [REPLAY_HEADER]: String(cr._id) },
    });

    expect(res.status).toBe(202);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
    // It was held AGAIN rather than applied — two pending requests, no change.
    expect(await ChangeRequest.countDocuments({ status: "pending" })).toBe(2);
  });

  test("a signed replayOf for a DIFFERENT request cannot bypass", async () => {
    // Both halves present and the token genuinely signed — but the claim names
    // change A while the header names change B. Presence is not enough; they
    // have to agree.
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();

    await shareToVendor(editor.token, f);
    const cr = await ChangeRequest.findOne({ status: "pending" });
    const otherId = String(new mongoose.Types.ObjectId());

    const res = await shareToVendor(tokenClaiming(otherId, editor.email), f, {
      headers: { [REPLAY_HEADER]: String(cr._id) },
    });

    expect(res.status).toBe(202);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("a matching signed claim and header does bypass", async () => {
    // The other direction, so the tests prove a gate and not a wall: when the
    // two agree the request goes through, which is what keeps real approvals
    // working.
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();

    await shareToVendor(editor.token, f);
    const cr = await ChangeRequest.findOne({ status: "pending" });

    const res = await shareToVendor(tokenClaiming(String(cr._id), editor.email), f, {
      headers: { [REPLAY_HEADER]: String(cr._id) },
    });

    expect(res.status).toBe(200);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
  });

  test("forged approver headers cannot stamp an audit record as approved", async () => {
    // An approver may write directly — that is allowed. What must not be
    // possible is dressing that write up as something a second person signed
    // off, by sending the attribution headers the loopback normally sends.
    await configureDepartment();
    const approver = await person({ grant: true, grantRole: "approver" });
    const f = await forwardable();

    const res = await shareToVendor(approver.token, f, {
      headers: {
        [REPLAY_HEADER]: String(new mongoose.Types.ObjectId()),
        "x-grav-approver-name": "Somebody Important",
        "x-grav-approver-email": "ceo@example.com",
        "x-grav-decision-note": "looks fine to me",
      },
    });

    expect(res.status).toBe(200);

    const logged = await forwardingLog();
    expect(logged.origin).toBe("direct");
    expect(logged.approvedByEmail || "").toBe("");
    expect(logged.approvedByName || "").toBe("");
    expect(logged.changeRequestId || "").toBe("");
  });

  test("a viewer sending replay headers is still refused", async () => {
    // The role guard runs ahead of the approval guard, so the bypass was never
    // reachable from below editor. Pinned anyway: it is one line of ordering
    // away from being reachable.
    await configureDepartment();
    const viewer = await person({ grant: true, grantRole: "viewer" });
    const f = await forwardable();

    const res = await shareToVendor(viewer.token, f, {
      headers: { [REPLAY_HEADER]: "anything" },
    });

    expect(res.status).toBe(403);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("an anonymous caller sending replay headers is still refused", async () => {
    const f = await forwardable();
    const res = await call("/api/cms/manufacturing/manufacturing-orders/share-to-vendor", {
      method: "POST",
      headers: { [REPLAY_HEADER]: "anything" },
      body: { workOrderIds: [String(f.wo._id)], vendorId: String(f.vendor._id) },
    });

    expect(res.status).toBe(401);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("an expired token carrying a valid-looking claim is still refused", async () => {
    await configureDepartment();
    const editor = await person({ grant: true, grantRole: "editor" });
    const f = await forwardable();
    await shareToVendor(editor.token, f);
    const cr = await ChangeRequest.findOne({ status: "pending" });

    const stale = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), email: editor.email, replayOf: String(cr._id) },
      SECRET,
      { expiresIn: -10 },
    );
    const res = await shareToVendor(stale, f, { headers: { [REPLAY_HEADER]: String(cr._id) } });

    expect(res.status).toBe(401);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("pending");
  });

  test("an approver writes directly", async () => {
    await configureDepartment();
    const approver = await person({ grant: true, grantRole: "approver" });
    const f = await forwardable();
    const res = await shareToVendor(approver.token, f);

    expect(res.status).toBe(200);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("a direct privileged write is recorded, without the request body", async () => {
    // Phase E. The held path leaves a ChangeRequest; the direct path left
    // nothing at all, and there is no audit floor under /api/cms/manufacturing
    // the way there is under /api/hr. Recorded through the same changeLog the
    // rest of the codebase uses — not a second log.
    await configureDepartment();
    const approver = await person({ grant: true, grantRole: "approver" });
    const f = await forwardable();
    await shareToVendor(approver.token, f);

    const logged = await forwardingLog();
    expect(logged).toBeTruthy();
    expect(logged.departmentSlug).toBe("project-manager");
    expect(logged.entityId).toBe(String(f.vendor._id));
    expect(logged.summary).toContain(f.vendor.name);
    // Who did it has to be on the record, or it answers nothing. Denormalised
    // onto the row by services/changeLog, so it survives the account changing.
    expect(logged.actorEmail).toBe(approver.email);
    // "direct", not "approval": this is the path that previously left no trace.
    expect(logged.origin).toBe("direct");

    // And nothing that should never reach a log.
    const serialised = JSON.stringify(logged);
    expect(serialised).not.toContain(approver.token);
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("authorization");
  });

  test("an owner writes directly", async () => {
    await configureDepartment();
    const owner = await person({ grant: true, grantRole: "owner" });
    const f = await forwardable();
    const res = await shareToVendor(owner.token, f);

    expect(res.status).toBe(200);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
  });

  test("a platform admin is outside the approval chain", async () => {
    await configureDepartment();
    const admin = await person({ role: "employee", isAdmin: true });
    const f = await forwardable();
    const res = await shareToVendor(admin.token, f);

    expect(res.status).toBe(200);
    expect((await WorkOrder.findById(f.wo._id)).status).toBe("forwarded");
  });

  test("a legacy ProjectManager session is treated by its DepartmentRole, not its token role", async () => {
    // The legacy account question, pinned as behaviour: `role: "project_manager"`
    // in the token buys nothing once the department is configured. A legacy
    // account with no DepartmentRole row is refused exactly like any other
    // employee — which is what would break if roles were rolled out without
    // granting them first. See the audit's legacy section.
    await configureDepartment();
    const legacy = await person({ role: "project_manager" });
    const f = await forwardable();
    const res = await shareToVendor(legacy.token, f);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_DEPARTMENT_ROLE");
  });

  test("access succeeding is not the same as the request being valid", async () => {
    // The distinction the audit needs kept visible: a 400 here comes from the
    // handler, AFTER the guard let the caller through. An approver sending a
    // nonsense body must not look like a permission problem.
    await configureDepartment();
    const approver = await person({ grant: true, grantRole: "approver" });
    const res = await call("/api/cms/manufacturing/manufacturing-orders/share-to-vendor", {
      method: "POST",
      token: approver.token,
      body: { workOrderIds: [], vendorId: "" },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

/* ══ 4 · THE SHARED PREFIX STAYS SHARED ════════════════════════════════════ */

describe("shared manufacturing routes are not swept into the PM guard", () => {
  test("a reader with no production role still lists manufacturing orders", async () => {
    await configureDepartment();
    const cutting = await person({ role: "cutting_master" });
    const res = await call(
      "/api/cms/manufacturing/manufacturing-orders?page=1&limit=5",
      { token: cutting.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("the stats overview is unchanged by this chunk", async () => {
    await configureDepartment();
    const qc = await person({ role: "quality_control" });
    const res = await call(
      "/api/cms/manufacturing/manufacturing-orders/stats/overview",
      { token: qc.token },
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("stats");
  });

  test("a non-PM mutation on the same router is NOT gated on a production role", async () => {
    // mark-stage writes the production-completion scan ledger the floor also
    // writes. It is deliberately left ungated (see the audit): a cutting master
    // or supervisor reaching it must not be parked in a PM approver's queue.
    // Reaching a 404 from the handler proves the request got past every guard.
    await configureDepartment();
    const stranger = await person({ role: "employee" });
    const res = await call(
      `/api/cms/manufacturing/manufacturing-orders/${new mongoose.Types.ObjectId()}/work-orders/${new mongoose.Types.ObjectId()}/mark-stage`,
      { method: "POST", token: stranger.token, body: { stage: "cutting", quantity: 1 } },
    );

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
