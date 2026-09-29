// test/costing/costing-freight.test.js
//
// GETTING THE FINISHED ORDER TO THE CUSTOMER.
//
// ── THE DISTINCTION THIS SUITE DEFENDS ──────────────────────────────────────
// Freight paid to bring fabric INTO our warehouse is part of what the fabric
// cost and belongs in its rate. Freight paid to take garments OUT to the
// customer is a cost of the order. They are different money, owed to different
// people, and adding one to the other either double-counts the inbound leg or
// invents an outbound one. Only the outbound leg is priced here.
//
// ── AND A RECORDED ZERO IS NOT A MISSING COST ───────────────────────────────
// An ex-works order costs the company nothing to deliver, because the customer
// collects it. That is an ANSWER, with an arrangement and a source behind it.
// A costing with no freight line because nobody asked is a different state, and
// the completeness model has to tell them apart.
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
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CRMAddress = require("../../models/CMS_Models/Sales/Address");
const Account = require("../../models/CMS_Models/Sales/Account");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const FreightOffer = require("../../models/CMS_Models/Inventory/Sourcing/FreightOffer");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");

const freight = require("../../services/centralCosting/freight.service");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const { approvePackingFacts, seedSourceBacked, configureProduction, approveGstPolicy, prepareForCosting, assembleForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

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
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* ── AND THE GST TREATMENT IS NOT HERE ANY MORE ─────────────────────
     It is an approved Board decision, so the costing policy refuses the field
     outright. `configureProduction` approves the fixture's — RECOVERABLE, the
     same value this used to write, so every figure below is unchanged. The
     one test that needs the other answer approves its own. */
};

const THREE = [
  { key: "q100", label: "100", quantity: "100", isPrimary: true },
  { key: "q500", label: "500", quantity: "500" },
  { key: "q1000", label: "1000", quantity: "1000" },
];
const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

const newKey = () => `f-${++seq}-${Math.random().toString(36).slice(2)}`;

async function company(name = "Freight") {
  const co = await Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const n = ++seq;
  const email = `frt-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `FR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
  expect((await call("/policy/current", { method: "PUT", token, company: co._id, body: { ...POLICY, revision: 0 } })).status).toBe(200);
  return { co, token, emp };
}

/** A dispatch warehouse, a transporter, and a delivery address on the account. */
async function lane(w, { accountId, over = {} } = {}) {
  const origin = await Warehouse.create({
    companyId: w.co._id, name: `Ludhiana Unit ${++seq}`, shortName: `LDH${seq}`,
    status: "Active", addressDetail: { city: "Ludhiana", state: "Punjab", country: "India" },
  });
  const transporter = await Vendor.create({
    companyId: w.co._id, companyName: `Northern Carriers ${seq}`, vendorType: "Transporter", status: "Active",
  });
  const destination = await CRMAddress.create({
    accountId, addressType: "shipping", isPrimaryForType: true, isActive: true,
    recipient: "Warehouse gate 3", addressLine1: "Plot 42, Peenya",
    city: "Bengaluru", region: "Karnataka", country: "India", postalCode: "560058",
  });
  /* A BILLING address too, deliberately: the two must never be interchangeable
     and a test with only one cannot prove that. */
  const billing = await CRMAddress.create({
    accountId, addressType: "billing", isPrimaryForType: true, isActive: true,
    recipient: "Accounts", addressLine1: "12 MG Road",
    city: "Mumbai", region: "Maharashtra", country: "India",
  });
  return { origin, transporter, destination, billing, ...over };
}

async function offerFor(w, { origin, transporter, destination = null, over = {} }) {
  const doc = await FreightOffer.create({
    companyId: w.co._id,
    supplierId: transporter._id, supplierName: transporter.companyName,
    originWarehouseId: origin._id, originName: origin.name,
    ...(destination ? { destinationAddressId: destination._id } : {}),
    destinationZone: destination ? { city: "", region: "", country: "" } : { region: "Karnataka", country: "India" },
    destinationLabel: destination ? "Bengaluru" : "Karnataka",
    mode: "ROAD", basis: "FIXED_PER_CONSIGNMENT",
    rateMinor: 1200000, currency: "INR", priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18,
    quotationReference: `TR-${++seq}`, status: "ACTIVE",
    effectiveFrom: new Date("2026-01-01"),
    ...over,
  });
  return doc;
}

/**
 * A costing whose enquiry carries the delivery terms under test.
 *
 * `shipment` is the sample's own packed weight and carton capacity — the two
 * facts a per-kg or per-carton rate needs, and which nothing in this system
 * recorded before this chunk.
 */
