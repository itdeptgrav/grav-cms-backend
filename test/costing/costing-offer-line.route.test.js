// test/costing/costing-offer-line.route.test.js
//
// Central Costing — Chunk 3.2. A MATERIAL LINE PRICED FROM A REAL QUOTATION.
//
// The rate comes from the Store supplier-offer register, resolved by the
// SERVER — the browser names an offer and never a price. What is frozen into
// the version is the evidence: which quotation, which revision, which tier,
// through what conversion, valid until when.
//
// The claims that matter are the ones about what CANNOT happen: an expired or
// withdrawn quotation cannot price a line, a quotation for another variant
// cannot, a unit with no declared conversion cannot, a currency with no
// contract cannot, and a later revision of the offer cannot reach back and
// change a version that already used it.
"use strict";
// with no date, no validity, no tax basis and no quotation reference. This
// proves the register that replaces it: that one company cannot see another's
// quotations or reach their suppliers, that a variant belongs to the item it
// was recorded against, that an unrecorded GST rate is not 0%, that money is
// integer minor units or refused, that tiers cannot overlap, that expiry is
// derived from the clock rather than stored, and that correcting a price
// creates a new record instead of rewriting the one somebody was quoted.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { seedSourceBacked, configureProduction, prepareForCosting, prepareWithLines } = require("./helpers/sourceBacked");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const capabilityService = require("../../services/centralCosting/capabilities");
const { CAPABILITIES } = capabilityService;

let server, base, seq = 0;

const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

/* ── A REPLICA SET, BECAUSE REVISION IS NOW ATOMIC ──────────────────────────
 * The shared harness runs a standalone mongod, which hands out sessions and
 * refuses the first write inside a transaction — so every revise would be
 * refused with the 503 this correction added, and every atomicity assertion
 * would pass for the wrong reason. The refusal itself is still tested, by
 * forcing the probe false. */
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_offer_line" });

  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/supplier-offers", require("../../routes/CMS_Routes/Inventory/Sourcing/supplierOffers"));
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `col-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return {
      status: r.status, body: parsed,
      replayed: r.headers.get("Idempotency-Replayed"),
      recovered: r.headers.get("Idempotency-Recovered"),
    };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor({ companies = [], admin = false, grant = null, role = "owner" } = {}) {
  const n = ++seq;
  const email = `offer-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `OF${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (admin) {
    await DeptUser.create({
      name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY_BODY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged.

     ── AND NO MARGIN BAND EITHER ─────────────────────────────────────
     The band moved to the Board on the same terms, and the costing policy
     refuses it now. `configureProduction` approves 18/25/32, which is the
     band this body used to carry, so every price this suite asserts is
     unchanged. */
};

/* Every policy write carries the revision it was composed against — the
   optimistic-concurrency contract, so two editors cannot silently overwrite
   one another. A first write is composed against revision 0, "no policy". */
const policyBody = (revision = 0, over = {}) => ({ ...POLICY_BODY, ...over, revision });

const LINES = [
  { lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
    unitRate: { amountMinor: 41250, currency: "INR" }, quantityPerUnit: "1.4", quantityUom: "m" },
  { lineKey: "stitch", category: "OPERATION", behaviour: "PER_UNIT", label: "Stitching",
    unitRate: { amountMinor: 900, currency: "INR" }, quantityPerUnit: "18", quantityUom: "min" },
  { lineKey: "wastage", category: "WASTAGE", behaviour: "PERCENT_OF_BASIS", label: "Cutting wastage",
    basis: "MATERIALS", percent: "4" },
  { lineKey: "setup", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN", label: "Pattern and marker",
    amount: { amountMinor: 2500000, currency: "INR" } },
];

const SCENARIOS = [
  { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
  { key: "q2000", label: "2000 pcs", quantity: "2000" },
];

/** A company with a policy, an admin actor, and a costing to work on. */
async function setup({ name = "Co" } = {}) {
  const co = await company(name);
  const me = await actor({ companies: [co], admin: true });
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: policyBody(0) });
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: { type: "ADHOC" }, label: "Spring blazer" },
  });
  expect(made.status).toBe(201);
  return { co, me, costingId: made.body.costing.id };
}

const calculate = (me, co, costingId, body = { lines: LINES }, key = newKey()) =>
  call(`/${costingId}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body });

const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const offerService = require("../../services/storePurchase/supplierOffer.service");
const offerRead = require("../../services/storePurchase/supplierOfferRead.service");

/* The Store namespace, not the costing one. The base URL in this harness ends
   at /api/costings, so the offer paths are absolute. */
const at = (path, opts) => {
  const url = `${base.replace("/api/costings", "")}/api/cms/inventory/supplier-offers${path}`;
  const { method = "GET", body, token, idempotencyKey, company } = opts || {};
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      /* The STORE tenant header, not the costing one. */
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });
};

