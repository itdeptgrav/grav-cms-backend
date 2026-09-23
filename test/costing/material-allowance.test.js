// test/costing/material-allowance.test.js
//
// WHAT A GARMENT CONTAINS, AND WHAT MAKING IT CONSUMES.
//
// ── THE TWO NUMBERS, AND THE ONE THAT WAS BEING IGNORED ─────────────────────
// `consumptionPerPiece` is what ends up in the product: the net length, weight
// or count. `allowancePercent` is what the process additionally consumes to put
// it there — cutting loss, end bits, shrinkage, the unusable part of the roll.
// The company buys the second as surely as the first and pays the same rate.
//
// R&D has recorded both, separately, since the technical record existed. The
// costing read the first and carried the second as decoration. A style
// consuming 1.4 metres with a 5% allowance was costed at 1.4 and bought at
// 1.47.
//
// ── AND THE UNDERSTATEMENT DID NOT STOP AT THE TOTAL ────────────────────────
// The same figure is what the applicability check multiplies by the run size,
// so the supplier's minimum order and the quantity tier were both judged on a
// quantity nobody was going to buy. A run that reached a cheaper tier at the
// real consumption was priced at the dearer one; a run that failed a minimum
// at the real consumption appeared to pass it.
//
// ── THE ONE ERROR THIS MUST NOT INTRODUCE ───────────────────────────────────
// Applying the allowance twice. The legacy path stored what R&D typed as the
// EFFECTIVE amount already, which is why `allowanceAlreadyInQuantity` exists,
// and multiplying that by its own percentage again is the reason the flag was
// written down rather than inferred.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const SourcingDecision = require("../../models/CMS_Models/Inventory/Sourcing/SourcingDecision");

const { seedSourceBacked, configureProduction, prepareForCosting, assembleForCosting } = require("./helpers/sourceBacked");
const technicalSource = require("../../services/centralCosting/technicalSource.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  app.use("/api/sourcing-decisions", require("../../routes/CMS_Routes/Inventory/Sourcing/sourcingDecisions"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `ma-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company), "X-Company-Id": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/* Overhead is the Board's now and the costing policy refuses it here. */
const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* The GST treatment is an approved Board decision now; the costing policy
     refuses the field. `configureProduction` approves the fixture's, at the
     same RECOVERABLE this used to write. */
  revision: 0,
};

const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

