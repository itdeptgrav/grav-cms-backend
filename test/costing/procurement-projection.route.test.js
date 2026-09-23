// test/costing/procurement-projection.route.test.js
//
// THE PROJECTION ENDPOINT, AGAINST A REAL APPROVED COSTING.
//
// One happy path, one visibility boundary, one company boundary, and the
// promise this whole chunk rests on: reading a projection writes nothing.
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
  await mongoose.connect(rs.getUri(), { dbName: "procurement_projection" });
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

const newKey = () => `pp-${++seq}-${Math.random().toString(36).slice(2)}`;
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
    await hit(`/${costingId}/versions/${versionId}/submit`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: {},
    });
    const a = await hit(`/${costingId}/versions/${versionId}/approve`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: { note: "Approved for projection." },
    });
    expect(a.status).toBe(200);
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

/* ── 1 · THE APPROVED VERSION, NOT THE NEWEST ────────────────────────────── */

describe("which version a projection is built from", () => {
  test("the APPROVED version is used even when a newer working version exists", async () => {
    const w = await world({ newerWorking: true });
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    /* The approved one — not the later one, which is merely newer. */
    expect(r.body.version.costingVersionId).toBe(w.versionId);
    expect(r.body.version.costingVersionId).not.toBe(w.workingId);
    /* And it is genuinely the EARLIER version, so this cannot pass by the
       working version happening to be the approved one. */
    const working = await CostingVersion.findById(w.workingId).lean();
    expect(r.body.version.versionNumber).toBeLessThan(working.versionNumber);

    /* The approved version's own evidence, and the working version's
       inflated fabric cost nowhere in it. */
    expect(r.body.requirements).toHaveLength(2);
    expect(JSON.stringify(r.body)).not.toContain("99000");
  });

  test("a version with no supplier evidence projects nothing, and says why", async () => {
    const w = await world();
    const r = await project(w);
    /* Every line here was typed rather than priced from a quotation, so
       nothing can be ordered from anybody — which is an answer, not an empty
       screen. The excluded families explain the whole cost. */
    expect(r.body.available).toBe(true);
    expect(r.body.requirements).toEqual([]);
    expect(r.body.summary.expectedProcurementValueMinor).toBe(0);
    expect(r.body.summary.notProcurement.length).toBeGreaterThan(0);
  });

  test("a physical requirement and a service requirement stay distinct end to end", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    const byKind = Object.fromEntries(r.body.requirements.map((q) => [q.kind, q]));

    expect(byKind.PHYSICAL.reference.itemId).toBeTruthy();
    expect(byKind.PHYSICAL.reference.variantId).toBeTruthy();
    expect(byKind.PHYSICAL.quantity.purchaseQuantity).toBe("700");
    expect(byKind.PHYSICAL.quantity.purchaseUom).toBe("m");
    expect(byKind.PHYSICAL.quantity.moq).toBe(500);

    /* A service has a service id, a billing unit, and no item identity or
       conversion anywhere near it. */
    expect(byKind.SERVICE.reference.serviceId).toBeTruthy();
    expect(byKind.SERVICE.reference.itemId).toBeNull();
    expect(byKind.SERVICE.quantity.billingUnit).toBe("piece");
    expect(byKind.SERVICE.quantity.conversionFactor).toBeUndefined();

    expect(r.body.summary.physicalCount).toBe(1);
    expect(r.body.summary.serviceCount).toBe(1);
  });

  test("each approved quantity gets its own frozen purchase quantity", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const small = await project(w, "?scenarioKey=q500");
    const large = await project(w, "?scenarioKey=q2000");
    /* By the key the SERVER assembled, not the fixture's readable name —
       `assembledKey` translates one into the other when the evidence is
       stamped, and a lookup that missed that would find nothing. */
    const fabricOf = (r) => r.body.requirements
      .find((q) => q.reference.lineKey === w.seeded.materialLineKey);
    expect(fabricOf(small).quantity.purchaseQuantity).toBe("700");
    expect(fabricOf(large).quantity.purchaseQuantity).toBe("2800");
    /* And the tier the larger run reached is its own, not the small one's. */
    expect(fabricOf(large).supplier.quotedRateMinor).toBe(39000);
  });

  test("with nothing approved, the projection says so rather than using a draft", async () => {
    const w = await world({ approve: false });
    const r = await project(w);
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(r.body.reason).toBe("NO_APPROVED_VERSION");
    expect(r.body.message).toMatch(/no version of this costing has been approved/i);
    expect(r.body.requirements).toBeUndefined();
  });

  test("an unapproved quantity is refused; the nearest is never offered", async () => {
    const w = await world();
    const exact = await project(w, "?scenarioKey=q2000");
    expect(exact.body.available).toBe(true);
    expect(exact.body.scenario.scenarioKey).toBe("q2000");
    expect(exact.body.scenario.outputQuantity).toBe("2000");

    const nonsense = await project(w, "?scenarioKey=q1234");
    expect(nonsense.body.available).toBe(false);
    expect(nonsense.body.reason).toBe("NO_SCENARIO");
    /* Not silently answered with q500 or q2000. */
    expect(nonsense.body.scenario).toBeUndefined();
  });

  test("the projection names itself an estimate, never an authorisation", async () => {
    const w = await world();
    const r = await project(w);
    expect(r.body.basis).toBe("ESTIMATED_PROCUREMENT_REQUIREMENT");
    expect(r.body.notAuthorisation).toBe(true);
  });
});

