// test/accountant/legacy-route-auth-facade.route.test.js
//
// LANE A, CHUNK 2 — the 39 route files that still import
// `AccountantAuthMiddleware` no longer accept legacy CMS role tokens.
//
// WHAT THIS FILE IS DEFENDING
// ---------------------------
// Chunk 1 closed the legacy grant on the routes behind `orgAuth`. It did not
// touch these: vouchers, invoices, journals, reports, settings, parties,
// banking, expenses, payroll and thirty more were gated by
// `makeAuth(["accountant","admin"])`, which compared a role-NAME string out of
// the JWT and asked the database nothing at all. The accounting department's
// own CMS login issues exactly those two role names. So a cookie saying
// `role: "admin"` could post a voucher — and kept doing so after a user was
// deactivated, removed from the organisation, or logged out of all devices.
//
// `AccountantAuthMiddleware` is now a façade over `orgAuth`. These tests are
// deliberately run against the REAL routers, not a stand-in chain, because the
// claim being made is about production wiring: that the module the 39 files
// import refuses what it used to accept, and that the identity it hands them is
// the database-confirmed one.
"use strict";

// Pinned BEFORE anything is required — the middleware reads these once at load.
process.env.JWT_SECRET = "test_secret_for_route_facade";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

const {
  Acc_Organization,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");

const facade = require("../../Middlewear/AccountantAuthMiddleware");
const { accountantAuth, accountantReadOnlyAuth, adminOnlyAuth } = facade;
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");

const UPGRADE = "ACCOUNTING_SESSION_UPGRADE_REQUIRED";

let server;
let origin;
let warnSpy;

beforeAll(async () => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

  const app = express();
  app.use(express.json());

  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);

  // Representative of each family named in the chunk brief. Every one of these
  // mounts the façade itself — nothing here re-wires their auth.
  app.use("/api/accountant/vouchers", R("Acc_vouchers"));
  app.use("/api/accountant/invoices", R("Acc_invoices"));
  app.use("/api/accountant/reports", R("Acc_reports"));
  app.use("/api/accountant/settings", R("Acc_settings"));
  app.use("/api/accountant/parties", R("Acc_parties"));
  app.use("/api/accountant/bank-transactions", R("Acc_bankTransactions"));
  app.use("/api/accountant/expenses", R("Acc_expenses"));
  app.use("/api/accountant/journal-entries", R("Acc_journalEntries"));
  app.use("/api/accountant/change-history", R("Acc_changeHistory"));

  // A probe behind the real `accountantAuth`, so what the façade ATTACHES can
  // be asserted directly rather than inferred from a handler's behaviour.
  const probe = express.Router();
  probe.use(accountantAuth);
  probe.all("/echo", (req, res) =>
    res.json({
      user: req.user,
      accountantId: req.accountantId,
      organization: req.organization
        ? { id: String(req.organization._id), name: req.organization.name }
        : null,
    }),
  );
  app.use("/api/accountant/_probe", probe);

  // `adminOnlyAuth` has no production mount today; exercised the way a settings
  // route would use it.
  const adminOnly = express.Router();
  adminOnly.use(adminOnlyAuth);
  adminOnly.all("/", (req, res) => res.json({ success: true }));
  app.use("/api/accountant/_admin-only", adminOnly);

  // Same for the read-only variant, so its capability is asserted on both verbs.
  const readOnly = express.Router();
  readOnly.use(accountantReadOnlyAuth);
  readOnly.all("/", (req, res) => res.json({ success: true }));
  app.use("/api/accountant/_read-only", readOnly);

  await new Promise((r) => {
    server = app.listen(0, r);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

async function call(path, { method = "GET", body, cookies, bearer } = {}) {
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
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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

/** A CMS-issued JWT — a role name and no organizationId. */
function legacyToken(claims = {}) {
  return jwt.sign(
    {
      id: new mongoose.Types.ObjectId().toString(),
      role: "accountant",
      employeeId: "GR0067",
      name: "Legacy Accountant",
      ...claims,
    },
    SECRET,
    { expiresIn: "24h" },
  );
}

/**
 * One read and one write on each representative family, addressed at the real
 * routers. The write bodies are deliberately empty — every assertion here is
 * about the gate, which answers before any handler sees a body.
 */
const REPRESENTATIVE = [
  { family: "vouchers", read: "/api/accountant/vouchers", write: { path: "/api/accountant/vouchers", method: "POST" } },
  { family: "invoices", read: "/api/accountant/invoices", write: { path: "/api/accountant/invoices", method: "POST" } },
  { family: "reports", read: "/api/accountant/reports/receivables-aging", write: null },
  { family: "settings", read: "/api/accountant/settings", write: { path: "/api/accountant/settings", method: "PUT" } },
  { family: "parties", read: "/api/accountant/parties", write: { path: `/api/accountant/parties/${new mongoose.Types.ObjectId()}/credit-terms`, method: "PATCH" } },
  { family: "banking", read: "/api/accountant/bank-transactions", write: { path: "/api/accountant/bank-transactions", method: "POST" } },
  { family: "expenses", read: "/api/accountant/expenses", write: { path: "/api/accountant/expenses", method: "POST" } },
  { family: "journals", read: "/api/accountant/journal-entries", write: { path: "/api/accountant/journal-entries", method: "POST" } },
  { family: "change-history", read: "/api/accountant/change-history", write: null },
];

/* ================================================================== */
/* 1. Legacy CMS role tokens are refused                               */
/* ================================================================== */

describe("legacy CMS role tokens on routes still using AccountantAuthMiddleware", () => {
  test.each(["accountant", "admin", "accountant_viewer"])(
    "role %s cannot read any representative route",
    async (role) => {
      const token = legacyToken({ role });
      for (const { family, read } of REPRESENTATIVE) {
        const res = await call(read, { cookies: { auth_token: token } });
        expect(`${family}: ${res.status}`).toBe(`${family}: 401`);
        expect(res.body.code).toBe(UPGRADE);
      }
    },
  );

  test("a legacy admin token cannot write on any representative route", async () => {
    const token = legacyToken({ role: "admin" });
    for (const { family, write } of REPRESENTATIVE) {
      if (!write) continue;
      const res = await call(write.path, {
        method: write.method,
        body: {},
        cookies: { auth_token: token },
      });
      expect(`${family}: ${res.status}`).toBe(`${family}: 401`);
      expect(res.body.code).toBe(UPGRADE);
    }
  });

  test("the legacy role name buys nothing even as a Bearer", async () => {
    const res = await call("/api/accountant/_probe/echo", {
      bearer: legacyToken({ role: "admin" }),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UPGRADE);
  });

  test("no token at all is a plain 401", async () => {
    const res = await call("/api/accountant/vouchers");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("NO_TOKEN");
  });
});

/* ================================================================== */
/* 2. What the façade attaches                                         */
/* ================================================================== */

describe("the identity handed to the legacy routes", () => {
  test("is the database-confirmed Acc_User and organisation", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/_probe/echo", {
      bearer: signOrgToken(owner),
    });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(String(owner._id));
    expect(res.body.user.organizationId).toBe(String(org._id));
    expect(res.body.user.role).toBe("owner");
    expect(res.body.user.isLegacy).toBeUndefined();
    expect(res.body.organization.id).toBe(String(org._id));
    // Compatibility field several routes stamp onto records they write.
    expect(res.body.accountantId).toBe(String(owner._id));
  });

  test("carries the role STORED in the database, not the one in the token", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "viewer" });

    // A token that claims owner for a user the database says is a viewer. The
    // signature is valid — this is exactly what a self-minted claim looks like.
    const lying = jwt.sign(
      {
        id: String(user._id),
        organizationId: String(org._id),
        role: "owner",
        email: user.email,
        name: user.name,
        tokenVersion: 0,
      },
      SECRET,
      { expiresIn: "24h" },
    );

    const res = await call("/api/accountant/_probe/echo", { bearer: lying });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("viewer");
    expect(res.body.user.permissions.canEdit).toBe(false);
  });

  test("a lying token cannot write, whatever it claims", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "viewer" });
    const lying = jwt.sign(
      {
        id: String(user._id),
        organizationId: String(org._id),
        role: "owner",
        tokenVersion: 0,
        permissions: { canEdit: true, canManageSettings: true },
      },
      SECRET,
      { expiresIn: "24h" },
    );

    const res = await call("/api/accountant/journal-entries", {
      method: "POST",
      body: {},
      bearer: lying,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_ROLE");
    expect(res.body.requires).toBe("canEdit");
  });
});

