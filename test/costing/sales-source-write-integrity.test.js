// test/costing/sales-source-write-integrity.test.js
//
// Central Costing — Chunk 3B1 write-integrity correction.
//
// ── WHAT THE PREVIOUS PASS PROVED, AND WHAT IT DID NOT ─────────────────────
// Every Account, Lead and Contact query now carries the company, which stops
// one company READING another's records. It says nothing about a record
// CHANGING companies. Two holes survived it:
//
//   • a PATCH body carrying `companyId` — the read that found the record was
//     legitimate (it is mine), and the write hands it to somebody else;
//   • a relationship pointing out of the company — a Contact or Lead under a
//     foreign Account, or a foreign Account as a parent. The record stays mine
//     by ownership and becomes theirs by association, and `.populate()` on the
//     detail page is the first thing that reads the foreign row.
//
// Every foreign case below is preceded by the SAME operation between two
// same-company records, so a refusal proves the boundary rather than proving
// the endpoint was broken for everyone.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Account = require("../../models/CMS_Models/Sales/Account");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const {
  stripCompanyOwnershipInput, withOwnershipMigration, CompanyOwnershipImmutableError,
} = require("../../models/CMS_Models/Sales/companyOwnership");
const { assertNoAccountCycle, HierarchyError } = require("../../services/crmHierarchy");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/accounts", require("../../routes/CMS_Routes/Sales/accounts"));
  app.use("/contacts", require("../../routes/CMS_Routes/Sales/contacts"));
  app.use("/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { global.__ACTOR__ = null; jest.restoreAllMocks(); });

const call = (path_, { method = "GET", body } = {}) =>
  fetch(`${base}${path_}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actorIn(companies = []) {
  const n = ++seq;
  const email = `wri${n}@test.example`;
  const emp = await Employee.create({
    firstName: "W", lastName: `R${n}`, email, biometricId: `WR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "W" });
  }
  return { id: String(emp._id), email, name: "W", role: "sales" };
}

const be = (actor) => { global.__ACTOR__ = actor; };

/** An account owned outright by `co`, created below the API so the fixture
    itself never depends on the endpoint under test. */
const accountIn = (co, extra = {}) =>
  Account.create({
    companyName: `Acct ${++seq}`,
    companyId: co._id,
    companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
    isActive: true,
    ...extra,
  });

/** Two companies, and an actor who is a member of the FIRST only. */
async function twoCompanies() {
  const mine = await company("Mine");
  const theirs = await company("Theirs");
  const actor = await actorIn([mine]);
  be(actor);
  return { mine, theirs, actor };
}

/* ═══ 1–3 · OWNERSHIP CANNOT BE REASSIGNED THROUGH A PATCH ═══════════════ */

describe("ownership is immutable over HTTP", () => {
  test("Account PATCH changes an ordinary field but cannot change companyId or companyOwnership", async () => {
    const { mine, theirs } = await twoCompanies();
    const acct = await accountIn(mine, { companyName: "Original Ltd" });

    // Same-company success first: the endpoint works.
    const ok = await call(`/accounts/${acct._id}`, { method: "PATCH", body: { companyName: "Renamed Ltd" } });
    expect(ok.status).toBe(200);

    const r = await call(`/accounts/${acct._id}`, {
      method: "PATCH",
      body: { companyName: "Hijacked Ltd", companyId: String(theirs._id) },
    });
    expect(r.status).toBe(200); // the ownership key is dropped, not an error

    const stored = await Account.findById(acct._id).lean();
    expect(String(stored.companyId)).toBe(String(mine._id));
    expect(stored.companyName).toBe("Hijacked Ltd"); // the rest of the patch still applied
  });

  test("Account PATCH cannot launder the stamp — whole object or a single nested key", async () => {
    const { mine } = await twoCompanies();
    const acct = await accountIn(mine);

    await call(`/accounts/${acct._id}`, {
      method: "PATCH",
      body: { companyOwnership: { source: "MEMBERSHIP_RECORD", proven: true } },
    });
    await call(`/accounts/${acct._id}`, {
      method: "PATCH",
      body: { "companyOwnership.proven": true, "companyOwnership.source": "FORGED" },
    });

    const stored = await Account.findById(acct._id).lean();
    expect(stored.companyOwnership.source).toBe("MEMBERSHIP_RECORD");
    expect(stored.companyOwnership.proven).toBe(true);
    expect(String(stored.companyId)).toBe(String(mine._id));
  });

  test("Contact PATCH cannot change ownership", async () => {
    const { mine, theirs } = await twoCompanies();
    const created = await call("/contacts", { method: "POST", body: { firstName: "Ana", lastName: "Roy" } });
    expect(created.status).toBe(201);
    const id = created.body.contact._id;

    const ok = await call(`/contacts/${id}`, { method: "PATCH", body: { lastName: "Roy-Sen" } });
    expect(ok.status).toBe(200);

    await call(`/contacts/${id}`, {
      method: "PATCH",
      body: { companyId: String(theirs._id), "companyOwnership.proven": false },
    });

    const stored = await Contact.findById(id).lean();
    expect(String(stored.companyId)).toBe(String(mine._id));
    expect(stored.companyOwnership.proven).toBe(true);
    expect(stored.lastName).toBe("Roy-Sen");
  });

  test("Lead PATCH cannot change ownership", async () => {
    const { mine, theirs } = await twoCompanies();
    const created = await call("/leads", { method: "POST", body: { company: "Prospect Co" } });
    expect(created.status).toBe(201);
    const id = created.body.lead._id;

    const ok = await call(`/leads/${id}`, { method: "PATCH", body: { city: "Pune" } });
    expect(ok.status).toBe(200);

    await call(`/leads/${id}`, {
      method: "PATCH",
      body: { companyId: String(theirs._id), companyOwnership: { source: "FORGED", proven: true } },
    });

    const stored = await Lead.findById(id).lean();
    expect(String(stored.companyId)).toBe(String(mine._id));
    expect(stored.companyOwnership.source).toBe("MEMBERSHIP_RECORD");
    expect(stored.city).toBe("Pune");
  });
});

