// test/security/sec0-jwt-secrets.test.js
//
// SEC-0 — the signing secrets published in this repository are dead.
//
//   · a token signed with either published secret is refused by every CMS
//     verifier exercised here;
//   · a token signed with the configured secret still works;
//   · an `isAdmin` claim in a VALID token is not administrator authority on
//     the administrative / role-management endpoints — only an active
//     administrator row in dept_users is;
//   · production refuses to start with a missing, blank or published secret;
//   · no application source file still names a published secret.
//
// The two literals below are the published values under test, not secrets in
// use anywhere.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "sec0-configured-secret-for-tests";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { verifyCmsToken, resolveSecret } = require("../../config/jwt");
const { authenticateCmsSession } = require("../../services/cmsSession");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const SalesAuthMiddleware = require("../../Middlewear/SalesAuthMiddlewear");
const requirePlatformAdmin = require("../../Middlewear/requirePlatformAdmin");
const { verifyToken: deptVerifyToken } = require("../../routes/auth/deptAuth");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");

const PUBLISHED = ["grav_clothing_secret_key", "grav_clothing_secret_key_2024"];
const ROOT = path.resolve(__dirname, "../..");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/department-team", require("../../routes/Access/departmentTeam"));
  app.use("/api/change-requests", require("../../routes/Access/changeRequests"));
  app.use("/api/dev", require("../../routes/DevOps/developer"));
  app.use("/api/admin", requirePlatformAdmin, require("../../routes/Admin/accessAdmin"));
  app.post("/api/auth-probe/verify", (req, res) => {
    try { deptVerifyToken(String(req.body.token || "")); res.json({ ok: true }); } catch { res.status(401).json({ ok: false }); }
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (p, { method = "GET", token, body } = {}) => fetch(`${base}${p}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

function runMiddleware(mw, req) {
  return new Promise((done) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { done({ nextCalled: false, status: this.statusCode, body }); return this; },
    };
    Promise.resolve(mw(req, res, () => done({ nextCalled: true, status: null })))
      .catch((err) => done({ nextCalled: false, status: "threw", body: err }));
  });
}
const bearerReq = (token) => ({ headers: { authorization: `Bearer ${token}` }, cookies: {} });

const claims = (extra = {}) => ({
  v: 2, id: String(new mongoose.Types.ObjectId()), email: `sec0.${++n}@grav.test`,
  role: "sales", deptSlug: "sales", isAdmin: false, tv: 0, ...extra,
});
const signWith = (secret, extra) => jwt.sign(claims(extra), secret, { expiresIn: "5m" });
const current = (extra) => signWith(process.env.JWT_SECRET, extra);

async function deptUser({ isAdmin = false, isActive = true, slug = "ceo" } = {}) {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
  const dept = await AccessDepartment.findOne({ slug });
  const user = await DeptUser.create({
    name: `Sec Zero ${++n}`, email: `sec0.dept${n}@grav.test`, passwordHash: "x",
    departmentId: dept._id, isAdmin, isActive,
  });
  const token = jwt.sign(
    { v: 2, id: String(user._id), deptId: String(dept._id), deptSlug: dept.slug,
      email: user.email, name: user.name, isAdmin: true, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET, { expiresIn: "5m" },
  );
  return { user, token };
}

/* ══ Published secrets are rejected ══════════════════════════════════════ */

describe.each(PUBLISHED)("a token signed with the published secret %s", (secret) => {
  const forged = () => signWith(secret, { isAdmin: true, role: "ceo" });

  test("verifyCmsToken refuses it", () => {
    expect(() => verifyCmsToken(forged())).toThrow();
  });

  test("the department login verifier refuses it", async () => {
    expect((await call("/api/auth-probe/verify", { method: "POST", body: { token: forged() } })).status).toBe(401);
  });

  test("cmsSession, EmployeeAuthMiddlewear, SalesAuthMiddlewear and requirePlatformAdmin answer 401", async () => {
    const t = forged();
    for (const mw of [authenticateCmsSession, EmployeeAuthMiddleware, SalesAuthMiddleware, requirePlatformAdmin]) {
      const out = await runMiddleware(mw, bearerReq(t));
      expect({ mw: mw.name, nextCalled: out.nextCalled, status: out.status })
        .toEqual({ mw: mw.name, nextCalled: false, status: 401 });
    }
  });

  test("the administrative and role-management endpoints answer 401", async () => {
    const t = forged();
    expect((await call("/api/department-team/sales", { token: t })).status).toBe(401);
    expect((await call("/api/change-requests/sales/approve-all", { method: "POST", token: t, body: {} })).status).toBe(401);
    expect((await call("/api/dev/settings", { token: t })).status).toBe(401);
    expect((await call("/api/admin/departments", { token: t })).status).toBe(401);
  });
});

/* ══ The configured secret still works ═══════════════════════════════════ */

describe("a token signed with the configured secret", () => {
  test("verifies, and passes the session middlewares", async () => {
    const t = current({ role: "sales" });
    expect(verifyCmsToken(t).role).toBe("sales");
    for (const mw of [authenticateCmsSession, EmployeeAuthMiddleware, SalesAuthMiddleware]) {
      const req = bearerReq(t);
      const out = await runMiddleware(mw, req);
      expect({ mw: mw.name, nextCalled: out.nextCalled }).toEqual({ mw: mw.name, nextCalled: true });
    }
  });

  test("a real, active administrator is an owner on department-team and passes /api/admin", async () => {
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    const { token } = await deptUser({ isAdmin: true });
    const team = await call("/api/department-team/sales", { token });
    expect(team.status).toBe(200);
    expect(team.body.canManage).toBe(true);
    expect((await call("/api/admin/departments", { token })).status).toBe(200);
  });
});

/* ══ A forged isAdmin claim is not administrator authority ═══════════════ */

describe("an isAdmin claim in a validly-signed token, with no active administrator record", () => {
  const forgedCases = {
    "no account at all": async () => current({ isAdmin: true }),
    "an account that is not an administrator": async () => (await deptUser({ isAdmin: false })).token,
    "a deactivated administrator": async () => (await deptUser({ isAdmin: true, isActive: false })).token,
    "an administrator whose sessions were revoked": async () => {
      const { user, token } = await deptUser({ isAdmin: true });
      await DeptUser.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
      return token;
    },
  };

  test.each(Object.keys(forgedCases))("%s: cmsSession drops the claim", async (label) => {
    const req = bearerReq(await forgedCases[label]());
    const out = await runMiddleware(authenticateCmsSession, req);
    expect(out.nextCalled).toBe(true);
    expect(req.user.isAdmin).toBe(false);
  });

  test.each(Object.keys(forgedCases))("%s: role management and admin endpoints refuse it", async (label) => {
    await DepartmentRole.create({ departmentSlug: "sales", email: `owner.${label.length}@grav.test`, role: "owner" });
    const token = await forgedCases[label]();

    const read = await call("/api/department-team/sales", { token });
    expect(read.status).toBe(403);

    const grant = await call("/api/department-team/sales", {
      method: "PUT", token, body: { email: "victim@grav.test", role: "owner" },
    });
    expect(grant.status).toBe(403);
    expect(await DepartmentRole.countDocuments({ email: "victim@grav.test" })).toBe(0);

    const approve = await call("/api/change-requests/sales/approve-all", { method: "POST", token, body: {} });
    expect(approve.status).toBe(403);

    const dev = await call("/api/dev/settings", { token });
    expect(dev.status).toBe(403);

    const admin = await call("/api/admin/departments", { token });
    expect([401, 403]).toContain(admin.status);
  });

  test("a failed administrator lookup is an outage (503), never an elevation", async () => {
    const token = current({ isAdmin: true });
    jest.spyOn(DeptUser, "findById").mockImplementation(() => { throw new Error("simulated outage"); });
    try {
      const out = await runMiddleware(authenticateCmsSession, bearerReq(token));
      expect(out.nextCalled).toBe(false);
      expect(out.status).toBe(503);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

/* ══ Startup configuration ═══════════════════════════════════════════════ */

describe("secret configuration", () => {
  test("production refuses a missing or blank JWT_SECRET", () => {
    expect(() => resolveSecret({ NODE_ENV: "production" })).toThrow(/JWT_SECRET is not set/);
    expect(() => resolveSecret({ NODE_ENV: "production", JWT_SECRET: "   " })).toThrow(/JWT_SECRET is not set/);
  });

  test.each(PUBLISHED)("every environment refuses the published value %s", (secret) => {
    expect(() => resolveSecret({ NODE_ENV: "production", JWT_SECRET: secret })).toThrow(/published/);
    expect(() => resolveSecret({ NODE_ENV: "development", JWT_SECRET: secret })).toThrow(/published/);
  });

  test("a real configured secret is used as given", () => {
    expect(resolveSecret({ NODE_ENV: "production", JWT_SECRET: " a-real-secret " })).toBe("a-real-secret");
  });

  test("outside production a missing secret is random per process, never a known string", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const a = resolveSecret({ NODE_ENV: "development" });
    const b = resolveSecret({ NODE_ENV: "development" });
    warn.mockRestore();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(64);
  });

  test("loading config/jwt in a production process without JWT_SECRET exits with an error", () => {
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.JWT_SECRET;
    const out = spawnSync(process.execPath, ["-e", "require('./config/jwt')"], { cwd: ROOT, env, encoding: "utf8" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/JWT_SECRET is not set/);
  });
});

/* ══ No application source still names a published secret ═══════════════ */

test("no application source file references a published secret or LEGACY_SECRETS", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "docs"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/grav_clothing_secret_key|LEGACY_SECRETS/.test(text)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const d of ["config", "Middlewear", "middleware", "routes", "services", "models", "lib", "utils"]) {
    if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  }
  const serverText = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  if (/grav_clothing_secret_key|LEGACY_SECRETS/.test(serverText)) offenders.push("server.js");
  expect(offenders).toEqual([]);
});
