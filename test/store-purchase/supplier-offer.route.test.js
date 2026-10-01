// test/store-purchase/supplier-offer.route.test.js
//
// Store & Purchase — THE SUPPLIER OFFER REGISTER.
//
// ── AND WHOSE PERMISSIONS OPEN IT ───────────────────────────────────────────
// Store's. The first cut gated this on `costing.cost.read` and
// `costing.draft.write`, so a storekeeper needed a costing grant to see their
// own supplier register. These prove the boundary is Store's now: a Store
// viewer reads, a sourcing manager writes, and a costing-only user holds no
// authority here at all.
//
// The only supplier price in the system was a mutable `vendorNicknames[].price`
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
  await mongoose.connect(rs.getUri(), { dbName: "supplier_offers" });

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

const newKey = () => `of-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  /* No overhead: it is a Board policy now and this body is refused with it. */
  minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32",
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

const calculate = (me, co, costingId, body = { lines: LINES, scenarios: SCENARIOS }, key = newKey()) =>
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
  const email = `spo-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "S", lastName: `L${n}`, email, biometricId: `SPO${n}`,
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
  quotationReference: "Q-118",
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

/* ═══ 1 · COMPANY BOUNDARY ═══════════════════════════════════════════════ */

describe("two companies, two registers", () => {
  test("equivalent supplier, item and reference values coexist independently", async () => {
    const a = await world("Acme");
    const b = await world("Beta");
    /* Same quotation number, same price, same unit — in two companies. */
    expect((await create(a)).status).toBe(201);
    expect((await create(b)).status).toBe(201);

    const seenByA = await at("/", { token: a.me.token, company: a.co._id });
    expect(seenByA.body.offers).toHaveLength(1);
    expect(seenByA.body.offers[0].supplier.name).toBe(a.supplier.companyName);
    /* Nothing of B's is reachable, and nothing says B's exists. */
    expect(JSON.stringify(seenByA.body)).not.toContain(b.supplier.companyName);
  });

  test("another company's offer is not found, not forbidden", async () => {
    const a = await world("Acme");
    const b = await world("Beta");
    const theirs = await live(b);

    const r = await at(`/${theirs.id}`, { token: a.me.token, company: a.co._id });
    expect(r.status).toBe(404);
    /* Identical to an id that never existed — a 403 would confirm it does. */
    const ghost = await at(`/${new mongoose.Types.ObjectId()}`, { token: a.me.token, company: a.co._id });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toEqual(r.body.error);
  });

  test("a foreign supplier, item, unit or variant is refused without disclosure", async () => {
    const a = await world("Acme");
    const b = await world("Beta");

    for (const over of [
      { supplierId: String(b.supplier._id) },
      { itemId: String(b.item._id) },
      { variantId: b.variantId },
    ]) {
      const r = await create(a, over);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("NOT_FOUND");
      /* No name, no code, nothing that says the record exists elsewhere. */
      expect(JSON.stringify(r.body)).not.toContain(b.supplier.companyName);
      expect(JSON.stringify(r.body)).not.toContain(b.item.sku);
    }
    expect(await SupplierOffer.countDocuments({ companyId: a.co._id })).toBe(0);
  });
});

/* ═══ 2 · THE SUBJECT MUST HANG TOGETHER ═════════════════════════════════ */

describe("supplier, item, variant and unit", () => {
  test("a variant from another item is not found", async () => {
    const w = await world("Variant");
    const other = await RawItem.create({
      companyId: w.co._id, name: "Linen", sku: `RAW-LIN-${++seq}`, unit: "Metre",
      quantity: 0, minStock: 0, maxStock: 10,
      variants: [{ combination: ["Blue"], sku: `RAW-LIN-${seq}-B`, quantity: 0 }],
    });
    const r = await create(w, { variantId: String(other.variants[0]._id) });
    expect(r.status).toBe(404);
  });

  test("a variant of the named item is accepted and labelled", async () => {
    const w = await world("VariantOk");
    const r = await create(w, { variantId: w.variantId });
    expect(r.status).toBe(201);
    expect(r.body.offer.variant.id).toBe(w.variantId);
    /* ── A GENUINE LIMIT, NOT A CHOICE ─────────────────────────────────────
       `storeFacts.itemFacts` exposes a variant's `name` and `sku` and NOT its
       `combination` array, and that narrow door is the only way this service
       reads the Store masters — reaching around it into `RawItem` would be a
       second definition of "is this item yours". So a variant whose identity
       lives in `combination` is labelled by its SKU, which is unambiguous.
       Widening `itemFacts` is Chunk 3.2's to consider. */
    expect(r.body.offer.variant.label).toBe(w.item.variants[0].sku);
  });

  test("an inactive supplier cannot be quoted from", async () => {
    const w = await world("Inactive");
    await Vendor.updateOne({ _id: w.supplier._id }, { $set: { status: "Inactive" } });
    const r = await create(w);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not active/i);
  });
});

/* ═══ 3 · MONEY AND TAX ══════════════════════════════════════════════════ */

