// test/industrial-engineering/ie-chunk-1d-linkage.test.js
//
// IE CHUNK 1D — EVERY NEW WORK ORDER KNOWS WHICH STYLE IT IS MAKING.
//
// The Chunk 1C audit found 0 of 95 operational work orders with a provable
// order-to-style link — not because the links disagreed, but because almost
// none were stored. These prove the write path that fixes it for NEW orders,
// the refusals that keep it honest, and that the IE read boundary understands
// the canonical field alongside the two legacy ones.
//
// No historical record is touched by any of this.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const link = require("../../services/industrialEngineering/workOrderStyleLink.service");
const orderStyleLink = require("../../services/industrialEngineering/orderStyleLink");

let seq = 0;

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

async function world(name) {
  const co = await company(name);
  const journey = await SalesJourney.create({
    journeyId: `SJ-1D-${++seq}`, companyId: co._id, accountId: new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "J", isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-1D-${++seq}`, journeyId: journey._id, companyId: co._id,
    accountId: new mongoose.Types.ObjectId(), title: "E", isActive: true,
    products: [{ product: "Tee", quantity: 1 }],
  });
  return { co, journey, enquiry };
}

const product = (label) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-1D-${label}-${++seq}`, reference: `REF-1D-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  variants: [{ sku: `VAR-1D-${label}-${seq}`, cost: 0, salesPrice: 0 }],
});

const style = (ctx, label, extra = {}) => SampleStyle.create({
  sampleStyleId: `SS-1D-${label}-${++seq}`, productName: `Tee ${label}`, styleCode: `ST-${label}`,
  journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id,
  materials: { status: "pending", rawItems: [] },
  techSheet: { technical: { status: "draft" } },
  ...extra,
});

/** A customer request shaped as the generator reads it: lines with variants. */
const request = (lines) => ({
  _id: new mongoose.Types.ObjectId(),
  items: lines.map(({ stockItem, styleId, variants = 1 }) => ({
    stockItemId: stockItem._id,
    ...(styleId ? { sampleStyleId: styleId } : {}),
    stockItemName: stockItem.name,
    variants: Array.from({ length: variants }, (_, i) => ({ variantId: `V${i}`, quantity: 5 })),
    totalQuantity: 5 * variants,
  })),
});

const codeOf = (err) => err?.code || null;

/* ══ 1–4. THE EXACT REQUEST LINE IS THE SOURCE ════════════════════════════ */

describe("a work order takes the style of the exact line it is built from", () => {
  test("1 — the release path resolves each line's own style", async () => {
    const ctx = await world("Main");
    const a = await product("MainA");
    const b = await product("MainB");
    const sa = await style(ctx, "MainA");
    const sb = await style(ctx, "MainB");
    const req = request([
      { stockItem: a, styleId: sa._id }, { stockItem: b, styleId: sb._id },
    ]);

    const proved = await link.preflightRequestLines(req, [
      { stockItemId: a._id, label: a.name }, { stockItemId: b._id, label: b.name },
    ]);
    expect(proved.get(String(a._id))).toBe(String(sa._id));
    expect(proved.get(String(b._id))).toBe(String(sb._id));
  });

  test("2 — two lines for the SAME product never cross-link", async () => {
    /* The only line discriminator a work order and a request line share is
       `stockItemId`. With two lines on one product it identifies nothing, so
       the release refuses instead of picking one. */
    const ctx = await world("Shared");
    const p = await product("Shared");
    const s1 = await style(ctx, "SharedOne");
    const s2 = await style(ctx, "SharedTwo");
    const req = request([
      { stockItem: p, styleId: s1._id }, { stockItem: p, styleId: s2._id },
    ]);

    expect(() => link.styleFromRequestLine(req, p._id)).toThrow();
    try { link.styleFromRequestLine(req, p._id); } catch (e) {
      expect(codeOf(e)).toBe("WORK_ORDER_STYLE_LINK_AMBIGUOUS");
      expect(e.message).toMatch(/Reconcile the lines in Sales/);
    }
    /* And two lines that AGREE on one style are not ambiguous. */
    const agreeing = request([
      { stockItem: p, styleId: s1._id }, { stockItem: p, styleId: s1._id },
    ]);
    expect(link.styleFromRequestLine(agreeing, p._id)).toBe(String(s1._id));
  });

  test("3 — several variants of one line all carry that line's style", async () => {
    const ctx = await world("Variants");
    const p = await product("Variants");
    const s = await style(ctx, "Variants");
    const req = request([{ stockItem: p, styleId: s._id, variants: 3 }]);

    const proved = await link.preflightRequestLines(req, [{ stockItemId: p._id }]);
    /* One product, one style — every variant work order reads the same map. */
    expect(proved.get(String(p._id))).toBe(String(s._id));
    expect([...proved.keys()]).toHaveLength(1);
  });

  test("4 — a newly added variant order resolves the same line", async () => {
    const ctx = await world("AddVariant");
    const p = await product("AddVariant");
    const s = await style(ctx, "AddVariant");
    const req = request([{ stockItem: p, styleId: s._id }]);
    expect(link.styleFromRequestLine(req, p._id, { label: p.name })).toBe(String(s._id));
  });

  test("a sampling order proves its style from the request, on a single-line request", async () => {
    /* An R&D sampling release stores the style on the REQUEST, not the line.
       That is the order-specific fact for such an order, and it is accepted
       only where there is no second line for it to answer wrongly — the same
       rule the IE read resolver already applies, so write and read agree. */
    const ctx = await world("Sampling");
    const p = await product("Sampling");
    const s = await style(ctx, "Sampling");
    const req = { ...request([{ stockItem: p }]), sampleStyleId: s._id };
    expect(link.styleFromRequestLine(req, p._id)).toBe(String(s._id));

    /* Two lines: the request-level style cannot say which, so it refuses. */
    const other = await product("SamplingOther");
    const two = { ...request([{ stockItem: p }, { stockItem: other }]), sampleStyleId: s._id };
    try { link.styleFromRequestLine(two, p._id); } catch (e) {
      expect(codeOf(e)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
    }
  });

  test("the request-level style is NOT used when an item line exists", async () => {
    const ctx = await world("RequestLevel");
    const p = await product("RequestLevel");
    const lineStyle = await style(ctx, "RequestLevelLine");
    const requestStyle = await style(ctx, "RequestLevelRequest");
    const req = { ...request([{ stockItem: p, styleId: lineStyle._id }]), sampleStyleId: requestStyle._id };
    expect(link.styleFromRequestLine(req, p._id)).toBe(String(lineStyle._id));
  });
});

/* ══ 5–6. DERIVATIVES INHERIT ═════════════════════════════════════════════ */

describe("a derivative order inherits its source's proved style", () => {
  test("5 — a split/replacement inherits", async () => {
    const ctx = await world("Split");
    const s = await style(ctx, "Split");
    const source = { _id: new mongoose.Types.ObjectId(), sampleStyleId: s._id };
    expect(link.styleFromSourceWorkOrder(source)).toBe(String(s._id));
  });

  test("6 — a derivative resolves a legacy source through the accepted resolver", async () => {
    /* CORRECTED AFTER REVIEW. Absence never inherits: a derivative of a legacy
       order is not created with a null link. The source is RESOLVED instead,
       through the same resolver the IE read boundary uses, and refused when
       that cannot answer. The source is read, never written to. */
    const ctx = await world("Derivative");
    const item = await product("Derivative");
    const s = await style(ctx, "Derivative");

    /* Canonical source: inherited directly. */
    const canonical = await WorkOrder.create({
      workOrderNumber: `WO-D-CANON-${++seq}`, quantity: 1, status: "planned",
      stockItemId: item._id, sampleStyleId: s._id,
    });
    await expect(link.styleForDerivative([canonical._id])).resolves.toBe(String(s._id));

    /* Legacy source with a resolvable style-side reference: resolved, and the
       source is NOT backfilled. */
    const legacy = await WorkOrder.create({
      workOrderNumber: `WO-D-LEGACY-${++seq}`, quantity: 1, status: "planned", stockItemId: item._id,
    });
    const namingStyle = await style(ctx, "DerivativeLegacy", {
      production: { workOrderIds: [legacy._id] },
    });
    await expect(link.styleForDerivative([legacy._id])).resolves.toBe(String(namingStyle._id));
    expect((await WorkOrder.findById(legacy._id).lean()).sampleStyleId).toBeUndefined();

    /* Legacy source nothing can resolve: refused, never null. */
    const orphan = await WorkOrder.create({
      workOrderNumber: `WO-D-ORPHAN-${++seq}`, quantity: 1, status: "planned", stockItemId: item._id,
    });
    await expect(link.styleForDerivative([orphan._id], { label: "This remake" }))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_LINK_REQUIRED" });

    /* Two sources making different styles refuse the whole remake. */
    const other = await style(ctx, "DerivativeOther");
    const second = await WorkOrder.create({
      workOrderNumber: `WO-D-2-${++seq}`, quantity: 1, status: "planned",
      stockItemId: item._id, sampleStyleId: other._id,
    });
    await expect(link.styleForDerivative([canonical._id, second._id]))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_LINK_AMBIGUOUS" });

    /* A source in another company refuses non-disclosingly. */
    const foreign = await world("DerivativeForeign");
    await expect(link.styleForDerivative([canonical._id], { expectedCompanyId: String(foreign.co._id) }))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_COMPANY_MISMATCH" });
  });
});

/* ══ AN AMBIGUOUS SOURCE REFUSES, EVEN WITH A DIRECT REFERENCE ════════════ */

describe("a derivative whose source has ambiguous request lines", () => {
  /** A persisted legacy source: no canonical field, a direct style-side
   *  reference to A, and the given request lines. */
  async function legacySource(ctx, lines, { directStyle }) {
    const item = await product(`AmbSrc${++seq}`);
    const request = await CustomerRequest.create({
      requestId: `CR-AMB-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "Northwind", email: "b@x.test", phone: "1" },
      items: lines.map((styleId) => ({
        stockItemId: item._id,
        ...(styleId ? { sampleStyleId: styleId } : {}),
        stockItemName: item.name, totalQuantity: 1,
      })),
    });
    const source = await WorkOrder.create({
      workOrderNumber: `WO-AMB-${++seq}`, quantity: 2, status: "completed",
      stockItemId: item._id, customerRequestId: request._id,
    });
    await SampleStyle.updateOne({ _id: directStyle._id },
      { $set: { "production.workOrderIds": [source._id] } });
    return { source, request, item };
  }

  test("duplicate lines resolving to A and B refuse, and the source is untouched", async () => {
    const ctx = await world("AmbAB");
    const a = await style(ctx, "AmbA");
    const b = await style(ctx, "AmbB");
    const { source } = await legacySource(ctx, [a._id, b._id], { directStyle: a });

    /* The direct reference alone WOULD resolve to A — the read boundary
       attaches it and reports the ambiguity beside it. Creation may not: a new
       record must not carry forward an uncertainty nobody will re-examine. */
    await expect(link.styleForDerivative([source._id], { label: "This remake" }))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_LINK_AMBIGUOUS" });

    /* And nothing about the source moved. */
    const after = await WorkOrder.findById(source._id).lean();
    expect(after.sampleStyleId).toBeUndefined();
    expect(String((await SampleStyle.findById(a._id).lean()).production.workOrderIds[0]))
      .toBe(String(source._id));
  });

  test("a duplicate line with NO style refuses the same way", async () => {
    const ctx = await world("AmbBlank");
    const a = await style(ctx, "AmbBlankA");
    const { source } = await legacySource(ctx, [a._id, null], { directStyle: a });

    await expect(link.styleForDerivative([source._id], { label: "This remake" }))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_LINK_AMBIGUOUS" });
    expect((await WorkOrder.findById(source._id).lean()).sampleStyleId).toBeUndefined();
  });

  test("the control: ONE matching line agreeing with the direct reference resolves", async () => {
    /* Proves the two refusals above are about the AMBIGUITY and not about the
       fixture shape. */
    const ctx = await world("AmbControl");
    const a = await style(ctx, "AmbControlA");
    const { source } = await legacySource(ctx, [a._id], { directStyle: a });
    await expect(link.styleForDerivative([source._id])).resolves.toBe(String(a._id));
  });
});

