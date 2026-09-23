// test/accountant/legacy-auth-bootstrap.route.test.js
//
// CHUNK 1 — legacy CMS sessions are bootstrap-only.
//
// WHAT THIS FILE IS DEFENDING
// ---------------------------
// A legacy CMS JWT is any token without an `organizationId` — which is every
// token the main GRAV login issues, for every department. `orgAuth` used to
// answer such a token by handing it canView, canEdit, canPostDirectly,
// canApprove and canManageSettings, and `requireCompanyAccess` waved it past
// company scoping entirely. Any logged-in employee of any department was one
// request away from reading, posting and approving accounting entries.
//
// The rule now: a legacy token is an IDENTITY, not an AUTHORISATION. It gets
// through exactly two doors — GET /auth/me (so the frontend can see it needs
// to upgrade) and POST /auth/sync-legacy (which performs the upgrade against
// the Acc_Department roster). Everything behind `orgAuth` refuses it with
// ACCOUNTING_SESSION_UPGRADE_REQUIRED.
//
// The tests hit REAL routers (approvals, team, pins) rather than a stand-in,
// because the thing being asserted is that the production wiring refuses these
// sessions — not that a hand-rolled middleware chain does.
"use strict";

// Pinned BEFORE anything is required: the middleware reads these once at module
// load, and a stray .env would otherwise decide what these tests prove.
process.env.JWT_SECRET = "test_secret_for_legacy_bootstrap";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

const {
  Acc_Organization,
  Acc_User,
  Acc_ApprovalRequest,
} = require("../../models/Accountant_model/Acc_OrgModels");
const Acc_Department = require("../../models/Accountant_model/Acc_Department");

