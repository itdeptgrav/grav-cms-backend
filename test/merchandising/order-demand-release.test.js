// test/merchandising/order-demand-release.test.js
//
// WHEN A CONFIRMED ORDER BECOMES SOMETHING THE COMPANY GOES AND BUYS.
//
// ── THE RULE UNDER TEST ─────────────────────────────────────────────────────
// An approved costing says a PRICE MAY BE QUOTED. It does not say an order
// exists, and it must not cause anything to be bought. Neither does a customer
// approving a quotation, and neither does Merchandising accepting a handover.
//
// Demand becomes eligible only when all five hold together: a genuine confirmed
// order, a known style and quantity, requirements frozen as approved, a
// commercial decision approved for THAT order, and identities that match.
//
// ── AND EACH ONE ALONE PROVES NOTHING ───────────────────────────────────────
// Most of this suite is the negative half: each prerequisite on its own
// releasing nothing. That is the half that catches a future refactor quietly
// re-attaching the release to an approval hook.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

/* ── WHY A REPLICA SET FOR A MOSTLY-MOCKED SUITE ──────────────────────────────
   Replacing an existing release moves two rows — the predecessor out of the
   one-active slot and the successor into it — and the service refuses to do
   that unless it can do it in one transaction. A standalone would make every
   succession test refuse with MERCHANDISING_TRANSACTION_REQUIRED, which is the
   right production behaviour and the wrong thing to assert here. */
let rs;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "demand_release_unit" });
});
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const DemandRelease = require("../../models/CMS_Models/Merchandising/DemandRelease");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

const release = require("../../services/merchandising/orderDemandRelease.service");
const access = require("../../services/merchandising/access.service");
const projectionHandoff = require("../../services/centralCosting/projectionHandoff.service");
const approvedOutput = require("../../services/centralCosting/approvedOutput.service");
const costingDemand = require("../../services/requests/costingDemand.service");

const { CAPABILITY, ROLE_CAPABILITIES } = access;

/** A file with its prose removed — a comment naming a service is not a call. */
const bare = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^[ \t]*\/\/.*$/gm, "");
let seq = 0;

const ctxOf = (co, role) => ({ companyId: co._id, role });
const actor = { id: "u1", name: "M Manager" };

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return null;
};

/**
 * A confirmed order line, its chosen style, and an APPROVED floor-priced
 * costing version whose frozen scenario matches the ordered quantity.
 *
 * Everything a release rests on is seeded as a real record, so a test that
 * removes one of them is removing a genuine precondition rather than a flag.
 */
async function world({
  status = "quotation_sales_approved",
  quantity = 500,
  costedQuantity = null,
  versionStatus = "APPROVED",
  contract = "floor",
  bomApprovalStatus = "approved",
  sampleStatus = "approved",
  withCostingSource = true,
} = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Rel ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-R-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-R-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-R-${n}`, styleCode: `SC-R-${n}`, companyId: co._id,
    productName: `R${n} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
  });

  const costing = await Costing.create({
    companyId: co._id,
    context: { type: "ENQUIRY_STYLE", primaryId: enquiry._id, externalKey: `R${n} polo` },
    contextSnapshot: { label: `R${n} polo` },
    baseCurrency: "INR", status: "DRAFT",
  });

  const scenarioQuantity = String(costedQuantity ?? quantity);
  const version = await CostingVersion.create({
    companyId: co._id, costingId: costing._id, versionNumber: 1,
    status: versionStatus, baseCurrency: "INR",
    calculation: { engineVersion: 1, calculatedAt: new Date() },
    scenarios: [{
      key: "q1", label: scenarioQuantity, quantity: scenarioQuantity, isPrimary: true,
      unitCostMinor: 12640, totalCostMinor: 12640 * Number(scenarioQuantity),
      ...(contract === "floor"
        ? { floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 12640, markupAmountMinor: 2528, floorPriceMinor: 15200,
        } }
        : { prices: {
          minimum: { requestedMarginPercent: "10", priceMinor: 14000, effectiveMarginPercent: "10" },
        } }),
    }],
    sourceReferences: [{
        sourceType: "BOM", sourceKey: `SS-R-${n}`, confidence: "VERIFIED",
        snapshot: [
          { key: "styleCode", text: `SC-R-${n}` },
          { key: "bomApprovalStatus", text: bomApprovalStatus },
          { key: "bomApprovalRound", num: 2 },
          { key: "sampleStatus", text: sampleStatus },
      ],
    }],
    provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
  });

  const request = await CustomerRequest.create({
    requestId: `REQ-R-${n}`, companyId: co._id, status, orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{ stockItemName: `R${n} polo`, totalQuantity: quantity, sampleStyleId: style._id }],
    /* ── THE APPROVED PRICE LIVES ON THE QUOTATION LINE ────────────────
       Not on the order line. The stored join between the two is the style,
       which is why `sampleStyleId` exists on a quotation item at all. */
    quotations: withCostingSource
      ? [{
        quotationNumber: `Q-R-${n}`,
        status: "sales_approved",
        currency: "INR",
        items: [{
          itemName: `R${n} polo`,
          sampleStyleId: style._id,
          quantity,
          /* The figure the customer was quoted, in MAJOR units — written
             together with the provenance by `quotationPricing`. */
          unitPrice: 152,
          basePrice: 152,
          costingSource: {
            source: "APPROVED_COSTING",
            costingId: costing._id,
            costingVersionId: version._id,
            costingVersionNumber: 1,
            sampleStyleId: style._id,
            styleCode: `SC-R-${n}`,
            productName: `R${n} polo`,
            scenarioKey: "q1",
            quantity: String(quantity),
            priceTier: "floor",
            unitPriceMinor: 15200,
            currency: "INR",
            approvedAt: new Date(),
            /* The canonical fingerprint over the six identities. Required —
               an absent one cannot be verified and is refused. */
            fingerprint: approvedOutput.fingerprintOf({
              costingId: String(costing._id),
              versionId: String(version._id),
              scenarioKey: "q1",
              tier: "floor",
              priceMinor: 15200,
              currency: "INR",
            }),
          },
        }],
      }]
      : [],
  });

  const saved = await CustomerRequest.findById(request._id).lean();
  return {
    co, style, costing, version, request,
    orderId: String(request._id),
    lineRef: String(saved.items[0].lineRef),
    costingVersionId: String(version._id),
    quantity,
  };
}

/**
 * Sales recosts for a new run size and the quotation is repriced.
 *
 * A costing version is immutable, so a quantity nobody costed cannot be added
 * to the approved one — the real answer is a new approved version, and the
 * quotation line is restamped to it.
 */
