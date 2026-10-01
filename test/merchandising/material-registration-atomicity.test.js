// test/merchandising/material-registration-atomicity.test.js
//
// REGISTERING A MATERIAL IS ONE OPERATION, OR IT IS NOTHING.
//
// The item and the audit row that says why it exists used to be two writes.
// Three things were wrong with that, and each one is a claim here:
//
//   1  A FAILED AUDIT LEFT AN ITEM BEHIND. An item in Store's catalogue with no
//      record of who put it there or what for is exactly the thing the audit row
//      exists to prevent, and the failure produced it. Now the item rolls back
//      with the audit.
//
//   2  A RETRY CREATED A SECOND ITEM, OR REFUSED THE FIRST. The ledger row was
//      written after the transaction, so a crash in between left the item
//      created and the key unrecorded; the honest retry then met the duplicate
//      check and was told the material it had itself just created was already
//      there. Now the ledger commits with the item, and a replay returns the
//      FIRST answer verbatim.
//
//   3  TWO REQUESTS TOGETHER CREATED TWO ITEMS. A read-then-write duplicate
//      check cannot hold under concurrency: both read "not there" and both
//      insert, because snapshot isolation only conflicts on documents they BOTH
//      touch. Now the loser meets a unique index — the ledger's, or the
//      catalogue's — and never a second row.
//
// And the thing that must NOT change: Store's own screen may still register a
// deliberate near-duplicate. The uniqueness is claimed by the door that refuses
// duplicates, not by the field, so the two doors keep their different answers.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent, MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const creation = require("../../services/inventory/rawItemCreation.service");

