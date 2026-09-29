// test/accountant/companies-and-mutating-gets.route.test.js
//
// LANE A, CHUNK 2 CORRECTION — two holes the façade migration did not close.
//
// 1. `Acc_companies.js` opened its own gate with
//    `if (req.method === "GET") return next();`, mounted ABOVE the only call to
//    `accountantAuth` in the router. Every read was therefore public: the
//    company list, a company's detail, its document index, its document links
//    and its file downloads, all served with no session at all. Company records
//    carry GSTIN, PAN, CIN, registered address and contacts.
//
// 2. The façade derives the required capability from the HTTP METHOD — right
//    for almost every route, and wrong for a GET that writes. Accounting has
//    several: "resolve the sales ledger" creates the ledger when it is missing,
//    and reactivates it when it has been deactivated. A Viewer could create and
//    revive accounting objects by loading a page.
//
// These tests run against the REAL routers.
"use strict";

process.env.JWT_SECRET = "test_secret_for_companies_and_gets";
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
  app.use("/api/accountant/companies", R("Acc_companies"));
  app.use("/api/accountant/vouchers", R("Acc_vouchers"));
  app.use("/api/accountant/chart-of-accounts", R("Acc_chartOfAccounts"));
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
    parsed = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body: parsed };
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

/**
 * A company, optionally attached to the organisation that will be asking for
 * it. Lane A Chunk 3A made company scope real: a company that is not in
 * `org.tallyCompanyIds` is now 403 COMPANY_FORBIDDEN for that organisation, so
 * a fixture that creates a detached company no longer models a working setup.
 */
async function makeCompany(org = null) {
  const company = await Acc_Company.create({
    companyName: `Co ${++seq}`,
    booksFromDate: new Date("2025-04-01"),
  });
  if (org) {
    await Acc_Organization.updateOne(
      { _id: org._id },
      { $addToSet: { tallyCompanyIds: company._id } },
    );
  }
  return company;
}

/** A revenue group, so the sales-ledger resolver has somewhere to put one. */
async function seedRevenueGroup(company) {
  return Acc_Group.create({
    companyId: company._id,
    name: "Sales Accounts",
    nature: "revenue",
    isActive: true,
  });
}

function legacyToken(claims = {}) {
  return jwt.sign(
    { id: new mongoose.Types.ObjectId().toString(), role: "accountant", ...claims },
    SECRET,
    { expiresIn: "24h" },
  );
}

/* ================================================================== */
/* 1. Company reads require a session                                  */
/* ================================================================== */

// Every read surface the router exposes. `/document-kinds` is a static list,
// but it sits behind /api/accountant and there is no reason for it to be the
// one endpoint anyone can reach.
function companyReads(companyId, docId = new mongoose.Types.ObjectId()) {
  return [
    ["company list", `/api/accountant/companies`],
    ["company detail", `/api/accountant/companies/${companyId}`],
    ["document kinds", `/api/accountant/companies/document-kinds`],
    ["document index", `/api/accountant/companies/${companyId}/documents`],
    ["document link", `/api/accountant/companies/${companyId}/documents/${docId}/link`],
    ["document download", `/api/accountant/companies/${companyId}/documents/${docId}/download`],
    ["named download", `/api/accountant/companies/${companyId}/documents/${docId}/download/file.pdf`],
  ];
}