async function actor(co) {
  const n = ++seq;
  const email = `allow-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Cost", lastName: `L${n}`, email, biometricId: `MA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Cost" });
  return jwt.sign(
    { id: String(emp._id), email, name: "Cost", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
  );
}

/**
 * A style whose material consumption comes from R&D's APPROVED technical
 * record — the modern path, where the allowance is a separate fact.
 *
 * The shared fixture seeds the LEGACY path (`sample.consumptionRawItems`),
 * where whatever R&D typed is already the consumed amount. Both are exercised
 * here, because the whole point is that they are combined differently.
 */
async function engineeredWorld({
  consumptionPerPiece = 1.4, allowancePercent = 5, uom = "Metre",
  offer = {}, second = null,
} = {}) {
  const co = await Acc_Company.create({
    companyName: `Allowance ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const token = await actor(co);
  expect((await call("/api/costings/policy/current", {
    method: "PUT", token, company: co._id, body: POLICY,
  })).status).toBe(200);

  /* No legacy row and no operation: this suite is about one material. */
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: ONE, quantityUom: "Pieces" },
    withOperation: false, uom,
    rateMinor: offer.rateMinor ?? 10000,
    ...(offer.over ? { } : {}),
  });
  await configureProduction(co._id);

  /* R&D's approved revision, which is what `technicalSource` reads. */
  const material = {
    rawItemId: seeded.item._id,
    rawItemName: seeded.item.name,
    rawItemSku: seeded.item.sku || "",
    specification: "Shell fabric",
    consumptionPerPiece,
    unit: uom,
    allowancePercent,
    appliesToAllVariants: true,
  };
  await SampleStyle.updateOne({ _id: seeded.style._id }, {
    $set: {
      /* The legacy list is emptied so the engineered row is unambiguously the
         one chosen — two pieces of evidence for one item is a different test. */
      "sample.consumptionRawItems": [],
      "techSheet.technical.status": "approved",
      "techSheet.technical.materials": [material],
      "techSheet.technicalRevisions": [{
        revision: 1, outcome: "approved",
        snapshot: { materials: [material], operations: [] },
      }],
    },
  });

  if (offer.over) {
    await SupplierOffer.collection.updateOne(
      { _id: seeded.offer._id }, { $set: offer.over },
    );
  }
  if (second) {
    const v = await Vendor.create({
      companyId: co._id, companyName: `Mill B ${++seq}`, vendorType: "Supplier", status: "Active",
    });
    await SupplierOffer.create({
      companyId: co._id, supplierId: v._id, supplierName: v.companyName,
      itemId: seeded.item._id, purchaseUom: uom, currency: "INR",
      unitPriceMinor: second.rateMinor ?? 9900, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
      freightTerms: "INCLUSIVE_LANDED", quotationReference: `Q-${++seq}`,
      /* A second Indian mill quoting the same fabric — stated, because an
         offer that never answered the question blocks the costing rather
         than being assumed domestic, and this suite is about allowances. */
      sourcing: { type: "DOMESTIC" },
      status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
      ...(second.over || {}),
    });
  }

  const made = await call("/api/costings", {
    method: "POST", token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, token, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, and the engine is unchanged: the orchestration resolves the
   confirmed brief and every source and calls it.

   `lines` never reached the engine even before — the server assembles its own
   rows — so a body carrying only lines goes the Sales way. A body carrying
   anything ELSE is a payload-contract test, and those go to the retired door
   on purpose: its refusal is the contract now. */
const payloadContract = (body = {}) => Object.keys(body).some((k) => k !== "lines")
  /* A NON-EMPTY `lines` is a payload-contract test too. The engine assembles
     its own rows and ignored an empty list, but a list with something in it is
     a client trying to send a figure — which is exactly what those tests
     exist to see refused. */
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calc = (w, body = {}) => (payloadContract(body)
  ? call(`/api/costings/${w.costingId}/versions`, {
    method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
    body: { lines: [], ...body },
  })
  : prepareForCosting(w.costingId));

const preview = (w) => call(`/api/costings/${w.costingId}/technical-preview`,
  { token: w.token, company: w.co._id });

const materialLine = (v, key) => v.cost.inputs.find((l) => l.lineKey === key);
const snapshotOf = (v, key) => {
  const ref = (v.cost.sourceReferences || [])
    .find((s) => (s.snapshot || []).some((f) => f.key === "technicalKey"))
    && (v.cost.sourceReferences || []).find((s) => s.sourceKey === key || true);
  return ref ? Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text ?? f.num])) : {};
};

/* ═══ 1 · THE RULE, IN ISOLATION ════════════════════════════════════════ */

describe("the canonical effective consumption", () => {
  const eff = technicalSource.effectiveConsumption;

  test("a modern row adds the allowance to the base", () => {
    const r = eff({ quantity: 1.4, allowancePercent: 5, allowanceAlreadyInQuantity: false });
    expect(r.effectiveExact).toBe("1.47");
    expect(r.base).toBe(1.4);
    expect(r.alreadyIncluded).toBe(false);
  });

  test("a legacy row is left exactly as recorded", () => {
    /* ── THE DOUBLE-COUNT THIS PREVENTS ────────────────────────────────
       What R&D typed into the legacy list was already the consumed amount.
       1.45 x 1.05 would be 1.5225 — the allowance charged twice, and the
       reason the flag is stored rather than inferred from the number. */
    const r = eff({ quantity: 1.45, allowancePercent: 5, allowanceAlreadyInQuantity: true });
    expect(r.effectiveExact).toBe("1.45");
    expect(r.alreadyIncluded).toBe(true);
    /* The percentage is kept as information — what R&D was planning around. */
    expect(r.allowancePercent).toBe(5);
  });

  test("an explicit zero is a real answer, and absence is a different one", () => {
    const zero = eff({ quantity: 1.4, allowancePercent: 0, allowanceAlreadyInQuantity: false });
    const absent = eff({ quantity: 1.4, allowancePercent: null, allowanceAlreadyInQuantity: false });

    /* Both consume 1.4 — nothing is invented for a blank. */
    expect(zero.effectiveExact).toBe("1.4");
    expect(absent.effectiveExact).toBe("1.4");
    /* And they stay distinguishable for ever: "R&D said none" is not "R&D has
       not said", and only one of them is a decision. */
    expect(zero.allowancePercent).toBe(0);
    expect(absent.allowancePercent).toBeNull();
  });

  test("a decimal allowance is exact, not floating point", () => {
    /* 1.4 x 1.025 is 1.435. In binary floating point it is
       1.4349999999999998, and a costing that priced that could not be
       reconciled against the record it cites. */
    const r = eff({ quantity: 1.4, allowancePercent: 2.5, allowanceAlreadyInQuantity: false });
    expect(r.effectiveExact).toBe("1.435");
    expect(String(1.4 * 1.025)).not.toBe("1.435");
  });

  test("a missing base consumption stays missing", () => {
    /* An absent quantity is a gap R&D has to fill. Multiplying nothing by an
       allowance must not manufacture a number. */
    const r = eff({ quantity: null, allowancePercent: 5, allowanceAlreadyInQuantity: false });
    expect(r.effective).toBeNull();
    expect(r.effectiveExact).toBeNull();
  });
});

/* ═══ 2 · IT REACHES THE COSTING ════════════════════════════════════════ */

describe("the priced quantity", () => {
  test("a modern row is costed at base plus allowance", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const r = await calc(w);
    expect(r.status).toBe(201);

    const line = materialLine(r.body.versions[0], w.seeded.materialLineKey);
    expect(line.quantityPerUnit).toBe("1.47");
    /* Not the base — the defect this closes. */
    expect(line.quantityPerUnit).not.toBe("1.4");
  });

  test("a 0% allowance costs the base, and says it was told so", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 0 });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(materialLine(r.body.versions[0], w.seeded.materialLineKey).quantityPerUnit).toBe("1.4");
  });

  test("the legacy path is unchanged, and is not multiplied a second time", async () => {
    /* The shared fixture seeds the legacy list. Its figure is what R&D typed,
       and it must arrive at the costing untouched. */
    const co = await Acc_Company.create({
      companyName: `Legacy ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const token = await actor(co);
    await call("/api/costings/policy/current", {
      method: "PUT", token, company: co._id, body: POLICY,
    });
    const seeded = await seedSourceBacked(co._id, { brief: { quantities: ONE, quantityUom: "Pieces" }, withOperation: false, consumption: "1.45" });
    await configureProduction(co._id);
    /* An allowance beside the legacy quantity, as a real record carries. */
    await SampleStyle.collection.updateOne(
      { _id: seeded.style._id },
      { $set: { "sample.consumptionRawItems.0.allowancePercent": 5 } },
    );
    const made = await call("/api/costings", {
      method: "POST", token, company: co._id, idempotencyKey: newKey(),
      body: { context: seeded.context },
    });
    const r = await prepareForCosting(made.body.costing.id);
    expect(r.status).toBe(201);
    const line = materialLine(r.body.versions[0], seeded.materialLineKey);
    expect(line.quantityPerUnit).toBe("1.45");
    /* 1.45 x 1.05 = 1.5225 would be the allowance charged twice. */
    expect(line.quantityPerUnit).not.toBe("1.5225");
  });

  test("two materials with different allowances each get their own", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });

    /* A second material on the same approved revision, with its own figure. */
    const trim = await RawItem.create({
      companyId: w.co._id, name: `Thread ${++seq}`, sku: `TRD-${seq}`,
      unit: "Metre", status: "Active",
    });
    const style = await SampleStyle.findById(w.seeded.style._id).lean();
    const existing = style.techSheet.technicalRevisions[0].snapshot.materials;
    const second = {
      rawItemId: trim._id, rawItemName: trim.name, rawItemSku: "",
      specification: "Overlock thread", consumptionPerPiece: 2, unit: "Metre",
      allowancePercent: 10, appliesToAllVariants: true,
    };
    await SampleStyle.collection.updateOne({ _id: w.seeded.style._id }, {
      $set: {
        "techSheet.technical.materials": [...existing, second],
        "techSheet.technicalRevisions.0.snapshot.materials": [...existing, second],
      },
    });

    const p = await preview(w);
    expect(p.status).toBe(200);
    const rows = p.body.assembly.rows.materials;
    const fabric = rows.find((x) => x.description.includes("Cotton") || x.quantity === "1.47");
    const thread = rows.find((x) => x.description.includes("Thread"));
    expect(fabric.quantity).toBe("1.47");
    /* 2 x 1.10 = 2.2 — its own allowance, not the fabric's. */
    expect(thread.quantity).toBe("2.2");
  });
});

