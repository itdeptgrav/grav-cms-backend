// test/store-purchase/governed-po-chain.test.js
//
// A2 — THE MATERIAL PURCHASE ORDER MUST PROVE WHY IT EXISTS.
//
// The governed chain:
//   material request (MRF) → purchase shortfall → PRODUCT spend request →
//   Finance approval → purchase order
//
// The MRF proves the material is genuinely needed. The spend request remains
// the authority for sourcing, Finance approval and budget. An MRF on its own is
// not budget approval, and a purchase order with neither is a commitment to a
// supplier that no one can trace back to a need.
//
// ── WHAT THESE TESTS ARE REALLY GUARDING ────────────────────────────────────
// Not "a field is populated". Every case here is one where a plausible-looking
// order could be raised against money nobody approved, a quantity already
// bought, or a need that belongs to another company.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

require("../../models/ProjectManager");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Acc_BudgetCommitment = require("../../models/Accountant_model/Acc_BudgetCommitment");

const governed = require("../../services/storePurchase/governedPurchaseOrder.service");

let seq = 0;
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

/** A tenant context of the kind `requireTenant` puts on the request. */
const tenantFor = (co) => ({
  companyId: co._id,
  siteId: null,
  actorId: new mongoose.Types.ObjectId(),
  legacyMode: false,
});

async function rawItem(name = "Cotton Twill") {
  return RawItem.create({ name: `${name} ${++seq}`, sku: `SKU-${seq}`, unit: "m" });
}

/**
 * One MRF with a real purchase shortfall on its single line.
 *
 * `buyQty` is the shortfall — deliberately NOT `requestedQty − issuedQty`,
 * which is merely "short" and may be a line nobody has decided to buy.
 */
async function mrfWithShortfall(co, over = {}) {
  const ri = over.rawItem || (await rawItem());
  return MRF.create({
    companyId: co._id,
    mrfNumber: over.mrfNumber || `MRF/${++seq}`,
    requestedFor: new mongoose.Types.ObjectId(),
    requestedForName: "Meena",
    requestedForDept: over.department || "Cutting",
    createdByRef: new mongoose.Types.ObjectId(),
    createdByModel: "Employee",
    /* The model's own required field: how the material is consumed, not what
       kind of request this is. */
    requestType: "USES_BASED",
    status: over.status || "APPROVED",
    fulfilmentDecision: over.fulfilmentDecision || "buy_or_service",
    items: over.items || [{
      rawItem: ri._id,
      rawItemName: ri.name,
      rawItemSku: ri.sku,
      requestedQty: 100,
      unit: "m",
      issuedQty: over.issuedQty ?? 0,
      buyQty: over.buyQty ?? 100,
      itemStatus: "PENDING",
    }],
    ...(over.spendRequestId ? { spendRequestId: over.spendRequestId } : {}),
    ...(over.spendRequestNumber ? { spendRequestNumber: over.spendRequestNumber } : {}),
  });
}

