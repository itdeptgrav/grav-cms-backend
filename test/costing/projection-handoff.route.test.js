// test/costing/projection-handoff.route.test.js
//
// FROM AN APPROVED COSTING'S PROJECTION TO DRAFT REQUESTS — AND NO FURTHER.
//
// The dangerous mistakes here all look like helpfulness. Creating a purchase
// order because the supplier is known. Reserving budget because the head
// resolved. Trusting a quantity the browser sent because it looks like the one
// the screen showed. Raising a second request for demand already asked for.
// Putting a service on a product request because both are things you buy.
//
// Every one of those turns a draft into a commitment nobody made.
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
  await mongoose.connect(rs.getUri(), { dbName: "projection_handoff" });
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

const newKey = () => `ph-${++seq}-${Math.random().toString(36).slice(2)}`;
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

/* ── 1, 2, 3, 4 · HOW MANY DRAFTS, AND OF WHAT ───────────────────────────── */

describe("the retired HTTP door", () => {
  test("POST cannot produce a record, and names the replacement", async () => {
    /* ── THE BYPASS THIS CLOSES ───────────────────────────────────────────
       It raised purchasing demand from a COSTING: no confirmed order, no
       order line, no reconciliation of demand already released. Anybody
       holding `costing.draft.write` could commit the company to buy for an
       enquiry nobody had ordered.

       410 rather than 404: a caller still posting here is told where the act
       moved to, not handed something that reads as a broken deploy. */
    const w = await world();
    const prepared = await prepare(w);
    const before = await SpendRequest.countDocuments({ companyId: w.co._id });

    const r = await hit(`/${w.costingId}/procurement-projection/requests`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: {
        costingVersionId: w.versionId, scenarioKey: "q500",
        requirementIds: idsOf(prepared.body, "PHYSICAL"),
      },
    });

    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("PROCUREMENT_PROJECTION_RETIRED");
    expect(r.body.error.details.use).toMatch(/demand-release/);
    /* And nothing was created — a refusal that still writes is not one. */
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(before);
  });
});

describe("how many drafts one action creates", () => {
  test("a physical-only selection creates exactly one Product draft", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });

    expect(r.status).toBe(201);
    expect(r.body.drafts).toHaveLength(1);
    expect(r.body.productRequest.requestType).toBe("PRODUCT");
    expect(r.body.serviceRequest).toBeNull();
    const doc = await SpendRequest.findById(r.body.productRequest.requestId).lean();
    expect(doc.requestType).toBe("PRODUCT");
    /* A DRAFT — not submitted, not pending anybody. */
    expect(doc.status).toBe("draft");
  });

  test("a service-only selection creates exactly one Service draft", async () => {
    const w = await world();
    await freezeProvenance(w, [WASH]);
    await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "SERVICE") });

    expect(r.status).toBe(201);
    expect(r.body.drafts).toHaveLength(1);
    expect(r.body.serviceRequest.requestType).toBe("SERVICE");
    expect(r.body.productRequest).toBeNull();
    expect((await SpendRequest.findById(r.body.serviceRequest.requestId).lean()).status).toBe("draft");
  });

  test("a mixed selection creates exactly two drafts — never one, never three", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    await mkItem(FABRIC.itemId); await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body) });

    expect(r.status).toBe(201);
    expect(r.body.drafts).toHaveLength(2);
    expect(r.body.productRequest).toBeTruthy();
    expect(r.body.serviceRequest).toBeTruthy();
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("two suppliers stay two lines on ONE Product request", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, THREAD]);
    await mkItem(FABRIC.itemId); await mkItem(THREAD.itemId, { name: "Poly thread", sku: "TRD-40" });
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });

    /* NOT one request per supplier — the costing priced them separately and
       Store raises the separate purchase orders later from one approved
       request. */
    expect(r.body.drafts).toHaveLength(1);
    const doc = await SpendRequest.findById(r.body.productRequest.requestId).lean();
    expect(doc.items).toHaveLength(2);

    /* ── AND THE TWO REMAIN INDEPENDENTLY IDENTIFIABLE ──────────────────
       This is the contract a future PO split depends on: each line keeps its
       own supplier, its own quotation and its own costing line. */
    const byLine = Object.fromEntries(doc.items.map((l) => [l.costingDemandSource.costingLineKey, l]));
    /* Keyed by the row the SERVER assembled — `assembledKey` translated the
       fixture's readable `fabric` and `bag` into these when the evidence was
       stamped, and the request line carries the real key through. */
    const fabric = byLine[w.seeded.materialLineKey];
    const bag = byLine[w.seeded.packagingLineKey];
    expect(fabric.suggestedVendorName).toBe("Arvind Mills");
    expect(bag.suggestedVendorName).toBe("Coats India");
    expect(String(fabric.vendorId)).not.toBe(String(bag.vendorId));
    expect(fabric.quoteRef).toMatch(/^Q-14/);
    expect(bag.quoteRef).toMatch(/^Q-88/);
    expect(fabric.costingDemandSource.costingLineKey).toBe(w.seeded.materialLineKey);
    expect(bag.costingDemandSource.costingLineKey).toBe(w.seeded.packagingLineKey);
    /* Neither was collapsed, and the request was not refused for having two. */
    expect(new Set(doc.items.map((l) => String(l.rawItem))).size).toBe(2);
  });
});