describe("company reads with no session", () => {
  test("every read surface is refused", async () => {
    const company = await makeCompany();
    for (const [label, url] of companyReads(company._id)) {
      const res = await call(url);
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe("NO_TOKEN");
    }
  });

  test("no company data leaks in the refusal body", async () => {
    const company = await makeCompany();
    const res = await call(`/api/accountant/companies/${company._id}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(company.companyName);
  });
});

describe("company reads with a legacy CMS session", () => {
  test("every read surface is refused with the upgrade code", async () => {
    const company = await makeCompany();
    const cookies = { auth_token: legacyToken({ role: "admin" }) };
    for (const [label, url] of companyReads(company._id)) {
      const res = await call(url, { cookies });
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe(UPGRADE);
    }
  });
});

describe("company reads with a valid organisation session", () => {
  test("a viewer can still list and open companies", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);
    const bearer = signOrgToken(viewer);

    const list = await call("/api/accountant/companies", { bearer });
    expect(list.status).toBe(200);

    const detail = await call(`/api/accountant/companies/${company._id}`, { bearer });
    expect(detail.status).toBe(200);

    const docs = await call(`/api/accountant/companies/${company._id}/documents`, { bearer });
    expect(docs.status).toBe(200);

    const kinds = await call("/api/accountant/companies/document-kinds", { bearer });
    expect(kinds.status).toBe(200);
  });

  test("an owner can read too", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, { role: "owner" });
    const company = await makeCompany(org);
    const res = await call(`/api/accountant/companies/${company._id}`, {
      bearer: signOrgToken(owner),
    });
    expect(res.status).toBe(200);
  });
});

/* ================================================================== */
/* 2. Company writes stay owner-only                                   */
/* ================================================================== */

describe("company writes", () => {
  test("an owner may create; an editor and a viewer may not", async () => {
    const org = await makeOrg();
    const results = {};
    for (const role of ["owner", "editor", "viewer"]) {
      const user = await makeUser(org, { role });
      const res = await call("/api/accountant/companies", {
        method: "POST",
        body: {
          companyName: `New Co ${role} ${++seq}`,
          booksFromDate: "2025-04-01",
        },
        bearer: signOrgToken(user),
      });
      results[role] = res.status;
    }
    expect(results.owner).toBe(201);
    expect(results.editor).toBe(403);
    expect(results.viewer).toBe(403);
  });

  test("a write with no session is refused before the owner check", async () => {
    const res = await call("/api/accountant/companies", {
      method: "POST",
      body: { companyName: "Anonymous Co", booksFromDate: "2025-04-01" },
    });
    expect(res.status).toBe(401);
    expect(await Acc_Company.countDocuments({ companyName: "Anonymous Co" })).toBe(0);
  });

  test("the default-credit-days route keeps its own weaker permission", async () => {
    // It is excluded from the owner-only gate on purpose: it requires the same
    // credit-terms permission the party-level editor uses, not ownership.
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });
    const company = await makeCompany(org);

    const res = await call(
      `/api/accountant/companies/${company._id}/default-credit-days`,
      { method: "PATCH", body: { defaultCreditDays: 45 }, bearer: signOrgToken(editor) },
    );
    // Not the owner-only 403 — an editor gets through the ownership gate here.
    expect(res.body?.message || "").not.toMatch(/Only the owner/i);
    expect([200, 400, 404]).toContain(res.status);
  });

  test("default-credit-days still requires a session", async () => {
    const company = await makeCompany();
    const res = await call(
      `/api/accountant/companies/${company._id}/default-credit-days`,
      { method: "PATCH", body: { defaultCreditDays: 45 } },
    );
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* 3. Mutating GETs demand canEdit                                     */
/* ================================================================== */

const MUTATING_GETS = [
  ["sales ledgers", "/api/accountant/vouchers/sales-ledgers"],
  ["purchase ledgers", "/api/accountant/vouchers/purchase-ledgers"],
  ["sales returns ledger", "/api/accountant/vouchers/sales-returns-ledger"],
  ["purchase returns ledger", "/api/accountant/vouchers/purchase-returns-ledger"],
  ["roundoff ledger", "/api/accountant/vouchers/roundoff-ledger"],
];

describe("a viewer and the mutating voucher resolvers", () => {
  test("every one is refused with canEdit named", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);
    await seedRevenueGroup(company);
    const bearer = signOrgToken(viewer);

    for (const [label, url] of MUTATING_GETS) {
      const res = await call(`${url}?companyId=${company._id}`, { bearer });
      expect(`${label}: ${res.status}`).toBe(`${label}: 403`);
      expect(res.body.code).toBe("INSUFFICIENT_ROLE");
      expect(res.body.requires).toBe("canEdit");
    }
  });

  test("and no ledger is created, restored or reactivated", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);
    await seedRevenueGroup(company);
    const bearer = signOrgToken(viewer);

    const before = await Acc_Ledger.countDocuments({ companyId: company._id });
    for (const [, url] of MUTATING_GETS) {
      await call(`${url}?companyId=${company._id}`, { bearer });
    }
    expect(await Acc_Ledger.countDocuments({ companyId: company._id })).toBe(before);
  });

  test("a deactivated ledger is not reactivated by a viewer's read", async () => {
    // The reactivation path is the quieter half of the bug: no new row appears,
    // so a count alone would not notice a ledger coming back to life.
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);
    const group = await seedRevenueGroup(company);
    const dormant = await Acc_Ledger.create({
      companyId: company._id,
      name: "Sales — Local",
      groupId: group._id,
      groupName: group.name,
      nature: "revenue",
      isActive: false,
    });

    const res = await call(
      `/api/accountant/vouchers/sales-ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(403);
    expect((await Acc_Ledger.findById(dormant._id)).isActive).toBe(false);
  });

  test("the URLs are unchanged — the refusal is 403, not 404", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);
    for (const [label, url] of MUTATING_GETS) {
      const res = await call(`${url}?companyId=${company._id}`, {
        bearer: signOrgToken(viewer),
      });
      expect(`${label}: ${res.status}`).not.toBe(`${label}: 404`);
    }
  });
});