/** An approved PRODUCT spend request raised from that MRF. */
async function approvedRequestFor(co, mrf, over = {}) {
  const line = mrf.items[0];
  const doc = await SpendRequest.collection.insertOne({
    companyId: co._id,
    requestNumber: over.requestNumber || `SR/${++seq}`,
    title: over.title || "Cotton twill shortfall",
    purpose: "Cutting shortfall",
    requestType: over.requestType || "PRODUCT",
    status: over.status || "approved",
    department: mrf.requestedForDept,
    requestedBy: new mongoose.Types.ObjectId(),
    requestedByName: "Meena",
    sourceMrfId: over.sourceMrfId !== undefined ? over.sourceMrfId : mrf._id,
    sourceMrfNumber: over.sourceMrfNumber !== undefined ? over.sourceMrfNumber : mrf.mrfNumber,
    budgetApprovalKind: over.budgetApprovalKind || "within_budget",
    ...(over.commitmentId ? { commitmentId: over.commitmentId } : {}),
    ...(over.purchaseOrderId ? { purchaseOrderId: over.purchaseOrderId } : {}),
    items: over.items || [{
      _id: new mongoose.Types.ObjectId(),
      name: line.rawItemName,
      whyNeeded: "Shortfall on the cutting request",
      /* Line-level provenance, exactly as the MRF flow writes it: which
         material-request line this buys, and what that line said it was. */
      sourceMrfLineId: over.sourceMrfLineId !== undefined ? over.sourceMrfLineId : line._id,
      rawItem: over.rawItem !== undefined ? over.rawItem : line.rawItem,
      rawItemSku: line.rawItemSku,
      variantId: over.variantId !== undefined ? over.variantId : (line.variantId || null),
      quantity: over.quantity ?? line.buyQty,
      unit: over.unit || line.unit,
      rate: over.rate ?? 120,
      amount: (over.quantity ?? line.buyQty) * (over.rate ?? 120),
      gstPercent: 5,
      /* The approved tax on this line. The allocator reads `amount + taxAmount`
         when there is no `lineTotal`, so a line without it allocates its net
         only and cannot cover an order that includes tax. */
      taxAmount: ((over.quantity ?? line.buyQty) * (over.rate ?? 120)) * 0.05,
      ...(over.vendorId ? { vendorId: over.vendorId } : {}),
      vendorName: over.vendorName || "Northwind Textiles",
    }],
    /* The payable figure: lines + tax, plus any approved adjustments. A stored
       total that does not follow from its own parts fails closed downstream,
       which is the point — so the fixture states a consistent one. */
    grandTotal: over.grandTotal ?? (
      (over.quantity ?? line.buyQty) * (over.rate ?? 120) * 1.05
      + (over.approvedShippingCharges || 0)
      + (over.approvedCustomCharges || []).reduce((t, c) => t + c.amount, 0)
      - (over.approvedDiscount || 0)
    ),
    ...(over.approvedShippingCharges !== undefined ? { approvedShippingCharges: over.approvedShippingCharges } : {}),
    ...(over.approvedDiscount !== undefined ? { approvedDiscount: over.approvedDiscount } : {}),
    ...(over.approvedCustomCharges !== undefined ? { approvedCustomCharges: over.approvedCustomCharges } : {}),
    createdAt: new Date(),
  });
  const saved = await SpendRequest.findById(doc.insertedId);

  /* ── FINANCE'S PROMISE, AND THE RULES IT WAS MADE UNDER ──────────────────
     A missing commitment is no longer read as "budget review was paused" —
     that would make a deleted or corrupt promise look like a deliberate
     policy. So the ordinary fixture carries a real commitment and the mode
     marker that says one is required; the paused case is set explicitly where
     it is being tested. */
  if (over.budgetMode !== "BUDGET_PAUSED" && over.commitment !== false) {
    const c = await Acc_BudgetCommitment.create({
      spendRequestId: saved._id,
      companyId: co._id,
      /* The GRAND total, as the approval workflow reserves it — 100 × 120
         plus 5% GST. Committing the subtotal would leave the tax
         unpromised, which is the case the amount check exists for. */
      amount: over.commitmentAmount ?? 12600,
      status: over.commitmentStatus || "committed",
    });
    await SpendRequest.collection.updateOne({ _id: saved._id }, {
      $set: {
        commitmentId: c._id,
        commitmentStatus: c.status,
        budgetApprovalMode: "COMMITMENT_REQUIRED",
        budgetApprovalModeAt: new Date(),
        budgetApprovalModeSource: "test fixture",
      },
    });
  } else if (over.budgetMode === "BUDGET_PAUSED") {
    await SpendRequest.collection.updateOne({ _id: saved._id }, {
      $set: {
        budgetApprovalMode: "BUDGET_PAUSED",
        budgetApprovalModeAt: new Date(),
        budgetApprovalModeSource: "test fixture",
      },
    });
  }

  if (over.linkBack !== false) {
    await MRF.updateOne({ _id: mrf._id }, {
      $set: { spendRequestId: saved._id, spendRequestNumber: saved.requestNumber },
    });
  }
  return SpendRequest.findById(saved._id);
}

const actor = () => ({ _id: new mongoose.Types.ObjectId(), name: "Store User" });

/** Every refusal in this suite is a coded business outcome, never a 500. */
async function refusal(fn) {
  try {
    await fn();
    throw new Error("expected a refusal, but the call succeeded");
  } catch (e) {
    if (!e.code && !e.code) throw e;
    return e;
  }
}