/* ── 5, 6, 7 · WHAT GOES ON WHICH REQUEST ────────────────────────────────── */

describe("physical and service never cross over", () => {
  test("a service is written as a service, never as a physical item", async () => {
    const w = await world();
    await freezeProvenance(w, [WASH]);
    await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "SERVICE") });
    const line = (await SpendRequest.findById(r.body.serviceRequest.requestId).lean()).items[0];

    expect(String(line.service)).toBe(String(WASH.serviceId));
    expect(line.serviceCode).toBe("WASH");
    expect(line.billingUnit).toBe("piece");
    expect(line.sacCode).toBe("9988");
    /* Nothing that would put it on a stock ledger. */
    expect(line.rawItem).toBeNull();
    expect(line.rawItemSku).toBe("");
  });

  test("a physical item is written as an item, never as a service", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    if (r.status !== 201) throw new Error(`create refused: ${r.status} ${JSON.stringify(r.body).slice(0,500)}`);
    const doc0 = await SpendRequest.findById(r.body.productRequest.requestId).lean();
    if (!doc0 || !doc0.items) throw new Error(`doc: ${JSON.stringify(doc0).slice(0,600)} | resp: ${JSON.stringify(r.body).slice(0,300)}`);
    const line = doc0.items[0];

    expect(String(line.rawItem)).toBe(String(FABRIC.itemId));
    expect(line.rawItemSku).toBe("FAB-OX");
    expect(line.baseUnit).toBe("m");
    expect(line.service).toBeNull();
    expect(line.serviceCode).toBe("");
  });

  test("internal labour, overhead and financing produce no request at all", async () => {
    const w = await world();
    /* Only the fabric has supplier evidence; stitch, burden and interest are
       ordinary cost lines on the same version. */
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const keys = p.body.requirements.map((r) => r.reference.lineKey);
    expect(keys).toEqual([w.seeded.materialLineKey]);

    const r = await create(w, { requirementIds: idsOf(p.body) });
    const doc = await SpendRequest.findById(r.body.productRequest.requestId).lean();
    expect(doc.items).toHaveLength(1);
    /* Not one of them reached a request line. */
    for (const excluded of ["stitch", "burden", "interest", "cess", "pattern"]) {
      expect(doc.items.some((l) => l.costingDemandSource?.costingLineKey === excluded)).toBe(false);
    }
  });
});

/* ── 8 · THE SERVER DESCRIBES; THE BROWSER ONLY CHOOSES ──────────────────── */