/* ═══ 10 · CREATION TAKES THE SERVER'S STAMP, NOT THE BODY'S ════════════ */

describe("body-supplied ownership on creation", () => {
  test("Account, Lead and Contact are all stamped from the resolved company", async () => {
    const { mine, theirs } = await twoCompanies();
    const forged = {
      companyId: String(theirs._id),
      companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
    };

    const a = await call("/accounts", { method: "POST", body: { companyName: "Forged Ltd", ...forged } });
    const l = await call("/leads", { method: "POST", body: { company: "Forged Prospect", ...forged } });
    const c = await call("/contacts", { method: "POST", body: { firstName: "Forged", ...forged } });
    expect([a.status, l.status, c.status]).toEqual([201, 201, 201]);

    for (const [Model, id] of [
      [Account, a.body.account._id], [Lead, l.body.lead._id], [Contact, c.body.contact._id],
    ]) {
      const stored = await Model.findById(id).lean();
      expect(String(stored.companyId)).toBe(String(mine._id));
      expect(stored.companyOwnership.source).toBe("MEMBERSHIP_RECORD");
    }
  });
});

/* ═══ 4–5 · CONTACT → ACCOUNT ═══════════════════════════════════════════ */

describe("a Contact's Account", () => {
  test("company A can create a Contact under its OWN Account, but not under company B's", async () => {
    const { mine, theirs } = await twoCompanies();
    const ours = await accountIn(mine);
    const foreign = await accountIn(theirs);

    const ok = await call("/contacts", {
      method: "POST", body: { firstName: "Same", lastName: "Company", accountId: String(ours._id) },
    });
    expect(ok.status).toBe(201);
    expect(String(ok.body.contact.accountId)).toBe(String(ours._id));

    const bad = await call("/contacts", {
      method: "POST", body: { firstName: "Cross", lastName: "Company", accountId: String(foreign._id) },
    });
    expect(bad.status).toBe(404);
    expect(await Contact.countDocuments({ lastName: "Company", firstName: "Cross" })).toBe(0);
  });

  test("a foreign Account and a nonexistent one give the same answer", async () => {
    const { theirs } = await twoCompanies();
    const foreign = await accountIn(theirs);
    const missing = new mongoose.Types.ObjectId();

    const a = await call("/contacts", { method: "POST", body: { firstName: "A", accountId: String(foreign._id) } });
    const b = await call("/contacts", { method: "POST", body: { firstName: "A", accountId: String(missing) } });
    expect(a.status).toBe(b.status);
    expect(a.body.message).toBe(b.body.message);
  });

  test("company A can move a Contact between its own Accounts, but not onto company B's", async () => {
    const { mine, theirs } = await twoCompanies();
    const from = await accountIn(mine);
    const to = await accountIn(mine);
    const foreign = await accountIn(theirs);

    const created = await call("/contacts", {
      method: "POST", body: { firstName: "Mover", accountId: String(from._id) },
    });
    const id = created.body.contact._id;

    const ok = await call(`/contacts/${id}`, { method: "PATCH", body: { accountId: String(to._id) } });
    expect(ok.status).toBe(200);
    expect(String(ok.body.contact.accountId)).toBe(String(to._id));

    const bad = await call(`/contacts/${id}`, {
      method: "PATCH", body: { accountId: String(foreign._id), lastName: "AlsoChanged" },
    });
    expect(bad.status).toBe(404);

    // 11 · a refused relationship changes NOTHING, not even the sibling field.
    const stored = await Contact.findById(id).lean();
    expect(String(stored.accountId)).toBe(String(to._id));
    expect(stored.lastName).toBeFalsy();
  });
});