/* ═══ 3 · AND THE QUOTATION IT REACHES ══════════════════════════════════ */

describe("quotation applicability", () => {
  test("the supplier is asked for the effective quantity, not the base", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const r = await calc(w);
    expect(r.status).toBe(201);

    const prov = r.body.versions[0].cost.offerProvenance
      .find((p) => p.lineKey === w.seeded.materialLineKey);
    /* 1.47 x 500 = 735 metres. At the base it would have been 700 — and 700 is
       what the minimum and the tier used to be judged on. */
    expect(prov.appliedPurchaseQuantity).toBe("735");
  });

  test("a minimum order met only WITH the allowance is met", async () => {
    /* ── THE BOUNDARY THAT WAS BEING MISJUDGED ─────────────────────────
       700 metres is below this supplier's 720 minimum; 735 is not. Costed at
       the base, the quotation was excluded and the costing blocked for a
       minimum the company would actually have met. */
    const w = await engineeredWorld({
      consumptionPerPiece: 1.4, allowancePercent: 5,
      offer: { over: { moq: 720 } },
    });
    const r = await calc(w);
    expect(r.status).toBe(201);
    expect(materialLine(r.body.versions[0], w.seeded.materialLineKey).quantityPerUnit).toBe("1.47");
  });

  test("a minimum order missed even WITH the allowance still blocks", async () => {
    /* The correction must not become a way past a real minimum. */
    const w = await engineeredWorld({
      consumptionPerPiece: 1.4, allowancePercent: 5,
      offer: { over: { moq: 900 } },
    });
    const r = await calc(w);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/minimum|applic/i);
  });

  test("the tier the run reaches is the one the effective quantity reaches", async () => {
    /* Two bands with the boundary between 700 and 735: at the base the run
       buys at the dearer band, at the real consumption at the cheaper one. */
    const w = await engineeredWorld({
      consumptionPerPiece: 1.4, allowancePercent: 5,
      offer: {
        over: {
          tiers: [
            { minQuantity: 1, maxQuantity: 720, unitPriceMinor: 12000 },
            { minQuantity: 721, maxQuantity: null, unitPriceMinor: 9000 },
          ],
        },
      },
    });
    const r = await calc(w);
    expect(r.status).toBe(201);
    const prov = r.body.versions[0].cost.offerProvenance
      .find((p) => p.lineKey === w.seeded.materialLineKey);
    expect(prov.appliedPurchaseQuantity).toBe("735");
    expect(prov.netRateMinor).toBe(9000);
  });
});