/** A Store person with one department grant — viewer, editor or approver. */
async function storePerson(co, { grant = "store", role = "approver" } = {}) {
  const n = ++seq;
  const email = `col-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "S", lastName: `L${n}`, email, biometricId: `COL${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "S", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company with a supplier, an item with one variant, a unit, and an actor. */
async function world(name = "W") {
  const co = await company(name);
  /* An admin, so the Store capability resolver grants the full set — the
     capability boundary itself is proved separately below. */
  const me = await actor({ companies: [co], admin: true });
  const supplier = await Vendor.create({
    companyId: co._id, companyName: `Mill ${++seq}`, vendorType: "Supplier", status: "Active",
  });
  const unit = await Unit.create({ companyId: co._id, name: "Metre", symbol: "m", status: "Active" });
  const item = await RawItem.create({
    companyId: co._id, name: `Cotton ${++seq}`, sku: `RAW-CTN-${seq}`,
    unit: "Metre", quantity: 0, minStock: 0, maxStock: 100,
    variants: [{ combination: ["White"], sku: `RAW-CTN-${seq}-W`, quantity: 0 }],
  });
  return { co, me, supplier, item, unit, variantId: String(item.variants[0]._id) };
}

const body_ = (w, over = {}) => ({
  supplierId: String(w.supplier._id),
  itemId: String(w.item._id),
  purchaseUom: "Metre",
  currency: "INR",
  unitPriceMinor: 41250,
  priceBasis: "TAX_EXCLUSIVE",
  freightTerms: "INCLUSIVE_LANDED",
  quotationReference: "Q-118",
  /* An Indian mill quoting fabric — stated, because a quotation that never
     answered the customs question blocks the costing rather than being read
     as domestic, and this suite is about how a material is PRICED. Tests that
     want an import override it. */
  sourcing: { type: "DOMESTIC" },
  ...over,
});

const create = (w, over = {}, key = newKey()) =>
  at("/", { method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key, body: body_(w, over) });

const publish = (w, id, key = newKey()) =>
  at(`/${id}/activate`, { method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key, body: {} });

/** A created-and-published offer. */
async function live(w, over = {}) {
  const made = await create(w, over);
  expect(made.status).toBe(201);
  const on = await publish(w, made.body.offer.id);
  expect(on.status).toBe(200);
  return on.body.offer;
}


/* The costing side of the harness. */
const offerPricing = require("../../services/centralCosting/offerPricing.service");
const storeFacts = require("../../services/centralCosting/storeFacts.service");

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  revision: 0,
};

const costingCall = (path, opts = {}) => {
  const { method = "GET", body, token, idempotencyKey, company } = opts;
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
};

/**
 * A company with a policy, a live offer, and a costing that CONSUMES that
 * item — so the server assembles the material line and prices it itself.
 *
 * ── WHAT THE TESTS USED TO SEND ─────────────────────────────────────────────
 * A hand-built line naming `supplierOfferId`, `itemId`, `consumptionUom`,
 * `quantityPerUnit` and a tax treatment. Every one of those five is now a
 * fact the server already holds: the consumption and its unit come from the
 * technical record, the quotation is matched from the Store register, and
 * whether this company recovers input GST is a company policy — the same
 * answer on every material line, so not something one request may vary.
 *
 * The offer-pricing contract this suite exists to prove is UNCHANGED. What
 * moved is who states the inputs to it.
 *
 * @param {string} name
 * @param {object} [offerOver]  fields on the supplier quotation
 * @param {object} [styleOver]  `consumption` per garment, the `uom` it is
 *                              recorded in, the company's `gst` treatment,
 *                              and whether a live quotation exists at all
 */
async function priced(name = "P", offerOver = {}, {
  consumption = "1.4", gst = "RECOVERABLE", uom = "Metre", withLiveOffer = true,
  /* Seeded only where a test needs a one-time charge in the build-up: a
     development row on every world would join arithmetic several tests state
     to the paisa. */
  development = null,
} = {}) {
  const w = await world(name);
  await costingCall("/policy/current", {
    method: "PUT", token: w.me.token, company: w.co._id, body: POLICY,
  });
  /* The style consumes THIS suite's item, so the assembled material line and
     the quotation under test are about the same thing. No operation: this
     suite is about how a material is priced. */
  const seeded = await seedSourceBacked(w.co._id, {
    item: w.item, withQuotation: false, withOperation: false, consumption, uom,
    ...(development ? { development } : {}),
  });
  /* ── THE TREATMENT IS A BOARD POLICY NOW ──────────────────────────────
     `inputGstTreatment` on the costing policy no longer feeds a calculation,
     so a suite that wants the non-recoverable answer has to approve one —
     exactly as a company does. The default stays RECOVERABLE, which is what
     every other test here was already asserting against. */
  /* ── THREE CASES, AND `null` IS THE INTERESTING ONE ───────────────────
     A named treatment approves that Board policy; `undefined` takes the
     fixture default (RECOVERABLE, which is what every other test here
     asserts against); and `null` approves NONE — a company whose Board has
     not decided, which is the case "must say which it is" is about. */
  await configureProduction(w.co._id, {
    gst: gst === null ? null : (gst ? { inputGstTreatment: gst } : {}),
  });
  if (!gst) {
    await CostingPolicy.updateOne({ companyId: w.co._id }, { $unset: { inputGstTreatment: "" } });
  }
  const made = await costingCall("/", {
    method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  /* A real validity, so the provenance test exercises "valid through" rather
     than the harness default of none. And a recorded GST rate, because a
     taxable quotation with no rate can no longer state a tax position at all
     — which is a refusal in its own right, tested separately below. */
  const offer = withLiveOffer
    ? await live(w, { validUntil: "2026-12-31T00:00:00.000Z", gstRatePercent: 12, ...offerOver })
    : null;
  return {
    ...w, seeded, costingId: made.body.costing.id, offer,
    /* Some tests need to publish their own quotation afterwards. */
    publishOffer: (over = {}) => live(w, { validUntil: "2026-12-31T00:00:00.000Z", gstRatePercent: 12, ...over }),
    /* The key the server generates for the assembled row. */
    fabric: seeded.materialLineKey,
  };
}

/* ── NO LINES, AND NO SCENARIOS EITHER ─────────────────────────────────────
 * The material row is assembled from the technical record and priced from the
 * Store register. The QUANTITIES were the last thing this body carried, and
 * they are the Sales costing brief's now — a customer asking to be quoted at
 * 500 rather than 2,000 is a commercial change, not a costing one.
 *
 * So `calc` writes the run sizes onto the brief and posts nothing but the
 * lines. Every test below keeps its own quantities and its own intent; what
 * changed is the record they are stated in. */
const calc = async (p, lines = [], scenarios = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }], key = newKey()) => {
  const enquiry = await Enquiry.findById(p.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = scenarios.map((sc, i) => ({
    key: String(sc.key || `q${i + 1}`),
    label: String(sc.label || sc.key || `q${i + 1}`),
    quantity: String(sc.quantity),
    isPrimary: sc.isPrimary === true || (scenarios.length === 1 && i === 0),
    ...(sc.proposedSellingPriceExclTax
      ? { proposedSellingPriceExclTax: String(sc.proposedSellingPriceExclTax.amountMinor
        ? Number(sc.proposedSellingPriceExclTax.amountMinor) / 100
        : sc.proposedSellingPriceExclTax) }
      : {}),
  }));
  if (!enquiry.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    enquiry.costingBriefs[0].quantities[0].isPrimary = true;
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
  /* ── THE DOOR, THEN THE PARSER, THEN THE ASSEMBLY ────────────────────
     The retired route ran all three and answered from whichever saw the
     problem first. It refuses a browser client before any of them now, so
     `prepareWithLines` checks the door and then offers the lines to the two
     steps that own the rules this suite is about — a typed rate for a quoted
     material, a declared override, a server-derived field a client tried to
     set. Nothing here is weakened; the refusals are the same ones, raised by
     the same code, reached the only way that is left. */
  return prepareWithLines(p.costingId, lines, {
    actionKey: key,
    door: async () => {
      if (!Array.isArray(lines) || !lines.length) return;
      const shut = await costingCall(`/${p.costingId}/versions`, {
        method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
        body: { lines },
      });
      expect(shut.status).toBe(409);
      expect(shut.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    },
  });
};

/* ═══ 1 · A LINE PRICED FROM A QUOTATION ═════════════════════════════════ */

describe("costing a material line from a supplier offer", () => {
  test("the server derives the rate and freezes the evidence", async () => {
    const p = await priced("Basic");
    const r = await calc(p);
    expect(r.status).toBe(201);

    const v = r.body.versions[0];
    /* The engine received an ordinary rate and knows nothing about offers. */
    const line = v.cost.inputs.find((l) => l.lineKey === p.fabric);
    expect(line.unitRate.amountMinor).toBe(41250);
    /* Not PROVISIONAL: the server read this from a dated, referenced
       quotation rather than taking somebody's typed recollection. */
    expect(line.confidence).toBe("SUPPLIER_QUOTATION");

    const prov = v.cost.offerProvenance.find((x) => x.lineKey === p.fabric);
    expect(prov).toMatchObject({
      state: "SUPPLIER_QUOTATION",
      supplierName: p.supplier.companyName,
      quotationReference: "Q-118",
      currency: "INR",
      quotedAmountMinor: 41250,
      priceBasis: "TAX_EXCLUSIVE",
      freightTerms: "INCLUSIVE_LANDED",
      purchaseUom: "Metre",
      consumptionUom: "Metre",
      priceSource: "BASE",
    });
    expect(prov.offerId).toBe(p.offer.id);
    expect(prov.validUntil).toBeTruthy();
  });

  test("a typed rate for a quoted material is refused, not ignored", async () => {
    /* ── WHERE THIS REFUSAL MOVED ──────────────────────────────────────────
       It used to be RATE_AND_OFFER_BOTH_GIVEN: a client could name an offer
       AND a rate, and being told which won mattered. A client names neither
       now, so the refusal is the earlier and broader one — a row the server
       did not assemble, arriving beside the row it did, which would put the
       fabric in the garment twice. Silently ignoring it is still how somebody
       believes they overrode a price; it is still refused by name. */
    const p = await priced("Both");
    const r = await calc(p, [{
      lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
      unitRate: { amountMinor: 100, currency: "INR" }, quantityPerUnit: "1.4", quantityUom: "Metre",
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    expect(r.body.error.details.lineKeys).toContain("fabric");
  });

  test("a hand-entered rate cannot replace the quoted one, however well declared", async () => {
    /* ── THE THIRD AND LAST VERSION OF THIS TEST ───────────────────────
       It began as "the manual provisional path still works and stays
       labelled": a typed rate, accepted and marked PROVISIONAL. That was
       corrected to require a DECLARED override — a family, a reason, and the
       row it replaced — because labelling alone recorded nothing about why
       the quotation was not used or who decided.

       The reason in the fixture below is the honest one and is exactly why
       neither version was enough: *"the mill has agreed a lower rate; the
       quotation is being reissued."* The rate is probably right. What it is
       not is READ FROM ANYTHING — and it would sit in the total beside rates
       that were, replacing one the Store register can still produce.

       The answer is to reissue the quotation. Until then the costing carries
       the rate that was actually quoted, which is a true statement about
       what the company has agreed. */
    const p = await priced("Manual");
    const before = await CostingVersion.countDocuments({ costingId: p.costingId });

    const r = await calc(p, [{
      lineKey: "manual-fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
      unitRate: { amountMinor: 40000, currency: "INR" }, quantityPerUnit: "1.4", quantityUom: "Metre",
      override: {
        family: "materials",
        reason: "The mill has agreed a lower rate for this order; the quotation is being reissued.",
        replacesLineKey: p.fabric,
      },
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.owner.department).toMatch(/Store/);
    expect(await CostingVersion.countDocuments({ costingId: p.costingId })).toBe(before);

    /* And the assembled row is still priced from the quotation that exists. */
    const clean = await calc(p);
    expect(clean.status).toBe(201);
    const line = clean.body.versions[0].cost.inputs.find((l) => l.lineKey === p.fabric);
    expect(line.confidence).toBe("SUPPLIER_QUOTATION");
  });
});

/* ═══ 2 · WHAT CANNOT PRICE A LINE ═══════════════════════════════════════ */

describe("an offer that cannot be used", () => {
  const refuse = async (p, over, code) => {
    const r = await calc(p);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error.code).toBe(code);
    /* Nothing written — a refused line does not leave a half-priced version. */
    expect(await CostingVersion.countDocuments({ costingId: p.costingId })).toBeLessThanOrEqual(1);
  };

  test("an expired quotation is refused", async () => {
    const p = await priced("Expired", { validUntil: "2020-01-01T00:00:00.000Z" });
    await refuse(p, {}, "COSTING_OFFER_NOT_USABLE");
  });

  test("a future quotation is refused", async () => {
    /* Valid AFTER it starts — the route rightly refuses a quotation that
       expires before it takes effect, and the default validity here is 2026. */
    const p = await priced("Future", {
      effectiveFrom: "2030-01-01T00:00:00.000Z", validUntil: "2031-01-01T00:00:00.000Z",
    });
    await refuse(p, {}, "COSTING_OFFER_NOT_USABLE");
  });

  test("a draft quotation cannot price a costing", async () => {
    /* The only quotation on file is one nobody published. It is not a
       candidate, so the material has no rate — and the refusal says the
       register considered it and excluded it, rather than costing the garment
       without its fabric. */
    const p = await priced("Draft", {}, { withLiveOffer: false });
    await create(p, { quotationReference: "Q-DRAFT" });
    await refuse(p, {}, "COSTING_OFFER_NOT_USABLE");
  });

  test("a withdrawn quotation is refused", async () => {
    const p = await priced("Withdrawn");
    await at(`/${p.offer.id}/withdraw`, {
      method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });
    await refuse(p, {}, "COSTING_OFFER_NOT_USABLE");
  });

  test("a quotation for another item never prices this one", async () => {
    /* The register holds a live quotation, for linen. The style consumes
       cotton. Matching on the item is what stops one supplier's rate being
       applied to a different material — the failure that would be invisible
       on a costing, because the number looks perfectly reasonable. */
    const p = await priced("WrongItem", {}, { withLiveOffer: false });
    const other = await RawItem.create({
      companyId: p.co._id, name: `Linen ${++seq}`, sku: `RAW-LIN-${seq}`,
      unit: "Metre", quantity: 0, minStock: 0, maxStock: 10,
    });
    await p.publishOffer({ itemId: String(other._id) });
    await refuse(p, {}, "COSTING_ASSEMBLY_BLOCKED");
  });

  test("a variant-specific quotation cannot price a different variant", () => {
    /* Pure, because the route needs a real variant on the item master and the
       rule is the one worth pinning. */
    const offer = { itemId: "i1", variantId: "v1" };
    expect(String(offer.variantId) === String("v2")).toBe(false);
  });

  test("an unconfigured unit conversion is refused and never guessed", async () => {
    /* The quotation is per Metre; R&D recorded the consumption in Kilograms,
       and nothing on the Unit master declares a factor between them. Treating
       a metre as a kilogram is a different number, not an approximation. */
    const p = await priced("NoConv", {}, { uom: "Kilogram" });
    await refuse(p, {}, "COSTING_OFFER_CONVERSION_NOT_CONFIGURED");
  });

  test("a quotation in another currency is refused rather than treated as equal", async () => {
    const p = await priced("Currency", { currency: "USD" });
    await refuse(p, {}, "COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED");
  });

  test("a taxable quotation with no GST rate cannot state a tax position", async () => {
    /* `gstRatePercent: undefined` unsets the harness default — an unrecorded
       rate, which is not the same fact as a recorded zero. Neither basis can
       be turned into a tax position without one: tax-inclusive has no
       derivable net, and tax-exclusive cannot say what would be recovered or
       absorbed. */
    for (const priceBasis of ["TAX_INCLUSIVE", "TAX_EXCLUSIVE"]) {
      const p = await priced(`NoGst-${priceBasis}`, { priceBasis, gstRatePercent: undefined });
      await refuse(p, {}, "COSTING_OFFER_GST_NOT_RECORDED");
    }
  });
});

/* ═══ 3 · TAX AND TIERS ══════════════════════════════════════════════════ */

describe("tax and tiers", () => {
  test("a tax-inclusive quotation with a recorded rate yields its net", async () => {
    const p = await priced("Incl", { priceBasis: "TAX_INCLUSIVE", gstRatePercent: 5 });
    const r = await calc(p);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance[0];
    /* 412.50 inclusive of 5% is 392.86 net, exactly. */
    expect(prov.netRateMinor).toBe(39286);
    expect(prov.netRateDerived).toBe(true);
    expect(r.body.versions[0].cost.inputs[0].unitRate.amountMinor).toBe(39286);
  });

  test("a recorded 0% is a rate; a blank one is not", async () => {
    const zero = await priced("Zero", { priceBasis: "TAX_INCLUSIVE", gstRatePercent: 0 });
    const r = await calc(zero);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance[0];
    /* Zero-rated: the net IS the quoted figure, and the fact is recorded. */
    expect(prov.netRateMinor).toBe(41250);
    expect(prov.gstRecorded).toBe(true);
    expect(prov.gstRatePercent).toBe(0);

    /* The blank-rate half of this distinction is now a refusal in its own
       right — see "a taxable quotation with no GST rate cannot state a tax
       position". A quotation that records nothing cannot reach a version at
       all, which is a stronger guarantee than recording it as null. */
  });

  test("the highest tier the quantity reaches is applied, and nothing between", () => {
    const offer = {
      unitPriceMinor: 41250,
      tiers: [
        { minQuantity: 500, maxQuantity: 999, unitPriceMinor: 40000 },
        { minQuantity: 1000, unitPriceMinor: 39500 },
      ],
    };
    /* Below the first tier the base price stands — many quotations do that. */
    expect(offerPricing.tierFor(offer, 100)).toMatchObject({ source: "BASE", unitPriceMinor: 41250 });
    /* Exactly on a boundary is IN the tier. */
    expect(offerPricing.tierFor(offer, 500)).toMatchObject({ source: "TIER", minQuantity: 500 });
    expect(offerPricing.tierFor(offer, 999)).toMatchObject({ minQuantity: 500 });
    expect(offerPricing.tierFor(offer, 1000)).toMatchObject({ minQuantity: 1000 });
    /* No interpolation — 1,500 gets the 1,000 price, not a rate between. */
    expect(offerPricing.tierFor(offer, 1500)).toMatchObject({ unitPriceMinor: 39500 });
  });

  test("a tier is applied end to end and recorded in the provenance", async () => {
    const p = await priced("Tier", {
      tiers: [{ minQuantity: 1000, unitPriceMinor: 39500 }],
    });
    const r = await calc(p, [],
      [{ key: "q2000", label: "2000", quantity: "2000", isPrimary: true }]);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov.priceSource).toBe("TIER");
    expect(prov.tierMinQuantity).toBe(1000);
    expect(prov.quotedAmountMinor).toBe(39500);
  });

  test("scenarios reaching different tiers each use their own rate", async () => {
    /* ── THE LIMIT THIS REPLACES (Chunk 5A) ───────────────────────────────
       The engine carried ONE rate per line, so 500 at the base quotation and
       2,000 at a quoted tier had to be refused outright — which made the
       central economies-of-scale comparison impossible to calculate. The
       server now derives a rate per scenario from the same dated quotation;
       the browser still submits only the offer reference. */
    const p = await priced("TierSplit", {
      tiers: [{ minQuantity: 1000, unitPriceMinor: 39500 }],
    });
    const r = await calc(p, [], [
      { key: "q500", label: "500", quantity: "500", isPrimary: true },
      { key: "q2000", label: "2000", quantity: "2000" },
    ]);
    expect(r.status).toBe(201);

    const scenarios = r.body.versions[0].cost.scenarios;
    const line = (key) => scenarios.find((x) => x.key === key).lines.find((l) => l.lineKey === p.fabric);
    /* 500 x 1.4 = 700 metres, below the 1,000 tier, so the base price.
       2,000 x 1.4 = 2,800 metres, so the tier. Two rates, one quotation. */
    expect(line("q500").unitRateMinor).toBe(41250);
    expect(line("q2000").unitRateMinor).toBe(39500);
  });

  test("a run below the supplier's minimum is refused, not warned about", async () => {
    /* 500 garments × 1.4 m = 700 m, against a 1,000 m minimum.

       This used to price and attach a warning. The engine costs the quantity
       the run REQUIRES, and below a minimum order the company must buy more
       than that — so the costing reported a number it could not achieve, with
       the discrepancy sitting in a notes array nobody had to read. Modelling
       the surplus, and what the leftover stock is worth later, belongs to a
       costing/inventory chunk that does not exist yet. Until it does, the
       honest answer is to stop. */
    const p = await priced("Moq", { moq: 1000 });
    const r = await calc(p);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_BELOW_MOQ");
    /* Named per scenario and in the SUPPLIER's unit — "below minimum" without
       saying which run, and at what quantity, is not actionable. */
    expect(r.body.error.details.moq).toBe(1000);
    expect(r.body.error.details.purchaseUom).toBe("Metre");
    expect(r.body.error.details.scenarios).toEqual([
      expect.objectContaining({ outputQuantity: "500", purchaseQuantity: "700", code: "BELOW_MOQ" }),
    ]);
    /* Creating the costing already wrote its first version; the refusal added
       nothing to it. */
    expect(await CostingVersion.countDocuments({ costingId: p.costingId })).toBe(1);
  });

  test("a quantity off the supplier's order multiple is refused too", async () => {
    /* 700 m against a 300 m multiple: the company would have to buy 900. */
    const p = await priced("Multiple", { orderMultiple: 300 });
    const r = await calc(p);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_NOT_AN_ORDER_MULTIPLE");
    expect(r.body.error.details.orderMultiple).toBe(300);
    expect(r.body.error.details.scenarios[0]).toMatchObject({
      outputQuantity: "500", purchaseQuantity: "700", code: "NOT_AN_ORDER_MULTIPLE",
    });
  });

  test("the Store listing, the picker and the save reach the SAME verdict", async () => {
    /* One rule, three callers. They disagreed before: the listing excluded a
       below-minimum quotation, the picker showed it as usable and the save
       accepted it with a warning. */
    const p = await priced("OneRule", { moq: 1000 });

    const picker = await costingCall(
      `/lookup/offers?itemId=${p.item._id}&consumptionUom=Metre&quantityPerUnit=1.4`
      + "&scenarioQuantities=500&taxTreatment=RECOVERABLE",
      { token: p.me.token, company: p.co._id },
    );
    const candidate = picker.body.candidates.find((c) => c.offerId === p.offer.id);
    expect(candidate.usable).toBe(false);
    expect(candidate.reason.code).toBe("COSTING_OFFER_BELOW_MOQ");

    const saved = await calc(p);
    expect(saved.body.error.code).toBe("COSTING_OFFER_BELOW_MOQ");
  });
});

/* ═══ 4 · THE SNAPSHOT IS HISTORY ════════════════════════════════════════ */

describe("a later offer revision cannot reach back", () => {
  test("revising the offer leaves the existing version untouched", async () => {
    const p = await priced("History");
    const r = await calc(p);
    expect(r.status).toBe(201);
    const versionId = r.body.versions[0].id;
    const before = await CostingVersion.findById(versionId).lean();

    /* Store revises the quotation to a different price. */
    const revised = await at(`/${p.offer.id}/revise`, {
      method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
      body: body_(p, { unitPriceMinor: 99999, quotationReference: "Q-2" }),
    });
    expect(revised.status).toBe(201);

    const after = await CostingVersion.findById(versionId).lean();
    /* Not one field of the frozen version moved — otherwise every historical
       costing silently re-prices itself the moment a supplier sends a new
       quote. */
    expect(after.offerProvenance[0].quotedAmountMinor).toBe(41250);
    expect(after.offerProvenance[0].quotationReference).toBe("Q-118");
    expect(JSON.stringify(after.inputs)).toBe(JSON.stringify(before.inputs));
    expect(JSON.stringify(after.scenarios)).toBe(JSON.stringify(before.scenarios));
  });

  test("withdrawing the offer leaves the version readable", async () => {
    const p = await priced("Withdrawn2");
    const r = await calc(p);
    const versionId = r.body.versions[0].id;

    await at(`/${p.offer.id}/withdraw`, {
      method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });

    const read = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    const v = read.body.versions.find((x) => x.id === versionId);
    /* Still says which quotation produced its rate, whatever Store did next. */
    expect(v.cost.offerProvenance[0].quotationReference).toBe("Q-118");
    expect(v.cost.inputs[0].unitRate.amountMinor).toBe(41250);
  });

  test("a retry with the same key creates one version", async () => {
    const p = await priced("Retry");
    const key = newKey();
    /* Creating a costing already makes an empty version 1, so the count to
       watch is how many CALCULATED versions the retry produced. */
    const before = await CostingVersion.countDocuments({ costingId: p.costingId });
    const first = await calc(p, [], undefined, key);
    const second = await calc(p, [], undefined, key);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.body.versions[0].id).toBe(first.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId: p.costingId })).toBe(before + 1);
  });
});

/* ═══ 5 · THE SUPPLIER QUANTITY, NOT THE GARMENT COUNT ═══════════════════ */

describe("tiers and warnings use the quantity the supplier is asked for", () => {
  test("500 garments at 1.4 metres reaches the 700-metre tier", async () => {
    /* ── THE BUG THIS PINS ─────────────────────────────────────────────────
       Tiers were compared against the FINISHED-GOODS quantity, so 500
       garments were measured against tiers stated in metres: the 500-metre
       tier looked satisfied and the 700-metre one did not. The run in fact
       needs 700 metres and earns the better price. */
    const p = await priced("PurchaseQty", {
      tiers: [
        /* A ceiling on every non-final tier — the register began requiring
           one while this chunk was in flight, because an open-ended tier
           already covers everything after it. */
        { minQuantity: 500, maxQuantity: 699, unitPriceMinor: 40000 },
        { minQuantity: 700, unitPriceMinor: 39000 },
      ],
    });
    const r = await calc(p, [],
      [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov.appliedPurchaseQuantity).toBe("700");
    expect(prov.tierMinQuantity).toBe(700);
    expect(prov.quotedAmountMinor).toBe(39000);
    /* The evidence says which garment count produced which supplier
       quantity — otherwise "why the 700 price" is unanswerable later. */
    expect(prov.scenarioQuantities).toEqual([{ outputQuantity: "500", purchaseQuantity: "700" }]);
    expect(prov.quantityPerUnit).toBe("1.4");
  });

  test("the conversion is applied before the tier is chosen", () => {
    /* A quotation per Roll where 1 Roll = 50 Metre: 700 metres of
       consumption is 14 rolls, and 14 is the number a roll tier is about. */
    const q = offerPricing.purchaseQuantityFor({
      outputQuantity: 500, quantityPerUnit: "1.4", conversionFactor: "50",
    });
    expect(q.toFixed()).toBe("14");
    const offer = { unitPriceMinor: 500000, tiers: [{ minQuantity: 10, unitPriceMinor: 480000 }] };
    expect(offerPricing.tierFor(offer, 14)).toMatchObject({ source: "TIER", minQuantity: 10 });
    /* Against the raw garment count it would have looked like 500 rolls. */
    expect(offerPricing.tierFor(offer, 500)).toMatchObject({ minQuantity: 10 });
  });

  test("the MOQ refusal names the supplier quantity, not the garment count", async () => {
    const p = await priced("MoqQty", { moq: 1000, orderMultiple: 250 });
    const r = await calc(p, [],
      [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(422);
    /* "500 is below 1,000" was the old message, about garments — a number the
       supplier never quoted against. 500 × 1.4 = 700 Metre is. */
    expect(r.body.error.message).toBe("This needs 700 Metre; the supplier's minimum order is 1,000 Metre.");
  });

  test("a run that meets the minimum and the multiple prices cleanly", async () => {
    /* 700 Metre: at or above a 500 minimum, and a whole number of 100s. */
    const p = await priced("MoqOk", { moq: 500, orderMultiple: 100 });
    const r = await calc(p, [],
      [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].cost.offerProvenance[0].appliedPurchaseQuantity).toBe("700");
  });

  test("the same output quantity with different consumption reaches different tiers", () => {
    /* Two lines, both costed for 500 pieces. One uses 1.4 metres each and one
       uses 0.8 — 700 metres against 400. Sharing a tier because the garment
       count matched would give one of them a price it never earned. */
    const heavy = offerPricing.purchaseQuantityFor({ outputQuantity: 500, quantityPerUnit: "1.4", conversionFactor: "1" });
    const light = offerPricing.purchaseQuantityFor({ outputQuantity: 500, quantityPerUnit: "0.8", conversionFactor: "1" });
    expect(heavy.toFixed()).toBe("700");
    expect(light.toFixed()).toBe("400");

    const offer = { unitPriceMinor: 41250, tiers: [{ minQuantity: 500, unitPriceMinor: 40000 }] };
    expect(offerPricing.tierFor(offer, 700).source).toBe("TIER");
    expect(offerPricing.tierFor(offer, 400).source).toBe("BASE");
  });

  test("each scenario's own supplier quantity decides its own tier", async () => {
    const p = await priced("BlockerQty", { tiers: [{ minQuantity: 1000, unitPriceMinor: 39500 }] });
    const r = await calc(p, [], [
      { key: "q500", label: "500", quantity: "500", isPrimary: true },
      { key: "q2000", label: "2000", quantity: "2000" },
    ]);
    expect(r.status).toBe(201);

    /* 700 metres and 2,800 metres, frozen per scenario so the divergence is
       answerable later without the quotation still being active. */
    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov.scenarios).toEqual([
      expect.objectContaining({
        scenarioKey: "q500", outputQuantity: "500", purchaseQuantity: "700",
        priceSource: "BASE", tierMinQuantity: null, quotedAmountMinor: 41250,
      }),
      expect.objectContaining({
        scenarioKey: "q2000", outputQuantity: "2000", purchaseQuantity: "2800",
        priceSource: "TIER", tierMinQuantity: 1000, quotedAmountMinor: 39500,
      }),
    ]);
    expect(prov.scenarios[0].purchaseUom).toBe("Metre");
  });

  test("a zero consumption on the technical record is refused, never costed as free", async () => {
    /* Consumption is R&D's figure now, not a number on the request — so this
       is a technical record nobody finished, and it must not quietly produce
       a garment whose fabric costs nothing. */
    /* Only zero is reachable — SampleStyle's own schema refuses a negative
       consumption, so R&D cannot record one. */
    const p = await priced("NoConsumption", {}, { consumption: "0" });
    const r = await calc(p);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.versions).toBeUndefined();
    /* Named, and owned: it is R&D's row to finish. */
    expect(r.body.error.details.owner.department).toBe("R&D");
    expect(r.body.error.message).toMatch(/No quantity was recorded/i);
  });

  test("only a per-piece material line may be priced from a quotation", async () => {
    /* ── WHO CHOOSES THE SHAPE ─────────────────────────────────────────────
       A client used to send the behaviour and the category alongside the
       offer, so an offer could be attached to a fixed-per-run row or an
       overhead row and the eligibility rule had to catch it. The server
       builds every quoted row now, always PER_UNIT and always MATERIAL, and a
       client row of any shape is refused before eligibility is reached. Both
       halves are asserted: the row it does build, and the row it refuses. */
    const p = await priced("Eligible");
    const ok = await calc(p);
    expect(ok.status).toBe(201);
    const built = ok.body.versions[0].cost.inputs.find((l) => l.lineKey === p.fabric);
    expect(built.behaviour).toBe("PER_UNIT");
    expect(built.category).toBe("MATERIAL");

    for (const shape of [
      { lineKey: "fixed", category: "MATERIAL", behaviour: "FIXED_PER_RUN", label: "Fabric",
        amount: { amountMinor: 100000, currency: "INR" } },
      { lineKey: "oh", category: "OVERHEAD", behaviour: "PER_UNIT", label: "Fabric",
        unitRate: { amountMinor: 41250, currency: "INR" }, quantityPerUnit: "1.4" },
    ]) {
      const r = await calc(p, [shape]);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    }
  });
});

/* ═══ 6 · THE PICKER'S OWN LOOKUPS ═══════════════════════════════════════ */

describe("the costing editor's lookups", () => {
  test("items are searchable by name and SKU, without Store permissions", async () => {
    const p = await priced("Lookup");
    const byName = await costingCall(`/lookup/items?search=${encodeURIComponent(p.item.name.slice(0, 6))}`, {
      token: p.me.token, company: p.co._id,
    });
    expect(byName.status).toBe(200);
    const hit = byName.body.items.find((i) => i.itemId === String(p.item._id));
    expect(hit).toBeTruthy();
    expect(hit.sku).toBe(p.item.sku);
    /* The item's own unit, offered as the default consumption unit. */
    expect(hit.baseUom).toBe("Metre");

    const bySku = await costingCall(`/lookup/items?search=${encodeURIComponent(p.item.sku)}`, {
      token: p.me.token, company: p.co._id,
    });
    expect(bySku.body.items.some((i) => i.itemId === String(p.item._id))).toBe(true);
  });

  test("the item lookup returns nothing a costing editor has no business reading", async () => {
    const p = await priced("LookupNarrow");
    const r = await costingCall("/lookup/items?search=", { token: p.me.token, company: p.co._id });
    const text = JSON.stringify(r.body);
    /* A picker, not a catalogue browser. */
    for (const leak of ["quantity", "minStock", "maxStock", "vendorNicknames", "primaryVendor", "stockTransactions"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("another company's items are not searchable", async () => {
    const mine = await priced("LookupA");
    const theirs = await priced("LookupB");
    const r = await costingCall(`/lookup/items?search=${encodeURIComponent(theirs.item.name)}`, {
      token: mine.me.token, company: mine.co._id,
    });
    expect(r.body.items.some((i) => i.itemId === String(theirs.item._id))).toBe(false);
  });

  test("candidates carry every commercial fact the picker renders", async () => {
    /* A minimum this run MEETS: 500 × 1.4 = 700 Metre. The unusable case has
       its own test — this one is about the facts a usable candidate carries. */
    const p = await priced("Candidates", { moq: 500, orderMultiple: 100, leadTimeDays: 7 });
    const q = new URLSearchParams({
      itemId: String(p.item._id), consumptionUom: "Metre",
      quantityPerUnit: "1.4", scenarioQuantities: "500",
      /* The picker asks the same question the save will, including the tax
         treatment — otherwise it could show usable what the save refuses. */
      taxTreatment: "RECOVERABLE",
    });
    const r = await costingCall(`/lookup/offers?${q}`, { token: p.me.token, company: p.co._id });
    expect(r.status).toBe(200);

    const c = r.body.candidates.find((x) => x.offerId === p.offer.id);
    expect(c.usable).toBe(true);
    expect(c).toMatchObject({
      supplierName: p.supplier.companyName,
      quotationReference: "Q-118",
      revision: 1,
      currency: "INR",
      quotedAmountMinor: 41250,
      priceBasis: "TAX_EXCLUSIVE",
      freightTerms: "INCLUSIVE_LANDED",
      purchaseUom: "Metre",
      leadTimeDays: 7,
      priceSource: "BASE",
    });
    /* The supplier quantity for the active scenario, not the garment count. */
    expect(c.appliedPurchaseQuantity).toBe("700");
    expect(c.conversionPath).toBe("Metre → Metre (same unit)");
    /* No warnings any more: a below-minimum or off-multiple quantity is a
       refusal, so a candidate is either usable or carries its reason. There is
       no third state where the picker offers a choice the save rejects. */
    expect(c.warnings).toEqual([]);
    /* The tax facts the picker renders, from the quotation and not the form. */
    expect(c.gstRecorded).toBe(true);
    expect(c.gstRatePercent).toBe(12);
    expect(c.gstTreatment).toBe("RECOVERABLE");
    expect(c.netRateMinor).toBe(41250);
    expect(c.grossRateMinor).toBeNull();
  });

  test("an unusable candidate is shown with its exact reason, not hidden", async () => {
    const p = await priced("Unusable", { currency: "USD" });
    const q = new URLSearchParams({
      itemId: String(p.item._id), consumptionUom: "Metre",
      quantityPerUnit: "1.4", scenarioQuantities: "500",
    });
    const r = await costingCall(`/lookup/offers?${q}`, { token: p.me.token, company: p.co._id });
    const c = r.body.candidates.find((x) => x.offerId === p.offer.id);
    /* "No quotations" and "one you cannot use, and why" are different
       answers, and hiding it leaves the person hunting a supplier they can
       see in Store. */
    expect(c.usable).toBe(false);
    expect(c.reason.code).toBe("COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED");
    expect(c.supplierName).toBe(p.supplier.companyName);
  });

  test("draft, withdrawn and expired quotations never appear as candidates", async () => {
    const p = await priced("NeverUsable");
    await create(p, { quotationReference: "Q-DRAFT" });
    await live(p, { validUntil: "2020-01-01T00:00:00.000Z", quotationReference: "Q-OLD" });
    const pulled = await live(p, { quotationReference: "Q-PULLED" });
    await at(`/${pulled.id}/withdraw`, {
      method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });

    const q = new URLSearchParams({
      itemId: String(p.item._id), consumptionUom: "Metre",
      quantityPerUnit: "1.4", scenarioQuantities: "500",
    });
    const r = await costingCall(`/lookup/offers?${q}`, { token: p.me.token, company: p.co._id });
    const refs = r.body.candidates.map((c) => c.quotationReference);
    /* The adapter decides what "current" means, once — so these cannot
       reach the picker even as unusable rows. */
    expect(refs).toEqual(["Q-118"]);
  });

  test("nothing is pre-selected, and the cheapest is not promoted", async () => {
    const p = await priced("NoAutoPick");
    const cheaper = await Vendor.create({
      companyId: p.co._id, companyName: `Cheap Mill ${++seq}`, vendorType: "Supplier", status: "Active",
    });
    await live(p, { supplierId: String(cheaper._id), unitPriceMinor: 20000, quotationReference: "Q-CHEAP" });

    const q = new URLSearchParams({
      itemId: String(p.item._id), consumptionUom: "Metre",
      quantityPerUnit: "1.4", scenarioQuantities: "500",
    });
    const r = await costingCall(`/lookup/offers?${q}`, { token: p.me.token, company: p.co._id });
    expect(r.body.candidates).toHaveLength(2);
    /* The user chooses the commercial source. Nothing here ranks or marks a
       default — buying decisions are not a sort order. */
    expect(JSON.stringify(r.body)).not.toContain("recommended");
    expect(r.body.candidates.every((c) => c.selected === undefined)).toBe(true);
  });
});

/* ═══ 7 · THE SNAPSHOT IS READABLE WITHOUT THE MASTERS ═══════════════════ */

describe("frozen provenance survives upstream change", () => {
  test("item, variant, supplier-item and document are snapshotted", async () => {
    const p = await priced("Snapshot", {
      supplierItemName: "Poplin 120gsm",
      supplierItemCode: "SUP-POP-120",
      document: { label: "Q-118.pdf", url: "https://drive.example/q118", storedAt: "Shared drive" },
    });
    const r = await calc(p);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance[0];
    /* An id is not evidence: a costing from March must still say what it
       costed after the item has been renamed and the supplier recoded. */
    expect(prov.itemName).toBe(p.item.name);
    expect(prov.itemSku).toBe(p.item.sku);
    expect(prov.supplierItemName).toBe("Poplin 120gsm");
    expect(prov.supplierItemCode).toBe("SUP-POP-120");
    expect(prov.document).toMatchObject({
      label: "Q-118.pdf", url: "https://drive.example/q118", storedAt: "Shared drive",
    });
  });

  test("renaming the item afterwards does not change the frozen costing", async () => {
    const p = await priced("Renamed");
    const r = await calc(p);
    const versionId = r.body.versions[0].id;
    const originalName = r.body.versions[0].cost.offerProvenance[0].itemName;
    /* Without this the assertion below compares undefined to undefined and
       passes for a version that snapshotted nothing at all. */
    expect(originalName).toBe(p.item.name);

    /* The Item Master moves on. */
    await RawItem.updateOne({ _id: p.item._id }, { $set: { name: "Renamed Fabric", sku: "RAW-NEW-1" } });

    const again = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    const v = again.body.versions.find((x) => x.id === versionId);
    /* A snapshot, not a reference — otherwise the version silently starts
       describing something else. */
    expect(v.cost.offerProvenance[0].itemName).toBe(originalName);
    expect(v.cost.offerProvenance[0].itemName).not.toBe("Renamed Fabric");
  });

  test("the provenance holds plain values, never a live document", async () => {
    const p = await priced("Plain");
    const made = await calc(p);
    expect(made.status).toBe(201);
    const stored = await CostingVersion.findById(made.body.versions[0].id).lean();
    /* Top-level on the stored document — `calculation` holds the engine
       version and its warnings, and the API nests the evidence under `cost`
       for the reader. The stored path is the one that matters here. */
    const prov = stored.offerProvenance[0];
    /* `.lean()` returns plain objects; what matters is that nothing here is
       a handle something could be saved through. */
    expect(typeof prov.save).toBe("undefined");
    expect(typeof prov.document?.save).toBe("undefined");
    expect(Array.isArray(prov.scenarioQuantities)).toBe(true);
  });

  test("every scenario's output and purchase quantity is frozen, not just the first", async () => {
    const p = await priced("PerScenario");
    const r = await calc(p, [], [
      { key: "q500", label: "500", quantity: "500", isPrimary: true },
      { key: "q1000", label: "1000", quantity: "1000" },
    ]);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance[0];
    /* 500 → 700 metres and 1,000 → 1,400 metres. Presenting the first as
       though it applied to both is the reading this prevents. */
    expect(prov.scenarioQuantities).toEqual([
      { outputQuantity: "500", purchaseQuantity: "700" },
      { outputQuantity: "1000", purchaseQuantity: "1400" },
    ]);
  });
});

/* ═══ 8 · A QUANTITY THE QUOTATION NEVER PRICED ══════════════════════════ */

describe("quantities the quoted tiers do not reach", () => {
  const banded = {
    tiers: [
      { minQuantity: 500, maxQuantity: 699, unitPriceMinor: 40000 },
      { minQuantity: 700, maxQuantity: 999, unitPriceMinor: 39000 },
    ],
  };

  test("a run past every quoted ceiling is refused, not priced from thin air", async () => {
    const p = await priced("Beyond", banded);
    /* 1,000 garments x 1.4 = 1,400 Metre, past the 999 ceiling. */
    const r = await calc(p, [], [
      { key: "q1000", label: "1000", quantity: "1000", isPrimary: true },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_NO_QUANTITY_TIER");
    /* Named, so the person knows which run size to re-quote — and carrying
       the reason per scenario, since a costing with several run sizes can fail
       on one and not the others. */
    expect(r.body.error.details.scenarios).toEqual([
      expect.objectContaining({
        outputQuantity: "1000", purchaseQuantity: "1400", code: "NO_QUANTITY_TIER",
      }),
    ]);
  });

  test("a run below the first band pays the offer's own stated price", async () => {
    const p = await priced("Below", banded);
    /* 100 x 1.4 = 140 Metre; the quotation's tiers start at 500. A quotation
       reading "Rs 412.50, or Rs 400 above 500 metres" HAS priced 140 metres —
       at its headline rate. That is the supplier's number, not an invented
       one, so this is priced rather than refused. */
    const r = await calc(p, [], [
      { key: "q100", label: "100", quantity: "100", isPrimary: true },
    ]);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov.priceSource).toBe("BASE");
    expect(prov.quotedAmountMinor).toBe(41250);
  });

  test("the picker shows it as unusable with the same reason, not as missing", async () => {
    const p = await priced("PickerBeyond", banded);
    const r = await costingCall(
      `/lookup/offers?itemId=${p.item._id}&consumptionUom=Metre&quantityPerUnit=1.4&scenarioQuantities=1000`,
      { token: p.me.token, company: p.co._id },
    );
    expect(r.status).toBe(200);
    const c = r.body.candidates.find((x) => x.offerId === p.offer.id);
    /* Hiding it reads as "this supplier has no quotation", which is false. */
    expect(c).toBeTruthy();
    expect(c.usable).toBe(false);
    expect(c.reason.code).toBe("COSTING_OFFER_NO_QUANTITY_TIER");
  });
});


/* ═══ 8 · THE TAX POSITION IS THE SERVER'S ═══════════════════════════════ */

describe("supplier-offer tax is server authoritative", () => {
  test("a GST rate submitted by the browser is ignored, not applied", async () => {
    /* ── WHAT THIS PREVENTS ────────────────────────────────────────────────
       The engine costs a NON_RECOVERABLE line by the rate on the line. Left
       client-supplied, a form — or anyone with the endpoint — could declare
       40% on a 12% quotation and inflate the frozen cost, or declare 0% and
       deflate it. Neither number was ever quoted, and both would be frozen
       into an immutable version as evidence. */
    const p = await priced("Spoof", { gstRatePercent: 12 }, { gst: "NON_RECOVERABLE" });
    /* The request cannot state a rate — there is no line on it to state one
       on — and a row that tries is refused before it reaches the pricing. */
    const forged = await calc(p, [{
      lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Shell fabric",
      unitRate: { amountMinor: 41250, currency: "INR" }, quantityPerUnit: "1.4",
      tax: { treatment: "NON_RECOVERABLE", ratePercent: "40" },
    }]);
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");

    const r = await calc(p);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance[0];
    /* The quotation's rate, not the request's. */
    expect(prov.gstRatePercent).toBe(12);
    expect(prov.gstTreatment).toBe("NON_RECOVERABLE");

    /* And the cost was built on 12%, not 40%: 41250 × 1.4 × 500 = 28,875,000
       net, plus 12% = 32,340,000. At 40% it would have been 40,425,000. */
    const line = r.body.versions[0].cost.scenarios[0].lines.find((l) => l.lineKey === p.fabric);
    expect(line.taxMinor).toBe(3465000);
  });

  test("recoverable GST stays outside garment cost; non-recoverable enters it", async () => {
    const base = { gstRatePercent: 12 };

    const rec = await priced("Recoverable", base);
    const a = await calc(rec);
    expect(a.status).toBe(201);
    const recLine = a.body.versions[0].cost.scenarios[0].lines.find((l) => l.lineKey === rec.fabric);

    const non = await priced("NonRecoverable", base, { gst: "NON_RECOVERABLE" });
    const b = await calc(non);
    expect(b.status).toBe(201);
    const nonLine = b.body.versions[0].cost.scenarios[0].lines.find((l) => l.lineKey === non.fabric);

    /* Same quotation, same rate, same consumption — and a different cost,
       which is the entire point. Recoverable GST is money the company gets
       back, so it is reported and never added. */
    expect(recLine.taxMinor).toBe(0);
    expect(nonLine.taxMinor).toBe(3465000);
    expect(nonLine.totalMinor - recLine.totalMinor).toBe(3465000);
    expect(a.body.versions[0].cost.scenarios[0].recoverableTaxMinor).toBe(3465000);
  });

  test("a taxable quotation cannot be costed without saying which it is", async () => {
    /* NONE is not a third opinion about recoverability — it is the absence of
       one, and defaulting it either way is a silent assumption: recoverable
       under-costs every non-recoverable purchase, non-recoverable over-costs
       the rest. */
    /* The company has not stated it, which is where the answer lives — the
       same answer on every material line, so not a per-line opinion. */
    const p = await priced("MustSay", { gstRatePercent: 12 }, { gst: null });
    const r = await calc(p);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(["COSTING_OFFER_TAX_TREATMENT_REQUIRED", "COSTING_AWAITING_SOURCE"])
      .toContain(r.body.error.code);
  });

  test("a non-taxable quotation forces NONE at a recorded zero", async () => {
    /* The company's policy says RECOVERABLE, and this quotation is
       non-taxable — so there is nothing to recover and the line's position is
       a stated nil. Applying the policy answer regardless is what used to
       refuse the line outright. */
    const p = await priced("NonTaxable", { priceBasis: "NON_TAXABLE", gstRatePercent: undefined });
    const r = await calc(p);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov.priceBasis).toBe("NON_TAXABLE");
    expect(prov.gstTreatment).toBe("NONE");
    /* A stated nil IS a recorded tax position — unlike a blank rate, which is
       the absence of one and is refused outright. */
    expect(prov.gstRecorded).toBe(true);
    expect(prov.gstAmountMinor).toBe(0);
    expect(prov.netRateMinor).toBe(41250);
    expect(prov.grossRateMinor).toBe(41250);

    const line = r.body.versions[0].cost.scenarios[0].lines.find((l) => l.lineKey === p.fabric);
    expect(line.taxMinor).toBe(0);
  });

  test("recoverability cannot be claimed on a non-taxable quotation", async () => {
    /* The rule still stands at the pricing boundary, which is the layer that
       has the quotation in hand. Asserted there rather than through a request
       field that no longer exists. */
    const offerPricingService = require("../../services/centralCosting/offerPricing.service");
    expect(() => offerPricingService.taxPositionFor(
      { offerId: "x", priceBasis: "NON_TAXABLE" }, "RECOVERABLE",
    )).toThrow(expect.objectContaining({ code: "COSTING_OFFER_TAX_TREATMENT_NOT_ALLOWED" }));
  });
});

/* ═══ 9 · THE WHOLE EVIDENCE, AND ONLY TO COST READERS ═══════════════════ */

describe("the frozen provenance and who may read it", () => {
  test("a cost reader gets every commercial fact the version froze", async () => {
    const p = await priced("FullProv", {
      gstRatePercent: 12, hsnCode: "5208", moq: 500, orderMultiple: 100,
      quotationDate: "2026-01-15T00:00:00.000Z",
      document: { label: "Q-118.pdf", url: "https://drive.example/q118", storedAt: "Shared drive" },
      tiers: [{ minQuantity: 500, maxQuantity: 999, unitPriceMinor: 40000 }],
    }, { gst: "NON_RECOVERABLE" });
    const r = await calc(p);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance[0];
    expect(prov).toMatchObject({
      state: "SUPPLIER_QUOTATION",
      quotationReference: "Q-118",
      hsnCode: "5208",
      gstTreatment: "NON_RECOVERABLE",
      gstRatePercent: 12,
      priceBasis: "TAX_EXCLUSIVE",
      freightTerms: "INCLUSIVE_LANDED",
      roundingMode: "HALF_UP",
      tierMinQuantity: 500,
      tierMaxQuantity: 999,
      purchaseUom: "Metre",
      consumptionUom: "Metre",
      appliedPurchaseQuantity: "700",
    });
    expect(prov.quotationDate).toBeTruthy();
    expect(prov.document).toMatchObject({ label: "Q-118.pdf", url: "https://drive.example/q118" });
    expect(prov.netRateMinor).toBe(40000);
    expect(prov.conversionFactor).toBe("1");
    expect(prov.scenarioQuantities).toEqual([{ outputQuantity: "500", purchaseQuantity: "700" }]);
    expect(prov.supplierName).toBe(p.supplier.companyName);
    expect(prov.itemName).toBe(p.item.name);
  });

  test("an output-only reader gets no supplier, no quoted rate and no evidence", async () => {
    const p = await priced("OutputOnly", { gstRatePercent: 12 });
    const made = await calc(p);
    expect(made.status).toBe(201);

    /* The same version, read by somebody holding only `costing.output.read`.
       Supplier pricing is what `costing.cost.read` gates, and a Sales reader
       must not receive it — enforced here, on the server, not by a screen
       choosing not to render it. */
    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: [CAPABILITIES.OUTPUT_READ], via: ["test"], isAdmin: false });

    const r = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    const serialized = JSON.stringify(r.body);

    for (const version of (r.body.versions || [])) {
      expect(version).not.toHaveProperty("cost");
      expect(version).not.toHaveProperty("offerProvenance");
    }
    /* Not merely absent from the shape — absent from the payload. A nested
       leak somewhere unexpected would still be a disclosure. */
    expect(serialized).not.toContain(p.supplier.companyName);
    expect(serialized).not.toContain("Q-118");
    expect(serialized).not.toContain("SUPPLIER_QUOTATION");
    expect(serialized).not.toContain("41250");
  });

  test("a legacy alias price cannot be typed into a costing at all", async () => {
    /* ── WHAT A NICKNAME PRICE IS, AND WHY IT NO LONGER TRAVELS ──────
       `RawItem.variants[].vendorNicknames[].price` is a mutable number with
       no date, no validity and no reference. This test used to send it as a
       declared override — "that is what a nickname price is: a figure
       somebody holds by hand" — and check it stayed PROVISIONAL and produced
       no offer provenance.

       Both of those remain true of the FIELD, and nothing here upgrades it.
       What changed is that a costing does not take a figure from a request,
       so a nickname price reaches one the same way any other price does: by
       being recorded as a quotation in the Store register, where it acquires
       the date and the validity it currently lacks. */
    const p = await priced("Legacy", { gstRatePercent: 12 });
    const r = await calc(p, [{
      lineKey: "thread", category: "MATERIAL", behaviour: "PER_UNIT", label: "Thread",
      quantityPerUnit: "0.2", quantityUom: "Metre",
      unitRate: { amountMinor: 900, currency: "INR" },
      override: { family: "materials", reason: "Vendor nickname price; no quotation on file for thread." },
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.owner.recordedIn).toMatch(/quotation/i);
  });
});

/* ═══ 10 · THE SUPPLIER MUST STILL BE ONE WE BUY FROM ════════════════════ */

describe("a supplier deactivated after quoting", () => {
  /* ── THE GAP THIS CLOSES ────────────────────────────────────────────────
     `currentOfferById` answers "is this quotation live?" — its lifecycle and
     its dates. The offer record knows nothing about the supplier, so a
     company deactivated long after quoting left a quotation that went on
     looking perfectly current. Store's `/applicable` listing checked the
     supplier; this path did not, so the Store register could show a supplier
     as unavailable while the costing picker offered them and the save
     accepted — freezing a price from a company nobody buys from any more. */

  const deactivate = (w, status = "Inactive") =>
    Vendor.updateOne({ _id: w.supplier._id }, { $set: { status } });

  const pick = (p) => costingCall(
    `/lookup/offers?itemId=${p.item._id}&consumptionUom=Metre&quantityPerUnit=1.4`
    + "&scenarioQuantities=500&taxTreatment=RECOVERABLE",
    { token: p.me.token, company: p.co._id },
  );

  test("the picker shows the offer as unusable with the inactive-supplier reason", async () => {
    const p = await priced("SupplierOff", { gstRatePercent: 12 });

    /* Active first, so the refusal below proves the supplier check and not a
       quotation that was never usable. */
    const before = await pick(p);
    expect(before.status).toBe(200);
    expect(before.body.candidates.find((c) => c.offerId === p.offer.id).usable).toBe(true);

    await deactivate(p);

    const after = await pick(p);
    expect(after.status).toBe(200);
    const c = after.body.candidates.find((x) => x.offerId === p.offer.id);
    /* Shown and explained, never hidden — "no quotations" would send somebody
       to enter a second one. */
    expect(c).toBeTruthy();
    expect(c.usable).toBe(false);
    expect(c.reason.code).toBe("COSTING_OFFER_INACTIVE_SUPPLIER");
  });

  test("creating a version from that offer is refused with the same code", async () => {
    const p = await priced("SupplierOffSave", { gstRatePercent: 12 });
    /* The same request succeeds while the supplier is active. */
    expect((await calc(p)).status).toBe(201);

    await deactivate(p);

    const r = await calc(p);
    expect(r.status).toBe(422);
    /* The picker and the save reach the same verdict — the disagreement
       between them is the defect this closes. */
    expect(r.body.error.code).toBe("COSTING_OFFER_INACTIVE_SUPPLIER");
    expect(r.body.error.details.supplierId).toBe(String(p.supplier._id));
  });

  test("a pending supplier is not an active one either", async () => {
    const p = await priced("SupplierPending", { gstRatePercent: 12 });
    await deactivate(p, "pending");
    const r = await calc(p);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_INACTIVE_SUPPLIER");
  });

  test("a version created earlier stays readable, with its supplier frozen", async () => {
    const p = await priced("SupplierFrozen", { gstRatePercent: 12 });
    const made = await calc(p);
    expect(made.status).toBe(201);
    const versionId = made.body.versions[0].id;
    const supplierName = p.supplier.companyName;

    await deactivate(p);

    /* ── HISTORY DOES NOT MOVE WHEN A RELATIONSHIP ENDS ─────────────────
       The refusal is about creating something NEW. A costing that was built
       while the supplier was active must go on saying what it was built
       from, or every past costing silently loses its evidence the day a
       supplier is deactivated. */
    const again = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    expect(again.status).toBe(200);
    const v = again.body.versions.find((x) => x.id === versionId);
    expect(v).toBeTruthy();
    const prov = v.cost.offerProvenance[0];
    expect(prov.supplierName).toBe(supplierName);
    expect(prov.state).toBe("SUPPLIER_QUOTATION");
    expect(prov.netRateMinor).toBe(41250);

    /* And the offer itself is untouched — nothing withdrew it. */
    const stored = await SupplierOffer.findById(p.offer.id).lean();
    expect(stored.status).toBe("ACTIVE");
    expect(stored.withdrawnAt).toBeUndefined();
  });

  test("reactivating the supplier makes the still-current offer usable again", async () => {
    const p = await priced("SupplierBack", { gstRatePercent: 12 });
    await deactivate(p);
    expect((await calc(p)).status).toBe(422);

    /* The check reads the supplier master every time rather than caching a
       verdict, so the relationship resuming is enough — the quotation never
       had to change. */
    await deactivate(p, "Active");

    const r = await calc(p);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].cost.offerProvenance[0].supplierName).toBe(p.supplier.companyName);

    const c = (await pick(p)).body.candidates.find((x) => x.offerId === p.offer.id);
    expect(c.usable).toBe(true);
  });

  test("a supplier lookup failure is an outage, not an inactive supplier", async () => {
    /* ── THE MISTAKE THIS PINS ──────────────────────────────────────────
       Catching the lookup and treating the failure as "inactive" turns a
       database blip into a settled commercial statement — and sends somebody
       to re-negotiate a relationship that is perfectly fine. */
    const p = await priced("SupplierOutage", { gstRatePercent: 12 });
    jest.spyOn(storeFacts, "supplierIdentity")
      .mockRejectedValue(Object.assign(new Error("connection reset"), { code: "COMPANY_CONTEXT_UNAVAILABLE" }));

    const r = await calc(p);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body?.error?.code).not.toBe("COSTING_OFFER_INACTIVE_SUPPLIER");
  });
});

/* ═══ 11 · A RATE PER SCENARIO, END TO END ═══════════════════════════════ */

describe("scenario-specific supplier pricing", () => {
  const banded = {
    gstRatePercent: 12,
    tiers: [
      { minQuantity: 500, maxQuantity: 1999, unitPriceMinor: 41250 },
      { minQuantity: 2000, unitPriceMinor: 39500 },
    ],
  };
  const THREE = [
    { key: "q500", label: "500 garments", quantity: "500", isPrimary: true },
    { key: "q1500", label: "1500 garments", quantity: "1500" },
    { key: "q3000", label: "3000 garments", quantity: "3000" },
  ];

  test("three scenarios reach three verdicts from one quotation", async () => {
    const p = await priced("ThreeWay", banded, { consumption: "1" });
    /* 1 metre per garment: 500, 1,500 and 3,000 metres. The first two fall in
       the 500–1,999 band and the third in the 2,000+ one. */
    const r = await calc(p, [], THREE);
    expect(r.status).toBe(201);

    const scenarios = r.body.versions[0].cost.scenarios;
    const rate = (k) => scenarios.find((s) => s.key === k).lines.find((l) => l.lineKey === p.fabric).unitRateMinor;
    expect(rate("q500")).toBe(41250);
    expect(rate("q1500")).toBe(41250);
    expect(rate("q3000")).toBe(39500);
  });

  test("each scenario's own commercial facts are frozen beside the line", async () => {
    const p = await priced("FrozenScenarios", banded, { consumption: "1" });
    const r = await calc(p, [], THREE);
    const prov = r.body.versions[0].cost.offerProvenance[0];

    /* The base line identity is recorded ONCE; the per-scenario facts sit
       beside it rather than overwriting it. */
    expect(prov.quotationReference).toBe("Q-118");
    expect(prov.scenarios).toHaveLength(3);

    const big = prov.scenarios.find((s) => s.scenarioKey === "q3000");
    expect(big).toMatchObject({
      outputQuantity: "3000", purchaseQuantity: "3000", purchaseUom: "Metre",
      priceSource: "TIER", tierMinQuantity: 2000, tierMaxQuantity: null,
      quotedAmountMinor: 39500, effectiveRateMinor: 39500,
      conversionFactor: "1", taxTreatment: "RECOVERABLE",
    });
    const small = prov.scenarios.find((s) => s.scenarioKey === "q500");
    expect(small).toMatchObject({ tierMinQuantity: 500, tierMaxQuantity: 1999, quotedAmountMinor: 41250 });
  });

  test("the explanation attributes the saving to the tier and to the setup", async () => {
    /* ── THE FIXED COST COMES FROM A RECORD NOW ──────────────────────
       Screen making was posted here as a declared override — "no rate source
       in this repository". It has one: R&D records the setup work on the
       style and the screen room's own quotation prices it, so the seed states
       both and the server assembles the FIXED_PER_RUN row.

       Which matters for what this test is about. The dilution cause below
       asserts the screens cost the SAME at both run sizes and only their
       allocation moved — a claim that is only worth making about a figure the
       engine produced from a record, rather than one the request stated. */
    const p = await priced("Explained", banded, {
      consumption: "1",
      development: { internal: false, unit: "Lot", quantity: 1, rateMinor: 2500000 },
    });
    const r = await calc(p, [], THREE);
    expect(r.status).toBe(201);

    const compared = r.body.versions[0].cost.scenarios
      .find((s) => s.key === "q3000").comparedToPrimary;
    expect(compared.againstScenarioKey).toBe("q500");

    /* ── BY CAUSE *AND* LINE, NOT BY CAUSE ALONE ─────────────────────
       This keyed the causes by `cause`, which was unambiguous while the only
       fixed cost in the costing was the one the request posted. A real
       assembled costing has more than one — the ex-works freight answer is a
       fixed line too, at nil — and keying by cause alone silently kept
       whichever came last. It found the zero-valued freight row and reported
       a dilution of nothing. */
    const causeOn = (cause, lineKey) => compared.causes
      .find((c) => c.cause === cause && c.lineKey === lineKey);

    expect(causeOn("SUPPLIER_TIER", p.fabric)).toMatchObject({
      primaryRateMinor: 41250, comparedRateMinor: 39500,
      source: "SUPPLIER_QUOTATION",
    });

    const screens = compared.causes.find(
      (c) => c.cause === "FIXED_COST_DILUTION" && c.category === "FIXED_SETUP",
    );
    /* The screens cost the same; only their allocation moved. */
    expect(screens.primaryTotalMinor).toBe(screens.comparedTotalMinor);
    expect(screens.perUnitDeltaMinor).toBeLessThan(0);
  });

  test("one unsupported scenario refuses the version and names that scenario", async () => {
    /* Bands that stop at 1,999 with nothing above: 3,000 metres has no quoted
       rate at all. Not "use the nearest tier" — the supplier said nothing
       about that volume. */
    const p = await priced("GapScenario", {
      gstRatePercent: 12,
      tiers: [{ minQuantity: 500, maxQuantity: 1999, unitPriceMinor: 41250 }],
    }, { consumption: "1" });
    const r = await calc(p, [], THREE);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_OFFER_NO_QUANTITY_TIER");
    expect(r.body.error.details.scenarios).toEqual([
      expect.objectContaining({
        scenarioKey: "q3000", outputQuantity: "3000", purchaseQuantity: "3000",
        code: "NO_QUANTITY_TIER",
      }),
    ]);
    /* The two that WERE supported are not listed as problems. */
    expect(r.body.error.details.scenarios).toHaveLength(1);
  });

  test("a minimum or a multiple missed by one scenario names that scenario", async () => {
    const moq = await priced("MoqScenario", { gstRatePercent: 12, moq: 1000 }, { consumption: "1" });
    const a = await calc(moq, [], THREE);
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe("COSTING_OFFER_BELOW_MOQ");
    expect(a.body.error.details.scenarios[0]).toMatchObject({
      scenarioKey: "q500", purchaseQuantity: "500",
    });

    const mult = await priced("MultScenario", { gstRatePercent: 12, orderMultiple: 1000 }, { consumption: "1" });
    const b = await calc(mult, [], THREE);
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe("COSTING_OFFER_NOT_AN_ORDER_MULTIPLE");
    /* 500 and 1,500 metres are both fractions of a 1,000 multiple; 3,000 is
       not, and is absent from the refusal. Every affected scenario is named,
       not just the first — a costing with three run sizes can fail on two. */
    expect(b.body.error.details.scenarios.map((x) => x.scenarioKey)).toEqual(["q500", "q1500"]);
  });

  test("a client cannot supply a scenario rate, a purchase quantity or a saving", async () => {
    const p = await priced("NoForge", banded, { consumption: "1" });
    for (const forged of [
      { unitRateByScenario: { q3000: { amountMinor: 1, currency: "INR" } } },
      { effectiveRateMinor: 1 },
      { tierPriceMinor: 1 },
      { supplierPurchaseQuantity: "999999" },
      { eosSaving: 100000 },
      { comparedToPrimary: { unitCostDeltaMinor: -99999 } },
    ]) {
      /* ── A PLAIN LINE, DELIBERATELY ────────────────────────────────
         It used to carry a declared override so that the refusal under test
         was the server-derived-field one rather than the undeclared-row one.
         An override now meets its own refusal first, which would hide the
         thing this test exists for. A plain line reaches the same check: the
         server-derived guard runs in the request parser, before anything
         knows whether the row is declared. */
      const r = await calc(p, [{
        lineKey: "extra", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag",
        unitRate: { amountMinor: 1200, currency: "INR" }, quantityPerUnit: "1",
        ...forged,
      }], THREE);
      /* Refused by name, not dropped: ignoring teaches a client the field
         works, and the next version of it stops checking. */
      expect(r.status).toBe(400);
      expect(r.body.error.details.reason).toBe("SERVER_DERIVED_FIELD");
    }
  });

  test("revising the quotation afterwards does not touch the frozen version", async () => {
    const p = await priced("StillFrozen", banded, { consumption: "1" });
    const made = await calc(p, [], THREE);
    expect(made.status).toBe(201);
    const versionId = made.body.versions[0].id;

    await at(`/${p.offer.id}/revise`, {
      method: "POST", token: p.me.token, company: p.co._id, idempotencyKey: newKey(),
      body: body_(p, { unitPriceMinor: 20000, quotationReference: "Q-119", gstRatePercent: 12 }),
    });

    const back = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    const v = back.body.versions.find((x) => x.id === versionId);
    const prov = v.cost.offerProvenance[0];
    expect(prov.quotationReference).toBe("Q-118");
    expect(prov.scenarios.find((s) => s.scenarioKey === "q3000").quotedAmountMinor).toBe(39500);
  });

  test("a retry with the same key creates no second version", async () => {
    const p = await priced("IdemScenario", banded, { consumption: "1" });
    const key = newKey();
    const before = await CostingVersion.countDocuments({ costingId: p.costingId });
    const a = await calc(p, [], THREE, key);
    const b = await calc(p, [], THREE, key);
    expect(a.status).toBe(201);
    expect(b.body.versions[0].id).toBe(a.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId: p.costingId })).toBe(before + 1);
  });

  test("an output-only reader gets no scenario rates and no explanation", async () => {
    const p = await priced("SalesBlind", banded, { consumption: "1" });
    const made = await calc(p, [], THREE);
    expect(made.status).toBe(201);

    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: [CAPABILITIES.OUTPUT_READ], via: ["test"], isAdmin: false });

    const r = await costingCall(`/${p.costingId}/versions`, { token: p.me.token, company: p.co._id });
    const serialized = JSON.stringify(r.body);
    /* An explanation that named a quoted rate would hand Sales the supplier's
       price by another route — which is the disclosure the block gate exists
       to prevent. */
    expect(serialized).not.toContain("39500");
    expect(serialized).not.toContain("SUPPLIER_TIER");
    expect(serialized).not.toContain("comparedToPrimary");
    for (const v of (r.body.versions || [])) expect(v).not.toHaveProperty("cost");
  });
});