async function world({
  arrangement = "delivered", shipment = null, enquiryFreight = {}, accountFreight = null,
  inputGstTreatment = null,
} = {}) {
  const w = await company();
  /* Before `configureProduction`, which approves the RECOVERABLE default only
     where the company has no GST policy at all. */
  if (inputGstTreatment) await approveGstPolicy(w.co._id, { inputGstTreatment });
  /* A real material line, so a costing exists even when freight produces
     none — the "nobody has said" case would otherwise fail for having no
     lines at all, which is a different refusal. */
  const seeded = await seedSourceBacked(w.co._id, { freight: null });
  await configureProduction(w.co._id);

  const account = await Account.create({
    /* Owned, because an account with no company is legacy and is refused
       everywhere ownership could be ambiguous — which a test database with
       many companies always is. */
    companyId: w.co._id,
    companyName: `Buyer ${++seq}`, status: "active",
    ...(accountFreight ? { freightArrangement: accountFreight } : {}),
  });
  await Enquiry.updateOne({ _id: seeded.enquiry._id }, { $set: { accountId: account._id } });

  const built = await lane(w, { accountId: account._id });
  /* ── THE APPROVED FACTS, NOT THE WORKING NOTE ────────────────────────
     This wrote `sample.shipment`, which is R&D's unversioned working record.
     A costing reads an APPROVED weighing (R&D's) and an APPROVED pack-out
     (Merchandising's), so the fixture approves whichever the test states and
     leaves the other absent — which is how these tests ask for the gap. */
  if (shipment) {
    await approvePackingFacts(seeded.style._id, {
      packedWeightGrams: shipment.packedWeightGrams ?? null,
      garmentsPerCarton: shipment.garmentsPerCarton ?? null,
    });
  }

  const terms = {
    ...(arrangement ? { arrangement } : {}),
    mode: "ROAD",
    shippingAddressId: built.destination._id,
    originWarehouseId: built.origin._id,
    ...enquiryFreight,
  };
  await Enquiry.updateOne({ _id: seeded.enquiry._id }, { $set: { freight: terms } });

  const made = await call("/", {
    method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { ...w, seeded, account, ...built, costingId: made.body.costing.id };
}

/* ── THE RUN SIZES ARE THE SALES COSTING BRIEF'S ───────────────────────────
 * They travelled on this body. What quantities the customer wants priced is a
 * commercial decision Sales confirms on the enquiry, and the costing reads it
 * — so `calc` writes them where Sales writes them and posts only the lines.
 * Every test below keeps its own quantities and its own intent; what changed
 * is the record they are stated in. */
const writeBriefQuantities = async (w, scenarios) => {
  const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = (scenarios || []).map((sc, i) => ({
    key: String(sc.key || `q${i + 1}`),
    label: String(sc.label || sc.key || `q${i + 1}`),
    quantity: String(sc.quantity),
    isPrimary: sc.isPrimary === true || (scenarios.length === 1 && i === 0),
    ...(sc.proposedSellingPriceExclTax
      ? {
        proposedSellingPriceExclTax: String(
          sc.proposedSellingPriceExclTax.amountMinor !== undefined
            ? Number(sc.proposedSellingPriceExclTax.amountMinor) / 100
            : sc.proposedSellingPriceExclTax,
        ),
      }
      : {}),
  }));
  if (!enquiry.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    enquiry.costingBriefs[0].quantities[0].isPrimary = true;
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
};

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, which is unchanged — the orchestration resolves the brief and
   the sources and calls it. A call carrying a BODY still goes to the retired
   door on purpose: those tests are about the payload contract, and its
   refusal is the contract now. */
const calc = async (x, scenarios = ONE, body = {}) => {
  await writeBriefQuantities(x, scenarios);
  if (Object.keys(body).length) {
    return call(`/${x.costingId}/versions`, {
      method: "POST", token: x.token, company: x.co._id, idempotencyKey: newKey(),
      body: { lines: [], ...body },
    });
  }
  return prepareForCosting(x.costingId);
};
const preview = (x) => call(`/${x.costingId}/technical-preview`, { token: x.token, company: x.co._id });

const scenarioOf = (v, key) => v.cost.scenarios.find((s) => s.key === key);
const freightIn = (v, key) => scenarioOf(v, key).categorySubtotals.find((c) => c.category === "FREIGHT");
const familyOf = (v, key) => (v.cost.completeness?.families || []).find((f) => f.key === key);

/* ═══ 1 · WHO BEARS IT ════════════════════════════════════════════════════ */

describe("the delivery arrangement decides whether there is a cost at all", () => {
  test("ex-works is a recorded zero, and the costing is complete", async () => {
    /* ── AN ANSWER OF NIL ─────────────────────────────────────────────
       The customer collects. That costs the company nothing to deliver —
       which is a result somebody produced, not a gap somebody left. */
    const x = await world({ arrangement: "ex_works" });
    const r = await calc(x);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    expect(freightIn(v, "q500").totalMinor).toBe(0);
    expect(familyOf(v, "freight").state).toBe("RECORDED_ZERO");
    /* Not "needs input", and not absent — the distinction this family turns
       on. */
    expect(v.cost.completeness.families.map((f) => f.key)).toContain("freight");
    expect((v.cost.completeness.families.find((f) => f.key === "freight")).totalMinor).toBe(0);

    const p = v.cost.freightProvenance;
    expect(p.state).toBe("RECORDED_ZERO");
    expect(p.arrangement).toBe("ex_works");
    /* And where that arrangement came from, because "agreed on this order"
       and "the customer's usual term" are different claims. */
    expect(p.arrangementSource).toBe("ENQUIRY");
  });

  test("to-pay is a recorded zero too — the customer pays the carrier", async () => {
    const x = await world({ arrangement: "to_pay" });
    const v = (await calc(x)).body.versions[0];
    expect(freightIn(v, "q500").totalMinor).toBe(0);
    expect(familyOf(v, "freight").state).toBe("RECORDED_ZERO");
    expect(v.cost.freightProvenance.arrangement).toBe("to_pay");
  });

  test("the customer's standing term is not applied to an enquiry nobody answered", async () => {
    /* ── IT USED TO BE READ LIVE, AND THAT WAS THE BUG ─────────────────
       The costing loaded `Account.freightArrangement` and fell back to it, so
       editing the customer's standing term in November changed the
       arrangement an existing draft had been built on — retrospectively, with
       nothing recorded to say so. The account's terms are now offered to
       Sales on the enquiry and copied when saved; an enquiry nobody answered
       is unanswered, and the costing names Sales rather than borrowing a term
       nobody applied to this order. */
    const standing = await world({ arrangement: null, accountFreight: "ex_works" });
    const unanswered = (await calc(standing)).body.versions[0];
    expect(unanswered.cost.freightProvenance).toBeUndefined();
    expect(familyOf(unanswered, "freight").state).toBe("NEEDS_INPUT");
  });

  test("the record says whether the terms are the customer's usual ones or this deal's", async () => {
    /* Applying the customer's usual terms and agreeing something for this
       order are different claims, and the costing freezes which was made. */
    const applied = await world({
      arrangement: "ex_works", accountFreight: "ex_works", enquiryFreight: { source: "ACCOUNT" },
    });
    const fromAccount = (await calc(applied)).body.versions[0];
    expect(fromAccount.cost.freightProvenance.arrangement).toBe("ex_works");
    expect(fromAccount.cost.freightProvenance.arrangementSource).toBe("ACCOUNT");

    const asked = await world({
      arrangement: "to_pay", accountFreight: "ex_works", enquiryFreight: { source: "ENQUIRY" },
    });
    const fromEnquiry = (await calc(asked)).body.versions[0];
    expect(fromEnquiry.cost.freightProvenance.arrangement).toBe("to_pay");
    expect(fromEnquiry.cost.freightProvenance.arrangementSource).toBe("ENQUIRY");
  });

  test("a later change to the customer's standing terms cannot restate a saved enquiry", async () => {
    const x = await world({
      arrangement: "to_pay", accountFreight: "to_pay", enquiryFreight: { source: "ACCOUNT" },
    });
    /* The customer renegotiates: everything they ship from now on is
       delivered. The order already agreed stays as it was agreed. */
    await Account.updateOne({ _id: x.seeded.accountId || undefined }, { $set: { freightArrangement: "delivered" } });
    await Account.updateMany({}, { $set: { freightArrangement: "delivered" } });
    const after = (await calc(x)).body.versions[0];
    expect(after.cost.freightProvenance.arrangement).toBe("to_pay");
  });

  test("prepaid is a commercial decision nobody in this codebase has made", async () => {
    /* ── THE CODES CANNOT ANSWER IT ───────────────────────────────────
       "Prepaid (we pay)" says the company pays the carrier. `delivered` is
       separately labelled "included in price". So prepaid does NOT say
       whether the money is recovered — and the two readings differ by the
       whole freight amount in the garment cost. */
    const x = await world({ arrangement: "prepaid" });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.message).toMatch(/inside the quoted price or recovered from the customer separately/);

    /* Answered, it proceeds. */
    await Enquiry.updateOne({ _id: x.seeded.enquiry._id }, { $set: { "freight.prepaidTreatment": "IN_PRICE" } });
    const second = await calc(x);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/No freight quotation covers/);
  });

  test("an unanswered arrangement is not a zero — the family needs input", async () => {
    /* Nothing yet says freight is owed at all. The draft calculates; the
       costing is not complete, and it names Sales. */
    const x = await world({ arrangement: null });
    const r = await calc(x);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(familyOf(v, "freight").state).toBe("NEEDS_INPUT");
    /* No line, and certainly not a zero one — a zero would be an answer
       nobody gave. */
    expect(v.cost.inputs.some((l) => l.category === "FREIGHT")).toBe(false);
    expect(v.cost.freightProvenance).toBeUndefined();
  });
});

/* ═══ 2 · WHAT A DELIVERED ORDER NEEDS ════════════════════════════════════ */

describe("a delivered order blocks until it can be priced", () => {
  test("no destination blocks, names Sales, and never falls back to the billing address", async () => {
    /* ── THE SUBSTITUTION THAT MUST NOT HAPPEN ────────────────────────
       `CRMAddress` keeps billing and shipping apart precisely because they
       differ. Delivering to the accounts department is worse than saying
       nothing. */
    const x = await world({ enquiryFreight: { shippingAddressId: null } });
    await Enquiry.updateOne({ _id: x.seeded.enquiry._id }, { $unset: { "freight.shippingAddressId": "" } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.message).toMatch(/billing address is not used as a destination/);
    /* The billing address exists and was not used. */
    expect(JSON.stringify(r.body)).not.toContain("Mumbai");
  });

  test("no origin blocks and names Store administration", async () => {
    const x = await world();
    await Enquiry.updateOne({ _id: x.seeded.enquiry._id }, { $unset: { "freight.originWarehouseId": "" } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Store administration");
  });

  test("no applicable quotation blocks and names Store / Purchase", async () => {
    const x = await world();
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Store / Purchase");
    expect(r.body.error.message).toMatch(/No freight quotation covers/);
    expect(await CostingVersion.countDocuments({ costingId: x.costingId })).toBe(1);
  });

  test("a per-kg rate with no packed weight blocks and names R&D", async () => {
    /* A garment of no weight would ship for nothing. */
    const x = await world();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_KG", rateMinor: 3500 } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("R&D");
    expect(r.body.error.message).toMatch(/records no packed weight/);
  });

  test("a per-carton rate with no carton capacity blocks and names R&D", async () => {
    const x = await world();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_CARTON", rateMinor: 120000 } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("R&D");
    expect(r.body.error.message).toMatch(/how many garments a carton holds/);
  });
});

/* ═══ 3 · CHOOSING AMONG CARRIERS ═════════════════════════════════════════ */

describe("which quotation prices it", () => {
  test("withdrawn, superseded, future and expired quotations are all excluded", async () => {
    const x = await world();
    for (const over of [
      { status: "WITHDRAWN" },
      { status: "SUPERSEDED" },
      { status: "DRAFT" },
      { effectiveFrom: new Date("2099-01-01") },
      { validUntil: new Date("2020-01-01") },
    ]) {
      await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination, over });
    }
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No freight quotation covers/);
  });

  test("another company's transporter, lane and quotation are all invisible", async () => {
    const x = await world();
    const other = await company("Foreign");
    const theirOrigin = await Warehouse.create({
      companyId: other.co._id, name: "Foreign Depot", shortName: "FGN", status: "Active",
    });
    const theirCarrier = await Vendor.create({
      companyId: other.co._id, companyName: "Foreign Freight", vendorType: "Transporter", status: "Active",
    });
    /* Same destination, same mode — and a different company. */
    await FreightOffer.create({
      companyId: other.co._id, supplierId: theirCarrier._id, supplierName: theirCarrier.companyName,
      originWarehouseId: x.origin._id, originName: x.origin.name,
      destinationAddressId: x.destination._id, destinationLabel: "Bengaluru",
      mode: "ROAD", basis: "FIXED_PER_CONSIGNMENT", rateMinor: 1, currency: "INR",
      priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18, status: "ACTIVE",
      effectiveFrom: new Date("2026-01-01"), quotationReference: "FOREIGN-1",
    });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).not.toContain("Foreign Freight");
    expect(theirOrigin._id).toBeTruthy();
  });

  test("several applicable quotations are a decision, and the cheapest is not chosen", async () => {
    /* Transit time, claims history and who actually has capacity are not in
       this database. Picking on price would be a sourcing decision made with
       none of the information the person making it has. */
    const x = await world();
    const cheap = await Vendor.create({
      companyId: x.co._id, companyName: "Budget Movers", vendorType: "Transporter", status: "Active",
    });
    const dear = await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    await offerFor(x, { origin: x.origin, transporter: cheap, destination: x.destination, over: { rateMinor: 400000 } });

    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/2 freight quotations apply/);
  /* ── AND THE CANDIDATES ARE READ OFF THE ASSEMBLY, NOT OFF SALES ──────
     They used to arrive on the route's refusal. They do not arrive on Sales'
     any more, and deliberately: a candidate quotation names its supplier and
     its rate, and the narrow projection exists so that neither reaches a
     Sales response. The claim is unchanged and it is the engine's — so it is
     asserted where the data lives, and acted on by a buyer in Store. */
    const gap = (await assembleForCosting(x.costingId)).missing
      .find((m) => /freight quotations apply/.test(m.message));
    expect(gap.candidates).toHaveLength(2);
    expect(gap.candidates.some((c) => c.selected)).toBe(false);

    /* ── AND NAMING ONE IS A STORE ACT ────────────────────────────────
       A lane with two carriers is a sourcing decision like any other —
       transit time, claims history and who actually has capacity are not in
       a rate — so it is recorded in Store against the requirement and the
       costing reads it. The DEARER carrier being honoured over the cheaper
       one, which is what this test was really about, is asserted on that
       path in `sourcing-decisions.route.test.js`.

       The calculation refuses to be told. */
    const chosen = await calc(x, ONE, { quotationChoices: { "freight:outbound": String(dear._id) } });
    /* Refused at the door — the route reads no body at all now. The parser's
       own refusal, which names Store, is asserted directly so the rule keeps
       a test even with no route that can carry a choice to it. */
    expect(chosen.status).toBe(409);
    expect(chosen.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try {
      refuseQuotationChoices({ quotationChoices: { "freight:outbound": String(dear._id) } });
    } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
    expect(told.details.owner.department).toBe("Store");
  });

  test("a zone quotation covers an address inside it; an address outside it is not covered", async () => {
    const x = await world();
    /* "Anywhere in Karnataka" — a real way transporters quote, and one that
       cannot be expressed as a single address. */
    await offerFor(x, { origin: x.origin, transporter: x.transporter });
    expect((await calc(x)).status).toBe(201);

    const elsewhere = await world();
    await CRMAddress.updateOne({ _id: elsewhere.destination._id }, { $set: { region: "Tamil Nadu" } });
    await offerFor(elsewhere, { origin: elsewhere.origin, transporter: elsewhere.transporter });
    const r = await calc(elsewhere);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No freight quotation covers/);
  });
});