async function recost(w, quantity) {
  const version = await CostingVersion.create({
    companyId: w.co._id, costingId: w.costing._id, versionNumber: 2,
    status: "APPROVED", baseCurrency: "INR",
    calculation: { engineVersion: 1, calculatedAt: new Date() },
    scenarios: [{
      key: "q2", label: String(quantity), quantity: String(quantity), isPrimary: true,
      unitCostMinor: 12000, totalCostMinor: 12000 * quantity,
      floor: {
        floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
        trueUnitCostMinor: 12000, markupAmountMinor: 2400, floorPriceMinor: 14400,
      },
    }],
    sourceReferences: [{
      sourceType: "BOM", sourceKey: "recost", confidence: "VERIFIED",
      snapshot: [
        { key: "styleCode", text: "SC" },
        { key: "bomApprovalStatus", text: "approved" },
        { key: "bomApprovalRound", num: 2 },
        { key: "sampleStatus", text: "approved" },
      ],
    }],
    provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
  });

  await CustomerRequest.updateOne({ _id: w.request._id }, {
    $set: {
      "items.0.totalQuantity": quantity,
      "quotations.0.items.0.quantity": quantity,
      "quotations.0.items.0.costingSource.costingVersionId": version._id,
      "quotations.0.items.0.costingSource.costingVersionNumber": 2,
      "quotations.0.items.0.costingSource.scenarioKey": "q2",
      "quotations.0.items.0.costingSource.quantity": String(quantity),
      "quotations.0.items.0.costingSource.unitPriceMinor": 14400,
      "quotations.0.items.0.unitPrice": 144,
      "quotations.0.items.0.basePrice": 144,
      "quotations.0.items.0.costingSource.fingerprint": approvedOutput.fingerprintOf({
        costingId: String(w.costing._id),
        versionId: String(version._id),
        scenarioKey: "q2",
        tier: "floor",
        priceMinor: 14400,
        currency: "INR",
      }),
    },
  });
  return version;
}

/**
 * The spend requests a release raised, as the Requests domain really stores
 * them. Seeded so their STATUS is a real one the active-list recognises.
 */
async function seedRequests(w, ids, status) {
  await SpendRequest.insertMany(ids.map((id, i) => ({
    _id: id,
    companyId: w.co._id,
    requestNumber: `SR-${++seq}-${i}`,
    requestType: i === 0 ? "PRODUCT" : "SERVICE",
    status,
    title: "Released demand",
    purpose: "Confirmed order line",
    requestedBy: new mongoose.Types.ObjectId(),
    createdByEmployee: new mongoose.Types.ObjectId(),
    items: [{
      name: "Fabric", whyNeeded: "Confirmed order line",
      quantity: 100, unit: "Metre", rate: 100, amount: 10000,
    }],
  })));
}

const args = (w, over = {}) => ({
  orderId: w.orderId, lineRef: w.lineRef, costingVersionId: w.costingVersionId, actor, ...over,
});

/** The handoff is the existing authority; this suite is about the gate. */
const stubHandoff = () => {
  jest.spyOn(projectionHandoff, "prepare").mockResolvedValue({
    available: true,
    requirements: [
      { requirementId: "mat:a::MATERIAL", selectable: true },
      { requirementId: "svc:b::SERVICE", selectable: true },
    ],
  });
  jest.spyOn(projectionHandoff, "handoff").mockImplementation(async () => ({
    mode: "CREATED",
    drafts: [{ _id: new mongoose.Types.ObjectId() }, { _id: new mongoose.Types.ObjectId() }],
    productRequest: { _id: new mongoose.Types.ObjectId() },
    serviceRequest: { _id: new mongoose.Types.ObjectId() },
  }));
};

afterEach(() => jest.restoreAllMocks());

/* ═══ 1 · WHO MAY RELEASE ════════════════════════════════════════════════ */

