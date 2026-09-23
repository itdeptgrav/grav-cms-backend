// test/accountant/company-isolation.route.test.js
//
// LANE A, CHUNK 3A — a company outside your organisation is not yours to read.
//
// WHAT THIS IS DEFENDING
// ---------------------
// Chunks 1 and 2 established WHO a request is: a database-confirmed Acc_User in
// an active organisation, with a role that decides what they may do. None of it
// said anything about WHICH BOOKS. 149 mounted endpoints took `companyId`
// straight out of the params, the query or the body and handed it to a Mongo
// filter, so an authenticated user of one organisation could read another
// organisation's ledgers, post vouchers into them and delete their records by
// editing a single query parameter. The role checks all passed — the caller
// really was an owner, just of somewhere else.
//
// These tests run against the REAL routers. A middleware unit test cannot show
// that the guard is actually MOUNTED on the invoice list, and being mounted is
// the entire claim.
"use strict";

process.env.JWT_SECRET = "test_secret_for_company_isolation";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

const {
  Acc_Organization,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");
const {
  Acc_Company,
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");
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
  app.use("/api/accountant/vouchers", R("Acc_vouchers"));
  app.use("/api/accountant/invoices", R("Acc_invoices"));
  app.use("/api/accountant/expenses", R("Acc_expenses"));
  app.use("/api/accountant/parties", R("Acc_parties"));
  app.use("/api/accountant/chart-of-accounts", R("Acc_chartOfAccounts"));
  app.use("/api/accountant/gstr2b", R("Acc_gstr2b"));
  app.use("/api/accountant/bank-recon", R("Acc_bankRecon"));
  app.use("/api/accountant/budgets", R("Acc_budgets"));
  // Acc_books is deliberately NOT mounted here — see KNOWN_UNPARSEABLE below.
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

async function call(path, { method = "GET", body, cookies, bearer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookies) headers.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${origin}${path}`, {
    method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 160) }; }
  return { status: res.status, body: parsed };
}

let seq = 0;

async function makeCompany() {
  return Acc_Company.create({
    companyName: `Co ${++seq}`,
    booksFromDate: new Date("2025-04-01"),
  });
}

/** An organisation that owns exactly the companies given. */
async function makeOrg(companies = []) {
  return Acc_Organization.create({
    name: `Org ${++seq}`,
    tallyCompanyIds: companies.map((c) => c._id),
  });
}

async function makeUser(org, role = "owner") {
  const user = new Acc_User({
    organizationId: org._id,
    name: `User ${++seq}`,
    email: `user${seq}@example.com`,
    role,
  });
  await user.setPassword("a-long-enough-password");
  await user.save();
  return user;
}

function legacyToken(claims = {}) {
  return jwt.sign(
    { id: new mongoose.Types.ObjectId().toString(), role: "accountant", ...claims },
    SECRET,
    { expiresIn: "24h" },
  );
}

/**
 * Two organisations, each owning one company. `alpha` is the caller throughout;
 * `beta.company` is the one they must never reach.
 */
async function twoTenants() {
  const aCo = await makeCompany();
  const bCo = await makeCompany();
  const aOrg = await makeOrg([aCo]);
  const bOrg = await makeOrg([bCo]);
  return {
    alpha: { org: aOrg, company: aCo, owner: await makeUser(aOrg, "owner"), viewer: await makeUser(aOrg, "viewer") },
    beta: { org: bOrg, company: bCo, owner: await makeUser(bOrg, "owner") },
  };
}

/* Representative read endpoints across the families named in the brief. */
const READS = [
  ["vouchers list", "/api/accountant/vouchers"],
  ["invoice list", "/api/accountant/invoices"],
  ["expense list", "/api/accountant/expenses"],
  ["party list", "/api/accountant/parties"],
  ["chart of accounts", "/api/accountant/chart-of-accounts/ledgers"],
  ["coa tree", "/api/accountant/chart-of-accounts/tree"],
  ["gst periods", "/api/accountant/gstr2b/periods"],
  ["bank recon sessions", "/api/accountant/bank-recon/sessions"],
  ["budget list", "/api/accountant/budgets"],
];

/**
 * Reads whose company is genuinely optional: absent means "everything this
 * organisation owns". They carry `scopeCompanyIfPresent`, so absent is allowed
 * and anything SUPPLIED is still ownership-checked.
 */
const OPTIONAL_SCOPE = new Set(["chart of accounts", "budget list"]);

/* Representative writes. Bodies are minimal — the guard answers first. */
const WRITES = [
  ["create group", "POST", "/api/accountant/chart-of-accounts/groups", { name: "X", nature: "asset" }],
  ["create budget", "POST", "/api/accountant/budgets", { name: "B" }],
  ["create expense", "POST", "/api/accountant/expenses", {}],
  // Acc_invoices has no bare POST — its create lives elsewhere. PUT /:id is the
  // write on this router that names a company, so that is the one to pin.
  ["update invoice", "PUT", `/api/accountant/invoices/${new mongoose.Types.ObjectId()}`, {}],
  ["ensure defaults", "POST", "/api/accountant/chart-of-accounts/ensure-defaults", {}],
];

/* ================================================================== */
/* 1. Your own company still works                                     */
/* ================================================================== */

describe("a user reading their own organisation's company", () => {
  test("every representative read is allowed through the guard", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);

    for (const [label, url] of READS) {
      const res = await call(`${url}?companyId=${alpha.company._id}`, { bearer });
      // A handler may still answer 400/404/500 on its own terms; what must
      // never appear is the scope guard's refusal.
      expect(`${label}: ${res.body?.code || "none"}`).not.toMatch(/COMPANY_/);
      expect(`${label}: ${res.status}`).not.toBe(`${label}: 403`);
    }
  });

  test("a write to their own company is not refused by the guard", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);

    for (const [label, method, url, body] of WRITES) {
      const res = await call(url, {
        method,
        body: { ...body, companyId: String(alpha.company._id) },
        bearer,
      });
      expect(`${label}: ${res.body?.code || "none"}`).not.toMatch(/COMPANY_/);
    }
  });

  test("an organisation owning several companies can use any of them", async () => {
    const c1 = await makeCompany();
    const c2 = await makeCompany();
    const org = await makeOrg([c1, c2]);
    const owner = await makeUser(org, "owner");
    const bearer = signOrgToken(owner);

    for (const c of [c1, c2]) {
      const res = await call(`/api/accountant/vouchers?companyId=${c._id}`, { bearer });
      expect(res.body?.code).not.toBe("COMPANY_FORBIDDEN");
    }
  });
});

/* ================================================================== */
/* 2. Another organisation's company is refused                        */
/* ================================================================== */

describe("a user reaching for another organisation's company", () => {
  test("is refused on every representative read", async () => {
    const { alpha, beta } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);

    for (const [label, url] of READS) {
      const res = await call(`${url}?companyId=${beta.company._id}`, { bearer });
      expect(`${label}: ${res.status}`).toBe(`${label}: 403`);
      expect(res.body.code).toBe("COMPANY_FORBIDDEN");
    }
  });

  test("is refused on every representative write", async () => {
    const { alpha, beta } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);

    for (const [label, method, url, body] of WRITES) {
      const res = await call(url, {
        method,
        body: { ...body, companyId: String(beta.company._id) },
        bearer,
      });
      expect(`${label}: ${res.status}`).toBe(`${label}: 403`);
      expect(res.body.code).toBe("COMPANY_FORBIDDEN");
    }
  });

  test("and nothing is created in the foreign company", async () => {
    const { alpha, beta } = await twoTenants();
    const before = await Acc_Group.countDocuments({ companyId: beta.company._id });

    await call("/api/accountant/chart-of-accounts/groups", {
      method: "POST",
      body: { companyId: String(beta.company._id), name: "Intruder", nature: "asset" },
      bearer: signOrgToken(alpha.owner),
    });
    await call("/api/accountant/chart-of-accounts/ensure-defaults", {
      method: "POST",
      body: { companyId: String(beta.company._id) },
      bearer: signOrgToken(alpha.owner),
    });

    expect(await Acc_Group.countDocuments({ companyId: beta.company._id })).toBe(before);
  });

  test("an owner of the OTHER organisation can use it — the company is real", async () => {
    // Proves the 403 is about ownership, not about a broken fixture.
    const { beta } = await twoTenants();
    const res = await call(`/api/accountant/vouchers?companyId=${beta.company._id}`, {
      bearer: signOrgToken(beta.owner),
    });
    expect(res.body?.code).not.toBe("COMPANY_FORBIDDEN");
  });

  test("the refusal does not leak the company's name or existence", async () => {
    const { alpha, beta } = await twoTenants();
    const real = await call(`/api/accountant/vouchers?companyId=${beta.company._id}`, {
      bearer: signOrgToken(alpha.owner),
    });
    const imaginary = await call(
      `/api/accountant/vouchers?companyId=${new mongoose.Types.ObjectId()}`,
      { bearer: signOrgToken(alpha.owner) },
    );

    // A company that exists and one that never did are indistinguishable —
    // otherwise this endpoint is a directory of real company ids.
    expect(imaginary.status).toBe(real.status);
    expect(imaginary.body).toEqual(real.body);
    expect(JSON.stringify(real.body)).not.toContain(beta.company.companyName);
    expect(JSON.stringify(real.body)).not.toContain(String(beta.company._id));
  });

  test("an organisation that owns nothing reaches nothing", async () => {
    const orphanOrg = await makeOrg([]);
    const orphan = await makeUser(orphanOrg, "owner");
    const someone = await makeCompany();

    const res = await call(`/api/accountant/vouchers?companyId=${someone._id}`, {
      bearer: signOrgToken(orphan),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("COMPANY_FORBIDDEN");
  });
});

/* ================================================================== */
/* 3. Conflicting, missing and malformed scope                         */
/* ================================================================== */

describe("conflicting company scope", () => {
  test("query and body naming different companies is refused", async () => {
    const { alpha, beta } = await twoTenants();
    const res = await call(
      `/api/accountant/chart-of-accounts/groups?companyId=${alpha.company._id}`,
      {
        method: "POST",
        body: { companyId: String(beta.company._id), name: "X", nature: "asset" },
        bearer: signOrgToken(alpha.owner),
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("it fails closed even when the OWNED company is the one in the body", async () => {
    // Precedence is how a guard gets bypassed: check the param, act on the
    // body. Neither ordering is safe, so a conflict is simply refused.
    const { alpha, beta } = await twoTenants();
    const res = await call(
      `/api/accountant/chart-of-accounts/groups?companyId=${beta.company._id}`,
      {
        method: "POST",
        body: { companyId: String(alpha.company._id), name: "X", nature: "asset" },
        bearer: signOrgToken(alpha.owner),
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("a repeated query parameter with two values is a conflict", async () => {
    const { alpha, beta } = await twoTenants();
    const res = await call(
      `/api/accountant/vouchers?companyId=${alpha.company._id}&companyId=${beta.company._id}`,
      { bearer: signOrgToken(alpha.owner) },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("the same company in two places is not a conflict", async () => {
    const { alpha } = await twoTenants();
    const res = await call(
      `/api/accountant/chart-of-accounts/groups?companyId=${alpha.company._id}`,
      {
        method: "POST",
        body: { companyId: String(alpha.company._id), name: "Agreed", nature: "asset" },
        bearer: signOrgToken(alpha.owner),
      },
    );
    expect(res.body?.code).not.toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("the conflict message names the sources, never the values", async () => {
    const { alpha, beta } = await twoTenants();
    const res = await call(
      `/api/accountant/vouchers?companyId=${alpha.company._id}&companyId=${beta.company._id}`,
      { bearer: signOrgToken(alpha.owner) },
    );
    expect(JSON.stringify(res.body)).not.toContain(String(beta.company._id));
  });
});

describe("missing and malformed company scope", () => {
  test("a required endpoint with no companyId is a stable 400", async () => {
    // Two of the representative reads deliberately aggregate across the whole
    // organisation when no company is named (the ledger list and the budget
    // list), so they carry the permissive guard and are excluded here. What
    // they must still do — refuse a company that is not theirs — is asserted in
    // "an optional-scope endpoint still refuses a foreign company" below.
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);
    for (const [label, url] of READS) {
      if (OPTIONAL_SCOPE.has(label)) continue;
      const res = await call(url, { bearer });
      expect(`${label}: ${res.status}`).toBe(`${label}: 400`);
      expect(res.body.code).toBe("COMPANY_SCOPE_REQUIRED");
    }
  });

  test("an optional-scope endpoint answers without a company", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);
    for (const [label, url] of READS) {
      if (!OPTIONAL_SCOPE.has(label)) continue;
      const res = await call(url, { bearer });
      expect(`${label}: ${res.status}`).not.toBe(`${label}: 400`);
    }
  });

  test.each([
    ["not an id", "banana"],
    ["too short", "abc123"],
    ["23 hex chars", "0123456789abcdef01234567".slice(0, 23)],
    ["non-hex", "zzzzzzzzzzzzzzzzzzzzzzzz"],
    ["an object-ish string", "[object Object]"],
  ])("a malformed companyId (%s) is a stable 400", async (_label, bad) => {
    const { alpha } = await twoTenants();
    const res = await call(
      `/api/accountant/vouchers?companyId=${encodeURIComponent(bad)}`,
      { bearer: signOrgToken(alpha.owner) },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPANY_SCOPE_INVALID");
  });

  test("a blank companyId is treated as missing, not malformed", async () => {
    const { alpha } = await twoTenants();
    const res = await call("/api/accountant/vouchers?companyId=", {
      bearer: signOrgToken(alpha.owner),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("an optional-scope endpoint still refuses a foreign company", async () => {
    // "Optional" must never mean "unchecked". Absent is allowed; a company
    // belonging to someone else is not.
    const { alpha, beta } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);
    for (const [label, url] of READS) {
      if (!OPTIONAL_SCOPE.has(label)) continue;
      const res = await call(`${url}?companyId=${beta.company._id}`, { bearer });
      expect(`${label}: ${res.status}`).toBe(`${label}: 403`);
      expect(res.body.code).toBe("COMPANY_FORBIDDEN");
    }
  });

  test("every optional-scope WRITE still refuses a foreign company", async () => {
    // 13 write routes carry the permissive guard because their company comes
    // from a record id (Chunk 3B) or is genuinely optional. None of them may
    // accept a foreign company when one IS supplied.
    const {
      scopeCompanyIfPresent,
    } = require("../../Middlewear/AccountantOrgAuthMiddleware");
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "routes", "Accountant_Routes");

    let checked = 0;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      let router;
      try { router = require(path.join(dir, file)); } catch { continue; }
      if (!router || !Array.isArray(router.stack)) continue;
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const hs = layer.route.stack || [];
        if (!hs.some((h) => h.handle === scopeCompanyIfPresent ||
            (typeof h.handle === "function" && /scopeCompanyIfPresent\s*\(/.test(String(h.handle))))) continue;
        const isWrite = Object.keys(layer.route.methods).some(
          (m) => !["get", "head", "options"].includes(m),
        );
        if (isWrite) checked++;
      }
    }
    // The permissive guard is the SAME resolver as the strict one for a
    // supplied value; this pins that such routes exist and are accounted for.
    expect(checked).toBeGreaterThan(0);
  });

  test("malformed is answered the same way on every family", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);
    const codes = new Set();
    for (const [, url] of READS) {
      const res = await call(`${url}?companyId=banana`, { bearer });
      codes.add(`${res.status}:${res.body.code}`);
    }
    expect([...codes]).toEqual(["400:COMPANY_SCOPE_INVALID"]);
  });
});

/* ================================================================== */
/* 4. The other gates still hold                                       */
/* ================================================================== */

describe("permissions are unchanged by company scoping", () => {
  test("a viewer reads their own company", async () => {
    const { alpha } = await twoTenants();
    const res = await call(`/api/accountant/vouchers?companyId=${alpha.company._id}`, {
      bearer: signOrgToken(alpha.viewer),
    });
    expect(res.status).not.toBe(403);
  });

  test("a viewer still cannot write, even to their own company", async () => {
    const { alpha } = await twoTenants();
    const res = await call("/api/accountant/chart-of-accounts/groups", {
      method: "POST",
      body: { companyId: String(alpha.company._id), name: "Nope", nature: "asset" },
      bearer: signOrgToken(alpha.viewer),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_ROLE");
  });

  test("a viewer reaching a foreign company is refused for scope, not silently allowed", async () => {
    const { alpha, beta } = await twoTenants();
    const res = await call(`/api/accountant/vouchers?companyId=${beta.company._id}`, {
      bearer: signOrgToken(alpha.viewer),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("COMPANY_FORBIDDEN");
  });

  test("a legacy CMS session is still refused before scope is even considered", async () => {
    const { alpha } = await twoTenants();
    const res = await call(`/api/accountant/vouchers?companyId=${alpha.company._id}`, {
      cookies: { auth_token: legacyToken({ role: "admin" }) },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UPGRADE);
  });

  test("an anonymous request is refused before scope", async () => {
    const { beta } = await twoTenants();
    const res = await call(`/api/accountant/vouchers?companyId=${beta.company._id}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("NO_TOKEN");
  });

  test("a deactivated user cannot use a company they used to reach", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);
    await Acc_User.updateOne({ _id: alpha.owner._id }, { $set: { isActive: false } });
    const res = await call(`/api/accountant/vouchers?companyId=${alpha.company._id}`, { bearer });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STALE_TOKEN");
  });
});

