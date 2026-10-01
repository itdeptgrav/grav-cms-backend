// test/accountant/company-list-scoping.route.test.js
//
// THE COMPANY PICKER MAY ONLY OFFER COMPANIES THE GUARD WILL ALLOW.
//
// ── THE BUG THIS PINS ────────────────────────────────────────────────────────
// `GET /api/accountant/tally/companies` answered `find({ isActive: true })` —
// every active company in the deployment, to any authenticated organisation
// user. Every OTHER endpoint was correct: `resolveCompanyScope` refuses a
// company outside `tallyCompanyIds` with 403 COMPANY_FORBIDDEN, and did.
//
// The result was an accountant dashboard that could not be used at all. The
// picker selected a company from the unscoped list, stored it, and every
// subsequent request came back "This company is not available to your
// organization" — an error the user could not clear by reloading, because the
// list it came from kept offering the same company back.
//
// So what is asserted here is an agreement between two endpoints: whatever the
// list returns, the scope guard must accept. A test that only checked the list
// for foreign names would pass on a list that was scoped by some SECOND rule
// that happened to differ from `tallyCompanyIds` — which is the same class of
// bug one layer down. The agreement is asserted directly, per company.
//
// These run against the REAL router and the REAL middleware, with real signed
// organisation tokens. A unit test of the handler could not show that the
// scoping survives the router's own two gates.
"use strict";

process.env.JWT_SECRET = "test_secret_for_company_list_scoping";
/* Read at module load by AccountantOrgAuthMiddleware, so it has to be set
   before the requires below. The dev bypass has its own suite —
   company-list-dev-bypass.route.test.js — because it cannot be turned on and
   off within one process. */
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");

const {
  Acc_Organization,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");
const {
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");

let server;
let origin;
let warnSpy;

beforeAll(async () => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/tally/companies",
    require("../../routes/Accountant_Routes/Acc_companies"),
  );
  /* Mounted so the list's promise can be checked against the guard that
     actually refuses. The ledgers endpoint is company-scoped through the same
     `resolveCompanyScope` every accounting read uses. */
  app.use(
    "/api/accountant/chart-of-accounts",
    require("../../routes/Accountant_Routes/Acc_chartOfAccounts"),
  );
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

async function call(path, { bearer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${origin}${path}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body };
}

const listFor = (bearer) =>
  call("/api/accountant/tally/companies", { bearer });

let seq = 0;

async function makeOrg() {
  return Acc_Organization.create({ name: `Org ${++seq}`, tallyCompanyIds: [] });
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

/**
 * A company, optionally assigned to an organisation.
 *
 * Assignment goes through `$addToSet` on `tallyCompanyIds` — the canonical
 * ownership record, and the same write path
 * services/accountantCompanyOwnership.service.js documents. Nothing here
 * invents a second way to own a company.
 */
async function makeCompany(name, org = null, over = {}) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
    ...over,
  });
  if (org) {
    await Acc_Organization.updateOne(
      { _id: org._id },
      { $addToSet: { tallyCompanyIds: company._id } },
    );
  }
  return company;
}

const namesIn = (body) => (body.companies || []).map((c) => c.companyName).sort();
const idsIn = (body) => (body.companies || []).map((c) => String(c._id));

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. One organisation cannot see another's companies
 * ══════════════════════════════════════════════════════════════════════════ */

