// test/costing/production-actual.route.test.js
//
// PRODUCTION EVIDENCE, COMPOSED WITH PROCUREMENT — AND STILL NO UNIT COST.
//
// The report reaches through real records to real work orders and real stock
// issues, and then correctly refuses to produce a per-good-unit cost, because
// good accepted output has no authoritative source in this system. These tests
// prove the refusal is principled rather than an absence of plumbing.
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
  await mongoose.connect(rs.getUri(), { dbName: "production_actual" });
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

const newKey = () => `pa-${++seq}-${Math.random().toString(36).slice(2)}`;
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
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged. */
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
  hit(`/${w.costingId}/actual-cost${q}`, { token: w.me.token, company: w.co._id });

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

const rowOf = (res) => res.body.requirements.find((r) => r.requirementId === "fabric:PHYSICAL");


const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

/** Add production evidence on top of the procurement chain. */
async function produce(w, { workOrders = [], issues = [] } = {}) {
  const request = await CustomerRequest.create({
    requestId: `MO-${++seq}`, customerInfo: { name: "Acme" },
    quotations: [{
      quotationNumber: `Q-${seq}`, status: "customer_approved",
      items: [{
        itemName: "Oxford Shirt", quantity: 500, unitPrice: 300,
        stockItemId: new mongoose.Types.ObjectId(),
        costingSource: {
          source: "APPROVED_COSTING", costingVersionId: new mongoose.Types.ObjectId(String(w.versionId)),
          costingVersionNumber: 1, unitPriceMinor: 30000, currency: "INR", priceTier: "target",
        },
      }],
    }],
  });
  const stockItemId = request.quotations[0].items[0].stockItemId;

  const made = [];
  for (const wo of workOrders) {
    const doc = await WorkOrder.collection.insertOne({
      workOrderNumber: `WO-${++seq}`, customerRequestId: request._id,
      stockItemId: wo.foreign ? new mongoose.Types.ObjectId() : stockItemId,
      status: wo.status || "in_progress", quantity: wo.quantity ?? 500,
      cuttingProgress: { completed: wo.started ?? 500 },
      productionCompletion: {
        overallCompletedQuantity: wo.completed ?? 0,
        efficiencyMetrics: wo.metrics || [],
      },
      qcCompletion: { completedQuantity: wo.qc ?? 0 },
      packagedQuantity: 0, bulkDispatchHistory: [],
    });
    made.push(doc.insertedId);
  }
  for (const i of issues) {
    await StockIssuance.collection.insertOne({
      companyId: w.co._id, direction: i.direction || "debit",
      manufacturingOrder: request._id, moNumber: request.requestId,
      items: [{ rawItem: new mongoose.Types.ObjectId(String(FABRIC.itemId)), variantId: null, nativeQty: i.qty, nativeUnit: i.unit || "m", issuedQty: i.qty, issuedUnit: i.unit || "m", rawItemName: "Oxford cotton" }],
    });
  }
  return { request, stockItemId, workOrderIds: made };
}

/* ── THE COMPOSED REPORT ─────────────────────────────────────────────────── */

describe("the actual cost and margin report", () => {
  test("it composes procurement with production and keeps 8A's section intact", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }, bill: { status: "posted" } });
    await produce(w, { workOrders: [{ completed: 480, qc: 470 }], issues: [{ qty: 740 }] });

    const r = await report(w);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("Actual cost & margin");
    /* The procurement report is carried whole, so its tab keeps working. */
    expect(r.body.procurement.available).toBe(true);
    expect(r.body.procurement.summary.postedActualMinor).toBe(28875000);
    /* And production is now beside it. */
    expect(r.body.output.completed).toBe(480);
    expect(r.body.lineage.workOrders).toHaveLength(1);
  });

  test("a work order for another product under the same order is excluded and kept visible", async () => {
    const w = await world();
    await chain(w, { order: false });
    await produce(w, { workOrders: [{ completed: 480 }, { completed: 999, foreign: true }] });

    const r = await report(w);
    expect(r.body.output.completed).toBe(480);
    expect(r.body.lineage.workOrders).toHaveLength(1);
    /* Not silently dropped. */
    expect(r.body.lineage.unlinkedWorkOrders).toHaveLength(1);
    expect(r.body.lineage.unlinkedWorkOrders[0].reason).toMatch(/product identity does not match/i);
  });

  test("cancelled work is excluded from output but survives as history", async () => {
    const w = await world();
    await chain(w, { order: false });
    await produce(w, { workOrders: [{ completed: 200 }, { completed: 999, status: "cancelled" }] });
    const r = await report(w);
    expect(r.body.output.completed).toBe(200);
    expect(r.body.lineage.cancelledWorkOrders).toHaveLength(1);
    expect(r.body.lineage.cancelledWorkOrders[0].reason).toMatch(/kept as history/i);
  });

  test("issues and returns net once, through the stored manufacturing order", async () => {
    const w = await world();
    await chain(w, { order: false });
    await produce(w, {
      workOrders: [{ completed: 480 }],
      issues: [{ qty: 740 }, { qty: 40, direction: "credit" }],
    });
    const r = await report(w);
    const material = r.body.materials[0];
    expect(material.issuedQty).toBe(740);
    expect(material.returnedQty).toBe(40);
    expect(material.netIssuedQty).toBe(700);
    /* Named for what it is. */
    expect(material.actualBasis).toBe("Net issued to production");
    expect(material.consumedValueMinor).toBeNull();
  });
});

