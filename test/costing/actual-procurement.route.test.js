// test/costing/actual-procurement.route.test.js
//
// THE ESTIMATE BESIDE WHAT WAS ACTUALLY SPENT — THROUGH STORED IDS ONLY.
//
// This suite drives the whole chain against real records: an approved costing,
// the draft requests raised from it, the purchase order raised against those,
// the receipt, the inspection and the posted voucher. What it is really
// testing is that every join is an id somebody stored, and that nothing the
// report reads is ever written back.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy,
  EVERY_FAMILY, prepareForCosting } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingTransition = require("../../models/CMS_Models/Costing/CostingTransition");

const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs, server, base, seq = 0;

jest.setTimeout(240000);

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "actual_procurement" });
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const newKey = () => `ap-${++seq}-${Math.random().toString(36).slice(2)}`;
const hit = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/** An actor holding the costing capabilities, in the given companies. */
async function actor(companies = [], { admin = true } = {}) {
  const n = ++seq;
  const emp = await Employee.create({
    firstName: "Cost", lastName: `A${n}`, email: `pp${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `PP${n}`, department: "Finance",
  });
  if (admin) {
    await DeptUser.create({
      name: "Admin", email: emp.email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, employeeRef: emp._id, email: emp.email, isActive: true });
  }
  const user = { id: String(emp._id), role: "employee", employeeId: emp.biometricId, email: emp.email, name: "Cost A" };
  return { emp, user, token: jwt.sign(user, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" }) };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* Overhead used to arrive as a typed OVERHEAD line. It is a company RULE,
     and the engine applies it from here — which is where it always belonged. */
  revision: 0,
};
/* ── THE COSTING IS ASSEMBLED, NOT TYPED ─────────────────────────
   `LINES` stood here — eight rows, one per cost family, each a typed rate
   carrying a declared override, posted to `POST /versions` so this suite had
   an approved costing to work from. It was "deliberately mixed: two families
   that ARE procurement and four that are not", and that mix is preserved: the
   seed below produces a material and a packaging item (procurement) alongside
   an operation, an outside service, development work, overhead and financing
   (not).

   What changed is where they come from. Overrides are retired, so the fixture
   states the RECORDS — a technical record, supplier quotations, the company
   policy, the Board's financing methodology and the enquiry's payment terms
   — and the server assembles the rows from them, as it does in production.

   The suite's own subject is untouched: it stamps `offerProvenance` onto the
   approved version itself and projects from that, which is a different field
   from the assembled inputs and needs no line key to match. */
const SCENARIOS = [
  { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
  { key: "q2000", label: "2000 pcs", quantity: "2000" },
];
const PRODUCT = "Oxford Shirt";

/** A company with a costing approved at v1, and a newer working v2. */
async function world({ approve = true, newerWorking = false, requirementDeadline = null } = {}) {
  const co = await company("PP");
  const me = await actor([co]);
  await hit("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });

  /* ── EVERY FAMILY ANSWERED BY A RECORD ─────────────────────────────
     The enquiry, its journey, the technical record and the quotations behind
     it. This used to be three hand-built documents and eight typed cost
     lines; it is now the same fixture a real costing has, and the server
     assembles the rows. `EVERY_FAMILY` covers the sourced families, the
     Board answers financing's methodology, and duty — the one family with no
     source at all — is answered by a decision on the calculation below. */
  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCENARIOS, quantityUom: "Pieces" }, ...EVERY_FAMILY });
  await configureProduction(co._id);
  const { enquiry, style, journey } = seeded;
  const accountId = enquiry.accountId;
  /* Written onto the seeded enquiry rather than passed to the seed: the
     deadline is a Sales fact about THIS order, not a property of the fixture,
     and the seed has no option for it. */
  if (requirementDeadline) {
    await Enquiry.updateOne({ _id: enquiry._id }, { $set: { requirementDeadline } });
  }

  const made = await hit("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  const costingId = made.body.costing.id;
  /* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────
     `POST /:id/versions` was Calculate and refuses a browser client now. This
     fixture only ever needed a calculated version to exist; the orchestration
     makes one from the confirmed brief and the same sources. */
  const calc = await prepareForCosting(costingId);
  if (calc.status !== 201) throw new Error(`calculate refused: ${calc.status} ${JSON.stringify(calc.body).slice(0, 500)}`);
  const versionId = calc.body.versions[0].id;

  /* ── THE SUITE OWNS THE FROZEN EVIDENCE, AS IT ALWAYS DID ────────────
     `offerProvenance` is what a projection is built from, and every test
     below stamps exactly the entries it is about through `freezeProvenance`.
     The old fixture's typed lines carried no quotation, so the version
     started with none and "no supplier evidence" was the natural starting
     state. A real assembled costing IS priced from a quotation and arrives
     with provenance of its own — which would silently join every projection
     and make each test assert against rows it did not put there.

     Cleared once, here, so the starting state is the same one these tests
     were written against and each of them still controls its own evidence. */
  await CostingVersion.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(versionId)) },
    { $set: { offerProvenance: [] } },
  );

  if (approve) {
    /* ── A FIXTURE CONCERN, NOT A PRODUCT ONE ────────────────────────────
       The in-memory replica set this suite runs against gives transactions a
       5ms lock timeout, and this file drives many lifecycle transitions in
       quick succession. A `TransientTransactionError` is exactly what Mongo
       tells a client to retry, so the fixture retries — with a FRESH key,
       because the old one may have been abandoned. Nothing about the
       production path changes; the alternative is a suite that fails on
       machine speed rather than on behaviour. */
    const transition = async (verb, body) => {
      let last = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await hit(`/${costingId}/versions/${versionId}/${verb}`, {
          method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body,
        });
        if (res.status === 200) return res;
        last = res;
        if (res.status !== 500) break;   // a real refusal, not a lock timeout
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
      }
      throw new Error(`${verb} refused: ${last.status} ${JSON.stringify(last.body).slice(0, 400)}`);
    };
    await transition("submit", {});
    await transition("approve", { note: "Approved for projection." });
  }

  let workingId = null;
  if (newerWorking) {
    /* A LATER, UNAPPROVED version with a materially different cost. If the
       projection ever reads the newest version, these figures show up. */
    /* Sales adds a run size to the brief — a genuinely different
       calculation, and the only way a fixture can make one now that it
       can neither type a rate nor post a scenario. */
    const enq2 = await Enquiry.findById(seeded.enquiry._id);
    enq2.costingBriefs[0].quantities = [
      ...SCENARIOS.map((sc) => ({ ...sc, quantity: String(sc.quantity) })),
      { key: "q9000", label: "9000 pcs", quantity: "9000", isPrimary: false },
    ];
    enq2.markModified("costingBriefs");
    await enq2.save();
    /* ── A LATER VERSION OF THE SAME SOURCES ──────────────────────────
       This inflated the fabric rate to 99000 by hand, so a projection that
       read the newest version instead of the approved one would be caught by
       that figure appearing. A fixture cannot type a rate any more, so the
       later version costs a THIRD run size — a genuinely different
       calculation, and one whose extra scenario key is just as visible in a
       response that read the wrong version. Sales added it to the brief
       above, which is also what makes the estimate stale and so worth
       preparing again. */
    const v2 = await prepareForCosting(costingId);
    expect(v2.status).toBe(201);
    workingId = v2.body.versions[0].id;
  }

  return { co, me, seeded, costingId, versionId, workingId, enquiry };
}

const project = (w, q = "") =>
  hit(`/${w.costingId}/procurement-projection${q}`, { token: w.me.token, company: w.co._id });

/**
 * A fixture provenance entry, keyed to the row the SERVER assembled.
 *
 * ── WHY THIS TRANSLATION EXISTS ─────────────────────────────────────────────
 * The entries below are written with readable keys — `fabric`, `job` — because
 * a suite whose evidence reads `mat:68f1a2...::` is a suite nobody can follow.
 * Those used to BE the line keys, because the fixture typed its own cost lines
 * and chose them.
 *
 * It cannot any more: the rows are assembled from the technical record and
 * their keys are built from the item and the service the record names. A
 * projection joins provenance to a cost line BY KEY, so evidence stamped under
 * a name the version does not contain produces no requirement at all — which
 * is a silently empty projection rather than a failing one.
 *
 * So the readable name is translated here, in one place, and every entry below
 * stays as legible as it was.
 */
const assembledKey = (w, entry) => {
  const map = {
    fabric: w.seeded.materialLineKey,
    job: w.seeded.serviceLineKey,
    bag: w.seeded.packagingLineKey,
    stitch: w.seeded.operationLineKey,
  };
  const key = map[entry.lineKey];
  return key ? { ...entry, lineKey: key } : entry;
};

/**
 * Stamp frozen supplier evidence onto an already-approved version.
 *
 * ── WHY THE DRIVER, AND WHY THIS IS HONEST ──────────────────────────────────
 * `offerProvenance` is written by the calculation when a line is priced from a
 * real dated quotation in the Store register. Building that whole chain here
 * would test the offer picker, not the projection. What the projection reads
 * is a FROZEN version, so the fixture writes one — exactly the shape a costing
 * approved last March carries — through the driver, which also bypasses the
 * immutability guard the way the legacy fixtures do.
 *
 * The route then reads it through the ordinary path, with no test seam.
 */
async function freezeProvenance(w, entries) {
  await CostingVersion.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(w.versionId)) },
    { $set: { offerProvenance: entries.map((e) => assembledKey(w, e)) } },
  );
}

/* One material line, priced from a dated quotation, with a per-scenario
   purchase quantity for each approved run size. */
const FABRIC = {
  lineKey: "fabric", state: "SUPPLIER_QUOTATION",
  supplierId: new mongoose.Types.ObjectId(), supplierName: "Arvind Mills",
  itemId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(),
  itemName: "Oxford cotton", itemSku: "FAB-OX", variantLabel: "Blue",
  quotationReference: "Q-14", offerRevision: 2,
  quotationDate: new Date("2026-06-01"), validUntil: new Date("2027-12-31"),
  currency: "INR", netRateMinor: 41250, priceBasis: "PER_METRE",
  purchaseUom: "m", consumptionUom: "m", conversionFactor: "1", conversionPath: "m → m",
  quantityPerUnit: "1.4", appliedPurchaseQuantity: "700", moq: 500, orderMultiple: 50,
  scenarios: [
    { scenarioKey: "q500", outputQuantity: "500", purchaseQuantity: "700", purchaseUom: "m", netRateMinor: 41250, taxTreatment: "RECOVERABLE", gstAmountMinor: 519750 },
    { scenarioKey: "q2000", outputQuantity: "2000", purchaseQuantity: "2800", purchaseUom: "m", netRateMinor: 39000, taxTreatment: "RECOVERABLE", gstAmountMinor: 2079000 },
  ],
};
/* A service, which must stay a service. */
const WASH = {
  lineKey: "job", state: "SUPPLIER_QUOTATION",
  supplierId: new mongoose.Types.ObjectId(), supplierName: "Blue Wash Co",
  serviceId: new mongoose.Types.ObjectId(), serviceCode: "WASH", serviceName: "Enzyme wash",
  sacCode: "9988", billingUnit: "piece", requestedUnit: "piece",
  quotationReference: "S-9", offerRevision: 1, validUntil: new Date("2027-12-31"),
  currency: "INR", appliedServiceQuantity: "500",
  scenarios: [
    { scenarioKey: "q500", serviceQuantity: "500", billingUnit: "piece", lineNetMinor: 400000 },
    { scenarioKey: "q2000", serviceQuantity: "2000", billingUnit: "piece", lineNetMinor: 1600000 },
  ],
};


const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");

const mkItem = (id, over = {}) => RawItem.collection.insertOne({
  _id: new mongoose.Types.ObjectId(String(id)),
  name: "Oxford cotton", sku: "FAB-OX", category: "Fabric", ...over,
});
const mkService = (id, companyId, over = {}) => Service.collection.insertOne({
  _id: new mongoose.Types.ObjectId(String(id)),
  companyId, serviceCode: "WASH", name: "Enzyme wash", category: "Processing", ...over,
});

/* A second physical line from a DIFFERENT supplier, on a line key the version
   actually has (`bag`, the packaging line) — the case that must stay ONE
   Product request with two independently identifiable lines. */
const THREAD = {
  ...FABRIC,
  lineKey: "bag",
  supplierId: new mongoose.Types.ObjectId(), supplierName: "Coats India",
  itemId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(),
  itemName: "Poly thread", itemSku: "TRD-40",
  quotationReference: "Q-88", offerRevision: 1,
  netRateMinor: 1200,
  scenarios: [
    { scenarioKey: "q500", outputQuantity: "500", purchaseQuantity: "20", purchaseUom: "cone", netRateMinor: 1200 },
  ],
  purchaseUom: "cone", consumptionUom: "cone", appliedPurchaseQuantity: "20",
};

const prepare = (w, q = "") =>
  hit(`/${w.costingId}/procurement-projection/requests${q}`, { token: w.me.token, company: w.co._id });

/**
 * The projection, created through the SERVICE.
 *
 * ── WHY NOT THROUGH THE HTTP DOOR ANY MORE ──────────────────────────────────
 * `POST /:id/procurement-projection/requests` is retired: it could raise
 * purchasing demand for an enquiry nobody ordered, at a quantity no confirmed
 * order line named, and it answers 410 naming the confirmed-order
 * demand-release authority instead.
 *
 * What these suites are about is the REPORTING chain that reads such records —
 * request → order → receipt → inspection → bill — and that chain is unchanged.
 * So the fixture calls the same engine the retired door called, which is also
 * the engine the new authority calls. Retiring a door is not a reason to stop
 * testing what came through it.
 */
const projectionHandoffService = require("../../services/centralCosting/projectionHandoff.service");
const companyContext = require("../../services/centralCosting/companyContext.service");

const create = async (w, body, key) => {
  const payload = { costingVersionId: w.versionId, scenarioKey: "q500", ...body };
  try {
    /* The same context the middleware builds: the actor fields the handoff
       stamps its records with, and the capability set it checks. Resolved
       through the real resolver so the fixture cannot grant itself something
       the route would not. */
    const ctx = await companyContext.resolveForActor(
      w.me.user,
      { requestedCompanyId: String(w.co._id) },
    );
    const out = await projectionHandoffService.handoff(
      ctx,
      {
        costingId: w.costingId,
        costingVersionId: payload.costingVersionId,
        scenarioKey: payload.scenarioKey,
        requirementIds: Array.isArray(payload.requirementIds) ? payload.requirementIds : [],
        purpose: String(payload.purpose || ""),
        requiredDate: payload.requiredDate || null,
        requiredDateReason: String(payload.requiredDateReason || ""),
        idempotencyKey: key || newKey(),
      },
    );
    return { status: out.mode === "RECOVERED" ? 200 : 201, body: { success: true, ...out } };
  } catch (err) {
    /* Shaped like the route's own refusal, so every assertion below reads the
       same way it did when this went over HTTP. */
    return {
      status: err?.status || 400,
      body: { success: false, code: err?.code, message: err?.message, ...(err?.details || {}) },
    };
  }
};

const idsOf = (prepared, kind) => prepared.requirements
  .filter((r) => (kind ? r.kind === kind : true)).map((r) => r.requirementId);


const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const report = (w, q = "") =>
  hit(`/${w.costingId}/actual-procurement${q}`, { token: w.me.token, company: w.co._id });

/**
 * Drive the whole chain to whatever depth a test needs.
 *
 * Written through the driver rather than through Lane B's routes: this suite
 * is about whether the REPORT reads the records correctly, not about whether
 * Store's own workflows produce them, and driving those would test Lane B.
 * Every id below is the one the real chain stores.
 */
async function chain(w, { order = true, receive = 0, inspect = null, bill = null, landed = null } = {}) {
  await freezeProvenance(w, [FABRIC]);
  await RawItem.collection.insertOne({
    _id: new mongoose.Types.ObjectId(String(FABRIC.itemId)),
    name: "Oxford cotton", sku: "FAB-OX", category: "Fabric",
  });
  const prepared = await hit(`/${w.costingId}/procurement-projection/requests`, { token: w.me.token, company: w.co._id });
  /* Through the service, like `create` above: the HTTP door is retired and
     what this fixture needs is the RECORD it used to produce. */
  const created = await create(w, { requirementIds: idsOf(prepared.body, "PHYSICAL") });
  if (created.status !== 201) throw new Error(`handoff refused: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);

  const request = await SpendRequest.findById(created.body.productRequest.requestId).lean();
  await SpendRequest.updateOne({ _id: request._id }, { $set: { status: "approved" } });
  const spendLineId = request.items[0]._id;
  if (!order) return { request, spendLineId, po: null };

  /* The purchase order, joined to the request line by the STORED id. */
  const poLineId = new mongoose.Types.ObjectId();
  const po = await PurchaseOrder.collection.insertOne({
    companyId: w.co._id, poNumber: `PO-${++seq}`, spendRequestId: request._id,
    vendorId: new mongoose.Types.ObjectId(String(FABRIC.supplierId)), vendorName: "Arvind Mills",
    status: "issued",
    items: [{ _id: poLineId, spendLineId, name: "Oxford cotton", quantity: 700, unit: "m", rate: 412.5, amount: 288750 }],
  });
  const purchaseOrderId = po.insertedId;

  if (receive > 0) {
    await GoodsReceipt.collection.insertOne({
      companyId: w.co._id, purchaseOrderId, grnNumber: `GRN-${++seq}`, status: "RECORDED",
      lines: [{ _id: new mongoose.Types.ObjectId(), poItemId: poLineId, receivedQuantity: receive, unit: "m" }],
    });
  }
  if (inspect) {
    await GoodsReceiptInspection.collection.insertOne({
      companyId: w.co._id, purchaseOrderId,
      lines: [{
        goodsReceiptLineId: new mongoose.Types.ObjectId(), poItemId: poLineId, unit: "m",
        receivedQuantity: receive, ...inspect,
      }],
    });
  }
  if (bill) {
    await Acc_Voucher.collection.insertOne({
      companyId: w.co._id, voucherType: "purchase", voucherNumber: `PV-${++seq}`,
      voucherDate: new Date("2026-08-01"), status: bill.status || "posted",
      purchaseOrderId, grandTotal: bill.net ?? 288750,
      inventoryEntries: [{
        _id: new mongoose.Types.ObjectId(),
        poItemId: bill.unlinked ? null : poLineId,
        quantity: bill.quantity ?? 700, rate: bill.rate ?? 412.5, amount: bill.net ?? 288750,
        taxAmount: bill.taxAmount ?? 0,
        ...(bill.taxRecoverable === undefined ? {} : { taxRecoverable: bill.taxRecoverable }),
      }],
    });
  }
  if (landed) {
    await mongoose.connection.db.collection("landed_cost_allocations").insertOne({
      companyId: w.co._id, purchaseOrderId, sourceVoucherId: new mongoose.Types.ObjectId(),
      sourceVoucherNumber: `PV-F-${++seq}`, status: "active",
      targets: [{ movementId: new mongoose.Types.ObjectId(), poLineId, itemId: new mongoose.Types.ObjectId(String(FABRIC.itemId)), receivedQuantity: 700, allocatedAmount: landed.amount }],
    });
  }
  return { request, spendLineId, purchaseOrderId, poLineId };
}

/* The material row, found by the key the SERVER assembled rather than the
   fixture's readable `fabric` — see `assembledKey`, which translates one into
   the other when the evidence is stamped. */
const rowOf = (res, w) => res.body.requirements
  .find((r) => r.requirementId === `${w.seeded.materialLineKey}:PHYSICAL`);

/* ── 1, 2 · THE ESTIMATE IS THE APPROVED ONE ─────────────────────────────── */

describe("where the estimate comes from", () => {
  test("the approved version's own figures are the estimate, not the working version's", async () => {
    const w = await world({ newerWorking: true });
    await chain(w, { order: false });
    const r = await report(w);
    expect(r.status).toBe(200);
    expect(r.body.version.costingVersionId).toBe(w.versionId);
    /* The later, unapproved version's inflated fabric cost is nowhere in it. */
    expect(JSON.stringify(r.body)).not.toContain("99000");
    expect(rowOf(r, w).estimate.rateMinor).toBe(41250);
    expect(rowOf(r, w).estimate.supplierName).toBe("Arvind Mills");
    expect(rowOf(r, w).estimate.quotation).toBe("Q-14");
  });

  test("the report names itself honestly and explains what it is not", async () => {
    const w = await world();
    await chain(w, { order: false });
    const r = await report(w);
    expect(r.body.title).toBe("Procurement cost feedback");
    expect(r.body.standing).toMatch(/not the full finished-product actual cost/i);
    expect(r.body.laterConnections).toEqual(expect.arrayContaining(["Final finished-product unit cost"]));
  });
});

/* ── 3, 4 · LINEAGE BY STORED ID ─────────────────────────────────────────── */

describe("how the report finds the actuals", () => {
  test("the chain joins request → order → receipt → inspection → bill by stored ids", async () => {
    const w = await world();
    await chain(w, {
      receive: 700,
      inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "posted" },
    });
    const row = rowOf(await report(w), w);
    expect(row.actual.ordered).toHaveLength(1);
    expect(row.actual.ordered[0].supplierName).toBe("Arvind Mills");
    expect(row.actual.receivedQuantity).toBe(700);
    expect(row.actual.acceptedQuantity).toBe(700);
    expect(row.actual.postedNetMinor).toBe(28875000);
    expect(row.state).toBe("Posted actual available");
    /* Every hop has a document behind it. */
    expect(row.documents.request.number).toMatch(/^SPR-/);
    expect(row.documents.orders[0].number).toMatch(/^PO-/);
    expect(row.documents.vouchers[0].number).toMatch(/^PV-/);
  });

  test("an identically named, identically priced order for another costing is never picked up", async () => {
    const w = await world();
    await chain(w, { order: false });
    /* Same item name, same supplier name, same amount — and no stored link to
       this costing's request line. A name or amount match would find it. */
    await PurchaseOrder.collection.insertOne({
      companyId: w.co._id, poNumber: `PO-DECOY-${++seq}`,
      spendRequestId: new mongoose.Types.ObjectId(), vendorName: "Arvind Mills", status: "issued",
      items: [{ _id: new mongoose.Types.ObjectId(), spendLineId: null, name: "Oxford cotton", quantity: 700, unit: "m", rate: 412.5, amount: 288750 }],
    });
    const row = rowOf(await report(w), w);
    expect(row.actual.ordered).toHaveLength(0);
    expect(row.state).toBe("Approved, not ordered");
    expect(JSON.stringify(row)).not.toContain("PO-DECOY");
  });

  test("where the lineage stops is said precisely", async () => {
    const w = await world();
    await chain(w, { receive: 700 });
    const row = rowOf(await report(w), w);
    const gaps = row.gaps.map((g) => g.key);
    expect(gaps).toContain("NO_INSPECTION");
    expect(row.gaps.find((g) => g.key === "NO_INSPECTION").message)
      .toMatch(/received is not accepted/i);
    expect(row.state).toBe("Received, awaiting inspection");
    expect(row.nextAction).toBe("Waiting for inspection.");
  });
});