/* ══ 1–3. THE MRF ITSELF ═════════════════════════════════════════════════ */

describe("the source MRF is mandatory and must be this company's", () => {
  it("refuses a material purchase order with no MRF at all", async () => {
    const co = await company();
    const e = await refusal(() => governed.resolveChain(tenantFor(co), {}));
    expect(e.code).toBe("MRF_REQUIRED");
  });

  it("refuses an MRF id that does not exist", async () => {
    const co = await company();
    const e = await refusal(() =>
      governed.resolveChain(tenantFor(co), { sourceMrfId: new mongoose.Types.ObjectId() }));
    expect(e.code).toBe("MRF_UNAVAILABLE");
  });

  it("refuses a malformed MRF id without throwing a cast error", async () => {
    const co = await company();
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: "not-an-id" }));
    expect(["MRF_REQUIRED", "MRF_UNAVAILABLE"]).toContain(e.code);
  });

  it("another company's MRF is indistinguishable from one that does not exist", async () => {
    const mine = await company();
    const theirs = await company();
    const foreign = await mrfWithShortfall(theirs, { mrfNumber: "MRF/SECRET" });

    const e = await refusal(() =>
      governed.resolveChain(tenantFor(mine), { sourceMrfId: foreign._id }));
    /* The same code as a missing record: a different one would confirm the MRF
       exists, which is itself the leak. */
    expect(e.code).toBe("MRF_UNAVAILABLE");
    /* And nothing about it travels in the message or the details. */
    const said = JSON.stringify({ m: e.message, d: e.details || {} });
    expect(said).not.toContain("MRF/SECRET");
    expect(said).not.toContain("Cutting");
    expect(said).not.toContain(String(theirs._id));
  });
});

/* ══ 4–5. A SHORTFALL, AND A REQUEST FOR IT ══════════════════════════════ */

describe("the MRF must carry a real purchase shortfall with a request", () => {
  it("refuses an MRF whose lines were all issued from stock", async () => {
    const co = await company();
    /* Issued in full and nothing decided to buy: `buyQty` is zero. */
    const mrf = await mrfWithShortfall(co, {
      buyQty: 0, issuedQty: 100, fulfilmentDecision: "issue_from_stock",
    });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("MRF_NO_PURCHASE_SHORTFALL");
  });

  it("a short line nobody decided to buy is not a purchase shortfall", async () => {
    const co = await company();
    /* 40 of 100 issued — short, but `buyQty` is 0, so no one has decided to
       buy the difference. Treating "short" as "buy" would order material
       against a decision nobody made. */
    const mrf = await mrfWithShortfall(co, { buyQty: 0, issuedQty: 40 });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("MRF_NO_PURCHASE_SHORTFALL");
  });

  it("refuses a shortfall that has no linked purchase request", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("MRF_NO_PURCHASE_REQUEST");
    /* And it says where to go, because the buyer's next step is upstream. */
    expect(e.details?.correction).toBeTruthy();
  });

  it("refuses when the request is a SERVICE, not a material one", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { requestType: "SERVICE" });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("MRF_NO_PURCHASE_REQUEST");
  });
});

/* ══ 5–7. THE REQUEST MUST AGREE WITH THE MRF, AND BE APPROVED ═══════════ */