/* ═══ 4 · THE ARITHMETIC ══════════════════════════════════════════════════ */

describe("what each scenario is charged", () => {
  test("a fixed consignment charge is the same money, diluted across the run", async () => {
    const x = await world();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const v = (await calc(x, THREE)).body.versions[0];

    for (const key of ["q100", "q500", "q1000"]) {
      expect(freightIn(v, key).totalMinor).toBe(1200000);
    }
    /* ₹120 a garment at 100, ₹24 at 500, ₹12 at 1,000. */
    expect(freightIn(v, "q100").perUnitMinor).toBe(12000);
    expect(freightIn(v, "q500").perUnitMinor).toBe(2400);
    expect(freightIn(v, "q1000").perUnitMinor).toBe(1200);
  });

  test("a per-kg rate uses the scenario quantity and the packed weight", async () => {
    /* 500 garments at 420 g is 210 kg; at ₹35 a kg that is ₹7,350. */
    const x = await world({ shipment: { packedWeightGrams: 420 } });
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_KG", rateMinor: 3500 } });
    const v = (await calc(x, THREE)).body.versions[0];

    expect(freightIn(v, "q100").totalMinor).toBe(147000);
    expect(freightIn(v, "q500").totalMinor).toBe(735000);
    expect(freightIn(v, "q1000").totalMinor).toBe(1470000);
    /* It scales, so the per-garment figure does not move. */
    for (const key of ["q100", "q500", "q1000"]) {
      expect(freightIn(v, key).perUnitMinor).toBe(1470);
    }
    const sc = v.cost.freightProvenance.scenarios.find((s) => s.scenarioKey === "q500");
    expect(sc.working).toMatchObject({ garments: "500", packedWeightGrams: "420", chargeableKg: "210.000" });
  });

  test("a per-carton rate divides by capacity and rounds UP", async () => {
    /* ── A PART CARTON IS A CARTON ────────────────────────────────────
       100 garments at 40 a carton is 3 cartons, not 2.5 — the transporter
       charges for the third whether it is full or not. */
    const x = await world({ shipment: { garmentsPerCarton: 40 } });
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_CARTON", rateMinor: 120000 } });
    const v = (await calc(x, THREE)).body.versions[0];

    expect(freightIn(v, "q100").totalMinor).toBe(360000);   // 3 cartons
    expect(freightIn(v, "q500").totalMinor).toBe(1560000);  // 13 cartons
    expect(freightIn(v, "q1000").totalMinor).toBe(3000000); // 25 cartons
    /* It steps rather than scaling, which is exactly why a per-scenario run
       total exists at all. */
    const working = v.cost.freightProvenance.scenarios;
    expect(working.find((s) => s.scenarioKey === "q100").working.cartons).toBe("3");
    expect(working.find((s) => s.scenarioKey === "q500").working.cartons).toBe("13");
  });

  test("a minimum charge floors the consignment, not the rate", async () => {
    /* "₹35 a kg, minimum ₹4,000" means a 42 kg load is charged ₹4,000 and
       not ₹1,470. */
    const x = await world({ shipment: { packedWeightGrams: 420 } });
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_KG", rateMinor: 3500, minimumChargeMinor: 400000 } });
    const v = (await calc(x, THREE)).body.versions[0];

    /* 100 garments = 42 kg = ₹1,470 → floored to ₹4,000. */
    expect(freightIn(v, "q100").totalMinor).toBe(400000);
    /* 500 garments = 210 kg = ₹7,350 → above the floor, untouched. */
    expect(freightIn(v, "q500").totalMinor).toBe(735000);

    const at100 = v.cost.freightProvenance.scenarios.find((s) => s.scenarioKey === "q100");
    expect(at100.minimumChargeApplied).toBe(true);
    expect(at100.beforeMinimumMinor).toBe(147000);
    expect(v.cost.freightProvenance.scenarios.find((s) => s.scenarioKey === "q500").minimumChargeApplied).toBe(false);
  });

  test("a blank quantity is never read as one", async () => {
    /* Pure resolver: a garment count of nothing is not a garment. */
    const offer = { basis: "PER_CARTON", rateMinor: 120000, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18, offerId: "o" };
    const out = freight.priceScenario(offer, { quantity: "100", shipment: {}, gstTreatment: "RECOVERABLE" });
    expect(out.missing.code).toBe(freight.CODES.CARTON_MISSING);
  });

  test("a fixed consignment charge is not multiplied by an undeclared delivery count", async () => {
    /* Nothing here schedules deliveries, so how a one-consignment rate
       applies across three is a commercial question, not a multiplication. */
    const x = await world({ enquiryFreight: { deliveryCount: 3 } });
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.message).toMatch(/3 deliveries/);
  });
});