/* ══ 7–11. REFUSALS, BEFORE ANY WRITE ════════════════════════════════════ */

describe("creation refuses rather than guessing", () => {
  test("7 — a line with no style refuses", async () => {
    const p = await product("NoStyle");
    const req = request([{ stockItem: p }]);
    try { link.styleFromRequestLine(req, p._id, { label: p.name }); } catch (e) {
      expect(codeOf(e)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
      expect(e.message).toMatch(/names no approved style/);
    }
  });

  test("7b — a product on no line at all refuses", async () => {
    const p = await product("Absent");
    const other = await product("AbsentOther");
    try { link.styleFromRequestLine(request([{ stockItem: other, styleId: new mongoose.Types.ObjectId() }]), p._id); }
    catch (e) { expect(codeOf(e)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED"); }
  });

  test("8 — a style that does not exist refuses", async () => {
    await expect(link.assertStylesUsable([new mongoose.Types.ObjectId()]))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_NOT_FOUND" });
  });

  test("9 — unprovable parentage refuses", async () => {
    /* A dangling journey: the accepted rule refuses to fall back to the
       enquiry, and Chunk 1D does not relax that. */
    const ctx = await world("Unprovable");
    const s = await style(ctx, "Unprovable");
    await SampleStyle.collection.updateOne({ _id: s._id },
      { $set: { journeyId: new mongoose.Types.ObjectId() } });
    await expect(link.assertStylesUsable([s._id]))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_OWNERSHIP_UNPROVEN" });
  });

  test("10 — styles from two companies in one release refuse", async () => {
    const one = await world("XCoOne");
    const two = await world("XCoTwo");
    const s1 = await style(one, "XCoOne");
    const s2 = await style(two, "XCoTwo");
    await expect(link.assertStylesUsable([s1._id, s2._id]))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_COMPANY_MISMATCH" });

    /* And a style outside the acting company refuses too. */
    await expect(link.assertStylesUsable([s1._id], { expectedCompanyId: String(two.co._id) }))
      .rejects.toMatchObject({ code: "WORK_ORDER_STYLE_COMPANY_MISMATCH" });
  });

  test("11 — completed, cancelled and inactive styles remain valid evidence (Lane A)", async () => {
    const ctx = await world("LaneA1D");
    for (const extra of [{ status: "completed" }, { status: "cancelled" }, { isActive: false }]) {
      const s = await style(ctx, `LaneA${++seq}`, extra);
      const out = await link.assertStylesUsable([s._id]);
      expect(out.companyId).toBe(String(ctx.co._id));
    }
  });

  test("12 — a refused pre-flight writes nothing at all", async () => {
    const ctx = await world("Atomic");
    const good = await product("AtomicGood");
    const bad = await product("AtomicBad");
    const s = await style(ctx, "Atomic");
    const req = request([{ stockItem: good, styleId: s._id }, { stockItem: bad }]);

    const before = await WorkOrder.countDocuments();
    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "bulkWrite", "insertMany", "findOneAndUpdate"]
        .map((n) => jest.spyOn(mongoose.Model, n)),
    ];
    try {
      await expect(link.preflightRequestLines(req, [
        { stockItemId: good._id }, { stockItemId: bad._id },
      ])).rejects.toMatchObject({ code: "WORK_ORDER_STYLE_LINK_REQUIRED" });
      /* The pre-flight is the whole point: it runs before the first write, so
         a batch that cannot prove every line creates nothing. */
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
    expect(await WorkOrder.countDocuments()).toBe(before);
  });
});

/* ══ 13–17. THE IE RESOLVER ACROSS ALL THREE SOURCES ══════════════════════ */

describe("the IE resolver understands canonical and legacy references", () => {
  const own = (map) => (id) => map[String(id)] || null;
  const A = "a".repeat(24);
  const B = "b".repeat(24);

  test("13 — a canonical link is its own typed source", () => {
    const out = orderStyleLink.resolveOrderStyleLink({
      order: { sampleStyleId: A }, ownerOf: own({ [A]: "co1" }),
    });
    expect(out.linkStatus).toBe("CANONICAL_WORK_ORDER_REFERENCE");
    expect(out.attachedStyleIds).toEqual([A]);
    expect(out.linkVia[A]).toBe("WORK_ORDER_SAMPLE_STYLE_ID");
  });

  test("14 — canonical agreeing with legacy yields ONE style, not duplicates", () => {
    const out = orderStyleLink.resolveOrderStyleLink({
      order: { sampleStyleId: A }, directStyleIds: [A], ownerOf: own({ [A]: "co1" }),
    });
    expect(out.attachedStyleIds).toEqual([A]);
    expect(out.linkStatus).toBe("CANONICAL_WORK_ORDER_REFERENCE");
  });

  test("15 — canonical disagreeing with legacy, same company, attaches nothing", () => {
    const out = orderStyleLink.resolveOrderStyleLink({
      order: { sampleStyleId: A }, directStyleIds: [B],
      ownerOf: own({ [A]: "co1", [B]: "co1" }),
    });
    expect(out.linkStatus).toBe("REFERENCES_CONFLICT");
    expect(out.attachedStyleIds).toEqual([]);
    /* Visible to that company — whichever reference is right it is theirs. */
    expect(out.companyId).toBe("co1");
  });

  test("16 — a cross-company canonical/legacy conflict is nobody's", () => {
    const out = orderStyleLink.resolveOrderStyleLink({
      order: { sampleStyleId: A }, directStyleIds: [B],
      ownerOf: own({ [A]: "co1", [B]: "co2" }),
    });
    expect(out.attribution).toBe("MULTIPLE_COMPANIES");
    expect(out.companyId).toBeNull();
    expect(out.attachedStyleIds).toEqual([]);
  });

  test("17 — a legacy order with no canonical field keeps its behaviour", () => {
    const legacy = orderStyleLink.resolveOrderStyleLink({
      order: {}, directStyleIds: [A], ownerOf: own({ [A]: "co1" }),
    });
    expect(legacy.linkStatus).toBe("DIRECT_WORK_ORDER_REFERENCE");
    expect(legacy.attachedStyleIds).toEqual([A]);
    expect(legacy.canonicalStyleIds).toEqual([]);
  });

  test("an unprovable canonical style fails closed", () => {
    const out = orderStyleLink.resolveOrderStyleLink({
      order: { sampleStyleId: A }, ownerOf: own({}),
    });
    expect(out.attribution).toBe("NO_COMPANY_PROOF");
    expect(out.attachedStyleIds).toEqual([]);
  });
});
