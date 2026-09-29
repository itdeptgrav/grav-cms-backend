// test/cctv/cctv-person-access.test.js
//
// Person-wise CCTV permissions (28 Sep 2026): which cameras a person may use
// and, on each, live video / sound / recorded playback — stored on the `cctv`
// grant row through the one audited access write, read back by the CCTV site
// through GET /api/cctv/internal/access, and handed over by a 90-second
// sign-in token that names the person (the old hand-off gave everyone one
// shared key and therefore every camera).
//
// A fake CCTV site (plain http server) stands in for grav-cctv: it serves the
// camera list and records the "access changed" notices it is sent.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "cctv-person-access-test-secret";
process.env.CCTV_SSO_SECRET = "test-only-cctv-sso-secret-0123456789abcdef";
process.env.CCTV_SERVICE_KEY = "test-only-cctv-service-key-0123456789abcdef";

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const ChangeLog = require("../../models/Access/ChangeLog");
const { AccessGrantEvent } = require("../../models/Access/AccessGrantEvent");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const requirePlatformAdmin = require("../../Middlewear/requirePlatformAdmin");
const { resolveCctvAccess } = require("../../services/cctv/cctvAccess.service");
const cctvLink = require("../../services/cctv/cctvLink");

let server, base, fakeCctv, n = 0;
const notices = [];
const REGISTRY = [
  { key: "nvr2:8", displayName: "HR Office", technicalName: "NVR2 Cam 8", nvr: "nvr2", channel: 8, displayOrder: 1, audio: "available" },
  { key: "nvr1:9", displayName: "Reception", technicalName: "NVR1 Cam 9", nvr: "nvr1", channel: 9, displayOrder: 2, audio: "available" },
  { key: "nvr1:4", displayName: "CEO Chamber", technicalName: "NVR1 Cam 4", nvr: "nvr1", channel: 4, displayOrder: 3, audio: "available" },
  { key: "nvr1:14", displayName: "Corridor", technicalName: "NVR1 Cam 14", nvr: "nvr1", channel: 14, displayOrder: 4, audio: "unavailable" },
];
let cctvUp = true;

beforeAll(async () => {
  // The fake CCTV site: checks the service key like grav-cctv does.
  fakeCctv = http.createServer((req, res) => {
    const ok = req.headers["x-cctv-service-key"] === process.env.CCTV_SERVICE_KEY;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!cctvUp) { res.writeHead(503); return res.end("{}"); }
      if (!ok) { res.writeHead(401); return res.end("{}"); }
      if (req.method === "GET" && req.url === "/api/internal/cameras") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ cameras: REGISTRY }));
      }
      if (req.method === "POST" && req.url === "/api/internal/access-changed") {
        notices.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise((r) => fakeCctv.listen(0, "127.0.0.1", r));
  process.env.CCTV_APP_URL = `http://127.0.0.1:${fakeCctv.address().port}`;

  const app = express();
  app.use(express.json());
  app.use("/api/admin", requirePlatformAdmin, require("../../routes/Admin/accessAdmin"));
  app.use("/api/cctv", require("../../routes/cctvSso"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await DepartmentRole.syncIndexes();
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fakeCctv.close(r));
});
beforeEach(() => { notices.length = 0; cctvUp = true; cctvLink._resetForTests(); });

const call = (p, { method = "GET", token, body, headers = {}, redirect = "follow" } = {}) => fetch(`${base}${p}`, {
  method, redirect,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));

async function seed({ cctvOn = ["hr"] } = {}) {
  await ensureAccessDepartments(mongoose.connection);
  await AccessDepartment.updateMany({ slug: { $in: cctvOn } }, { $set: { cctvEnabled: true } });
  invalidate("access-departments:active");
}
const dept = (slug) => AccessDepartment.findOne({ slug });

async function admin() {
  const d = await dept("ceo");
  const user = await DeptUser.create({ name: `Admin ${++n}`, email: `cctv.admin${n}@grav.test`, passwordHash: "x", departmentId: d._id, isAdmin: true, isActive: true });
  const token = jwt.sign({ v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug, email: user.email, name: user.name,
    isAdmin: true, subject: "dept_user", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "10m" });
  return { user, token, who: { id: user._id, subject: "dept_user", tv: 0, email: user.email } };
}

async function sharedLogin(slug = "hr") {
  const d = await dept(slug);
  const user = await DeptUser.create({ name: `Shared ${++n}`, email: `hr.shared${n}@grav.test`, passwordHash: "x", departmentId: d._id, isAdmin: false, isActive: true });
  const token = jwt.sign({ v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug, email: user.email, name: user.name,
    isAdmin: false, subject: "dept_user", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "10m" });
  return { user, token, who: { id: user._id, subject: "dept_user", tv: 0, email: user.email } };
}