/* ═══ 4 · STORE SEES THE SAME QUANTITY ══════════════════════════════════ */

describe("the Store sourcing queue", () => {
  test("judges candidates at the effective quantity, not the base", async () => {
    /* ── ONE QUANTITY, TWO SCREENS ─────────────────────────────────────
       If the queue judged 700 and the costing 735, Store could offer a
       supplier the costing then refuses — and nothing would say why. */
    /* ── A RUN SIZE HAS TO EXIST FIRST ────────────────────────────────
       A costing that has never calculated has no scenarios, so applicability
       cannot be judged against a quantity at all — the queue says so rather
       than printing one nobody judged. So this costs the style while one
       quotation applies, and the ambiguity arrives afterwards, which is also
       the ordinary way it happens: a second supplier quotes an item the
       company is already costing. */
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    expect((await calc(w)).status).toBe(201);

    const v = await Vendor.create({
      companyId: w.co._id, companyName: `Mill B ${++seq}`, vendorType: "Supplier", status: "Active",
    });
    await SupplierOffer.create({
      companyId: w.co._id, supplierId: v._id, supplierName: v.companyName,
      itemId: w.seeded.item._id, purchaseUom: "Metre", currency: "INR",
      unitPriceMinor: 9900, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
      freightTerms: "INCLUSIVE_LANDED", quotationReference: `Q-${++seq}`,
      /* Same fabric, second Indian mill. Stated for the same reason. */
      sourcing: { type: "DOMESTIC" },
      status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
    });

    const q = await call("/api/sourcing-decisions", { token: w.token, company: w.co._id });
    expect(q.status).toBe(200);
    const row = q.body.decisions.find((d) => d.lineKey === w.seeded.materialLineKey);
    expect(row).toBeTruthy();
    expect(row.judged.quantity).toBe("735");
    for (const c of row.candidates) {
      if (c.purchaseQuantity) expect(c.purchaseQuantity).toBe("735");
    }
  });

  test("changing the allowance reopens a decision whose quotation no longer applies", async () => {
    /* A decision is made against a quantity. Raising the allowance past a
       supplier's maximum band must not silently reprice at a rate they never
       quoted for that volume. */
    const w = await engineeredWorld({
      consumptionPerPiece: 1.4, allowancePercent: 5,
      offer: { over: { tiers: [{ minQuantity: 1, maxQuantity: 800, unitPriceMinor: 10000 }] } },
      second: { rateMinor: 9900, over: { tiers: [{ minQuantity: 1, maxQuantity: 800, unitPriceMinor: 9900 }] } },
    });
    await calc(w);

    const q = await call("/api/sourcing-decisions", { token: w.token, company: w.co._id });
    const row = q.body.decisions.find((d) => d.lineKey === w.seeded.materialLineKey);
    const chosen = row.candidates[0].offerId;
    const made = await call(`/api/sourcing-decisions/costing/${w.costingId}`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lineKey: w.seeded.materialLineKey, offerId: String(chosen) },
    });
    expect(made.status).toBe(201);
    expect((await calc(w)).status).toBe(201);

    /* R&D raises the allowance: 1.4 x 1.60 = 2.24, so the run needs 1,120
       metres — past every quoted band. */
    await SampleStyle.collection.updateOne({ _id: w.seeded.style._id }, {
      $set: {
        "techSheet.technical.materials.0.allowancePercent": 60,
        "techSheet.technicalRevisions.0.snapshot.materials.0.allowancePercent": 60,
      },
    });

    const after = await calc(w);
    expect(after.status).toBeGreaterThanOrEqual(400);
    /* The decision is not silently applied to a quantity it was never judged
       against — the requirement reopens and says so. */
    expect(after.body.error.message).toMatch(/no longer applies at these quantities/i);
    expect(after.body.error.details.owner.department).toBe("Store");
  });
});