const {
  orgAuth,
  legacyBootstrapAuth,
  requireCompanyAccess,
  signOrgToken,
  ACCOUNTING_SESSION_UPGRADE_REQUIRED,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");

let server;
let origin;
let warnSpy;

beforeAll(async () => {
  // Every refusal below logs a deliberate warning. Silenced so the run output
  // shows test results rather than several hundred lines of expected noise.
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

  const app = express();
  app.use(express.json());

  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);
  app.use("/api/accountant/auth", R("Acc_auth"));
  app.use("/api/accountant/approvals", R("Acc_approvals"));
  app.use("/api/accountant/team", R("Acc_team"));
  app.use("/api/accountant/pins", R("Acc_pins"));

  // `requireCompanyAccess` has no production mount yet (that lands in Chunk 2),
  // so it is exercised the way Chunk 2 will use it: behind orgAuth, in front of
  // a handler that would read a company's books.
  const companyScoped = express.Router();
  companyScoped.get("/:companyId/ledger", orgAuth, requireCompanyAccess, (req, res) =>
    res.json({ success: true, companyId: req.params.companyId }),
  );
  app.use("/api/accountant/company-scoped", companyScoped);

  await new Promise((r) => {
    server = app.listen(0, r);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

/* ------------------------------------------------------------------ */
/* HTTP helper                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param cookies  object of cookie name → value, sent as a raw Cookie header
 *                 (the middleware parses that header itself, with or without
 *                 cookie-parser installed)
 * @param bearer   Authorization: Bearer token
 */
async function call(
  path,
  { method = "GET", body, cookies, bearer } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (cookies) {
    headers.Cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    setCookie: res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* Token + fixture builders                                            */
/* ------------------------------------------------------------------ */

/** A CMS-issued JWT: an id and a role, and crucially NO organizationId. */
function legacyToken(claims = {}, opts = {}) {
  return jwt.sign(
    {
      id: new mongoose.Types.ObjectId().toString(),
      role: "employee",
      name: "Legacy User",
      userType: "cms",
      ...claims,
    },
    SECRET,
    { expiresIn: "24h", ...opts },
  );
}

let seq = 0;

async function makeOrg(overrides = {}) {
  return Acc_Organization.create({
    name: `Org ${++seq}`,
    tallyCompanyIds: [],
    ...overrides,
  });
}

async function makeUser(org, overrides = {}) {
  const user = new Acc_User({
    organizationId: org._id,
    name: `User ${++seq}`,
    email: `user${seq}@example.com`,
    role: "owner",
    ...overrides,
  });
  await user.setPassword("a-long-enough-password");
  await user.save();
  return user;
}

async function makeDepartment(overrides = {}) {
  return Acc_Department.create({
    email: `accountant${++seq}@example.com`,
    password: "dept-password",
    name: `Accountant ${seq}`,
    employeeId: `ACC-${seq}`,
    phone: "9999999999",
    ...overrides,
  });
}

/** The four gates a legacy session must not be able to open. */
function protectedCalls() {
  const id = new mongoose.Types.ObjectId().toString();
  return [
    { label: "read approvals", path: "/api/accountant/approvals", opts: {} },
    { label: "read team", path: "/api/accountant/team", opts: {} },
    {
      label: "write (pin a record)",
      path: "/api/accountant/pins",
      opts: { method: "POST", body: { entityType: "voucher", entityId: id } },
    },
    {
      label: "approve",
      path: `/api/accountant/approvals/${id}/approve`,
      opts: { method: "POST", body: {} },
    },
    {
      label: "manage settings (invite a user)",
      path: "/api/accountant/team/invites",
      opts: {
        method: "POST",
        body: { email: "x@example.com", name: "X", role: "editor" },
      },
    },
  ];
}

/* ================================================================== */
/* 1. A non-Accounting legacy CMS user                                 */
/* ================================================================== */

describe("a legacy CMS token from outside Accounting", () => {
  test("is refused by every orgAuth-protected route, with the upgrade code", async () => {
    const token = legacyToken({ role: "employee", name: "Ravi (Logistics)" });

    for (const { label, path, opts } of protectedCalls()) {
      const res = await call(path, { ...opts, cookies: { auth_token: token } });
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
      expect(res.body.success).toBe(false);
    }
  });

  test("cannot reach a company-scoped route either", async () => {
    const org = await makeOrg();
    const res = await call(
      `/api/accountant/company-scoped/${org._id}/ledger`,
      { cookies: { auth_token: legacyToken() } },
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
  });

  test("the refusal tells the caller how to recover", async () => {
    const res = await call("/api/accountant/approvals", {
      cookies: { auth_token: legacyToken() },
    });
    expect(res.body.requiresUpgrade).toBe(true);
    expect(res.body.upgradeEndpoint).toBe("/api/accountant/auth/sync-legacy");
    expect(typeof res.body.message).toBe("string");
  });
});

/* ================================================================== */
/* 2. A legacy token that IS an accountant — still no access           */
/* ================================================================== */

describe("a legacy CMS token belonging to a real Accounting admin", () => {
  test("still cannot read, write, post, approve or manage settings before upgrading", async () => {
    const dept = await makeDepartment({ role: "admin" });
    // The strongest legacy claim available: the accounting department's own
    // admin. Being the right person is not the same as having upgraded.
    const token = legacyToken({
      id: dept._id.toString(),
      role: "admin",
      email: dept.email,
      name: dept.name,
    });

    for (const { label, path, opts } of protectedCalls()) {
      const res = await call(path, {
        ...opts,
        cookies: { auth_token: token },
      });
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
    }
  });

  test("a refused approval is not executed on the way out", async () => {
    const org = await makeOrg();
    const dept = await makeDepartment({ role: "accountant" });
    const request = await Acc_ApprovalRequest.create({
      organizationId: org._id,
      kind: "voucher",
      action: "post",
      title: "Post sales voucher SV-1",
      status: "pending",
      requestedBy: new mongoose.Types.ObjectId(),
      payload: {},
    });

    const res = await call(
      `/api/accountant/approvals/${request._id}/approve`,
      {
        method: "POST",
        body: {},
        cookies: {
          auth_token: legacyToken({
            id: dept._id.toString(),
            role: "accountant",
            email: dept.email,
          }),
        },
      },
    );

    expect(res.status).toBe(401);
    const after = await Acc_ApprovalRequest.findById(request._id).lean();
    expect(after.status).toBe("pending");
  });
});

/* ================================================================== */
/* 3. /me still bootstraps                                             */
/* ================================================================== */

describe("GET /auth/me with a legacy session", () => {
  test("returns the safe bootstrap response with every permission false", async () => {
    const dept = await makeDepartment({ role: "admin" });
    const res = await call("/api/accountant/auth/me", {
      cookies: {
        auth_token: legacyToken({
          id: dept._id.toString(),
          role: "admin",
          name: dept.name,
        }),
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.isLegacy).toBe(true);
    expect(res.body.organization).toBeNull();

    // Every financial capability off. Listed one by one on purpose: a new
    // permission added to the block must be added here too, and default-false.
    expect(res.body.permissions).toEqual({
      canView: false,
      canEdit: false,
      canPostDirectly: false,
      canApprove: false,
      canManageTeam: false,
      canManageSettings: false,
    });
    expect(Object.values(res.body.permissions).some(Boolean)).toBe(false);
  });

  test("says explicitly that an upgrade is required", async () => {
    const res = await call("/api/accountant/auth/me", {
      cookies: { auth_token: legacyToken() },
    });
    expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
    expect(res.body.requiresUpgrade).toBe(true);
    expect(res.body.upgradeEndpoint).toBe("/api/accountant/auth/sync-legacy");
  });

  test("does not silently promote a role-less legacy token to owner", async () => {
    const res = await call("/api/accountant/auth/me", {
      cookies: { auth_token: legacyToken({ role: undefined }) },
    });
    expect(res.body.user.role).not.toBe("owner");
  });

  test("with no token at all it is a plain 401", async () => {
    const res = await call("/api/accountant/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("NO_TOKEN");
  });
});

/* ================================================================== */
/* 4. sync-legacy upgrades a real Accounting user                      */
/* ================================================================== */

describe("POST /auth/sync-legacy", () => {
  test("upgrades a valid Accounting department user to an org-aware session", async () => {
    const dept = await makeDepartment({ role: "admin" });
    const token = legacyToken({
      id: dept._id.toString(),
      role: "admin",
      name: dept.name,
    });

    const sync = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: { auth_token: token },
    });

    expect(sync.status).toBe(200);
    expect(sync.body.success).toBe(true);
    expect(sync.body.user.organizationId).toBeTruthy();

    // A normal accountant_token, in the cookie AND in the body (lib/api.js
    // replays the body one as a Bearer header).
    expect(sync.setCookie.join(";")).toContain("accountant_token=");
    expect(typeof sync.body.token).toBe("string");

    const decoded = jwt.verify(sync.body.token, SECRET);
    expect(String(decoded.organizationId)).toBe(
      String(sync.body.user.organizationId),
    );

    // And the upgraded session works where the legacy one was refused.
    const me = await call("/api/accountant/auth/me", {
      cookies: { accountant_token: sync.body.token },
    });
    expect(me.status).toBe(200);
    expect(me.body.user.isLegacy).toBeUndefined();
    expect(me.body.permissions.canView).toBe(true);

    const approvals = await call("/api/accountant/approvals", {
      cookies: { accountant_token: sync.body.token },
    });
    expect(approvals.status).toBe(200);
  });

  test("refuses a CMS user who is not in the Accounting roster", async () => {
    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: {
        auth_token: legacyToken({
          role: "employee",
          email: "logistics.person@example.com",
        }),
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("refuses an unrecognised token with no matching identity at all", async () => {
    await makeDepartment();
    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: { auth_token: legacyToken({ id: "not-an-object-id" }) },
    });
    expect(res.status).toBe(403);
  });

  test("refuses a deactivated Accounting department user", async () => {
    const dept = await makeDepartment({ role: "admin", isActive: false });
    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: {
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
    });
    expect(res.status).toBe(403);
  });

  test("refuses when there is no session to upgrade", async () => {
    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* 5. Normal organisation sessions still work                          */
/* ================================================================== */

describe("a normal organisation session", () => {
  test("an active owner in an active org passes orgAuth with real permissions", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const token = signOrgToken(owner);

    const me = await call("/api/accountant/auth/me", {
      cookies: { accountant_token: token },
    });
    expect(me.status).toBe(200);
    expect(me.body.user.organizationId).toBe(String(org._id));
    expect(me.body.permissions).toEqual({
      canView: true,
      canEdit: true,
      canPostDirectly: true,
      canApprove: true,
      canManageTeam: true,
      canManageSettings: true,
    });

    expect((await call("/api/accountant/approvals", { cookies: { accountant_token: token } })).status).toBe(200);
    expect((await call("/api/accountant/team", { cookies: { accountant_token: token } })).status).toBe(200);
  });

  test("a viewer keeps read access and is refused the approve gate", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const token = signOrgToken(viewer);

    expect((await call("/api/accountant/approvals", { cookies: { accountant_token: token } })).status).toBe(200);

    const approve = await call(
      `/api/accountant/approvals/${new mongoose.Types.ObjectId()}/approve`,
      { method: "POST", body: {}, cookies: { accountant_token: token } },
    );
    expect(approve.status).toBe(403);
  });

  test("works over the Bearer header as well as the cookie", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const res = await call("/api/accountant/approvals", {
      bearer: signOrgToken(owner),
    });
    expect(res.status).toBe(200);
  });
});

/* ================================================================== */
/* 6. The org-token validity checks                                    */
/* ================================================================== */

describe("organisation token validation", () => {
  test("rejects a token for a deactivated user", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const token = signOrgToken(user);
    await Acc_User.updateOne({ _id: user._id }, { $set: { isActive: false } });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: token },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("rejects a token whose user no longer exists", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const token = signOrgToken(user);
    await Acc_User.deleteOne({ _id: user._id });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: token },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("rejects a token for a deactivated organisation", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const token = signOrgToken(user);
    await Acc_Organization.updateOne({ _id: org._id }, { $set: { isActive: false } });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: token },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ORGANIZATION_INACTIVE");
  });

  test("rejects a token claiming an organisation the user does not belong to", async () => {
    const home = await makeOrg();
    const other = await makeOrg();
    const user = await makeUser(home, { role: "owner" });

    // Same user, same signature, someone else's organisation in the claim.
    const forged = jwt.sign(
      {
        id: String(user._id),
        organizationId: String(other._id),
        role: "owner",
        email: user.email,
        name: user.name,
        tokenVersion: 0,
      },
      SECRET,
      { expiresIn: "24h" },
    );

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: forged },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("rejects a token whose version is behind the user's (logout-all)", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const token = signOrgToken(user); // tokenVersion 0
    await Acc_User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: token },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("rejects a token signed with the wrong secret", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const forged = jwt.sign(
      { id: String(user._id), organizationId: String(org._id), role: "owner" },
      "not-the-secret",
      { expiresIn: "24h" },
    );

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: forged },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });
});

/* ================================================================== */
/* 7. Company scoping                                                  */
/* ================================================================== */

describe("requireCompanyAccess", () => {
  test("allows a company the organisation owns", async () => {
    const companyId = new mongoose.Types.ObjectId();
    const org = await makeOrg({ tallyCompanyIds: [companyId] });
    const owner = await makeUser(org, { role: "owner" });

    const res = await call(
      `/api/accountant/company-scoped/${companyId}/ledger`,
      { cookies: { accountant_token: signOrgToken(owner) } },
    );
    expect(res.status).toBe(200);
  });

  test("rejects a company outside the authenticated organisation", async () => {
    const mine = new mongoose.Types.ObjectId();
    const theirs = new mongoose.Types.ObjectId();
    const org = await makeOrg({ tallyCompanyIds: [mine] });
    const owner = await makeUser(org, { role: "owner" });

    const res = await call(
      `/api/accountant/company-scoped/${theirs}/ledger`,
      { cookies: { accountant_token: signOrgToken(owner) } },
    );
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/does not have access to this company/i);
  });

  test("no longer waves a legacy session past company scoping", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await makeOrg({ tallyCompanyIds: [companyId] });
    const dept = await makeDepartment({ role: "admin" });

    const res = await call(
      `/api/accountant/company-scoped/${companyId}/ledger`,
      {
        cookies: {
          auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
        },
      },
    );
    // Refused at the gate — it never reaches requireCompanyAccess, which is
    // the point: there is no session for it to exempt.
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
  });
});

/* ================================================================== */
/* 8. Expired / stale accountant_token falling back to the CMS token   */
/* ================================================================== */

describe("an expired accountant_token alongside a live CMS token", () => {
  test("falls back for the bootstrap flow", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const expired = signOrgToken(owner, "-1s");
    const dept = await makeDepartment({ role: "admin" });

    const res = await call("/api/accountant/auth/me", {
      cookies: {
        accountant_token: expired,
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.user.isLegacy).toBe(true);
    // …and the dead cookie is cleared so the browser stops replaying it.
    expect(res.setCookie.join(";")).toContain("accountant_token=;");
  });

  test("does NOT fall back into protected accounting access", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const dept = await makeDepartment({ role: "admin" });

    const res = await call("/api/accountant/approvals", {
      cookies: {
        accountant_token: signOrgToken(owner, "-1s"),
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
  });

  test("a valid-but-stale accountant_token does not fall back into access either", async () => {
    // The old stale-user fallback: token verifies, Acc_User is gone, a CMS
    // cookie is sitting right there. That used to be a full legacy grant.
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const token = signOrgToken(owner);
    await Acc_User.deleteOne({ _id: owner._id });
    const dept = await makeDepartment({ role: "admin" });

    const protectedRes = await call("/api/accountant/approvals", {
      cookies: {
        accountant_token: token,
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
    });
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);

    // The same request to /me still bootstraps, so the user can recover.
    const me = await call("/api/accountant/auth/me", {
      cookies: {
        accountant_token: token,
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
    });
    expect(me.status).toBe(200);
    expect(me.body.user.isLegacy).toBe(true);
  });
});

/* ================================================================== */
/* 9. Mixed credentials — the browser's real state                     */
/* ================================================================== */
//
// A browser that has signed into the CMS sends the legacy `auth_token` cookie
// on EVERY accounting request, because lib/api.js uses `credentials: "include"`.
// It ALSO injects the accounting token it holds in localStorage as
// `Authorization: Bearer`. Both are cryptographically valid, and the legacy one
// used to be checked first — so a caller with a perfectly good accounting
// session was handed the legacy answer, which after Chunk 1 means a refusal.
// On Chrome that is every request the accounting app makes.
//
// The rule these pin: the credential that WINS is the first organisation-aware
// one confirmed against the database, Bearer ahead of cookies. Legacy is the
// last resort, never a preference.

describe("a legacy CMS cookie alongside a valid accounting Bearer", () => {
  test("resolves to the normal organisation session, not a legacy one", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const dept = await makeDepartment({ role: "admin" });

    const res = await call("/api/accountant/auth/me", {
      cookies: {
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
      bearer: signOrgToken(owner),
    });

    expect(res.status).toBe(200);
    expect(res.body.user.isLegacy).toBeUndefined();
    expect(res.body.user.organizationId).toBe(String(org._id));
    expect(res.body.permissions.canView).toBe(true);
    expect(res.body.requiresUpgrade).toBeUndefined();
  });

  test("reaches an orgAuth-protected route with real permissions", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const dept = await makeDepartment({ role: "admin" });
    const cookies = {
      auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
    };
    const bearer = signOrgToken(owner);

    expect((await call("/api/accountant/approvals", { cookies, bearer })).status).toBe(200);
    expect((await call("/api/accountant/team", { cookies, bearer })).status).toBe(200);

    // …including the write path, which a legacy session can never have.
    const pin = await call("/api/accountant/pins", {
      method: "POST",
      body: { entityType: "voucher", entityId: new mongoose.Types.ObjectId().toString() },
      cookies,
      bearer,
    });
    expect([200, 201]).toContain(pin.status);
  });

  test("company scoping is applied to the Bearer's organisation", async () => {
    const mine = new mongoose.Types.ObjectId();
    const theirs = new mongoose.Types.ObjectId();
    const org = await makeOrg({ tallyCompanyIds: [mine] });
    const owner = await makeUser(org, { role: "owner" });
    const cookies = { auth_token: legacyToken() };
    const bearer = signOrgToken(owner);

    expect((await call(`/api/accountant/company-scoped/${mine}/ledger`, { cookies, bearer })).status).toBe(200);
    expect((await call(`/api/accountant/company-scoped/${theirs}/ledger`, { cookies, bearer })).status).toBe(403);
  });
});

describe("a stale accountant_token must not hide a valid Bearer", () => {
  test("expired cookie + legacy cookie + valid Bearer → the Bearer session, cookie cleared", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const dept = await makeDepartment({ role: "admin" });

    const res = await call("/api/accountant/approvals", {
      cookies: {
        accountant_token: signOrgToken(owner, "-1s"),
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
      bearer: signOrgToken(owner),
    });

    expect(res.status).toBe(200);
    expect(res.setCookie.join(";")).toContain("accountant_token=;");
  });

  test("a cookie for a deleted account does not shadow the Bearer, and is cleared", async () => {
    const org = await makeOrg();
    const gone = await makeUser(org, { role: "owner" });
    const staleCookie = signOrgToken(gone);
    await Acc_User.deleteOne({ _id: gone._id });

    const live = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/auth/me", {
      cookies: { accountant_token: staleCookie },
      bearer: signOrgToken(live),
    });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(String(live._id));
    // The cookie names someone else — a leftover that would win any later
    // request the Bearer happens to miss.
    expect(res.setCookie.join(";")).toContain("accountant_token=;");
  });

  test("but a merely-unconfirmed Bearer does not shadow a good cookie either", async () => {
    // Preference is not blind trust: the Bearer is tried first, and when the
    // database refuses it the cookie still gets its turn.
    const org = await makeOrg();
    const gone = await makeUser(org, { role: "owner" });
    const deadBearer = signOrgToken(gone);
    await Acc_User.deleteOne({ _id: gone._id });

    const live = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: signOrgToken(live) },
      bearer: deadBearer,
    });
    expect(res.status).toBe(200);
  });

  test("an expired Bearer with no legacy credential still falls back to the cookie", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/approvals", {
      cookies: { accountant_token: signOrgToken(owner) },
      bearer: signOrgToken(owner, "-1s"),
    });
    expect(res.status).toBe(200);
  });
});