let server, base, salesBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "material_atomicity" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/developmentRoute"));
  app.use("/api/cms/sales/development-requests", require("../../routes/CMS_Routes/Sales/developmentRequests"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales/development-requests`;
  /* The partial unique index is the thing several of these tests are about, so
     it has to exist rather than be assumed. */
  await RawItem.syncIndexes();
  await DevelopmentFile.syncIndexes();
  await MerchandisingCommandLedger.syncIndexes();
}, 120000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const req = (root) => (p, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${root}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  });

const call = (p, o) => req(base)(p, o);
const sales = (p, o) => req(salesBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `atom-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `Tom${n}`, email, biometricId: `AT${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    id: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Atom ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await Unit.create([
    { companyId: co._id, name: "Metre", status: "Active" },
    { companyId: co._id, name: "Piece", status: "Active" },
  ]);
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-A-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-A-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `Tee ${n}`, quantity: 500 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  return { co, journey, enquiry, productLineRef: String(saved.products[0].productLineRef) };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

async function cast(co) {
  return {
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    sales: await actor({ companies: [co], grants: { sales: "approver" } }),
  };
}

async function draftOn(w, c) {
  const asked = await sales(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
    ...at(w, c.sales), method: "POST",
    body: {
      requirementSummary: "Lightweight running tee — mesh body, reflective trim.",
      requestedCategories: ["FABRIC", "TRIMS"],
      requiredByDate: "2026-10-15",
    },
  });
  if (asked.status >= 400) throw new Error(`Sales could not ask: ${asked.text}`);
  const file = await DevelopmentFile.findOne({
    companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef,
  }).lean();
  await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
  await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
  return file;
}

const registerWith = (w, c, file, { key, name = "Bamboo jersey 180", ...rest } = {}) =>
  call("/catalogue/materials", {
    ...at(w, c.editor), method: "POST", key,
    body: { fileId: String(file._id), name, category: "Fabric", unit: "Metre", ...rest },
  });

const auditCount = (co) => MerchandisingAuditEvent.countDocuments({
  companyId: co._id, action: "DEVELOPMENT_MATERIAL_REGISTERED",
});

/* Only THIS command's keys. Accepting the request and opening the draft each
   record one of their own against the same company. */
const keysBurned = (co) => MerchandisingCommandLedger.countDocuments({
  companyId: co._id, scope: /^dev:material:register:/,
});

/* ══ THE KEY IS REQUIRED ═════════════════════════════════════════════════ */

describe("a command that creates something takes an idempotency key", () => {
  test("without one it is refused, and nothing is written", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await registerWith(w, c, file, { key: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await auditCount(w.co)).toBe(0);
  });

  test("the same key for a DIFFERENT material is a client bug, not a retry", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();

    expect((await registerWith(w, c, file, { key, name: "First material" })).status).toBe(201);
    const second = await registerWith(w, c, file, { key, name: "Different material" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    /* Answering it with the first result would silently ignore the second thing
       somebody asked for. */
    expect(await RawItem.countDocuments({ companyId: w.co._id, name: "Different material" })).toBe(0);
  });
});

/* ══ 2 — REPLAY ══════════════════════════════════════════════════════════ */

describe("a retry of a request that already succeeded", () => {
  test("returns the first item, not a duplicate conflict", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();

    const first = await registerWith(w, c, file, { key, name: "Poly mesh 135" });
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);

    const retry = await registerWith(w, c, file, { key, name: "Poly mesh 135" });
    /* Before this, the retry met the duplicate check and was told the material
       it had itself created a moment earlier was already registered. */
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.item.rawItemId).toBe(first.body.item.rawItemId);
    expect(retry.body.item).toEqual(first.body.item);

    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("a third and fourth retry are the same answer again", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();
    const first = await registerWith(w, c, file, { key });
    for (let i = 0; i < 3; i += 1) {
      const again = await registerWith(w, c, file, { key });
      expect(again.status).toBe(200);
      expect(again.body.item.rawItemId).toBe(first.body.item.rawItemId);
    }
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("a NEW key for the same material is a genuine duplicate and is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const first = await registerWith(w, c, file, { key: uniq(), name: "Poly mesh 135" });
    expect(first.status).toBe(201);

    /* Somebody who came back later and asked again. Not a retry — a second
       attempt to register a material that is now there. */
    const again = await registerWith(w, c, file, { key: uniq(), name: "Poly mesh 135" });
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe("RAW_ITEM_ALREADY_REGISTERED");
    expect(again.body.error.details.existing._id).toBe(first.body.item.rawItemId);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a key is scoped, so another company's identical key is not a replay", async () => {
    const mine = await world();
    const theirs = await world();
    const mc = await cast(mine.co);
    const tc = await cast(theirs.co);
    const mf = await draftOn(mine, mc);
    const tf = await draftOn(theirs, tc);
    const key = uniq();

    /* Two companies are separate worlds. The ledger is keyed on company, scope
       AND key, so one company's retry token cannot suppress another's command. */
    const a = await registerWith(mine, mc, mf, { key, name: "Same key both sides" });
    const b = await registerWith(theirs, tc, tf, { key, name: "Same key both sides" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.replayed).toBe(false);
    expect(a.body.item.rawItemId).not.toBe(b.body.item.rawItemId);
  });

  test("the ledger records the reply, so a replay is read back and not rebuilt", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();
    const first = await registerWith(w, c, file, { key, name: "Recorded reply" });

    const row = await MerchandisingCommandLedger.findOne({
      companyId: w.co._id, idempotencyKey: key,
    }).lean();
    expect(row).toBeTruthy();
    expect(row.scope).toBe(`dev:material:register:${String(file._id)}`);
    expect(row.payload.item.rawItemId).toBe(first.body.item.rawItemId);
    expect(await keysBurned(w.co)).toBe(1);
  });
});

/* ══ 1 — A FAILED AUDIT LEAVES NO ITEM ═══════════════════════════════════ */

describe("if the audit cannot be written", () => {
  test("no item is created, and the failure is not reported as success", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const real = MerchandisingAuditEvent.create;
    MerchandisingAuditEvent.create = jest.fn(() => {
      throw new Error("audit collection unavailable");
    });
    try {
      const res = await registerWith(w, c, file, { key: uniq(), name: "Rolled back" });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body.success).toBe(false);
    } finally {
      MerchandisingAuditEvent.create = real;
    }

    /* The whole point. Before this, the item was saved and then the audit
       failed, leaving a row in Store's catalogue that nothing explained. */
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await auditCount(w.co)).toBe(0);
    /* And no idempotency key was burned, so an honest retry still works. */
    expect(await keysBurned(w.co)).toBe(0);
  });

  test("and the retry afterwards succeeds normally", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();

    const real = MerchandisingAuditEvent.create;
    MerchandisingAuditEvent.create = jest.fn(() => { throw new Error("audit unavailable"); });
    try {
      await registerWith(w, c, file, { key, name: "Second time lucky" });
    } finally {
      MerchandisingAuditEvent.create = real;
    }

    const res = await registerWith(w, c, file, { key, name: "Second time lucky" });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("a refused item leaves no audit row and burns no key", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();

    /* A field this door may not take. */
    const res = await registerWith(w, c, file, { key, minStock: 100 });
    expect(res.status).toBe(403);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await auditCount(w.co)).toBe(0);
    expect(await keysBurned(w.co)).toBe(0);

    /* So the same key still works once the caller stops sending it. */
    expect((await registerWith(w, c, file, { key })).status).toBe(201);
  });
});

/* ══ 3 — CONCURRENCY ═════════════════════════════════════════════════════ */

describe("two requests at the same moment", () => {
  test("with the same key produce one item and one audit row", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const key = uniq();

    const [a, b] = await Promise.all([
      registerWith(w, c, file, { key, name: "Simultaneous mesh" }),
      registerWith(w, c, file, { key, name: "Simultaneous mesh" }),
    ]);

    /* One of them created it; the other replayed. Which is which is a race and
       is not asserted — that exactly one item exists is. */
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.item.rawItemId).toBe(b.body.item.rawItemId);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("with different keys for the same material still produce one item", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const [a, b] = await Promise.all([
      registerWith(w, c, file, { key: uniq(), name: "Raced mesh" }),
      registerWith(w, c, file, { key: uniq(), name: "Raced mesh" }),
    ]);

    /* A read-then-write duplicate check cannot catch this — both read "not
       there". The unique partial index on the claimed identity does. */
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("five at once produce one item", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const all = await Promise.all(
      Array.from({ length: 5 }, () => registerWith(w, c, file, { key: uniq(), name: "Five at once" })),
    );
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await auditCount(w.co)).toBe(1);
  });

  test("the loser is told the material exists, not that something went wrong", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const all = await Promise.all(
      Array.from({ length: 3 }, () => registerWith(w, c, file, { key: uniq(), name: "Losing race" })),
    );
    for (const r of all.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.error.details.reason).toBe("RAW_ITEM_ALREADY_REGISTERED");
      /* A caller cannot tell whether they lost a race or simply arrived
         second, which is the honest answer to both. */
      expect(r.body.message).toMatch(/already in this company's Store catalogue|registered a moment ago/);
    }
  });

  test("two companies registering the same material at once both succeed", async () => {
    const mine = await world();
    const theirs = await world();
    const mc = await cast(mine.co);
    const tc = await cast(theirs.co);
    const mf = await draftOn(mine, mc);
    const tf = await draftOn(theirs, tc);

    const [a, b] = await Promise.all([
      registerWith(mine, mc, mf, { key: uniq(), name: "Shared name" }),
      registerWith(theirs, tc, tf, { key: uniq(), name: "Shared name" }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await RawItem.countDocuments({ companyId: mine.co._id })).toBe(1);
    expect(await RawItem.countDocuments({ companyId: theirs.co._id })).toBe(1);
  });
});

/* ══ AND STORE KEEPS ITS OWN ANSWER ══════════════════════════════════════ */

describe("Store may still register a deliberate near-duplicate", () => {
  test("the uniqueness is claimed by the door, not by the field", async () => {
    const w = await world();
    const tenant = { companyId: w.co._id };
    const who = new mongoose.Types.ObjectId();
    const payload = {
      name: "Poly mesh 135", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
      minStock: 10, maxStock: 100,
    };

    const first = await creation.createRawItem({
      tenant, actorId: who, payload, sections: creation.STORE_SECTIONS, onDuplicate: "allow",
    });
    const second = await creation.createRawItem({
      tenant, actorId: who, payload, sections: creation.STORE_SECTIONS, onDuplicate: "allow",
    });

    /* Both exist. A storekeeper can see the catalogue in front of them and may
       have a real reason for a second row. */
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(2);
    expect(first.rawItem.identityUnique).toBe(false);
    expect(second.rawItem.identityUnique).toBe(false);
    /* And the near-match is REPORTED rather than discovered later. */
    expect(second.duplicate).toBeTruthy();
    expect(second.duplicate.name).toBe("Poly mesh 135");
  });

  test("the narrow door claims uniqueness on what it creates", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const made = await registerWith(w, c, file, { key: uniq(), name: "Claimed" });
    const stored = await RawItem.findById(made.body.item.rawItemId).lean();
    expect(stored.identityUnique).toBe(true);
    expect(stored.masterIdentityKey).toBe("claimed|fabric|metre|fabric");
  });

  test("Store's near-duplicates do not block the narrow door from refusing", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const tenant = { companyId: w.co._id };
    const payload = {
      name: "Store made this", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
      minStock: 10, maxStock: 100,
    };
    await creation.createRawItem({
      tenant, actorId: new mongoose.Types.ObjectId(), payload,
      sections: creation.STORE_SECTIONS, onDuplicate: "allow",
    });

    /* Merchandising is still told it is there — the read finds it whether or
       not the index covers it. */
    const res = await registerWith(w, c, file, { key: uniq(), name: "store made this" });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("RAW_ITEM_ALREADY_REGISTERED");
  });
});