/* ═══ 5 · A READER CAN REPRODUCE THE NUMBER ═════════════════════════════ */

describe("frozen provenance", () => {
  test("carries the base, the allowance, whether it was included, and the effective", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const r = await calc(w);
    expect(r.status).toBe(201);

    const ref = r.body.versions[0].cost.sourceReferences
      .find((s) => (s.snapshot || []).some((f) => f.key === "effectiveConsumptionPerPiece"));
    expect(ref).toBeTruthy();
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text ?? f.num]));

    /* Everything needed to check 1.4 x 1.05 = 1.47, and 1.47 x 500 = 735. */
    expect(snap.baseConsumptionPerPiece).toBe(1.4);
    expect(snap.allowancePercent).toBe(5);
    expect(snap.allowanceInQuantity).toBe("no");
    expect(snap.effectiveConsumptionPerPiece).toBe(1.47);
    expect(snap.unit).toBe("Metre");
  });

  test("a legacy row is identified as already including its allowance", async () => {
    const co = await Acc_Company.create({
      companyName: `LegacyProv ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const token = await actor(co);
    await call("/api/costings/policy/current", {
      method: "PUT", token, company: co._id, body: POLICY,
    });
    const seeded = await seedSourceBacked(co._id, { brief: { quantities: ONE, quantityUom: "Pieces" }, withOperation: false, consumption: "1.45" });
    await configureProduction(co._id);
    await SampleStyle.collection.updateOne(
      { _id: seeded.style._id },
      { $set: { "sample.consumptionRawItems.0.allowancePercent": 5 } },
    );
    const made = await call("/api/costings", {
      method: "POST", token, company: co._id, idempotencyKey: newKey(),
      body: { context: seeded.context },
    });
    const r = await prepareForCosting(made.body.costing.id);
    expect(r.status).toBe(201);

    const ref = r.body.versions[0].cost.sourceReferences
      .find((s) => (s.snapshot || []).some((f) => f.key === "allowanceInQuantity"));
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text ?? f.num]));
    /* The distinction the whole flag exists for. */
    expect(snap.allowanceInQuantity).toBe("yes");
    expect(snap.effectiveConsumptionPerPiece).toBe(1.45);
  });

  test("an unrecorded allowance says so, rather than reading as 0%", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: null });
    const r = await calc(w);
    expect(r.status).toBe(201);

    const ref = r.body.versions[0].cost.sourceReferences
      .find((s) => (s.snapshot || []).some((f) => f.key === "allowanceInQuantity"));
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text ?? f.num]));
    expect(snap.allowanceInQuantity).toBe("none recorded");
    expect(snap.effectiveConsumptionPerPiece).toBe(1.4);
    /* R&D's own rule: the field is optional and must be EXPLICIT. Nothing is
       blocked, and nothing is invented. */
    expect(snap.allowancePercent).toBeUndefined();
  });

  test("the screen shows the working, not just the answer", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const p = await preview(w);
    expect(p.status).toBe(200);
    const row = p.body.assembly.rows.materials
      .find((x) => x.lineKey === w.seeded.materialLineKey);
    expect(row.quantity).toBe("1.47");
    expect(row.consumptionWorking).toMatchObject({
      basePerPiece: 1.4, allowancePercent: 5, effectivePerPiece: "1.47",
    });
  });
});

/* ═══ 6 · HISTORY, AND THE PATH THAT STAYS CLOSED ═══════════════════════ */

describe("what this must not disturb", () => {
  test("a frozen version is not recalculated when the allowance changes", async () => {
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const r = await calc(w);
    const versionId = r.body.versions[0].id;
    const before = await CostingVersion.findById(versionId).lean();

    await SampleStyle.collection.updateOne({ _id: w.seeded.style._id }, {
      $set: {
        "techSheet.technical.materials.0.allowancePercent": 12,
        "techSheet.technicalRevisions.0.snapshot.materials.0.allowancePercent": 12,
      },
    });

    const after = await CostingVersion.findById(versionId).lean();
    expect(after.inputs).toEqual(before.inputs);
    expect(after.sourceReferences).toEqual(before.sourceReferences);

    /* And it still reads. */
    const read = await call(`/api/costings/${w.costingId}/versions`,
      { token: w.token, company: w.co._id });
    expect(read.status).toBe(200);
    expect(read.body.versions.find((v) => v.id === versionId)
      .cost.inputs.find((l) => l.lineKey === w.seeded.materialLineKey).quantityPerUnit).toBe("1.47");
  });

  test("a typed wastage line is still refused", async () => {
    /* The 4% cutting-wastage row a fixture used to type is exactly what the
       allowance replaces. It must not come back as a manual line. */
    const w = await engineeredWorld();
    const r = await calc(w, {
      lines: [{
        lineKey: "wastage", category: "WASTAGE", behaviour: "PERCENT_OF_BASIS",
        label: "Cutting wastage", basis: "MATERIALS", percent: "4",
      }],
    });
    /* Refused at the door now: the route reads no body at all, because
       preparing an estimate is a Sales action. A typed row has one fewer way
       in than it had, not one more — and the parser still refuses it, which
       is asserted directly so the rule keeps a test. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    let refused = null;
    try {
      await assembleForCosting(w.costingId, {
        lines: [{
          lineKey: "wastage", category: "WASTAGE", behaviour: "PERCENT_OF_BASIS",
          label: "Cutting wastage", basis: "MATERIALS", percent: "4",
        }],
      });
    } catch (err) { refused = err; }
    expect(["COSTING_MANUAL_LINE_REFUSED", "COSTING_MANUAL_INPUT_RETIRED"])
      .toContain(refused.code);
  });

  test("nothing was added to an operation, a service or a packaging row", async () => {
    /* An allowance is a property of a material being cut, not of a process
       being performed or a bag being filled. */
    const w = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const p = await preview(w);
    const rows = p.body.assembly.rows;
    for (const family of ["operations", "packaging", "services"]) {
      for (const row of rows[family] || []) {
        expect(row.consumptionWorking ?? null).toBeNull();
      }
    }
  });

  test("another company's style is untouched by any of this", async () => {
    const mine = await engineeredWorld({ consumptionPerPiece: 1.4, allowancePercent: 5 });
    const theirs = await engineeredWorld({ consumptionPerPiece: 2, allowancePercent: 50 });

    const r = await calc(mine);
    expect(r.status).toBe(201);
    expect(materialLine(r.body.versions[0], mine.seeded.materialLineKey).quantityPerUnit).toBe("1.47");
    expect(await SourcingDecision.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });
});
