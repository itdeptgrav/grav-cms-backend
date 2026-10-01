// services/storePurchase/customerMaterialReceipt.service.js
//
// RECEIVING GOODS THE FACTORY DID NOT BUY.
//
// The customer-material SOURCE ADAPTER. It answers the questions only the source
// can answer — which lines exist, how much is outstanding on each, whose goods
// these are — and then hands the physical act to `receiptPosting.service`, which
// is the same implementation a purchase receipt uses. Nothing here converts a
// unit, moves a balance or allocates a number: a second copy of any of those
// would be a second answer to "how much arrived", and the first time the two
// disagreed one kind of goods would post differently for reasons nobody could
// find.
//
// ── WHAT IT ADDS THAT A PURCHASE RECEIPT HAS NO NEED OF ─────────────────────
// An OWNERSHIP LOT per received line. A purchase receipt does not need one: the
// factory owns what it bought, and `RawItem.quantity` plus a location balance is
// the whole truth. Customer goods are different — the same poplin may be held for
// two customers, for two orders of one customer, and for two lines of one order,
// and a single quantity has already lost every distinction that matters. The lot
// is where those distinctions live, and it is created in the SAME transaction as
// the receipt, because stock that exists without a provable owner is the one
// outcome this design must never produce.
//
// ── AND WHAT IT REFUSES TO CARRY ────────────────────────────────────────────
// No supplier, no invoice number, no unit price, no value, nothing payable and
// no procurement spend. The `GoodsReceipt` validator refuses all of them
// outright for this source type, so it is not a convention this file observes —
// it is a document that will not save.
//
// ── RECEIPT PROGRESS IS NEVER STORED ON THE EXPECTATION ─────────────────────
// Nothing here writes a received quantity back onto the expectation. Progress is
// DERIVED from goods receipts every time it is asked for. A stored counter is a
// second source of truth that drifts the first time a receipt is voided, a
// transaction half-commits, or a revision is issued — and it drifts silently,
// because nothing recomputes it to notice.
"use strict";

const mongoose = require("mongoose");

