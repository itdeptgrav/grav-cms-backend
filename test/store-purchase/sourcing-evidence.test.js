// test/store-purchase/sourcing-evidence.test.js
//
// STORE OWNS WHERE PURCHASED GOODS COME FROM.
//
// The one claim everything else hangs off: **missing is never duty-free.** An
// item nobody has classified must not read like an item with nothing to pay,
// and `DOMESTIC` — an answer somebody gave, on a quotation — must be tellable
// apart from silence. They are different states, they produce different
// readiness, and neither is ever a zero.
//
// Also pinned: company isolation on both reads, the quotation lifecycle
// (a draft is not evidence, a withdrawn one is retracted, an expired one is
// still the last thing anybody said), and that no rate, tier or supplier name
// can leave the projection.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

const svc = require("../../services/storePurchase/sourcingEvidence.service");
const { EVIDENCE } = svc;

let seq = 0;

async function company(name) {
  return Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });
}

async function item(co, { tariff = "" } = {}) {
  const n = ++seq;
  return RawItem.create({
    companyId: co._id, name: `Shell fabric ${n}`, sku: `RAW-${n}`,
    unit: "Metre", quantity: 0, minStock: 0, maxStock: 100,
    ...(tariff ? { customsTariffCode: tariff } : {}),
  });
}

async function offer(co, it, { sourcing, status = "ACTIVE", validUntil, effectiveFrom } = {}) {
  const n = ++seq;
  const supplier = await Vendor.create({
    companyId: co._id, companyName: `Mill ${n}`, vendorType: "Supplier", status: "Active",
  });
  return SupplierOffer.create({
    companyId: co._id, supplierId: supplier._id, supplierName: supplier.companyName,
    itemId: it._id, purchaseUom: "Metre", currency: "INR",
    unitPriceMinor: 24500, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
    hsnCode: "5208", quotationReference: `Q-${n}`,
    quotationDate: new Date("2026-08-01"),
    effectiveFrom: effectiveFrom || new Date("2026-08-01"),
    ...(validUntil ? { validUntil } : {}),
    status,
    ...(sourcing ? { sourcing } : {}),
  });
}

/* ══ THE ONE CLAIM: MISSING IS NEVER DUTY-FREE ═════════════════════════════ */

describe("silence and a domestic decision are different facts", () => {
  test("an offer nobody has answered is MISSING, and blocks", () => {
    const r = svc.assess({ _id: "o1", quotationReference: "Q-1" }, { _id: "i1", name: "Jersey" });
    expect(r.state).toBe(EVIDENCE.MISSING);
    expect(r.blocking).toBe(true);
    expect(r.missing[0].field).toBe("sourcing.type");
    expect(r.missing[0].message).toMatch(/not a domestic supply/);
    /* And emphatically not a duty of nil. The row now names the duty-inclusion
       QUESTION (`dutyInQuotedRate`, empty because nobody was asked), so the
       claim is stated as what it always meant: no rate, no percentage and no
       zero anywhere in it. A field asking whether duty is included is not a
       duty figure, and asserting on the substring hid that distinction. */
    expect(r.sourcingType).toBe("");
    expect(r.dutyInQuotedRate).toBe("");
    expect(JSON.stringify(r)).not.toMatch(/\d+(\.\d+)?%|ratePercent|dutyMinor|"rate"/i);
  });

  test("a stated DOMESTIC supply is NOT_APPLICABLE, and does not block", () => {
    const r = svc.assess(
      { _id: "o1", quotationReference: "Q-1", sourcing: { type: "DOMESTIC" } },
      { _id: "i1", name: "Jersey" },
    );
    expect(r.state).toBe(EVIDENCE.NOT_APPLICABLE);
    expect(r.blocking).toBe(false);
    expect(r.missing).toEqual([]);
    /* No country is asked for and none is stored: a domestic supply's origin
       is India by definition. */
    expect(r.countryOfOrigin).toBe("");
    /* It is traceable to the quotation that said it — which is what makes it
       a decision rather than an assumption. */
    expect(r.quotation.reference).toBe("Q-1");
  });

  test("the two states are never conflated by the roll-up", () => {
    const silent = svc.rollUp([svc.assess({ _id: "o" }, { _id: "i" })]);
    const decided = svc.rollUp([svc.assess({ _id: "o", sourcing: { type: "DOMESTIC" } }, { _id: "i" })]);
    expect(silent.state).toBe(EVIDENCE.MISSING);
    expect(silent.blocking).toBe(true);
    expect(decided.state).toBe(EVIDENCE.NOT_APPLICABLE);
    expect(decided.blocking).toBe(false);
  });
});