async function person({ primary = "hr", extra = [], isActive = true } = {}) {
  const p = primary ? await dept(primary) : null;
  const extras = await Promise.all(extra.map(dept));
  const i = ++n;
  const email = `cctv.person${i}@grav.test`;
  const emp = await Employee.create({
    firstName: "Person", lastName: `No${i}`, email, biometricId: `CCTV${i}`, isActive, gender: "Other", department: "Tech",
    accessDepartmentId: p?._id, additionalDepartmentIds: extras.map((d) => d._id),
  });
  const token = jwt.sign({ v: 2, id: String(emp._id), subject: "employee", email, name: `Person No${i}`, isAdmin: false,
    deptId: String(p?._id || ""), deptSlug: p?.slug || "", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "10m" });
  return { emp, email, token, who: { id: emp._id, subject: "employee", tv: 0, email } };
}

const REASON = "Needs to watch the HR office door for the audit";
const key = () => `cctv-${++n}-${crypto.randomBytes(4).toString("hex")}`;
const grant = (token, email, cctvCameras, extra = {}) => call("/api/admin/app-access", {
  method: "PUT", token,
  body: { email, application: "cctv", role: cctvCameras.length ? "viewer" : null, cctvCameras, reason: REASON, idempotencyKey: key(), ...extra },
});
const access = (who, headers = { "X-CCTV-Service-Key": process.env.CCTV_SERVICE_KEY }) =>
  call(`/api/cctv/internal/access?id=${who.id}&subject=${who.subject}&tv=${who.tv}&email=${encodeURIComponent(who.email)}`, { headers });
const waitFor = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); } return pred(); };

const RAHUL = [
  { key: "nvr2:8", live: true, audio: false, playback: true },   // HR Office
  { key: "nvr1:9", live: true, audio: true, playback: false },   // Reception
];

/* ══ Granting cameras (the one audited write) ════════════════════════════ */

describe("an administrator grants cameras, per camera: live / sound / playback", () => {
  test("the grant is stored normalised on the cctv row, audited with before/after, and in the Access history", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await call("/api/admin/cctv/cameras", { token: a.token }); // camera names for the history line
    const res = await grant(a.token, p.email, RAHUL);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, after: { role: "viewer" }, effective: { allowed: true, role: "viewer" } });
    expect(res.body.after.cctvCameras).toEqual([RAHUL[1], RAHUL[0]]); // sorted by key: nvr1:9, nvr2:8
    const row = await DepartmentRole.findOne({ departmentSlug: "cctv", email: p.email }).lean();
    expect(row).toMatchObject({ role: "viewer", isActive: true });
    expect(row.cctvCameras).toEqual([RAHUL[1], RAHUL[0]]);
    const ev = await AccessGrantEvent.findById(res.body.auditId).lean();
    expect(ev).toMatchObject({ application: "cctv", actor: { email: a.user.email, authority: "platform_admin" },
      before: { role: null }, after: { role: "viewer" }, reason: REASON });
    expect(ev.after.cctvCameras).toHaveLength(2);
    const log = await ChangeLog.findOne({ entity: "access-grant", entityId: `cctv:${p.email}` }).lean();
    expect(log.summary).toMatch(/\+HR Office \(live, playback\)/);
    expect(log.summary).toMatch(/\+Reception \(live, sound\)/);
    // The CCTV site is told at once, for this person only.
    expect(await waitFor(() => notices.some((x) => x.email === p.email))).toBe(true);
  });

  test("a change is recorded as a change; saving the same cameras again is not", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await grant(a.token, p.email, RAHUL);
    const changed = await grant(a.token, p.email, [{ ...RAHUL[0] }, { ...RAHUL[1], audio: false }]);
    expect(changed.body).toMatchObject({ changed: true });
    const same = await grant(a.token, p.email, [{ ...RAHUL[1], audio: false }, { ...RAHUL[0] }]);
    expect(same.body).toMatchObject({ changed: false });
  });

  test("revoke removes every camera (the row keeps none) and the person resolves to no cameras", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await grant(a.token, p.email, RAHUL);
    const res = await grant(a.token, p.email, []);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, after: { role: null, cctvCameras: [] } });
    const row = await DepartmentRole.findOne({ departmentSlug: "cctv", email: p.email }).lean();
    expect(row).toMatchObject({ isActive: false, cctvCameras: [] });
    expect(await resolveCctvAccess(p.who)).toMatchObject({ allowed: true, cameras: [] });
  });

  test("refusals: unknown camera, a role other than viewer, viewer with nothing, cameras on another app, cameras with a revoke", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    const bad = await grant(a.token, p.email, [{ key: "../stream/3", live: true }]);
    expect(bad).toMatchObject({ status: 400, body: { code: "CCTV_CAMERAS_INVALID" } });
    const role = await grant(a.token, p.email, RAHUL, { role: "editor" });
    expect(role).toMatchObject({ status: 400, body: { code: "INVALID_ROLE" } });
    // Sound alone grants nothing (no picture): the entry is dropped, leaving no camera.
    const soundOnly = await grant(a.token, p.email, [{ key: "nvr1:9", audio: true }], { role: "viewer" });
    expect(soundOnly).toMatchObject({ status: 400, body: { code: "CCTV_NO_CAMERAS" } });
    const other = await call("/api/admin/app-access", { method: "PUT", token: a.token,
      body: { email: p.email, application: "sales", role: "viewer", cctvCameras: RAHUL, reason: REASON, idempotencyKey: key() } });
    expect(other).toMatchObject({ status: 400, body: { code: "FIELD_NOT_ACCEPTED" } });
    const revokeWith = await grant(a.token, p.email, RAHUL, { role: null });
    expect(revokeWith).toMatchObject({ status: 400, body: { code: "CCTV_CAMERAS_INVALID" } });
    expect(await DepartmentRole.countDocuments({ departmentSlug: "cctv" })).toBe(0);
  });

  test("only a platform administrator may grant cameras (the CCTV grant has no Owner)", async () => {
    await seed();
    const shared = await sharedLogin();
    const p = await person();
    const res = await grant(shared.token, p.email, RAHUL);
    expect(res.status).toBe(403);
    expect(await DepartmentRole.countDocuments({ departmentSlug: "cctv" })).toBe(0);
  });

  test("the holders list carries each person's cameras for the editor", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await grant(a.token, p.email, RAHUL);
    const res = await call("/api/admin/department-roles/cctv", { token: a.token });
    expect(res.status).toBe(200);
    const h = res.body.holders.find((x) => x.email === p.email);
    expect(h).toMatchObject({ role: "viewer", isActive: true, isEmployee: true });
    expect(h.cctvCameras).toEqual([RAHUL[1], RAHUL[0]]);
  });
});