describe("organisation isolation", () => {
  test("Organisation A's list holds A's companies and none of B's", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const owner = await makeUser(a);
    const mine = await makeCompany("ALPHA TEXTILES PVT LTD", a);
    const theirs = await makeCompany("BETA GARMENTS PVT LTD", b);

    const res = await listFor(signOrgToken(owner));

    expect(res.status).toBe(200);
    expect(namesIn(res.body)).toEqual(["ALPHA TEXTILES PVT LTD"]);
    expect(idsIn(res.body)).toEqual([String(mine._id)]);
    expect(res.body.count).toBe(1);

    // Not merely absent from the names — absent from the response entirely.
    // A company's GSTIN, PAN, CIN and registered address travel in these rows.
    expect(JSON.stringify(res.body)).not.toContain("BETA GARMENTS");
    expect(JSON.stringify(res.body)).not.toContain(String(theirs._id));
  });

  test("the reverse direction too — neither organisation is privileged", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await makeCompany("ALPHA TEXTILES PVT LTD", a);
    await makeCompany("BETA GARMENTS PVT LTD", b);

    const fromB = await listFor(signOrgToken(await makeUser(b)));
    expect(namesIn(fromB.body)).toEqual(["BETA GARMENTS PVT LTD"]);
  });

  test("an UNASSIGNED company belongs to nobody and appears in no list", async () => {
    /* The state the deployment is actually in when this breaks: a company
       exists, no organisation holds it. Before the fix every organisation saw
       it; the guard then refused it on the next request. */
    const a = await makeOrg();
    await makeCompany("ALPHA TEXTILES PVT LTD", a);
    await makeCompany("ORPHANED COMPANY PVT LTD"); // no org

    const res = await listFor(signOrgToken(await makeUser(a)));
    expect(namesIn(res.body)).toEqual(["ALPHA TEXTILES PVT LTD"]);
    expect(JSON.stringify(res.body)).not.toContain("ORPHANED");
  });

  test("every role reads the same scoped list — this is not a permission", async () => {
    // Scope is not seniority. An owner of A is no more entitled to B's books
    // than a viewer of A is.
    const a = await makeOrg();
    const b = await makeOrg();
    await makeCompany("ALPHA TEXTILES PVT LTD", a);
    await makeCompany("BETA GARMENTS PVT LTD", b);

    for (const role of ["owner", "approver", "editor", "viewer"]) {
      const res = await listFor(signOrgToken(await makeUser(a, role)));
      expect(res.status).toBe(200);
      expect(namesIn(res.body)).toEqual(["ALPHA TEXTILES PVT LTD"]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. The list and the guard agree
 * ══════════════════════════════════════════════════════════════════════════ */

describe("whatever the list offers, the company-scope guard accepts", () => {
  test("every listed company is usable, and an unlisted one is refused", async () => {
    /* THE ACTUAL CLAIM. The dashboard's failure was not that the list was
       wrong in isolation — it was that the list and the guard disagreed. */
    const a = await makeOrg();
    const b = await makeOrg();
    const owner = await makeUser(a);
    const bearer = signOrgToken(owner);

    await makeCompany("ALPHA ONE PVT LTD", a);
    await makeCompany("ALPHA TWO PVT LTD", a);
    const foreign = await makeCompany("BETA GARMENTS PVT LTD", b);

    const list = await listFor(bearer);
    expect(idsIn(list.body)).toHaveLength(2);

    for (const companyId of idsIn(list.body)) {
      const scoped = await call(
        `/api/accountant/chart-of-accounts/ledgers?companyId=${companyId}`,
        { bearer },
      );
      expect(scoped.status).not.toBe(403);
      expect(scoped.body?.code).not.toBe("COMPANY_FORBIDDEN");
    }

    // And the company that is NOT on the list is exactly the one that 403s —
    // the error the user was seeing.
    const refused = await call(
      `/api/accountant/chart-of-accounts/ledgers?companyId=${foreign._id}`,
      { bearer },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("COMPANY_FORBIDDEN");
    expect(refused.body.message).toMatch(/not available to your organization/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Inactive companies
 * ══════════════════════════════════════════════════════════════════════════ */

describe("inactive companies", () => {
  test("a soft-deleted company is excluded even though the org still holds it", async () => {
    /* `DELETE /:id` is a soft delete — it clears `isActive` and leaves the id
       in `tallyCompanyIds`. Ownership and activity are two different
       questions and the list has to answer both. */
    const a = await makeOrg();
    await makeCompany("ALPHA ACTIVE PVT LTD", a);
    const dead = await makeCompany("ALPHA CLOSED PVT LTD", a, { isActive: false });

    const org = await Acc_Organization.findById(a._id).lean();
    expect(org.tallyCompanyIds.map(String)).toContain(String(dead._id));

    const res = await listFor(signOrgToken(await makeUser(a)));
    expect(namesIn(res.body)).toEqual(["ALPHA ACTIVE PVT LTD"]);
    expect(res.body.count).toBe(1);
  });

  test("an organisation whose every company is inactive gets an empty list", async () => {
    const a = await makeOrg();
    await makeCompany("ALPHA CLOSED PVT LTD", a, { isActive: false });

    const res = await listFor(signOrgToken(await makeUser(a)));
    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. No companies assigned
 * ══════════════════════════════════════════════════════════════════════════ */

describe("an organisation with nothing assigned", () => {
  test("gets an empty list and a 200 — not an error, and not everything", async () => {
    /* The two wrong answers here are opposite and both plausible: fall back to
       "all companies" (the bug), or refuse the request (which would read as a
       broken dashboard rather than an unconfigured one). An empty list is what
       lets the frontend clear its stored selection. */
    const a = await makeOrg();
    await makeCompany("SOMEBODY ELSES CO PVT LTD", await makeOrg());
    await makeCompany("ANOTHER UNASSIGNED CO PVT LTD");

    const res = await listFor(signOrgToken(await makeUser(a)));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.companies).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("an organisation with no tallyCompanyIds field at all behaves the same", async () => {
    // Older organisation documents predate the field.
    const a = await Acc_Organization.create({ name: `Org ${++seq}` });
    await Acc_Organization.updateOne({ _id: a._id }, { $unset: { tallyCompanyIds: 1 } });
    await makeCompany("SOMEBODY ELSES CO PVT LTD", await makeOrg());

    const res = await listFor(signOrgToken(await makeUser(a)));
    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. The permitted companies stay visible, in full
 * ══════════════════════════════════════════════════════════════════════════ */

describe("an organisation's own companies are unaffected", () => {
  test("all of them are returned, primary first, with their stats", async () => {
    /* Narrowing a list is easy to overdo. The fix must not cost the
       organisation companies it does own, the ordering the picker relies on,
       or the fields the screen renders. */
    const a = await makeOrg();
    await makeCompany("ALPHA ORDINARY PVT LTD", a);
    await makeCompany("ALPHA PRIMARY PVT LTD", a, { isPrimary: true });
    await makeCompany("ALPHA THIRD PVT LTD", a);

    const res = await listFor(signOrgToken(await makeUser(a)));

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.companies[0].companyName).toBe("ALPHA PRIMARY PVT LTD");
    expect(res.body.companies[0].isPrimary).toBe(true);
    // `stats.groupCount` is computed per row and the screen reads it.
    for (const c of res.body.companies) {
      expect(c.stats).toEqual({ groupCount: 0 });
      expect(c.booksFromDate).toBeTruthy();
    }
  });

  test("a company assigned to the organisation AFTER a first read shows up", async () => {
    // The ownership repair path: assign, reload, it is there. No caching.
    const a = await makeOrg();
    const bearer = signOrgToken(await makeUser(a));

    const before = await listFor(bearer);
    expect(before.body.companies).toEqual([]);

    await makeCompany("ALPHA TEXTILES PVT LTD", a);

    const after = await listFor(bearer);
    expect(namesIn(after.body)).toEqual(["ALPHA TEXTILES PVT LTD"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. The list still needs a session
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the existing session requirement is unchanged", () => {
  test("no session is still refused, not answered with an empty list", async () => {
    await makeCompany("ALPHA TEXTILES PVT LTD", await makeOrg());
    const res = await listFor(undefined);
    expect(res.status).toBe(401);
    expect(res.body.companies).toBeUndefined();
  });
});