/* ══ IMPORTED NEEDS BOTH HALVES ════════════════════════════════════════════ */

describe("imported goods", () => {
  /* ── A COMPLETE IMPORT NOW HAS THREE FACTS, NOT TWO ──────────────────
     `dutyInQuotedRate` joined the origin and the heading: a quoted rate that
     already carries the duty must not be dutied again, and neither guess is
     safe, so Store is asked. It is stated here so every test below still
     isolates the single fact it removes. */
  const imported = (over = {}) => ({
    _id: "o1", quotationReference: "Q-1",
    sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED", ...over },
  });

  test("origin and classification together are READY", () => {
    const r = svc.assess(imported(), { _id: "i1", name: "Jersey", customsTariffCode: "52085200" });
    expect(r.state).toBe(EVIDENCE.READY);
    expect(r.blocking).toBe(false);
    expect(r.countryOfOrigin).toBe("CN");
    expect(r.customsTariffCode).toBe("52085200");
  });

  test("an origin with no classification is IN_PROGRESS, and names the item", () => {
    const r = svc.assess(imported(), { _id: "i1", name: "Jersey" });
    expect(r.state).toBe(EVIDENCE.IN_PROGRESS);
    expect(r.missing.map((m) => m.field)).toEqual(["customsTariffCode"]);
    expect(r.missing[0].message).toMatch(/Jersey/);
    /* And says why the GST code beside it is not an answer. */
    expect(r.missing[0].message).toMatch(/GST HSN .* is a different classification/);
  });

  test("a classification with no origin is IN_PROGRESS", () => {
    const r = svc.assess(imported({ countryOfOrigin: "" }), { _id: "i1", customsTariffCode: "52085200" });
    expect(r.state).toBe(EVIDENCE.IN_PROGRESS);
    expect(r.missing.map((m) => m.field)).toEqual(["sourcing.countryOfOrigin"]);
  });

  test("neither half recorded names both", () => {
    const r = svc.assess(imported({ countryOfOrigin: "" }), { _id: "i1" });
    expect(r.missing.map((m) => m.field)).toEqual(["sourcing.countryOfOrigin", "customsTariffCode"]);
    expect(r.missing.every((m) => m.owner === "Store")).toBe(true);
  });

  /* ── AND THE THIRD FACT, WHICH IS ABOUT THE PRICE AND NOT THE GOODS ─────
     The origin and the heading describe what was bought. This one describes
     what the supplier's number already contains, and it is the difference
     between charging duty once and charging it twice. */
  test("an import whose duty-inclusion nobody recorded is IN_PROGRESS, not chargeable", () => {
    const r = svc.assess(imported({ dutyInQuotedRate: "" }), { _id: "i1", customsTariffCode: "52085200" });
    expect(r.state).toBe(EVIDENCE.IN_PROGRESS);
    expect(r.blocking).toBe(true);
    expect(r.missing.map((m) => m.field)).toEqual(["sourcing.dutyInQuotedRate"]);
    expect(r.missing[0].owner).toBe("Store");
    /* And it does not settle itself either way: no assumption is recorded. */
    expect(r.dutyInQuotedRate).toBe("");
  });

  test("both answers are complete answers — INCLUDED is not a gap", () => {
    /* A rate that already carries the duty is READY, not missing. What it
       changes is the charge, not the readiness: the costing adds no second
       line. Reading it as an absence would block a quotation that answered
       the question fully. */
    for (const answer of ["INCLUDED", "EXCLUDED"]) {
      const r = svc.assess(imported({ dutyInQuotedRate: answer }), { _id: "i1", customsTariffCode: "52085200" });
      expect([answer, r.state]).toEqual([answer, EVIDENCE.READY]);
      expect([answer, r.dutyInQuotedRate]).toEqual([answer, answer]);
    }
  });

  test("and a DOMESTIC supply is never asked it", () => {
    /* There is no customs entry for duty to be inside. Asking would invent a
       blocker for every locally-bought input in the company. */
    const r = svc.assess({ _id: "o1", sourcing: { type: "DOMESTIC" } }, { _id: "i1" });
    expect(r.state).toBe(EVIDENCE.NOT_APPLICABLE);
    expect(r.missing).toEqual([]);
    expect(r.dutyInQuotedRate).toBe("");
  });
});