/* ═══ 5 · TAX ═════════════════════════════════════════════════════════════ */

describe("GST on freight", () => {
  test("recoverable GST is not garment cost; non-recoverable is", async () => {
    const recoverable = await world();
    await offerFor(recoverable, { origin: recoverable.origin, transporter: recoverable.transporter, destination: recoverable.destination });
    const a = (await calc(recoverable)).body.versions[0];
    /* The company reclaims it, so the garment carries the net ₹12,000. */
    expect(freightIn(a, "q500").totalMinor).toBe(1200000);
    expect(a.cost.freightProvenance.taxTreatment).toBe("RECOVERABLE");

    /* A company whose Board decided the other way. Approved BEFORE the world
       seeds — `configureProduction` approves the default only where the
       company has none, and two policies cannot be in force at once. */
    const absorbed = await world({ inputGstTreatment: "NON_RECOVERABLE" });
    await offerFor(absorbed, { origin: absorbed.origin, transporter: absorbed.transporter, destination: absorbed.destination });
    const b = (await calc(absorbed)).body.versions[0];
    /* ₹12,000 + 18% = ₹14,160, because the company cannot reclaim it. */
    expect(freightIn(b, "q500").totalMinor).toBe(1416000);
    expect(b.cost.freightProvenance.taxTreatment).toBe("NON_RECOVERABLE");
    /* The exclusive figure is still on the record beside the costed one. */
    expect(b.cost.freightProvenance.scenarios.find((s) => s.scenarioKey === "q500").freightMinor).toBe(1200000);
  });
});