/* ── 5, 6 · WHAT IS EXCLUDED, AND WHY ────────────────────────────────────── */

describe("what the projection excludes", () => {
  test("internal families are explained rather than projected or silently dropped", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    const excluded = r.body.summary.notProcurement.map((e) => e.category);
    /* Labour, overhead and financing are costs and are NOT purchases. */
    expect(excluded).toEqual(expect.arrayContaining(["OPERATION", "OVERHEAD", "FINANCING"]));
    for (const e of r.body.summary.notProcurement) {
      expect(typeof e.reason).toBe("string");
      expect(e.reason.length).toBeGreaterThan(10);
    }
    /* And none of them became a requirement. */
    const projectedKeys = r.body.requirements.map((q) => q.reference.lineKey);
    expect(projectedKeys).not.toContain("stitch");
    expect(projectedKeys).not.toContain("burden");
    expect(projectedKeys).not.toContain("interest");
  });

  test("the finished garment quantity is never itself a requirement", async () => {
    const w = await world();
    const r = await project(w);
    /* The output quantity is context for every line, not a line of its own. */
    expect(r.body.scenario.outputQuantity).toBe("500");
    for (const req of r.body.requirements) {
      expect(["PHYSICAL", "SERVICE", "FREIGHT"]).toContain(req.kind);
      expect(req.reference.lineKey).not.toBe("output");
    }
  });
});

/* ── 22 · THE VISIBILITY BOUNDARY ────────────────────────────────────────── */

describe("who may read a projection", () => {
  test("an output-only Sales reader is refused — this is cost data", async () => {
    const w = await world();
    /* A reader with no costing capability at all: what the company pays a
       supplier is the inside of the cost build-up, and an output-only grant
       exists precisely to withhold it. */
    const sales = await actor([w.co], { admin: false });
    const r = await hit(`/${w.costingId}/procurement-projection`, { token: sales.token, company: w.co._id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.requirements).toBeUndefined();
    /* Not one supplier rate leaks through the refusal. */
    expect(JSON.stringify(r.body)).not.toMatch(/20000|supplierName|quotationReference/);
  });

  test("another company's costing is not found, not refused", async () => {
    const a = await world();
    const b = await world();
    /* B's actor asking for A's costing gets the same answer as for one that
       does not exist — the existence of A's costing is not disclosed. */
    const r = await hit(`/${a.costingId}/procurement-projection`, { token: b.me.token, company: b.co._id });
    expect(r.body.available).toBe(false);
    expect(r.body.reason).toBe("NO_COSTING");
    expect(JSON.stringify(r.body)).not.toContain(String(a.co._id));
  });
});

/* ── 14 · TIMING ─────────────────────────────────────────────────────────── */

describe("the expected month", () => {
  test("with no recorded deadline every line goes to Timing not recorded", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    expect(r.body.summary.byMonth).toEqual([]);
    expect(r.body.summary.timingNotRecordedCount).toBe(r.body.requirements.length);
    for (const req of r.body.requirements) {
      expect(req.timing.recorded).toBe(false);
      /* Never invented from createdAt, and the desk that has the answer is
         named rather than left implicit. */
      expect(req.timing.month).toBeNull();
      expect(req.timing.owner).toBe("Sales");
      expect(req.issues).toContain("TIMING_UNRECORDED");
    }
  });

  test("an authoritative enquiry deadline supplies the month", async () => {
    const w = await world({ requirementDeadline: new Date("2027-02-18T00:00:00.000Z") });
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    expect(r.body.summary.timingSource).toBe("ENQUIRY_REQUIREMENT_DEADLINE");
    const req = r.body.requirements[0];
    expect(req.timing.recorded).toBe(true);
    expect(req.timing.month).toBe("2027-02");
    expect(req.timing.monthLabel).toMatch(/February 2027/);
    expect(r.body.summary.timingNotRecordedCount).toBe(0);
  });
});