/* ================================================================== */
/* 3. The capability matrix across the representative routes           */
/* ================================================================== */

describe("owner", () => {
  test("can read every representative route", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(owner);

    for (const { family, read } of REPRESENTATIVE) {
      const res = await call(read, { bearer });
      // The gate let it through. A handler may still answer 400/404/500 for
      // reasons of its own — what must never appear is an auth refusal.
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 401`);
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 403`);
    }
  });

  test("can write on every representative route", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(owner);

    for (const { family, write } of REPRESENTATIVE) {
      if (!write) continue;
      const res = await call(write.path, {
        method: write.method,
        body: {},
        bearer,
      });
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 401`);
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 403`);
    }
  });
});

describe("viewer", () => {
  test("can read every representative route", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const bearer = signOrgToken(viewer);

    for (const { family, read } of REPRESENTATIVE) {
      const res = await call(read, { bearer });
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 401`);
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 403`);
    }
  });

  test("is refused every write, with the capability named", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const bearer = signOrgToken(viewer);

    for (const { family, write } of REPRESENTATIVE) {
      if (!write) continue;
      const res = await call(write.path, {
        method: write.method,
        body: {},
        bearer,
      });
      expect(`${family}: ${res.status}`).toBe(`${family}: 403`);
      expect(res.body.code).toBe("INSUFFICIENT_ROLE");
      expect(res.body.requires).toBe("canEdit");
      expect(res.body.role).toBe("viewer");
    }
  });
});