/* ═══ 6 · LEAD → ACCOUNT ════════════════════════════════════════════════ */

describe("a Lead's Account", () => {
  test("company A can create a Lead under its own Account, but not under company B's", async () => {
    const { mine, theirs } = await twoCompanies();
    const ours = await accountIn(mine);
    const foreign = await accountIn(theirs);

    const ok = await call("/leads", { method: "POST", body: { company: "Own Acct", accountId: String(ours._id) } });
    expect(ok.status).toBe(201);
    expect(String(ok.body.lead.accountId)).toBe(String(ours._id));

    const bad = await call("/leads", { method: "POST", body: { company: "Foreign Acct", accountId: String(foreign._id) } });
    expect(bad.status).toBe(404);
    expect(await Lead.countDocuments({ company: "Foreign Acct" })).toBe(0);
  });

  test("company A can move a Lead to its own Account and clear the link, but not move it to company B's", async () => {
    const { mine, theirs } = await twoCompanies();
    const ours = await accountIn(mine);
    const foreign = await accountIn(theirs);

    const created = await call("/leads", { method: "POST", body: { company: "Linker", city: "Nashik" } });
    const id = created.body.lead._id;

    const ok = await call(`/leads/${id}`, { method: "PATCH", body: { accountId: String(ours._id) } });
    expect(ok.status).toBe(200);
    expect(String(ok.body.lead.accountId)).toBe(String(ours._id));

    const bad = await call(`/leads/${id}`, { method: "PATCH", body: { accountId: String(foreign._id), city: "Moved" } });
    expect(bad.status).toBe(404);

    const afterRefusal = await Lead.findById(id).lean();
    expect(String(afterRefusal.accountId)).toBe(String(ours._id));
    expect(afterRefusal.city).toBe("Nashik"); // 11 · nothing else was saved

    // Clearing an existing link is still allowed.
    const cleared = await call(`/leads/${id}`, { method: "PATCH", body: { accountId: null } });
    expect(cleared.status).toBe(200);
    expect(await Lead.findById(id).lean().then((l) => l.accountId)).toBeFalsy();
  });
});

/* ═══ 7–8 · ACCOUNT HIERARCHY ═══════════════════════════════════════════ */

describe("the Account hierarchy stays inside one company", () => {
  test("a same-company parent is accepted on create and on PATCH; company B's is not", async () => {
    const { mine, theirs } = await twoCompanies();
    const ourParent = await accountIn(mine);
    const foreignParent = await accountIn(theirs);

    const ok = await call("/accounts", {
      method: "POST", body: { companyName: "Child Ltd", parentAccountId: String(ourParent._id) },
    });
    expect(ok.status).toBe(201);
    expect(String(ok.body.account.parentAccountId)).toBe(String(ourParent._id));

    const badCreate = await call("/accounts", {
      method: "POST", body: { companyName: "Foreign Child Ltd", parentAccountId: String(foreignParent._id) },
    });
    expect(badCreate.status).toBe(400);
    expect(await Account.countDocuments({ companyName: "Foreign Child Ltd" })).toBe(0);

    const badPatch = await call(`/accounts/${ok.body.account._id}`, {
      method: "PATCH", body: { parentAccountId: String(foreignParent._id), companyName: "AlsoChanged Ltd" },
    });
    expect(badPatch.status).toBe(400);

    const stored = await Account.findById(ok.body.account._id).lean();
    expect(String(stored.parentAccountId)).toBe(String(ourParent._id));
    expect(stored.companyName).toBe("Child Ltd"); // 11 · nothing else saved either
  });

  test("a foreign parent and a nonexistent parent give the same refusal", async () => {
    const { theirs } = await twoCompanies();
    const foreignParent = await accountIn(theirs);
    const missing = new mongoose.Types.ObjectId();

    const a = await call("/accounts", { method: "POST", body: { companyName: "P1", parentAccountId: String(foreignParent._id) } });
    const b = await call("/accounts", { method: "POST", body: { companyName: "P1", parentAccountId: String(missing) } });
    expect(a.status).toBe(b.status);
    expect(a.body.message).toBe(b.body.message);
  });

  test("the cycle walk stops at a cross-company ancestor instead of traversing it", async () => {
    const mine = await company("WalkMine");
    const theirs = await company("WalkTheirs");
    const child = await accountIn(mine);
    const foreignAncestor = await accountIn(theirs, { parentAccountId: child._id });
    const mid = await accountIn(mine, { parentAccountId: foreignAncestor._id });

    /* The loader the route builds: this company's records only. */
    const loaded = [];
    const loader = async (id) => {
      loaded.push(String(id));
      return Account.findOne({ companyId: mine._id, _id: id }).select("parentAccountId").lean();
    };

    const global_ = jest.spyOn(Account, "findById");
    await expect(assertNoAccountCycle(loader, child._id, mid._id)).resolves.toBeUndefined();

    // It climbed to the foreign node's id, could not load it, and stopped —
    // it never reached `child` through company B, and never read a company-B row.
    expect(loaded).toEqual([String(mid._id), String(foreignAncestor._id)]);
    expect(global_).not.toHaveBeenCalled();
  });

  test("a same-company cycle is still caught, and passing a model is refused outright", async () => {
    const mine = await company("CycleMine");
    const a = await accountIn(mine);
    const b = await accountIn(mine, { parentAccountId: a._id });
    const loader = (id) => Account.findOne({ companyId: mine._id, _id: id }).select("parentAccountId").lean();

    await expect(assertNoAccountCycle(loader, a._id, b._id)).rejects.toThrow(HierarchyError);
    await expect(assertNoAccountCycle(loader, b._id, a._id)).resolves.toBeUndefined();

    /* The old signature took the model and read across every company. It is
       now a loud programming error, not a quiet global walk. */
    await expect(assertNoAccountCycle(Account, a._id, b._id)).rejects.toThrow(TypeError);
  });
});