describe("the linked request must match the MRF and be authorised", () => {
  it("refuses a request whose sourceMrfId points elsewhere", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const other = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { sourceMrfId: other._id, sourceMrfNumber: other.mrfNumber });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("REQUEST_MRF_MISMATCH");
  });

  it("refuses a request whose stored MRF number contradicts its id", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { sourceMrfNumber: "MRF/SOMETHING-ELSE" });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("REQUEST_MRF_MISMATCH");
  });

  it("refuses a request belonging to another company", async () => {
    const mine = await company();
    const theirs = await company();
    const mrf = await mrfWithShortfall(mine);
    await approvedRequestFor(theirs, mrf);
    const e = await refusal(() => governed.resolveChain(tenantFor(mine), { sourceMrfId: mrf._id }));
    expect(["REQUEST_MRF_MISMATCH", "MRF_NO_PURCHASE_REQUEST"]).toContain(e.code);
  });

  it.each(["draft", "submitted", "pending_tl", "pending_finance", "requester_confirmed"])(
    "refuses a request still at %s", async (status) => {
      const co = await company();
      const mrf = await mrfWithShortfall(co);
      await approvedRequestFor(co, mrf, { status });
      const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
      expect(e.code).toBe("REQUEST_NOT_APPROVED");
    });

  it.each(["rejected", "cancelled", "budget_exception"])(
    "refuses a %s request", async (status) => {
      const co = await company();
      const mrf = await mrfWithShortfall(co);
      await approvedRequestFor(co, mrf, { status });
      const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
      expect(e.code).toBe("REQUEST_NOT_APPROVED");
    });

  it("accepts a request that was in budget_exception and has since been approved", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { status: "budget_exception" });
    /* The existing workflow moved it on. The refusal is about the state NOW,
       never about where it has been. */
    await SpendRequest.updateOne({ _id: sr._id }, { $set: { status: "approved" } });
    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(chain.spendRequest.status).toBe("approved");
  });
});

/* ══ 8. FINANCE MAY ALWAYS APPROVE ══════════════════════════════════════ */

describe("every Finance decision the workflow treats as approved is honoured", () => {
  it.each(["within_budget", "over_budget", "unbudgeted"])(
    "a Finance-approved %s decision is not rejected", async (kind) => {
      const co = await company();
      const mrf = await mrfWithShortfall(co);
      await approvedRequestFor(co, mrf, { budgetApprovalKind: kind });
      /* Finance may always approve; what changes is what the approval is ON
         THE RECORD as. Reading anything but `within_budget` as invalid would
         block exactly the spending Finance deliberately signed off. */
      const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
      expect(chain.spendRequest.budgetApprovalKind).toBe(kind);
      expect(chain.budget.authorised).toBe(true);
    });

  it("an approved request with no recorded decision is still authorised by its status", async () => {
    /* MRF budget involvement can be switched off, in which case the request is
       created already approved and never carries a decision. Demanding one
       would block every purchase under that configuration. */
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.updateOne({ _id: sr._id }, { $unset: { budgetApprovalKind: "" } });
    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(chain.budget.authorised).toBe(true);
    expect(chain.budget.kind).toBeNull();
  });
});

/* ══ 9–12. THE HAPPY PATH, AND WHAT THE CLIENT CANNOT CHANGE ════════════ */

describe("a complete chain produces a governed order", () => {
  it("resolves MRF → approved request → orderable lines", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);

    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(String(chain.mrf._id)).toBe(String(mrf._id));
    expect(String(chain.spendRequest._id)).toBe(String(sr._id));
    expect(chain.lines).toHaveLength(1);
    expect(chain.lines[0].quantity).toBe(100);
    expect(chain.lines[0].unitPrice).toBe(120);
  });

  it("every line carries the approved spend line it came from", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(String(chain.lines[0].spendLineId)).toBe(String(sr.items[0]._id));
  });

  it("client-supplied quantity, rate, tax, item, supplier and company are ignored", async () => {
    const co = await company();
    const other = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const chain = await governed.resolveChain(tenantFor(co), {
      sourceMrfId: mrf._id,
      /* Everything a hostile or confused client could send. */
      companyId: other._id,
      items: [{ rawItem: new mongoose.Types.ObjectId(), quantity: 99999, unitPrice: 1, gstRate: 0 }],
      vendor: new mongoose.Types.ObjectId(),
      vendorName: "Somebody Else",
      subtotal: 1, taxAmount: 0, totalAmount: 1,
    });

    /* Every authoritative value comes from the reloaded records. */
    expect(String(chain.companyId)).toBe(String(co._id));
    expect(chain.lines).toHaveLength(1);
    expect(chain.lines[0].quantity).toBe(100);
    expect(chain.lines[0].unitPrice).toBe(120);
    expect(chain.vendorName).toBe("Northwind Textiles");
    expect(chain.totals.subtotal).toBe(12000);
  });
});

/* ══ 13–14. QUANTITY IS FINITE AND SPENDABLE ONCE ═══════════════════════ */