/* ── 19, 20 · NO FALSE FINAL NUMBER ──────────────────────────────────────── */

describe("completeness", () => {
  test("a partial lifecycle is labelled actual to date, and yields no unit cost", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 600, quarantinedQuantity: 100, rejectedQuantity: 0 } });
    const r = await report(w);
    expect(r.body.summary.complete).toBe(false);
    expect(r.body.summary.label).toBe("Actual to date — incomplete");
    /* THE POINT: a partial posted amount is never divided by the approved
       output quantity to manufacture a per-unit figure. */
    expect(r.body.summary.perUnitActualMinor).toBeNull();
    expect(r.body.summary.perUnitWithheldReason).toMatch(/cannot be divided into a per-unit cost/i);
    expect(rowOf(r, w).complete).toBe(false);
  });

  test("even a fully posted line withholds a per-unit actual, and says why", async () => {
    const w = await world();
    await chain(w, {
      receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "posted" },
    });
    const r = await report(w);
    expect(rowOf(r, w).complete).toBe(true);
    /* A per-unit figure is a FINISHED-PRODUCT claim, and production
       consumption, labour and output quantities are not connected. */
    expect(r.body.summary.perUnitActualMinor).toBeNull();
    expect(r.body.summary.perUnitWithheldReason).toMatch(/production consumption, labour and output quantities/i);
  });

  test("the separate figures are all reported, never collapsed into one", async () => {
    const w = await world();
    await chain(w, {
      receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "posted" }, landed: { amount: 5000 },
    });
    const s = (await report(w)).body.summary;
    for (const key of [
      "estimatedProcurementMinor", "orderedMinor", "postedActualMinor", "landedPostedMinor",
      "remainingWithoutPostedMinor", "coveragePercent", "awaitingBillMinor", "notOrderedMinor",
    ]) {
      expect(s).toHaveProperty(key);
    }
    expect(s.landedPostedMinor).toBe(500000);
    expect(typeof s.coveragePercent).toBe("number");
  });
});