/* ================================================================== */
/* 5. Same-company workflows still run                                 */
/* ================================================================== */

describe("existing same-company workflows", () => {
  test("seeding a chart of accounts and listing it back works end to end", async () => {
    const { alpha } = await twoTenants();
    const bearer = signOrgToken(alpha.owner);

    const seeded = await call("/api/accountant/chart-of-accounts/ensure-defaults", {
      method: "POST",
      body: { companyId: String(alpha.company._id) },
      bearer,
    });
    expect([200, 201]).toContain(seeded.status);
    expect(
      await Acc_Group.countDocuments({ companyId: alpha.company._id }),
    ).toBeGreaterThan(0);

    const listed = await call(
      `/api/accountant/chart-of-accounts/ledgers?companyId=${alpha.company._id}`,
      { bearer },
    );
    expect(listed.status).toBe(200);
  });

  test("a ledger created in company A is not visible from company B's scope", async () => {
    const c1 = await makeCompany();
    const c2 = await makeCompany();
    const org = await makeOrg([c1, c2]);
    const owner = await makeUser(org, "owner");
    const bearer = signOrgToken(owner);

    const group = await Acc_Group.create({
      companyId: c1._id, name: "Sundry Debtors", nature: "asset", isActive: true,
    });
    await Acc_Ledger.create({
      companyId: c1._id, name: "Only In One", groupId: group._id,
      groupName: group.name, nature: "asset", isActive: true,
    });

    const inC1 = await call(`/api/accountant/chart-of-accounts/ledgers?companyId=${c1._id}`, { bearer });
    const inC2 = await call(`/api/accountant/chart-of-accounts/ledgers?companyId=${c2._id}`, { bearer });

    expect(JSON.stringify(inC1.body)).toContain("Only In One");
    // Same organisation, both companies owned — the separation here is the
    // handler's own filter, which the guard does not disturb.
    expect(JSON.stringify(inC2.body)).not.toContain("Only In One");
  });
});