/* ═══ THE MODEL BOUNDARY, BEHIND THE ROUTES ═════════════════════════════ */

describe("the model refuses ownership writes on its own", () => {
  test("query updates, document assignment and replacement are all refused", async () => {
    const mine = await company("SealA");
    const theirs = await company("SealB");
    const acct = await accountIn(mine);

    await expect(Account.findOneAndUpdate({ _id: acct._id }, { $set: { companyId: theirs._id } }))
      .rejects.toThrow(CompanyOwnershipImmutableError);
    await expect(Account.updateOne({ _id: acct._id }, { "companyOwnership.proven": false }))
      .rejects.toThrow(CompanyOwnershipImmutableError);
    await expect(Account.replaceOne({ _id: acct._id }, { companyName: "Wiped" }))
      .rejects.toThrow(CompanyOwnershipImmutableError);

    const doc = await Account.findById(acct._id);
    doc.companyId = theirs._id;
    await expect(doc.save()).rejects.toThrow(CompanyOwnershipImmutableError);

    const stored = await Account.findById(acct._id).lean();
    expect(String(stored.companyId)).toBe(String(mine._id));
  });

  test("an ordinary save of a record that has no ownership yet still works", async () => {
    // Legacy rows predate the field; refusing to save them would be a bug, not
    // a guard. Inserted below the model so no stamp is applied.
    const raw = await Account.collection.insertOne({ companyName: "Legacy Ltd", isActive: true });
    const doc = await Account.findById(raw.insertedId);
    doc.companyName = "Legacy Renamed Ltd";
    await expect(doc.save()).resolves.toBeTruthy();
  });

  test("the migration hatch is the one way ownership is assigned afterwards", async () => {
    const co = await company("MigrateMe");
    const raw = await Account.collection.insertOne({ companyName: "Unowned Ltd", isActive: true });

    await withOwnershipMigration(async () => {
      await Account.updateMany({ _id: raw.insertedId }, {
        $set: {
          companyId: co._id,
          companyOwnership: { source: "BACKFILL_SINGLE_COMPANY_DEPLOYMENT", resolvedAt: new Date(), proven: false },
        },
      });
    });

    const stored = await Account.findById(raw.insertedId).lean();
    expect(String(stored.companyId)).toBe(String(co._id));
    expect(stored.companyOwnership.proven).toBe(false);

    // And the permission ended with the callback.
    await expect(Account.updateOne({ _id: raw.insertedId }, { $set: { companyId: null } }))
      .rejects.toThrow(CompanyOwnershipImmutableError);
  });
});

/* ═══ THE SANITIZER ITSELF ══════════════════════════════════════════════ */

describe("stripCompanyOwnershipInput", () => {
  test("removes plain, dotted, nested and operator-wrapped ownership without mutating its input", () => {
    const body = {
      companyName: "Keep",
      companyId: "x",
      companyOwnership: { proven: true },
      "companyOwnership.source": "FORGED",
      $set: { city: "Keep", companyId: "x", "companyOwnership.proven": true },
      $rename: { legacyField: "companyId", other: "alsoOther" },
    };
    const clean = stripCompanyOwnershipInput(body);

    expect(clean).toEqual({
      companyName: "Keep",
      $set: { city: "Keep" },
      $rename: { other: "alsoOther" },
    });
    expect(body.companyId).toBe("x"); // the caller's object is untouched
  });
});