describe("the release authority", () => {
  test("it is a Merchandising grant at approver and above, and Sales holds none of it", () => {
    expect(CAPABILITY.PROCUREMENT_RELEASE).toBe("procurement.demand.release");
    expect(ROLE_CAPABILITIES.viewer.has(CAPABILITY.PROCUREMENT_RELEASE)).toBe(false);
    /* An editor states requirements; releasing them is a commitment. */
    expect(ROLE_CAPABILITIES.editor.has(CAPABILITY.PROCUREMENT_RELEASE)).toBe(false);
    expect(ROLE_CAPABILITIES.approver.has(CAPABILITY.PROCUREMENT_RELEASE)).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has(CAPABILITY.PROCUREMENT_RELEASE)).toBe(true);
    expect(access.minimumRoleFor(CAPABILITY.PROCUREMENT_RELEASE)).toBe("approver");
  });

  test("no Sales capability grants it — confirming an order is not committing to buy", () => {
    const costingCaps = require("../../services/centralCosting/capabilities");
    const sales = costingCaps.capabilitiesFromGrants(
      [{ departmentSlug: "sales", role: "owner" }], false,
    ).capabilities;
    expect(sales).not.toContain(CAPABILITY.PROCUREMENT_RELEASE);
    /* Nor does the commercial approver's grant, which decides the PRICE. */
    expect(sales).not.toContain("procurement.demand.release");
  });

  test("a Merchandising viewer and editor are refused, and write nothing", async () => {
    stubHandoff();
    const w = await world();
    for (const role of ["viewer", "editor"]) {
      const err = await refusalOf(() => release.release(ctxOf(w.co, role), args(w)));
      expect(err.code).toBe(release.CODES.FORBIDDEN);
      expect(err.details.required).toBe(CAPABILITY.PROCUREMENT_RELEASE);
    }
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("an approver releases", async () => {
    stubHandoff();
    const w = await world();
    const out = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(out.outcome).toBe("RELEASED");
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ═══ 2 · EACH PREREQUISITE ALONE IS NOT ENOUGH ══════════════════════════ */

describe("what alone releases nothing", () => {
  test("an approved costing on an UNCONFIRMED order releases nothing", async () => {
    stubHandoff();
    /* The costing is approved and the line is priced from it. The order is
       not confirmed, and that is the whole difference. */
    const w = await world({ status: "quotation_customer_approved" });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.code).toBe(release.CODES.NOT_ELIGIBLE);
    expect(err.details.reason).toBe(release.BLOCKED.ORDER_NOT_CONFIRMED);
    expect(await DemandRelease.countDocuments({})).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("CUSTOMER approval alone is not confirmation", async () => {
    /* `quotation_customer_approved` still awaits Sales' own sign-off. */
    expect(release.CONFIRMED_STATUSES).not.toContain("quotation_customer_approved");
    expect(release.CONFIRMED_STATUSES).toContain("quotation_sales_approved");
    for (const notConfirmed of ["draft", "pending", "quotation_sent", "rejected", "cancelled", "on_hold"]) {
      expect(release.CONFIRMED_STATUSES).not.toContain(notConfirmed);
    }
  });

  test("a confirmed order with NO approved costing releases nothing", async () => {
    stubHandoff();
    const w = await world({ withCostingSource: false });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.NO_COSTING_SOURCE);
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a costing version that is not APPROVED releases nothing", async () => {
    stubHandoff();
    const w = await world({ versionStatus: "IN_REVIEW" });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.COSTING_NOT_APPROVED);
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("requirements not frozen as approved release nothing", async () => {
    stubHandoff();
    for (const over of [{ bomApprovalStatus: "pending" }, { sampleStatus: "pending" }]) {
      const w = await world(over);
      const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
      expect(err.details.reason).toBe(release.BLOCKED.REQUIREMENTS_NOT_APPROVED);
    }
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a historical MARGIN_BAND_V1 costing releases nothing", async () => {
    stubHandoff();
    const w = await world({ contract: "band" });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.HISTORICAL_CONTRACT);
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });
});

/* ═══ 3 · THE QUANTITY MUST BE ONE THAT WAS COSTED ═══════════════════════ */

describe("the ordered quantity", () => {
  test("a quantity nobody costed is refused with an explicit recost blocker", async () => {
    /* ── AND NOTHING IS DERIVED ───────────────────────────────────────
       Not the nearest scenario, not consumption multiplied out, not an
       interpolation. A purchase quantity nobody approved is a purchase
       nobody approved. */
    stubHandoff();
    const w = await world({ quantity: 750, costedQuantity: 500 });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));

    expect(err.code).toBe(release.CODES.RECOST_REQUIRED);
    expect(err.details.reason).toBe(release.BLOCKED.QUANTITY_NOT_COSTED);
    expect(err.message).toMatch(/recost for the ordered quantity/i);
    expect(err.details.orderedQuantity).toBe("750");
    /* The quantities that WERE approved, so the gap is visible. */
    expect(err.details.approvedQuantities).toEqual(["500"]);

    expect(await DemandRelease.countDocuments({})).toBe(0);
    expect(projectionHandoff.handoff).not.toHaveBeenCalled();
  });

  test("an exactly matching quantity releases", async () => {
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const out = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(out.outcome).toBe("RELEASED");
    expect(out.subject.orderedQuantity).toBe("500");
    expect(out.subject.scenarioKey).toBe("q1");
  });
});

/* ═══ 4 · IDENTITY ══════════════════════════════════════════════════════ */

describe("identity", () => {
  test("the command must name order, line and costing version", async () => {
    const w = await world();
    for (const over of [{ orderId: "" }, { lineRef: "" }, { costingVersionId: "" }, { orderId: "nope" }]) {
      const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w, over)));
      expect(err.code).toBe(release.CODES.IDENTITY_REQUIRED);
    }
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a costing version the line was NOT priced from is refused", async () => {
    stubHandoff();
    const w = await world();
    const other = await world();
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: other.costingVersionId })));
    /* Company-scoped read finds nothing, or the line mismatch names it —
       either way, nothing is released. */
    expect(err).toBeTruthy();
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("another company's order is not found, never forbidden", async () => {
    stubHandoff();
    const mine = await world();
    const theirs = await world();
    const err = await refusalOf(() => release.release(ctxOf(mine.co, "approver"), args(theirs)));
    expect(err.code).toBe(release.CODES.NOT_FOUND);
    expect(await DemandRelease.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("an unknown line reference on a real order is refused", async () => {
    stubHandoff();
    const w = await world();
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { lineRef: "LINE-THAT-DOES-NOT-EXIST" })));
    expect(err.details.reason).toBe(release.BLOCKED.LINE_NOT_FOUND);
  });
});

/* ═══ 5 · WHAT A RELEASE PRODUCES ═══════════════════════════════════════ */

describe("the demand it produces", () => {
  test("it delegates to the existing handoff and creates drafts only", async () => {
    stubHandoff();
    const w = await world();
    await release.release(ctxOf(w.co, "approver"), args(w));

    expect(projectionHandoff.handoff).toHaveBeenCalledTimes(1);
    const [, sent] = projectionHandoff.handoff.mock.calls[0];
    /* ── NOTHING THE CALLER SENT DESCRIBES A QUANTITY ──────────────────
       The scenario key and the requirement ids are the server's, derived
       from the frozen approved version. */
    expect(sent.scenarioKey).toBe("q1");
    expect(sent.requirementIds).toEqual(["mat:a::MATERIAL", "svc:b::SERVICE"]);
    expect(sent).not.toHaveProperty("quantity");
    expect(sent).not.toHaveProperty("supplierId");
    expect(sent).not.toHaveProperty("rate");
  });

  test("the record carries identities and quantities, and no money at all", async () => {
    stubHandoff();
    const w = await world();
    await release.release(ctxOf(w.co, "approver"), args(w));

    const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(String(row.orderId)).toBe(w.orderId);
    expect(row.lineRef).toBe(w.lineRef);
    expect(row.orderedQuantity).toBe("500");
    expect(String(row.costingVersionId)).toBe(w.costingVersionId);
    expect(row.requirementRevision.bomApprovalStatus).toBe("approved");
    expect(row.pricingContract).toBe("MARKUP_FLOOR_V2");

    const body = JSON.stringify(row);
    for (const secret of [
      "floorMarkupPercent", "trueUnitCostMinor", "markupAmountMinor", "floorPriceMinor",
      "unitCostMinor", "totalCostMinor", "supplierName", "supplierId", "unitPriceMinor",
      "ratePercent", "policySnapshot",
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test("the projection Merchandising reads carries no money either", async () => {
    stubHandoff();
    const w = await world();
    await release.release(ctxOf(w.co, "approver"), args(w));
    const state = await release.stateFor(ctxOf(w.co, "approver"), args(w));

    expect(state.subject.orderedQuantity).toBe("500");
    expect(state.releases).toHaveLength(1);
    const body = JSON.stringify(state);
    for (const secret of ["floorPriceMinor", "unitCostMinor", "markupAmount", "supplier", "priceMinor"]) {
      expect(body).not.toContain(secret);
    }
  });

  test("no purchase order, supplier choice or reservation is made", async () => {
    stubHandoff();
    const w = await world();
    await release.release(ctxOf(w.co, "approver"), args(w));

    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    expect(await PurchaseOrder.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ═══ 6 · RETRY AND SUCCESSION ══════════════════════════════════════════ */

describe("releasing twice", () => {
  test("an exact retry creates no second demand", async () => {
    stubHandoff();
    const w = await world();
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const again = await release.release(ctxOf(w.co, "approver"), args(w));

    expect(first.outcome).toBe("RELEASED");
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(first.releaseId);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    /* And the handoff was asked exactly once. */
    expect(projectionHandoff.handoff).toHaveBeenCalledTimes(1);
  });

  test("a successor is REFUSED while the earlier demand is still open", async () => {
    /* ── BUYING THE SAME LINE TWICE IS THE FAILURE ────────────────────
       Marking the old release SUPERSEDED does nothing to the requests it
       raised. If those are still live, Store now holds two sets of demand
       for one order line and will buy against both. */
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(first.outcome).toBe("RELEASED");

    /* The earlier drafts are live — `submitted` is an active status. */
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "submitted");

    const recosted = await recost(w, 800);
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) })));

    expect(err.code).toBe(release.CODES.RECONCILIATION_REQUIRED);
    expect(err.details.reason).toBe(release.BLOCKED.PRIOR_DEMAND_ACTIVE);
    expect(err.details.priorReleaseId).toBe(first.releaseId);
    expect(err.details.openRequests).toHaveLength(2);
    expect(err.details.remedy).toBe("CLOSE_IN_REQUESTS");

    /* ── AND MERCHANDISING CLOSED NOTHING ITSELF ──────────────────────
       The requests are exactly as they were. A department reaching into
       another's records to tidy them is how an approval trail stops
       meaning anything. */
    const still = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(still.every((r) => r.status === "submitted")).toBe(true);
    /* No successor was created, and the first release still stands. */
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect((await DemandRelease.findById(first.releaseId).lean()).state).toBe("RELEASED");
  });

  test("once the earlier demand is closed, the successor is explicit", async () => {
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "submitted");

    /* Closed through the OWNING workflow — Requests, not Merchandising. */
    await SpendRequest.updateMany(
      { _id: { $in: priorRow.demand.spendRequestIds } },
      { $set: { status: "rejected" } },
    );

    const recosted = await recost(w, 800);
    const second = await release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) }));

    expect(second.outcome).toBe("RELEASED_SUPERSEDING");
    expect(second.supersededReleaseId).toBe(first.releaseId);

    const rows = await DemandRelease.find({ companyId: w.co._id }).sort({ releasedAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("SUPERSEDED");
    expect(String(rows[0].supersededByReleaseId)).toBe(second.releaseId);
    expect(rows[0].orderedQuantity).toBe("500");
    /* The earlier row's own demand references survive: those requests were
       really raised, and the history of what was asked for must remain. */
    expect(rows[0].demand.spendRequestIds).toHaveLength(2);
    expect(rows[1].state).toBe("RELEASED");
    expect(rows[1].orderedQuantity).toBe("800");
    expect(String(rows[1].supersedesReleaseId)).toBe(first.releaseId);
    expect(rows[1].costingVersionNumber).toBe(2);
  });

  test("a release row cannot be edited afterwards", async () => {
    stubHandoff();
    const w = await world();
    await release.release(ctxOf(w.co, "approver"), args(w));
    const row = await DemandRelease.findOne({ companyId: w.co._id });

    const err = await refusalOf(() => DemandRelease.updateOne(
      { _id: row._id }, { $set: { orderedQuantity: "9999" } },
    ));
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/immutable/i);
  });
});