describe("approved quantity cannot be exceeded or ordered twice", () => {
  it("refuses a quantity above the remaining approved amount", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const e = await refusal(() => governed.resolveChain(tenantFor(co), {
      sourceMrfId: mrf._id,
      requestedLines: [{ quantity: 101 }],
    }));
    expect(e.code).toBe("QUANTITY_EXCEEDS_APPROVED");
  });

  it("refuses an approved quantity that an existing order already covers", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await PurchaseOrder.create({
      companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED",
      spendRequestId: sr._id, spendRequestNumber: sr.requestNumber,
      createdBy: new mongoose.Types.ObjectId(), vendorName: "Northwind Textiles",
      subtotal: 0, taxAmount: 0, totalAmount: 12000,
      items: [{
        _id: new mongoose.Types.ObjectId(), rawItem: mrf.items[0].rawItem,
        spendLineId: sr.items[0]._id, itemName: "Cotton", sku: "S", unit: "m",
        quantity: 100, unitPrice: 120, totalPrice: 12000,
        receivedQuantity: 0, pendingQuantity: 100, status: "PENDING",
      }],
    });

    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("QUANTITY_ALREADY_ORDERED");
  });

  it("a cancelled order does not consume the approved quantity", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await PurchaseOrder.create({
      companyId: co._id, poNumber: `PO/${++seq}`, status: "CANCELLED",
      spendRequestId: sr._id, spendRequestNumber: sr.requestNumber,
      createdBy: new mongoose.Types.ObjectId(), vendorName: "Northwind Textiles",
      subtotal: 0, taxAmount: 0, totalAmount: 12000,
      items: [{
        _id: new mongoose.Types.ObjectId(), rawItem: mrf.items[0].rawItem,
        spendLineId: sr.items[0]._id, itemName: "Cotton", sku: "S", unit: "m",
        quantity: 100, unitPrice: 120, totalPrice: 12000,
        receivedQuantity: 0, pendingQuantity: 100, status: "CANCELLED",
      }],
    });
    /* A cancelled order bought nothing, so the money is still available. */
    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(chain.lines[0].quantity).toBe(100);
  });
});

/* ══ 32. MULTIPLE SUPPLIERS — GOVERNED, NOT BYPASSED ════════════════════ */