/* ══ THE QUOTATION LIFECYCLE ═══════════════════════════════════════════════ */

describe("which quotation carries the evidence", () => {
  test("no quotation is NO_QUOTATION — a different fix from an unanswered one", () => {
    const r = svc.assess(null, { _id: "i1", name: "Jersey" });
    expect(r.state).toBe(EVIDENCE.NO_QUOTATION);
    expect(r.blocking).toBe(true);
    expect(r.missing[0].field).toBe("quotation");
    expect(r.quotation).toBeNull();
  });

  test("only an ACTIVE quotation is read — a draft is not evidence", async () => {
    const co = await company("Alpha");
    const it = await item(co, { tariff: "52085200" });
    await offer(co, it, { status: "DRAFT", sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" } });

    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(it._id)] });
    expect(out.items[0].state).toBe(EVIDENCE.NO_QUOTATION);
    expect(out.complete).toBe(false);
  });

  test("a withdrawn quotation's origin is not cited — the company retracted it", async () => {
    const co = await company("Beta");
    const it = await item(co, { tariff: "52085200" });
    await offer(co, it, {
      status: "WITHDRAWN", sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" },
    });
    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(it._id)] });
    expect(out.items[0].state).toBe(EVIDENCE.NO_QUOTATION);
  });

  test("an expired quotation still carries its statement, marked expired", async () => {
    const co = await company("Gamma");
    const it = await item(co, { tariff: "52085200" });
    await offer(co, it, {
      sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" },
      validUntil: new Date("2026-01-01"),
    });
    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(it._id)] });
    const row = out.items[0];
    /* Expiry is a Store decision to revise, not an absence of evidence: it is
       still the last thing anybody said about where the goods come from. */
    expect(row.state).toBe(EVIDENCE.READY);
    expect(row.quotation.expired).toBe(true);
  });

  test("the most recently effective active quotation is the current statement", async () => {
    const co = await company("Delta");
    const it = await item(co, { tariff: "52085200" });
    await offer(co, it, {
      sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" },
      effectiveFrom: new Date("2026-01-01"),
    });
    await offer(co, it, {
      sourcing: { type: "DOMESTIC" },
      effectiveFrom: new Date("2026-09-01"),
    });
    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(it._id)] });
    expect(out.items[0].sourcingType).toBe("DOMESTIC");
    expect(out.items[0].state).toBe(EVIDENCE.NOT_APPLICABLE);
  });
});