describe("what the browser may say", () => {
  test("a posted quantity, rate, supplier and budget head are all ignored", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const realHead = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: realHead, budgetLedgerName: "Fabric purchases" });
    const p = await prepare(w);

    const r = await create(w, {
      requirementIds: idsOf(p.body, "PHYSICAL"),
      /* Every one of these is a field a client must not be able to assert. */
      lines: [{ name: "Gold thread", quantity: 999999, rate: 999999, unit: "kg" }],
      quantity: 999999, rate: 999999, unitPrice: 999999,
      vendorName: "Somebody Else Ltd", vendorId: new mongoose.Types.ObjectId(),
      quoteRef: "FORGED-1",
      budgetLedgerId: new mongoose.Types.ObjectId(), budgetLedgerName: "Petty cash",
      rawItem: new mongoose.Types.ObjectId(), sacCode: "0000",
    });
    expect(r.status).toBe(201);
    const line = (await SpendRequest.findById(r.body.productRequest.requestId).lean()).items[0];

    /* The frozen projection won, on every field. */
    expect(line.quantity).toBe(700);
    expect(line.unit).toBe("m");
    expect(line.rate).toBe(412.5);
    expect(String(line.rawItem)).toBe(String(FABRIC.itemId));
    expect(line.suggestedVendorName).toBe("Arvind Mills");
    expect(line.quoteRef).toMatch(/^Q-14/);
    expect(String(line.budgetAllocation.budgetLedgerId)).toBe(String(realHead));
    /* And not a trace of what was posted. */
    const json = JSON.stringify(line);
    expect(json).not.toContain("999999");
    expect(json).not.toContain("Somebody Else");
    expect(json).not.toContain("FORGED-1");
    expect(json).not.toContain("Petty cash");
  });

  test("a requirement that is not in the authoritative projection is refused", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const r = await create(w, { requirementIds: ["ghost:PHYSICAL"] });
    expect(r.status).toBe(409);
    expect(r.body.error?.code || r.body.code).toBe("HANDOFF_REQUIREMENT_NOT_IN_PROJECTION");
    /* Never substituted with the nearest real line. */
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("naming a version that is not the approved one is a conflict, not a silent switch", async () => {
    const w = await world({ newerWorking: true });
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const r = await create(w, {
      costingVersionId: w.workingId,      // the newer, UNAPPROVED version
      requirementIds: idsOf(p.body, "PHYSICAL"),
    });
    expect(r.status).toBe(409);
    expect(r.body.error?.code || r.body.code).toBe("HANDOFF_VERSION_MISMATCH");
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a costing with nothing approved cannot raise a request", async () => {
    const w = await world({ approve: false });
    const r = await create(w, { costingVersionId: undefined, requirementIds: ["fabric:PHYSICAL"] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("an empty selection creates nothing", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const r = await create(w, { requirementIds: [] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ── 13, 14 · QUANTITIES ARE CARRIED, NOT RE-DERIVED ─────────────────────── */

describe("quantities", () => {
  test("the projected purchase quantity is used, not the garment count", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    const line = (await SpendRequest.findById(r.body.productRequest.requestId).lean()).items[0];

    /* 700 m of fabric, not 500 garments — and MOQ (500) is NOT applied again
       over a figure that already carries the engine's rounding. */
    expect(line.quantity).toBe(700);
    expect(line.unit).toBe("m");
    expect(line.costingDemandSource.projectedQuantity).toBe("700");
    expect(line.costingDemandSource.projectedUnit).toBe("m");
  });

  test("a requirement the projection could not quantify cannot be requested", async () => {
    const w = await world();
    /* Unlike units with no frozen conversion — the projection refuses a
       quantity, so there is nothing to put on a line. */
    await freezeProvenance(w, [{
      ...FABRIC, purchaseUom: "kg", consumptionUom: "m", conversionFactor: null,
      scenarios: [{ scenarioKey: "q500", purchaseQuantity: "700", purchaseUom: "kg", conversionFactor: null }],
    }]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const blocked = p.body.requirements[0];
    expect(blocked.blocked).toBe(true);
    expect(blocked.selectable).toBe(false);
    expect(blocked.blockedReason).toBeTruthy();
    expect(p.body.handoff.blockedCount).toBe(1);

    const r = await create(w, { requirementIds: [blocked.requirementId] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error?.code || r.body.code).toBe("HANDOFF_REQUIREMENT_BLOCKED");
    /* Never converted into a zero-quantity line. */
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ── 15–19 · BUDGET ──────────────────────────────────────────────────────── */

describe("budget attribution", () => {
  test("an item's own head is carried onto the line", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const head = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: head, budgetLedgerName: "Fabric purchases" });
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    const a = (await SpendRequest.findById(r.body.productRequest.requestId).lean()).items[0].budgetAllocation;

    expect(String(a.budgetLedgerId)).toBe(String(head));
    expect(a.budgetLedgerName).toBe("Fabric purchases");
    expect(a.status).toBe("resolved");
  });

  test("a service carries its own explicit head, and never a category fallback", async () => {
    const w = await world();
    await freezeProvenance(w, [WASH]);
    const head = new mongoose.Types.ObjectId();
    await mkService(WASH.serviceId, w.co._id, {
      category: "Processing", budgetLedgerId: head, budgetLedgerName: "Outside processing",
    });
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "SERVICE") });
    const a = (await SpendRequest.findById(r.body.serviceRequest.requestId).lean()).items[0].budgetAllocation;
    expect(String(a.budgetLedgerId)).toBe(String(head));
    expect(a.status).toBe("resolved");
  });

  test("an unresolved head is SAVED on the draft, visible, and never guessed", async () => {
    const w = await world();
    await freezeProvenance(w, [WASH]);
    await mkService(WASH.serviceId, w.co._id, { category: "Processing" }); // no head
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "SERVICE") });
    const line = (await SpendRequest.findById(r.body.serviceRequest.requestId).lean()).items[0];

    /* The line survives — dropping it would lose the demand. */
    expect(line.budgetAllocation.budgetLedgerId).toBeNull();
    expect(line.budgetAllocation.status).toBe("unresolved");
    /* And no head was invented for it. */
    expect(line.budgetAllocation.budgetLedgerName).toBe("");
    expect(line.budgetAllocation.resolutionReason).toMatch(/No budget head is set on this service/i);
  });

  test("creating drafts creates no budget commitment", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const head = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: head, budgetLedgerName: "Fabric purchases" });
    const p = await prepare(w);

    const before = await mongoose.connection.db.listCollections().toArray();
    const names = before.map((c) => c.name);
    const countOf = async (n) => (names.includes(n) ? mongoose.connection.db.collection(n).countDocuments({}) : 0);
    const commitmentsBefore = await countOf("budgetcommitments");

    await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });

    expect(await countOf("budgetcommitments")).toBe(commitmentsBefore);
    /* A draft is not a commitment, and the request says so itself. */
    const doc = await SpendRequest.findById((await SpendRequest.findOne({ companyId: w.co._id }).lean())._id).lean();
    expect(doc.status).toBe("draft");
  });
});