const materialOwnership = require("../inventory/materialOwnership.service");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const {
  CustomerMaterialExpectation, STATE,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const posting = require("./receiptPosting.service");
const { fail } = require("./errors");

const { r4 } = posting;
const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/* ═══ WHAT MAY BE RECEIVED AGAINST ═════════════════════════════════════════ */

/**
 * The expectation a receipt discharges — ISSUED only.
 *
 * ── WHY NOT A DRAFT, AND WHY NOT A CANCELLED ONE ────────────────────────────
 * A draft is a document somebody is still composing; receiving against one would
 * mean Store acting on a decision nobody has taken, and the quantities could
 * change underneath the receipt afterwards.
 *
 * A cancelled one has been withdrawn. Stock already received against it STAYS —
 * the goods are on the shelf and cancelling a document does not unship a lorry —
 * but no more may be received, because the document no longer says anything is
 * coming.
 */
async function receivableExpectation(ctx, { documentRef, expectationId }, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to record a receipt.");

  const where = { companyId: ctx.companyId, state: STATE.ISSUED };
  if (isId(expectationId)) where._id = expectationId;
  else if (str(documentRef)) where.documentRef = str(documentRef);
  else throw fail("VALIDATION", "Say which customer-material document this is against.", { field: "documentRef" });

  /* The HIGHEST issued revision. A receipt is always recorded against what is
     currently stated — receiving against a superseded revision would book goods
     against requirements somebody has already replaced. */
  const doc = await CustomerMaterialExpectation.findOne(where)
    .sort({ revisionNo: -1 }).session(session);

  if (!doc) {
    /* Told apart from "not found at all", because the two need different
       answers: one is a wrong reference, the other is a document that exists and
       is not receivable yet. */
    const any = await CustomerMaterialExpectation.findOne(
      isId(expectationId)
        ? { companyId: ctx.companyId, _id: expectationId }
        : { companyId: ctx.companyId, documentRef: str(documentRef) },
    ).sort({ revisionNo: -1 }).session(session).lean();
    if (!any) throw fail("NOT_FOUND", "That customer-material document was not found.");
    if (any.state === STATE.DRAFT) {
      throw fail("LIFECYCLE_BLOCKED",
        "That document has not been stated to Store yet, so nothing can be received against it.",
        { reason: "EXPECTATION_NOT_ISSUED", state: any.state });
    }
    throw fail("LIFECYCLE_BLOCKED",
      "That document was withdrawn, so no more can be received against it. Anything already "
      + "received stays on the record — withdrawing a document does not unship a delivery.",
      { reason: "EXPECTATION_CANCELLED", state: any.state });
  }

  /* ── AN OWNERSHIP LOT NEEDS A PROVABLE OWNER ──────────────────────────────
     A Phase 1 document carries no `customerId`. It stays readable, and it cannot
     be received against until it is reissued with the chain repaired: a lot with
     no owner is stock nobody can attribute, and the only safe thing to do with
     that is nothing. */
  if (!doc.customerId) {
    throw fail("LIFECYCLE_BLOCKED",
      "This document does not name the customer whose goods these are, so nothing can be "
      + "received against it. Ask Merchandising to reissue it once Sales has attached the "
      + "customer to the order.",
      { reason: "CUSTOMER_IDENTITY_UNPROVEN", documentRef: str(doc.documentRef) });
  }
  return doc;
}

/* ═══ HOW MUCH IS OUTSTANDING ══════════════════════════════════════════════ */

/**
 * Everything ever received against one document reference, by line.
 *
 * Keyed on `documentRef + sourceLineRef`, which is the identity that SURVIVES A
 * REVISION. That is the whole reason a receipt against revision 1 still counts
 * after revision 2 is issued: the line is the same line, and the revision number
 * on each receipt records which statement it was measured against.
 *
 * VOID receipts are excluded. A voided receipt is a receipt that should never
 * have counted, and including it would hold a line closed against goods nobody
 * has.
 */
async function receivedByLine(ctx, documentRef, session = null) {
  const rows = await GoodsReceipt.find({
    companyId: ctx.companyId,
    sourceType: "CUSTOMER_MATERIAL",
    sourceDocumentNumber: str(documentRef),
    status: { $ne: "VOID" },
  }).sort({ receiptDate: 1, createdAt: 1 }).session(session).lean();

  const byLine = new Map();
  for (const grn of rows) {
    for (const line of grn.lines || []) {
      const ref = str(line.sourceLineRef);
      if (!ref) continue;
      if (!byLine.has(ref)) byLine.set(ref, { received: 0, receipts: [] });
      const entry = byLine.get(ref);
      /* Summed in the RECEIPT unit, which is the expectation's unit — the
         adapter refuses a receipt in any other unit, precisely so that this sum
         is a number and not an apples-and-oranges total. */
      entry.received = r4(entry.received + (Number(line.receivedQuantity) || 0));
      entry.receipts.push({
        goodsReceiptId: str(grn._id),
        receiptNumber: str(grn.receiptNumber),
        receiptDate: grn.receiptDate || null,
        quantity: Number(line.receivedQuantity) || 0,
        unit: str(line.poUnit) || str(line.baseUnit),
        /* Which statement this was measured against. */
        againstRevisionNo: grn.customerMaterial?.expectationRevisionNo ?? null,
        customerReference: str(grn.customerMaterial?.customerReference),
        recordedBy: str(grn.recordedBy?.name),
        warehouseName: str(grn.warehouseName),
        locationCode: str(grn.locationCode),
      });
    }
  }
  return byLine;
}

const RECEIPT_STATUS = Object.freeze({
  NOT_RECEIVED: "NOT_RECEIVED",
  PARTIALLY_RECEIVED: "PARTIALLY_RECEIVED",
  RECEIVED: "RECEIVED",
  SHORT_CLOSED: "SHORT_CLOSED",
  CANCELLED: "CANCELLED",
});

/**
 * The receipt standing of one line — derived, never stored.
 *
 * ── WHY THE DOCUMENT'S STATE IS NOT ONE OF THESE ────────────────────────────
 * `DRAFT / ISSUED / CANCELLED` is the AUTHORING lifecycle: what somebody has
 * decided to state. Receipt standing is what has physically happened. Folding
 * them into one field would mean an issued document turning itself into
 * "RECEIVED", at which point the record can no longer distinguish "Merchandising
 * has stated this" from "the goods are here" — and those have different owners,
 * different evidence and different consequences.
 *
 * CANCELLED appears here only because a withdrawn document stops expecting
 * anything: it is the one place the two lifecycles legitimately meet.
 */
function lineStanding(line, receipt, documentState) {
  const required = r4(Number(line.requiredQuantity) || 0);
  const received = r4(receipt?.received || 0);
  const pending = r4(Math.max(0, required - received));

  let status = RECEIPT_STATUS.NOT_RECEIVED;
  if (documentState === STATE.CANCELLED) status = RECEIPT_STATUS.CANCELLED;
  else if (line.shortClosedAt) status = RECEIPT_STATUS.SHORT_CLOSED;
  else if (received >= required && required > 0) status = RECEIPT_STATUS.RECEIVED;
  else if (received > 0) status = RECEIPT_STATUS.PARTIALLY_RECEIVED;

  const history = receipt?.receipts || [];
  return {
    lineRef: str(line.lineRef),
    requiredQuantity: required,
    receivedQuantity: received,
    /* Pending is what MAY still be received. A short-closed line expects
       nothing more, and a cancelled document expects nothing at all — reporting
       an outstanding figure for either would invite somebody to chase it. */
    pendingQuantity: (line.shortClosedAt || documentState === STATE.CANCELLED) ? 0 : pending,
    /* And the arithmetic shortfall, kept separately, because "nothing more is
       coming" and "nothing more is owed" are different statements and a
       short-closure does not make the missing quantity stop having been
       missing. */
    shortfallQuantity: line.shortClosedAt ? pending : 0,
    unit: str(line.unit),
    status,
    receiptCount: history.length,
    latestReceipt: history.length ? history[history.length - 1] : null,
    receiptHistory: history,
    shortClosedAt: line.shortClosedAt || null,
    shortClosedBy: line.shortClosedBy?.name ? { name: str(line.shortClosedBy.name) } : null,
    shortCloseReason: str(line.shortCloseReason),
  };
}

/* ═══ WHAT IS PHYSICALLY THERE, PER LINE ═══════════════════════════════════
   Receipt standing answers "did it arrive". This answers "where is it now" —
   held, issued to production, or gone back to the customer — and it is derived
   from the LOTS, which are the only records that know.

   Kept separate from receipt standing for the same reason receipt standing is
   kept separate from the authoring state: they are three different questions
   with three different sources, and one field holding all of them could answer
   none of them precisely. */
async function heldByLine(ctx, documentRef, session = null) {
  const lots = await CustomerMaterialLot.find({
    companyId: ctx.companyId, documentRef: str(documentRef),
  }).sort({ receivedAt: 1 }).session(session).lean();

  /* How many labels exist per lot, counted in one query rather than per lot. */
  const lotIds = lots.map((l) => l._id);
  const labels = lotIds.length
    ? await Barcode.aggregate([
      { $match: { "customerMaterial.lotId": { $in: lotIds } } },
      { $group: { _id: "$customerMaterial.lotId", n: { $sum: 1 } } },
    ]).session(session)
    : [];
  const labelled = new Map(labels.map((r) => [str(r._id), r.n]));

  const byLine = new Map();
  for (const lot of lots) {
    const ref = str(lot.expectationLineRef);
    if (!byLine.has(ref)) {
      byLine.set(ref, {
        available: 0, issued: 0, returnedToCustomer: 0, lots: [],
        latestIssue: null, latestReturn: null,
      });
    }
    const entry = byLine.get(ref);
    entry.available = r4(entry.available + (Number(lot.availableQuantity) || 0));
    entry.issued = r4(entry.issued + (Number(lot.issuedQuantity) || 0));
    entry.returnedToCustomer = r4(entry.returnedToCustomer + (Number(lot.returnedQuantity) || 0));
    entry.lots.push(lotView(lot, labelled.get(str(lot._id)) || 0));

    /* ── THE MOST RECENT HANDOVER, FOR A SENTENCE ─────────────────────────
       Merchandising's status block says "220 m issued to production for WO-…",
       and the work order in that sentence comes from here. The newest ISSUED
       movement across the line's lots, because a reader wants the one that
       happened, not a list. */
    for (const m of (lot.movements || [])) {
      if (str(m.type) !== "ISSUED") continue;
      const at = m.at ? new Date(m.at).getTime() : 0;
      if (!entry.latestIssue || at >= entry.latestIssue.at) {
        entry.latestIssue = {
          at,
          when: m.at || null,
          quantity: m.quantity,
          manufacturingOrderNumber: str(m.manufacturingOrderNumber),
          workOrderNumber: str(m.workOrderNumber),
          by: str(m.by?.name),
        };
      }
    }

    /* ── AND THE MOST RECENT RETURN, ON THE DAY IT ACTUALLY LEFT ───────────
       `m.at` is the effective business date the operator entered, not the moment
       the row was written, so a status line reads "40 m returned on 12 Sep" even
       when it was keyed in on the 15th. Merchandising and PPC read this through
       `standingFor`, so all three departments quote one date. */
    for (const m of (lot.movements || [])) {
      if (str(m.type) !== "RETURNED_TO_CUSTOMER") continue;
      const at = m.at ? new Date(m.at).getTime() : 0;
      if (!entry.latestReturn || at >= entry.latestReturn.at) {
        entry.latestReturn = {
          at,
          when: m.at || null,
          recordedAt: m.recordedAt || null,
          quantity: m.quantity,
          reason: str(m.reason),
          customerReference: str(m.customerReference),
          by: str(m.by?.name),
        };
      }
    }
  }
  return byLine;
}

/** One lot, as Store reads it. Named facts, never an internal id as a label. */
function lotView(lot, labelCount = 0) {
  return {
    id: str(lot._id),
    /* What a person quotes: the receipt number, not the lot's own id. */
    goodsReceiptNumber: str(lot.goodsReceiptNumber),
    goodsReceiptId: str(lot.goodsReceiptId),
    receivedAt: lot.receivedAt || null,
    customer: {
      id: str(lot.customerId), label: str(lot.customerLabel), code: str(lot.customerCode),
    },
    orderRef: str(lot.orderRef),
    orderLineRef: str(lot.orderLineRef),
    expectationLineRef: str(lot.expectationLineRef),
    againstRevisionNo: lot.expectationRevisionNo ?? null,
    material: {
      rawItemId: str(lot.rawItemId), name: str(lot.itemName), sku: str(lot.sku),
      variantId: lot.variantId ? str(lot.variantId) : null,
      variantCombination: (lot.variantCombination || []).map(str),
    },
    where: {
      warehouseId: str(lot.warehouseId), warehouseName: str(lot.warehouseName),
      locationId: str(lot.locationId), locationCode: str(lot.locationCode),
    },
    received: { quantity: lot.receiptQuantity, unit: str(lot.receiptUnit) },
    base: { unit: str(lot.baseUnit), quantity: lot.baseQuantity },
    availableQuantity: lot.availableQuantity,
    issuedQuantity: lot.issuedQuantity,
    returnedToCustomerQuantity: lot.returnedQuantity,
    status: str(lot.status),
    /* The customer's own reference for the delivery this lot came in on. */
    label: {
      count: labelCount,
      printed: labelCount > 0,
      lastPrintedAt: lot.lastLabelledAt || null,
      /* ── HOW MUCH OF THE LOT IS ALREADY ON A LABEL ─────────────────────
         A count cannot answer "may another 300 metres be labelled"; only the
         quantity can, and a screen that offers a quantity it will be refused for
         is worse than one that offers nothing. */
      labelledQuantity: r4(lot.labelledQuantity || 0),
      stillLabelable: r4(Math.max(
        0, r4(lot.availableQuantity || 0) - r4(lot.labelledQuantity || 0),
      )),
    },
    lastMovementAt: lot.lastMovementAt || null,
    movementCount: (lot.movements || []).length,
  };
}

/** Every line's standing for one document, plus the document's own roll-up. */
async function standingFor(ctx, doc, session = null) {
  const byLine = await receivedByLine(ctx, doc.documentRef, session);
  const held = await heldByLine(ctx, doc.documentRef, session);
  /* What the catalogue says each material normally is. The document, not the
     catalogue, decides the ownership of what is received here — this is shown
     beside the line so a storekeeper sees when the two disagree. */
  const defaults = await materialOwnership.materialDefaultsFor(
    ctx, (doc.lines || []).map((l) => l.rawItemId), session,
  );
  const lines = (doc.lines || []).map((l) => {
    const base = lineStanding(l, byLine.get(str(l.lineRef)), doc.state);
    base.rawItemId = str(l.rawItemId);
    base.materialDefault = defaults.get(str(l.rawItemId)) || null;
    const physical = held.get(str(l.lineRef))
      || {
        available: 0, issued: 0, returnedToCustomer: 0, lots: [],
        latestIssue: null, latestReturn: null,
      };
    return {
      ...base,
      /* ── WHERE IT IS NOW ──────────────────────────────────────────────
         Received is what arrived; these three say what became of it. They sum
         to the received quantity, always, because every receipt creates a lot
         and nothing else changes a lot's total. */
      availableQuantity: physical.available,
      issuedQuantity: physical.issued,
      returnedToCustomerQuantity: physical.returnedToCustomer,
      lots: physical.lots,
      /* The newest handover, so a status sentence can name the work order it
         went to rather than making somebody open the lot history. */
      latestIssue: physical.latestIssue
        ? {
          when: physical.latestIssue.when,
          quantity: physical.latestIssue.quantity,
          manufacturingOrderNumber: physical.latestIssue.manufacturingOrderNumber,
          workOrderNumber: physical.latestIssue.workOrderNumber,
          by: physical.latestIssue.by,
        }
        : null,
      /* ── AND THE NEWEST RETURN, WITH THE DATE IT LEFT ───────────────────
         `when` is the effective business date the operator entered; `recordedAt`
         is when it was keyed in. Store's detail, Merchandising's read-only block
         and PPC's availability all read this, so none of them has to reconstruct
         the date and none of them can show a different one. */
      latestReturn: physical.latestReturn
        ? {
          when: physical.latestReturn.when,
          recordedAt: physical.latestReturn.recordedAt,
          quantity: physical.latestReturn.quantity,
          reason: physical.latestReturn.reason,
          customerReference: physical.latestReturn.customerReference,
          by: physical.latestReturn.by,
        }
        : null,
      /* One word for the physical position, distinct from the receipt word. */
      operationalStanding: operationalStandingOf(base, physical),
    };
  });

  /* ── THE DOCUMENT'S ROLL-UP, FROM THE LINES ──────────────────────────────
     Deliberately not a summed quantity: a document carrying metres, kilograms
     and pieces has no meaningful total, and printing one invites somebody to
     divide by it. It is a count of lines in each standing, which is a figure
     that means what it says. */
  const counts = Object.fromEntries(Object.values(RECEIPT_STATUS).map((s) => [s, 0]));
  for (const l of lines) counts[l.status] += 1;

  const settled = lines.length > 0 && lines.every(
    (l) => [RECEIPT_STATUS.RECEIVED, RECEIPT_STATUS.SHORT_CLOSED, RECEIPT_STATUS.CANCELLED].includes(l.status),
  );
  const anyReceived = lines.some((l) => l.receivedQuantity > 0);

  const allReceipts = lines.flatMap((l) => l.receiptHistory);
  const latest = allReceipts.length
    ? allReceipts.reduce((a, b) => (new Date(b.receiptDate || 0) >= new Date(a.receiptDate || 0) ? b : a))
    : null;

  return {
    lines,
    counts,
    /* One word for the document, for a register column. */
    standing: doc.state === STATE.CANCELLED ? RECEIPT_STATUS.CANCELLED
      : settled ? (counts[RECEIPT_STATUS.SHORT_CLOSED] > 0 ? RECEIPT_STATUS.SHORT_CLOSED : RECEIPT_STATUS.RECEIVED)
        : anyReceived ? RECEIPT_STATUS.PARTIALLY_RECEIVED : RECEIPT_STATUS.NOT_RECEIVED,
    /* ── WHO HAS TO DO SOMETHING NEXT ─────────────────────────────────────
        Store while anything is still expected — they are the ones who will
        receive it. Merchandising only when a decision is needed: the document is
        withdrawn, or every line is settled and nothing more will happen without
        a new statement. Naming an owner who cannot act is how a queue becomes
        noise. */
    nextOwner: doc.state === STATE.CANCELLED ? "MERCHANDISING"
      : settled ? "MERCHANDISING" : "STORE",
    latestReceipt: latest,
    latestReceiptDate: latest?.receiptDate || null,
    /* The document's physical totals, for a register column. */
    availableQuantity: r4(lines.reduce((s, l) => s + (l.availableQuantity || 0), 0)),
    issuedQuantity: r4(lines.reduce((s, l) => s + (l.issuedQuantity || 0), 0)),
    returnedToCustomerQuantity: r4(lines.reduce((s, l) => s + (l.returnedToCustomerQuantity || 0), 0)),
    /* The most recent thing that happened to any of its material. */
    latestMovementAt: lines
      .flatMap((l) => (l.lots || []).map((x) => x.lastMovementAt || x.receivedAt))
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null,
  };
}

/* ── WHERE THE MATERIAL IS, IN ONE WORD ─────────────────────────────────────
   Deliberately its own vocabulary. "Received" says it arrived; it says nothing
   about whether it is still on the shelf, which is the question a storekeeper
   and a production planner both actually ask. */
const OPERATIONAL = Object.freeze({
  NONE_HELD: "NONE_HELD",           // nothing has arrived, or nothing is left
  HELD: "HELD",                     // in Store, available to issue
  PARTLY_ISSUED: "PARTLY_ISSUED",   // some with production, some still held
  FULLY_ISSUED: "FULLY_ISSUED",     // all of it is with production
  RETURNED: "RETURNED",             // all of it went back to the customer
});

function operationalStandingOf(base, physical) {
  const available = r4(physical.available);
  const issued = r4(physical.issued);
  const returned = r4(physical.returnedToCustomer);
  if (available <= 0 && issued <= 0 && returned <= 0) return OPERATIONAL.NONE_HELD;
  if (available <= 0 && issued <= 0 && returned > 0) return OPERATIONAL.RETURNED;
  if (available <= 0 && issued > 0) return OPERATIONAL.FULLY_ISSUED;
  if (issued > 0) return OPERATIONAL.PARTLY_ISSUED;
  return OPERATIONAL.HELD;
}

/* ═══ BUILDING A RECEIPT ═══════════════════════════════════════════════════ */

/**
 * Validate every requested line against the expectation and build plans.
 *
 * Runs entirely BEFORE any write, so an unknown line, a duplicate, a
 * non-positive quantity, a wrong unit, a short-closed line, a missing conversion
 * and over-receipt all refuse with nothing mutated.
 */
async function validateReceiptLines(ctx, { doc, items }, session = null) {
  if (!Array.isArray(items) || items.length === 0) {
    throw fail("VALIDATION", "At least one line is required.", { reason: "NO_LINES" });
  }
  const byLine = await receivedByLine(ctx, doc.documentRef, session);

  const plans = [];
  const seen = new Set();
  for (const ri of items) {
    const ref = str(ri.lineRef);
    const line = (doc.lines || []).find((l) => str(l.lineRef) === ref);
    if (!line) {
      throw fail("VALIDATION", `Line ${ref || "(unnamed)"} is not on this document.`,
        { reason: "UNKNOWN_LINE", lineRef: ref });
    }
    if (seen.has(ref)) {
      throw fail("VALIDATION", `Line "${line.rawItemName}" appears more than once in this receipt.`,
        { reason: "DUPLICATE_LINE", lineRef: ref });
    }
    seen.add(ref);

    /* ── A SHORT-CLOSED LINE EXPECTS NOTHING MORE ─────────────────────────
       Reopening is an explicit, audited act. Letting a receipt quietly reopen it
       would make the short-closure meaningless — somebody decided nothing more
       was coming, and that decision is a record. */
    if (line.shortClosedAt) {
      throw fail("LIFECYCLE_BLOCKED",
        `"${line.rawItemName}" was short closed, so no more is expected. Reopen the line if the `
        + "customer is sending more after all.",
        { reason: "LINE_SHORT_CLOSED", lineRef: ref });
    }

    const qty = Number(ri.quantity);
    if (!(qty > 0)) {
      throw fail("VALIDATION", `A positive received quantity is required for "${line.rawItemName}".`,
        { reason: "NON_POSITIVE_QTY", lineRef: ref });
    }

    /* ── THE RECEIPT UNIT IS THE EXPECTATION'S UNIT ───────────────────────
       Not a free choice. The expectation says how much is expected and in what;
       accepting a different unit here would mean the received total and the
       required total are in different units, and `received >= required` would be
       comparing two unrelated numbers. Base-unit conversion still happens for the
       stock movement — that is a different question. */
    const unit = str(ri.unit) || str(line.unit);
    if (unit.toLowerCase() !== str(line.unit).toLowerCase()) {
      throw fail("VALIDATION",
        `"${line.rawItemName}" is expected in ${line.unit}. Record the receipt in ${line.unit}, `
        + "so that what arrived and what was expected can be compared.",
        { reason: "UNIT_MISMATCH", lineRef: ref, expected: str(line.unit), sent: unit });
    }

    const required = r4(Number(line.requiredQuantity) || 0);
    const previouslyReceived = r4(byLine.get(ref)?.received || 0);
    const pending = r4(Math.max(0, required - previouslyReceived));
    /* The shared refusal. Over-receipt is refused before any write, whichever
       gate the goods came through. */
    posting.assertWithinPending({
      requested: qty, pending, label: line.rawItemName, unit: str(line.unit),
      details: { lineRef: ref, documentRef: str(doc.documentRef) },
    });

    const rawItemId = line.rawItemId ? String(line.rawItemId) : null;
    const baseUnit = await posting.baseUnitOf(rawItemId, str(line.unit), session);
    const conv = await posting.resolveConversion({
      quantity: qty, fromUnit: str(line.unit), toUnit: baseUnit, session,
    });

    plans.push({
      /* The source-neutral line key the shared posting uses for its per-line
         movement idempotency. */
      lineKey: ref,
      sourceLineId: line._id,
      sourceLineRef: ref,
      rawItemId,
      variantId: line.variantId ? String(line.variantId) : null,
      variantCombination: (line.variantCombination || []).map(str),
      itemName: str(line.rawItemName),
      sku: str(line.rawItemSku),
      variantSku: "",
      poUnit: str(line.unit),
      receivedQuantity: r4(qty),
      baseUnit,
      baseQuantity: conv.baseQuantity,
      conversionFactor: conv.factor,
      conversionNote: conv.note,
      quantityOrdered: required,
      previouslyReceived,
      /* No unit price. The factory bought nothing. */
    });
  }
  return { plans };
}

/**
 * Post a validated receipt inside the caller's unit of work.
 *
 * ONE transaction commits the receipt, the stock movement, the location
 * movement, the ownership lots and the audit. A failure in any step rolls back
 * every step — a lot without its GRN would be stock nobody can trace, and a GRN
 * without its lot would be a customer's goods on the shelf owned by nobody.
 */
async function applyReceipt({
  session, tenant, ctx, doc, plans, header, actor, idempotencyKey,
}) {
  const companyId = tenant.companyId;

  /* ── SERIALISE RECEIPTS AGAINST THIS DOCUMENT ────────────────────────────
     The FIRST write of the transaction, before anything is allocated or moved.
     Two simultaneous receipts both read "nothing received yet" and both find the
     full quantity pending — snapshot isolation does not stop them, because it
     only conflicts on documents they both touch. This is the document they are
     both made to touch: the loser takes a write conflict, the driver retries it,
     and the retry re-reads the receipts and refuses the over-receipt properly.

     Nothing reads the counter's value. It is a lock, not a tally — see the field
     on the model for why it is not `revision`. */
  await CustomerMaterialExpectation.updateOne(
    { _id: doc._id, companyId },
    { $inc: { receiptSerial: 1 } },
    { session },
  );

  /* ── AND RE-ASSERT WHAT IS PENDING, INSIDE THE TRANSACTION ───────────────
     The plans were validated before the transaction opened, which is right: a
     bad request should be refused quickly with nothing started. But that check
     cannot be the GUARANTEE, for a reason the serialisation above only half
     solves — when the loser takes a write conflict the driver retries the whole
     transaction, and the retry would otherwise re-post the plan it composed the
     first time, still saying the full quantity was pending.

     So the invariant is asserted again here, against what the receipts say
     INSIDE this session. Validated early for a clean refusal; re-asserted here
     because this is the only place the answer cannot change underneath it. */
  const nowReceived = await receivedByLine(ctx, doc.documentRef, session);
  for (const pl of plans) {
    const already = r4(nowReceived.get(pl.sourceLineRef)?.received || 0);
    posting.assertWithinPending({
      requested: pl.receivedQuantity,
      pending: r4(Math.max(0, pl.quantityOrdered - already)),
      label: pl.itemName,
      unit: pl.poUnit,
      details: { lineRef: pl.sourceLineRef, documentRef: str(doc.documentRef) },
    });
    /* The receipt line's own before/after figures must describe what was true
       when it was written, not what the first attempt thought. */
    pl.previouslyReceived = already;
  }

  const { number: receiptNumber } = await posting.allocateReceiptNumber({
    companyId, session, siteId: tenant.siteId || null,
  });

  const wh = header.warehouse || null;
  const loc = header.location || null;
  const customerLabel = str(doc.customerSnapshot?.customerLabel);

  /* ── THE CUSTOMER-MATERIAL SOURCE'S PROVENANCE ───────────────────────────
     Whose goods, for which order, against which document. Deliberately no
     supplier, no price and no invoice: there is nowhere for one to go and the
     GoodsReceipt validator refuses them. */
  const source = {
    type: "CUSTOMER_MATERIAL",
    documentId: doc._id,
    documentNumber: str(doc.documentRef),
    stockMeta: (pl) => ({
      reason: "Customer-supplied material receipt",
      /* Explicit ownership on the physical movement: these goods are the
         customer's, physically held by us. The valuation engine reads this to
         exclude them from company inventory value and company-owned on-hand
         while leaving RawItem.quantity — the physical total — untouched. */
      ownership: "CUSTOMER",
      /* `notes` carries the provenance a stock-ledger reader sees. It names the
         customer and the order, and never a supplier — a stock transaction that
         said "supplier: <customer>" would turn a buyer into a vendor in every
         report that groups by one. */
      notes: `GRN ${receiptNumber} · customer-supplied for ${str(doc.orderRef)}`
        + `${customerLabel ? ` (${customerLabel})` : ""}`
        + `${pl.conversionNote ? ` (${pl.conversionNote})` : ""}`,
    }),
    locationSource: (pl) => ({
      kind: "customer_material_receipt",
      id: doc._id,
      reference: str(doc.documentRef),
      customerId: doc.customerId,
      orderRef: str(doc.orderRef),
      /* The permanent Sales line where the document carries one. A movement that
         named only the expectation's line could not be matched to a production
         order, which is the question asked of it downstream. */
      orderLineRef: str(doc.salesOrderLineRef) || str(pl.sourceLineRef),
    }),
  };

  await posting.postMovements({
    session, tenant, plans, receiptNumber, header, actor, idempotencyKey, source,
  });

  const grnLines = plans.map((pl) => ({
    sourceLineId: pl.sourceLineId,
    sourceLineRef: pl.sourceLineRef,
    rawItemId: pl.rawItemId, variantId: pl.variantId,
    variantCombination: pl.variantCombination,
    itemName: pl.itemName, sku: pl.sku, variantSku: pl.variantSku,
    poUnit: pl.poUnit, receivedQuantity: pl.receivedQuantity,
    baseUnit: pl.baseUnit, baseQuantity: pl.baseQuantity,
    conversionFactor: pl.conversionFactor, conversionNote: pl.conversionNote,
    quantityOrdered: pl.quantityOrdered, previouslyReceived: pl.previouslyReceived,
    receivedAfter: r4(pl.previouslyReceived + pl.receivedQuantity),
    pendingAfter: r4(Math.max(0, pl.quantityOrdered - pl.previouslyReceived - pl.receivedQuantity)),
    stockLedgerRef: { rawItemId: pl.rawItemId, transactionId: pl.__txId || null },
    locationMovementId: pl.__mvId || null,
  }));

  const [goodsReceipt] = await GoodsReceipt.create([{
    companyId, siteId: tenant.siteId || null, receiptNumber,
    sourceType: "CUSTOMER_MATERIAL",
    sourceDocumentId: doc._id,
    sourceDocumentNumber: str(doc.documentRef),
    /* No purchaseOrderId, no poNumber, no supplier, no invoiceNumber. The
       validator refuses each of them for this source type. */
    warehouseId: wh?._id || null, warehouseName: wh?.name || "",
    locationId: loc?._id || null, locationCode: loc?.code || "", locationName: loc?.name || "",
    receiptDate: header.receiptDate ? new Date(header.receiptDate) : new Date(),
    notes: str(header.notes), status: "RECORDED",
    recordedBy: { id: actor.id || null, name: actor.name || "" },
    idempotencyKey: idempotencyKey || "",
    customerMaterial: {
      customerId: doc.customerId,
      customerLabel,
      customerCode: str(doc.customerSnapshot?.customerCode),
      orderRef: str(doc.orderRef),
      executionFileId: doc.executionFileId,
      /* The exact statement this was measured against. A later revision never
         rewrites it. */
      expectationRevisionNo: doc.revisionNo,
      /* The customer's own challan. Not an invoice, and not called one. */
      customerReference: str(header.customerReference),
    },
    lines: grnLines,
  }], session ? { session } : {});

  /* ── THE OWNERSHIP LOTS ─────────────────────────────────────────────────
     One per received line, in the same transaction. The unique index on
     `(companyId, goodsReceiptId, goodsReceiptLineId)` is the last line of
     defence behind the idempotency claim: if a replay ever reached here it
     collides rather than doubling a customer's stock. */
  const lotDocs = goodsReceipt.lines.map((line, i) => {
    const pl = plans[i];
    return {
      companyId, siteId: tenant.siteId || null,
      customerId: doc.customerId,
      customerLabel,
      customerCode: str(doc.customerSnapshot?.customerCode),
      orderRef: str(doc.orderRef),
      /* The PERMANENT SALES line, not the expectation's — those are two
         different identities and the lot needs both: this one to be matched
         against a WorkOrder, `expectationLineRef` below to be matched against
         the document that asked for it. */
      orderLineRef: str(doc.salesOrderLineRef),
      executionFileId: doc.executionFileId,
      expectationId: doc._id,
      documentRef: str(doc.documentRef),
      expectationRevisionNo: doc.revisionNo,
      expectationLineRef: pl.sourceLineRef,
      rawItemId: pl.rawItemId,
      variantId: pl.variantId,
      variantCombination: pl.variantCombination,
      itemName: pl.itemName,
      sku: pl.sku,
      goodsReceiptId: goodsReceipt._id,
      goodsReceiptNumber: receiptNumber,
      goodsReceiptLineId: line._id,
      warehouseId: wh?._id || null, warehouseName: wh?.name || "",
      locationId: loc?._id || null, locationCode: loc?.code || "",
      receiptUnit: pl.poUnit,
      receiptQuantity: pl.receivedQuantity,
      baseUnit: pl.baseUnit,
      baseQuantity: pl.baseQuantity,
      /* All of it is available: nothing has been issued or returned, and this
         phase has no way to do either. */
      availableQuantity: pl.baseQuantity,
      issuedQuantity: 0,
      returnedQuantity: 0,
      receivedAt: goodsReceipt.receiptDate,
      receivedBy: { id: actor.id || null, name: actor.name || "" },
      movements: [{
        type: "RECEIVED",
        quantity: pl.baseQuantity,
        baseUnit: pl.baseUnit,
        availableAfter: pl.baseQuantity,
        at: goodsReceipt.receiptDate,
        by: { id: actor.id || null, name: actor.name || "" },
        reason: `Customer-supplied material received against ${str(doc.documentRef)} revision ${doc.revisionNo}`,
        goodsReceiptId: goodsReceipt._id,
        goodsReceiptNumber: receiptNumber,
        stockTransactionId: pl.__txId || null,
        locationMovementId: pl.__mvId || null,
      }],
    };
  });
  const lots = await CustomerMaterialLot.create(lotDocs, session ? { session, ordered: true } : { ordered: true });

  return { goodsReceipt, lots };
}

/** The destination, resolved and proven to be this company's. */
async function resolveDestination(ctx, { warehouseId, locationId }, session = null) {
  /* ── NO DESTINATION AT GRN TIME (1 Oct 2026) ──────────────────────────────
     The receive screen no longer asks where the goods went — the owner: that
     is Inventory's put-away, not the receipt's. A lot with no warehouse waits
     in the put-away queue; a warehouse, when a caller still names one, is
     checked as before. */
  if (!isId(warehouseId)) {
    if (isId(locationId)) throw fail("VALIDATION", "A location needs its warehouse.", { field: "warehouseId" });
    return { warehouse: null, location: null };
  }
  const q = Warehouse.findOne({ _id: warehouseId, companyId: ctx.companyId });
  const warehouse = await (session ? q.session(session) : q);
  if (!warehouse) {
    /* Another company's warehouse answers exactly as one that does not exist. */
    throw fail("NOT_FOUND", "That warehouse was not found in this company.", { field: "warehouseId" });
  }
  let location = null;
  if (isId(locationId)) {
    location = (warehouse.locations || []).find((l) => String(l._id) === String(locationId)) || null;
    if (!location) {
      throw fail("NOT_FOUND", "That location is not in this warehouse.", { field: "locationId" });
    }
    if (location.status !== "Active") {
      throw fail("VALIDATION", `Location ${location.code} is not active.`, { field: "locationId" });
    }
  }
  return { warehouse, location };
}

module.exports = {
  RECEIPT_STATUS,
  OPERATIONAL,
  heldByLine,
  lotView,
  receivableExpectation,
  receivedByLine,
  lineStanding,
  standingFor,
  validateReceiptLines,
  applyReceipt,
  resolveDestination,
};