describe("the price", () => {
  test("a missing GST rate is not 0%", async () => {
    const w = await world("NoGst");
    const o = await live(w);
    /* Absent, so the screen cannot print 0% for a rate nobody recorded. */
    expect(o.gstRatePercent).toBeNull();
    expect(o.price.gstKnown).toBe(false);
    expect(o.price.gstAmountMinor).toBeNull();
    expect(o.price.reason).toBe("GST_RATE_NOT_RECORDED");
    /* The quoted figure is still the net, because the basis says so. */
    expect(o.price.netUnitPriceMinor).toBe(41250);
    expect(o.price.grossUnitPriceMinor).toBeNull();
  });

  test("a recorded 0% is a real commercial statement", async () => {
    const w = await world("ZeroGst");
    const o = await live(w, { gstRatePercent: 0 });
    expect(o.gstRatePercent).toBe(0);
    expect(o.price.gstKnown).toBe(true);
    expect(o.price.gstAmountMinor).toBe(0);
    expect(o.price.grossUnitPriceMinor).toBe(41250);
  });

  test("exclusive and inclusive bases produce correct integer figures", async () => {
    const w = await world("Basis");
    const ex = await live(w, { unitPriceMinor: 10000, gstRatePercent: 18, priceBasis: "TAX_EXCLUSIVE" });
    expect(ex.price.netUnitPriceMinor).toBe(10000);
    expect(ex.price.gstAmountMinor).toBe(1800);
    expect(ex.price.grossUnitPriceMinor).toBe(11800);

    const inc = await live(w, { unitPriceMinor: 11800, gstRatePercent: 18, priceBasis: "TAX_INCLUSIVE" });
    expect(inc.price.grossUnitPriceMinor).toBe(11800);
    expect(inc.price.netUnitPriceMinor).toBe(10000);
    expect(inc.price.gstAmountMinor).toBe(1800);
    /* Integers throughout — a float here is a fraction of a paisa in a
       register of exact prices. */
    for (const v of Object.values(inc.price)) {
      if (typeof v === "number") expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  test("a price basis must be stated — there is no default", async () => {
    const w = await world("Basisless");
    const r = await create(w, { priceBasis: undefined });
    expect(r.status).toBe(400);
    /* Guessing is an 18% error waiting to be quoted. */
    expect(r.body.error.message).toMatch(/excludes or includes tax/i);
  });

  test("non-integer or unsafe money is refused, not rounded", async () => {
    const w = await world("Money");
    for (const bad of [412.5, "412.50", -100, 9007199254740993, null, ""]) {
      const r = await create(w, { unitPriceMinor: bad });
      expect(r.status).toBe(400);
    }
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ═══ 4 · QUANTITY TIERS ═════════════════════════════════════════════════ */

describe("quantity tiers", () => {
  test("they are stored in order, whatever order they arrive in", async () => {
    const w = await world("Tiers");
    const o = await live(w, { tiers: [
      { minQuantity: 500, unitPriceMinor: 39000 },
      { minQuantity: 100, unitPriceMinor: 41000 },
    ] });
    expect(o.tiers.map((t) => t.minQuantity)).toEqual([100, 500]);
  });

  test("overlapping, duplicate and non-positive tiers are refused", async () => {
    const w = await world("BadTiers");
    for (const tiers of [
      [{ minQuantity: 100, unitPriceMinor: 1 }, { minQuantity: 100, unitPriceMinor: 2 }],
      [{ minQuantity: 0, unitPriceMinor: 1 }],
      [{ minQuantity: -5, unitPriceMinor: 1 }],
      [{ minQuantity: 100, unitPriceMinor: 12.5 }],
    ]) {
      expect((await create(w, { tiers })).status).toBe(400);
    }
  });

  test("no tiers means no tiers, not one tier at quantity one", async () => {
    const w = await world("NoTiers");
    const o = await live(w);
    /* Null, so a screen cannot render an invented tier the supplier never
       quoted. */
    expect(o.tiers).toBeNull();
  });
});

/* ═══ 5 · DERIVED STATE, AT A FIXED CLOCK ════════════════════════════════ */

describe("state is derived from the clock, never stored", () => {
  const NOW = new Date("2026-09-15T00:00:00.000Z");
  const offer = (over) => ({ status: "ACTIVE", ...over });

  test("current, future and expired at one instant", () => {
    expect(offerService.deriveState(offer({
      effectiveFrom: new Date("2026-09-01"), validUntil: new Date("2026-10-01"),
    }), NOW)).toBe("current");

    expect(offerService.deriveState(offer({
      effectiveFrom: new Date("2026-10-01"),
    }), NOW)).toBe("future");

    expect(offerService.deriveState(offer({
      effectiveFrom: new Date("2026-08-01"), validUntil: new Date("2026-09-01"),
    }), NOW)).toBe("expired");

    /* No validity recorded is NOT expired — it is "validity not recorded",
       and the offer stands until somebody says otherwise. */
    expect(offerService.deriveState(offer({ effectiveFrom: new Date("2026-09-01") }), NOW)).toBe("current");
  });

  test("a draft, a withdrawal and a supersession are their own answers", () => {
    expect(offerService.deriveState({ status: "DRAFT" }, NOW)).toBe("incomplete");
    expect(offerService.deriveState({ status: "WITHDRAWN" }, NOW)).toBe("withdrawn");
    expect(offerService.deriveState({ status: "SUPERSEDED" }, NOW)).toBe("superseded");
    /* Collapsing expired into withdrawn would blame somebody for the
       calendar. */
    expect(offerService.deriveState(offer({ validUntil: new Date("2026-01-01") }), NOW)).toBe("expired");
  });

  test("only a current offer is selectable", () => {
    for (const state of [{ status: "DRAFT" }, { status: "WITHDRAWN" }, { status: "SUPERSEDED" },
      offer({ validUntil: new Date("2026-01-01") }), offer({ effectiveFrom: new Date("2027-01-01") })]) {
      expect(offerService.isSelectable(state, NOW)).toBe(false);
    }
    expect(offerService.isSelectable(offer({ effectiveFrom: new Date("2026-09-01") }), NOW)).toBe(true);
  });

  test("an expired offer is readable history and is not selectable over HTTP", async () => {
    const w = await world("Expired");
    const o = await live(w, {
      effectiveFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-02-01T00:00:00.000Z",
    });
    const r = await at(`/${o.id}`, { token: w.me.token, company: w.co._id });
    expect(r.status).toBe(200);
    expect(r.body.offer.state).toBe("expired");
    expect(r.body.offer.selectable).toBe(false);
    /* The price is still readable — it is what was quoted. */
    expect(r.body.offer.price.quotedMinor).toBe(41250);
  });
});

/* ═══ 6 · REVISION PRESERVES HISTORY ═════════════════════════════════════ */

describe("correcting a price", () => {
  test("a revision creates a new record and supersedes the old one", async () => {
    const w = await world("Revise");
    const first = await live(w, { unitPriceMinor: 41250 });

    const r = await at(`/${first.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { unitPriceMinor: 43000 }),
    });
    expect(r.status).toBe(201);
    expect(r.body.offer.revision).toBe(2);
    expect(r.body.offer.supersedesOfferId).toBe(first.id);

    /* The old record still says what was quoted — somebody was quoted it,
       and a costing may already have used it. */
    const old = await SupplierOffer.findById(first.id).lean();
    expect(old.unitPriceMinor).toBe(41250);
    expect(old.status).toBe("SUPERSEDED");
    expect(String(old.supersededByOfferId)).toBe(r.body.offer.id);

    /* And the chain reads from either end. */
    const detail = await at(`/${first.id}`, { token: w.me.token, company: w.co._id });
    expect(detail.body.revisions.map((x) => x.revision).sort()).toEqual([1, 2]);
    expect(detail.body.offer.state).toBe("superseded");
    expect(detail.body.offer.selectable).toBe(false);
  });

  test("an already-revised offer cannot be revised again", async () => {
    const w = await world("ReviseTwice");
    const first = await live(w);
    await at(`/${first.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    });
    const again = await at(`/${first.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SUPPLIER_OFFER_ALREADY_SUPERSEDED");
  });

  test("a withdrawal needs a reason and cannot be undone by reading", async () => {
    const w = await world("Withdraw");
    const o = await live(w);

    const noReason = await at(`/${o.id}/withdraw`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED");

    const done = await at(`/${o.id}/withdraw`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted the quotation." },
    });
    expect(done.status).toBe(200);
    expect(done.body.offer.state).toBe("withdrawn");
    expect(done.body.offer.selectable).toBe(false);
    expect(done.body.offer.withdrawalReason).toMatch(/retracted/);
    /* Still readable — a withdrawn price is history, not a deletion. */
    expect(done.body.offer.price.quotedMinor).toBe(41250);
  });
});

/* ═══ 7 · IDEMPOTENCY ════════════════════════════════════════════════════ */

describe("repeating a write", () => {
  test("the same key creates one offer", async () => {
    const w = await world("Idem");
    const key = newKey();
    const a = await create(w, {}, key);
    const b = await create(w, {}, key);
    expect(a.status).toBe(201);
    expect([200, 201]).toContain(b.status);
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("the same key with a changed body conflicts", async () => {
    const w = await world("IdemChanged");
    const key = newKey();
    expect((await create(w, { unitPriceMinor: 41250 }, key)).status).toBe(201);
    const changed = await create(w, { unitPriceMinor: 99999 }, key);
    expect(changed.status).toBe(409);
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ═══ 8 · UoM RECONCILIATION IS NEVER GUESSED ════════════════════════════ */

describe("purchase unit versus the item's base unit", () => {
  test("the same unit reconciles trivially", () => {
    const r = offerService.reconcileUom({ item: { purchaseUom: "Metre" }, unit: null, purchaseUom: "Metre" });
    expect(r).toMatchObject({ configured: true, sameUnit: true, factor: 1 });
  });

  test("a declared conversion is used, and reported", () => {
    const r = offerService.reconcileUom({
      item: { purchaseUom: "Metre" },
      unit: { conversions: [{ toUnitName: "Metre", factor: 100 }] },
      purchaseUom: "Roll",
    });
    expect(r).toMatchObject({ configured: true, sameUnit: false, factor: 100 });
  });

  test("an unconfigured conversion is SAID, never invented", () => {
    const r = offerService.reconcileUom({
      item: { purchaseUom: "Kilogram" }, unit: { conversions: [] }, purchaseUom: "Metre",
    });
    /* A price per metre shown against an item counted in kilograms as though
       they matched is the failure this refuses to commit. */
    expect(r.configured).toBe(false);
    expect(r.reason).toBe("CONVERSION_NOT_CONFIGURED");
    expect(r.factor).toBeUndefined();
    expect(r).toMatchObject({ baseUom: "Kilogram", purchaseUom: "Metre" });
  });

  test("the detail route reports it", async () => {
    const w = await world("Uom");
    const o = await live(w);
    const r = await at(`/${o.id}`, { token: w.me.token, company: w.co._id });
    expect(r.body.offer.uomReconciliation).toMatchObject({ configured: true, sameUnit: true });
  });
});

/* ═══ 9 · SEARCH, FILTER AND AUTHORITY ═══════════════════════════════════ */

describe("the register", () => {
  test("it searches supplier, item, SKU, supplier code and reference", async () => {
    const w = await world("Search");
    await live(w, { supplierItemCode: "MILL-CT-77", quotationReference: "Q-2026-441" });

    for (const q of [w.supplier.companyName.slice(0, 6), w.item.sku, "MILL-CT", "Q-2026"]) {
      const r = await at(`/?search=${encodeURIComponent(q)}`, { token: w.me.token, company: w.co._id });
      expect(r.body.offers).toHaveLength(1);
    }
    const miss = await at("/?search=nothing-like-this", { token: w.me.token, company: w.co._id });
    expect(miss.body.offers).toHaveLength(0);
  });

  test("it filters by state at one clock for the whole page", async () => {
    const w = await world("Filter");
    await live(w, { validUntil: "2020-01-01T00:00:00.000Z" });
    await live(w);

    const all = await at("/", { token: w.me.token, company: w.co._id });
    expect(all.body.offers).toHaveLength(2);
    /* One `asOf`, so two rows cannot disagree about today. */
    expect(all.body.asOf).toBeTruthy();

    const current = await at("/?state=current", { token: w.me.token, company: w.co._id });
    expect(current.body.offers).toHaveLength(1);
    expect(current.body.offers[0].state).toBe("current");
  });

  test("a Sales reader may not read or write the register", async () => {
    const w = await world("Sales");
    const o = await live(w);
    const sales = await actor({ companies: [w.co], grant: "sales" });
    expect((await at("/", { token: sales.token, company: w.co._id })).status).toBe(403);
    expect((await at(`/${o.id}`, { token: sales.token, company: w.co._id })).status).toBe(403);
    expect((await at("/", {
      method: "POST", token: sales.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    })).status).toBe(403);
  });
});

/* ═══ 10 · THE AUTHORITY IS STORE'S, NOT COSTING'S ═══════════════════════ */

describe("who may open the register", () => {
  test("a Store viewer reads offers and cannot write one", async () => {
    const w = await world("Viewer");
    const o = await live(w);
    const viewer = await storePerson(w.co, { grant: "store", role: "viewer" });

    expect((await at("/", { token: viewer.token, company: w.co._id })).status).toBe(200);
    expect((await at(`/${o.id}`, { token: viewer.token, company: w.co._id })).status).toBe(200);

    /* `sp.read` looks. `sp.sourcing.manage` changes. */
    for (const [path, body] of [
      ["/", body_(w)],
      [`/${o.id}/withdraw`, { reason: "Not wanted." }],
    ]) {
      const r = await at(path, {
        method: "POST", token: viewer.token, company: w.co._id,
        idempotencyKey: newKey(), body,
      });
      expect(r.status).toBe(403);
    }
  });

  test("a Store sourcing manager can create, activate, revise and withdraw", async () => {
    const w = await world("Sourcer");
    /* `approver` on the store department carries sourcing manage — the same
       grant that already governs supplier aliases and their prices. */
    const sourcer = await storePerson(w.co, { grant: "store", role: "approver" });

    const made = await at("/", {
      method: "POST", token: sourcer.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    });
    expect(made.status).toBe(201);

    const on = await at(`/${made.body.offer.id}/activate`, {
      method: "POST", token: sourcer.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    expect(on.status).toBe(200);

    const revised = await at(`/${made.body.offer.id}/revise`, {
      method: "POST", token: sourcer.token, company: w.co._id, idempotencyKey: newKey(),
      body: { ...body_(w), unitPriceMinor: 43000 },
    });
    expect(revised.status).toBe(201);

    const gone = await at(`/${revised.body.offer.id}/withdraw`, {
      method: "POST", token: sourcer.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });
    expect(gone.status).toBe(200);
  });

  test("a Store user with NO costing capability can still use the register", async () => {
    const w = await world("NoCosting");
    const sourcer = await storePerson(w.co, { grant: "store", role: "approver" });

    /* The costing resolver is forced to grant nothing at all. The register
       must be unaffected — this is Store's master, and the first cut made a
       storekeeper need `costing.cost.read` to open it. */
    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: [], via: ["test"], isAdmin: false });

    const made = await at("/", {
      method: "POST", token: sourcer.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    });
    expect(made.status).toBe(201);
    expect((await at("/", { token: sourcer.token, company: w.co._id })).status).toBe(200);
  });

  test("a costing user with no Store authority cannot maintain offers", async () => {
    const w = await world("CostingOnly");
    /* A company member with no Store department grant at all. */
    const outsider = await storePerson(w.co, { grant: null });

    expect((await at("/", { token: outsider.token, company: w.co._id })).status).toBe(403);
    expect((await at("/", {
      method: "POST", token: outsider.token, company: w.co._id, idempotencyKey: newKey(), body: body_(w),
    })).status).toBe(403);
  });
});

/* ═══ 11 · SERVER-SIDE FILTERING, BEFORE THE CAP ═════════════════════════ */

describe("the register filters in the query", () => {
  test("supplier and item filters narrow the query, not the page", async () => {
    const w = await world("FilterQuery");
    const otherSupplier = await Vendor.create({
      companyId: w.co._id, companyName: `Other Mill ${++seq}`, vendorType: "Supplier", status: "Active",
    });
    await live(w);
    await live(w, { supplierId: String(otherSupplier._id) });

    const bySupplier = await at(`/?supplierId=${w.supplier._id}`, { token: w.me.token, company: w.co._id });
    expect(bySupplier.body.offers).toHaveLength(1);
    expect(bySupplier.body.offers[0].supplier.id).toBe(String(w.supplier._id));

    const byItem = await at(`/?itemId=${w.item._id}`, { token: w.me.token, company: w.co._id });
    expect(byItem.body.offers).toHaveLength(2);

    const byCurrency = await at("/?currency=USD", { token: w.me.token, company: w.co._id });
    expect(byCurrency.body.offers).toHaveLength(0);
  });

  test("a state filter is applied before the cap, not to an arbitrary page", async () => {
    const w = await world("Cap");
    /* Five expired and one current. With a cap of 2 the old code fetched two
       arbitrary rows and filtered them, so "current" could legitimately
       return nothing while a current offer existed — and the register said so
       as though it were complete. */
    for (let i = 0; i < 5; i += 1) {
      await live(w, { validUntil: "2020-01-01T00:00:00.000Z", quotationReference: `OLD-${i}` });
    }
    await live(w, { quotationReference: "LIVE-1" });

    const r = await at("/?state=current&limit=2", { token: w.me.token, company: w.co._id });
    expect(r.body.offers).toHaveLength(1);
    expect(r.body.offers[0].quotationReference).toBe("LIVE-1");
    /* One result, and it is not capped — the cap applies to what MATCHED. */
    expect(r.body.capped).toBe(false);
  });

  test("a capped register says so rather than reading as complete", async () => {
    const w = await world("CappedSays");
    for (let i = 0; i < 4; i += 1) await live(w, { quotationReference: `Q-${i}` });

    const r = await at("/?limit=2", { token: w.me.token, company: w.co._id });
    expect(r.body.offers).toHaveLength(2);
    expect(r.body.capped).toBe(true);
    expect(r.body.limit).toBe(2);

    const all = await at("/?limit=50", { token: w.me.token, company: w.co._id });
    expect(all.body.capped).toBe(false);
  });
});

/* ═══ 12 · THE COSTING READ ADAPTER ══════════════════════════════════════ */

describe("what Central Costing will be able to read", () => {
  const ctx = (co) => ({ companyId: co._id, reason: "costing_line_pricing" });

  test("only genuinely current offers come back", async () => {
    const w = await world("Adapter");
    const current = await live(w, { quotationReference: "NOW" });
    await live(w, { validUntil: "2020-01-01T00:00:00.000Z", quotationReference: "OLD" });
    await live(w, { effectiveFrom: "2030-01-01T00:00:00.000Z", quotationReference: "LATER" });
    const draft = await create(w, { quotationReference: "DRAFT" });
    const pulled = await live(w, { quotationReference: "PULLED" });
    await at(`/${pulled.id}/withdraw`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });

    const facts = await offerRead.currentOffersForItem(ctx(w.co), String(w.item._id));
    /* Draft, withdrawn, expired and future are not "current" — and none of
       them may be handed to a costing as though they were. */
    expect(facts.map((f) => f.quotationReference)).toEqual(["NOW"]);
    expect(facts[0].offerId).toBe(current.id);
    expect(draft.body.offer.state).toBe("incomplete");
  });

  test("it returns plain frozen facts, not a document to save through", async () => {
    const w = await world("Frozen");
    await live(w, { gstRatePercent: 5 });
    const [fact] = await offerRead.currentOffersForItem(ctx(w.co), String(w.item._id));

    expect(typeof fact.save).toBe("undefined");
    expect(Object.isFrozen(fact)).toBe(true);
    /* A caller that tried to adjust a price before using it fails loudly
       rather than quietly. */
    expect(() => { "use strict"; fact.unitPriceMinor = 1; }).toThrow();
    expect(fact.unitPriceMinor).toBe(41250);
  });

  test("a missing GST rate reaches costing as null, never as 0", async () => {
    const w = await world("AdapterGst");
    await live(w);
    const [fact] = await offerRead.currentOffersForItem(ctx(w.co), String(w.item._id));
    /* A costing that read an unrecorded rate as zero-rated would under-cost
       every line built on it. */
    expect(fact.gstRatePercent).toBeNull();

    const w2 = await world("AdapterZero");
    await live(w2, { gstRatePercent: 0 });
    const [zero] = await offerRead.currentOffersForItem(ctx(w2.co), String(w2.item._id));
    expect(zero.gstRatePercent).toBe(0);
  });

  test("it refuses to read without a company and a stated reason", async () => {
    const w = await world("AdapterCtx");
    await expect(offerRead.currentOffersForItem({}, String(w.item._id))).rejects.toThrow();
    await expect(offerRead.currentOffersForItem({ companyId: w.co._id }, String(w.item._id))).rejects.toThrow();
  });

  test("another company's current offer is not reachable", async () => {
    const a = await world("AdapterA");
    const b = await world("AdapterB");
    await live(b);
    expect(await offerRead.currentOffersForItem(ctx(a.co), String(b.item._id))).toEqual([]);
  });

  test("one offer by id answers null unless it is current", async () => {
    const w = await world("AdapterById");
    const o = await live(w);
    expect((await offerRead.currentOfferById(ctx(w.co), o.id)).offerId).toBe(o.id);

    await at(`/${o.id}/withdraw`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });
    /* Null, not a fact with a flag on it — a flag is something a caller can
       forget to read. */
    expect(await offerRead.currentOfferById(ctx(w.co), o.id)).toBeNull();
  });

  test("costing does not reach the register over HTTP", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync(
      require("node:path").join(__dirname, "../../services/storePurchase/supplierOfferRead.service.js"), "utf8",
    );
    /* An in-process read. A network hop inside one runtime would mean the
       costing engine carrying a Store session — and a costing pricing
       silently without offers the first time it failed. */
    expect(/fetch\(|axios|http:\/\//.test(src)).toBe(false);
  });
});

/* ═══ 13 · A REVISION IS ONE COMMIT ══════════════════════════════════════ */

describe("revision persistence is indivisible", () => {
  const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

  test("a failure after the new record leaves neither it nor a broken chain", async () => {
    const w = await world("AtomicRevise");
    const original = await live(w, { quotationReference: "Q-1" });

    /* Break the predecessor's supersession — the second of the two writes. */
    const realSave = SupplierOffer.prototype.save;
    jest.spyOn(SupplierOffer.prototype, "save").mockImplementation(function patched(...args) {
      if (this.status === "SUPERSEDED") return Promise.reject(new Error("supersede write failed"));
      return realSave.apply(this, args);
    });

    const r = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { unitPriceMinor: 43000, quotationReference: "Q-1" }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    jest.restoreAllMocks();

    /* The first cut created the new ACTIVE record and superseded afterwards,
       so this left TWO active records for one quotation — and a retry then
       found the new one and returned success over a chain still broken. */
    const after = await SupplierOffer.find({ companyId: w.co._id, itemId: w.item._id }).lean();
    expect(after).toHaveLength(1);
    expect(String(after[0]._id)).toBe(original.id);
    expect(after[0].status).toBe("ACTIVE");
    expect(after[0].supersededByOfferId).toBeNull();
    expect(after[0].unitPriceMinor).toBe(41250);
  });

  test("two attempts cannot produce two successor revisions", async () => {
    /* ── REPEATED, BECAUSE ONE ROUND PROVES NOTHING ──────────────────────
       Two concurrent requests may happen to serialise, so a single round can
       pass against a predecessor read OUTSIDE the transaction — which is the
       defect. Every round must produce exactly one successor. */
    for (let round = 0; round < 4; round += 1) {
      const w = await world(`RaceRevise${round}`);
      const original = await live(w);

      const [a, b] = await Promise.all([
        at(`/${original.id}/revise`, {
          method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
          body: body_(w, { unitPriceMinor: 43000 }),
        }),
        at(`/${original.id}/revise`, {
          method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
          body: body_(w, { unitPriceMinor: 44000 }),
        }),
      ]);

      const successors = await SupplierOffer.countDocuments({
        companyId: w.co._id, supersedesOfferId: original.id,
      });
      expect(successors).toBe(1);
      expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
      /* And never two live prices for one quotation. */
      expect(await SupplierOffer.countDocuments({
        companyId: w.co._id, itemId: w.item._id, status: "ACTIVE",
      })).toBe(1);
    }
  });

  test("a retry with the same key returns the same revision", async () => {
    const w = await world("ReplayRevise");
    const original = await live(w);
    const key = newKey();
    const payload = body_(w, { unitPriceMinor: 43000 });

    const first = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key, body: payload,
    });
    expect(first.status).toBe(201);
    const second = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key, body: payload,
    });
    /* Either replay path is correct: the idempotency middleware replays the
       stored 201, and the handler's own recovery answers 200. What must be
       true is that it is the SAME revision and there is only one. */
    expect([200, 201]).toContain(second.status);
    expect(second.body.offer.id).toBe(first.body.offer.id);
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id, supersedesOfferId: original.id })).toBe(1);
  });

  test("the same key with a different payload is refused", async () => {
    const w = await world("ChangedRevise");
    const original = await live(w);
    const key = newKey();
    expect((await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key,
      body: body_(w, { unitPriceMinor: 43000 }),
    })).status).toBe(201);

    const changed = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: key,
      body: body_(w, { unitPriceMinor: 99999 }),
    });
    expect(changed.status).toBe(409);
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id, supersedesOfferId: original.id })).toBe(1);
  });

  test("without transactions the revision is refused before any write", async () => {
    const w = await world("NoTxnRevise");
    const original = await live(w);
    jest.spyOn(unitOfWork, "transactionsAvailable").mockResolvedValue(false);

    const r = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { unitPriceMinor: 43000 }),
    });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("SUPPLIER_OFFER_TRANSACTION_REQUIRED");

    jest.restoreAllMocks();
    /* Nothing written, so nothing to repair — a register that cannot be
       revised is a visible problem; a half-revised chain is not. */
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id, supersedesOfferId: original.id })).toBe(0);
    expect((await SupplierOffer.findById(original.id).lean()).status).toBe("ACTIVE");
  });

  test("the predecessor is re-read inside the transaction, not before it", () => {
    /* ── WHY THIS IS A SOURCE ASSERTION ─────────────────────────────────────
       The concurrency test above observed the real defect — two successors
       for one quotation — when the guards ran only on a copy loaded before
       the transaction opened. It cannot reproduce it on demand: two HTTP
       requests in one Node process serialise too reliably to force the
       interleave, so that test passes either way and is kept for the outcome
       it asserts rather than for the race it cannot stage.

       What CAN be pinned exactly is the property that makes the race
       impossible: the predecessor is re-read in the session, and the
       already-superseded check runs on THAT document. */
    const fs = require("node:fs");
    const src = fs.readFileSync(
      require("node:path").join(__dirname, "../../routes/CMS_Routes/Inventory/Sourcing/supplierOffers.js"),
      "utf8",
    );
    const mutate = src.slice(src.indexOf("mutate: async (session) => {"), src.indexOf("return {\n            entityType"));
    expect(mutate).toMatch(/SupplierOffer\.findOne\(\{[\s\S]{0,120}\}\)\.session\(session\)/);
    expect(mutate).toMatch(/if \(live\.supersededByOfferId \|\| live\.status === "SUPERSEDED"\)/);
    /* And the writes both carry the session, so neither escapes the commit. */
    expect(mutate).toMatch(/SupplierOffer\.create\(\[\{[\s\S]{0,1400}\}\], \{ session \}\)/);
    /* Saved INSIDE the session — through the model's named SUPERSEDE
       transition, which is the only way a published quotation may be
       written at all now. The session is what this test is about. */
    expect(mutate).toMatch(/beginOfferLifecycle\(live, "SUPERSEDE"\)\.save\(\{ session \}\)/);
    /* Nothing in the mutation writes outside it. */
    expect(mutate).not.toMatch(/\.save\(\)\s*;/);
  });
});

/* ═══ 14 · THE SERVER OWNS THE CHAIN'S IDENTITY ══════════════════════════ */

describe("a revision keeps its subject", () => {
  test("a different supplier is refused, whatever the form allowed", async () => {
    const w = await world("SubjectSupplier");
    const original = await live(w);
    const other = await Vendor.create({
      companyId: w.co._id, companyName: `Rival Mill ${++seq}`, vendorType: "Supplier", status: "Active",
    });

    const r = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { supplierId: String(other._id) }),
    });
    /* A disabled input is a convenience, not a control — this would splice a
       different supplier into an existing quotation's history. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SUPPLIER_OFFER_SUBJECT_MISMATCH");
    expect(r.body.error.details.expected.supplierId).toBe(String(w.supplier._id));
    expect(await SupplierOffer.countDocuments({ companyId: w.co._id, supersedesOfferId: original.id })).toBe(0);
  });

  test("a different item is refused too", async () => {
    const w = await world("SubjectItem");
    const original = await live(w);
    const otherItem = await RawItem.create({
      companyId: w.co._id, name: `Linen ${++seq}`, sku: `RAW-LIN-${seq}`,
      unit: "Metre", quantity: 0, minStock: 0, maxStock: 10,
    });

    const r = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { itemId: String(otherItem._id) }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SUPPLIER_OFFER_SUBJECT_MISMATCH");
  });

  test("the commercial facts ARE revisable", async () => {
    const w = await world("SubjectOk");
    const original = await live(w, { unitPriceMinor: 41250, quotationReference: "Q-1" });

    const r = await at(`/${original.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, {
        unitPriceMinor: 43000, priceBasis: "TAX_INCLUSIVE", gstRatePercent: 12,
        quotationReference: "Q-2", leadTimeDays: 0, notes: "Renegotiated.",
      }),
    });
    expect(r.status).toBe(201);
    expect(r.body.offer.price.quotedMinor).toBe(43000);
    expect(r.body.offer.quotationReference).toBe("Q-2");
    expect(r.body.offer.revision).toBe(2);
    /* And the original still says exactly what was quoted. */
    const old = await SupplierOffer.findById(original.id).lean();
    expect(old.unitPriceMinor).toBe(41250);
    expect(old.quotationReference).toBe("Q-1");
    expect(old.status).toBe("SUPERSEDED");
  });
});

/* ═══ 15 · ZERO IS A LEAD TIME ═══════════════════════════════════════════ */

describe("lead time", () => {
  test("zero days is recorded and is not the same as blank", async () => {
    const w = await world("LeadZero");
    const sameDay = await create(w, { leadTimeDays: 0 });
    expect(sameDay.status).toBe(201);
    /* The parser refused 0, so a same-day supplier could only be entered by
       leaving the field blank — which the register then read as unknown. */
    expect(sameDay.body.offer.leadTimeDays).toBe(0);

    const unknown = await create(w, {});
    expect(unknown.body.offer.leadTimeDays).toBeNull();
  });

  test("a negative or fractional lead time is refused", async () => {
    const w = await world("LeadBad");
    for (const leadTimeDays of [-1, 1.5, "two"]) {
      const r = await create(w, { leadTimeDays });
      expect(r.status).toBe(400);
    }
  });
});

/* ═══ A QUOTED PRICE IS NOT EDITABLE ═════════════════════════════════════ */

describe("supplier-offer immutability at the model boundary", () => {
  /* ── WHY THIS IS TESTED AT THE MODEL AND NOT THE ROUTE ──────────────────
     The routes already create a revision rather than edit. That was a
     CONVENTION — nothing stopped the next route, migration or bulk job from
     writing a price straight onto a live quotation, and the failure would be
     silent and backwards: every historical costing that read that offer would
     read as though it had used the new figure. */

  test("a published quotation's commercial fields cannot be written directly", async () => {
    const w = await world("Sealed");
    const offer = await live(w, { unitPriceMinor: 41250 });

    const doc = await SupplierOffer.findById(offer.id);
    doc.unitPriceMinor = 1;
    await expect(doc.save()).rejects.toThrow(/cannot be edited once it exists/);

    /* Tiers, tax, validity and the subject are all evidence too, and each is
       reachable through a different-looking assignment. */
    for (const [path, value] of [
      ["gstRatePercent", 40],
      ["validUntil", new Date("2099-01-01")],
      ["purchaseUom", "Kilogram"],
      ["quotationReference", "Q-999"],
    ]) {
      const d = await SupplierOffer.findById(offer.id);
      d[path] = value;
      await expect(d.save()).rejects.toThrow(/cannot be edited once it exists/);
    }

    const stored = await SupplierOffer.findById(offer.id).lean();
    expect(stored.unitPriceMinor).toBe(41250);
    expect(stored.purchaseUom).toBe("Metre");
  });

  test("update, replace and delete queries are refused too", async () => {
    const w = await world("SealedQuery");
    const offer = await live(w);
    const id = offer.id;

    /* A `save()`-only guard would hold for exactly the one code path that
       happens to use `save()`. These are the paths a migration reaches for. */
    await expect(SupplierOffer.updateOne({ _id: id }, { $set: { unitPriceMinor: 1 } }))
      .rejects.toThrow(/cannot be changed by an update query/);
    await expect(SupplierOffer.findOneAndUpdate({ _id: id }, { unitPriceMinor: 1 }))
      .rejects.toThrow(/cannot be changed by an update query/);
    await expect(SupplierOffer.updateMany({ companyId: w.co._id }, { $set: { status: "ACTIVE" } }))
      .rejects.toThrow(/cannot be changed by an update query/);
    await expect(SupplierOffer.replaceOne({ _id: id }, { companyName: "gone" }))
      .rejects.toThrow(/cannot be replaced/);

    /* A persisted offer is evidence: a costing may have been priced from it
       and frozen the reference. Deleting it leaves that version pointing at
       nothing. Withdrawal is what exists for this, and it keeps the reason. */
    await expect(SupplierOffer.deleteOne({ _id: id })).rejects.toThrow(/cannot be deleted/);
    await expect(SupplierOffer.deleteMany({ companyId: w.co._id })).rejects.toThrow(/cannot be deleted/);
    await expect(SupplierOffer.findOneAndDelete({ _id: id })).rejects.toThrow(/cannot be deleted/);
    await expect(SupplierOffer.findByIdAndDelete(id)).rejects.toThrow(/cannot be deleted/);

    const doc = await SupplierOffer.findById(id);
    await expect(doc.deleteOne()).rejects.toThrow(/cannot be deleted/);

    expect(await SupplierOffer.countDocuments({ _id: id })).toBe(1);
  });

  test("the three named lifecycle transitions still work end to end", async () => {
    /* The guard would be worthless if it also blocked the operations the
       register exists to perform, so each is exercised through its own route. */
    const w = await world("Lifecycle");

    // DRAFT → ACTIVE
    const made = await create(w);
    expect(made.status).toBe(201);
    const on = await publish(w, made.body.offer.id);
    expect(on.status).toBe(200);
    expect(on.body.offer.status).toBe("ACTIVE");
    expect(on.body.offer.updatedByName).toBeTruthy();

    // ACTIVE → SUPERSEDED, as its revision is created
    const revised = await at(`/${on.body.offer.id}/revise`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: body_(w, { unitPriceMinor: 39000, quotationReference: "Q-119" }),
    });
    expect(revised.status).toBe(201);
    expect(revised.body.supersededOffer.status).toBe("SUPERSEDED");
    expect(revised.body.offer.revision).toBe(2);
    /* The superseded record keeps the price somebody was quoted. */
    expect(revised.body.supersededOffer.price.quotedMinor).toBe(41250);

    // ACTIVE → WITHDRAWN
    const gone = await at(`/${revised.body.offer.id}/withdraw`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier pulled the price." },
    });
    expect(gone.status).toBe(200);
    expect(gone.body.offer.status).toBe("WITHDRAWN");
    expect(gone.body.offer.withdrawalReason).toBe("Supplier pulled the price.");
  });

  test("a lifecycle transition cannot smuggle a price change alongside it", async () => {
    /* The narrowest part of the door: each transition names the fields it may
       write, so a withdrawal cannot carry a new rate in with the reason. */
    const w = await world("NoSmuggle");
    const offer = await live(w, { unitPriceMinor: 41250 });

    const doc = await SupplierOffer.findById(offer.id);
    doc.status = "WITHDRAWN";
    doc.withdrawnAt = new Date();
    doc.withdrawalReason = "Also, a new price.";
    doc.unitPriceMinor = 1;
    await expect(SupplierOffer.beginOfferLifecycle(doc, "WITHDRAW").save())
      .rejects.toThrow(/unitPriceMinor/);

    expect((await SupplierOffer.findById(offer.id).lean()).unitPriceMinor).toBe(41250);
  });

  test("the token is spent on one save and does not carry to the next", async () => {
    const w = await world("OneShot");
    const offer = await live(w);

    const doc = await SupplierOffer.findById(offer.id);
    doc.status = "WITHDRAWN";
    doc.withdrawnAt = new Date();
    doc.withdrawalReason = "Pulled.";
    await SupplierOffer.beginOfferLifecycle(doc, "WITHDRAW").save();

    /* A token that survived its save would leave the door open for whatever
       the same request did next. */
    doc.unitPriceMinor = 1;
    await expect(doc.save()).rejects.toThrow(/cannot be edited once it exists/);
  });
});

/* ═══ N · WHERE THE GOODS COME FROM, THROUGH THE REAL DOOR ═══════════════ */

describe("recording sourcing on a quotation", () => {
  /* ── WHY THIS SECTION EXISTS ────────────────────────────────────────────
     Nothing here sent `sourcing` through the route, so the branch that stores
     it had never once run in a test. It threw a ReferenceError on its own
     first line — the `text()` helper it calls was declared two hundred lines
     BELOW it, so a `const` in its temporal dead zone answered 500 to every
     quotation that recorded where the goods came from. Store would have hit
     it the first time somebody classified an import.

     Costing blocks on the absence of these facts, which makes the door that
     records them load-bearing: a blocker nobody can clear is worse than no
     blocker at all. */

  test("a domestic supply is recorded, with its evidence note", async () => {
    const w = await world("Src-A");
    const made = await create(w, {
      sourcing: { type: "DOMESTIC", evidenceNote: "Mill at Erode, delivered ex-works." },
    });
    expect(made.status).toBe(201);
    const doc = await SupplierOffer.findById(made.body.offer.id).lean();
    expect(doc.sourcing.type).toBe("DOMESTIC");
    expect(doc.sourcing.evidenceNote).toMatch(/Erode/);
    /* No country against a domestic supply: its origin is India by definition,
       and a second answer to a settled fact is contradictable. */
    expect(doc.sourcing.countryOfOrigin).toBeUndefined();
  });

  test("an import records its origin and whether the rate already carries the duty", async () => {
    const w = await world("Src-B");
    const made = await create(w, {
      sourcing: { type: "IMPORTED", countryOfOrigin: "cn", dutyInQuotedRate: "excluded" },
    });
    expect(made.status).toBe(201);
    const doc = await SupplierOffer.findById(made.body.offer.id).lean();
    expect(doc.sourcing.countryOfOrigin).toBe("CN");
    expect(doc.sourcing.dutyInQuotedRate).toBe("EXCLUDED");
  });

  test("an import with no country of origin is refused, not stored half-recorded", async () => {
    const w = await world("Src-C");
    const r = await create(w, { sourcing: { type: "IMPORTED" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("sourcing.countryOfOrigin");
  });

  test("an unknown country is refused rather than kept as free text", async () => {
    const w = await world("Src-D");
    const r = await create(w, { sourcing: { type: "IMPORTED", countryOfOrigin: "ZZ" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("sourcing.countryOfOrigin");
  });

  test("a duty-inclusion answer that is neither included nor excluded is refused", async () => {
    const w = await world("Src-E");
    const r = await create(w, {
      sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "MAYBE" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("sourcing.dutyInQuotedRate");
  });

  test("and a domestic supply cannot answer it at all", async () => {
    /* Refused rather than quietly dropped. Goods that never cross a border
       have no duty for a rate to include, and storing an answer to a question
       that does not apply would let a later reader conclude they were
       imported. */
    const w = await world("Src-F");
    const r = await create(w, {
      sourcing: { type: "DOMESTIC", dutyInQuotedRate: "INCLUDED" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("sourcing.dutyInQuotedRate");
  });

  test("an unstated sourcing writes no sub-document — silence is not domestic", async () => {
    const w = await world("Src-G");
    const made = await create(w, {});
    expect(made.status).toBe(201);
    const doc = await SupplierOffer.findById(made.body.offer.id).lean();
    expect(doc.sourcing?.type).toBeUndefined();
  });
});