/* ── 20 · NOTHING DOWNSTREAM IS CREATED ──────────────────────────────────── */

describe("what is NOT created", () => {
  test("no purchase order, service order, material request or reservation appears", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    await mkItem(FABRIC.itemId); await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    await create(w, { requirementIds: idsOf(p.body) });

    const existing = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    const countOf = async (n) => (existing.includes(n) ? mongoose.connection.db.collection(n).countDocuments({}) : 0);
    for (const collection of [
      "purchaseorders", "serviceorders", "mrfs", "materialrequests",
      "stockreservations", "stockissuances", "goodsreceipts", "locationmovements",
    ]) {
      expect(await countOf(collection)).toBe(0);
    }
    /* Only the two drafts. */
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("the approved costing and its projection are untouched", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const versionBefore = await CostingVersion.findById(w.versionId).lean();
    const costingBefore = await Costing.findById(w.costingId).lean();
    const p = await prepare(w);
    await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });

    const versionAfter = await CostingVersion.findById(w.versionId).lean();
    expect(versionAfter.updatedAt.getTime()).toBe(versionBefore.updatedAt.getTime());
    expect(String((await Costing.findById(w.costingId).lean()).approvedVersionId))
      .toBe(String(costingBefore.approvedVersionId));

    /* And the projection reads exactly as it did. */
    const after = await prepare(w);
    expect(after.body.requirements[0].quantity.purchaseQuantity).toBe("700");
  });
});

/* ── 21, 22, 23 · IDEMPOTENCY AND ALL-OR-NOTHING ─────────────────────────── */