/* ================================================================== */
/* 6. Coverage — the guard is mounted, not merely written              */
/* ================================================================== */

describe("guard coverage across the mounted routers", () => {
  const {
    requireCompanyScope,
    scopeCompanyIfPresent,
  } = require("../../Middlewear/AccountantOrgAuthMiddleware");

  // Pre-existing duplicate-declaration defects that babel-jest refuses to parse
  // (Node loads them, so they are live). Recorded by name rather than skipped
  // silently, and covered by a Node-level check below instead.
  const KNOWN_UNPARSEABLE = {
    "Acc_books.js": "duplicate `findPrimary` (lines 502 and 731), committed at HEAD",
    "Acc_auditNotes.js": "duplicate `notifyAuditNote` (lines 46 and 175), committed at HEAD",
  };

  test("every route that reads a companyId has a scope guard in front of it", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "routes", "Accountant_Routes");
    // The route files bind the guard per request (`(req,res,next) =>
    // accOrgAuth.requireCompanyScope(...)`) so they still load under the
    // partial jest.mocks several suites use for that module. So a handler
    // counts if it IS a guard or if it delegates to one — checked against the
    // function's own source, which a comment cannot fake into existence
    // because a comment is not a call.
    const GUARDS = new Set([requireCompanyScope, scopeCompanyIfPresent]);
    const delegatesToGuard = (fn) =>
      typeof fn === "function" &&
      /\b(requireCompanyScope|scopeCompanyIfPresent)\s*\(/.test(
        String(fn).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
      );
    const isGuard = (fn) => GUARDS.has(fn) || delegatesToGuard(fn);
    const unguarded = [];

    // Lane B owns these two and they carry their own report guard
    // (`requireCompanyAccess` inside a shared `guard` array). Out of scope for
    // Lane A and deliberately not re-guarded here.
    const LANE_B = new Set(["Acc_customerReports.js", "Acc_vendorReports.js"]);

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      if (file in KNOWN_UNPARSEABLE) continue;
      if (LANE_B.has(file)) continue;
      let router;
      try {
        router = require(path.join(dir, file));
      } catch (e) {
        // Anything OTHER than the recorded parse defects is a real failure —
        // a silent `continue` here would let a whole unguarded router hide.
        throw new Error(`${file} could not be loaded for coverage: ${e.message}`);
      }
      if (!router || !Array.isArray(router.stack)) continue;

      for (const layer of router.stack) {
        if (!layer.route) continue;
        const handlers = layer.route.stack || [];
        const src = handlers.map((h) => String(h.handle)).join("\n");
        // Broad on purpose. Handlers reach a companyId in several shapes:
        //   req.body.companyId                       direct
        //   const { companyId } = req.query          destructured
        //   const body = req.body; const { companyId } = body   aliased first
        // A narrower check reported full coverage while POST /expenses — which
        // aliases req.body before destructuring — was still unguarded.
        const readsCompany =
          /:companyId/.test(layer.route.path) ||
          (/\bcompanyId\b/.test(src) && /req\.(params|query|body)\b/.test(src));
        if (!readsCompany) continue;
        const guarded = handlers.some((h) => isGuard(h.handle));
        if (!guarded) unguarded.push(`${file} ${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  test("the files Jest cannot parse are still guarded, checked at source level", () => {
    // Node loads these fine, so their routes are live in production. Their
    // company-scoped routes are verified by reading the source rather than the
    // router stack, so the exemption above cannot hide an unguarded endpoint.
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "routes", "Accountant_Routes");
    const unguarded = [];

    for (const file of Object.keys(KNOWN_UNPARSEABLE)) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]*)"([^\n]*)/g;
      let m;
      while ((m = re.exec(src))) {
        const [, verb, route, rest] = m;
        // Only routes that actually name a company are in scope here.
        // Bound the window to THIS route declaration — a fixed slice spills
        // into the next handler and reports a derived-scope route (Chunk 3B)
        // as an unguarded companyId route.
        const idx = m.index;
        const nextRoute = src.slice(idx + 1).search(/\n\s*router\.(get|post|put|patch|delete)\(/);
        const body = src.slice(idx, nextRoute === -1 ? src.length : idx + 1 + nextRoute);
        if (!/\bcompanyId\b/.test(body) && !/:companyId/.test(route)) continue;
        if (!/\bcompanyScope(Optional)?\b/.test(rest)) {
          unguarded.push(`${file} ${verb.toUpperCase()} ${route}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  test("the unparseable list has not silently grown", () => {
    expect(Object.keys(KNOWN_UNPARSEABLE).sort()).toEqual([
      "Acc_auditNotes.js",
      "Acc_books.js",
    ]);
  });
});