/* ── THE GATE ────────────────────────────────────────────────────────────── */

describe("no final unit cost", () => {
  test("even a fully posted, fully produced order yields no per-unit cost, and says why", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }, bill: { status: "posted" } });
    await produce(w, { workOrders: [{ completed: 500, qc: 500 }], issues: [{ qty: 700 }] });

    const r = await report(w);
    expect(r.body.summary.complete).toBe(false);
    expect(r.body.summary.label).toBe("Known cost to date — incomplete");
    expect(r.body.summary.actualUnitCostMinor).toBeNull();
    /* 8C connected the per-piece QC ledger, so the reason is no longer "no
       source exists" — it is that nobody has closed the run. */
    expect(r.body.summary.unitCostWithheldReason).toMatch(/have not had their production closed/i);

    /* The known total is real, and the missing families are listed beside it
       rather than counted as zero. */
    expect(r.body.summary.knownTotalMinor).toBeGreaterThan(0);
    expect(r.body.summary.missingFamilyCount).toBeGreaterThan(0);
    const blockers = r.body.completeness.blockers.map((b) => b.key);
    expect(blockers).toContain("CLOSEOUT_INCOMPLETE");
    expect(blockers).toContain("LABOUR_SOURCE");
  });

  test("the margin is at the approved selling price and is never called realised", async () => {
    const w = await world();
    await chain(w, { order: false });
    await produce(w, { workOrders: [{ completed: 480 }] });
    const r = await report(w);
    expect(r.body.margin.label).toBe("Margin at approved selling price");
    expect(r.body.margin.approvedPriceMinor).toBe(30000);
    /* No actual margin while there is no actual unit cost. */
    expect(r.body.margin.actualUnitCostMinor).toBeNull();
    expect(r.body.margin.actualMarginMinor).toBeNull();
    expect(r.body.margin.incomeTaxNote).toMatch(/company taxable profit/i);
    expect(JSON.stringify(r.body.margin)).not.toMatch(/cash in pocket/i);
  });

  test("variance reconciles exactly, whatever the evidence", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }, bill: { status: "posted" } });
    await produce(w, { workOrders: [{ completed: 480 }] });
    const v = (await report(w)).body.variance;
    expect(v.explainedMinor + v.unexplainedMinor).toBe(v.totalMinor);
  });
});

/* ── READ-ONLY ───────────────────────────────────────────────────────────── */

describe("the report writes nothing", () => {
  test("repeated reads leave every production and procurement record identical", async () => {
    const w = await world();
    const built = await chain(w, {
      receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 },
      bill: { status: "posted" }, landed: { amount: 5000 },
    });
    const made = await produce(w, { workOrders: [{ completed: 480, qc: 470 }], issues: [{ qty: 740 }, { qty: 40, direction: "credit" }] });

    const snapshot = async () => ({
      version: await CostingVersion.findById(w.versionId).lean(),
      costing: await Costing.findById(w.costingId).lean(),
      request: await SpendRequest.findById(built.request._id).lean(),
      customerRequest: await CustomerRequest.findById(made.request._id).lean(),
      workOrders: await WorkOrder.collection.find({ customerRequestId: made.request._id }).sort({ _id: 1 }).toArray(),
      issuances: await StockIssuance.collection.find({ manufacturingOrder: made.request._id }).sort({ _id: 1 }).toArray(),
      counts: {
        wo: await WorkOrder.collection.countDocuments({}),
        si: await StockIssuance.collection.countDocuments({}),
        cr: await CustomerRequest.countDocuments({}),
        sr: await SpendRequest.countDocuments({}),
      },
    });

    const before = await snapshot();
    await report(w);
    await report(w, "?scenarioKey=q500");
    await report(w);
    expect(await snapshot()).toEqual(before);
  });

  test("an output-only Sales reader is refused, and no cost leaks through", async () => {
    const w = await world();
    await chain(w, { receive: 700, inspect: { acceptedQuantity: 700, quarantinedQuantity: 0, rejectedQuantity: 0 }, bill: { status: "posted" } });
    await produce(w, { workOrders: [{ completed: 480 }] });
    const sales = await actor([w.co], { admin: false });
    const r = await hit(`/${w.costingId}/actual-cost`, { token: sales.token, company: w.co._id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.bridge).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(/28875000|Arvind Mills|WO-/);
  });

  test("another company cannot read it", async () => {
    const a = await world();
    await chain(a, { order: false });
    const b = await world();
    const r = await hit(`/${a.costingId}/actual-cost`, { token: b.me.token, company: b.co._id });
    expect(r.body.available).toBe(false);
  });
});