/* ═══ 6b · THE EXACT FROZEN SOURCE ══════════════════════════════════════ */

describe("the quotation source must be the exact one", () => {
  /** Tamper with one field of the frozen provenance and try to release. */
  const tamper = async (w, $set) => {
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set });
    return refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
  };

  test("a version with ANOTHER scenario at the ordered quantity is not enough", async () => {
    /* ── THE CASE THIS EXISTS FOR ─────────────────────────────────────
       The named version contains a scenario whose quantity matches the
       order — but the quotation was priced from a DIFFERENT scenario.
       Releasing against the matching one would buy for a run size nobody
       quoted, and every other identity would look perfectly correct. */
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    /* A second approved version carrying a scenario at the SAME quantity
       under a different key — the quotation was not priced from it. The
       first version is left alone: a costing version is immutable. */
    const v2 = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 2, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [
        { key: "qOther", label: "500", quantity: "500", isPrimary: true,
          unitCostMinor: 12640, totalCostMinor: 6320000,
          floor: { floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
            trueUnitCostMinor: 12640, markupAmountMinor: 2528, floorPriceMinor: 15200 } },
      ],
      sourceReferences: [{ sourceType: "BOM", sourceKey: "x", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: "SC" }, { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 }, { key: "sampleStatus", text: "approved" }] }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });
    /* The quotation still names scenario `q1`, which this version lacks. */
    await CustomerRequest.updateOne({ _id: w.request._id },
      { $set: { "quotations.0.items.0.costingSource.costingVersionId": v2._id } });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(v2._id) })));
    expect(err.details.reason).toBe(release.BLOCKED.SCENARIO_MISMATCH);
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a tampered quantity, scenario, style, tier or price is refused by name", async () => {
    stubHandoff();
    const cases = [
      [{ "quotations.0.items.0.costingSource.quantity": "9999" }, release.BLOCKED.QUANTITY_MISMATCH],
      [{ "quotations.0.items.0.costingSource.scenarioKey": "qNope" }, release.BLOCKED.SCENARIO_MISMATCH],
      [{ "quotations.0.items.0.costingSource.sampleStyleId": new mongoose.Types.ObjectId() },
        release.BLOCKED.STYLE_MISMATCH],
      [{ "quotations.0.items.0.costingSource.priceTier": "target" }, release.BLOCKED.HISTORICAL_CONTRACT],
      [{ "quotations.0.items.0.costingSource.unitPriceMinor": 999 }, release.BLOCKED.PRICE_MISMATCH],
      [{ "quotations.0.items.0.costingSource.costingId": new mongoose.Types.ObjectId() },
        release.BLOCKED.COSTING_MISMATCH],
    ];
    for (const [$set, reason] of cases) {
      const w = await world();
      const err = await tamper(w, $set);
      expect(err.details.reason).toBe(reason);
    }
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a fingerprint that no longer matches its own facts is refused", async () => {
    /* ── NON-VACUOUS: THE GOOD ONE IS ACCEPTED FIRST ──────────────────
       A canonical fingerprint is stamped, proved to release, and only then
       corrupted — so this cannot pass because the check never ran. */
    stubHandoff();
    const good = await world();
    const canonical = approvedOutput.fingerprintOf({
      costingId: String(good.costing._id),
      versionId: String(good.version._id),
      scenarioKey: "q1", tier: "floor", priceMinor: 15200, currency: "INR",
    });
    await CustomerRequest.updateOne({ _id: good.request._id },
      { $set: { "quotations.0.items.0.costingSource.fingerprint": canonical } });
    expect((await release.release(ctxOf(good.co, "approver"), args(good))).outcome).toBe("RELEASED");

    const bad = await world();
    await CustomerRequest.updateOne({ _id: bad.request._id },
      { $set: { "quotations.0.items.0.costingSource.fingerprint": `${canonical.slice(0, 30)}zz` } });
    const err = await refusalOf(() => release.release(ctxOf(bad.co, "approver"), args(bad)));
    expect(err.details.reason).toBe(release.BLOCKED.FINGERPRINT_MISMATCH);
  });

  test("a house-sample order cannot release", async () => {
    stubHandoff();
    const w = await world();
    await CustomerRequest.updateOne({ _id: w.request._id }, { $set: { orderOrigin: "in_house" } });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.NOT_A_CUSTOMER_ORDER);
  });
});