/* ═══ 6 · PROVENANCE, AND WHAT MUST NOT MOVE ══════════════════════════════ */

describe("the frozen record", () => {
  test("it carries the whole working — lane, carrier, quotation and shipment", async () => {
    const x = await world({ shipment: { packedWeightGrams: 420, garmentsPerCarton: 40 } });
    const offer = await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_CARTON", rateMinor: 120000, minimumChargeMinor: 100000 } });
    const v = (await calc(x, THREE)).body.versions[0];
    const p = v.cost.freightProvenance;

    expect(p).toMatchObject({
      state: "SUPPLIER_QUOTATION",
      arrangement: "delivered",
      arrangementSource: "ENQUIRY",
      mode: "ROAD",
      basis: "PER_CARTON",
      rateMinor: 120000,
      currency: "INR",
      minimumChargeMinor: 100000,
      taxTreatment: "RECOVERABLE",
      gstRatePercent: 18,
      packedWeightGrams: 420,
      garmentsPerCarton: 40,
    });
    /* Identity AND snapshot at both ends of the lane: the id so it can be
       found again, the words so it stays readable when a record is renamed. */
    expect(p.origin).toMatchObject({ warehouseId: String(x.origin._id), city: "Ludhiana" });
    expect(p.destination).toMatchObject({ addressId: String(x.destination._id), city: "Bengaluru", region: "Karnataka" });
    expect(p.supplierId).toBe(String(x.transporter._id));
    expect(p.supplierName).toMatch(/^Northern Carriers/);
    expect(p.offerId).toBe(String(offer._id));
    expect(p.quotationReference).toMatch(/^TR-/);
    expect(p.effectiveFrom).toBeTruthy();
    expect(p.asOf).toBeTruthy();
    /* One working per scenario. */
    expect(p.scenarios.map((s) => s.scenarioKey)).toEqual(["q100", "q500", "q1000"]);
    expect(p.scenarios[0]).toMatchObject({ quantity: "100", chargeableUnit: "carton", chargeable: "3" });
  });

  test("withdrawing the quotation afterwards does not re-price the frozen version", async () => {
    const x = await world();
    const offer = await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const first = await calc(x, THREE);
    expect(first.status).toBe(201);
    const versionId = first.body.versions[0].id;

    const doc = await FreightOffer.findById(offer._id);
    doc.status = "WITHDRAWN";
    doc.withdrawalReason = "Carrier left the lane.";
    await FreightOffer.beginFreightOfferLifecycle(doc, "WITHDRAW").save();

    const reread = await call(`/${x.costingId}/versions`, { token: x.token, company: x.co._id });
    const after = reread.body.versions.find((y) => y.id === versionId);
    expect(freightIn(after, "q100").totalMinor).toBe(1200000);
    expect(after.cost.freightProvenance.quotationReference).toMatch(/^TR-/);

    /* And the NEXT costing is blocked rather than quietly using it again. */
    expect((await calc(x, THREE)).status).toBe(409);
  });
});

/* ═══ 7 · THE ESCAPE THAT IS CLOSED ═══════════════════════════════════════ */