describe("a multi-supplier shortfall has a governed answer", () => {
  it("refuses one order for two suppliers and sends the buyer upstream", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const ri2 = await rawItem("Poplin");
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.updateOne({ _id: sr._id }, {
      $push: {
        items: {
          _id: new mongoose.Types.ObjectId(),
          name: ri2.name, whyNeeded: "second supplier", rawItem: ri2._id,
          quantity: 10, unit: "m", rate: 50, amount: 500,
          vendorId: new mongoose.Types.ObjectId(), vendorName: "Second Supplier",
        },
      },
    });

    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("SUPPLIER_SPLIT_REQUIRED");
    /* The correction is upstream — never "raise an unlinked order instead",
       which is the bypass this whole chunk exists to close. */
    expect(e.message).not.toMatch(/purchase-order module/i);
    expect(e.details?.correction).toBeTruthy();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE CONTEXTUAL ACTION'S OWN RULE

   A material purchase order must prove an operational need. A material request
   is one proof; a recorded intake requirement — somebody asked, Store
   classified it as a purchase, Finance approved it — is the other. A request
   with NEITHER has no upstream at all, and that is the unlinked order this
   whole chunk exists to prevent.
   ────────────────────────────────────────────────────────────────────────── */
describe("the contextual action requires a proven operational need", () => {
  it("refuses an approved request with no material request", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id },
      { $unset: { sourceMrfId: "", sourceMrfNumber: "", intakeRequestId: "" } });
    const bare = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(co), bare));
    expect(e.code).toBe("MRF_REQUIRED");
  });

  /* ── THE INTAKE DOOR IS CLOSED ─────────────────────────────────────────
     An earlier pass let an intake-origin request through on `intakeRequestId`
     alone, so as not to take a live journey offline. That was a second door
     into the same invariant, and it was a dead end besides: the order was
     created with `sourceMrfId: null` and could never be issued, because
     `assertIssuable` requires a material request. Refusing at creation is both
     the rule and the kinder answer.

     Intake is not removed. It must be linked to, or converted into, a material
     request first — and that conversion is deliberately not automated here. */
  it("refuses an intake-origin request that has no material request", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id }, {
      $unset: { sourceMrfId: "", sourceMrfNumber: "" },
      $set: { intakeRequestId: new mongoose.Types.ObjectId() },
    });
    const intakeBorn = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(co), intakeBorn));
    expect(e.code).toBe("MRF_REQUIRED");
    /* It says what to do, and names the intake it came from. */
    expect(e.message).toMatch(/intake requirement/i);
    expect(e.message).toMatch(/link it to a material request/i);
    expect(e.details.origin).toBe("intake");
    expect(e.details.correction).toContain("/order-requests/intake/");
  });

  it("an intake-origin refusal creates no draft and no dead end", async () => {
    /* The old behaviour produced an unissuable order. Nothing is created now. */
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id }, {
      $unset: { sourceMrfId: "", sourceMrfNumber: "" },
      $set: { intakeRequestId: new mongoose.Types.ObjectId() },
    });
    const doc = await SpendRequest.findById(sr._id).lean();
    const before = await PurchaseOrder.countDocuments({ companyId: co._id });

    await refusal(() => governed.resolveForRequest(tenantFor(co), doc));
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(before);
  });

  it("an MRF-origin request still passes every other rule", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { status: "pending_finance" });
    const doc = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(co), doc));
    expect(e.code).toBe("REQUEST_NOT_APPROVED");
  });

  /* ── A RE-POINTED REQUEST NO LONGER PASSES ──────────────────────────────
     An earlier pass accepted this: the request's own claim was self-consistent
     and the MRF it named had a shortfall, so provenance simply followed the
     claim. That is exactly the hole this pass closes — an approved request for
     material B could be re-pointed at an MRF whose shortfall is material A and
     still order, because nothing compared the two LINE BY LINE.

     Now each approved line names the material-request line it is buying, and
     that mapping must land inside the MRF actually being ordered against. */
  it("a request re-pointed at an unrelated material request is refused", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const other = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id },
      { $set: { sourceMrfId: other._id, sourceMrfNumber: other.mrfNumber } });
    const doc = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(co), doc));
    expect(e.code).toBe("LINE_NOT_APPROVED");
    expect(e.details.reason).toBe("LINE_NOT_IN_MRF");
  });

  it("a re-pointed request still cannot reach another company's material request", async () => {
    const mine = await company();
    const theirs = await company();
    const mrf = await mrfWithShortfall(mine);
    const foreign = await mrfWithShortfall(theirs, { mrfNumber: "MRF/THEIRS" });
    const sr = await approvedRequestFor(mine, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id },
      { $set: { sourceMrfId: foreign._id, sourceMrfNumber: foreign.mrfNumber } });
    const doc = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(mine), doc));
    expect(e.code).toBe("MRF_UNAVAILABLE");
    expect(JSON.stringify({ m: e.message, d: e.details || {} })).not.toContain("MRF/THEIRS");
  });

  it("the New purchase order form's rule has no such exception", async () => {
    /* The form asks for a material request and takes no other answer — the
       intake door is the contextual action's, not the form's. */
    const co = await company();
    const e = await refusal(() => governed.resolveChain(tenantFor(co), {}));
    expect(e.code).toBe("MRF_REQUIRED");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   LINE PROVENANCE — MATERIAL A CANNOT AUTHORISE MATERIAL B

   Proving the MRF has *something* to buy is not enough. Each approved line
   names the material-request line it is buying, by id, and that mapping must
   be a bijection into the MRF's buy lines.
   ────────────────────────────────────────────────────────────────────────── */
describe("every ordered line comes from the material request", () => {
  it("material A's shortfall cannot authorise material B", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);             // shortfall is material A
    const other = await rawItem("Polyester");           // the request asks for B
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id }, {
      $set: { "items.0.rawItem": other._id, "items.0.name": other.name },
    });
    const doc = await SpendRequest.findById(sr._id).lean();

    const e = await refusal(() => governed.resolveForRequest(tenantFor(co), doc));
    expect(e.code).toBe("LINE_NOT_APPROVED");
    expect(e.details.reason).toBe("LINE_MATERIAL_MISMATCH");
  });

  it("a line with no stated material-request line fails closed", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { sourceMrfLineId: null });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("LINE_NOT_APPROVED");
    expect(e.details.reason).toBe("LINE_PROVENANCE_MISSING");
    expect(sr.items[0].sourceMrfLineId).toBeFalsy();
  });

  it("a line pointing at a material-request line that is not being bought is refused", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { sourceMrfLineId: new mongoose.Types.ObjectId() });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.details.reason).toBe("LINE_NOT_IN_MRF");
  });

  it("two approved lines cannot claim the same material-request line", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const dup = { ...JSON.parse(JSON.stringify(sr.items[0])), _id: new mongoose.Types.ObjectId() };
    await SpendRequest.collection.updateOne({ _id: sr._id }, { $push: { items: dup } });

    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.details.reason).toBe("LINE_CLAIMED_TWICE");
  });

  it("a quantity above the material request's own buy quantity is refused", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co, { buyQty: 40 });
    /* The approval says 100; the store only decided to buy 40. */
    await approvedRequestFor(co, mrf, { quantity: 100 });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("QUANTITY_EXCEEDS_APPROVED");
    expect(e.details.reason).toBe("EXCEEDS_MRF_BUY_QTY");
    expect(e.details.mrfBuyQty).toBe(40);
  });

  it("a different unit is refused rather than silently compared", async () => {
    /* 10 metres is not 10 rolls; comparing the numbers alone would pass. */
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { unit: "roll" });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.details.reason).toBe("LINE_UNIT_MISMATCH");
  });

  it("a different variant of the same material is refused", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { variantId: new mongoose.Types.ObjectId() });
    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.details.reason).toBe("LINE_VARIANT_MISMATCH");
  });

  it("a complete chain carries the material-request line onto every order line", async () => {
    const co = await company();
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(String(chain.lines[0].sourceMrfLineId)).toBe(String(mrf.items[0]._id));
  });
});