/* ══ COMPANY ISOLATION ═════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("another company's item is not read, and neither is its quotation", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const theirItem = await item(theirs, { tariff: "52085200" });
    await offer(theirs, theirItem, { sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" } });

    const out = await svc.evidenceForItems({ companyId: mine._id }, { itemIds: [String(theirItem._id)] });
    /* Not "unavailable" — not listed. An item id from a Sales record can name
       any item in the deployment, and answering about one would make this a
       lookup oracle dressed as a customs check. */
    expect(out.items).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/Shell fabric|52085200/);
  });

  test("an item of mine whose only quotation is another company's has none", async () => {
    const mine = await company("MineTwo");
    const theirs = await company("TheirsTwo");
    const myItem = await item(mine, { tariff: "52085200" });
    /* Same item id, another company's offer row. */
    await SupplierOffer.create({
      companyId: theirs._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "Foreign",
      itemId: myItem._id, purchaseUom: "Metre", currency: "INR",
      unitPriceMinor: 1, priceBasis: "TAX_EXCLUSIVE", status: "ACTIVE",
      sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" },
    });
    const out = await svc.evidenceForItems({ companyId: mine._id }, { itemIds: [String(myItem._id)] });
    expect(out.items[0].state).toBe(EVIDENCE.NO_QUOTATION);
  });

  test("no company means no read at all", async () => {
    await expect(svc.evidenceForItems({}, { itemIds: ["x"] })).rejects.toThrow(/company is required/i);
  });
});

/* ══ NOTHING COMMERCIAL LEAVES THE PROJECTION ══════════════════════════════ */

describe("what may not cross this boundary", () => {
  test("no rate, tier, supplier name or amount is published", async () => {
    const co = await company("Epsilon");
    const it = await item(co, { tariff: "52085200" });
    await offer(co, it, { sourcing: { type: "IMPORTED", countryOfOrigin: "CN", evidenceNote: "Certificate of origin" } });

    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(it._id)] });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/24500|unitPriceMinor|priceBasis|Mill |supplierName|tiers|moq/i);
    const row = out.items[0];
    expect(row.unitPriceMinor).toBeUndefined();
    expect(row.supplierName).toBeUndefined();
    /* The reference and the dates ARE published — a claim that cannot be
       traced to paper is not evidence. */
    expect(row.quotation.reference).toMatch(/^Q-/);
    expect(row.evidenceNote).toBe("Certificate of origin");
  });

  test("and no duty rate is invented anywhere", () => {
    const source = require("fs").readFileSync(
      require.resolve("../../services/storePurchase/sourcingEvidence.service"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* The table that turns a heading and an origin into a rate is the
       Board's, and it does not exist. Nothing here stands in for it. */
    expect(source).not.toMatch(/dutyRate|dutyPercent|ratePercent|amountMinor/);
  });
});

/* ══ THE SET, ROLLED UP ════════════════════════════════════════════════════ */

describe("a bill of materials answered together", () => {
  test("one unanswered item blocks a set of otherwise complete ones", async () => {
    const co = await company("Zeta");
    const [a, b] = [await item(co, { tariff: "52085200" }), await item(co)];
    await offer(co, a, { sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" } });
    await offer(co, b, {});

    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [String(a._id), String(b._id)] });
    expect(out.complete).toBe(false);
    expect(out.blocking).toHaveLength(1);
    expect(svc.rollUp(out.items).state).toBe(EVIDENCE.MISSING);
  });

  test("all domestic rolls up to not applicable; one imported makes it ready", () => {
    const domestic = svc.assess({ _id: "o", sourcing: { type: "DOMESTIC" } }, { _id: "i" });
    const importedReady = svc.assess(
      { _id: "o2", sourcing: { type: "IMPORTED", countryOfOrigin: "CN", dutyInQuotedRate: "EXCLUDED" } },
      { _id: "i2", customsTariffCode: "52085200" },
    );
    expect(svc.rollUp([domestic, domestic]).state).toBe(EVIDENCE.NOT_APPLICABLE);
    expect(svc.rollUp([domestic, importedReady]).state).toBe(EVIDENCE.READY);
  });

  test("no items is not a blocker — there is nothing to classify", async () => {
    const co = await company("Eta");
    const out = await svc.evidenceForItems({ companyId: co._id }, { itemIds: [] });
    expect(out).toEqual({ items: [], complete: true, blocking: [] });
  });
});