describe("editors and above keep the existing behaviour", () => {
  test("an editor's read still resolves and creates the ledger", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });
    const company = await makeCompany(org);
    await seedRevenueGroup(company);

    const res = await call(
      `/api/accountant/vouchers/sales-ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(editor) },
    );
    expect(res.status).toBe(200);
    expect(res.body.ledgers.local).toBeTruthy();
    expect(
      await Acc_Ledger.countDocuments({ companyId: company._id, isActive: true }),
    ).toBeGreaterThan(0);
  });

  test("an editor reactivates a dormant ledger, as before", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });
    const company = await makeCompany(org);
    const group = await seedRevenueGroup(company);
    const dormant = await Acc_Ledger.create({
      companyId: company._id,
      name: "Sales — Local",
      groupId: group._id,
      groupName: group.name,
      nature: "revenue",
      isActive: false,
    });

    const res = await call(
      `/api/accountant/vouchers/sales-ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(editor) },
    );
    expect(res.status).toBe(200);
    expect((await Acc_Ledger.findById(dormant._id)).isActive).toBe(true);
  });

  test.each(["approver", "owner"])("an %s is allowed through too", async (role) => {
    const org = await makeOrg();
    const user = await makeUser(org, { role });
    const company = await makeCompany(org);
    await seedRevenueGroup(company);

    const res = await call(
      `/api/accountant/vouchers/roundoff-ledger?companyId=${company._id}`,
      { bearer: signOrgToken(user) },
    );
    expect(res.status).not.toBe(403);
  });

  test("a legacy session is refused before the capability check", async () => {
    const company = await makeCompany();
    const res = await call(
      `/api/accountant/vouchers/sales-ledgers?companyId=${company._id}`,
      { cookies: { auth_token: legacyToken({ role: "admin" }) } },
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UPGRADE);
  });
});

/* ================================================================== */
/* 4. The chart-of-accounts previews that create                       */
/* ================================================================== */

describe("chart-of-accounts previews that write", () => {
  test("a viewer cannot make /parties/preview seed the chart", async () => {
    // doPartiesSync self-heals an empty chart by creating the 28 reserved
    // groups BEFORE it consults its dryRun flag — so a "preview" creates.
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);

    const before = await Acc_Group.countDocuments({ companyId: company._id });
    const res = await call(
      `/api/accountant/chart-of-accounts/parties/preview?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canEdit");
    expect(await Acc_Group.countDocuments({ companyId: company._id })).toBe(before);
  });

  test("a viewer cannot make the payroll preview create ledgers", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);

    const before = await Acc_Ledger.countDocuments({ companyId: company._id });
    const res = await call(
      `/api/accountant/chart-of-accounts/payroll/runs/${new mongoose.Types.ObjectId()}/preview?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canEdit");
    expect(await Acc_Ledger.countDocuments({ companyId: company._id })).toBe(before);
  });

  test("an editor still reaches both", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, { role: "editor" });
    const company = await makeCompany(org);

    const parties = await call(
      `/api/accountant/chart-of-accounts/parties/preview?companyId=${company._id}`,
      { bearer: signOrgToken(editor) },
    );
    expect(parties.status).not.toBe(403);

    const payroll = await call(
      `/api/accountant/chart-of-accounts/payroll/runs/${new mongoose.Types.ObjectId()}/preview?companyId=${company._id}`,
      { bearer: signOrgToken(editor) },
    );
    expect(payroll.status).not.toBe(403);
  });

  test("ordinary chart-of-accounts reads stay open to a viewer", async () => {
    // The point of the change is the writes, not a general downgrade of the
    // Viewer role: the ledger list must still work.
    const org = await makeOrg();
    const viewer = await makeUser(org, { role: "viewer" });
    const company = await makeCompany(org);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
  });
});