describe("freight cannot be typed", () => {
  test("a declared override for freight is refused, and says where the answer comes from", async () => {
    /* ── THE REFUSAL WIDENED, AND KEPT ITS ADDRESS ────────────────────
       This asserted `OVERRIDE_FAMILY_HAS_A_SOURCE` — a refusal `mergeOverrides`
       raised for freight ALONE, once freight acquired a source of its own
       while other families still had none.

       Every family has a source now bar customs duty, so the special case
       became the general rule and the freight-specific code went with the
       merger that raised it. What this suite cares about survives intact: the
       figure is refused, and the refusal says where the answer comes from
       rather than leaving somebody holding a number. */
    const x = await world({ arrangement: "ex_works" });
    const r = await calc(x, ONE, {
      lines: [{
        lineKey: "carriage", category: "FREIGHT", behaviour: "FIXED_PER_RUN",
        label: "Transport", amount: { amountMinor: 500000, currency: "INR" },
        override: { family: "freight", reason: "Quoted over the phone" },
      }],
    });
    /* ── AND NOW IT IS REFUSED ONE STEP EARLIER ───────────────────────
       The route no longer reads the body: it refuses a browser client
       outright, because preparing an estimate is a Sales action. The typed
       figure never reaches the parser that used to name the family — which
       is a stronger answer to "can somebody type a freight cost", not a
       weaker one. The parser's own refusal is asserted directly below, so
       the rule keeps a test even with no route that can reach it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(r.body.error.details.owner.department).toBe("Sales");

    const { parseLine } = require("../../services/centralCosting/calculationInput");
    let refused = null;
    try {
      parseLine({
        lineKey: "carriage", category: "FREIGHT", behaviour: "FIXED_PER_RUN",
        label: "Transport", amount: { amountMinor: 500000, currency: "INR" },
        override: { family: "freight", reason: "Quoted over the phone" },
      }, 0, "INR", new Set());
    } catch (err) { refused = err; }
    expect(refused.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(refused.details.reason).toBe("MANUAL_OVERRIDE_RETIRED");
    expect(refused.details.family).toBe("freight");
    /* Sales states who bears it, R&D measures what ships, Store quotes the
       lane — the three desks, named. */
    expect(refused.details.owner.department).toMatch(/Sales/);
    expect(refused.details.owner.recordedIn).toMatch(/freight quotations/i);
  });

  test("nothing anywhere can declare away a delivered order's freight", async () => {
    /* ── HOW THIS USED TO BE STOPPED, AND WHY IT NO LONGER NEEDS TO BE ──
       `applyFreight` caught a costing-side `{ key: "freight" }` on a
       DELIVERED order and refused it by name — somebody declaring away a cost
       the company had agreed to bear.

       There is nothing left to catch. The payload refuses an applicability
       decision outright, and `familyApplicability` gives freight NO owner at
       all: no record in the company can excuse this family. Sales' arrangement
       is the whole answer — the customer collects, and the zero is a line, or
       the company pays and it comes from a quotation. */
    const x = await world();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const r = await calc(x, ONE, {
      technicalAcknowledgements: [{ key: "freight", reason: "We will absorb it." }],
    });
    /* Refused at the door now — the route reads no body at all. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    /* And the parser still refuses it, named as unanswerable rather than
       merely relocated: a client told only "not here" would go looking for
       the other screen. Asserted directly, because no route carries a body
       to it any more. */
    const { refuseAcknowledgements } = require("../../services/centralCosting/calculationInput");
    let thrown = null;
    try {
      refuseAcknowledgements({ technicalAcknowledgements: [{ key: "freight", reason: "We will absorb it." }] });
    } catch (err) { thrown = err; }
    expect(thrown.code).toBe("COSTING_APPLICABILITY_DECISION_MOVED");
    expect(thrown.details.owners.freight.inherentlyRequired).toBe(true);
    expect(thrown.details.owners.freight.department).toBeNull();

    const coverage = require("../../services/centralCosting/costCoverage");
    const assessed = coverage.assess({
      scenario: {},
      sourceDecisions: { freight: { key: "freight", reason: "We will absorb it.", basis: "b" } },
    });
    /* Second layer: even handed one internally, the family stays open. */
    expect(assessed.families.find((f) => f.key === "freight").state).toBe("NEEDS_INPUT");
  });

  test("but an ex-works order needs no acknowledgement at all — the zero is the answer", async () => {
    const x = await world({ arrangement: "ex_works" });
    const v = (await calc(x)).body.versions[0];
    expect(familyOf(v, "freight").state).toBe("RECORDED_ZERO");
    expect(familyOf(v, "freight").reason).toBeNull();
  });
});

/* ═══ 8 · INBOUND IS SOMEBODY ELSE'S MONEY ════════════════════════════════ */

test("inbound freight on a material rate is not added again as outbound", async () => {
  /* ── THE DOUBLE COUNT THIS RULES OUT ──────────────────────────────────
     A landed material rate already contains the cost of getting the fabric
     here. The outbound family prices delivery of the FINISHED order and
     reads no purchase order, no landed-cost allocation and no material
     offer — so a landed rate cannot leak into it. */
  const x = await world({ arrangement: "ex_works" });
  const v = (await calc(x)).body.versions[0];
  expect(freightIn(v, "q500").totalMinor).toBe(0);

  /* And the freight service imports neither record. */
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../../services/centralCosting/freight.service"), "utf8")
    + fs.readFileSync(require.resolve("../../services/storePurchase/freightOfferRead.service"), "utf8");
  expect(src).not.toMatch(/require\([^)]*PurchaseOrder/);
  expect(src).not.toMatch(/require\([^)]*LandedCost/);
});

/* ═══ 9 · WHAT THE SCREEN IS GIVEN ════════════════════════════════════════ */

test("the preview shows the lane and the working, read-only", async () => {
  const x = await world();
  await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
  const p = await preview(x);
  expect(p.status).toBe(200);
  const row = (p.body.assembly.rows.freight || [])[0];
  expect(row).toBeTruthy();
  expect(row).toMatchObject({
    arrangement: "delivered",
    mode: "ROAD",
    basis: "FIXED_PER_CONSIGNMENT",
    state: "VERIFIED",
  });
  expect(row.origin).toMatch(/Ludhiana/);
  expect(row.destination).toMatch(/Bengaluru/);
  expect(row.supplierName).toMatch(/^Northern Carriers/);

  /* The family no longer sends anybody to type a figure. */
  const families = Object.fromEntries(p.body.assembly.coverage.families.map((f) => [f.key, f]));
  expect(families.freight.authority).toBe("AUTOMATIC");
  expect(families.freight.awaitingMessage).not.toMatch(/override/i);
});


/* ═══ 10 · THE DESTINATION BELONGS TO A COMPANY ═══════════════════════════ */