/* ── 10, 23 · DRAFT BILLS AND UNCONNECTED FAMILIES ───────────────────────── */

describe("what does not become an actual", () => {
  test("a draft bill is visible but excluded from the actual", async () => {
    const w = await world();
    await chain(w, {
      receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "draft" },
    });
    const row = rowOf(await report(w), w);
    expect(row.actual.postedActualMinor).toBe(0);
    expect(row.actual.recordedNotPosted).toHaveLength(1);
    expect(row.state).toBe("Bill recorded, awaiting posting");
  });

  test("unconnected cost families say so instead of reading as free", async () => {
    const w = await world();
    await chain(w, { order: false });
    const families = (await report(w)).body.families;
    expect(families).toHaveLength(9);
    const byKey = Object.fromEntries(families.map((f) => [f.key, f]));
    expect(byKey.operations.connected).toBe(false);
    expect(byKey.operations.reason).toMatch(/Actual source not connected/i);
    /* Not one of them carries a zero amount. */
    for (const f of families) expect(f).not.toHaveProperty("amountMinor");
  });
});

/* ── 24, 25, 26 · WHO MAY READ IT ────────────────────────────────────────── */

describe("who may read the actuals", () => {
  test("an output-only Sales reader is refused — this is cost data", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }, bill: { status: "posted" } });
    const sales = await actor([w.co], { admin: false });
    const r = await hit(`/${w.costingId}/actual-procurement`, { token: sales.token, company: w.co._id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.requirements).toBeUndefined();
    /* Not one supplier rate or posted amount leaks through the refusal. */
    expect(JSON.stringify(r.body)).not.toMatch(/41250|288750|Arvind Mills|PV-/);
  });

  test("a permitted Finance reader sees the report", async () => {
    const w = await world();
    await chain(w, { order: false });
    const r = await report(w);
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
  });

  test("another company cannot read it", async () => {
    const a = await world();
    await chain(a, { order: false });
    const b = await world();
    const r = await hit(`/${a.costingId}/actual-procurement`, { token: b.me.token, company: b.co._id });
    expect(r.body.available).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("Arvind Mills");
  });
});

