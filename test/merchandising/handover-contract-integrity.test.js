// test/merchandising/handover-contract-integrity.test.js
//
// THE FIVE STRUCTURAL CLAIMS OF THE M1+M2.1 CORRECTION.
//
//   A  an order line has a permanent identity of its own, so one order can
//      carry the same style on two commercial lines and hand each over
//      independently;
//   B  a line confirmed in several splits across several deliveries produces
//      execution units that total the order exactly ONCE, through a mapping
//      Sales states rather than one either side guesses;
//   C  Sales writes Sales records and Merchandising writes Merchandising
//      records — the producer cannot reach a Merchandising model, delivery is
//      idempotent, and a receiver that is unavailable does not roll back a
//      commercial act;
//   D  the producer's authority is the LIVE Sales grant, not a seven-day-old
//      token claim;
//   E  the accepted projection has a declared shape, so an unexpected field
//      can neither persist nor escape.
//
// On a replica set: every one of these commits several records together.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
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
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  SalesHandoverOutboxEvent, HANDOVER_EVENT_KINDS,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  MerchandisingIntakeLedger, MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const producer = require("../../services/sales/merchandisingHandover.service");
const receiver = require("../../services/merchandising/handoverIntake.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const contract = require("../../services/sales/handoverContract");
const {
  LINE_REF_PATTERN, carryLineIdentities,
} = require("../../models/Customer_Models/customerRequestLineIdentity");

let salesServer, salesBase, merchServer, merchBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "handover_contract" });

  const salesApp = express();
  salesApp.use(express.json());
  salesApp.use("/h", require("../../routes/CMS_Routes/Sales/merchandisingHandovers"));
  await new Promise((r) => { salesServer = salesApp.listen(0, r); });
  salesBase = `http://127.0.0.1:${salesServer.address().port}/h`;

  const merchApp = express();
  merchApp.use(express.json());
  merchApp.use("/m", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { merchServer = merchApp.listen(0, r); });
  merchBase = `http://127.0.0.1:${merchServer.address().port}/m`;
});