/* ═══ 6c · A FOREIGN ORDER IS SIMPLY NOT FOUND ══════════════════════════ */

describe("ownership is proved before anything is said", () => {
  /* ── EVERY BUSINESS REFUSAL CONFIRMS THE ORDER EXISTS ──────────────────
     "That order is not confirmed yet" tells a stranger there is an order.
     So ownership is proved first, and a foreign record answers exactly as
     one that never existed — whatever is wrong with it. */
  const foreignCases = [
    ["an unconfirmed foreign order", { status: "quotation_customer_approved" }],
    ["a foreign order with no costing source", { withCostingSource: false }],
    ["a foreign order priced by a retired band", { contract: "band" }],
    ["a foreign order with unapproved requirements", { bomApprovalStatus: "pending" }],
    ["a foreign order costed for another quantity", { quantity: 750, costedQuantity: 500 }],
  ];

  for (const [label, over] of foreignCases) {
    test(`${label} is NOT_FOUND, never a business refusal`, async () => {
      stubHandoff();
      const mine = await world();
      const theirs = await world(over);

      const err = await refusalOf(() => release.release(ctxOf(mine.co, "approver"), args(theirs)));
      expect(err.code).toBe(release.CODES.NOT_FOUND);
      /* Nothing about the other company's order leaked into the answer. */
      const body = JSON.stringify({ m: err.message, d: err.details || {} });
      expect(body).not.toContain("confirmed");
      expect(body).not.toContain(String(theirs.costingVersionId));
      expect(await DemandRelease.countDocuments({})).toBe(0);
    });
  }

  test("a foreign order with a missing line reference is also NOT_FOUND", async () => {
    stubHandoff();
    const mine = await world();
    const theirs = await world();
    const err = await refusalOf(() => release.release(ctxOf(mine.co, "approver"),
      args(theirs, { lineRef: "NO-SUCH-LINE" })));
    expect(err.code).toBe(release.CODES.NOT_FOUND);
  });

  test("the same faults on my OWN order are named, so refusals stay useful", async () => {
    /* The mirror of the above: ownership proved, so the real reason is told. */
    stubHandoff();
    const w = await world({ status: "quotation_customer_approved" });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.ORDER_NOT_CONFIRMED);
  });
});

/* ═══ 6d · A PARTIAL WRITE IS FINISHED, NEVER REPEATED ══════════════════ */

describe("recovering an interrupted release", () => {
  /**
   * The REAL handoff, with its own idempotency record.
   *
   * ── WHY A MOCK WAS NOT ENOUGH ───────────────────────────────────────────
   * The earlier fault test stubbed `prepare()` as selectable on every call.
   * In production, once the first attempt has created requests, those
   * requirements read as already spoken for and a re-derived selection is
   * EMPTY — so a recovery that re-ran selection would refuse a release that
   * had in fact succeeded.
   *
   * `handoff` is left completely alone here: its idempotency record, its
   * SpendRequest writes and its replay path are all real. Only `prepare` is
   * stubbed, to supply two requirement ids — and it is stubbed to report
   * them UNSELECTABLE from the second call onward, which is exactly what the
   * real projection does once requests exist.
   */
  const realHandoff = () => {
    let calls = 0;
    jest.spyOn(projectionHandoff, "prepare").mockImplementation(async () => {
      calls += 1;
      const selectable = calls === 1;
      return {
        available: true,
        requirements: [
          { requirementId: "mat:a::MATERIAL", selectable },
          { requirementId: "svc:b::SERVICE", selectable },
        ],
      };
    });
  };

  /* ── THE REAL-HANDOFF PROOF LIVES IN ITS OWN FILE ─────────────────────
     `order-demand-release.integration.test.js` runs this same interruption
     against the REAL projection, the real `SpendRequest` writes and the real
     handoff idempotency record — on a replica set, because the Requests
     domain refuses to create the product and service requests unless it can
     write them together.

     It proves what a stub cannot: that after the first attempt the
     projection genuinely reports nothing selectable, and that the replay of
     the FROZEN command still returns the same request ids. It found a real
     defect doing so — the released ids were being stored empty, because the
     Requests domain returns `requestId` summaries rather than documents.

     What stays here is the saga shape: the claim, the boundaries, and the
     healing. Those need a fault at an exact instant, which is easier to aim
     precisely with the handoff stubbed. */

  test("a crash BEFORE the handoff leaves a claim the retry completes", async () => {
    const w = await world();
    realHandoff();
    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });

    const crashed = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(crashed).toBeTruthy();
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    const claims = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(claims).toHaveLength(1);
    expect(claims[0].state).toBe("PENDING");

    jest.restoreAllMocks();
    stubHandoff();
    const done = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(done.outcome).toBe("RECOVERED");
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect((await DemandRelease.findById(done.releaseId).lean()).state).toBe("RELEASED");
  });

  test("a crash between RELEASED and the predecessor link is healed by the retry", async () => {
    /* ── THE THIRD BOUNDARY ───────────────────────────────────────────
       The successor is RELEASED and the predecessor has already left the
       active slot, but the back-pointer was never written. A retry must
       finish the chain and create nothing. */
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "rejected");
    const recosted = await recost(w, 800);

    let updates = 0;
    const realUpdate = DemandRelease.updateOne.bind(DemandRelease);
    jest.spyOn(DemandRelease, "updateOne").mockImplementation((...a) => {
      updates += 1;
      /* 1 vacates the slot, 2 stamps the demand, 3 writes the back-pointer. */
      if (updates === 3) throw new Error("simulated crash before the successor link");
      return realUpdate(...a);
    });

    const crashed = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) })));
    expect(crashed).toBeTruthy();

    DemandRelease.updateOne = realUpdate;
    jest.restoreAllMocks();
    stubHandoff();

    const mid = await DemandRelease.find({ companyId: w.co._id }).sort({ releasedAt: 1 }).lean();
    expect(mid).toHaveLength(2);
    expect(mid[0].state).toBe("SUPERSEDED");
    expect(mid[0].supersededByReleaseId).toBeFalsy();

    const healed = await release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) }));
    expect(healed.outcome).toBe("ALREADY_RELEASED");

    const rows = await DemandRelease.find({ companyId: w.co._id }).sort({ releasedAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    /* Exactly one current row, and the chain is complete. */
    expect(rows.filter((r) => r.state === "RELEASED")).toHaveLength(1);
    expect(String(rows[0].supersededByReleaseId)).toBe(String(rows[1]._id));
  });

  test("an exact retry after a completed release still creates nothing", async () => {
    stubHandoff();
    const w = await world();
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const again = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(first.releaseId);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ═══ 6e · ONE ACTIVE RELEASE PER ORDER LINE ════════════════════════════ */

describe("concurrency", () => {
  test("two differing successors cannot both become actionable", async () => {
    /* ── THE KEY ALONE CANNOT SEPARATE THEM ───────────────────────────
       Different costing versions hash to different release keys, so the key
       would let both claim. The partial unique index over PENDING/RELEASED
       for one order line is what refuses the second. */
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "rejected");

    const a = await recost(w, 800);
    const b = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 3, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q3", label: "800", quantity: "800", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 8800000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "b", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: "SC" }, { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 }, { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });

    await Promise.allSettled([
      release.release(ctxOf(w.co, "approver"), args(w, { costingVersionId: String(a._id) })),
      release.release(ctxOf(w.co, "approver"), args(w, { costingVersionId: String(b._id) })),
    ]);

    /* At most one row occupies the active slot — the other is refused, not
       admitted as a second set of actionable drafts. */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows.filter((r) => ["PENDING", "RELEASED"].includes(r.state))).toHaveLength(1);
  });
});