/* ══ What a person may do (the CCTV site's question) ═════════════════════ */

describe("GET /api/cctv/internal/access — the decision the CCTV site enforces", () => {
  test("only the CCTV site may ask (service key)", async () => {
    await seed();
    const p = await person();
    expect((await access(p.who, {})).status).toBe(401);
    expect((await access(p.who, { "X-CCTV-Service-Key": "wrong-key-wrong-key-wrong-key-wrong" })).status).toBe(401);
    expect((await access(p.who)).status).toBe(200);
  });

  test("a platform administrator: everything, no per-camera setup", async () => {
    await seed();
    const a = await admin();
    const res = await access(a.who);
    expect(res.body).toMatchObject({ allowed: true, admin: true, cameras: [] });
  });

  test("a person in a CCTV-enabled department sees exactly the cameras granted, with live / sound / playback each", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await grant(a.token, p.email, RAHUL);
    const res = await access(p.who);
    expect(res.body).toMatchObject({ allowed: true, admin: false, person: { email: p.email } });
    expect(res.body.cameras).toEqual([RAHUL[1], RAHUL[0]]);
  });

  test("CCTV-enabled department but no camera assigned: allowed in, with NO cameras (never every camera)", async () => {
    await seed();
    const p = await person();
    const res = await access(p.who);
    expect(res.body).toMatchObject({ allowed: true, admin: false, cameras: [] });
  });

  test("cameras granted but no CCTV-enabled department: refused (both are needed)", async () => {
    await seed();
    const a = await admin();
    const p = await person({ primary: "sales" });
    await grant(a.token, p.email, RAHUL);
    const res = await access(p.who);
    expect(res.body).toMatchObject({ allowed: false, denialCode: "CCTV_NOT_ENABLED", cameras: [] });
  });

  test("an ADDITIONAL CCTV-enabled department opens the gate too", async () => {
    await seed();
    const p = await person({ primary: "sales", extra: ["hr"] });
    expect((await access(p.who)).body).toMatchObject({ allowed: true });
  });

  test("switching the department's CCTV toggle off closes it for its people, and the CCTV site is told", async () => {
    await seed();
    const a = await admin();
    const p = await person();
    await grant(a.token, p.email, RAHUL);
    const hr = await dept("hr");
    notices.length = 0;
    const res = await call(`/api/admin/departments/${hr._id}`, { method: "PATCH", token: a.token, body: { cctvEnabled: false } });
    expect(res.status).toBe(200);
    expect((await access(p.who)).body).toMatchObject({ allowed: false, denialCode: "CCTV_NOT_ENABLED" });
    expect(await waitFor(() => notices.some((x) => x.all === true))).toBe(true);
  });

  test("a shared department login that is not an administrator gets no CCTV (people only)", async () => {
    await seed();
    const shared = await sharedLogin("hr");
    expect((await access(shared.who)).body).toMatchObject({ allowed: false, denialCode: "CCTV_PEOPLE_ONLY" });
  });

  test("a deactivated person, and a revoked session version, are refused", async () => {
    await seed();
    const off = await person({ isActive: false });
    expect((await access(off.who)).body).toMatchObject({ allowed: false, denialCode: "IDENTITY_INACTIVE" });
    const a = await admin();
    await DeptUser.updateOne({ _id: a.user._id }, { $inc: { tokenVersion: 1 } });
    expect((await access(a.who)).body).toMatchObject({ allowed: false, denialCode: "SESSION_REVOKED" });
  });
});