/* ══ THE SUPPLIER IS NOT GUESSED ════════════════════════════════════════ */

describe("an explicit approved supplier is never replaced by a namesake", () => {
  it("an unfindable supplier id is refused, not swapped for a same-name vendor", async () => {
    const co = await company();
    const Vendor = governed.Vendor;
    /* A different supplier that happens to share the approved name. */
    await Vendor.create({ companyName: "Northwind Textiles", companyId: co._id });
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { vendorId: new mongoose.Types.ObjectId() });

    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.code).toBe("SUPPLIER_SPLIT_REQUIRED");
    expect(e.details.reason).toBe("SUPPLIER_UNAVAILABLE");
  });

  it("another company's supplier id is refused", async () => {
    const co = await company();
    const other = await company();
    const Vendor = governed.Vendor;
    const foreign = await Vendor.create({ companyName: "Elsewhere Mills", companyId: other._id });
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { vendorId: foreign._id });

    const e = await refusal(() => governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id }));
    expect(e.details.reason).toBe("SUPPLIER_UNAVAILABLE");
  });

  it("a name-only supplier still resolves by name, as it always did", async () => {
    const co = await company();
    const Vendor = governed.Vendor;
    const v = await Vendor.create({ companyName: "Northwind Textiles", companyId: co._id });
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);   // vendorName only, no id

    const chain = await governed.resolveChain(tenantFor(co), { sourceMrfId: mrf._id });
    expect(String(chain.vendorId)).toBe(String(v._id));
  });
});

/* ══ UNKNOWN PROVENANCE POLICIES ════════════════════════════════════════ */

describe("only policies this code supports are honoured", () => {
  it("recognises exactly two", () => {
    expect(governed.SUPPORTED_POLICIES).toEqual([governed.PROVENANCE_POLICY, governed.LEGACY_POLICY]);
  });

  it("an unknown or misspelled policy is not governed and not legacy", () => {
    for (const p of ["MRF_REQUIRED_V2", "MRF_REQUIRED_V1 ", "legacy_pre_mrf_v1", "anything"]) {
      expect(governed.isSupportedPolicy(p)).toBe(false);
      expect(governed.isGovernedOrder({ provenancePolicy: p })).toBe(false);
      expect(governed.isLegacyOrder({ provenancePolicy: p })).toBe(false);
    }
  });
});