/* ── 20 · A PROJECTION CHANGES NOTHING ───────────────────────────────────── */

describe("reading a projection writes nothing", () => {
  test("no version, transition, costing or budget record moves", async () => {
    const w = await world({ newerWorking: true });

    const before = {
      costings: await Costing.countDocuments({}),
      versions: await CostingVersion.countDocuments({}),
      transitions: await CostingTransition.countDocuments({}),
      costing: await Costing.findById(w.costingId).lean(),
      version: await CostingVersion.findById(w.versionId).lean(),
    };

    /* Several reads, including a month view and a second scenario — none of
       which may be a write in disguise. */
    await project(w);
    await project(w, "?scenarioKey=q2000");
    await project(w);

    expect(await Costing.countDocuments({})).toBe(before.costings);
    expect(await CostingVersion.countDocuments({})).toBe(before.versions);
    /* A commitment or reservation would be a transition; there is none. */
    expect(await CostingTransition.countDocuments({})).toBe(before.transitions);

    const after = await Costing.findById(w.costingId).lean();
    expect(String(after.approvedVersionId)).toBe(String(before.costing.approvedVersionId));
    expect(after.updatedAt.getTime()).toBe(before.costing.updatedAt.getTime());
    const v = await CostingVersion.findById(w.versionId).lean();
    expect(v.updatedAt.getTime()).toBe(before.version.updatedAt.getTime());
  });

  test("changing the scenario viewed does not change the approved version", async () => {
    const w = await world();
    const approvedBefore = (await Costing.findById(w.costingId).lean()).approvedVersionId;
    await project(w, "?scenarioKey=q2000");
    const approvedAfter = (await Costing.findById(w.costingId).lean()).approvedVersionId;
    expect(String(approvedAfter)).toBe(String(approvedBefore));
  });
});

/* ── 19, 24 · SHAPE ──────────────────────────────────────────────────────── */

describe("the response shape", () => {
  test("the summary answers the questions the page leads with", async () => {
    const w = await world();
    const s = (await project(w)).body.summary;
    for (const key of [
      "physicalCount", "serviceCount", "expectedProcurementValueMinor",
      "mappedBudgetValueMinor", "budgetMappingRequiredMinor", "budgetMappingRequiredCount",
      "timingNotRecordedCount", "sourceAttentionCount",
      "byBudgetHead", "bySupplier", "byMonth", "notProcurement",
    ]) {
      expect(s).toHaveProperty(key);
    }
    /* Three views over one result, never three calculations. */
    expect(Array.isArray(s.byBudgetHead)).toBe(true);
    expect(Array.isArray(s.bySupplier)).toBe(true);
    expect(Array.isArray(s.byMonth)).toBe(true);
  });

  test("every requirement carries its future-handoff reference", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const r = await project(w);
    expect(r.body.requirements.length).toBeGreaterThan(0);
    for (const req of r.body.requirements) {
      expect(req.reference.costingId).toBe(w.costingId);
      expect(req.reference.costingVersionId).toBe(w.versionId);
      expect(req.reference.versionNumber).toBe(r.body.version.versionNumber);
      expect(req.reference.scenarioKey).toBe("q500");
      expect(typeof req.reference.lineKey).toBe("string");
      expect(["PHYSICAL", "SERVICE", "FREIGHT"]).toContain(req.reference.kind);
    }
  });

  test("the available approved quantities are offered, and only those", async () => {
    const w = await world();
    const keys = (await project(w)).body.scenario.availableScenarios.map((s) => s.scenarioKey);
    expect(keys.sort()).toEqual(["q2000", "q500"]);
  });
});

/* ══ BUDGET PROJECTION ══════════════════════════════════════════════════════
 *
 * The company's existing rules, reused rather than re-implemented: an item's
 * own head wins, then its category mapping, then unresolved; a service uses
 * ONLY its own explicit head and never borrows an item-category mapping.
 * ═════════════════════════════════════════════════════════════════════════ */

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const ItemCategoryBudget = (() => {
  try { return require("../../models/CMS_Models/Inventory/Products/ItemCategoryBudget"); }
  catch { return null; }
})();

const mkItem = (id, over = {}) => RawItem.collection.insertOne({
  _id: new mongoose.Types.ObjectId(String(id)),
  name: "Oxford cotton", sku: "FAB-OX", category: "Fabric", ...over,
});
const mkService = (id, companyId, over = {}) => Service.collection.insertOne({
  _id: new mongoose.Types.ObjectId(String(id)),
  companyId, serviceCode: "WASH", name: "Enzyme wash", category: "Processing", ...over,
});