describe("editor", () => {
  test("can perform ordinary edits", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });
    const bearer = signOrgToken(editor);

    for (const { family, write } of REPRESENTATIVE) {
      if (!write) continue;
      const res = await call(write.path, {
        method: write.method,
        body: {},
        bearer,
      });
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 403`);
      expect(`${family}: ${res.status}`).not.toBe(`${family}: 401`);
    }
  });

  test("cannot pass an admin-only gate", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });

    const res = await call("/api/accountant/_admin-only", {
      bearer: signOrgToken(editor),
    });
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canManageSettings");
  });
});

describe("adminOnlyAuth", () => {
  test("only an owner passes it", async () => {
    const org = await makeOrg();
    const results = {};
    for (const role of ["owner", "approver", "editor", "viewer"]) {
      const user = await makeUser(org, { role });
      const res = await call("/api/accountant/_admin-only", {
        bearer: signOrgToken(user),
      });
      results[role] = res.status;
    }
    expect(results).toEqual({
      owner: 200,
      approver: 403,
      editor: 403,
      viewer: 403,
    });
  });

  test("refuses writes as well as reads for a non-owner", async () => {
    const org = await makeOrg();
    const approver = await makeUser(org, { role: "approver" });
    const res = await call("/api/accountant/_admin-only", {
      method: "POST",
      body: {},
      bearer: signOrgToken(approver),
    });
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canManageSettings");
  });
});

describe("accountantReadOnlyAuth", () => {
  test("requires canView to read — a real org user passes", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const res = await call("/api/accountant/_read-only", {
      bearer: signOrgToken(viewer),
    });
    expect(res.status).toBe(200);
  });

  test("refuses a legacy session outright", async () => {
    const res = await call("/api/accountant/_read-only", {
      cookies: { auth_token: legacyToken({ role: "accountant_viewer" }) },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UPGRADE);
  });

  test("does not let a viewer write through it", async () => {
    // The name says read-only; it must not become a write bypass just because
    // the allow-list it was built from happened to mention a viewer role.
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const res = await call("/api/accountant/_read-only", {
      method: "POST",
      body: {},
      bearer: signOrgToken(viewer),
    });
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canEdit");
  });
});

/* ================================================================== */
/* 4. Account and organisation state is checked, every request         */
/* ================================================================== */

describe("session validity on the legacy routes", () => {
  test("a deactivated user is rejected", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(user);
    await Acc_User.updateOne({ _id: user._id }, { $set: { isActive: false } });

    const res = await call("/api/accountant/vouchers", { bearer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("a deactivated organisation is rejected", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(user);
    await Acc_Organization.updateOne(
      { _id: org._id },
      { $set: { isActive: false } },
    );

    const res = await call("/api/accountant/vouchers", { bearer });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ORGANIZATION_INACTIVE");
  });

  test("a stale token version is rejected (logout-all)", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(user);
    await Acc_User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

    const res = await call("/api/accountant/vouchers", { bearer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("a token naming an organisation the user does not belong to is rejected", async () => {
    const home = await makeOrg();
    const other = await makeOrg();
    const user = await makeUser(home, { role: "owner" });

    const forged = jwt.sign(
      {
        id: String(user._id),
        organizationId: String(other._id),
        role: "owner",
        tokenVersion: 0,
      },
      SECRET,
      { expiresIn: "24h" },
    );

    const res = await call("/api/accountant/vouchers", { bearer: forged });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });

  test("a deleted user is rejected", async () => {
    const org = await makeOrg();
    const user = await makeUser(org, { role: "owner" });
    const bearer = signOrgToken(user);
    await Acc_User.deleteOne({ _id: user._id });

    const res = await call("/api/accountant/vouchers", { bearer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });
});

/* ================================================================== */
/* 5. Mixed credentials reach these routes too                         */
/* ================================================================== */

describe("a legacy CMS cookie alongside a valid accounting Bearer", () => {
  test("selects the accounting session on a legacy-middleware route", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/_probe/echo", {
      cookies: { auth_token: legacyToken({ role: "admin" }) },
      bearer: signOrgToken(owner),
    });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(String(owner._id));
    expect(res.body.user.isLegacy).toBeUndefined();
  });

  test("and the write goes through as that accounting user, not the legacy one", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });

    const res = await call("/api/accountant/_probe/echo", {
      method: "POST",
      body: {},
      cookies: { auth_token: legacyToken({ role: "admin" }) },
      bearer: signOrgToken(owner),
    });
    expect(res.status).toBe(200);
    expect(res.body.accountantId).toBe(String(owner._id));
  });

  test("a legacy cookie beside a VIEWER's Bearer still cannot write", async () => {
    // The old failure mode in reverse: the legacy cookie must not top up what
    // the accounting session is allowed to do.
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });

    const res = await call("/api/accountant/journal-entries", {
      method: "POST",
      body: {},
      cookies: { auth_token: legacyToken({ role: "admin" }) },
      bearer: signOrgToken(viewer),
    });
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canEdit");
  });
});

/* ================================================================== */
/* 6. The import surface the 39 files depend on                        */
/* ================================================================== */

describe("the module's public surface", () => {
  test("still exports every name the route files import", async () => {
    // Both import styles in use across the 39: destructured, and namespace.
    expect(typeof facade.accountantAuth).toBe("function");
    expect(typeof facade.accountantReadOnlyAuth).toBe("function");
    expect(typeof facade.adminOnlyAuth).toBe("function");
    expect(typeof facade.withCompanyScope).toBe("function");
    expect(typeof facade.logAccountantActivity).toBe("function");
    expect(typeof facade.makeAuth).toBe("function");
    expect(typeof facade.extractToken).toBe("function");
    expect(typeof facade.newRolePermissions).toBe("function");
    // The default export is itself makeAuth — `module.exports = makeAuth`.
    expect(typeof facade).toBe("function");
    expect(facade).toBe(facade.makeAuth);
  });

  test("makeAuth translates legacy allow-lists into capabilities", () => {
    const { requiredCapability } = facade;
    expect(requiredCapability(["admin"], "GET")).toBe("canManageSettings");
    expect(requiredCapability(["admin"], "POST")).toBe("canManageSettings");
    expect(requiredCapability(["accountant", "admin"], "GET")).toBe("canView");
    expect(requiredCapability(["accountant", "admin"], "POST")).toBe("canEdit");
    expect(requiredCapability(["accountant", "admin"], "DELETE")).toBe("canEdit");
    expect(
      requiredCapability(["accountant", "accountant_viewer", "admin"], "GET"),
    ).toBe("canView");
  });

  test("a middleware built from makeAuth authenticates through orgAuth", async () => {
    // Refusing an unauthenticated request with orgAuth's own code is the
    // observable difference between "resolves through orgAuth" and "verifies a
    // JWT of its own".
    const app = express();
    app.use(express.json());
    app.get("/x", facade.makeAuth(["accountant", "admin"]), (req, res) =>
      res.json({ ok: true }),
    );
    const s = await new Promise((r) => {
      const srv = app.listen(0, () => r(srv));
    });
    const port = s.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { Cookie: `auth_token=${legacyToken({ role: "admin" })}` },
    });
    const body = await res.json();
    await new Promise((r) => s.close(r));

    expect(res.status).toBe(401);
    expect(body.code).toBe(UPGRADE);
  });
});