/* ══ Sign-in hand-off ═════════════════════════════════════════════════════ */

describe("POST/GET /api/cctv/sso — a 90-second token that names the person, never the shared key", () => {
  test("an allowed person gets the CCTV /sso URL with a verifiable HS256 token naming them", async () => {
    await seed();
    const p = await person();
    const res = await call("/api/cctv/sso", { method: "POST", token: p.token });
    expect(res.status).toBe(200);
    expect(res.body.url.startsWith(`${process.env.CCTV_APP_URL}/sso?token=`)).toBe(true);
    expect(res.body.url).not.toMatch(/[?&]key=/);
    const token = decodeURIComponent(res.body.url.split("token=")[1]);
    const claims = jwt.verify(token, process.env.CCTV_SSO_SECRET, { algorithms: ["HS256"], audience: "grav-cctv", issuer: "grav-cms" });
    expect(claims).toMatchObject({ sub: String(p.emp._id), subj: "employee", tv: 0, email: p.email });
    expect(claims.exp - claims.iat).toBe(90);
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  test("refused people get the reason, not a token; no session is 401", async () => {
    await seed();
    const outside = await person({ primary: "sales" });
    expect(await call("/api/cctv/sso", { method: "POST", token: outside.token }))
      .toMatchObject({ status: 403, body: { code: "CCTV_NOT_ENABLED" } });
    const shared = await sharedLogin("hr");
    expect(await call("/api/cctv/sso", { method: "POST", token: shared.token }))
      .toMatchObject({ status: 403, body: { code: "CCTV_PEOPLE_ONLY" } });
    expect((await call("/api/cctv/sso", { method: "POST" })).status).toBe(401);
  });

  test("GET (a plain link) redirects to the minted URL", async () => {
    await seed();
    const a = await admin();
    const res = await call("/api/cctv/sso", { token: a.token, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location").startsWith(`${process.env.CCTV_APP_URL}/sso?token=`)).toBe(true);
  });

  test("a missing, short or published secret refuses to mint (never a weak token)", async () => {
    await seed();
    const p = await person();
    const keep = process.env.CCTV_SSO_SECRET;
    try {
      process.env.CCTV_SSO_SECRET = "short";
      expect(await call("/api/cctv/sso", { method: "POST", token: p.token })).toMatchObject({ status: 503, body: { code: "CCTV_NOT_CONFIGURED" } });
      // The one that was published in grav-cctv's .env.example is refused by its fingerprint.
      process.env.CCTV_SSO_SECRET = keep;
      const src = require("fs").readFileSync(require.resolve("../../services/cctv/cctvLink"), "utf8");
      expect(src).toMatch(/1bcf4ad1a01f516b148911442399bdd040cfcc8f0de14800afb9e7a201b4d9fa/);
    } finally {
      process.env.CCTV_SSO_SECRET = keep;
    }
  });
});

/* ══ The camera list for the editor ═══════════════════════════════════════ */

describe("GET /api/admin/cctv/cameras — read from the CCTV site, never a second registry", () => {
  test("names, NVR and channel come from the CCTV site; unreachable is a clear 502", async () => {
    await seed();
    const a = await admin();
    const res = await call("/api/admin/cctv/cameras", { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.cameras.map((c) => c.key)).toEqual(["nvr2:8", "nvr1:9", "nvr1:4", "nvr1:14"]);
    expect(res.body.cameras[0]).toMatchObject({ displayName: "HR Office", nvr: "nvr2", channel: 8 });
    cctvLink._resetForTests();
    cctvUp = false;
    const down = await call("/api/admin/cctv/cameras", { token: a.token });
    expect(down).toMatchObject({ status: 502, body: { code: "CCTV_REFUSED" } });
  });

  test("an ordinary person cannot read it (administrators only)", async () => {
    await seed();
    const p = await person();
    expect((await call("/api/admin/cctv/cameras", { token: p.token })).status).toBe(403);
    expect((await call("/api/admin/cctv/cameras")).status).toBe(401);
  });
});