describe("a delivery address is resolved through a company-owned account", () => {
  test("another company's address does not resolve, and is not told apart from a missing one", async () => {
    /* ── THE LEAK THIS CLOSES ─────────────────────────────────────────
       The register loaded a destination by id alone, with no company
       anywhere in the query — so it would snapshot another company's
       customer, their delivery instructions and their city into this
       company's freight quotation. */
    const mine = await world({ arrangement: "ex_works" });
    const theirs = await world({ arrangement: "ex_works" });

    const { resolveShippingDestination, REASON } =
      require("../../services/centralCosting/shippingDestination.service");

    /* Their address, asked for under my company. */
    const foreign = await resolveShippingDestination(mine.co._id, { addressId: theirs.destination._id });
    expect(foreign.destination).toBeNull();
    expect(foreign.reason).toBe(REASON.NOT_FOUND);

    /* And one that does not exist at all gives the same answer — the caller
       cannot tell whether the record is elsewhere or nowhere. */
    const nowhere = await resolveShippingDestination(mine.co._id, { addressId: new mongoose.Types.ObjectId() });
    expect(nowhere.reason).toBe(REASON.NOT_FOUND);

    /* My own resolves, with the lane snapshotted from the RECORD. */
    const ours = await resolveShippingDestination(mine.co._id, { addressId: mine.destination._id });
    expect(ours.destination).toMatchObject({ city: "Bengaluru", region: "Karnataka" });
  });

  test("a billing address is refused as a destination, and says which type it is", async () => {
    /* Delivering garments to the accounts department is a mistake nobody
       notices until the lorry arrives. The type is required; nothing
       converts or falls back. */
    const x = await world({ arrangement: "ex_works" });
    const { resolveShippingDestination, REASON } =
      require("../../services/centralCosting/shippingDestination.service");
    const billing = await resolveShippingDestination(x.co._id, { addressId: x.billing._id });
    expect(billing.destination).toBeNull();
    /* Told apart only because this address IS this company's — the caller
       can already see it, and naming the type is the difference between a
       five-second fix and a mystery. */
    expect(billing.reason).toBe(REASON.NOT_SHIPPING);
    expect(billing.addressType).toBe("billing");
  });

  test("the costing re-checks the type, not only the save", async () => {
    /* The address could have been re-typed as billing since Sales chose it.
       A costing freezes a lane; it proves the lane at the moment it
       freezes it. */
    const x = await world();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    expect((await calc(x)).status).toBe(201);

    await CRMAddress.updateOne({ _id: x.destination._id }, { $set: { addressType: "billing" } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not a shipping address/);
    expect(r.body.error.details.owner.department).toBe("Sales");
  });
});

/* ═══ 11 · PREPAID: TWO ANSWERS, TWO OUTCOMES ═════════════════════════════ */

describe("prepaid freight, once the question is answered", () => {
  const prepaid = (treatment) => world({
    arrangement: "prepaid", enquiryFreight: { prepaidTreatment: treatment },
  });

  test("in-price freight raises the garment's selling price", async () => {
    const x = await prepaid("IN_PRICE");
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const r = await calc(x);
    expect(r.status).toBe(201);
    const s = scenarioOf(r.body.versions[0], "q500");

    /* An ordinary borne cost: it is in the total, in the priced cost, and in
       every price derived from it. */
    expect(freightIn(r.body.versions[0], "q500").totalMinor).toBe(1200000);
    expect(s.recoveredSeparatelyMinor).toBe(0);
    expect(s.pricedUnitCostMinor).toBe(s.unitCostMinor);
    expect(r.body.versions[0].cost.freightProvenance.recovery).toBe("COMPANY_BEARS");
    expect(r.body.versions[0].cost.freightProvenance.prepaidTreatment).toBe("IN_PRICE");
  });

  test("separately recovered freight does not inflate the garment's price, and is carried on its own", async () => {
    /* ── THE DIFFERENCE THE QUESTION EXISTS TO MAKE ───────────────────
       Both answers cost the company the same money. Only one of them is
       part of what the GARMENT is worth. Marking the other up would charge
       the customer a margin on their own reimbursement. */
    const x = await prepaid("RECOVERED_SEPARATELY");
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const r = await calc(x);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    const s = scenarioOf(v, "q500");

    /* Not zero: the money leaves. */
    expect(freightIn(v, "q500").totalMinor).toBe(1200000);
    expect(s.recoveredSeparatelyMinor).toBe(1200000);
    expect(s.recoveredSeparatelyPerUnitMinor).toBe(2400);
    /* And out of the price basis, exactly. */
    expect(s.pricedUnitCostMinor).toBe(s.unitCostMinor - 2400);

    /* Recorded at cost, with the rule on the record rather than inferred
       from two figures that happen to match. */
    expect(v.cost.freightProvenance.recovery).toBe("RECOVERED_SEPARATELY");
    expect(v.cost.freightProvenance.recoveryMarkup).toBe("AT_COST");
  });

  test("the same order prices differently under the two answers, and the carrier cost is traceable in both", async () => {
    const inPrice = await prepaid("IN_PRICE");
    await offerFor(inPrice, { origin: inPrice.origin, transporter: inPrice.transporter, destination: inPrice.destination });
    const a = scenarioOf((await calc(inPrice)).body.versions[0], "q500");

    const recovered = await prepaid("RECOVERED_SEPARATELY");
    await offerFor(recovered, { origin: recovered.origin, transporter: recovered.transporter, destination: recovered.destination });
    const bVersion = (await calc(recovered)).body.versions[0];
    const b = scenarioOf(bVersion, "q500");

    /* Same company cost. */
    expect(a.totalCostMinor).toBe(b.totalCostMinor);
    /* ── AND A DIFFERENT PRICED COST ──────────────────────────────
       The garment's price is derived from `pricedUnitCostMinor`, and the
       recovered freight is exactly what separates the two. */
    expect(a.pricedUnitCostMinor).toBe(a.unitCostMinor);
    expect(b.pricedUnitCostMinor).toBe(b.unitCostMinor - b.recoveredSeparatelyPerUnitMinor);
    expect(b.pricedUnitCostMinor).toBeLessThan(a.pricedUnitCostMinor);
    expect(a.pricedUnitCostMinor - b.pricedUnitCostMinor).toBe(2400);

    /* And in BOTH, the transporter, the reference and the rate are on the
       record. A cost that stops being priced does not stop being traceable. */
    for (const v of [(await calc(inPrice, ONE)).body.versions[0], bVersion]) {
      const p = v.cost.freightProvenance;
      expect(p.supplierName).toMatch(/^Northern Carriers/);
      expect(p.quotationReference).toMatch(/^TR-/);
      expect(p.rateMinor).toBe(1200000);
      expect(p.scenarios.length).toBeGreaterThan(0);
    }
  });

  test("a recovered order still needs a real quotation — it is not a zero", async () => {
    const x = await prepaid("RECOVERED_SEPARATELY");
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Store / Purchase");
  });
});

/* ═══ 12 · SPLITTING THE ORDER ════════════════════════════════════════════ */

describe("more than one delivery", () => {
  const split = (over = {}) => world({
    shipment: { packedWeightGrams: 420, garmentsPerCarton: 40 },
    enquiryFreight: { deliveryCount: 3 },
    ...over,
  });

  test("a fixed consignment charge blocks: it applies to each load", async () => {
    const x = await split();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.message).toMatch(/a fixed charge applies to each of the 3/);
  });

  test("a per-carton rate blocks: ceilings do not add up", async () => {
    /* ── THE COUNTEREXAMPLE ───────────────────────────────────────────
       500 garments at 40 a carton is 13 cartons in one load. Split evenly
       across three it is ⌈167/40⌉ × 3 = 5 × 3 = 15. An aggregate rounding
       is simply the wrong number, and which way it is wrong depends on a
       split nothing here records. */
    expect(Math.ceil(500 / 40)).toBe(13);
    expect(Math.ceil(167 / 40) * 3).toBe(15);

    const x = await split();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_CARTON", rateMinor: 120000 } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/cartons are rounded up per consignment/);
  });

  test("a minimum charge blocks: it applies to every consignment", async () => {
    /* 500 garments is 210 kg — ₹7,350 in one load, above a ₹4,000 floor.
       Three loads of 70 kg are ₹2,450 each, floored to ₹4,000 each: ₹12,000.
       Applying the minimum once understates it by ₹4,650. */
    const x = await split();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_KG", rateMinor: 3500, minimumChargeMinor: 400000 } });
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/a minimum charge, which applies to each of the 3/);
  });

  test("per-kg with no minimum is the one case a split cannot change", async () => {
    /* Linear in total weight, and total weight does not depend on how the
       weight is divided: 3 × 70 kg and 1 × 210 kg are the same 210 kg. */
    const x = await split();
    await offerFor(x, { origin: x.origin, transporter: x.transporter, destination: x.destination,
      over: { basis: "PER_KG", rateMinor: 3500 } });
    const r = await calc(x, THREE);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(freightIn(v, "q500").totalMinor).toBe(735000);
    /* Identical to the single-delivery answer, which is the point. */
    expect(v.cost.freightProvenance.deliveryCount).toBe(3);
  });
});

