"use strict";
// services/storePurchase/customerMaterialIssue.service.js
//
// HANDING A CUSTOMER'S MATERIAL TO PRODUCTION — AND GIVING BACK WHAT IS LEFT.
//
// A job-work customer sent the fabric. It arrived, it was counted, and it now
// sits on our shelf as an ownership lot. Two things can legitimately happen to
// it, and this module is both:
//
//   ISSUE               it goes to production, against the ONE order line it
//                       was sent for.
//   RETURN TO CUSTOMER  it leaves the factory and goes back to its owner.
//
// Both reduce `availableQuantity`, both reduce the physical Raw Item balance and
// the exact location balance, and both write the ordinary stock and location
// movements. What separates them is where the material WENT, and that difference
// is the whole reason they are two operations with two words rather than one
// with a flag.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
// Customer-owned quantity is not free stock. It may be used only when EVERY one
// of these matches: company, customer, sales order, permanent sales order line,
// execution file, raw item, variant, expectation line, lot, warehouse and
// location.
//
// Nine of those eleven are read from the LOT, which was stamped at receipt from
// the document and the handover chain. The client supplies the lot id, the
// quantity and the destination, and nothing else it says about identity is
// believed: a posted customer, order, line or item is compared with what the
// server resolved and a disagreement is REFUSED rather than ignored. Ignoring it
// would let a caller believe they had issued against one order while the record
// says another.
//
// ── AND THERE IS NO AUTOMATIC SUBSTITUTION ──────────────────────────────────
// If the right lot is short, this does not quietly take the difference from
// another lot — not even another lot of the same material for the same customer
// and the same order line. Somebody has to choose, and choosing is what the
// explicit multi-lot request is for. A substitution nobody chose is a
// discrepancy discovered at delivery, and by then the fabric is cut.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// RETURN FROM PRODUCTION. It is a real operation and it is not this one: it
// moves quantity from `issuedQuantity` back to `availableQuantity` and puts
// stock back on the shelf, where a return to the customer takes stock off it
// permanently. Sharing a word with it would make `returnedQuantity` unreadable —
// see the note on the lot model. The movement type is declared; nothing writes
// it, and nothing here pretends it can.

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const { CustomerMaterialReturn } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialReturn");
const {
  CustomerMaterialExpectation, STATE,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const locStock = require("./locationStock.service");
const posting = require("./receiptPosting.service");
const { fail } = require("./errors");

const { r4 } = posting;
const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const same = (a, b) => str(a) === str(b);

/* ═══ WHAT MAY BE MOVED ════════════════════════════════════════════════════ */

/**
 * Load the lots named by the caller, and prove they are one coherent set.
 *
 * ── WHY THEY MUST AGREE WITH EACH OTHER ─────────────────────────────────────
 * A single operation may draw on SEVERAL lots — a customer sent the same fabric
 * in three deliveries and production needs more than one roll. What it may not
 * do is draw on lots belonging to different customers, orders, lines or
 * materials in one movement, because then the operation as a whole has no single
 * answer to "what did this discharge", and the issue record would be a summary
 * of unrelated events.
 */
/**
 * The document the ROUTE addressed, by its own id.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * The service used to take only the lots and derive the document from whichever
 * one it was handed. So a request to `/documents/A/issues` carrying a lot of
 * document B moved B's stock, wrote the audit and the idempotency key under A,
 * and answered with A's progress. Four records describing three different things.
 *
 * Now the URL is the authority: this resolves what the caller addressed, and
 * every lot is checked against it below.
 */
async function addressedDocument(ctx, docId, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store.");
  if (!isId(docId)) throw fail("NOT_FOUND", "That customer-material document was not found.");
  const doc = await CustomerMaterialExpectation
    .findOne({ _id: docId, companyId: ctx.companyId }).session(session);
  if (!doc) throw fail("NOT_FOUND", "That customer-material document was not found.");
  return doc;
}

/**
 * Prove a lot belongs to the document the route addressed.
 *
 * ── STABLE IDENTITY, NOT THE REVISION'S `_id` ───────────────────────────────
 * The binding is on `documentRef` — the reference that survives a revision —
 * together with the execution file and the permanent sales line. A lot received
 * against revision 1 is still that document's material after revision 2 is
 * issued, and requiring the current revision's Mongo id would orphan every
 * earlier receipt: the goods are on the shelf and the line is the same line.
 *
 * Everything else the domain rule names is checked too, because a lot could
 * share a document reference and still be the wrong material.
 */
function assertLotBelongsTo(lot, doc) {
  const checks = [
    ["companyId", lot.companyId, doc.companyId, "company"],
    /* The STABLE document reference — see above. */
    ["documentRef", lot.documentRef, doc.documentRef, "customer-material document"],
    ["executionFileId", lot.executionFileId, doc.executionFileId, "execution file"],
    ["customerId", lot.customerId, doc.customerId, "customer"],
    ["orderRef", lot.orderRef, doc.orderRef, "sales order"],
    ["orderLineRef", lot.orderLineRef, doc.salesOrderLineRef, "permanent sales order line"],
  ];
  for (const [field, actual, expected, label] of checks) {
    /* An expected value the document does not carry cannot be compared. Skipped
       rather than treated as a match, and the caller refuses separately where the
       value is required — a silent pass here would be the whole hole reopened. */
    if (!str(expected)) continue;
    if (!same(actual, expected)) {
      throw fail("VALIDATION",
        `Lot ${str(lot.goodsReceiptNumber)} belongs to a different ${label}, so it cannot be moved `
        + "against this document. Nothing was moved.",
        {
          reason: "LOT_NOT_ON_THIS_DOCUMENT",
          field, lotId: str(lot._id),
          expected: str(expected), actual: str(actual),
        });
    }
  }
  /* And the line the lot was received against must still be on the document —
     a revision may legitimately have removed a line that never received. */
  const line = (doc.lines || []).find((l) => same(l.lineRef, lot.expectationLineRef));
  if (!line) {
    throw fail("VALIDATION",
      `Lot ${str(lot.goodsReceiptNumber)} was received against a line that is not on this document.`,
      {
        reason: "LOT_LINE_NOT_ON_DOCUMENT",
        lotId: str(lot._id), expectationLineRef: str(lot.expectationLineRef),
      });
  }
  /* The material itself, from the line that asked for it. */
  for (const [field, actual, expected, label] of [
    ["rawItemId", lot.rawItemId, line.rawItemId, "material"],
    ["variantId", lot.variantId, line.variantId, "variant"],
  ]) {
    if (!str(expected) && !str(actual)) continue;
    if (!same(actual, expected)) {
      throw fail("VALIDATION",
        `Lot ${str(lot.goodsReceiptNumber)} is a different ${label} from the one this document's `
        + "line asks for.",
        { reason: "LOT_NOT_ON_THIS_DOCUMENT", field, lotId: str(lot._id) });
    }
  }
}

async function loadLots(ctx, rows, session = null) {
  if (!Array.isArray(rows) || !rows.length) {
    throw fail("VALIDATION", "Say which lot the material is coming out of.", { reason: "NO_LOTS" });
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = str(row?.lotId);
    if (!isId(id)) throw fail("VALIDATION", "That is not a lot reference.", { field: "lotId" });
    if (seen.has(id)) {
      throw fail("VALIDATION", "The same lot appears more than once in this operation.",
        { reason: "DUPLICATE_LOT", lotId: id });
    }
    seen.add(id);

    /* Company-scoped: another company's lot answers exactly as one that does not
       exist, so this cannot be used to ask what somebody else is holding. */
    const lot = await CustomerMaterialLot
      .findOne({ _id: id, companyId: ctx.companyId }).session(session);
    if (!lot) throw fail("NOT_FOUND", "That lot was not found in this company.", { field: "lotId" });

    const quantity = Number(row?.quantity);
    if (!(quantity > 0)) {
      throw fail("VALIDATION",
        `A positive quantity is required for lot ${str(lot.goodsReceiptNumber)}.`,
        { reason: "NON_POSITIVE_QTY", lotId: id });
    }
    out.push({ lot, quantity: r4(quantity) });
  }

  /* One customer, one order, one line, one material — see above. */
  const first = out[0].lot;
  for (const { lot } of out.slice(1)) {
    for (const [field, label] of [
      ["customerId", "customer"],
      ["orderRef", "sales order"],
      ["orderLineRef", "sales order line"],
      ["expectationLineRef", "document line"],
      ["rawItemId", "material"],
      ["variantId", "variant"],
    ]) {
      if (!same(lot[field], first[field])) {
        throw fail("VALIDATION",
          `These lots belong to a different ${label}, so they cannot be moved in one operation.`,
          { reason: "LOTS_NOT_ONE_SET", field, lotId: str(lot._id) });
      }
    }
  }
  return out;
}

/**
 * THE REVISION IN FORCE FOR A FILE, RIGHT NOW.
 *
 * Revisions are unique per `{companyId, executionFileId, revisionNo}` and issuing a
 * new one does NOT cancel the old one — supersession is implicit in the numbering.
 * So "in force" is the highest-numbered revision that was ever PUT into force:
 * `ISSUED` or `CANCELLED`, never `DRAFT`.
 *
 * Excluding drafts is the part that matters. Merchandising opens revision 3 as a
 * draft and works on it for a week; revision 2 is still the statement Store is
 * acting on, and material must keep flowing to production the whole time. Treating
 * the draft as "latest" would stop the factory because somebody started typing.
 *
 * A CANCELLED newest revision means the document is withdrawn — the older ISSUED
 * revision underneath it does NOT come back to life. Resurrecting a withdrawn
 * statement because a newer one was withdrawn is exactly backwards.
 */
async function revisionInForce(ctx, executionFileId, session = null) {
  return CustomerMaterialExpectation
    .findOne({
      companyId: ctx.companyId,
      executionFileId,
      state: { $in: [STATE.ISSUED, STATE.CANCELLED] },
    })
    .sort({ revisionNo: -1 })
    .session(session);
}

/**
 * MAY THIS DOCUMENT RELEASE MATERIAL TO PRODUCTION?
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * A check that refused only `CANCELLED`. Everything else it let through, and two
 * of those were wrong in ways nobody would see from the screen:
 *
 *   A DRAFT could issue. A draft is Merchandising thinking out loud — quantities
 *   half-entered, lines about to be deleted. Releasing fabric against one hands
 *   production material on the strength of a sentence nobody has finished
 *   writing, and the audit trail then cites a document that was never in force.
 *
 *   A SUPERSEDED revision could issue. Revision 2 says 800 m of the navy;
 *   revision 3, issued this morning, says 300 m and a different colour. Issuing
 *   against revision 2 is issuing against an instruction that was replaced, and
 *   every figure downstream is then measured against the wrong statement.
 *
 * ── AND A DOCUMENT WITH NO PROVABLE OWNER CANNOT ISSUE EITHER ───────────────
 * A Phase 1 document may carry no `customerId` and no permanent sales line. It
 * cannot prove whose material it is or which order line it belongs to, so it
 * cannot prove a production target — and material issued against it could not be
 * traced back to an owner afterwards.
 *
 * Returns are deliberately NOT subject to any of this: see `planReturn`.
 */
async function assertIssuableDocument(ctx, doc, session = null) {
  const ref = str(doc.documentRef);

  if (str(doc.state) === STATE.CANCELLED) {
    throw fail("LIFECYCLE_BLOCKED",
      "That customer-material document was withdrawn, so nothing more may be issued against it. "
      + "Material already on the shelf can still be returned to the customer.",
      { reason: "EXPECTATION_CANCELLED", documentRef: ref, state: str(doc.state) });
  }
  if (str(doc.state) !== STATE.ISSUED) {
    throw fail("LIFECYCLE_BLOCKED",
      `${ref} is still a draft, so nothing may be issued against it. Merchandising issues the `
      + "document when the statement is final; until then there is nothing for Store to act on.",
      { reason: "EXPECTATION_NOT_ISSUED", documentRef: ref, state: str(doc.state) });
  }

  const inForce = await revisionInForce(ctx, doc.executionFileId, session);
  if (inForce && !same(inForce._id, doc._id)) {
    if (str(inForce.state) === STATE.CANCELLED) {
      throw fail("LIFECYCLE_BLOCKED",
        `${ref} was withdrawn at revision ${inForce.revisionNo}, so nothing more may be issued `
        + "against it. Material already on the shelf can still be returned to the customer.",
        {
          reason: "EXPECTATION_CANCELLED", documentRef: ref,
          addressedRevisionNo: doc.revisionNo, revisionInForce: inForce.revisionNo,
        });
    }
    throw fail("CONFLICT",
      `Revision ${doc.revisionNo} of ${ref} has been replaced by revision ${inForce.revisionNo}. `
      + "Issue against the current revision — what it says may differ from this one.",
      {
        reason: "EXPECTATION_SUPERSEDED", documentRef: ref,
        addressedRevisionNo: doc.revisionNo, revisionInForce: inForce.revisionNo,
        currentDocId: str(inForce._id),
      });
  }

  if (!doc.customerId) {
    throw fail("LIFECYCLE_BLOCKED",
      `${ref} does not record whose material it is, so nothing may be issued against it. `
      + "Ask Merchandising to reissue it once Sales has attached the customer.",
      { reason: "DOCUMENT_HAS_NO_CUSTOMER", documentRef: ref });
  }
  /* The permanent sales line is what a production target is PROVED against. */
  if (!str(doc.salesOrderLineRef)) {
    throw fail("LIFECYCLE_BLOCKED",
      `${ref} does not record which permanent sales order line it belongs to, so material cannot `
      + "be issued to a production order. Ask Merchandising to reissue it.",
      { reason: "DOCUMENT_HAS_NO_SALES_LINE", documentRef: ref });
  }
  return inForce;
}

/** Enough left in the lot, or a refusal naming what is actually there. */
function assertLotHas({ lot, quantity, verb }) {
  const available = r4(lot.availableQuantity);
  if (r4(quantity) > available) {
    throw fail("VALIDATION",
      `Cannot ${verb} ${quantity} ${str(lot.baseUnit)} from lot ${str(lot.goodsReceiptNumber)}: `
      + `only ${available} ${str(lot.baseUnit)} of it is still held.`,
      {
        reason: "INSUFFICIENT_IN_LOT", lotId: str(lot._id),
        available, requested: r4(quantity),
        /* Named explicitly so a screen can say "choose another lot" rather than
           a caller assuming the system will find the difference somewhere. No
           substitution happens automatically — somebody chooses. */
        substitution: "NOT_AUTOMATIC",
      });
  }
  /* A lot fully returned to its owner is gone. It is not a source of anything. */
  if (available <= 0) {
    throw fail("LIFECYCLE_BLOCKED",
      `Lot ${str(lot.goodsReceiptNumber)} has nothing left in it.`,
      { reason: "LOT_EXHAUSTED", lotId: str(lot._id) });
  }
}

/* ═══ PROVING THE PRODUCTION ORDER ═════════════════════════════════════════ */

/**
 * Prove that a Manufacturing Order and (where given) a WorkOrder are the SAME
 * commercial line this material was sent for.
 *
 * ── WHAT COUNTS AS PROOF, AND WHAT DOES NOT ─────────────────────────────────
 * Proof is stored references agreeing:
 *
 *   ExecutionFile.currentHandoverVersionId → SalesHandoverVersion.sourceRecord
 *     .recordId  ==  the Manufacturing Order (a CustomerRequest)
 *   ExecutionFile.currentExecutionProjection.orderLineRef
 *     ==  WorkOrder.salesLineLink.lineRef
 *   WorkOrder.salesLineLink.customerRequestId  ==  that same order
 *   every one of them inside this company
 *
 * NOT proof: the same product name, the same style, the same buyer, the same SKU,
 * the same description, or the same quantity. Every one of those legitimately
 * repeats across two commercial lines of one order — that is precisely why the
 * `LN-…` line reference was minted — and matching on any of them would issue a
 * customer's fabric to the wrong line while looking entirely reasonable.
 *
 * A WorkOrder with no `salesLineLink` is refused. It may be perfectly valid and
 * simply predate the link, and that is the point: the relationship CANNOT be
 * proven, so it is not asserted. An unprovable link is not a weak yes.
 */
async function proveProductionTarget(ctx, {
  lot, manufacturingOrderId, workOrderId,
}, session = null) {
  if (!isId(manufacturingOrderId)) {
    throw fail("VALIDATION", "Say which production order this is being issued to.",
      { field: "manufacturingOrderId" });
  }

  /* The execution file the lot belongs to, and the order it is executing. */
  const file = await ExecutionFile
    .findOne({ _id: lot.executionFileId, companyId: ctx.companyId })
    .select("currentHandoverVersionId currentExecutionProjection fileNumber")
    .session(session).lean();
  if (!file) {
    throw fail("NOT_FOUND", "The execution file behind this lot was not found in this company.");
  }

  const customerIdentity = require("../merchandising/customerIdentity.service");
  const identity = await customerIdentity.resolveFromFile(ctx, file, session);
  if (!identity.ok) {
    throw fail("LIFECYCLE_BLOCKED",
      `${identity.message} Until that is put right, material cannot be issued against this order.`,
      { reason: "CUSTOMER_IDENTITY_UNPROVEN", cause: identity.reason });
  }

  /* ── THE MANUFACTURING ORDER IS THE SALES ORDER ─────────────────────────
     A Manufacturing Order in this system IS a CustomerRequest. So the proof is
     an identity comparison, not a lookup by name: the order somebody chose must
     be the very order this execution file was opened from. */
  if (!same(manufacturingOrderId, identity.customerRequestId)) {
    throw fail("VALIDATION",
      "That production order is not the order this material was sent for. Customer-supplied "
      + "material can only be issued to the order its customer sent it for.",
      {
        reason: "MANUFACTURING_ORDER_MISMATCH",
        expected: str(identity.customerRequestId),
        sent: str(manufacturingOrderId),
      });
  }
  const order = await CustomerRequest
    .findById(identity.customerRequestId).select("requestId items.lineRef").session(session).lean();
  if (!order) throw fail("NOT_FOUND", "That production order was not found.");

  /* The permanent Sales line. The lot carries it; the file is where it came
     from, and they must still agree. */
  const fileLineRef = str(file.currentExecutionProjection?.orderLineRef);
  const lotLineRef = str(lot.orderLineRef);
  if (!lotLineRef) {
    /* A lot received before the permanent line was stamped. Refused rather than
       guessed: without it there is nothing to compare a WorkOrder against. */
    throw fail("LIFECYCLE_BLOCKED",
      "This lot does not record which permanent sales order line it belongs to, so it cannot be "
      + "issued to a production order. Ask Merchandising to reissue the document and record the "
      + "arrival against the new revision.",
      { reason: "LOT_HAS_NO_SALES_LINE", lotId: str(lot._id) });
  }
  if (fileLineRef && !same(fileLineRef, lotLineRef)) {
    throw fail("VALIDATION",
      "This lot's sales order line no longer matches the execution file's.",
      { reason: "SALES_LINE_MISMATCH", lot: lotLineRef, file: fileLineRef });
  }
  /* And the line must actually exist on the order. */
  if (!(order.items || []).some((i) => same(i.lineRef, lotLineRef))) {
    throw fail("VALIDATION",
      "That sales order line is not on this production order.",
      { reason: "SALES_LINE_NOT_ON_ORDER", orderLineRef: lotLineRef });
  }

  /* ── THE WORK ORDER, WHERE ONE IS NAMED ────────────────────────────────── */
  let workOrder = null;
  if (str(workOrderId)) {
    if (!isId(workOrderId)) {
      throw fail("VALIDATION", "That is not a work order reference.", { field: "workOrderId" });
    }
    workOrder = await WorkOrder.findById(workOrderId)
      .select("workOrderNumber companyId customerRequestId salesLineLink").session(session).lean();
    if (!workOrder) throw fail("NOT_FOUND", "That work order was not found.");

    const link = workOrder.salesLineLink || null;
    if (!link || !link.lineRef) {
      /* Not a weak yes. */
      throw fail("LIFECYCLE_BLOCKED",
        `Work order ${str(workOrder.workOrderNumber) || "(unnumbered)"} does not record which sales `
        + "order line it is making, so it cannot be proved to belong to this material's line. "
        + "Customer-supplied material is not issued on an unprovable link.",
        { reason: "WORK_ORDER_LINK_UNPROVEN", workOrderId: str(workOrderId) });
    }
    if (!same(link.companyId, ctx.companyId)) {
      throw fail("NOT_FOUND", "That work order was not found.");
    }
    if (!same(link.customerRequestId, identity.customerRequestId)) {
      throw fail("VALIDATION",
        "That work order belongs to a different production order.",
        { reason: "WORK_ORDER_ORDER_MISMATCH", workOrderId: str(workOrderId) });
    }
    if (!same(link.lineRef, lotLineRef)) {
      throw fail("VALIDATION",
        "That work order is making a different sales order line. Customer-supplied material "
        + "belongs to the one line its customer sent it for.",
        {
          reason: "WORK_ORDER_LINE_MISMATCH",
          workOrderLine: str(link.lineRef), materialLine: lotLineRef,
        });
    }
  }

  return {
    file,
    identity,
    order: { id: order._id, number: str(order.requestId) },
    workOrder: workOrder
      ? { id: workOrder._id, number: str(workOrder.workOrderNumber) }
      : null,
    orderLineRef: lotLineRef,
  };
}

/* ═══ WHAT THE CLIENT CLAIMED MUST AGREE WITH WHAT THE SERVER RESOLVED ═════ */

/**
 * Refuse a request whose stated identity disagrees with the resolved one.
 *
 * ── WHY REFUSE RATHER THAN IGNORE ───────────────────────────────────────────
 * The server does not TRUST any of these — every one is resolved from the lot.
 * But a caller who sent them believes them, and silently substituting different
 * values would return a success for an operation they did not ask for. A screen
 * showing a stale customer, or a script pointed at the wrong order, would issue
 * a customer's fabric and be told it worked.
 */
function assertClaimMatches(claimed = {}, resolved) {
  const checks = [
    ["customerId", resolved.customerId, "customer"],
    ["orderRef", resolved.orderRef, "sales order"],
    ["orderLineRef", resolved.orderLineRef, "sales order line"],
    ["rawItemId", resolved.rawItemId, "material"],
    ["variantId", resolved.variantId, "variant"],
    ["expectationLineRef", resolved.expectationLineRef, "document line"],
    ["documentRef", resolved.documentRef, "customer-material document"],
  ];
  for (const [field, actual, label] of checks) {
    const sent = claimed[field];
    if (sent === undefined || sent === null || str(sent) === "") continue;
    if (!same(sent, actual)) {
      throw fail("VALIDATION",
        `The ${label} sent with this request is not the one this lot belongs to. Nothing was moved.`,
        { reason: "CLAIMED_IDENTITY_MISMATCH", field, sent: str(sent), actual: str(actual) });
    }
  }
}

/* ═══ THE DESTINATION IT COMES OUT OF ══════════════════════════════════════ */

/**
 * The lot's own warehouse and location — not the caller's choice.
 *
 * A lot is held somewhere specific. Taking it "out of" a different location
 * would decrement a balance the material is not in, so the location is READ from
 * the lot and a caller who names a different one is refused rather than
 * redirected.
 */
async function lotLocation(ctx, lot, claimed = {}, session = null) {
  if (!lot.warehouseId || !lot.locationId) {
    throw fail("LIFECYCLE_BLOCKED",
      `Lot ${str(lot.goodsReceiptNumber)} is not held at a tracked location, so stock cannot be `
      + "taken out of one.",
      { reason: "LOT_NOT_LOCATION_TRACKED", lotId: str(lot._id) });
  }
  for (const [field, actual, label] of [
    ["warehouseId", lot.warehouseId, "warehouse"],
    ["locationId", lot.locationId, "location"],
  ]) {
    if (str(claimed[field]) && !same(claimed[field], actual)) {
      throw fail("VALIDATION",
        `This lot is not held in that ${label}. It is in ${str(lot.warehouseName)} `
        + `${str(lot.locationCode)}.`,
        { reason: "WRONG_LOCATION", field, sent: str(claimed[field]), actual: str(actual) });
    }
  }
  const warehouse = await Warehouse
    .findOne({ _id: lot.warehouseId, companyId: ctx.companyId }).session(session);
  if (!warehouse) throw fail("NOT_FOUND", "The warehouse holding this lot was not found.");
  const location = (warehouse.locations || [])
    .find((l) => same(l._id, lot.locationId)) || null;
  if (!location) throw fail("NOT_FOUND", "The location holding this lot was not found.");
  return { warehouse, location };
}

/* ═══ THE PHYSICAL ACT, SHARED BY BOTH OPERATIONS ══════════════════════════ */

/**
 * Take quantity out of a lot, and out of the shelf.
 *
 * Identical for an issue and for a return to the customer: the material leaves
 * Store either way, the RawItem balance falls, the exact location balance falls,
 * and the lot's `availableQuantity` falls. What DIFFERS is which of the lot's
 * other two counters rises and what the movements say — passed in, so there is
 * one implementation of the movement and no second opinion about how stock
 * leaves.
 *
 * ── THE LOT DECREMENT IS GUARDED, NOT READ-THEN-WRITTEN ─────────────────────
 * `findOneAndUpdate` with `availableQuantity: { $gte: quantity }` in the FILTER.
 * Two simultaneous issues both read "500 available" and both pass a prior check;
 * only one can match this filter. The loser gets null and is refused, which is
 * the same guarantee `decLocationGuarded` gives the location balance — and the
 * reason neither can overdraw.
 */
async function takeFromLot({
  session, ctx, tenant, lot, quantity, counter, movement, actor, idempotencyKey,
  warehouse, location, note, stockMeta, locationSource, documentRef = "",
}) {
  /* ── 1. CLAIM THE QUANTITY IN THE LOT ─────────────────────────────────── */
  const claimed = await CustomerMaterialLot.findOneAndUpdate(
    {
      _id: lot._id,
      companyId: ctx.companyId,
      availableQuantity: { $gte: r4(quantity) },
    },
    {
      $inc: { availableQuantity: -r4(quantity), [counter]: r4(quantity) },
      $set: { lastMovementAt: new Date() },
    },
    { new: true, session },
  );
  if (!claimed) {
    /* Either it never had enough, or somebody else took it between the check and
       here. Both answer the same way: this much is not there. */
    const fresh = await CustomerMaterialLot.findById(lot._id).session(session).lean();
    throw fail("CONFLICT",
      `Lot ${str(lot.goodsReceiptNumber)} no longer has ${r4(quantity)} ${str(lot.baseUnit)} `
      + `available — ${r4(fresh?.availableQuantity || 0)} ${str(lot.baseUnit)} is held. `
      + "Nothing was moved.",
      {
        reason: "INSUFFICIENT_IN_LOT", lotId: str(lot._id),
        available: r4(fresh?.availableQuantity || 0), requested: r4(quantity),
        substitution: "NOT_AUTOMATIC",
      });
  }

  /* ── 1b. A LABEL LEAVES WITH THE MATERIAL IT IS STUCK TO ────────────────
     Issuing a roll sends its sticker to the cutting table; returning it sends the
     sticker back to the customer. Either way the claim is no longer on Store's
     shelf, so the lot's labelled quantity is capped at what it still holds.

     Without this the labelled quantity would stay behind: a lot issued down to 0
     would report 500 units claimed by labels and nothing would ever be labelable
     again, including material received against it later. */
  if (r4(claimed.labelledQuantity) > r4(claimed.availableQuantity)) {
    claimed.labelledQuantity = r4(claimed.availableQuantity);
  }

  /* ── 2. TAKE IT OFF THE EXACT LOCATION ────────────────────────────────── */
  const item = await RawItem.findById(lot.rawItemId).session(session);
  if (!item) {
    throw fail("VALIDATION", "The material for this lot no longer exists.",
      { reason: "RAW_ITEM_MISSING", rawItemId: str(lot.rawItemId) });
  }
  const out = await locStock.applyLocationOut(session, {
    companyId: ctx.companyId, siteId: tenant.siteId || null,
    item, variantId: lot.variantId || null,
    warehouse, location, quantity: r4(quantity),
    type: movement.locationType, intent: movement.locationIntent,
    /* Ownership travels on the movement itself, so a warehouse report reading
       movements can say whose goods moved without a join back. */
    source: locationSource,
    actor: { id: actor.id, name: actor.name },
    note,
    idempotencyKey: locStock.movementLineKey(idempotencyKey || "", str(lot._id), movement.keySuffix),
    operationKey: idempotencyKey || "",
  });
  if (!out.ok) {
    throw fail("CONFLICT",
      `There is not enough of ${str(lot.itemName)} at ${str(lot.warehouseName)} `
      + `${str(lot.locationCode)} to move ${r4(quantity)} ${str(lot.baseUnit)}. Nothing was moved.`,
      { reason: out.reason || "INSUFFICIENT_AT_LOCATION", lotId: str(lot._id) });
  }

  /* ── 3. AND OFF THE PHYSICAL BALANCE ──────────────────────────────────── */
  const txId = applyStockOut(item, {
    variantId: lot.variantId || null,
    variantCombination: (lot.variantCombination || []).map(str),
    baseQuantity: r4(quantity),
  }, { ...stockMeta, performedBy: actor.id, ...locStock.txLocationSnapshot(warehouse, location) });
  await item.save({ session });

  /* ── 4. AND SAY SO ON THE LOT, APPEND-ONLY ────────────────────────────── */
  /* ── TWO DATES, BECAUSE THEY ARE TWO DIFFERENT FACTS ────────────────────
     `at` is when it happened in the business — the day the lorry left, which the
     operator enters and which may be last Tuesday. `recordedAt` is when this row
     was written. Collapsing them into one `new Date()`, as this did, quietly
     destroyed the entered date and left the stock ledger disagreeing with the
     delivery note. */
  const effectiveAt = movement.at instanceof Date ? movement.at : new Date();
  claimed.movements.push({
    /* Caller-supplied first, so nothing in `extra` can overwrite the identity
       fields below — the whole point of them is that they are not negotiable. */
    ...(movement.extra || {}),
    type: movement.type,
    quantity: r4(quantity),
    baseUnit: str(lot.baseUnit),
    availableAfter: r4(claimed.availableQuantity),
    at: effectiveAt,
    recordedAt: movement.recordedAt instanceof Date ? movement.recordedAt : new Date(),
    by: { id: actor.id || null, name: actor.name || "" },
    reason: movement.reason,
    goodsReceiptId: lot.goodsReceiptId,
    goodsReceiptNumber: str(lot.goodsReceiptNumber),
    stockTransactionId: txId,
    locationMovementId: out.movement?._id || null,
    warehouseId: warehouse._id,
    locationId: location._id,
    locationCode: str(location.code),
    /* ── WHICH OPERATION WROTE THIS ROW ───────────────────────────────────
       Recovery reads these. Without them the only question that could be asked
       of history was "does a movement of this type exist anywhere in this
       company", which an unrelated movement from last month answers yes to. */
    operationKey: str(idempotencyKey),
    operationType: str(movement.operationType),
    documentRef: str(documentRef || lot.documentRef),
  });
  await claimed.save({ session });

  /* The sub-document id of the row just appended. Callers stamp THIS row —
     by id — with the canonical record they go on to create. */
  const appended = claimed.movements[claimed.movements.length - 1];

  return {
    lot: claimed,
    txId,
    movementId: out.movement?._id || null,
    movementDocId: appended._id,
    item,
  };
}

/**
 * The canonical RawItem stock-OUT.
 *
 * The mirror of `receiptPosting.applyStockIn`, and written here rather than
 * there because nothing else in the receipt path takes stock out. It refuses to
 * drive a balance negative: a negative physical quantity is not a number to
 * reconcile later, it is a state that must not be writable.
 */
function applyStockOut(rawItem, plan, txMeta) {
  const q = r4(plan.baseQuantity);
  const previousBaseQty = rawItem.quantity || 0;

  if (plan.variantId) {
    let variant = rawItem.variants.id(plan.variantId) || null;
    if (!variant && plan.variantCombination?.length) {
      variant = rawItem.variants.find(
        (v) => v.combination?.length === plan.variantCombination.length
          && v.combination.every((val, i) => val === plan.variantCombination[i]),
      ) || null;
    }
    if (!variant) {
      throw fail("VALIDATION",
        "The variant this lot was received against no longer exists on the material.",
        { reason: "VARIANT_MISSING" });
    }
    if (r4(variant.quantity || 0) < q) {
      throw fail("CONFLICT",
        `There is not enough of that variant on hand to move ${q}.`,
        { reason: "INSUFFICIENT_PHYSICAL", available: r4(variant.quantity || 0) });
    }
    variant.quantity = r4((variant.quantity || 0) - q);
    variant.status = variant.quantity === 0 ? "Out of Stock"
      : variant.quantity <= (variant.minStock || rawItem.minStock || 0) ? "Low Stock" : "In Stock";
    rawItem.quantity = r4(rawItem.variants.reduce((sm, v) => sm + (v.quantity || 0), 0));
  } else {
    if (r4(rawItem.quantity || 0) < q) {
      throw fail("CONFLICT",
        `There is not enough of ${str(rawItem.name)} on hand to move ${q}.`,
        { reason: "INSUFFICIENT_PHYSICAL", available: r4(rawItem.quantity || 0) });
    }
    rawItem.quantity = r4((rawItem.quantity || 0) - q);
  }
  rawItem.status = rawItem.quantity === 0 ? "Out of Stock"
    : rawItem.quantity <= (rawItem.minStock || 0) ? "Low Stock" : "In Stock";

  rawItem.stockTransactions.unshift({
    /* The ledger's own words for stock leaving: `REDUCE` / `VARIANT_REDUCE`.
       Taken from the model's enum rather than invented — a new verb here would
       be a transaction type nothing else in the application knows how to read. */
    type: plan.variantId ? "VARIANT_REDUCE" : "REDUCE",
    quantity: q,
    ...(plan.variantId ? { variantId: plan.variantId, variantCombination: plan.variantCombination } : {}),
    previousQuantity: previousBaseQty,
    newQuantity: rawItem.quantity,
    ...txMeta,
  });
  return rawItem.stockTransactions[0]._id;
}

/* ═══ TWO STAGES, AND WHY THE SPLIT IS THE POINT ═══════════════════════════
   PLAN is read-only. It resolves the addressed document, loads the lots, proves
   they belong to it, proves the production target, checks the quantities and the
   location — and writes nothing.

   POST re-reads what can move underneath it, applies the mutation, and writes the
   effect marker inside the same transaction.

   The split exists because of a specific defect: the routes used to call
   `markEffectApplied()` BEFORE any of this, so a request rejected for a bad
   quantity or a wrong work order left an EFFECT_APPLIED record behind. The
   operator corrected the form, retried with the same key — the normal thing to do
   — and was routed into reconciliation for an operation that had never happened.
   Nothing is marked now until a request has passed validation. */

/* ═══ ISSUE TO PRODUCTION ══════════════════════════════════════════════════ */

/** Stage one: everything that can be decided without writing. */
async function planIssue(ctx, {
  docId, rows, manufacturingOrderId, workOrderId, claimed = {}, session = null,
} = {}) {
  /* The URL is the authority. */
  const doc = await addressedDocument(ctx, docId, session);
  await assertIssuableDocument(ctx, doc, session);

  const loaded = await loadLots(ctx, rows, session);
  for (const { lot } of loaded) assertLotBelongsTo(lot, doc);

  const first = loaded[0].lot;
  const target = await proveProductionTarget(ctx, {
    lot: first, manufacturingOrderId, workOrderId,
  }, session);

  assertClaimMatches(claimed, {
    customerId: first.customerId,
    orderRef: first.orderRef,
    orderLineRef: first.orderLineRef,
    rawItemId: first.rawItemId,
    variantId: first.variantId,
    expectationLineRef: first.expectationLineRef,
    documentRef: first.documentRef,
  });

  const plans = [];
  for (const { lot, quantity } of loaded) {
    assertLotHas({ lot, quantity, verb: "issue" });
    const { warehouse, location } = await lotLocation(ctx, lot, claimed, session);
    plans.push({ lot, quantity, warehouse, location });
  }
  return { doc, target, plans };
}

/**
 * Stage two: move it, in one transaction.
 *
 * The plan is re-validated here against what the lots hold NOW, because a
 * transaction may be retried and because somebody else may have taken the
 * quantity in between.
 */
async function postIssue(ctx, {
  tenant, session, doc: planned, target: plannedTarget, plans,
  note = "", actor, idempotencyKey,
}) {
  /* ── THE PLAN IS EVIDENCE, NOT AUTHORITY ──────────────────────────────────
     Everything below re-decides inside the transaction, against the rows as they
     are NOW. The planning copy was read before the transaction opened, and in the
     gap between the two Merchandising may have withdrawn the document or issued a
     new revision — a gap that is seconds on a quiet afternoon and long enough to
     matter on a busy one, because the operator was reading the screen in between.
     Trusting the planned `doc` would release material against a statement that had
     already been replaced, and the audit row would then cite it as current.

     `withTransaction` also RETRIES the callback, so a second pass through here
     must re-read rather than replay a stale decision. */
  const doc = await addressedDocument(ctx, planned._id, session);
  await assertIssuableDocument(ctx, doc, session);

  /* The production target is re-proved too: a work order's stored sales-line link
     is what qualifies it, and that link is a row like any other. */
  const target = await proveProductionTarget(ctx, {
    lot: plans[0].lot,
    manufacturingOrderId: plannedTarget.order.id,
    workOrderId: plannedTarget.workOrder?.id || undefined,
  }, session);

  const items = [];
  const posted = [];

  for (const p of plans) {
    /* Re-read inside the transaction. The planning copy is stale by definition. */
    const lot = await CustomerMaterialLot
      .findOne({ _id: p.lot._id, companyId: ctx.companyId }).session(session);
    if (!lot) throw fail("NOT_FOUND", "That lot was not found in this company.");
    assertLotBelongsTo(lot, doc);
    assertLotHas({ lot, quantity: p.quantity, verb: "issue" });

    const moved = await takeFromLot({
      session, ctx, tenant, lot, quantity: p.quantity,
      counter: "issuedQuantity",
      movement: {
        type: "ISSUED",
        operationType: "ISSUE",
        locationType: "issue",
        locationIntent: "issue",
        keySuffix: "cmissue",
        reason: `Issued to ${target.order.number}`
          + `${target.workOrder ? ` / ${target.workOrder.number}` : ""}`,
        extra: {
          manufacturingOrderId: target.order.id,
          manufacturingOrderNumber: target.order.number,
          workOrderId: target.workOrder?.id || null,
          workOrderNumber: target.workOrder?.number || "",
        },
      },
      actor, idempotencyKey, warehouse: p.warehouse, location: p.location,
      documentRef: str(doc.documentRef),
      note: `Customer material issued to ${target.order.number}`,
      stockMeta: {
        reason: "Customer-supplied material issued to production",
        notes: `${str(lot.customerLabel)} · ${str(lot.orderRef)}`
          + `${target.workOrder ? ` · ${target.workOrder.number}` : ""}`
          + ` · lot ${str(lot.goodsReceiptNumber)}`,
      },
      locationSource: {
        kind: "customer_material_issue",
        id: doc._id,
        reference: str(doc.documentRef),
        customerId: lot.customerId,
        customerMaterialLotId: lot._id,
        orderRef: str(lot.orderRef),
        orderLineRef: str(lot.orderLineRef),
      },
    });

    posted.push(moved);
    items.push({
      rawItem: lot.rawItemId,
      rawItemName: str(lot.itemName),
      rawItemSku: str(lot.sku),
      variantId: lot.variantId || null,
      variantCombination: (lot.variantCombination || []).map(str),
      issuedQty: r4(p.quantity),
      issuedUnit: str(lot.baseUnit),
      nativeQty: r4(p.quantity),
      nativeUnit: str(lot.baseUnit),
      notes: str(note),
      customerMaterialLotId: lot._id,
      customerId: lot.customerId,
      customerLabel: str(lot.customerLabel),
      orderRef: str(lot.orderRef),
      orderLineRef: str(lot.orderLineRef),
      executionFileId: lot.executionFileId,
      expectationId: lot.expectationId,
      documentRef: str(lot.documentRef),
      expectationRevisionNo: lot.expectationRevisionNo,
      expectationLineRef: str(lot.expectationLineRef),
      warehouseId: p.warehouse._id,
      warehouseName: str(p.warehouse.name),
      locationId: p.location._id,
      locationCode: str(p.location.code),
      stockTransactionId: moved.txId,
      locationMovementId: moved.movementId,
    });
  }

  const [issuance] = await StockIssuance.create([{
    companyId: ctx.companyId,
    siteId: tenant.siteId || null,
    idempotencyKey: idempotencyKey || "",
    direction: "debit",
    ownership: "CUSTOMER_OWNED",
    manufacturingOrder: target.order.id,
    moNumber: target.order.number,
    customerName: str(plans[0].lot.customerLabel),
    items,
    reason: "Customer-supplied material issued to production",
    notes: str(note),
    performedBy: actor.id || null,
  }], { session, ordered: true });

  /* ── THE EXACT MOVEMENT, BY ITS OWN ID ────────────────────────────────────
     This used to be an array filter matching "any ISSUED movement whose
     `stockIssuanceId` is null", which would have stamped every historical issue
     that predated the field the first time it ran. The movement just created is
     known by id; nothing else is touched. */
  for (const m of posted) {
    await CustomerMaterialLot.updateOne(
      { _id: m.lot._id, companyId: ctx.companyId, "movements._id": m.movementDocId },
      { $set: { "movements.$.stockIssuanceId": issuance._id } },
      { session },
    );
  }

  return { issuance, lots: posted.map((m) => m.lot), target, documentRef: str(doc.documentRef) };
}

/* ═══ RETURN TO THE CUSTOMER ═══════════════════════════════════════════════ */

/** Stage one. Read-only, and never blocked by a withdrawn document. */
async function planReturn(ctx, {
  docId, rows, reason, returnedOn, claimed = {}, session = null,
} = {}) {
  if (!str(reason)) {
    throw fail("VALIDATION",
      "Say why the material is going back. The customer will ask, and the record is the answer.",
      { field: "reason" });
  }
  const doc = await addressedDocument(ctx, docId, session);
  /* Deliberately NOT refused for a cancelled document: a withdrawal is one of the
     main reasons material goes back. */

  const loaded = await loadLots(ctx, rows, session);
  for (const { lot } of loaded) assertLotBelongsTo(lot, doc);

  const first = loaded[0].lot;
  assertClaimMatches(claimed, {
    customerId: first.customerId,
    orderRef: first.orderRef,
    orderLineRef: first.orderLineRef,
    rawItemId: first.rawItemId,
    variantId: first.variantId,
    expectationLineRef: first.expectationLineRef,
    documentRef: first.documentRef,
  });

  /* ── THE EFFECTIVE DATE IS A FACT, NOT A TIMESTAMP ──────────────────────
     When the lorry left. It used to be parsed, echoed to the browser and then
     discarded while the movement stored `new Date()`. */
  const effectiveAt = returnedOn ? new Date(returnedOn) : new Date();
  if (Number.isNaN(effectiveAt.getTime())) {
    throw fail("VALIDATION", "That is not a date.", { field: "returnedOn" });
  }

  const plans = [];
  for (const { lot, quantity } of loaded) {
    assertLotHas({ lot, quantity, verb: "return" });
    const { warehouse, location } = await lotLocation(ctx, lot, claimed, session);
    plans.push({ lot, quantity, warehouse, location });
  }
  return { doc, plans, reason: str(reason), effectiveAt };
}

/** Stage two. One transaction, one canonical return record, exact linkage. */
async function postReturn(ctx, {
  tenant, session, doc, plans, reason, effectiveAt, customerReference = "",
  actor, idempotencyKey,
}) {
  const recordedAt = new Date();
  const posted = [];

  for (const p of plans) {
    const lot = await CustomerMaterialLot
      .findOne({ _id: p.lot._id, companyId: ctx.companyId }).session(session);
    if (!lot) throw fail("NOT_FOUND", "That lot was not found in this company.");
    assertLotBelongsTo(lot, doc);
    assertLotHas({ lot, quantity: p.quantity, verb: "return" });

    const out = await takeFromLot({
      session, ctx, tenant, lot, quantity: p.quantity,
      counter: "returnedQuantity",
      movement: {
        type: "RETURNED_TO_CUSTOMER",
        operationType: "RETURN_TO_CUSTOMER",
        locationType: "return",
        locationIntent: "return_to_customer",
        keySuffix: "cmreturn",
        reason: str(reason),
        /* The effective business date on the movement itself. */
        at: effectiveAt,
        recordedAt,
        extra: { customerReference: str(customerReference) },
      },
      actor, idempotencyKey, warehouse: p.warehouse, location: p.location,
      documentRef: str(doc.documentRef),
      note: `Returned to ${str(lot.customerLabel) || "customer"}`,
      stockMeta: {
        reason: "Customer-supplied material returned to customer",
        notes: `${str(lot.customerLabel)} · ${str(lot.orderRef)} · lot `
          + `${str(lot.goodsReceiptNumber)}${customerReference ? ` · ${str(customerReference)}` : ""}`,
      },
      locationSource: {
        kind: "customer_material_return",
        id: doc._id,
        reference: str(doc.documentRef),
        customerId: lot.customerId,
        customerMaterialLotId: lot._id,
        orderRef: str(lot.orderRef),
        orderLineRef: str(lot.orderLineRef),
      },
    });
    posted.push({ ...out, plan: p });
  }

  const [record] = await CustomerMaterialReturn.create([{
    companyId: ctx.companyId,
    siteId: tenant.siteId || null,
    idempotencyKey: idempotencyKey || "",
    operationKey: idempotencyKey || "",
    customerId: doc.customerId,
    customerLabel: str(doc.customerSnapshot?.customerLabel),
    orderRef: str(doc.orderRef),
    orderLineRef: str(doc.salesOrderLineRef),
    executionFileId: doc.executionFileId,
    documentRef: str(doc.documentRef),
    expectationId: doc._id,
    reason: str(reason),
    customerReference: str(customerReference),
    effectiveAt,
    recordedAt,
    recordedBy: { id: actor.id || null, name: actor.name || "" },
    lines: posted.map((m) => ({
      lotId: m.lot._id,
      goodsReceiptNumber: str(m.lot.goodsReceiptNumber),
      expectationLineRef: str(m.lot.expectationLineRef),
      expectationRevisionNo: m.lot.expectationRevisionNo,
      rawItemId: m.lot.rawItemId,
      variantId: m.lot.variantId || null,
      itemName: str(m.lot.itemName),
      quantity: r4(m.plan.quantity),
      baseUnit: str(m.lot.baseUnit),
      warehouseId: m.plan.warehouse._id,
      locationId: m.plan.location._id,
      locationCode: str(m.plan.location.code),
      stockTransactionId: m.txId,
      locationMovementId: m.movementId,
      lotMovementId: m.movementDocId,
    })),
  }], { session, ordered: true });

  /* The exact movements, by id. */
  for (const m of posted) {
    await CustomerMaterialLot.updateOne(
      { _id: m.lot._id, companyId: ctx.companyId, "movements._id": m.movementDocId },
      { $set: { "movements.$.customerReturnId": record._id } },
      { session },
    );
  }

  return {
    record,
    lots: posted.map((m) => m.lot),
    effectiveAt,
    recordedAt,
    reason: str(reason),
    customerReference: str(customerReference),
    documentRef: str(doc.documentRef),
  };
}

/* ═══ RECOVERY THAT PROVES THE EXACT OPERATION ═════════════════════════════ */

/**
 * Did THIS operation post, and did all of it post?
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * Recovery used to look for "any lot in this company with any
 * RETURNED_TO_CUSTOMER movement". An unrelated return from last month satisfied
 * that, so a failed new return reported success and the operator was told their
 * work had landed when nothing had moved.
 *
 * It now queries by company, operation type and the exact idempotency key, and
 * then PROVES completeness: every lot the plan named must carry a movement from
 * this operation, for the quantity expected. A partially posted operation answers
 * `complete: false`, which is a reconciliation case rather than a success.
 */
async function findPostedOperation(ctx, {
  operationType, idempotencyKey, expected = [],
}) {
  const key = str(idempotencyKey);
  if (!key) return { found: false, complete: false, record: null, posted: [] };

  if (operationType === "RETURN_TO_CUSTOMER") {
    const record = await CustomerMaterialReturn
      .findOne({ companyId: ctx.companyId, idempotencyKey: key }).lean();
    if (!record) return { found: false, complete: false, record: null, posted: [] };
    const posted = (record.lines || []).map((l) => ({
      lotId: str(l.lotId), quantity: r4(l.quantity),
    }));
    return { found: true, complete: coversExpected(posted, expected), record, posted };
  }

  const issuance = await StockIssuance
    .findOne({
      companyId: ctx.companyId, ownership: "CUSTOMER_OWNED", idempotencyKey: key,
    }).lean();
  if (!issuance) return { found: false, complete: false, record: null, posted: [] };
  const posted = (issuance.items || []).map((i) => ({
    lotId: str(i.customerMaterialLotId), quantity: r4(i.issuedQty),
  }));
  return { found: true, complete: coversExpected(posted, expected), record: issuance, posted };
}

/**
 * Every expected lot and quantity accounted for.
 *
 * `expected` empty means the caller could not reconstruct the plan — recovery
 * then cannot prove completeness and says so, rather than assuming it.
 */
function coversExpected(posted, expected) {
  if (!expected.length) return false;
  const have = new Map(posted.map((p) => [str(p.lotId), r4(p.quantity)]));
  return expected.every((e) => have.get(str(e.lotId)) === r4(e.quantity));
}

/* ═══ WHERE IT MAY GO — OFFERED, NOT GUESSED ════════════════════════════════ */

/**
 * The production order this document's material may be issued to, and the work
 * orders that can be PROVED to be making its line.
 *
 * ── WHY THE SERVER CHOOSES THE LIST ────────────────────────────────────────
 * A screen that let somebody type or pick any work order would be inviting the
 * mistake this whole design exists to prevent. The list is derived from the same
 * stored references the issue itself is checked against, so a control can only
 * offer destinations that will be accepted — and if none can be proved, it says
 * so rather than offering a plausible wrong one.
 */
async function productionTargets(ctx, { expectationId }, session = null) {
  const doc = await CustomerMaterialExpectation
    .findOne({ _id: expectationId, companyId: ctx.companyId }).session(session).lean();
  if (!doc) throw fail("NOT_FOUND", "That document was not found.");

  const file = await ExecutionFile
    .findOne({ _id: doc.executionFileId, companyId: ctx.companyId })
    .select("currentHandoverVersionId currentExecutionProjection").session(session).lean();
  if (!file) throw fail("NOT_FOUND", "The execution file behind this document was not found.");

  const customerIdentity = require("../merchandising/customerIdentity.service");
  const identity = await customerIdentity.resolveFromFile(ctx, file, session);
  if (!identity.ok) {
    /* Reported rather than thrown: a screen should be able to explain why there
       is nothing to choose, instead of failing to load. */
    return {
      manufacturingOrder: null, workOrders: [],
      unavailable: { reason: identity.reason, message: identity.message },
    };
  }

  const order = await CustomerRequest
    .findById(identity.customerRequestId).select("requestId").session(session).lean();
  const salesLine = str(doc.salesOrderLineRef) || str(file.currentExecutionProjection?.orderLineRef);

  /* Only work orders whose STORED link names this company, this order and this
     permanent line. Nothing is matched by product, style or buyer. */
  const workOrders = salesLine
    ? await WorkOrder.find({
      "salesLineLink.companyId": ctx.companyId,
      "salesLineLink.customerRequestId": identity.customerRequestId,
      "salesLineLink.lineRef": salesLine,
    }).select("workOrderNumber").sort({ workOrderNumber: 1 }).session(session).lean()
    : [];

  return {
    manufacturingOrder: order
      ? { id: str(order._id), number: str(order.requestId) }
      : null,
    orderLineRef: salesLine,
    workOrders: workOrders.map((w) => ({ id: str(w._id), number: str(w.workOrderNumber) })),
    /* Said explicitly, because an empty list has two quite different causes:
       no work order has been created, or none records the link. */
    unavailable: null,
  };
}

module.exports = {
  productionTargets,
  addressedDocument,
  assertLotBelongsTo,
  revisionInForce,
  assertIssuableDocument,
  loadLots,
  assertLotHas,
  proveProductionTarget,
  assertClaimMatches,
  lotLocation,
  applyStockOut,
  takeFromLot,
  planIssue,
  postIssue,
  planReturn,
  postReturn,
  findPostedOperation,
  coversExpected,
};