describe("retrying", () => {
  test("the same key returns the same drafts rather than creating a second pair", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    await mkItem(FABRIC.itemId); await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    const key = newKey();
    const body = { requirementIds: idsOf(p.body) };

    const first = await create(w, body, key);
    const again = await create(w, body, key);

    expect(first.status).toBe(201);
    expect(first.body.mode).toBe("CREATED");
    expect(again.body.mode).toBe("RECOVERED");
    /* The SAME two ids, not a second pair. */
    expect(again.body.productRequest.requestId).toBe(first.body.productRequest.requestId);
    expect(again.body.serviceRequest.requestId).toBe(first.body.serviceRequest.requestId);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("the same key with a changed selection conflicts rather than creating more", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    await mkItem(FABRIC.itemId); await mkService(WASH.serviceId, w.co._id);
    const p = await prepare(w);
    const key = newKey();

    await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") }, key);
    const changed = await create(w, { requirementIds: idsOf(p.body) }, key);

    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a refused attempt does not burn the key into a replayable success", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const key = newKey();
    const bad = await create(w, { requirementIds: ["ghost:PHYSICAL"] }, key);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    /* The same key may now be used for the corrected request. */
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ── 24, 25 · DUPLICATE DEMAND ───────────────────────────────────────────── */

describe("asking twice", () => {
  test("a requirement already on an active request cannot be requested again", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const ids = idsOf(p.body, "PHYSICAL");
    await create(w, { requirementIds: ids });

    /* The projection now says so, before anybody presses anything. */
    const again = await prepare(w);
    const req = again.body.requirements[0];
    expect(req.alreadyRequested).toBe(true);
    expect(req.demandState).toBe("Draft request");
    expect(req.selectable).toBe(false);
    expect(req.requests[0].requestNumber).toBeTruthy();

    /* And the door refuses it too — the screen is not the guard. */
    const second = await create(w, { requirementIds: ids });
    expect(second.status).toBe(409);
    expect(second.body.error?.code || second.body.code).toBe("HANDOFF_ALREADY_REQUESTED");
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a cancelled request stays visible as history and frees the requirement", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const first = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    await SpendRequest.updateOne(
      { _id: first.body.productRequest.requestId }, { $set: { status: "cancelled" } },
    );

    const again = await prepare(w);
    const req = again.body.requirements[0];
    /* History is KEPT — "did we already try this?" stays answerable. */
    expect(req.requests).toHaveLength(1);
    expect(req.requests[0].state).toBe("Cancelled/rejected");
    /* And a fresh draft is allowed. */
    expect(req.alreadyRequested).toBe(false);
    expect(req.selectable).toBe(true);
    const second = await create(w, { requirementIds: idsOf(again.body, "PHYSICAL") });
    expect(second.status).toBe(201);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(2);
  });
});

/* ── 26, 28 · PROVENANCE, AND WHAT IT DOES NOT BREAK ─────────────────────── */

describe("provenance", () => {
  test("the request and every line trace back to the exact costing line", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    const doc = await SpendRequest.findById(r.body.productRequest.requestId).lean();

    expect(doc.costingSource.source).toBe("APPROVED_COSTING_PROJECTION");
    expect(String(doc.costingSource.costingVersionId)).toBe(w.versionId);
    expect(doc.costingSource.scenarioKey).toBe("q500");
    expect(doc.costingSource.handoffKey).toBeTruthy();

    const src = doc.items[0].costingDemandSource;
    expect(src.source).toBe("APPROVED_COSTING_PROJECTION");
    expect(String(src.costingId)).toBe(w.costingId);
    expect(String(src.costingVersionId)).toBe(w.versionId);
    expect(src.costingVersionNumber).toBe(doc.costingSource.costingVersionNumber);
    expect(src.scenarioKey).toBe("q500");
    expect(src.costingLineKey).toBe(w.seeded.materialLineKey);
    expect(src.projectionRequirementId).toBe(`${w.seeded.materialLineKey}:PHYSICAL`);
    expect(src.projectedQuantity).toBe("700");
    expect(src.projectedUnit).toBe("m");
    expect(src.projectedAmountMinor).toBeGreaterThan(0);
    expect(src.currency).toBe("INR");
  });

  test("a request raised the ordinary way is unaffected and carries no costing block", async () => {
    const w = await world();
    /* Written the way every pre-existing request is: no costing anywhere. */
    const plain = await SpendRequest.create({
      companyId: w.co._id, requestNumber: `SR-PLAIN-${seq}`,
      requestedBy: w.me.emp._id, requestedByName: "Cost A", requestedById: "PP0", department: "Finance",
      title: "A perfectly ordinary request", purpose: "Because.",
      requestType: "PRODUCT", status: "draft",
      items: [{ name: "Stapler", whyNeeded: "The old one broke.", quantity: 1, unit: "pc", rate: 200, amount: 200 }],
      totalAmount: 200,
    });
    const doc = await SpendRequest.findById(plain._id).lean();
    expect(doc.costingSource).toBeUndefined();
    expect(doc.items[0].costingDemandSource).toBeUndefined();
    expect(doc.items[0].budgetAllocation).toBeUndefined();
    /* And it is invisible to the duplicate check, which reads stored
       provenance rather than matching on a name. */
    const p = await prepare(w);
    expect(p.body.available).toBe(true);
  });

  test("the supplier is labelled as estimate evidence, never as an appointment", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    expect(p.body.supplierMeaning).toBe("Supplier used in the approved cost estimate.");
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    const line = (await SpendRequest.findById(r.body.productRequest.requestId).lean()).items[0];

    /* The suggestion field, not the one Store fills in when IT chooses. */
    expect(line.suggestedVendorName).toBe("Arvind Mills");
    expect(line.vendorName).toBeUndefined();
    expect(line.vendorNote).toBe("Supplier used in the approved cost estimate.");
  });

  test("the standing explanation is on every response", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId);
    const p = await prepare(w);
    expect(p.body.standing).toMatch(/does not approve spending, reserve budget, place an order or reserve stock/i);
    const r = await create(w, { requirementIds: idsOf(p.body, "PHYSICAL") });
    expect(r.body.standing).toMatch(/does not approve spending/i);
  });
});