/* ═══ 13 · THE INBOUND LEG IS A DIFFERENT QUESTION ════════════════════════ */

describe("whether a material rate already included getting it here", () => {
  /* A world with a real material line, so there is a quotation to ask of. */
  const material = async (freightTerms) => {
    const w = await company();
    const seeded = await seedSourceBacked(w.co._id, { freight: null });
    await configureProduction(w.co._id);
    if (freightTerms === null) {
      await SupplierOffer.collection.updateOne(
        { _id: seeded.offer._id }, { $unset: { freightTerms: "" } },
      );
    } else {
      await SupplierOffer.collection.updateOne(
        { _id: seeded.offer._id }, { $set: { freightTerms } },
      );
    }
    await Enquiry.updateOne({ _id: seeded.enquiry._id }, { $set: { freight: { arrangement: "ex_works" } } });
    const made = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: { context: seeded.context },
    });
    return { ...w, seeded, costingId: made.body.costing.id };
  };

  test("a landed rate needs no inbound gap — the delivery is already in it", async () => {
    const x = await material("INCLUSIVE_LANDED");
    const r = await calc(x);
    expect(r.status).toBe(201);
    /* And the fact is frozen, so a reader can see the figure already
       contained the freight rather than having to ask. */
    const prov = (r.body.versions[0].cost.offerProvenance || [])
      .find((p) => p.lineKey === x.seeded.materialLineKey);
    expect(prov.freightTerms).toBe("INCLUSIVE_LANDED");
  });

  test("an excluded rate is an incomplete acquisition cost, owned by Store", async () => {
    const x = await material("EXCLUSIVE");
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/excludes delivery to our warehouse, so its landed cost is incomplete/);
    expect(r.body.error.details.owner.department).toMatch(/Store/);
  });

  test("an unrecorded term is an unanswered question, not a landed rate", async () => {
    /* Guessing either way is the same error in opposite directions. */
    const x = await material(null);
    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/does not say whether its rate includes delivery/);
  });

  test("an outbound quotation never resolves an inbound gap", async () => {
    /* ── DIFFERENT LANE, DIFFERENT CARRIER, DIFFERENT DIRECTION ───────
       Recording a transporter's rate for delivering the finished order says
       nothing about what it cost to bring the fabric in. */
    const x = await material("EXCLUSIVE");
    const origin = await Warehouse.create({
      companyId: x.co._id, name: "Ludhiana Unit", shortName: `LX${++seq}`, status: "Active",
    });
    const carrier = await Vendor.create({
      companyId: x.co._id, companyName: "Northern Carriers", vendorType: "Transporter", status: "Active",
    });
    await FreightOffer.create({
      companyId: x.co._id, supplierId: carrier._id, supplierName: carrier.companyName,
      originWarehouseId: origin._id, originName: origin.name,
      destinationZone: { region: "Karnataka", country: "India" }, destinationLabel: "Karnataka",
      mode: "ROAD", basis: "PER_KG", rateMinor: 3500, currency: "INR",
      priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18, status: "ACTIVE",
      effectiveFrom: new Date("2026-01-01"), quotationReference: "TR-OUT",
    });
    const r = await calc(x);
    expect(r.status).toBe(409);
    /* Still the inbound gap, unchanged. */
    expect(r.body.error.message).toMatch(/excludes delivery to our warehouse/);
  });

  test("and nothing reads a purchase order or a landed-cost allocation as a forecast", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../../services/centralCosting/freight.service"), "utf8")
      + fs.readFileSync(require.resolve("../../services/centralCosting/freightSource.service"), "utf8")
      + fs.readFileSync(require.resolve("../../services/storePurchase/freightOfferRead.service"), "utf8");
    expect(src).not.toMatch(/require\([^)]*PurchaseOrder/);
    expect(src).not.toMatch(/require\([^)]*LandedCost/);
  });
});