afterAll(async () => {
  await new Promise((r) => salesServer.close(r));
  await new Promise((r) => merchServer.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const hit = (root) => (p, { token, company, method = "GET", body } = {}) =>
  fetch(`${root}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  });

const callSales = (p, o) => hit(salesBase)(p, o);
const callMerch = (p, o) => hit(merchBase)(p, o);

async function actor({ companies = [], role = "sales", grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ci${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `I${n}`, email, biometricId: `CI${n}`,
    isActive: true, gender: "Other", department: "Sales",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "C Actor", role, employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A company and a confirmed order.
 *
 * `lines` describes the order lines to create — each names its own style, so
 * `sameStyleTwice` puts ONE style on two commercial lines, which is the case
 * the previous scheme declared malformed.
 */
async function world(label = "C", { quantity = 500, sameStyleTwice = false } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Acct ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
  });
  const items = [{
    stockItemName: `${label} polo`, totalQuantity: quantity,
    totalEstimatedPrice: 240, sampleStyleId: style._id,
  }];
  if (sameStyleTwice) {
    /* The same confirmed style, a second commercial line: a different
       destination and a different delivery commitment. */
    items.push({
      stockItemName: `${label} polo`, totalQuantity: quantity,
      totalEstimatedPrice: 240, sampleStyleId: style._id,
    });
  }
  const request = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`,
    status: "quotation_sales_approved",
    orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items,
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  return {
    co, style, request, saved, quantity, label,
    lineRefs: saved.items.map((i) => String(i.lineRef)),
  };
}

const issueBody = (quantity, extra = {}) => ({
  expectedCurrentVersionNo: 0,
  deliveries: [{ committedDeliveryDate: "2026-12-15", quantity }],
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════
   A — A PERMANENT SALES ORDER-LINE IDENTITY
   ══════════════════════════════════════════════════════════════════════════ */

describe("A. every order line has a permanent identity of its own", () => {
  test("a new line is minted a reference; it is not the style and not the position", async () => {
    const w = await world("A1");
    const [ref] = w.lineRefs;
    expect(ref).toMatch(LINE_REF_PATTERN);
    expect(ref).not.toBe(String(w.style._id));
    expect(ref).not.toMatch(/^\d+$/);
  });

  test("editing and reordering a line does not change its identity", async () => {
    const w = await world("A2");
    const before = w.lineRefs[0];

    const doc = await CustomerRequest.findById(w.request._id);
    doc.items[0].totalQuantity = 750;
    doc.items.push({ stockItemName: "Second", totalQuantity: 40, sampleStyleId: w.style._id });
    await doc.save();

    /* And now the array is rewritten in a different order, exactly as the
       quotation paths do when they filter emptied lines out. */
    const reordered = await CustomerRequest.findById(w.request._id);
    reordered.items = [reordered.items[1], reordered.items[0]];
    await reordered.save();

    const after = await CustomerRequest.findById(w.request._id).lean();
    const survivor = after.items.find((i) => i.totalQuantity === 750);
    expect(String(survivor.lineRef)).toBe(before);
    expect(new Set(after.items.map((i) => String(i.lineRef))).size).toBe(2);
  });

  test("a copied line receives a NEW identity, never the original's", async () => {
    const w = await world("A3");
    const doc = await CustomerRequest.findById(w.request._id);
    const copy = doc.items[0].toObject();
    delete copy.lineRef;              // a clone, as every cloning path builds one
    doc.items.push(copy);
    await doc.save();

    const after = await CustomerRequest.findById(w.request._id).lean();
    const refs = after.items.map((i) => String(i.lineRef));
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[0]).toBe(w.lineRefs[0]);
  });

  test("a client cannot invent a line reference; it may only name one that exists", () => {
    const existing = [{ lineRef: "LN-aaaaaaaaaaaa", stockItemId: "s1" }];

    /* Naming a line the order holds is how a client says which line it means. */
    const named = carryLineIdentities(existing, [{ lineRef: "LN-aaaaaaaaaaaa", stockItemId: "s1" }]);
    expect(named[0].lineRef).toBe("LN-aaaaaaaaaaaa");

    /* Inventing one buys nothing — it is dropped and the line is treated as
       new, which the hook then mints for. */
    const invented = carryLineIdentities(existing, [{ lineRef: "LN-bbbbbbbbbbbb", stockItemId: "zzz" }]);
    expect(invented[0].lineRef).toBeUndefined();
  });

  test("a duplicate reference is refused, never quietly repaired", async () => {
    const w = await world("A5");
    const doc = await CustomerRequest.findById(w.request._id);
    doc.items.push({
      stockItemName: "Collision", totalQuantity: 10,
      sampleStyleId: w.style._id, lineRef: w.lineRefs[0],
    });
    await expect(doc.save()).rejects.toThrow(/line reference/i);
  });

  test("a malformed reference is refused", async () => {
    const w = await world("A6");
    const doc = await CustomerRequest.findById(w.request._id);
    doc.items.push({ stockItemName: "Bad", totalQuantity: 10, lineRef: "not-a-reference" });
    await expect(doc.save()).rejects.toThrow(/did not issue|not a line reference/i);
  });

  /* ── THE HEADLINE: TWO LINES, ONE STYLE ────────────────────────────── */
  test("one order, the same style on two lines, two independent handovers and two files", async () => {
    const w = await world("A7", { quantity: 300, sameStyleTwice: true });
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const [refA, refB] = w.lineRefs;

    expect(refA).not.toBe(refB);

    /* Both lines are eligible — neither is AMBIGUOUS, which no longer exists. */
    const panel = await callSales(`/requests/${w.request._id}`, { token: seller.token });
    expect(panel.status).toBe(200);
    expect(panel.body.lines).toHaveLength(2);
    for (const line of panel.body.lines) {
      expect(line.eligible).toBe(true);
      expect(line.blockers).toHaveLength(0);
    }
    const allBlockers = JSON.stringify(panel.body.lines);
    expect(allBlockers).not.toMatch(/AMBIGUOUS/);

    /* Independent commitments: different dates, different destinations. */
    const a = await callSales(`/requests/${w.request._id}/lines/${refA}/issue`, {
      token: seller.token, method: "POST",
      body: issueBody(300, { deliveries: [{ committedDeliveryDate: "2026-11-01", quantity: 300, nominatedFactoryRef: "FAC-NORTH" }] }),
    });
    const b = await callSales(`/requests/${w.request._id}/lines/${refB}/issue`, {
      token: seller.token, method: "POST",
      body: issueBody(300, { deliveries: [{ committedDeliveryDate: "2027-02-01", quantity: 300, nominatedFactoryRef: "FAC-SOUTH" }] }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.version.handoverLineRef).toBe(refA);
    expect(b.body.version.handoverLineRef).toBe(refB);

    /* Independent version histories: superseding one leaves the other alone. */
    const a2 = await callSales(`/requests/${w.request._id}/lines/${refA}/issue`, {
      token: seller.token, method: "POST",
      body: { expectedCurrentVersionNo: 1, deliveries: [{ committedDeliveryDate: "2026-11-20", quantity: 300 }] },
    });
    expect(a2.status).toBe(201);
    expect(a2.body.version.versionNo).toBe(2);
    const bStill = await SalesHandoverVersion.findOne({
      companyId: w.co._id, handoverLineRef: refB, "publication.state": "CURRENT",
    }).lean();
    expect(bStill.versionNo).toBe(1);

    /* Accepting both opens TWO files, neither colliding with the other. */
    const t = { token: merch.token, company: w.co._id };
    const fa = await callMerch(`/handovers/${a2.body.version._id}/accept`, { ...t, method: "POST" });
    const fb = await callMerch(`/handovers/${bStill._id}/accept`, { ...t, method: "POST" });
    expect(fa.status).toBe(201);
    expect(fb.status).toBe(201);
    expect(fa.body.file.id).not.toBe(fb.body.file.id);
    expect(await ExecutionFile.countDocuments({ companyId: w.co._id })).toBe(2);

    const files = await ExecutionFile.find({ companyId: w.co._id }).lean();
    expect(new Set(files.map((f) => f.handoverLineRef))).toEqual(new Set([refA, refB]));
    /* Same order, same style, two different commitments — visibly. */
    const dates = files.map((f) => new Date(f.currentExecutionProjection.deliveries[0].committedDeliveryDate).getFullYear());
    expect(new Set(dates)).toEqual(new Set([2026, 2027]));
  });

  test("AMBIGUOUS_LINE is gone from the producer entirely", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "sales", "merchandisingHandover.service.js"), "utf8",
    );
    expect(src).not.toMatch(/AMBIGUOUS_LINE/);
  });

  test("a legacy line with no reference is blocked with the sentence that says what to do", async () => {
    const w = await world("A9");
    /* A record that predates permanent references — written around the hook,
       which is exactly the state the backfill utility exists for. */
    await CustomerRequest.collection.updateOne(
      { _id: w.request._id }, { $unset: { "items.0.lineRef": "" } },
    );
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const panel = await callSales(`/requests/${w.request._id}`, { token: seller.token });
    const line = panel.body.lines[0];
    expect(line.lineRef).toBe("");
    expect(line.eligible).toBe(false);
    expect(line.blockers.map((b) => b.code)).toContain("NO_LINE_REFERENCE");
    expect(line.blockers.find((b) => b.code === "NO_LINE_REFERENCE").message)
      .toMatch(/needs its permanent Sales line reference/i);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   B — MULTI-AXIS EXECUTION UNITS
   ══════════════════════════════════════════════════════════════════════════ */

describe("B. execution units total the line exactly once", () => {
  const split = (ref, qty, colour) => ({
    lineSplitRef: ref, quantity: qty, sizeRange: "S-XL",
    attributes: [{ name: "Colour", value: colour }],
  });
  const drop = (ref, qty, date) => ({ dropRef: ref, quantity: qty, committedDeliveryDate: date });

  const plan = (projection) => contract.deriveUnitPlan(projection);
  const totals = (units) => units.reduce((t, u) => t + u.quantity, 0);

  test("no breakdown, one delivery — one DEFAULT unit", () => {
    const units = plan({ totalQuantity: 100, deliveries: [drop("D1", 100, "2026-10-01")] });
    expect(units.map((u) => u.unitDiscriminator)).toEqual(["DEFAULT"]);
    expect(totals(units)).toBe(100);
  });

  test("no breakdown, several deliveries — one unit per drop", () => {
    const units = plan({
      totalQuantity: 100,
      deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
    });
    expect(units.map((u) => u.unitDiscriminator)).toEqual(["DROP:D1", "DROP:D2"]);
    expect(totals(units)).toBe(100);
  });

  test("several splits, one delivery — one unit per split, carrying that delivery", () => {
    const units = plan({
      totalQuantity: 100,
      breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
      deliveries: [drop("D1", 100, "2026-10-01")],
    });
    expect(units.map((u) => u.unitDiscriminator)).toEqual(["SPLIT:S1", "SPLIT:S2"]);
    expect(units.every((u) => u.dropRef === "D1")).toBe(true);
    expect(totals(units)).toBe(100);
  });

  test("one split, several deliveries — one unit per drop, carrying that split", () => {
    const units = plan({
      totalQuantity: 100,
      breakdown: [split("S1", 100, "Navy")],
      deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
    });
    expect(units.map((u) => u.unitDiscriminator)).toEqual(["DROP:D1", "DROP:D2"]);
    expect(units.every((u) => u.lineSplitRef === "S1")).toBe(true);
    expect(totals(units)).toBe(100);
  });

  /* ── THE DEFECT ITSELF ──────────────────────────────────────────────── */
  test("several splits across several deliveries — the mapping decides, and the total is counted ONCE", () => {
    const projection = {
      totalQuantity: 100,
      breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
      deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
      allocations: [
        { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 50 },
        { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 20 },
        { allocationRef: "A3", lineSplitRef: "S2", dropRef: "D1", quantity: 10 },
        { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 20 },
      ],
    };
    const units = plan(projection);
    expect(units.map((u) => u.unitDiscriminator)).toEqual([
      "UNIT:S1|D1", "UNIT:S1|D2", "UNIT:S2|D1", "UNIT:S2|D2",
    ]);
    /* Once — not 200, which is what two parallel axes produced. */
    expect(totals(units)).toBe(100);
    /* And every unit knows both of its parents, and its dates come from the
       drop it belongs to rather than from anywhere else. */
    const s1d2 = units.find((u) => u.unitDiscriminator === "UNIT:S1|D2");
    expect(s1d2.lineSplitRef).toBe("S1");
    expect(s1d2.dropRef).toBe("D2");
    expect(s1d2.attributes).toEqual([{ name: "Colour", value: "Navy" }]);
    /* Compared as the UTC calendar date it was stored as. `getMonth()` reads
       the LOCAL month, so this assertion passed only on a machine at or east
       of UTC — under TZ=America/Los_Angeles, midnight UTC on 1 November is
       still 31 October locally and the month came back as October. The value
       under test never changed; only the way this line read it was wrong. */
    expect(new Date(s1d2.committedDeliveryDate).toISOString().slice(0, 10)).toBe("2026-11-01");
  });

  test("identity comes from references, so renaming a colourway keeps the unit", () => {
    const base = {
      totalQuantity: 100,
      breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
      deliveries: [drop("D1", 100, "2026-10-01")],
    };
    const renamed = {
      ...base,
      breakdown: [split("S1", 70, "Midnight Navy"), split("S2", 30, "Ecru")],
    };
    expect(plan(base).map((u) => u.unitDiscriminator))
      .toEqual(plan(renamed).map((u) => u.unitDiscriminator));
  });

  describe("and a mapping that does not hold up is refused", () => {
    const twoByTwo = (allocations) => ({
      totalQuantity: 100,
      breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
      deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
      allocations,
    });
    const ok = [
      { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 50 },
      { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 20 },
      { allocationRef: "A3", lineSplitRef: "S2", dropRef: "D1", quantity: 10 },
      { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 20 },
    ];

    test("missing altogether", () => {
      expect(() => plan(twoByTwo([]))).toThrow(/how much of each split ships in each delivery/i);
    });
    test("an unknown split", () => {
      expect(() => plan(twoByTwo([...ok, { allocationRef: "A5", lineSplitRef: "S9", dropRef: "D1", quantity: 1 }])))
        .toThrow(/names a split this line does not have/i);
    });
    test("an unknown drop", () => {
      expect(() => plan(twoByTwo([...ok, { allocationRef: "A5", lineSplitRef: "S1", dropRef: "D9", quantity: 1 }])))
        .toThrow(/names a delivery this line does not have/i);
    });
    test("a repeated allocation reference", () => {
      const dup = ok.map((a, i) => (i === 3 ? { ...a, allocationRef: "A1" } : a));
      expect(() => plan(twoByTwo(dup))).toThrow(/its own reference/i);
    });
    test("the same split and drop stated twice", () => {
      const pair = [
        { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 25 },
        { allocationRef: "A1b", lineSplitRef: "S1", dropRef: "D1", quantity: 25 },
        { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 20 },
        { allocationRef: "A3", lineSplitRef: "S2", dropRef: "D1", quantity: 10 },
        { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 20 },
      ];
      expect(() => plan(twoByTwo(pair))).toThrow(/allocated twice/i);
    });
    test("a split whose allocations do not add up", () => {
      const bad = ok.map((a) => (a.allocationRef === "A2" ? { ...a, quantity: 25 } : a));
      expect(() => plan(twoByTwo(bad))).toThrow(/Split "S1" is allocated 75 against a confirmed 70/);
    });
    test("a drop whose allocations do not add up", () => {
      const bad = [
        { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 45 },
        { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 25 },
        { allocationRef: "A3", lineSplitRef: "S2", dropRef: "D1", quantity: 10 },
        { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 20 },
      ];
      expect(() => plan(twoByTwo(bad))).toThrow(/Delivery "D1" is allocated 55 against a confirmed 60/);
    });
    test("a confirmed split that ships in no delivery", () => {
      const orphan = [
        { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 60 },
        { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 40 },
      ];
      expect(() => plan(twoByTwo(orphan))).toThrow(/Split "S2" is confirmed but ships in no delivery/);
    });
    test("a mapping offered where the line has only one axis", () => {
      expect(() => plan({
        totalQuantity: 100,
        breakdown: [split("S1", 100, "Navy")],
        deliveries: [drop("D1", 100, "2026-10-01")],
        allocations: [{ allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 100 }],
      })).toThrow(/needs no allocation mapping/i);
    });
  });

  test("Sales issuance refuses the unmapped two-axis line, in business words", async () => {
    const w = await world("B1", { quantity: 100 });
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const res = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: {
        expectedCurrentVersionNo: 0,
        breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
        deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/how much of each split ships in each delivery/i);
    expect(await SalesHandoverVersion.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("end to end: a mapped two-axis line stores four units totalling the order once", async () => {
    const w = await world("B2", { quantity: 100 });
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });

    const issued = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: {
        expectedCurrentVersionNo: 0,
        breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
        deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
        allocations: ok2(),
      },
    });
    expect(issued.status).toBe(201);

    const t = { token: merch.token, company: w.co._id };
    const accepted = await callMerch(`/handovers/${issued.body.version._id}/accept`, { ...t, method: "POST" });
    expect(accepted.status).toBe(201);

    const units = await ExecutionUnit.find({ fileId: accepted.body.file.id, active: true }).lean();
    expect(units).toHaveLength(4);
    expect(units.reduce((s, u) => s + u.quantity, 0)).toBe(100);
    expect(new Set(units.map((u) => u.unitDiscriminator)))
      .toEqual(new Set(["UNIT:S1|D1", "UNIT:S1|D2", "UNIT:S2|D1", "UNIT:S2|D2"]));

    /* ── A LATER VERSION CHANGES THE MAPPING ─────────────────────────── */
    const v2 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: {
        expectedCurrentVersionNo: 1,
        breakdown: [split("S1", 70, "Navy"), split("S2", 30, "Ecru")],
        deliveries: [drop("D1", 60, "2026-10-01"), drop("D2", 40, "2026-11-01")],
        allocations: [
          { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 60 },
          { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 10 },
          { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 30 },
        ],
      },
    });
    expect(v2.status).toBe(201);
    await callMerch(`/handovers/${v2.body.version._id}/accept`, { ...t, method: "POST" });

    const after = await ExecutionUnit.find({ fileId: accepted.body.file.id }).lean();
    const active = after.filter((u) => u.active);
    const withdrawn = after.filter((u) => !u.active);
    /* The tuple the new mapping no longer carries is WITHDRAWN, not erased —
       a confirmed split that was later dropped is a decision somebody may
       have to explain. */
    expect(withdrawn.map((u) => u.unitDiscriminator)).toEqual(["UNIT:S2|D1"]);
    expect(active.reduce((s, u) => s + u.quantity, 0)).toBe(100);
  });

  function ok2() {
    return [
      { allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 50 },
      { allocationRef: "A2", lineSplitRef: "S1", dropRef: "D2", quantity: 20 },
      { allocationRef: "A3", lineSplitRef: "S2", dropRef: "D1", quantity: 10 },
      { allocationRef: "A4", lineSplitRef: "S2", dropRef: "D2", quantity: 20 },
    ];
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   C — PRODUCER / RECEIVER OWNERSHIP
   ══════════════════════════════════════════════════════════════════════════ */

describe("C. Sales publishes; Merchandising mutates", () => {
  const producerSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "services", "sales", "merchandisingHandover.service.js"), "utf8",
  );

  test("the producer imports no Merchandising-owned mutable record", () => {
    /* The structural half of the boundary. Every one of these was imported
       here before, and the cancellation path wrote through two of them. */
    for (const banned of [
      /require\([^)]*Merchandising\/ExecutionFile/,
      /require\([^)]*Merchandising\/ExecutionUnit/,
      /require\([^)]*Merchandising\/HandoverReceipt/,
      /require\([^)]*Merchandising\/MerchandisingEvent/,
      /MerchandisingAuditEvent/,
      /MerchandisingOutboxEvent/,
    ]) {
      expect(producerSrc).not.toMatch(banned);
    }
    /* And nothing at all from the Merchandising model directory. */
    expect(producerSrc).not.toMatch(/require\(["'][^"']*models\/CMS_Models\/Merchandising/);
  });

  test("no Merchandising model is reachable from the producer at all, transitively", () => {
    /* Stronger than reading the import list: a model pulled in through a
       helper two levels down is just as much a way for the producer to reach
       a Merchandising record, and it would not appear in this file's source. */
    const entry = require.resolve("../../services/sales/merchandisingHandover.service");
    require(entry);
    const seen = new Set();
    const walk = (id, depth) => {
      if (depth > 6 || seen.has(id)) return;
      seen.add(id);
      for (const child of (require.cache[id]?.children || [])) walk(child.id, depth + 1);
    };
    walk(entry, 0);
    const reachable = [...seen].filter((f) => /models[\\/]CMS_Models[\\/]Merchandising[\\/]/.test(f));
    expect(reachable).toEqual([]);
  });

  test("the producer's only writes are Sales records", () => {
    const written = [...producerSrc.matchAll(/(\w+)\.create\(|(\w+)\.updateOne\(/g)]
      .map((m) => m[1] || m[2]);
    for (const name of new Set(written)) {
      expect(name).toMatch(/^SalesHandover/);
    }
  });

  test("a Sales cancellation cannot touch a file until the receiver applies it", async () => {
    const w = await world("C1");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: merch.token, company: w.co._id };

    const issued = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    const file = (await callMerch(`/handovers/${issued.body.version._id}/accept`, { ...t, method: "POST" })).body.file;

    /* The producer alone — no delivery. The commercial fact is published... */
    const { correlationId } = await producer.cancel({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineRefs[0],
      reason: "Buyer withdrew.", actor: { name: "Sales" },
    });
    const version = await SalesHandoverVersion.findOne({ handoverLineRef: w.lineRefs[0] }).lean();
    expect(version.publication.state).toBe("CANCELLED");

    /* ...and the Merchandising file is untouched, because Sales did not and
       cannot touch it. The announcement is waiting. */
    expect((await ExecutionFile.findById(file.id).lean()).lifecycleStatus).toBe("OPEN");
    const pending = await SalesHandoverOutboxEvent.findOne({ correlationId, kind: HANDOVER_EVENT_KINDS.CANCELLED }).lean();
    expect(pending.status).toBe("PENDING");

    /* The receiver applies it. */
    const summary = await delivery.deliverPending({ companyId: w.co._id, correlationId });
    expect(summary.failed).toBe(0);
    const mirrored = await ExecutionFile.findById(file.id).lean();
    expect(mirrored.lifecycleStatus).toBe("CANCELLED");
    expect(mirrored.cancellation.reason).toMatch(/Buyer withdrew/);
    expect(String(mirrored.cancellation.sourceVersionId)).toBe(String(version._id));
    /* Attributed to the SOURCE, in Merchandising's own trail. */
    const audit = await MerchandisingAuditEvent.findOne({
      recordId: mirrored._id, action: "SALES_CANCELLATION_MIRRORED",
    }).lean();
    expect(audit.source).toBe("sales");
  });

  test("a receiver failure leaves the event pending and the Sales act intact", async () => {
    const w = await world("C2");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });

    const spy = jest.spyOn(receiver, "receive").mockRejectedValueOnce(new Error("receiver is down"));
    const res = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    spy.mockRestore();

    /* The commercial act succeeded and says the announcement has not landed. */
    expect(res.status).toBe(201);
    expect(res.body.handover.pending).toBe(true);
    expect(await SalesHandoverVersion.countDocuments({ companyId: w.co._id })).toBe(1);

    const event = await SalesHandoverOutboxEvent.findOne({ companyId: w.co._id }).lean();
    expect(event.status).toBe("PENDING");
    expect(event.attempts).toBe(1);
    expect(event.lastError).toMatch(/receiver is down/);

    /* And it is retryable — the same event, delivered on the next attempt. */
    const retry = await delivery.deliverPending({ companyId: w.co._id });
    expect(retry.failed).toBe(0);
    expect((await SalesHandoverOutboxEvent.findById(event._id).lean()).status).toBe("DELIVERED");
  });

  test("duplicate delivery changes nothing", async () => {
    const w = await world("C3");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: merch.token, company: w.co._id };

    const issued = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    const file = (await callMerch(`/handovers/${issued.body.version._id}/accept`, { ...t, method: "POST" })).body.file;

    const { correlationId } = await producer.cancel({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineRefs[0],
      reason: "Withdrawn.", actor: { name: "Sales" },
    });
    await delivery.deliverPending({ companyId: w.co._id, correlationId });
    const first = await ExecutionFile.findById(file.id).lean();

    /* The same event again, straight at the receiver — the retry sweep racing
       the immediate attempt, or an operator running it twice. */
    const event = await SalesHandoverOutboxEvent.findOne({ correlationId, kind: HANDOVER_EVENT_KINDS.CANCELLED }).lean();
    const again = await receiver.receive(event);
    expect(again.duplicate).toBe(true);

    const second = await ExecutionFile.findById(file.id).lean();
    expect(second.revision).toBe(first.revision);
    expect(second.sourceVersionHistory).toHaveLength(first.sourceVersionHistory.length);
    expect(await MerchandisingAuditEvent.countDocuments({
      recordId: file.id, action: "SALES_CANCELLATION_MIRRORED",
    })).toBe(1);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });

  test("an out-of-order cancellation cannot undo a newer accepted version", async () => {
    const w = await world("C4");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: merch.token, company: w.co._id };

    const v1 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    const file = (await callMerch(`/handovers/${v1.body.version._id}/accept`, { ...t, method: "POST" })).body.file;

    /* A cancellation of v1 that is held back... */
    const { correlationId } = await producer.cancel({ companyId: w.co._id }, {
      requestId: String(w.request._id), lineId: w.lineRefs[0],
      reason: "Stale withdrawal.", actor: { name: "Sales" },
    });
    /* ...while Sales issues and Merchandising accepts v2. */
    const v2 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: { expectedCurrentVersionNo: 0, deliveries: [{ committedDeliveryDate: "2027-01-01", quantity: w.quantity }] },
    });
    expect(v2.status).toBe(201);
    expect(v2.body.version.versionNo).toBe(2);
    await callMerch(`/handovers/${v2.body.version._id}/accept`, { ...t, method: "POST" });

    /* Now the stale event arrives. It is delivered — and changes nothing. */
    const summary = await delivery.deliverPending({ companyId: w.co._id, correlationId });
    expect(summary.failed).toBe(0);
    const still = await ExecutionFile.findById(file.id).lean();
    expect(still.lifecycleStatus).toBe("OPEN");

    const ledger = await MerchandisingIntakeLedger.findOne({ sourceKind: HANDOVER_EVENT_KINDS.CANCELLED }).lean();
    expect(ledger.outcome).toBe("NOOP");
    expect(ledger.note).toMatch(/has since been accepted/);
  });

  test("a supersession settles an open clarification and leaves an accepted file's projection alone", async () => {
    const w = await world("C5");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const t = { token: merch.token, company: w.co._id };

    const v1 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    await callMerch(`/handovers/${v1.body.version._id}/clarify`, {
      ...t, method: "POST",
      body: { category: "FACTORY_CAPABILITY_MISMATCH", reason: "That factory cannot do this finish." },
    });

    const v2 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: { expectedCurrentVersionNo: 1, deliveries: [{ committedDeliveryDate: "2027-03-01", quantity: w.quantity }] },
    });
    expect(v2.status).toBe(201);

    /* The clarification is settled by the replacement — and KEPT. */
    const receipt = await HandoverReceipt.findOne({ handoverVersionId: v1.body.version._id }).lean();
    expect(receipt.state).toBe("SUPERSEDED");
    expect(receipt.clarification.category).toBe("FACTORY_CAPABILITY_MISMATCH");
    expect(receipt.clarification.reason).toMatch(/cannot do this finish/);

    /* Accept v2, then have Sales supersede it with v3 — the file's accepted
       projection must not follow until a merchandiser accepts v3. */
    const file = (await callMerch(`/handovers/${v2.body.version._id}/accept`, { ...t, method: "POST" })).body.file;
    const acceptedDate = (await ExecutionFile.findById(file.id).lean())
      .currentExecutionProjection.deliveries[0].committedDeliveryDate;

    const v3 = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: { expectedCurrentVersionNo: 2, deliveries: [{ committedDeliveryDate: "2027-09-09", quantity: w.quantity }] },
    });
    expect(v3.status).toBe(201);

    const unchanged = await ExecutionFile.findById(file.id).lean();
    expect(new Date(unchanged.currentExecutionProjection.deliveries[0].committedDeliveryDate).toISOString())
      .toBe(new Date(acceptedDate).toISOString());
    expect(String(unchanged.currentHandoverVersionId)).toBe(String(v2.body.version._id));
    /* The v2 receipt stands as ACCEPTED; the supersession did not rewrite it. */
    expect((await HandoverReceipt.findOne({ handoverVersionId: v2.body.version._id }).lean()).state)
      .toBe("ACCEPTED");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   D — LIVE SALES AUTHORITY ON THE PRODUCER
   ══════════════════════════════════════════════════════════════════════════ */

describe("D. the producer answers to the live Sales grant", () => {
  const attempt = async (w, who) => ({
    inspect: (await callSales(`/requests/${w.request._id}`, { token: who.token })).status,
    issue: (await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: who.token, method: "POST", body: issueBody(w.quantity),
    })).status,
    cancel: (await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/cancel`, {
      token: who.token, method: "POST", body: { reason: "x" },
    })).status,
  });

  test("a Sales viewer may inspect and may not issue", async () => {
    const w = await world("D1");
    const who = await actor({ companies: [w.co], grants: { sales: "viewer" } });
    const out = await attempt(w, who);
    expect(out.inspect).toBe(200);
    expect(out.issue).toBe(403);
    expect(out.cancel).toBe(403);
  });

  test("a Sales editor may inspect and may not issue", async () => {
    const w = await world("D2");
    const who = await actor({ companies: [w.co], grants: { sales: "editor" } });
    const out = await attempt(w, who);
    expect(out.inspect).toBe(200);
    expect(out.issue).toBe(403);
  });

  test("a Sales approver issues; an owner issues", async () => {
    for (const role of ["approver", "owner"]) {
      const w = await world(`D3${role}`);
      const who = await actor({ companies: [w.co], grants: { sales: role } });
      const res = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
        token: who.token, method: "POST", body: issueBody(w.quantity),
      });
      expect(res.status).toBe(201);
    }
  });

  test.each([
    ["a platform admin with no Sales grant", { role: "admin", isAdmin: true, grants: {} }],
    ["a CEO with no Sales grant", { role: "ceo", grants: {} }],
    ["a Merchandising owner", { role: "merchandiser", grants: { merchandiser: "owner" } }],
    ["a Store owner", { role: "store_manager", grants: { store: "owner" } }],
    ["a token that merely says 'sales'", { role: "sales", grants: {} }],
  ])("%s is denied everything", async (_label, spec) => {
    const w = await world("D4");
    const who = await actor({ companies: [w.co], ...spec });
    const out = await attempt(w, who);
    expect(out.inspect).toBe(403);
    expect(out.issue).toBe(403);
    expect(out.cancel).toBe(403);
    expect(await SalesHandoverVersion.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a revoked grant fails on the very next request", async () => {
    const w = await world("D5");
    const who = await actor({ companies: [w.co], grants: { sales: "approver" } });

    const first = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: who.token, method: "POST", body: issueBody(w.quantity),
    });
    expect(first.status).toBe(201);

    await DepartmentRole.updateOne({ departmentSlug: "sales", email: who.email }, { $set: { isActive: false } });

    /* Same token, same second. */
    const after = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: who.token, method: "POST", body: { expectedCurrentVersionNo: 1, deliveries: [{ committedDeliveryDate: "2027-01-01", quantity: w.quantity }] },
    });
    expect(after.status).toBe(403);
    expect(after.body.error.details.requires.department).toBe("sales");
  });

  test("a downgrade takes effect immediately too", async () => {
    const w = await world("D6");
    const who = await actor({ companies: [w.co], grants: { sales: "approver" } });
    await DepartmentRole.updateOne({ departmentSlug: "sales", email: who.email }, { $set: { role: "editor" } });
    const res = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: who.token, method: "POST", body: issueBody(w.quantity),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details.requires.minimumRole).toBe("approver");
  });

  test("the producer does not use bypassesApproval", () => {
    const routeSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Sales", "merchandisingHandovers.js"), "utf8",
    );
    expect(routeSrc).toMatch(/salesHandoverAuthority/);
    expect(routeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1"))
      .not.toMatch(/bypassesApproval/);
  });

  test("the unrelated legacy Sales rule is untouched", () => {
    /* The correction is scoped to this producer. Redefining `bypassesApproval`
       globally would have changed the quotation and costing approval gates
       with no test coverage behind them. */
    const salesAccess = require("../../services/salesAccess");
    expect(salesAccess.bypassesApproval({ role: "sales" })).toBe(true);
    expect(salesAccess.bypassesApproval({ isAdmin: true })).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   E — THE DECLARED PROJECTION
   ══════════════════════════════════════════════════════════════════════════ */

describe("E. the execution projection has a shape, and it is enforced", () => {
  test("neither record stores the projection as Mixed", () => {
    for (const file of [
      ["models", "CMS_Models", "Sales", "SalesHandoverVersion.js"],
      ["models", "CMS_Models", "Merchandising", "ExecutionFile.js"],
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", ...file), "utf8");
      expect(src).toMatch(/executionProjectionSchema/);
      expect(src).not.toMatch(/currentExecutionProjection:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/);
      expect(src).not.toMatch(/executionProjection:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/);
    }
  });

  test("an unexpected nested field cannot persist, and cannot escape through a response", async () => {
    const w = await world("E1");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    const merch = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });

    const issued = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST", body: issueBody(w.quantity),
    });
    expect(issued.status).toBe(201);

    /* Something writes a field nobody agreed — a future helper, a bad merge.
       Strict mode drops it at the schema rather than storing it silently. */
    await SalesHandoverVersion.updateOne(
      { _id: issued.body.version._id },
      { $set: { "executionProjection.unitPrice": 12.5, "executionProjection.secretNote": "x" } },
    );
    const raw = await SalesHandoverVersion.findById(issued.body.version._id).lean();
    /* The raw update wrote it (updates bypass casting), so the point is what
       the SCHEMA does when the document is next loaded and saved... */
    const doc = await SalesHandoverVersion.findById(issued.body.version._id);
    doc.markModified("executionProjection");
    await doc.save();
    const cleaned = await SalesHandoverVersion.findById(issued.body.version._id).lean();
    expect(cleaned.executionProjection.unitPrice).toBeUndefined();
    expect(cleaned.executionProjection.secretNote).toBeUndefined();
    expect(raw.executionProjection.totalQuantity).toBe(w.quantity);

    /* ...and that the accepted copy is built through the same schema, so an
       Execution File cannot carry one either. */
    const t = { token: merch.token, company: w.co._id };
    const accepted = await callMerch(`/handovers/${issued.body.version._id}/accept`, { ...t, method: "POST" });
    const file = await ExecutionFile.findById(accepted.body.file.id).lean();
    expect(file.currentExecutionProjection.unitPrice).toBeUndefined();
    expect(file.currentExecutionProjection.secretNote).toBeUndefined();
    expect(JSON.stringify(accepted.body)).not.toMatch(/unitPrice|secretNote/);
  });

  test("the projection still refuses commercial fields at the door, by name", async () => {
    const w = await world("E2");
    const seller = await actor({ companies: [w.co], grants: { sales: "approver" } });
    for (const [field, body] of [
      ["unitPrice", { unitPrice: 12 }],
      ["customerInfo", { customerInfo: { name: "x" } }],
      ["paymentTerms", { paymentTerms: "30 days" }],
    ]) {
      const res = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
        token: seller.token, method: "POST", body: { ...issueBody(w.quantity), ...body },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(field);
    }
    /* And inside an allocation, which is a new surface. */
    const nested = await callSales(`/requests/${w.request._id}/lines/${w.lineRefs[0]}/issue`, {
      token: seller.token, method: "POST",
      body: {
        ...issueBody(w.quantity),
        allocations: [{ allocationRef: "A1", lineSplitRef: "S1", dropRef: "D1", quantity: 1, price: 9 }],
      },
    });
    expect(nested.status).toBe(400);
    expect(nested.body.error.details.field).toBe("price");
  });
});