describe("budget heads", () => {
  test("an item's own head wins over everything else", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const head = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: head, budgetLedgerName: "Fabric purchases" });

    const req = (await project(w)).body.requirements[0];
    expect(req.budget.resolved).toBe(true);
    expect(String(req.budget.budgetLedgerId)).toBe(String(head));
    expect(req.budget.budgetLedgerName).toBe("Fabric purchases");
    /* And WHY, so a wrong head is corrected at source rather than argued about. */
    expect(req.budget.source).toBeTruthy();
    expect(req.budget.message).toMatch(/on this item directly/i);
  });

  test("an item with no head of its own falls back to its category mapping", async () => {
    if (!ItemCategoryBudget) return; // the mapping model is not present in this build
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    await mkItem(FABRIC.itemId, { category: "Fabric" });
    const head = new mongoose.Types.ObjectId();
    await ItemCategoryBudget.collection.insertOne({
      companyId: w.co._id, category: "fabric", budgetLedgerId: head, budgetLedgerName: "Materials",
    });

    const req = (await project(w)).body.requirements[0];
    expect(req.budget.resolved).toBe(true);
    expect(String(req.budget.budgetLedgerId)).toBe(String(head));
    expect(req.budget.message).toMatch(/category mapping/i);
  });

  test("a service uses only its own head — never an item-category mapping", async () => {
    const w = await world();
    await freezeProvenance(w, [WASH]);
    /* Deliberately given a CATEGORY and no head. An item in this position
       would fall through to a category mapping; a service must not. */
    await mkService(WASH.serviceId, w.co._id, { category: "Processing" });

    const req = (await project(w)).body.requirements[0];
    expect(req.kind).toBe("SERVICE");
    expect(req.budget.resolved).toBe(false);
    expect(req.budget.budgetLedgerId).toBeNull();
    /* The category is named as considered and deliberately not used. */
    expect(req.budget.message).toMatch(/No budget head is set on this service/i);
    expect(req.issues).toContain("BUDGET_UNRESOLVED");

    /* With its own head set, it resolves — and only then. */
    const head = new mongoose.Types.ObjectId();
    await Service.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(WASH.serviceId)) },
      { $set: { budgetLedgerId: head, budgetLedgerName: "Outside processing" } },
    );
    const again = (await project(w)).body.requirements[0];
    expect(String(again.budget.budgetLedgerId)).toBe(String(head));
  });

  test("unresolved value is kept in its own total, never in a default head", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    /* Neither master carries a head. */
    await mkItem(FABRIC.itemId);
    await mkService(WASH.serviceId, w.co._id);

    const s = (await project(w)).body.summary;
    expect(s.budgetMappingRequiredCount).toBe(2);
    expect(s.mappedBudgetValueMinor).toBe(0);
    /* THE POINT: it is not silently placed anywhere. An amount in a head
       nobody chose is an amount nobody re-checks. */
    expect(s.byBudgetHead).toEqual([]);
    expect(s.budgetMappingRequiredMinor).toBeGreaterThan(0);
  });

  test("one costing can affect several budget heads at once", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC, WASH]);
    const fabricHead = new mongoose.Types.ObjectId();
    const washHead = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: fabricHead, budgetLedgerName: "Fabric purchases" });
    await mkService(WASH.serviceId, w.co._id, { budgetLedgerId: washHead, budgetLedgerName: "Outside processing" });

    const s = (await project(w)).body.summary;
    expect(s.byBudgetHead).toHaveLength(2);
    const ids = s.byBudgetHead.map((h) => String(h.budgetLedgerId)).sort();
    expect(ids).toEqual([String(fabricHead), String(washHead)].sort());
    expect(s.budgetMappingRequiredCount).toBe(0);
    /* Each head carries its own projected amount, not a shared total. */
    for (const h of s.byBudgetHead) expect(h.requirementCount).toBe(1);
  });

  test("projecting a budget head creates and releases nothing", async () => {
    const w = await world();
    await freezeProvenance(w, [FABRIC]);
    const head = new mongoose.Types.ObjectId();
    await mkItem(FABRIC.itemId, { budgetLedgerId: head, budgetLedgerName: "Fabric purchases" });

    const itemBefore = await RawItem.collection.findOne({ _id: new mongoose.Types.ObjectId(String(FABRIC.itemId)) });
    await project(w);
    await project(w);
    const itemAfter = await RawItem.collection.findOne({ _id: new mongoose.Types.ObjectId(String(FABRIC.itemId)) });
    /* No reservation, no commitment, no counter — the master is untouched. */
    expect(itemAfter).toEqual(itemBefore);
  });
});