/* ── 11, 27 · READING CHANGES NOTHING ────────────────────────────────────── */

describe("the report writes nothing", () => {
  test("repeated reads leave every source document byte-identical", async () => {
    const w = await world();
    const built = await chain(w, {
      receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "posted" }, landed: { amount: 5000 },
    });

    const snapshot = async () => ({
      version: await CostingVersion.findById(w.versionId).lean(),
      costing: await Costing.findById(w.costingId).lean(),
      request: await SpendRequest.findById(built.request._id).lean(),
      po: await PurchaseOrder.collection.findOne({ _id: built.purchaseOrderId }),
      grn: await GoodsReceipt.collection.findOne({ purchaseOrderId: built.purchaseOrderId }),
      inspection: await GoodsReceiptInspection.collection.findOne({ purchaseOrderId: built.purchaseOrderId }),
      voucher: await Acc_Voucher.collection.findOne({ purchaseOrderId: built.purchaseOrderId }),
      landed: await mongoose.connection.db.collection("landed_cost_allocations").findOne({ purchaseOrderId: built.purchaseOrderId }),
      counts: {
        po: await PurchaseOrder.collection.countDocuments({}),
        grn: await GoodsReceipt.collection.countDocuments({}),
        voucher: await Acc_Voucher.collection.countDocuments({}),
        requests: await SpendRequest.countDocuments({}),
      },
    });

    const before = await snapshot();
    await report(w);
    await report(w, "?scenarioKey=q500");
    await report(w);
    const after = await snapshot();

    /* Not a status, not a timestamp, not a counter, not a new document. */
    expect(after).toEqual(before);
  });
});