/* ═══ 6e-2 · THE REPLACEMENT BOUNDARY ═══════════════════════════════════ */

describe("replacing an existing release", () => {
  /**
   * A successor takes the one active slot from its predecessor. That is two
   * row changes, and they used to be two statements: vacate, then claim.
   * Everything between them was a window in which the line could be left with
   * a superseded predecessor and no successor at all — and the next attempt,
   * finding nothing RELEASED, would write a successor claiming to supersede
   * nothing. The chain would be gone, with no record that it had existed.
   *
   * These tests hold the boundary shut from both sides: nothing before the
   * swap may move the predecessor, and nothing after it may lose the link.
   */

  /** A settled predecessor, and the recosted version that would replace it. */
  async function replaceable() {
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "rejected");
    const recosted = await recost(w, 800);
    return { w, first, priorRow, next: args(w, { costingVersionId: String(recosted._id) }) };
  }

  const rowsOf = (co) => DemandRelease.find({ companyId: co._id }).sort({ releasedAt: 1 }).lean();

  test("a command that cannot be resolved leaves the predecessor RELEASED", async () => {
    /* ── THE REFUSAL THAT USED TO COST THE CHAIN ──────────────────────
       Selection now runs BEFORE the predecessor is touched, so a line whose
       requirements are no longer releasable is left exactly as it was
       found: still current, still the thing Merchandising is working to. */
    const { w, first, next } = await replaceable();

    jest.spyOn(projectionHandoff, "prepare").mockResolvedValue({
      available: false,
      reason: "REQUIREMENTS_NOT_APPROVED",
      message: "The requirements for this scenario are not approved.",
    });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(err).toBeTruthy();
    expect(err.code).toBe(release.CODES.NOT_ELIGIBLE);

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(first.releaseId));
    expect(rows[0].state).toBe("RELEASED");
    expect(rows[0].supersededAt).toBeFalsy();
  });

  test("nothing left to select leaves the predecessor RELEASED", async () => {
    /* The other resolution refusal: approved, but every requirement already
       spoken for. Same rule — no row moves. */
    const { w, first, next } = await replaceable();

    jest.spyOn(projectionHandoff, "prepare").mockResolvedValue({
      available: true,
      requirements: [
        { requirementId: "mat:a::MATERIAL", selectable: false },
        { requirementId: "svc:b::SERVICE", selectable: false },
      ],
    });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(err).toBeTruthy();

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("RELEASED");
    expect(String(rows[0]._id)).toBe(String(first.releaseId));
  });

  test("a failure between the two mutations rolls the vacate back", async () => {
    /* ── THE PROOF THAT THE SWAP IS ONE UNIT ──────────────────────────
       The predecessor's update has already run inside the transaction when
       the successor's insert fails. If the two were separate statements the
       line would now hold a superseded predecessor and nothing else. Inside
       one transaction the update is undone with it. */
    const { w, first, next } = await replaceable();

    jest.spyOn(DemandRelease, "create").mockImplementationOnce(() => {
      throw new Error("simulated failure between the vacate and the claim");
    });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/between the vacate and the claim/);

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(first.releaseId));
    /* Rolled back, not merely un-pointed. */
    expect(rows[0].state).toBe("RELEASED");
    expect(rows[0].supersededAt).toBeFalsy();
    expect(rows[0].supersededByReleaseId).toBeFalsy();

    /* And the line is still releasable — the refusal cost nothing. */
    jest.restoreAllMocks();
    stubHandoff();
    const done = await release.release(ctxOf(w.co, "approver"), next);
    expect(done.outcome).toBe("RELEASED_SUPERSEDING");
  });

  test("a crash after the swap commits leaves a linked PENDING successor", async () => {
    /* ── THE OTHER SIDE OF THE BOUNDARY ───────────────────────────────
       Once the swap commits, the successor exists and names its
       predecessor. The handoff has not run. A retry must finish that claim
       rather than start a new one. */
    const { w, first, next } = await replaceable();

    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash after the swap, before the handoff");
    });

    const crashed = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(crashed).toBeTruthy();

    const mid = await rowsOf(w.co);
    expect(mid).toHaveLength(2);
    expect(String(mid[0]._id)).toBe(String(first.releaseId));
    expect(mid[0].state).toBe("SUPERSEDED");
    expect(mid[1].state).toBe("PENDING");
    /* The link the old ordering could lose. */
    expect(String(mid[1].supersedesReleaseId)).toBe(String(first.releaseId));
    expect(mid[1].handoffCommand.requirementIds.length).toBeGreaterThan(0);

    jest.restoreAllMocks();
    stubHandoff();
    const recovered = await release.release(ctxOf(w.co, "approver"), next);
    expect(recovered.outcome).toBe("RECOVERED");
    expect(recovered.releaseId).toBe(String(mid[1]._id));

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(2);
    expect(rows[1].state).toBe("RELEASED");
    expect(rows[1].demand.spendRequestIds).toHaveLength(2);
  });

  test("a completed retry heals the succession link in both directions", async () => {
    /* Successor names predecessor at the claim; predecessor names successor
       at completion. A crash between them leaves the second half missing,
       and the retry must write it — and a further retry must change
       nothing. */
    const { w, first, next } = await replaceable();

    let updates = 0;
    const realUpdate = DemandRelease.updateOne.bind(DemandRelease);
    jest.spyOn(DemandRelease, "updateOne").mockImplementation((...a) => {
      updates += 1;
      /* 1 vacates inside the swap, 2 stamps the demand, 3 links back. */
      if (updates === 3) throw new Error("simulated crash before the back-pointer");
      return realUpdate(...a);
    });

    const crashed = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(crashed).toBeTruthy();

    DemandRelease.updateOne = realUpdate;
    jest.restoreAllMocks();
    stubHandoff();

    const mid = await rowsOf(w.co);
    expect(mid).toHaveLength(2);
    /* Forward link present, back link missing — exactly the half-state. */
    expect(String(mid[1].supersedesReleaseId)).toBe(String(first.releaseId));
    expect(mid[0].supersededByReleaseId).toBeFalsy();

    const healed = await release.release(ctxOf(w.co, "approver"), next);
    expect(healed.outcome).toBe("ALREADY_RELEASED");

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(2);
    expect(String(rows[0].supersededByReleaseId)).toBe(String(rows[1]._id));
    expect(String(rows[1].supersedesReleaseId)).toBe(String(rows[0]._id));
    expect(rows.filter((r) => ["PENDING", "RELEASED"].includes(r.state))).toHaveLength(1);

    /* Repeating it changes nothing. */
    const again = await release.release(ctxOf(w.co, "approver"), next);
    expect(again.outcome).toBe("ALREADY_RELEASED");
    const after = await rowsOf(w.co);
    expect(after).toHaveLength(2);
    expect(String(after[0].supersededByReleaseId)).toBe(String(after[1]._id));
  });

  test("two concurrent different successors produce one release and one demand set", async () => {
    /* ── THE KEY CANNOT SEPARATE THEM; THE SWAP CAN ───────────────────
       Different costing versions hash to different release keys, so the key
       would let both claim. Each successor's swap names the predecessor AND
       the state it was validated in, so the second finds nothing to move.
       The partial unique index remains the backstop for the case with no
       predecessor to move at all. */
    const { w, first, next } = await replaceable();

    const other = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 3, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q3", label: "800", quantity: "800", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 8800000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "b", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: "SC" }, { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 }, { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });

    jest.restoreAllMocks();
    stubHandoff();

    const settled = await Promise.allSettled([
      release.release(ctxOf(w.co, "approver"), next),
      release.release(ctxOf(w.co, "approver"), args(w, { costingVersionId: String(other._id) })),
    ]);

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rows = await rowsOf(w.co);
    const active = rows.filter((r) => ["PENDING", "RELEASED"].includes(r.state));
    expect(active).toHaveLength(1);

    /* ── AND ONLY ONE SET OF ACTIONABLE DEMAND ────────────────────────
       The refused successor never reached the handoff, so no second batch
       of drafts was raised for this order line. */
    expect(projectionHandoff.handoff).toHaveBeenCalledTimes(1);
    expect(active[0].demand.spendRequestIds).toHaveLength(2);

    /* The predecessor is superseded exactly once, by the winner. */
    const superseded = rows.filter((r) => r.state === "SUPERSEDED");
    expect(superseded).toHaveLength(1);
    expect(String(superseded[0]._id)).toBe(String(first.releaseId));
    expect(String(active[0].supersedesReleaseId)).toBe(String(first.releaseId));
  });

  test("a deployment without transactions refuses before either row moves", async () => {
    /* ── FAIL CLOSED ──────────────────────────────────────────────────
       Where the swap cannot be guaranteed, it is not attempted. Losing a
       release is recoverable; losing the chain is not. */
    const { w, first, next } = await replaceable();

    const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
    jest.spyOn(unitOfWork, "transactionsAvailable").mockResolvedValue(false);

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), next));
    expect(err.code).toBe("MERCHANDISING_TRANSACTION_REQUIRED");
    expect(err.status).toBe(503);

    const rows = await rowsOf(w.co);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(first.releaseId));
    expect(rows[0].state).toBe("RELEASED");
  });
});

