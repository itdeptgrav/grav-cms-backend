// test/store-purchase/customer-supplied-routing.test.js
//
// A CUSTOMER SENDS MATERIAL FOR A SAMPLE.
//
// The flow this covers is the one that had nowhere to go: a development sample,
// before any order exists, where the customer supplies the fabric. Three things
// decide whether it is safe to turn on, and each of them is a way the feature
// could be quietly wrong rather than visibly broken:
//
//   · WHOSE goods they are. Resolved by walking the development's Sales journey
//     on the server. A `customerId` taken from the request would let whoever
//     fills the form decide whose fabric arrives, and the lot on the shelf would
//     carry that answer for ever.
//   · That NOTHING commercial is created. No purchase order, not even a
//     zero-value one, and no spend request. Nothing was bought.
//   · That a retry adds nothing. Approvals arrive twice and callers repeat
//     timed-out requests; a second expectation for one line would put two
//     claims on one delivery.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const Customer = require("../../models/Customer_Models/Customer");
const CRMAccount = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const {
  ORIGIN, STATE, CustomerMaterialExpectation,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");

const routing = require("../../services/storePurchase/customerSuppliedRouting.service");
const auto = require("../../services/storePurchase/autoReservation.service");

let seq = 0;

beforeAll(async () => {
  /* ── THE INDEX IS THE GUARANTEE, SO THE TEST BUILDS IT ────────────────────
     Mongoose builds a schema's indexes lazily, on first use of the collection,
     and whether that has happened before a concurrent insert depends on what
     else the run touched first. In production these are built by
     `scripts/migrations/customer-material-ownership-indexes.js`, outside any
     transaction — so a test that relies on one must ensure it exists rather
     than hoping, or it passes for a reason that is not the code. */
  await CustomerMaterialExpectation.createIndexes();
});

/**
 * One company, one customer whose CRM account is linked, one Sales journey, one
 * development opened under it — the whole chain ownership is walked through.
 * `breakAt` snips one link so the refusals can be tested on a chain that is
 * otherwise sound.
 */
async function seed({ breakAt = null, customerSupplied = true, quantity = 12, reuse = null, sameDevelopment = false } = {}) {
  const n = ++seq;
  /* ── SHARING A COMPANY MEANS SHARING ITS OWNERSHIP CHAIN ──────────────────
     A second sample "in the same company as the first" cannot be made by
     seeding a fresh company and then moving the request into the old one: the
     customer, account, journey and development stay behind, and routing — quite
     correctly — refuses a request whose owner it cannot prove. So a reused
     company brings its whole chain with it, and only the parts that are
     genuinely new are created. */
  const company = reuse
    ? reuse.company
    : await Acc_Company.create({ companyName: `Dev Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const emp = reuse ? reuse.emp : await Employee.create({
    isActive: true, gender: "Other", department: "Merchandising",
    firstName: "Asha", lastName: `D${n}`, email: `dev${n}@demo.example`, biometricId: `DV${n}`,
  });

  const customer = reuse ? reuse.customer : await Customer.create({
    name: `Northwind Textiles ${n}`, customerId: `CUS-${n}`, email: `cust${n}@example.com`,
  });
  /* `breakAt: "account-company"` puts the account in ANOTHER company from the
     start. It cannot be moved afterwards — the platform refuses to change a
     record's owning company, which is itself the right guard. */
  const accountCompany = breakAt === "account-company"
    ? (await Acc_Company.create({ companyName: `Elsewhere ${n}`, booksFromDate: new Date("2026-04-01") }))._id
    : company._id;
  const account = reuse ? reuse.account : await CRMAccount.create({
    companyId: accountCompany,
    companyName: `Northwind ${n}`,
    ...(breakAt === "account-link" ? {} : { linkedCustomer: customer._id }),
  });
  const journey = reuse ? reuse.journey : await SalesJourney.create({
    companyId: company._id,
    journeyId: `SJ-${n}`,
    name: `Northwind development ${n}`,
    ownerId: emp._id,
    /* `accountId` is required, so a journey with none cannot exist. The way
       this chain actually breaks is an account that is gone. */
    accountId: breakAt === "journey-account" ? new mongoose.Types.ObjectId() : account._id,
  });
  /* A reused seed may share the development too — two request lines for one
     development sample is an ordinary thing, not an edge case. */
  const development = sameDevelopment && reuse ? reuse.development : await DevelopmentFile.create({
    companyId: company._id,
    developmentNumber: `DEV-${n}`,
    journeyId: journey._id,
    productLineRef: `PL-${n}`,
    productName: "Poplin shirt — development",
    styleRef: `STY-${n}`,
    buyerDisplayLabel: `Northwind ${n}`,
  });

  const raw = await RawItem.create({
    name: `Cotton poplin ${n}`, sku: `FAB-${n}`, unit: "metre", quantity: 0, minStock: 0,
    companyId: company._id,
  });

  const mrf = await MRF.create({
    mrfNumber: `MRF/CSM/${String(n).padStart(4, "0")}`,
    companyId: company._id,
    requestedFor: emp._id, requestedForName: "Asha", requestedForDept: "Merchandising",
    requestedForId: emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", tlApproved: true,
    createdByRef: emp._id, createdByModel: "Employee", createdByName: "Asha",
    reason: "Development sample",
    purpose: "DEVELOPMENT_SAMPLE",
    ...(breakAt === "work-context" ? {} : { developmentFileId: development._id }),
    items: [{
      rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
      requestedQty: quantity, unit: "metre", baseUnit: "metre",
      itemStatus: "APPROVED", availability: "UNREVIEWED",
      supplySource: customerSupplied ? "CUSTOMER_SUPPLIED" : "COMPANY_FULFILLED",
    }],
  });

  return {
    company, emp, customer, account, journey, development, raw, mrf,
    tenant: { companyId: company._id, siteId: null },
    lineId: mrf.items[0]._id,
  };
}

const route = (s) => routing.routeApprovedRequest({ tenant: s.tenant, mrfId: s.mrf._id });

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE EXPECTATION, AND EXACTLY ONE OF IT
   ═══════════════════════════════════════════════════════════════════════════ */

test("1 · an approved customer-supplied sample line creates one expectation", async () => {
  const s = await seed();
  const r = await route(s);

  expect(r.routed).toBe(true);
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0].outcome).toBe("EXPECTED");

  const docs = await CustomerMaterialExpectation.find({ companyId: s.company._id }).lean();
  expect(docs).toHaveLength(1);
  const doc = docs[0];
  expect(doc.origin).toBe(ORIGIN.DEVELOPMENT_SAMPLE);
  expect(String(doc.developmentFileId)).toBe(String(s.development._id));
  expect(doc.executionFileId).toBeNull();
  /* ISSUED, not DRAFT: the approval already decided it, and Store cannot
     receive against a draft. */
  expect(doc.state).toBe(STATE.ISSUED);
  expect(doc.lines).toHaveLength(1);
  expect(doc.lines[0].requiredQuantity).toBe(12);
  expect(doc.lines[0].unit).toBe("metre");
});

test("2 · the lineage back to the request is on the document", async () => {
  const s = await seed();
  await route(s);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();

  expect(String(doc.sourceMrfId)).toBe(String(s.mrf._id));
  expect(doc.sourceMrfNumber).toBe(s.mrf.mrfNumber);
  expect(String(doc.sourceMrfLineId)).toBe(String(s.lineId));
  /* And the document reference comes from Merchandising's own series — not a
     second one that would encode which path created it. */
  expect(doc.documentRef).toMatch(/^CSM-\d{4}-\d{4}$/);
});

test("3 · routing twice creates nothing the second time", async () => {
  const s = await seed();
  const first = await route(s);
  const again = await route(s);

  expect(first.lines[0].outcome).toBe("EXPECTED");
  expect(again.lines[0].outcome).toBe("ALREADY_EXPECTED");
  expect(again.lines[0].expectationId).toBe(first.lines[0].expectationId);
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(1);
});

test("4 · two simultaneous routings cannot both create one", async () => {
  const s = await seed();
  const [a, b] = await Promise.all([route(s), route(s)]);

  expect(a.routed).toBe(true);
  expect(b.routed).toBe(true);
  /* One claim on one delivery, whichever order they landed in. */
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(1);
  const ids = [a.lines[0].expectationId, b.lines[0].expectationId].filter(Boolean);
  expect(new Set(ids).size).toBe(1);
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. NOTHING COMMERCIAL
   ═══════════════════════════════════════════════════════════════════════════ */

test("5 · no purchase order and no spend request is created — not even a free one", async () => {
  const s = await seed();
  const before = {
    po: await PurchaseOrder.countDocuments({}),
    spend: await SpendRequest.countDocuments({}),
  };

  await route(s);

  /* Nothing was bought and nobody is owed money. A zero-value PO would be read
     by somebody as free goods from a supplier. */
  expect(await PurchaseOrder.countDocuments({})).toBe(before.po);
  expect(await SpendRequest.countDocuments({})).toBe(before.spend);
});

test("6 · the expectation carries no supplier, price or value, because it cannot", async () => {
  const s = await seed();
  await route(s);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();

  /* There is nowhere for one to arrive — the model has no such field, which is
     the only reliable way to keep one out. */
  for (const field of ["vendor", "vendorId", "unitPrice", "currency", "taxRate", "payable", "totalValue"]) {
    expect(doc[field]).toBeUndefined();
  }
  for (const line of doc.lines) {
    for (const field of ["unitPrice", "amount", "taxRate"]) expect(line[field]).toBeUndefined();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. OWNERSHIP IS WALKED, NEVER ACCEPTED
   ═══════════════════════════════════════════════════════════════════════════ */

test("7 · the customer is resolved through the development's Sales journey", async () => {
  const s = await seed();
  await route(s);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();

  /* Development -> journey -> account -> linkedCustomer. Not a field anybody
     typed on the request. */
  expect(String(doc.customerId)).toBe(String(s.customer._id));
  /* The snapshot travels for a screen to read; the id is the ownership. */
  expect(doc.customerSnapshot?.customerName || "").toContain("Northwind");
  expect(doc.customerSnapshot?.customerLabel || "").toContain("Northwind");
});

test("8 · a customerId on the request payload is never the authority", async () => {
  const s = await seed();
  const impostor = await Customer.create({ name: "Someone Else Ltd", customerId: `CUS-X${seq}`, email: `other${seq}@example.com` });
  /* Written straight into the stored document, bypassing the schema — because
     mongoose would otherwise drop an unknown field and the test would pass
     without the hostile value ever having been there. A client that found a way
     to persist one is exactly what this guard is for. */
  await MRF.collection.updateOne(
    { _id: s.mrf._id },
    { $set: { customerId: impostor._id, customerSnapshot: { customerName: "Someone Else Ltd" } } },
  );

  await route(s);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  /* The walk wins. The fabric belongs to whoever the journey says it does. */
  expect(String(doc.customerId)).toBe(String(s.customer._id));
  expect(String(doc.customerId)).not.toBe(String(impostor._id));
});

test.each([
  ["account-link", "the account is not linked to a customer yet"],
  ["journey-account", "the account on the journey is gone"],
])("9 · a broken ownership chain refuses rather than guessing (%s)", async (breakAt) => {
  const s = await seed({ breakAt });
  const r = await route(s);

  expect(r.lines[0].outcome).toBe("OWNER_UNPROVEN");
  expect(r.lines[0].message.length).toBeGreaterThan(0);
  /* No document at all: an expectation whose owner cannot be proven is the one
     record in this design that must not exist. */
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(0);
});

test("10 · a request with no work context cannot expect anything", async () => {
  const s = await seed({ breakAt: "work-context" });
  const r = await route(s);

  expect(r.lines[0].outcome).toBe("NO_WORK_CONTEXT");
  expect(r.lines[0].message).toMatch(/development or order/i);
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(0);
});

test("11 · another company's request is refused", async () => {
  const s = await seed();
  const other = await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const r = await routing.routeApprovedRequest({
    tenant: { companyId: other._id, siteId: null }, mrfId: s.mrf._id,
  });
  expect(r.routed).toBe(false);
  expect(r.reason).toBe("TENANT_MISMATCH");
  expect(await CustomerMaterialExpectation.countDocuments({})).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE OTHER HALF OF THE REQUEST IS UNTOUCHED
   ═══════════════════════════════════════════════════════════════════════════ */

test("12 · a company-fulfilled line is not expected from the customer", async () => {
  const s = await seed({ customerSupplied: false });
  const r = await route(s);

  expect(r.routed).toBe(true);
  expect(r.lines).toHaveLength(0);
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(0);
});

test("13 · a legacy line with no supplySource is company-fulfilled", async () => {
  /* Every line that exists today has no such field, and every one of them must
     keep exactly the behaviour it has. */
  const s = await seed({ customerSupplied: false });
  await MRF.updateOne({ _id: s.mrf._id }, { $unset: { "items.0.supplySource": "" } });
  const reloaded = await MRF.findById(s.mrf._id).lean();

  expect(routing.isCustomerSupplied(reloaded.items[0])).toBe(false);
  expect(routing.reservationShouldSkip(reloaded.items[0])).toBe(false);
  const r = await route(s);
  expect(r.lines).toHaveLength(0);
});

test("14 · a mixed request routes each line its own way", async () => {
  const s = await seed();
  const trim = await RawItem.create({
    name: `Buttons ${seq}`, sku: `BTN-${seq}`, unit: "pcs", quantity: 0, companyId: s.company._id,
  });
  await MRF.updateOne({ _id: s.mrf._id }, {
    $push: {
      items: {
        rawItem: trim._id, rawItemName: trim.name, requestedQty: 500, unit: "pcs", baseUnit: "pcs",
        itemStatus: "APPROVED", availability: "UNREVIEWED", supplySource: "COMPANY_FULFILLED",
      },
    },
  });

  const r = await route(s);
  /* The customer sends the fabric; the factory buys the trims. One request, two
     routes - which is why the source is a line fact and not a request one. */
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0].outcome).toBe("EXPECTED");
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  expect(doc.lines).toHaveLength(1);
  expect(doc.lines[0].rawItemName).toMatch(/Cotton poplin/);
});

test("15 · automatic reservation holds nothing for a customer-supplied line", async () => {
  const s = await seed();
  const skip = auto.skipReason(s.mrf, s.mrf.items[0]);
  expect(skip).not.toBeNull();
  expect(skip.reason).toBe("CUSTOMER_SUPPLIED");
  /* Holding company stock for material the customer is sending would make it
     unavailable to the work that actually needs it. */
  expect(skip.message).toMatch(/customer is sending/i);
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. THE MODEL REFUSES AN AMBIGUOUS DOCUMENT
   ═══════════════════════════════════════════════════════════════════════════ */

test("16 · an expectation with neither origin, or both, is refused", async () => {
  const s = await seed();
  const base = {
    companyId: s.company._id, customerId: s.customer._id,
    documentRef: `CSM-2026-9${seq}`, revisionNo: 1, state: STATE.ISSUED,
    lines: [{ lineRef: "L1", rawItemName: "x", requiredQuantity: 1, unit: "m" }],
  };

  await expect(CustomerMaterialExpectation.create({ ...base, origin: ORIGIN.DEVELOPMENT_SAMPLE }))
    .rejects.toThrow(/execution file or to a development|must name the work it is for/i);

  await expect(CustomerMaterialExpectation.create({
    ...base,
    origin: ORIGIN.CONFIRMED_ORDER,
    executionFileId: new mongoose.Types.ObjectId(),
    developmentFileId: s.development._id,
  })).rejects.toThrow(/never to both/i);
});

test("17 · the origin and the field it requires must agree", async () => {
  const s = await seed();
  await expect(CustomerMaterialExpectation.create({
    companyId: s.company._id, customerId: s.customer._id,
    documentRef: `CSM-2026-8${seq}`, revisionNo: 1, state: STATE.ISSUED,
    /* Labelled a confirmed order, carrying only a development. A mislabelled
       record is worse than a missing field: the label is what every downstream
       reader branches on. */
    origin: ORIGIN.CONFIRMED_ORDER,
    developmentFileId: s.development._id,
    lines: [{ lineRef: "L1", rawItemName: "x", requiredQuantity: 1, unit: "m" }],
  })).rejects.toThrow(/confirmed-order expectation must name its execution file/i);
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. THE APPROVAL IS THE AUTHORIZATION — SO IT HAS TO HAVE HAPPENED
   ═══════════════════════════════════════════════════════════════════════════ */

test.each([
  ["PENDING", { status: "PENDING", tlApproved: false }],
  ["approved status but nobody approved it", { status: "APPROVED", tlApproved: false }],
  ["CANCELLED", { status: "CANCELLED", tlApproved: true }],
])("18 · a request that is not finally approved expects nothing (%s)", async (_label, patch) => {
  const s = await seed();
  await MRF.updateOne({ _id: s.mrf._id }, { $set: patch });

  const r = await route(s);
  expect(r.routed).toBe(false);
  expect(r.reason).toBe("NOT_APPROVED");
  /* The expectation is ISSUED the moment it exists — there is no draft stage in
     which somebody would notice it was stated on a decision nobody took. */
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(0);
});

test("19 · a partly-issued approved request still routes", async () => {
  /* Part-way through fulfilment is the same decision, not a different one. */
  const s = await seed();
  await MRF.updateOne({ _id: s.mrf._id }, { $set: { status: "PARTIALLY_ISSUED" } });
  const r = await route(s);
  expect(r.routed).toBe(true);
  expect(r.lines[0].outcome).toBe("EXPECTED");
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. A LATER CHANGE NEVER SILENTLY EDITS AN ISSUED DOCUMENT
   ═══════════════════════════════════════════════════════════════════════════ */

test("20 · changing the request afterwards does not rewrite the issued expectation", async () => {
  const s = await seed({ quantity: 12 });
  await route(s);
  const before = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  expect(before.lines[0].requiredQuantity).toBe(12);

  /* Somebody edits the approved request and it is routed again. */
  await MRF.updateOne({ _id: s.mrf._id }, { $set: { "items.0.requestedQty": 40 } });
  const again = await route(s);

  expect(again.lines[0].outcome).toBe("ALREADY_EXPECTED");
  const after = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  /* An issued document is what Store is planning around and what receipts are
     recorded against. Changing it underneath them would move the quantity a
     delivery is measured against after the delivery was agreed — a change goes
     through the existing revision model, with its own audit trail. */
  expect(after.lines[0].requiredQuantity).toBe(12);
  expect(after.revisionNo).toBe(before.revisionNo);
  expect(after.revision).toBe(before.revision);
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(1);
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. WITHDRAWING THE REQUEST
   ═══════════════════════════════════════════════════════════════════════════ */

test("21 · cancelling the request withdraws an expectation nothing has arrived against", async () => {
  const s = await seed();
  await route(s);

  const r = await routing.cancelForRequest({
    tenant: s.tenant, mrfId: s.mrf._id, reason: "The sample was dropped.",
  });

  expect(r.handled).toBe(true);
  expect(r.expectations).toHaveLength(1);
  expect(r.expectations[0].outcome).toBe("CANCELLED");

  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  expect(doc.state).toBe("CANCELLED");
  /* Merchandising's own cancellation, so the reason and the audit trail are the
     ones every other reader of this document understands. */
  expect(doc.cancellationReason).toMatch(/sample was dropped/i);
  expect(doc.revision).toBeGreaterThan(0);
});

test("22 · cancelling leaves an expectation that has already received material alone", async () => {
  const s = await seed();
  await route(s);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();

  /* Something arrived. The goods are on the shelf, they belong to the customer,
     and they are in lots QC and issue read. */
  const receipts = require("../../services/storePurchase/customerMaterialReceipt.service");
  jest.spyOn(receipts, "standingFor").mockResolvedValue({
    lines: [{ lineRef: doc.lines[0].lineRef, receivedQuantity: 5, pendingQuantity: 7 }],
  });

  const r = await routing.cancelForRequest({ tenant: s.tenant, mrfId: s.mrf._id });
  receipts.standingFor.mockRestore();

  expect(r.expectations[0].outcome).toBe("REFUSED_RECEIPTS_EXIST");
  expect(r.expectations[0].receivedQuantity).toBe(5);
  /* And it names what to do instead, because short-closing and returning are
     decisions with physical consequences. */
  expect(r.expectations[0].message).toMatch(/short-close/i);
  expect(r.expectations[0].message).toMatch(/return or consume/i);

  const after = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  expect(after.state).toBe("ISSUED");
});

test("23 · a receipt total that cannot be read is treated as 'something may have arrived'", async () => {
  const s = await seed();
  await route(s);

  const receipts = require("../../services/storePurchase/customerMaterialReceipt.service");
  jest.spyOn(receipts, "standingFor").mockRejectedValue(new Error("read failed"));
  const r = await routing.cancelForRequest({ tenant: s.tenant, mrfId: s.mrf._id });
  receipts.standingFor.mockRestore();

  /* The safe direction is always to leave the document alone: cancelling one
     that turns out to hold received stock cannot be undone. */
  expect(r.expectations[0].outcome).toBe("REFUSED_RECEIPTS_EXIST");
  const after = await CustomerMaterialExpectation.findOne({ companyId: s.company._id }).lean();
  expect(after.state).toBe("ISSUED");
});

test("24 · cancelling a request that expected nothing is a no-op, not a failure", async () => {
  const s = await seed({ customerSupplied: false });
  const r = await routing.cancelForRequest({ tenant: s.tenant, mrfId: s.mrf._id });
  expect(r.handled).toBe(true);
  expect(r.expectations).toHaveLength(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. THE OWNERSHIP WALK CROSSES NO COMPANY BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

test("25 · an account in another company is not followed, even from this company's journey", async () => {
  /* The journey is this company's and is reached correctly; the account it
     names is not. "The previous link was checked" is exactly the reasoning that
     leaves one link in a chain unchecked, and this is the hop that decides whose
     fabric arrives. */
  const s = await seed({ breakAt: "account-company" });

  const r = await route(s);
  expect(r.lines[0].outcome).toBe("OWNER_UNPROVEN");
  expect(await CustomerMaterialExpectation.countDocuments({ companyId: s.company._id })).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. THE INDEXES, AS THE DATABASE ACTUALLY HOLDS THEM

   Both tests here reproduce an index shape deliberately and route against it,
   because an index is the only part of this feature a schema file cannot prove:
   mongo does not alter an index that already exists to match a changed
   declaration, so what the model says and what the database enforces can differ
   indefinitely. Each one restores the declared indexes before it finishes.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Put the collection back to exactly what the schema declares. */
async function restoreDeclaredIndexes() {
  await CustomerMaterialExpectation.collection.dropIndexes().catch(() => {});
  await CustomerMaterialExpectation.createIndexes();
}

test("26 · the deployed non-partial revision index collides on the second development sample", async () => {
  /* ── WHY THIS TEST EXISTS ────────────────────────────────────────────────
     The deployed database carries `companyId_1_executionFileId_1_revisionNo_1`
     as UNIQUE with no partial filter — built when every expectation had an
     execution file, so the combination could never repeat. A development-sample
     expectation has `executionFileId: null` and `revisionNo: 1`, and null is a
     value like any other to a unique index: the first inserts, and the second
     for the same company collides on (companyId, null, 1).

     The schema now declares that index partial, which is right for a fresh
     database and does nothing for one that already carries the old one. That
     makes this a deployment blocker rather than a code defect, and this test is
     here so the blocker is a demonstrated fact in the report rather than a
     reading of an index listing. */
  const col = CustomerMaterialExpectation.collection;
  await col.dropIndexes().catch(() => {});
  await col.createIndex(
    { companyId: 1, executionFileId: 1, revisionNo: 1 },
    { unique: true, name: "companyId_1_executionFileId_1_revisionNo_1" },
  );

  const a = await seed();
  expect((await route(a)).lines[0].outcome).toBe("EXPECTED");

  /* A second, unrelated development sample in the same company — its own
     development, under the same proven customer. */
  const b = await seed({ reuse: a });
  const second = await route(b);
  expect(second.lines[0].outcome).toBe("FAILED");
  expect(second.lines[0].message).toMatch(/duplicate key|E11000/i);

  /* With the index as the schema now declares it, the same second sample
     succeeds — which is the whole of what the deployed database needs. */
  await restoreDeclaredIndexes();
  const c = await seed({ reuse: a });
  expect((await route(c)).lines[0].outcome).toBe("EXPECTED");
});

test("27 · two expectations on ONE development are allowed, and each keeps its own revision 1", async () => {
  /* ── THE INDEX THIS FEATURE GOT WRONG FIRST ──────────────────────────────
     The revision rule was first written as (companyId, developmentFileId,
     revisionNo), by analogy with the execution-file rule. The analogy does not
     hold. An execution file has ONE expectation revised 1..n, so keying its
     revisions on the file is keying them on the document. A development may
     have SEVERAL, because each approved customer-supplied line produces its own
     document, each opening at revision 1 — two fabrics for one sample, or a
     second line approved a week later.

     Keyed on the development, the second one collided and routing reported a
     duplicate-key failure: a legitimate case refused by an index that had
     mistaken the work for the document. It is keyed on `documentRef` now, and
     this test is what the old index failed. */
  await restoreDeclaredIndexes();

  const a = await seed();
  const first = await route(a);
  expect(first.lines[0].outcome).toBe("EXPECTED");

  const b = await seed({ reuse: a, sameDevelopment: true });
  expect(String(b.development._id)).toBe(String(a.development._id));
  const second = await route(b);
  expect(second.lines[0].outcome).toBe("EXPECTED");

  const docs = await CustomerMaterialExpectation
    .find({ companyId: a.company._id, developmentFileId: a.development._id })
    .sort({ createdAt: 1 }).lean();
  expect(docs).toHaveLength(2);
  /* Two documents, two references, and both at revision 1 — which is the point:
     they are not revisions of each other. */
  expect(docs.map((d) => d.revisionNo)).toEqual([1, 1]);
  expect(new Set(docs.map((d) => d.documentRef)).size).toBe(2);
  expect(docs.map((d) => String(d.sourceMrfLineId)))
    .toEqual([String(a.lineId), String(b.lineId)]);
});

test("28 · one document cannot carry the same revision number twice", async () => {
  /* The replacement index is narrower in one dimension and must still do the
     job the old one did: hold a document's revision numbers unique. */
  await restoreDeclaredIndexes();
  const a = await seed();
  await route(a);
  const doc = await CustomerMaterialExpectation.findOne({ companyId: a.company._id }).lean();

  /* A duplicated revision of a real document, inserted underneath the model so
     nothing but the index can refuse it. */
  const clash = { ...doc, _id: new mongoose.Types.ObjectId(), sourceMrfLineId: new mongoose.Types.ObjectId() };
  await expect(CustomerMaterialExpectation.collection.insertOne(clash))
    .rejects.toThrow(/E11000|duplicate key/i);
});