describe("an unusable accounting Bearer beside a valid legacy cookie", () => {
  test("still bootstraps on /me", async () => {
    const dept = await makeDepartment({ role: "admin" });
    const res = await call("/api/accountant/auth/me", {
      cookies: {
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
      bearer: "not-a-jwt-at-all",
    });

    expect(res.status).toBe(200);
    expect(res.body.user.isLegacy).toBe(true);
    expect(Object.values(res.body.permissions).some(Boolean)).toBe(false);
  });

  test("and protected routes stay refused", async () => {
    const dept = await makeDepartment({ role: "admin" });
    const res = await call("/api/accountant/approvals", {
      cookies: {
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
      bearer: "not-a-jwt-at-all",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
  });

  test("a Bearer for a deleted account also falls through to bootstrap, not access", async () => {
    const org = await makeOrg();
    const gone = await makeUser(org, { role: "owner" });
    const deadBearer = signOrgToken(gone);
    await Acc_User.deleteOne({ _id: gone._id });
    const dept = await makeDepartment({ role: "admin" });
    const cookies = {
      auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
    };

    const me = await call("/api/accountant/auth/me", { cookies, bearer: deadBearer });
    expect(me.status).toBe(200);
    expect(me.body.user.isLegacy).toBe(true);

    const guarded = await call("/api/accountant/approvals", { cookies, bearer: deadBearer });
    expect(guarded.status).toBe(401);
    expect(guarded.body.code).toBe(ACCOUNTING_SESSION_UPGRADE_REQUIRED);
  });
});

/* ================================================================== */
/* 10. sync-legacy consumes a legacy identity, and only that           */
/* ================================================================== */

describe("POST /auth/sync-legacy with an organisation-aware session", () => {
  test("does not read the accounting token as a department identity", async () => {
    // The trap: a promoted owner's Acc_User carries the SAME email as the
    // Acc_Department row it was promoted from, so an email lookup on an
    // accountant_token's claims matches — and the endpoint would happily mint a
    // brand-new session from a credential that is not a legacy one at all.
    const dept = await makeDepartment({ role: "admin" });
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner", email: dept.email });

    const before = await Acc_User.countDocuments({});

    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: { accountant_token: signOrgToken(owner) },
    });

    expect(res.status).toBe(200);
    expect(res.body.alreadyUpgraded).toBe(true);
    expect(res.body.promoted).toBe(false);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user.organizationId).toBe(String(org._id));
    expect(await Acc_User.countDocuments({})).toBe(before);
  });

  test("a revoked accounting token cannot re-mint itself through the upgrade path", async () => {
    // "Log out of all devices" bumps tokenVersion. The revocation guard inside
    // sync-legacy compares a CMS token's `iat` against sessionsRevokedAt and
    // knows nothing about tokenVersion — so a revoked accountant_token reaching
    // the department lookup would have walked straight past it.
    const dept = await makeDepartment({ role: "admin" });
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner", email: dept.email });
    const revoked = signOrgToken(owner);
    await Acc_User.updateOne(
      { _id: owner._id },
      { $inc: { tokenVersion: 1 }, $set: { sessionsRevokedAt: new Date() } },
    );

    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: { accountant_token: revoked },
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
    expect(res.body.token).toBeUndefined();
  });

  test("a legacy cookie still upgrades even when an unusable Bearer is present", async () => {
    const dept = await makeDepartment({ role: "admin" });
    const res = await call("/api/accountant/auth/sync-legacy", {
      method: "POST",
      body: {},
      cookies: {
        auth_token: legacyToken({ id: dept._id.toString(), role: "admin" }),
      },
      bearer: "not-a-jwt-at-all",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.alreadyUpgraded).toBeUndefined();
    expect(typeof res.body.token).toBe("string");
    expect(jwt.verify(res.body.token, SECRET).organizationId).toBeTruthy();
  });
});