/* ═══ 6g · A COMMITTED CLAIM IS RECOVERED BY IDENTITY ═══════════════════ */

describe("claim recovery precedes source revalidation", () => {
  /** A committed PENDING claim: the handoff died before it raised anything. */
  async function pendingClaim(over = {}) {
    stubHandoff();
    const w = await world(over);
    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });
    const crashed = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(crashed).toBeTruthy();
    const claim = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(claim.state).toBe("PENDING");
    return { w, claim };
  }

  test("a different version cannot hijack the claim on that line", async () => {
    /* ── EXACT-VERSION IDENTITY IS WHAT MAKES RECOVERY SAFE ───────────
       A claim froze a command for ONE approved version. Naming a different
       version is not a recovery of it, and it cannot start a release of its
       own either — the line's one active slot is taken. Fail closed. */
    const { w, claim } = await pendingClaim({ quantity: 500, costedQuantity: 500 });
    jest.restoreAllMocks();
    stubHandoff();

    const other = await recost(w, 800);
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(other._id) })));

    expect(err.code).toBe(release.CODES.RECONCILIATION_REQUIRED);
    expect(err.details.reason).toBe(release.BLOCKED.PRIOR_DEMAND_ACTIVE);
    expect(err.details.inProgressReleaseId).toBe(String(claim._id));

    /* The claim is untouched: same version, same frozen command, still PENDING
       and still the only row. */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("PENDING");
    expect(String(rows[0].costingVersionId)).toBe(String(w.costingVersionId));
    expect(rows[0].handoffCommand.idempotencyKey)
      .toBe(claim.handoffCommand.idempotencyKey);
    /* And the hijack attempt raised nothing. */
    expect(projectionHandoff.handoff).not.toHaveBeenCalled();

    /* The rightful version still recovers it. */
    const done = await release.release(ctxOf(w.co, "approver"), args(w));
    expect(done.outcome).toBe("RECOVERED");
    expect(done.releaseId).toBe(String(claim._id));
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("another company's active claim is not found, exactly as a missing one is", async () => {
    /* ── THE LOOKUP IS COMPANY-SCOPED, SO IT CANNOT BE AN ORACLE ──────
       A claim in progress is a fact about somebody's order. A stranger
       naming that order must get the answer they would get for an order
       that does not exist — not "already in progress", which would confirm
       both the order and the work. */
    const { w: theirs, claim } = await pendingClaim();
    jest.restoreAllMocks();
    stubHandoff();
    const mine = await world();

    const foreign = await refusalOf(() => release.release(ctxOf(mine.co, "approver"), args(theirs)));
    const missing = await refusalOf(() => release.release(ctxOf(mine.co, "approver"),
      args(theirs, { orderId: String(new mongoose.Types.ObjectId()) })));

    expect(foreign.code).toBe(release.CODES.NOT_FOUND);
    expect(missing.code).toBe(release.CODES.NOT_FOUND);
    expect(foreign.message).toBe(missing.message);
    expect(foreign.details?.reason ?? null).toBe(missing.details?.reason ?? null);

    const body = JSON.stringify({ m: foreign.message, d: foreign.details || {} });
    expect(body).not.toContain("progress");
    expect(body).not.toContain(String(claim._id));

    /* The other company's claim is exactly as it was, and nothing was raised. */
    const rows = await DemandRelease.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("PENDING");
    expect(projectionHandoff.handoff).not.toHaveBeenCalled();
  });

  test("with no claim on the line, a new attempt still runs every source check", async () => {
    /* ── THE SHORT PATH IS FOR RECOVERY ONLY ──────────────────────────
       Nothing about looking for a claim first may let a first release skip
       verification. With no row on the line, the full `subjectFor` runs and
       names the exact fault. */
    stubHandoff();
    const w = await world();
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);

    await CustomerRequest.updateOne({ _id: w.orderId }, {
      $set: { "quotations.0.items.0.costingSource.fingerprint": "no-longer-matching" },
    });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.code).toBe(release.CODES.NOT_ELIGIBLE);
    expect(err.details.reason).toBe(release.BLOCKED.FINGERPRINT_MISMATCH);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(projectionHandoff.handoff).not.toHaveBeenCalled();
  });

  test("an unconfirmed order is still refused when nothing has been claimed", async () => {
    /* The other half of the same rule: order state is checked in full on a
       new attempt, and only bypassed for a command already started. */
    stubHandoff();
    const w = await world({ status: "quotation_customer_approved" });
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"), args(w)));
    expect(err.details.reason).toBe(release.BLOCKED.ORDER_NOT_CONFIRMED);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ═══ 6f · PRIOR DEMAND MUST BE FULLY ACCOUNTED FOR ═════════════════════ */

describe("unaccounted prior demand", () => {
  test("a prior request that cannot be found refuses the successor", async () => {
    /* ── MISSING IS NOT CLOSED ────────────────────────────────────────
       A release names the requests it raised. If one cannot be found its
       state is UNKNOWN — and treating unknown as closed is how one order
       line gets bought twice without anybody seeing it happen. */
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    /* Only ONE of the two referenced requests exists, and it is closed. */
    await seedRequests(w, [priorRow.demand.spendRequestIds[0]], "rejected");

    const recosted = await recost(w, 800);
    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) })));

    expect(err.code).toBe(release.CODES.RECONCILIATION_REQUIRED);
    expect(err.details.reason).toBe(release.BLOCKED.PRIOR_DEMAND_UNVERIFIABLE);
    expect(err.details.missingRequestCount).toBe(1);
    /* The predecessor is untouched and still current. */
    expect((await DemandRelease.findById(first.releaseId).lean()).state).toBe("RELEASED");
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a read failure is reported as unknown, never as 'nothing is active'", async () => {
    stubHandoff();
    const w = await world({ quantity: 500, costedQuantity: 500 });
    const first = await release.release(ctxOf(w.co, "approver"), args(w));
    const priorRow = await DemandRelease.findById(first.releaseId).lean();
    await seedRequests(w, priorRow.demand.spendRequestIds, "rejected");
    const recosted = await recost(w, 800);

    jest.spyOn(SpendRequest, "find").mockImplementationOnce(() => {
      throw new Error("simulated database read failure");
    });

    const err = await refusalOf(() => release.release(ctxOf(w.co, "approver"),
      args(w, { costingVersionId: String(recosted._id) })));

    expect(err.code).toBe(release.CODES.RECONCILIATION_REQUIRED);
    expect(err.details.reason).toBe(release.BLOCKED.PRIOR_DEMAND_UNVERIFIABLE);
    expect(err.details.retryable).toBe(true);
    /* The underlying failure is never published. */
    expect(JSON.stringify(err.details)).not.toContain("simulated");
  });

  test("stateOfRequests distinguishes closed, active and missing", async () => {
    const w = await world();
    const present = new mongoose.Types.ObjectId();
    const absent = new mongoose.Types.ObjectId();
    await seedRequests(w, [present], "rejected");

    const closed = await costingDemand.stateOfRequests({ companyId: w.co._id }, [present]);
    expect(closed).toMatchObject({ anyActive: false, accounted: true, unreadable: false });

    const partial = await costingDemand.stateOfRequests({ companyId: w.co._id }, [present, absent]);
    expect(partial.accounted).toBe(false);
    expect(partial.missing).toEqual([String(absent)]);
    /* Missing is reported separately, not folded into "active". */
    expect(partial.anyActive).toBe(false);

    const none = await costingDemand.stateOfRequests({ companyId: w.co._id }, []);
    expect(none).toMatchObject({ accounted: true, anyActive: false });
  });
});

