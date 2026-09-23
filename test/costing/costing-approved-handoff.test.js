// test/costing/costing-approved-handoff.test.js
//
// Central Costing — THE APPROVED PRICE SALES MAY QUOTE.
//
// An approved costing version holds two very different things: what the garment
// is estimated to COST, and what the company decided to SELL it for. Sales needs
// the second and must never receive the first — a negotiator who can see the
// company's own margin negotiates against it, and a buyer who can see a
// supplier's quoted rate can work out the mill's.
//
// The claims that matter are the refusals. A quotation for 1,200 pieces against
// a costing approved at 1,000 gets no price, because fixed costs are diluted
// over the run and the per-garment figure at 1,200 is a number nobody approved.
// The currency is not converted. The join is an id and never a name. And the
// price is read from the version by the server, never accepted from the browser.
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
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy,
  EVERY_FAMILY, prepareForCosting } = require("./helpers/sourceBacked");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const approvedOutput = require("../../services/centralCosting/approvedOutput.service");

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

jest.setTimeout(180000);

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_handoff" });
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

const newKey = () => `hx-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/**
 * An actor. `grant: "sales"` gets exactly `costing.output.read` — the real
 * Sales grant from the capability table, not a hand-built one.
 */
async function actor({ companies = [], admin = false, grant = null } = {}) {
  const n = ++seq;
  const email = `hx-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "H", lastName: `L${n}`, email, biometricId: `HX${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (admin) {
    await DeptUser.create({
      name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role: "owner", isActive: true });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "H" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "H Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "20m" },
    ),
  };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* Overhead arrived as a typed OVERHEAD line in the old fixture. It is a
     company RULE and the engine applies it from here. */
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged. */
  revision: 0,
};

/* ── NO HAND-ENTERED FIGURE AT ALL ────────────────────────────────────────
   A source-backed costing assembles itself from the technical record, the
   supplier quotations and the policy. A typed figure is an override, and it
   says so on the version with the family it answers and a reason. These
   fixtures are not testing that rule — they need a costing that approves, so
   they honour it. */
/* ── EVERY FAMILY ANSWERED — BY A RECORD, NOT A TYPED ROW ─────────────
   `FULL_LINES` stood here: one hand-entered row per cost family, so the
   version could be approved at all (the Chunk 4C gate refuses review while a
   family is unaddressed). The comment above it conceded the point already —
   "these fixtures are not testing that rule, they need a costing that
   approves, so they honour it".

   Honouring it now means stating the records. `EVERY_FAMILY` seeds the
   requirement and the quotation behind packaging, outside services and
   development, and confirms the enquiry's payment terms; the Board approves
   the financing methodology; the policy carries overhead; and customs duty —
   the one family with no source in this repository — is answered by a
   decision with a reason rather than by a figure somebody guessed. */

const SCENARIOS = [
  { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
  { key: "q1000", label: "1000 pcs", quantity: "1000" },
];

const PRODUCT = "Oxford Shirt";

/**
 * A company with an approved costing for one style.
 *
 * `approve: false` leaves the version a draft, for the tests about what an
 * unapproved costing must not offer.
 */
async function world({ approve = true, scenarios = SCENARIOS, styleOver = {} } = {}) {
  const co = await company("Handoff");
  const me = await actor({ companies: [co], admin: true });
  const sales = await actor({ companies: [co], grant: "sales" });
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });

  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY,
    brief: { quantities: scenarios, quantityUom: "Pieces" },
  });
  await configureProduction(co._id);
  const { enquiry, journey, style } = seeded;
  const accountId = enquiry.accountId;
  if (Object.keys(styleOver).length) {
    await SampleStyle.updateOne({ _id: style._id }, { $set: styleOver });
    Object.assign(style, styleOver);
  }

  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  const costingId = made.body.costing.id;

  /* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────
     `POST /:id/versions` was Calculate and refuses a browser client now. This
     fixture only ever needed a calculated version to exist; the orchestration
     makes one from the confirmed brief and the same sources. */
  const calc = await prepareForCosting(costingId);
  if (calc.status !== 201) throw new Error(`calculate refused: ${calc.status} ${JSON.stringify(calc.body).slice(0, 500)}`);
  const versionId = calc.body.versions[0].id;

  if (approve) {
    const s = await call(`/${costingId}/versions/${versionId}/submit`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(), body: {},
    });
    if (s.status !== 200) throw new Error(`submit refused: ${s.status} ${JSON.stringify(s.body).slice(0, 500)}`);
    const a = await call(`/${costingId}/versions/${versionId}/approve`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { note: "Approved for the season." },
    });
    expect(a.status).toBe(200);
  }

  return { co, me, sales, seeded, journey, enquiry, style, costingId, versionId };
}


/**
 * Sales adds a run size to the brief.
 *
 * A later version of the SAME sources, costed for a third quantity — which is
 * how a fixture produces a materially different calculation now that it can
 * neither add a typed row nor post a scenario. The quantities are Sales', so
 * the fixture changes them where Sales does.
 */
async function widenBrief(w) {
  const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = [
    ...SCENARIOS.map((sc) => ({ ...sc, quantity: String(sc.quantity) })),
    { key: "q5000", label: "5000 pcs", quantity: "5000", isPrimary: false },
  ];
  enquiry.markModified("costingBriefs");
  await enquiry.save();
}

const ctxOf = (w) => ({ companyId: w.co._id, actorId: String(w.me.emp._id) });

const askApi = (w, who, q) =>
  call(`/approved-output?${new URLSearchParams(q)}`, { token: who.token, company: w.co._id });


/* ═══ 1 · THE JOIN, AND WHAT IT REFUSES ═══════════════════════════════════ */

describe("finding the approved price for a quotation line", () => {
  test("the exact style and quantity returns the approved output", async () => {
    const w = await world();
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR",
    });
    expect(out.available).toBe(true);
    expect(out.costingId).toBe(w.costingId);
    expect(out.approvedVersionId).toBe(w.versionId);
    expect(out.approvedVersionNumber).toBeGreaterThan(0);
    expect(out.isCurrentApproval).toBe(true);
    expect(out.currency).toBe("INR");
    expect(out.style.productName).toBe(w.seeded.product);
    /* The exact scenario, and the one approved price it carries. */
    expect(out.match.scenarioKey).toBe("q500");
    expect(out.match.quantity).toBe("500");
    expect(out.match.floorPriceMinor).toBeGreaterThan(0);
    expect(out.match.pricingContract).toBe("MARKUP_FLOOR_V2");
    /* And the assumption Sales must repeat. */
    expect(out.assumptions.join(" ")).toMatch(/excludes GST/i);
  });

  test("a style belonging to another company returns nothing", async () => {
    const w = await world();
    const other = await world();
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: other.style._id, quantity: "500", currency: "INR",
    });
    /* Reported as absent, exactly as a style that does not exist — a refusal
       that varied would say which style ids are real. */
    expect(out.available).toBe(false);
    expect(out.reason).toBe("NO_STYLE");
  });

  test("a style with no costing is told apart from one with no approval", async () => {
    const w = await world();
    /* A second style on the same enquiry, for a different product — so the
       join finds no costing at all. */
    const orphan = await SampleStyle.create({
      sampleStyleId: `SS-${++seq}`, styleCode: `SC-${seq}`, productName: "Formal Trouser",
      journeyId: w.journey._id, enquiryId: w.enquiry._id, accountId: w.journey.accountId,
    });
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: orphan._id, quantity: "500", currency: "INR",
    });
    expect(out.available).toBe(false);
    /* "No costing has been raised" and "raised but not approved" need
       different actions from Sales. */
    expect(out.reason).toBe("NO_COSTING");
  });

  test("a costing with no approved version offers nothing", async () => {
    const w = await world({ approve: false });
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR",
    });
    /* A draft is somebody's working number. Quoting it would put an
       unapproved price in front of a customer. */
    expect(out.available).toBe(false);
    expect(out.reason).toBe("NO_APPROVED_VERSION");
    expect(out.costingId).toBe(w.costingId);
  });

  test("a pointer aimed at an unapproved version still serves nothing", async () => {
    const w = await world({ approve: false });
    /* ── THE BELT-AND-BRACES CASE ──────────────────────────────────────
       `approvedVersionId` is only set at approval, so in normal operation it
       always names an APPROVED version and the status filter never fires.
       This aims it at a DRAFT — a stale pointer, or one left behind by a
       future code path — and the read must still refuse. A query that
       trusted the pointer alone would serve an unapproved price the moment
       anything else went wrong. */
    await Costing.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.costingId)) },
      { $set: { approvedVersionId: new mongoose.Types.ObjectId(String(w.versionId)) } },
    );
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR",
    });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("NO_APPROVED_VERSION");
  });

  test("a quantity nobody approved gets no price, and never the nearest one", async () => {
    const w = await world();
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "1200", currency: "INR",
    });
    /* 1,200 against a costing approved at 500 and 1,000 is not a 1,000-piece
       price: fixed costs are diluted over the run, so the per-garment figure
       at 1,200 is a different number nobody has approved. */
    expect(out.available).toBe(false);
    expect(out.reason).toBe("NO_SCENARIO_FOR_QUANTITY");
    expect(out.message).toMatch(/No approved price exists for this quantity/);
    /* What IS approved, so Sales sees the gap rather than guessing at it. */
    expect(out.availableQuantities).toEqual(["500", "1000"]);
  });

  test("a different currency is refused, not converted", async () => {
    const w = await world();
    const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "USD",
    });
    /* A rate nobody recorded is not a price anybody approved. */
    expect(out.available).toBe(false);
    expect(out.reason).toBe("CURRENCY_MISMATCH");
    expect(out.approvedCurrency).toBe("INR");
    expect(out.quotationCurrency).toBe("USD");
  });

  test("quantity is matched exactly, whatever it was typed as", async () => {
    const w = await world();
    for (const q of ["500", "500.0", "500.00"]) {
      const out = await approvedOutput.approvedOutputFor(ctxOf(w), {
        sampleStyleId: w.style._id, quantity: q, currency: "INR",
      });
      expect(out.available).toBe(true);
      expect(out.match.scenarioKey).toBe("q500");
    }
    /* But 499.99 is a different quantity, not a rounding of 500. */
    const near = await approvedOutput.approvedOutputFor(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "499.99", currency: "INR",
    });
    expect(near.available).toBe(false);
  });
});


/* ═══ 2 · WHAT SALES RECEIVES, AND WHAT IT NEVER DOES ═════════════════════ */

describe("the boundary between cost and price", () => {
  test("a Sales user holding only output.read gets the price and no cost detail", async () => {
    const w = await world();
    const r = await askApi(w, w.sales, { sampleStyleId: String(w.style._id), quantity: "500", currency: "INR" });
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.match.floorPriceMinor).toBeGreaterThan(0);

    /* ── THE WHOLE RESPONSE, NOT A FIELD LIST ───────────────────────────
       Serialised and searched, so a field added later that carries cost
       detail fails this rather than slipping through a list nobody updated. */
    const wire = JSON.stringify(r.body);
    for (const forbidden of [
      "unitCostMinor", "totalCostMinor", "categorySubtotals", "offerProvenance",
      "supplierName", "quotationReference", "marginPercent", "markupPercent",
      "effectiveMarginPercent", "requestedMarginPercent", "minimumMarginPercent",
      "targetMarginPercent", "estimatedIncomeTax", "preTaxProfit", "afterTaxProfit",
      "completeness", "policySnapshot", "inputs", "sourceReferences",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  test("somebody with no costing grant is refused outright", async () => {
    const w = await world();
    /* A signed-in employee of the company with no costing department role at
       all. The approved price is commercial information, not something every
       login may read. */
    const nobody = await actor({ companies: [w.co] });
    const r = await askApi(w, nobody, { sampleStyleId: String(w.style._id), quantity: "500", currency: "INR" });
    expect([401, 403]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toContain("PriceMinor");
  });

  test("the floor price comes through without the markup that produced it", async () => {
    const w = await world();
    const r = await askApi(w, w.sales, { sampleStyleId: String(w.style._id), quantity: "500", currency: "INR" });
    const b = r.body.match;
    expect(b).toHaveProperty("floorPriceMinor");
    /* ── AND NOTHING THAT BUILT IT ────────────────────────────────────
       The markup the Board approved, the true unit cost and the markup
       amount all sit on the same subdocument as the price. None crosses: a
       reader entitled to quote a price is not thereby entitled to the
       company's cost or to what it marks that cost up by. */
    expect(b).not.toHaveProperty("floorMarkupPercent");
    expect(b).not.toHaveProperty("trueUnitCostMinor");
    expect(b).not.toHaveProperty("markupAmountMinor");
    /* The retired tiers are present and null — this version never had them. */
    expect(b.minimumPriceMinor).toBeNull();
    expect(b.targetPriceMinor).toBeNull();
    expect(b.preferredPriceMinor).toBeNull();
    /* `prices.target` on the version carries `requestedMarginPercent` and
       `effectiveMarginPercent` on the same subdocument. They stop here. */
    expect(Object.keys(b).join(",")).not.toMatch(/margin/i);
  });

  test("the cost read is not merely hidden — it is never fetched", () => {
    const src = require("fs")
      .readFileSync(require("path").join(__dirname, "../../services/centralCosting/approvedOutput.service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    /* A narrow projection is the guarantee. Fetching the whole version and
       deleting fields afterwards would mean the data had already crossed the
       boundary, and one forgotten `delete` would put it back. */
    expect(src).toMatch(/\.select\(\[/);
    expect(src).not.toMatch(/calculation\.inputs|offerProvenance|policySnapshot\./);
  });
});


/* ═══ 3 · WHAT A QUOTATION LINE FREEZES ═══════════════════════════════════ */

describe("linking a quotation line to an approved price", () => {
  test("the server resolves the price; a browser-supplied one is not used", async () => {
    const w = await world();
    const link = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
      /* A hopeful client. None of these is read. */
      unitPriceMinor: 1, costingVersionId: new mongoose.Types.ObjectId(), currencyOverride: "USD",
    });
    expect(link.available).toBe(true);

    const truth = await CostingVersion.findById(w.versionId).lean();
    const scenario = truth.scenarios.find((s) => s.key === "q500");
    /* The figure comes from the approved version, not the request. */
    expect(link.provenance.unitPriceMinor).toBe(scenario.floor.floorPriceMinor);
    expect(link.provenance.unitPriceMinor).not.toBe(1);
    expect(link.provenance.currency).toBe("INR");
    expect(link.provenance.costingVersionId).toBe(w.versionId);
  });

  test("the frozen provenance names everything a later reader needs", async () => {
    const w = await world();
    const { provenance: p } = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    expect(p.source).toBe("APPROVED_COSTING");
    expect(p.costingId).toBe(w.costingId);
    expect(p.costingVersionId).toBe(w.versionId);
    expect(p.costingVersionNumber).toBeGreaterThan(0);
    expect(p.sampleStyleId).toBe(String(w.style._id));
    expect(p.scenarioKey).toBe("q500");
    expect(p.quantity).toBe("500");
    /* Named `floor`, never a tier: a reader of this line must be able to tell
       a floor price from one of the retired tiers without looking the version
       up, and the two are different commercial claims about a number. */
    expect(p.priceTier).toBe("floor");
    expect(p.currency).toBe("INR");
    expect(p.linkedAt).toBeInstanceOf(Date);
    expect(p.assumptions.join(" ")).toMatch(/excludes GST/i);
    expect(p.fingerprint).toHaveLength(32);
  });

  test("the fingerprint moves when the price does, and only then", async () => {
    const w = await world();
    const a = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    const again = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    /* Same facts, same evidence — the timestamp is not part of it, or every
       read would look like a change. */
    expect(again.provenance.fingerprint).toBe(a.provenance.fingerprint);

    /* ── AND IT MOVES WHEN THE PRICE DOES ─────────────────────────────
       This used to compare two TIERS of one quantity, which is no longer a
       thing a costing has: there is one price. The claim survives against the
       other approved quantity, whose floor is derived from its own diluted
       unit cost and is therefore a different number. */
    const other = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "1000", currency: "INR", tier: "floor",
    });
    expect(other.provenance.unitPriceMinor).not.toBe(a.provenance.unitPriceMinor);
    expect(other.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
  });

  test("a quantity with no approved scenario cannot be linked at all", async () => {
    const w = await world();
    const link = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "1200", currency: "INR", tier: "floor",
    });
    expect(link.available).toBe(false);
    expect(link.provenance).toBeUndefined();
  });
});


/* ═══ 4 · A SAVED QUOTATION IS A RECORD, NOT A VIEW ═══════════════════════ */

describe("what a later change must not do", () => {
  test("a new approved version does not alter what was already frozen", async () => {
    const w = await world();
    const { provenance: saved } = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    const originalPrice = saved.unitPriceMinor;

    /* The costing is revised and re-approved at a higher cost. */
    await widenBrief(w);
    const dearer = await prepareForCosting(w.costingId);
    expect(dearer.status).toBe(201);
    const v2 = dearer.body.versions[0].id;
    await call(`/${w.costingId}/versions/${v2}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    const ap = await call(`/${w.costingId}/versions/${v2}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "Revised." },
    });
    expect(ap.status).toBe(200);

    /* The frozen object is untouched — nothing reaches back into it. */
    expect(saved.unitPriceMinor).toBe(originalPrice);
    expect(saved.costingVersionId).toBe(w.versionId);
  });

  test("a superseded source is reported, and the saved figure is not replaced", async () => {
    const w = await world();
    const { provenance: saved } = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    expect((await approvedOutput.supersessionFor(ctxOf(w), saved)).superseded).toBe(false);

    await widenBrief(w);
    const v2res = await prepareForCosting(w.costingId);
    const v2 = v2res.body.versions[0].id;
    await call(`/${w.costingId}/versions/${v2}/submit`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    await call(`/${w.costingId}/versions/${v2}/approve`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(), body: { note: "Revised." },
    });

    const check = await approvedOutput.supersessionFor(ctxOf(w), saved);
    expect(check.superseded).toBe(true);
    expect(check.message).toBe("Approved source has been superseded");
    expect(check.linkedVersionId).toBe(w.versionId);
    expect(check.currentApprovedVersionId).toBe(v2);
    /* Reported, never applied: the saved line still says what was offered. */
    expect(saved.costingVersionId).toBe(w.versionId);
  });

  test("supersession is not claimed when the costing cannot be read", async () => {
    const w = await world();
    const stranger = await world();
    const { provenance } = await approvedOutput.resolveLinkForLine(ctxOf(w), {
      sampleStyleId: w.style._id, quantity: "500", currency: "INR", tier: "floor",
    });
    const check = await approvedOutput.supersessionFor(ctxOf(stranger), provenance);
    /* Another company's costing is unreadable here. "Unknown" is the honest
       answer; "superseded" would be a claim about a record nobody read. */
    expect(check.superseded).toBe(false);
    expect(check.unknown).toBe(true);
  });
});


/* ═══ 5 · THE MODEL CARRIES THE JOIN AND THE PROVENANCE ═══════════════════ */

describe("the quotation line's stored shape", () => {
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const itemSchema = () => CustomerRequest.schema.path("quotations").schema.path("items").schema;

  test("a quotation line can name the style it is for", () => {
    /* The join is an id. Product name, SKU text and array position each
       silently repoint the price the first time somebody renames or reorders
       something. */
    expect(itemSchema().path("sampleStyleId")).toBeTruthy();
    expect(itemSchema().path("sampleStyleId").options.ref).toBe("SampleStyle");
  });

  test("a line records where its price came from, or records nothing", () => {
    for (const f of [
      "costingSource.source", "costingSource.costingId", "costingSource.costingVersionId",
      "costingSource.costingVersionNumber", "costingSource.scenarioKey", "costingSource.quantity",
      "costingSource.priceTier", "costingSource.unitPriceMinor", "costingSource.currency",
      "costingSource.linkedAt", "costingSource.fingerprint",
    ]) {
      expect(itemSchema().path(f)).toBeTruthy();
    }
    /* ── A MANUAL PRICE IS AN ABSENCE, NOT A LABEL ──────────────────────
       The only accepted value is APPROVED_COSTING, so a line cannot claim a
       costing origin it never had, and one that was never linked has no
       marker to forge. */
    expect(itemSchema().path("costingSource.source").enumValues).toEqual(["APPROVED_COSTING"]);
  });

  test("an unlinked line stores no costing source at all", async () => {
    const doc = new CustomerRequest({
      quotations: [{ items: [{ itemName: "Typed by hand", quantity: 10, unitPrice: 500 }] }],
    });
    const item = doc.quotations[0].items[0];
    /* Not `source: "MANUAL"` — absence is the record, and there is nothing
       to mistake for a link. */
    expect(item.costingSource?.source).toBeUndefined();
    expect(item.costingSource?.costingVersionId).toBeUndefined();
    expect(item.sampleStyleId).toBeNull();
  });
});