/* ═══ 7 · NOTHING ELSE RELEASES ═════════════════════════════════════════ */

describe("the side effects that must not exist", () => {
  test("approving a costing version releases nothing", async () => {
    /* The lifecycle moves a status and writes evidence. It has never called
       the handoff, and this is the assertion that keeps it that way. */
    const lifecycle = require("../../services/centralCosting/lifecycle.service");
    const src = bare(require("fs").readFileSync(
      require.resolve("../../services/centralCosting/lifecycle.service"), "utf8",
    ));
    for (const forbidden of ["projectionHandoff", "costingDemand", "SpendRequest", "demandRelease"]) {
      expect(src).not.toContain(forbidden);
    }
    expect(typeof lifecycle.approve).toBe("function");
  });

  test("issuing a Merchandising handover releases nothing", async () => {
    /* ── SCANNED WITH THE PROSE REMOVED ───────────────────────────────
       The producer's own comments legitimately NAME the release service —
       it explains why `loadOwnedRequest` is exported to it. A comment is not
       a call, and a scan that could not tell them apart would either fail on
       documentation or force the documentation out. */
    const src = bare(require("fs").readFileSync(
      require.resolve("../../services/sales/merchandisingHandover.service"), "utf8",
    ));
    for (const forbidden of ["orderDemandRelease", "projectionHandoff", "SpendRequest", "costingDemand"]) {
      expect(src).not.toContain(forbidden);
    }
  });

  test("the customer approval flow is untouched by any of this", async () => {
    const src = require("fs").readFileSync(
      require.resolve("../../services/merchandising/orderDemandRelease.service"), "utf8",
    );
    /* This service never reaches the customer token flow, and never writes
       the customer approval log. */
    expect(src).not.toContain("customerApprovalLog");
    expect(src).not.toContain("costing-approval");
  });

  test("the legacy Costing projection route is marked deprecated and gains no caller", () => {
    const src = require("fs").readFileSync(
      require.resolve("../../routes/CMS_Routes/Costing/costings"), "utf8",
    );
    expect(src).toMatch(/DEPRECATED — releasing demand moved to the confirmed order/);
    expect(src).toMatch(/demand-release/);
  });
});
