"use strict";
// services/storePurchase/receivingSession.service.js
//
// COUNTING A DELIVERY BY LABELLING IT.
//
// ── THE PROCESS THIS SERVES ─────────────────────────────────────────────────
// A receiver opens a purchase-order line, prints a label, sticks it on a roll,
// and that roll is now counted. They keep going until the pallet is empty, and
// the quantity received is the sum of the labels that went on. The goods
// receipt is recorded at the end and records what the labels already say.
//
// The order matters: labels are printed BEFORE the receipt exists. So the
// identity on a printed sticker has to be allocated by this service, be unique
// forever, and mean nothing until the receipt is recorded.
//
// ── THE FIVE STATES, AND THE ONE THAT IS STOCK ──────────────────────────────
//   RESERVED   allocated; printable; not stock
//   PRINTED    handed to a print job
//   APPLIED    the receiver confirmed it is on the goods; it counts
//   ACTIVATED  the receipt was recorded — and ONLY now is it a stock identity
//   VOIDED     terminal, kept in the record with its reason
//
// Finalising activates the APPLIED ones and voids everything still unsettled.
// Cancelling voids the lot. Nothing else moves a label into ACTIVATED, which is
// why a label printed during a count that was never finalised can never be
// found on a shelf.
//
// ── WHAT IT REFUSES, AND WHY THOSE AND NOT OTHERS ───────────────────────────
// Every refusal here is about one thing: the number on the goods receipt must
// be the number on the stickers. A receipt claiming 12 rolls while 11 stickers
// exist is worse than no receipt, because everything downstream believes it.
// So an unsettled label, an unmeasured package, a duplicate, a missing tracking
// level and an over-receipt all block finalisation — and the frontend's own
// copy of those rules (components/store/goods-receipt-entry/countLabel.mjs) is
// a courtesy to the receiver, never the enforcement.
const mongoose = require("mongoose");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const GoodsReceiptSession = require("../../models/CMS_Models/StorePurchase/GoodsReceiptSession");
const tenantContext = require("./tenantContext.service");
const { fail } = require("./errors");

const {
  SESSION_STATUS, RECEIVING_MODE, RECEIVING_MODES, TRACKING_LEVEL, TRACKING_LEVELS,
} = GoodsReceiptSession;

/** Label states, named here so nothing in this file spells one by hand. */
const IDENTITY = Object.freeze({
  RESERVED: "RESERVED",
  PRINTED: "PRINTED",
  APPLIED: "APPLIED",
  ACTIVATED: "ACTIVATED",
  VOIDED: "VOIDED",
});

/* A label still owing somebody a decision. These are what block a receipt. */
const UNRESOLVED = [IDENTITY.RESERVED, IDENTITY.PRINTED];
/* A label that counts toward what was received. */
const COUNTED = [IDENTITY.APPLIED, IDENTITY.ACTIVATED];

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const validId = (v) => mongoose.isValidObjectId(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
/* Quantities are compared, never tested for identity: 42.5 + 39.8 is not
   exactly 82.3 in binary floating point, and a receipt must not be refused
   over the last bit of a double. */
const QTY_TOL = 0.0001;
const sameQty = (a, b) => Math.abs(r4(a) - r4(b)) <= QTY_TOL;

/** Up to this many identities in one reservation. The label engine's ceiling. */
const MAX_BATCH = 100;

/* ══════════════════════════════════════════════════════════════════════════
 * READING A SESSION
 * ═════════════════════════════════════════════════════════════════════════ */

/** One label as every screen reads it. Shaped field by field, so a field added
 *  to Barcode tomorrow does not appear on a receiving screen by accident. */
function labelView(b) {
  return {
    id: str(b?._id),
    sessionSequence: b?.sessionSequence ?? null,
    identityState: str(b?.identityState) || IDENTITY.ACTIVATED,
    quantity: Number.isFinite(Number(b?.quantity)) ? Number(b.quantity) : null,
    unit: str(b?.unit),
    quantityMeasured: Boolean(b?.quantityMeasured),
    itemName: str(b?.rawItemName),
    sku: str(b?.rawItemSku),
    variantSku: str(b?.variantSku),
    variantCombination: Array.isArray(b?.variantCombination) ? b.variantCombination.map(str) : [],
    printedAt: b?.printedAt || null,
    appliedAt: b?.appliedAt || null,
    activatedAt: b?.activatedAt || null,
    voidedAt: b?.voidedAt || null,
    voidReason: str(b?.voidReason),
    replacedByBarcodeId: b?.replacedByBarcodeId ? str(b.replacedByBarcodeId) : null,
    replacesBarcodeId: b?.replacesBarcodeId ? str(b.replacesBarcodeId) : null,
    /* Printed elsewhere and taken into this count by a scan — see adoptLabel. */
    adopted: Boolean(b?.adoptedAt),
  };
}

function sessionView(session, labels) {
  return {
    id: str(session?._id),
    purchaseOrderId: str(session?.purchaseOrderId),
    poItemId: str(session?.poItemId),
    rawItemId: str(session?.rawItemId),
    variantId: session?.variantId ? str(session.variantId) : null,
    itemName: str(session?.itemName),
    sku: str(session?.sku),
    variantSku: str(session?.variantSku),
    variant: (Array.isArray(session?.variantCombination) ? session.variantCombination : []).map(str).filter(Boolean).join(" · "),
    unit: str(session?.unit),
    status: str(session?.status),
    receivingMode: str(session?.receivingMode),
    trackingLevel: session?.trackingLevel || null,
    suggestedTrackingLevel: session?.suggestedTrackingLevel || null,
    trackingOverrideReason: str(session?.trackingOverrideReason),
    sequenceHigh: session?.sequenceHigh ?? 0,
    openedAt: session?.openedAt || null,
    openedBy: str(session?.openedBy?.name),
    goodsReceiptNumber: str(session?.goodsReceiptNumber),
    labels: (labels || []).map(labelView),
  };
}

/** The totals the server itself works from. The client computes its own copy
 *  for display; this one decides whether a receipt may be recorded. */
function totalsOf(labels = []) {
  let counted = 0;
  let applied = 0;
  let printed = 0;
  let reserved = 0;
  let voided = 0;
  let activated = 0;
  const unmeasured = [];
  for (const l of labels) {
    const state = str(l?.identityState);
    if (state === IDENTITY.VOIDED) { voided += 1; continue; }
    if (state === IDENTITY.PRINTED) { printed += 1; continue; }
    if (state === IDENTITY.RESERVED) { reserved += 1; continue; }
    if (state === IDENTITY.ACTIVATED) activated += 1;
    if (!COUNTED.includes(state)) continue;
    applied += 1;
    const q = Number(l?.quantity);
    /* A package label still carrying its nominal figure was never measured.
       It is not a package holding nothing, so it is reported rather than
       added — and the finalisation refuses on it. */
    if (!Number.isFinite(q) || q <= 0) { unmeasured.push(l); continue; }
    if (l?.quantityMeasured === false && str(l?.identityState) === IDENTITY.APPLIED) {
      /* Only where the tracking level demands a measurement. Individual
         tracking has nothing to measure; that case never reaches here because
         the apply sets `quantityMeasured` true for it. */
      unmeasured.push(l);
      continue;
    }
    counted = r4(counted + q);
  }
  return {
    counted: r4(counted), applied, printed, reserved,
    /* Kept for the screens, which show "still to settle" as one figure. The
       BLOCKING rule above reads `printed` alone, deliberately. */
    unresolved: printed + reserved,
    voided, activated, unmeasured,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * OPENING OR RESUMING
 * ═════════════════════════════════════════════════════════════════════════ */

/** The PO and the line, company-scoped and receivable. */
async function receivableLine(ctx, { poId, lineId }, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(poId)) throw fail("NOT_FOUND", "Purchase order not found.");
  if (!validId(lineId)) throw fail("NOT_FOUND", "That purchase-order line was not found on this order.");

  const po = await PurchaseOrder.findOne({ _id: poId, ...tenantContext.tenantFilter(ctx) })
    .session(session).lean();
  if (!po) throw fail("NOT_FOUND", "Purchase order not found.");
  if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(str(po.status))) {
    throw fail("LIFECYCLE_BLOCKED",
      `This order is ${str(po.status).toLowerCase().replace(/_/g, " ")}, so nothing can be received against it.`,
      { reason: "ORDER_NOT_RECEIVABLE", status: po.status });
  }
  const line = (po.items || []).find((i) => String(i._id) === str(lineId));
  if (!line) throw fail("NOT_FOUND", "That purchase-order line was not found on this order.");
  if (str(line.status) === "CANCELLED") {
    throw fail("LIFECYCLE_BLOCKED", "This line was cancelled, so nothing can be received against it.", { reason: "LINE_CANCELLED" });
  }
  const rawItemId = line.rawItem?._id || line.rawItem;
  if (!rawItemId) {
    /* The material-link repair exists for exactly this, and says so. */
    throw fail("VALIDATION",
      "This line is not linked to a material, so a label printed for it would name nothing. Link the material first.",
      { reason: "MATERIAL_NOT_LINKED" });
  }
  const ordered = Number(line.quantity) || 0;
  const received = Number(line.receivedQuantity) || 0;
  return { po, line, rawItemId, outstanding: r4(Math.max(0, ordered - received)) };
}

/**
 * Open the count for a line, or hand back the one already open.
 *
 * ── WHY THIS IS ONE OPERATION AND NOT TWO ──────────────────────────────────
 * A receiver pressing "Count & label" does not know or care whether a count is
 * already open — they came back from lunch, or a colleague started it. Asking
 * the client to choose between create and resume makes the race the client's
 * problem: both terminals would look, both would find nothing, and both would
 * create. So it is one call, and the unique partial index on (company, line)
 * decides it. A duplicate-key error means somebody else won, and the winner's
 * session is what comes back.
 */
async function openOrResume(ctx, {
  poId, lineId, receivingMode = RECEIVING_MODE.COUNT_AND_LABEL,
  trackingLevel = null, trackingOverrideReason = "",
} = {}, actor = {}) {
  const { po, line, rawItemId, outstanding } = await receivableLine(ctx, { poId, lineId });

  if (!RECEIVING_MODES.includes(str(receivingMode))) {
    throw fail("VALIDATION", "Choose how this line is being received.", { field: "receivingMode" });
  }

  const existing = await GoodsReceiptSession.findOne({
    companyId: ctx.companyId, poItemId: line._id, status: SESSION_STATUS.OPEN,
  });
  if (existing) {
    const labels = await labelsOf(existing._id);
    return { session: sessionView(existing, labels), outstanding, resumed: true };
  }

  /* What the Materials master says this material is tracked as. Recorded as
     the suggestion so an override is visible as an override. */
  /* The tenant FILTER, not a strict companyId: a catalogue row created before
     Store had companies carries none, and those are exactly the legacy lines
     this screen still has to receive. The filter is the one place that decides
     whether an unowned record is reachable. */
  const material = await RawItem.findOne({ _id: rawItemId, ...tenantContext.tenantFilter(ctx) })
    .select("name sku unit customUnit variants defaultTrackingLevel").lean();
  if (!material) throw fail("NOT_FOUND", "That material was not found in this company's catalogue.");
  const suggested = TRACKING_LEVELS.includes(str(material.defaultTrackingLevel))
    ? str(material.defaultTrackingLevel) : null;

  const chosen = trackingLevel === null || trackingLevel === undefined || str(trackingLevel) === ""
    ? null : str(trackingLevel);
  if (chosen !== null && !TRACKING_LEVELS.includes(chosen)) {
    throw fail("VALIDATION", "That is not a tracking level this system records.", { field: "trackingLevel", allowed: TRACKING_LEVELS });
  }
  /* An override of the master's own setting is a decision somebody has to own. */
  if (chosen && suggested && chosen !== suggested && !str(trackingOverrideReason)) {
    throw fail("VALIDATION",
      "The Materials master tracks this material differently. Say why this delivery is tracked another way.",
      { field: "trackingOverrideReason", reason: "TRACKING_OVERRIDE_REASON_REQUIRED", suggested });
  }

  const variant = (material.variants || []).find((v) => String(v._id) === str(line.variantId)) || null;
  const doc = {
    ...tenantContext.stamp(ctx),
    purchaseOrderId: po._id,
    poNumber: str(po.poNumber),
    poItemId: line._id,
    rawItemId,
    variantId: line.variantId || null,
    itemName: str(line.itemName) || str(material.name),
    sku: str(line.sku) || str(material.sku),
    variantSku: str(variant?.sku),
    variantCombination: Array.isArray(line.variantCombination) && line.variantCombination.length
      ? line.variantCombination.map(str)
      : (variant?.combination || []).map(str),
    unit: str(line.unit),
    receivingMode: str(receivingMode),
    trackingLevel: chosen,
    suggestedTrackingLevel: suggested,
    trackingOverrideReason: chosen && suggested && chosen !== suggested ? str(trackingOverrideReason) : "",
    sequenceHigh: 0,
    status: SESSION_STATUS.OPEN,
    openedBy: { id: actor.id || null, name: str(actor.name) },
    openedAt: new Date(),
  };

  try {
    const created = await GoodsReceiptSession.create(doc);
    return { session: sessionView(created, []), outstanding, resumed: false };
  } catch (err) {
    /* Two terminals opened the same line in the same instant. The index
       refused the loser; the winner's count is the one that exists, and
       resuming it is what the loser wanted anyway. */
    if (err?.code === 11000) {
      const winner = await GoodsReceiptSession.findOne({
        companyId: ctx.companyId, poItemId: line._id, status: SESSION_STATUS.OPEN,
      });
      if (winner) {
        const labels = await labelsOf(winner._id);
        return { session: sessionView(winner, labels), outstanding, resumed: true };
      }
    }
    throw err;
  }
}

const labelsOf = (sessionId, dbSession = null) =>
  Barcode.find({ receivingSessionId: sessionId })
    .sort({ sessionSequence: 1 }).session(dbSession).lean();

/** An open session of this company's, with its labels. */
async function openSession(ctx, sessionId, dbSession = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(sessionId)) throw fail("NOT_FOUND", "That count was not found.");
  const session = await GoodsReceiptSession.findOne({ _id: sessionId, companyId: ctx.companyId }).session(dbSession);
  if (!session) throw fail("NOT_FOUND", "That count was not found.");
  if (str(session.status) !== SESSION_STATUS.OPEN) {
    throw fail("LIFECYCLE_BLOCKED",
      str(session.status) === SESSION_STATUS.FINALIZED
        ? "This count was finalised — its receipt has been recorded. Start a new count to receive more."
        : "This count was cancelled. Start a new one to receive this line.",
      { reason: "SESSION_NOT_OPEN", status: session.status });
  }
  return session;
}

/** Every session on an order, for the receiving screen. */
async function readForOrder(ctx, { poId } = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(poId)) throw fail("NOT_FOUND", "Purchase order not found.");
  /* Asked of the ORDER, not of the sessions. Scoping the session query alone
     would answer another company's order with an empty list, which discloses
     that the order exists and has no counts open. Foreign and missing get one
     answer. */
  const po = await PurchaseOrder.findOne({ _id: poId, ...tenantContext.tenantFilter(ctx) })
    .select("items.quantity items.receivedQuantity").lean();
  if (!po) throw fail("NOT_FOUND", "Purchase order not found.");
  const sessions = await GoodsReceiptSession.find({
    companyId: ctx.companyId, purchaseOrderId: poId, status: SESSION_STATUS.OPEN,
  }).lean();
  const ids = sessions.map((s) => s._id);
  const labels = ids.length
    ? await Barcode.find({ receivingSessionId: { $in: ids } }).sort({ sessionSequence: 1 }).lean()
    : [];
  const bySession = new Map(ids.map((id) => [String(id), []]));
  for (const b of labels) bySession.get(String(b.receivingSessionId))?.push(b);

  /* ── THE LINE'S OWN OUTSTANDING TRAVELS WITH THE COUNT ─────────────────
     Every bound in this feature — how many identities may be reserved, whether
     a confirmation would over-receive, whether finalisation is refused — is
     measured against it, so the count carries it rather than leaving the
     workspace to re-derive it from a PO line it may not be holding. It is the
     PO line's figure, read here from the order itself, so the two cannot
     disagree. */
  const outstandingOf = (poItemId) => {
    const line = (po.items || []).find((i) => String(i._id) === String(poItemId));
    if (!line) return null;
    return r4(Math.max(0, (Number(line.quantity) || 0) - (Number(line.receivedQuantity) || 0)));
  };
  return {
    sessions: sessions.map((s) => ({
      ...sessionView(s, bySession.get(String(s._id)) || []),
      outstanding: outstandingOf(s.poItemId),
    })),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE TRACKING LEVEL
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Set or change what a label on this delivery stands for.
 *
 * Locked once a label has been applied: the stickers already on the goods were
 * printed under the old rule, and re-reading them under a new one would change
 * what they claim without anybody touching the goods.
 */
async function setTrackingLevel(ctx, { sessionId, trackingLevel, reason = "" } = {}) {
  const session = await openSession(ctx, sessionId);
  const next = str(trackingLevel);
  if (!TRACKING_LEVELS.includes(next)) {
    throw fail("VALIDATION", "That is not a tracking level this system records.", { field: "trackingLevel", allowed: TRACKING_LEVELS });
  }
  const labels = await labelsOf(session._id);
  const t = totalsOf(labels);
  if (t.applied > 0 || t.unresolved > 0) {
    throw fail("LIFECYCLE_BLOCKED",
      "Labels have already been reserved on this count, so what they stand for cannot change. Void them to start again.",
      { reason: "TRACKING_LOCKED" });
  }
  const suggested = str(session.suggestedTrackingLevel);
  if (suggested && next !== suggested && !str(reason)) {
    throw fail("VALIDATION",
      "The Materials master tracks this material differently. Say why this delivery is tracked another way.",
      { field: "reason", reason: "TRACKING_OVERRIDE_REASON_REQUIRED", suggested });
  }
  session.trackingLevel = next;
  session.trackingOverrideReason = suggested && next !== suggested ? str(reason) : "";
  await session.save();
  return { session: sessionView(session, labels) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * RESERVING IDENTITIES
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Reserve a batch of label identities for this count.
 *
 * ── THE SEQUENCE IS ALLOCATED BEFORE ANYTHING IS WRITTEN ───────────────────
 * One atomic `$inc` on the session takes the whole block of numbers. Two
 * terminals reserving at the same instant get two disjoint blocks, because the
 * database — not the reader's snapshot of `sequenceHigh` — decides. The unique
 * partial index on (company, session, sequence) is the backstop: even a caller
 * that allocated some other way cannot insert two labels under one number.
 *
 * The count is bounded by what the line still owes. An identity reserved beyond
 * the outstanding quantity names a unit nobody ordered, and over-receipt has no
 * approval workflow in this system to authorise one.
 */
async function reserveBatch(ctx, { sessionId, count = 1, quantityPerLabel = null } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);

  if (str(session.receivingMode) !== RECEIVING_MODE.COUNT_AND_LABEL) {
    throw fail("VALIDATION",
      "This line is being received as a total with no labels. Switch it to Count & label to print any.",
      { reason: "MODE_IS_TOTAL_ONLY" });
  }
  const level = str(session.trackingLevel);
  if (!TRACKING_LEVELS.includes(level)) {
    throw fail("VALIDATION",
      "Say what a label on this delivery stands for before printing one.",
      { field: "trackingLevel", reason: "TRACKING_LEVEL_REQUIRED" });
  }

  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw fail("VALIDATION", "Print at least one label, as a whole number.", { field: "count" });
  if (n > MAX_BATCH) throw fail("VALIDATION", `Up to ${MAX_BATCH} labels can be reserved in one batch.`, { field: "count" });

  /* What one label stands for. One piece is one piece and is never editable;
     everything else is a nominal figure, re-measured when the label goes on. */
  let per;
  if (level === TRACKING_LEVEL.INDIVIDUAL) {
    per = 1;
  } else {
    per = Number(quantityPerLabel);
    if (!Number.isFinite(per) || per <= 0) {
      throw fail("VALIDATION", `Enter what one label holds, in ${str(session.unit) || "the line's unit"}.`, { field: "quantityPerLabel" });
    }
    per = r4(per);
  }

  const { outstanding } = await receivableLine(ctx, { poId: session.purchaseOrderId, lineId: session.poItemId });
  const labels = await labelsOf(session._id);
  const t = totalsOf(labels);

  if (level === TRACKING_LEVEL.LOT) {
    const held = t.applied + t.unresolved;
    if (held + n > 1) {
      throw fail("VALIDATION",
        held >= 1
          ? "A lot is one label, and this count already has it. Void it to start again, or track this delivery by package instead."
          : "A lot is one label. Reserve one, carrying the whole counted quantity.",
        { reason: "LOT_IS_ONE_LABEL" });
    }
  }

  /* The headroom, in the line's own terms. Unresolved labels consume it: they
     were reserved in order to be applied, and treating them as free would let
     one receiver reserve the line twice over. */
  const wouldHold = r4(per * n);
  const heldQty = r4(labels
    .filter((l) => UNRESOLVED.includes(str(l.identityState)))
    .reduce((s, l) => s + (Number(l.quantity) || 0), 0));
  const free = r4(Math.max(0, outstanding - t.counted - heldQty));
  if (wouldHold - free > QTY_TOL) {
    throw fail("VALIDATION",
      `${n} × ${per} ${str(session.unit)} is ${wouldHold} ${str(session.unit)}, more than the ${free} ${str(session.unit)} still outstanding on this line. `
      + "Receiving more than the outstanding quantity needs an over-receipt approval, and there is no approval workflow in the current system.",
      { reason: "BATCH_OVER_OUTSTANDING", outstanding: free, requested: wouldHold });
    }

  /* ── THE BLOCK OF NUMBERS, TAKEN ATOMICALLY ───────────────────────────── */
  const advanced = await GoodsReceiptSession.findOneAndUpdate(
    { _id: session._id, companyId: ctx.companyId, status: SESSION_STATUS.OPEN },
    { $inc: { sequenceHigh: n } },
    { new: true },
  );
  if (!advanced) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  const from = advanced.sequenceHigh - n + 1;

  const po = await PurchaseOrder.findOne({ _id: session.purchaseOrderId, companyId: ctx.companyId })
    .select("poNumber vendor vendorName items").lean();
  const poLine = (po?.items || []).find((i) => String(i._id) === String(session.poItemId)) || null;

  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      companyId: ctx.companyId,
      rawItem: session.rawItemId,
      rawItemName: str(session.itemName),
      rawItemSku: str(session.sku),
      variantId: session.variantId || null,
      variantCombination: session.variantCombination || [],
      variantSku: str(session.variantSku),
      quantity: per,
      unit: str(session.unit),
      purchaseOrder: session.purchaseOrderId,
      purchaseOrderNumber: str(po?.poNumber),
      purchaseOrderItemId: session.poItemId,
      vendor: po?.vendor || null,
      vendorName: str(po?.vendorName),
      unitPrice: Number.isFinite(Number(poLine?.unitPrice)) ? Number(poLine.unitPrice) : null,
      generatedBy: actor.id || null,
      /* Reserved, not stock. The receipt is what activates it. */
      identityState: IDENTITY.RESERVED,
      receivingSessionId: session._id,
      sessionSequence: from + i,
      /* Individual tracking has nothing to measure; a package's figure is
         nominal until the receiver measures it at apply. */
      quantityMeasured: level === TRACKING_LEVEL.INDIVIDUAL,
    });
  }

  let created;
  try {
    created = await Barcode.insertMany(rows, { ordered: true });
  } catch (err) {
    if (err?.code === 11000) {
      /* The index caught a sequence collision. The `$inc` above makes this
         unreachable in practice; it is handled rather than crashing because a
         receiver deserves an answer they can act on. */
      throw fail("CONFLICT",
        "Another terminal is counting this line at the same moment. Refresh the count and print again — no labels were created.",
        { reason: "SEQUENCE_COLLISION" });
    }
    throw err;
  }

  return {
    labels: created.map((b) => labelView(b.toObject ? b.toObject() : b)),
    sequenceFrom: from,
    sequenceTo: advanced.sequenceHigh,
    quantityPerLabel: per,
    total: wouldHold,
  };
}

/**
 * Record that these identities were handed to a print job.
 *
 * ── WHAT "PRINTED" DOES AND DOES NOT CLAIM ─────────────────────────────────
 * There is no printer integration in this system: a label is printed by handing
 * a page to the browser's print dialog, which chooses the device and never
 * reports back. So PRINTED means the job was handed over and the code is on
 * paper somewhere — not that a sticker exists. Only a confirmation, best of all
 * a scan of the printed code, settles that.
 */
async function markPrinted(ctx, { sessionId, barcodeIds = [] } = {}) {
  const session = await openSession(ctx, sessionId);
  const ids = (Array.isArray(barcodeIds) ? barcodeIds : []).filter(validId);
  if (!ids.length) throw fail("VALIDATION", "Name the labels that were printed.", { field: "barcodeIds" });
  await Barcode.updateMany(
    { _id: { $in: ids }, companyId: ctx.companyId, receivingSessionId: session._id, identityState: IDENTITY.RESERVED },
    { $set: { identityState: IDENTITY.PRINTED, printedAt: new Date() } },
  );
  const labels = await labelsOf(session._id);
  return { session: sessionView(session, labels) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * APPLYING, UNDOING AND VOIDING
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Confirm that a label is on the goods — the act that increments the count.
 *
 * For a package the receiver measures what is actually in it, which is the
 * whole reason a roll carries a label rather than a tally mark: 42.5 m and
 * 39.8 m are two different rolls and the receipt is the sum of the two.
 *
 * The update is CONDITIONAL on the label still being unresolved, so two
 * confirmations of one label — a double scan, a slow network and a retry —
 * increment the count once. The second is told it was already counted.
 */
async function applyLabel(ctx, { sessionId, barcodeId, quantity = null } = {}) {
  const session = await openSession(ctx, sessionId);
  if (!validId(barcodeId)) throw fail("NOT_FOUND", "That label was not found in this count.");

  const label = await Barcode.findOne({ _id: barcodeId, companyId: ctx.companyId }).lean();
  if (!label) throw fail("NOT_FOUND", "That label was not found.", { reason: "LABEL_NOT_FOUND" });
  if (String(label.receivingSessionId || "") !== String(session._id)) {
    /* A sticker from another delivery is in this pile. Quietly counting it
       would put one delivery's identity on another's goods. */
    throw fail("CONFLICT",
      `That label belongs to another count${str(label.rawItemName) ? ` — it was printed for ${label.rawItemName}` : ""}${str(label.purchaseOrderNumber) ? ` on ${label.purchaseOrderNumber}` : ""}. Do not count it here.`,
      {
        reason: "LABEL_FROM_ANOTHER_SESSION",
        itemName: str(label.rawItemName), poNumber: str(label.purchaseOrderNumber),
      });
  }
  const state = str(label.identityState);
  if (state === IDENTITY.VOIDED) {
    throw fail("CONFLICT",
      `Label ${label.sessionSequence} was voided${str(label.voidReason) ? `: ${label.voidReason}` : ""}. Take it off the goods and apply a new one.`,
      { reason: "LABEL_VOIDED", sessionSequence: label.sessionSequence });
  }
  if (COUNTED.includes(state)) {
    throw fail("CONFLICT",
      `Label ${label.sessionSequence} is already counted. Two things cannot carry one label — if a second package has this code on it, void one and print a replacement.`,
      { reason: "LABEL_ALREADY_COUNTED", sessionSequence: label.sessionSequence });
  }

  const level = str(session.trackingLevel);
  let measured;
  let quantityMeasured;
  if (level === TRACKING_LEVEL.INDIVIDUAL) {
    /* One label, one piece. A per-piece label claiming two pieces is not a
       per-piece label, so nothing here is editable. */
    measured = 1;
    quantityMeasured = true;
  } else if (quantity === null || quantity === undefined || str(quantity) === "") {
    throw fail("VALIDATION",
      `Enter the quantity in this ${level === TRACKING_LEVEL.LOT ? "lot" : "package"}, in ${str(session.unit)}, before confirming it.`,
      { field: "quantity", reason: "MEASURED_QUANTITY_REQUIRED" });
  } else {
    measured = Number(quantity);
    if (!Number.isFinite(measured) || measured <= 0) {
      throw fail("VALIDATION", "A quantity must be a number greater than zero.", { field: "quantity" });
    }
    measured = r4(measured);
    quantityMeasured = true;
  }

  /* ── A MEASUREMENT IS A PHYSICAL FACT AND IS RECORDED AS ONE ────────────
     This used to refuse a measurement that took the line past its outstanding
     quantity. That was backwards, and actively harmful: a receiver who
     measures a roll at 42.5 m, is refused, and is told the line only has 40 m
     left does not put the roll back on the lorry — they type 40. Refusing the
     measurement teaches people to enter a number that fits rather than the
     number they read off the tape, and a count of invented figures is worse
     than a count that is honestly too big.

     So the roll is recorded at what it actually holds, and the surplus is a
     FINALISATION blocker (see `finalizeBlockers`), where it belongs: the goods
     are here, the order does not cover them, and somebody has to amend the
     order or send them back. Reserving identities is still bounded — that is
     an allocation, not an observation, and reserving a hundred labels for a
     ten-unit line is the uncontrolled printing the bound exists to stop. */

  const updated = await Barcode.findOneAndUpdate(
    { _id: barcodeId, companyId: ctx.companyId, receivingSessionId: session._id, identityState: { $in: UNRESOLVED } },
    { $set: { identityState: IDENTITY.APPLIED, quantity: measured, quantityMeasured, appliedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) {
    /* Somebody else settled it between the read and the write. */
    throw fail("CONFLICT", "That label was settled a moment ago. Refresh the count.", { reason: "LABEL_RACE" });
  }

  const labels = await labelsOf(session._id);
  return { label: labelView(updated), session: sessionView(session, labels), totals: totalsOf(labels) };
}

/**
 * Take the last confirmed label back to printed.
 *
 * The sticker is still on the goods; this only says it was not counted. The
 * copy on the screen says so, because an undo that silently left a counted
 * sticker on a roll would be worse than no undo.
 */
async function undoLast(ctx, { sessionId } = {}) {
  const session = await openSession(ctx, sessionId);
  const last = await Barcode.findOne({
    companyId: ctx.companyId, receivingSessionId: session._id, identityState: IDENTITY.APPLIED,
  }).sort({ appliedAt: -1, sessionSequence: -1 });
  if (!last) throw fail("VALIDATION", "No label has been confirmed on this count yet.", { reason: "NOTHING_TO_UNDO" });

  /* An ADOPTED label was a live sticker before this count: undoing it
     releases it — back to the label it was, detached — rather than turning
     it into a "printed" identity of this count, which it never was. */
  const undone = await Barcode.findOneAndUpdate(
    { _id: last._id, companyId: ctx.companyId, identityState: IDENTITY.APPLIED },
    last.adoptedAt
      ? { $set: { identityState: IDENTITY.ACTIVATED, appliedAt: null, adoptedAt: null, receivingSessionId: null, sessionSequence: null } }
      : { $set: { identityState: IDENTITY.PRINTED, appliedAt: null } },
    { new: true },
  ).lean();
  if (!undone) throw fail("CONFLICT", "That label was settled a moment ago. Refresh the count.", { reason: "LABEL_RACE" });

  const labels = await labelsOf(session._id);
  return { label: labelView(undone), released: Boolean(last.adoptedAt), session: sessionView(session, labels), totals: totalsOf(labels) };
}

/**
 * Void a label: it is never used again, and it stays in the record.
 *
 * ── WHY A VOID IS NOT A DELETE ─────────────────────────────────────────────
 * The sequence printed on the stickers has a gap in it. If the voided identity
 * were removed, nobody could ever say whether label 7 was damaged or whether
 * somebody pocketed a roll. The reason is required for the same purpose.
 *
 * `replace` reserves the NEXT identity for the package the voided one was meant
 * for, and links the two — which is what makes a reprint-after-damage traceable
 * as a replacement rather than as a second sticker for one roll.
 */
async function voidLabel(ctx, { sessionId, barcodeId, reason = "", replace = false } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);
  if (!validId(barcodeId)) throw fail("NOT_FOUND", "That label was not found in this count.");
  if (!str(reason)) {
    throw fail("VALIDATION", "Say why this label is being voided. A gap in the printed sequence needs an explanation.", { field: "reason" });
  }

  const label = await Barcode.findOne({ _id: barcodeId, companyId: ctx.companyId, receivingSessionId: session._id }).lean();
  if (!label) throw fail("NOT_FOUND", "That label was not found in this count.");
  if (str(label.identityState) === IDENTITY.VOIDED) {
    throw fail("CONFLICT", "That label is already voided.", { reason: "ALREADY_VOIDED" });
  }
  if (str(label.identityState) === IDENTITY.ACTIVATED) {
    throw fail("LIFECYCLE_BLOCKED",
      "This label is live stock: its goods receipt has been recorded. Correcting live stock is a stock adjustment, not a void.",
      { reason: "LABEL_IS_LIVE" });
  }

  const voided = await Barcode.findOneAndUpdate(
    { _id: barcodeId, companyId: ctx.companyId, identityState: { $ne: IDENTITY.VOIDED } },
    { $set: { identityState: IDENTITY.VOIDED, voidedAt: new Date(), voidedBy: actor.id || null, voidReason: str(reason) } },
    { new: true },
  ).lean();
  if (!voided) throw fail("CONFLICT", "That label was settled a moment ago. Refresh the count.", { reason: "LABEL_RACE" });

  let replacement = null;
  if (replace) {
    const level = str(session.trackingLevel);
    const per = level === TRACKING_LEVEL.INDIVIDUAL ? 1 : Number(label.quantity) || null;
    const out = await reserveBatch(ctx, { sessionId, count: 1, quantityPerLabel: per }, actor);
    replacement = out.labels[0] || null;
    if (replacement) {
      await Barcode.updateOne({ _id: replacement.id }, { $set: { replacesBarcodeId: voided._id } });
      await Barcode.updateOne({ _id: voided._id }, { $set: { replacedByBarcodeId: replacement.id } });
      replacement.replacesBarcodeId = str(voided._id);
    }
  }

  const labels = await labelsOf(session._id);
  return { label: labelView(voided), replacement, session: sessionView(session, labels), totals: totalsOf(labels) };
}

/**
 * What a scanned code means in this count.
 *
 * The scanner is the reliable confirmation — the sticker is in the receiver's
 * hand and the code being read is the code that was printed. Anything that is
 * not this count's label is a BLOCKING answer, never a near miss.
 */
async function resolveScan(ctx, { sessionId, barcodeId } = {}) {
  const session = await openSession(ctx, sessionId);
  if (!validId(barcodeId)) {
    return { outcome: "NOT_A_LABEL", label: null, message: "That is not a material label printed by GRAV." };
  }
  const label = await Barcode.findOne({ _id: barcodeId, companyId: ctx.companyId }).lean();
  if (!label) return { outcome: "UNKNOWN", label: null, message: "That label is not in this company's register." };
  if (String(label.receivingSessionId || "") !== String(session._id)) {
    return {
      outcome: "OTHER_SESSION", label: null,
      itemName: str(label.rawItemName), poNumber: str(label.purchaseOrderNumber),
      message: `That label belongs to another delivery${str(label.rawItemName) ? ` — ${label.rawItemName}` : ""}. Do not count it here.`,
    };
  }
  const state = str(label.identityState);
  if (state === IDENTITY.VOIDED) return { outcome: "VOIDED", label: labelView(label), message: `Label ${label.sessionSequence} was voided.` };
  if (COUNTED.includes(state)) return { outcome: "ALREADY", label: labelView(label), message: `Label ${label.sessionSequence} is already counted.` };
  return { outcome: "APPLY", label: labelView(label), message: "" };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ENDING THE COUNT
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Abandon the count. Every identity it reserved is voided, applied ones
 * included: nothing was received, so nothing may stay live, and a sticker
 * already on the goods has to come off.
 */
async function cancel(ctx, { sessionId, reason = "" } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);
  const now = new Date();
  /* Labels printed elsewhere and adopted by a scan existed before this
     count; they go back to being the live labels they were, detached. Only
     the identities this count itself reserved are voided. */
  await Barcode.updateMany(
    { companyId: ctx.companyId, receivingSessionId: session._id, adoptedAt: { $ne: null }, identityState: { $ne: IDENTITY.VOIDED } },
    { $set: { identityState: IDENTITY.ACTIVATED, appliedAt: null, adoptedAt: null, receivingSessionId: null, sessionSequence: null } },
  );
  await Barcode.updateMany(
    { companyId: ctx.companyId, receivingSessionId: session._id, identityState: { $ne: IDENTITY.VOIDED } },
    {
      $set: {
        identityState: IDENTITY.VOIDED, voidedAt: now, voidedBy: actor.id || null,
        voidReason: str(reason) || "The receiving count was cancelled before any receipt was recorded.",
      },
    },
  );
  session.status = SESSION_STATUS.CANCELLED;
  session.cancelledAt = now;
  session.cancelReason = str(reason);
  await session.save();
  const labels = await labelsOf(session._id);
  return { session: sessionView(session, labels) };
}

/**
 * Everything standing between a count and a recorded receipt, as a list.
 *
 * A list rather than the first problem: a receiver at the end of a delivery
 * needs to know everything left to do, not to discover it one refusal at a
 * time. This is the SERVER's copy of the rule — the browser's identical list
 * is a courtesy, and this one is the enforcement.
 */
function finalizeBlockers({ session, labels, receivedQuantity, outstanding }) {
  const out = [];
  const t = totalsOf(labels);
  const unit = str(session.unit);

  if (!TRACKING_LEVELS.includes(str(session.trackingLevel))) {
    out.push({ code: "NO_TRACKING_LEVEL", message: "This count has no tracking level, so what its labels stand for is not recorded." });
  }
  if (t.applied === 0) {
    out.push({ code: "NOTHING_COUNTED", message: "No label has been applied, so nothing has been counted on this line." });
  }
  /* ── PRINTED BLOCKS; RESERVED DOES NOT ────────────────────────────────
     The two are different physical facts. A PRINTED identity may be on a roll
     right now — nobody but the receiver can say — so it has to be confirmed or
     voided by hand. A RESERVED one was never sent to a printer, so there is no
     paper anywhere and no question to answer: it is an allocation for a package
     that did not arrive, and the activation below voids it. Blocking on it
     would make a receiver settle labels that do not exist. */
  if (t.printed > 0) {
    out.push({
      code: "UNRESOLVED_LABELS",
      message: `${t.printed} label${t.printed === 1 ? " was" : "s were"} printed and not settled. Confirm each one on the goods, or void it — a printed code may already be on a package.`,
    });
  }
  if (t.unmeasured.length > 0) {
    out.push({
      code: "NO_QUANTITY",
      message: `${t.unmeasured.length} applied label${t.unmeasured.length === 1 ? " has" : "s have"} no measured quantity. A package nobody measured is not a package holding nothing.`,
    });
  }
  /* The whole point of the exercise: the receipt's number is the stickers'
     number, or the receipt is not recorded. */
  if (receivedQuantity !== null && receivedQuantity !== undefined && !sameQty(receivedQuantity, t.counted)) {
    out.push({
      code: "QUANTITY_MISMATCH",
      message: `The labels applied hold ${t.counted} ${unit}, but this receipt is being recorded for ${r4(receivedQuantity)} ${unit}. A receipt whose quantity is not the quantity on the goods cannot be recorded.`,
    });
  }
  if (outstanding !== null && outstanding !== undefined && t.counted - outstanding > QTY_TOL) {
    out.push({
      code: "OVER_RECEIPT",
      message: `The labels applied hold ${r4(t.counted - outstanding)} ${unit} more than is outstanding on this line, and over-receipt needs an approval this system has no workflow for.`,
    });
  }
  const seen = new Set();
  for (const l of labels) {
    const key = String(l._id);
    if (seen.has(key)) { out.push({ code: "DUPLICATE", message: "One label identity appears twice in this count." }); break; }
    seen.add(key);
  }
  return out;
}

/**
 * The open counts a receipt is about to close, checked before anything is
 * written — called by the receipt engine inside its own transaction.
 *
 * @param plans  the validated receipt plans, each carrying `poItemId` and
 *               `receivedQuantity` in the PO unit
 */
async function assertCountsAgree(ctx, { plans = [] } = {}, dbSession = null) {
  if (!ctx?.companyId || !plans.length) return [];
  const poItemIds = plans.map((p) => p.poItemId).filter(Boolean);
  const sessions = await GoodsReceiptSession.find({
    companyId: ctx.companyId, poItemId: { $in: poItemIds }, status: SESSION_STATUS.OPEN,
  }).session(dbSession).lean();
  if (!sessions.length) return [];

  const labelsBySession = new Map();
  const all = await Barcode.find({ receivingSessionId: { $in: sessions.map((s) => s._id) } })
    .session(dbSession).lean();
  for (const b of all) {
    const k = String(b.receivingSessionId);
    if (!labelsBySession.has(k)) labelsBySession.set(k, []);
    labelsBySession.get(k).push(b);
  }

  const matched = [];
  for (const session of sessions) {
    const plan = plans.find((p) => String(p.poItemId) === String(session.poItemId));
    if (!plan) continue;
    /* A line received as a bulk total has no labels to agree with. */
    if (str(session.receivingMode) === RECEIVING_MODE.TOTAL_ONLY) {
      matched.push({ session, labels: [], totalOnly: true });
      continue;
    }
    const labels = labelsBySession.get(String(session._id)) || [];
    const blockers = finalizeBlockers({
      session, labels,
      receivedQuantity: plan.receivedQuantity,
      outstanding: plan.quantityOrdered !== undefined && plan.previouslyReceived !== undefined
        ? r4(Math.max(0, Number(plan.quantityOrdered) - Number(plan.previouslyReceived)))
        : null,
    });
    if (blockers.length) {
      throw fail("VALIDATION",
        `${str(session.itemName) || "This line"} was counted by labelling, and the count is not settled. ${blockers[0].message}`,
        { reason: "COUNT_NOT_SETTLED", poItemId: String(session.poItemId), blockers });
    }
    matched.push({ session, labels, totalOnly: false });
  }
  return matched;
}

/**
 * Activate the labels a recorded receipt has just made real.
 *
 * Called INSIDE the receipt's own transaction, so a receipt that rolls back
 * takes the activation with it and the count stays open — rather than leaving
 * live stock identities for a delivery no document claims.
 *
 * Applied labels become ACTIVATED and are stamped with the receipt they came
 * from. Everything still unsettled is voided: a reserved identity for a package
 * that never arrived must not be printable tomorrow.
 */
async function activateForReceipt(ctx, { matched = [], goodsReceipt, actor = {} } = {}, dbSession = null) {
  if (!matched.length || !goodsReceipt) return { activated: 0, voided: 0 };
  const now = new Date();
  let activated = 0;
  let voided = 0;

  for (const { session, totalOnly } of matched) {
    const grnLine = (goodsReceipt.lines || []).find((l) => String(l.poItemId) === String(session.poItemId)) || null;

    if (!totalOnly) {
      const act = await Barcode.updateMany(
        { companyId: ctx.companyId, receivingSessionId: session._id, identityState: IDENTITY.APPLIED },
        {
          $set: {
            identityState: IDENTITY.ACTIVATED, activatedAt: now,
            goodsReceiptId: goodsReceipt._id,
            goodsReceiptNumber: str(goodsReceipt.receiptNumber),
            goodsReceiptLineId: grnLine?._id || null,
          },
        },
        dbSession ? { session: dbSession } : {},
      );
      activated += act.modifiedCount || 0;

      /* Reserved but unused. They were allocated for packages that did not
         arrive, and an identity nobody accounts for is one somebody finds on a
         shelf. */
      const vd = await Barcode.updateMany(
        { companyId: ctx.companyId, receivingSessionId: session._id, identityState: { $in: UNRESOLVED } },
        {
          $set: {
            identityState: IDENTITY.VOIDED, voidedAt: now, voidedBy: actor.id || null,
            voidReason: "Reserved during counting and never applied. Voided when the receipt was recorded.",
          },
        },
        dbSession ? { session: dbSession } : {},
      );
      voided += vd.modifiedCount || 0;
    }

    await GoodsReceiptSession.updateOne(
      { _id: session._id, companyId: ctx.companyId },
      {
        $set: {
          status: SESSION_STATUS.FINALIZED,
          finalizedAt: now,
          goodsReceiptId: goodsReceipt._id,
          goodsReceiptNumber: str(goodsReceipt.receiptNumber),
          goodsReceiptLineId: grnLine?._id || null,
        },
      },
      dbSession ? { session: dbSession } : {},
    );
  }
  return { activated, voided };
}


/* ══════════════════════════════════════════════════════════════════════════
 * ADOPTING A LABEL PRINTED ELSEWHERE  (30 Sep 2026)
 * ═════════════════════════════════════════════════════════════════════════
 * The Material labels screen prints raw-item stickers with no receipt behind
 * them. When such a sticker is already on the goods of a delivery, the
 * receiver scans it on the receiving screen and it is taken INTO the line's
 * count: attached as an APPLIED label carrying the quantity printed on it,
 * with this order, line and supplier written onto it. From there it is an
 * ordinary counted label — its quantity is part of the line's received figure,
 * and recording the receipt activates it and stamps the GRN on it.
 *
 * What is matched is the label's MATERIAL AND VARIANT against the order's
 * lines, never a name typed by anybody. A label that names another material,
 * a voided one, one already counted in a count, and one already received on a
 * goods receipt are each refused with the reason.
 */
async function adoptLabel(ctx, { poId, barcodeId, lineId = null } = {}, actor = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(poId)) throw fail("NOT_FOUND", "Purchase order not found.");
  if (!validId(barcodeId)) throw fail("VALIDATION", "That is not a material label printed by GRAV.", { reason: "NOT_A_LABEL" });

  /* The tenant FILTER, not a strict companyId: a label printed before Store
     had companies carries none, and those are exactly the stickers this is
     for. Adoption stamps the company on it (below). */
  const label = await Barcode.findOne({ _id: barcodeId, ...tenantContext.tenantFilter(ctx) }).lean();
  if (!label) throw fail("NOT_FOUND", "That label is not in this company's register.", { reason: "LABEL_UNKNOWN" });

  const state = str(label.identityState) || IDENTITY.ACTIVATED;
  if (state === IDENTITY.VOIDED) {
    throw fail("CONFLICT", `That label was voided${str(label.voidReason) ? `: ${label.voidReason}` : ""}. It cannot be received.`, { reason: "LABEL_VOIDED" });
  }
  if (label.goodsReceiptId) {
    throw fail("CONFLICT",
      `That label was already received${str(label.goodsReceiptNumber) ? ` on ${label.goodsReceiptNumber}` : ""}. One sticker cannot be received twice.`,
      { reason: "LABEL_ALREADY_RECEIVED", goodsReceiptNumber: str(label.goodsReceiptNumber) });
  }
  if (label.receivingSessionId) {
    const other = await GoodsReceiptSession.findOne({ _id: label.receivingSessionId }).select("poNumber poItemId status purchaseOrderId").lean();
    const here = other && String(other.purchaseOrderId) === String(poId);
    throw fail("CONFLICT",
      here
        ? `That label is already counted on this order${other?.status === SESSION_STATUS.OPEN ? "" : " (in a count that is closed)"}.`
        : `That label belongs to a count on ${str(other?.poNumber) || "another order"}. Do not count it here.`,
      { reason: here ? "LABEL_ALREADY_COUNTED" : "LABEL_FROM_ANOTHER_SESSION", poNumber: str(other?.poNumber) });
  }
  if (state !== IDENTITY.ACTIVATED) {
    throw fail("CONFLICT", "That label is not a live material label, so it cannot be taken into a receipt.", { reason: "LABEL_NOT_LIVE", state });
  }
  const quantity = r4(Number(label.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw fail("VALIDATION", "That label carries no quantity, so there is nothing to receive from it.", { reason: "LABEL_NO_QUANTITY" });
  }

  /* ── THE LINE IT BELONGS TO: MATERIAL AND VARIANT, NEVER A NAME ───────── */
  const po = await PurchaseOrder.findOne({ _id: poId, ...tenantContext.tenantFilter(ctx) }).lean();
  if (!po) throw fail("NOT_FOUND", "Purchase order not found.");
  if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(str(po.status))) {
    throw fail("LIFECYCLE_BLOCKED",
      `This order is ${str(po.status).toLowerCase().replace(/_/g, " ")}, so nothing can be received against it.`,
      { reason: "ORDER_NOT_RECEIVABLE", status: po.status });
  }
  const labelItem = str(label.rawItem?._id || label.rawItem);
  const labelVariant = str(label.variantId);
  const sameItem = (po.items || []).filter((i) => str(i.rawItem?._id || i.rawItem) === labelItem && str(i.status) !== "CANCELLED");
  if (!sameItem.length) {
    throw fail("VALIDATION",
      `That label is for ${str(label.rawItemName) || "another material"}, which is not on this order.`,
      { reason: "LABEL_MATERIAL_NOT_ON_ORDER", itemName: str(label.rawItemName) });
  }
  let candidates = sameItem.filter((i) => str(i.variantId) === labelVariant);
  /* A sticker printed with no variant on a one-variant material is that
     variant (the same rule the store map applies). */
  if (!candidates.length && !labelVariant && sameItem.length === 1) candidates = sameItem;
  if (!candidates.length) {
    throw fail("VALIDATION",
      `That label is ${str(label.rawItemName)}${(label.variantCombination || []).length ? ` · ${label.variantCombination.join(" · ")}` : ""}; this order has that material only in another variant.`,
      { reason: "LABEL_VARIANT_NOT_ON_ORDER" });
  }
  if (lineId) {
    candidates = candidates.filter((i) => String(i._id) === str(lineId));
    if (!candidates.length) {
      throw fail("VALIDATION", "That label is for a different material or variant than the line you chose.", { reason: "LABEL_LINE_MISMATCH" });
    }
  }
  const outstandingOf = (i) => r4(Math.max(0, (Number(i.quantity) || 0) - (Number(i.receivedQuantity) || 0)));
  const line = candidates.find((i) => outstandingOf(i) > 0) || candidates[0];
  if (outstandingOf(line) <= 0 && !lineId) {
    throw fail("LIFECYCLE_BLOCKED",
      `Every line for ${str(label.rawItemName) || "that material"} on this order is fully received.`,
      { reason: "LINE_FULLY_RECEIVED" });
  }
  if (str(label.unit) && str(line.unit) && str(label.unit).toLowerCase() !== str(line.unit).toLowerCase()) {
    throw fail("VALIDATION",
      `That label is in ${str(label.unit)} and this line is received in ${str(line.unit)}. A quantity in one unit cannot be counted into the other.`,
      { reason: "LABEL_UNIT_MISMATCH", labelUnit: str(label.unit), lineUnit: str(line.unit) });
  }

  /* ── THE LINE'S COUNT, OPENED OR RESUMED ─────────────────────────────── */
  const opened = await openOrResume(ctx, { poId, lineId: String(line._id), receivingMode: RECEIVING_MODE.COUNT_AND_LABEL }, actor);
  const session = await GoodsReceiptSession.findOne({ _id: opened.session.id, companyId: ctx.companyId });
  if (!session || str(session.status) !== SESSION_STATUS.OPEN) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  if (str(session.receivingMode) !== RECEIVING_MODE.COUNT_AND_LABEL) {
    throw fail("VALIDATION",
      "This line is being received as a total with no labels. Switch it to Count & label to take printed labels into it.",
      { reason: "MODE_IS_TOTAL_ONLY" });
  }
  const level = str(session.trackingLevel);
  const existing = await labelsOf(session._id);
  const t = totalsOf(existing);
  if (level === TRACKING_LEVEL.INDIVIDUAL && !sameQty(quantity, 1)) {
    throw fail("VALIDATION",
      `This count is one label per piece, and that label stands for ${quantity} ${str(label.unit)}. Track this delivery by package to take it in.`,
      { reason: "LABEL_QUANTITY_NOT_ONE" });
  }
  if (level === TRACKING_LEVEL.LOT && t.applied + t.unresolved >= 1) {
    throw fail("VALIDATION", "A lot is one label, and this count already has it.", { reason: "LOT_IS_ONE_LABEL" });
  }

  /* No level yet: a printed label carries its own measured quantity, which
     is what PACKAGE tracking records. Set here, with the reason on record,
     so the count is not left un-finalisable by a level nobody chose. */
  const advanced = await GoodsReceiptSession.findOneAndUpdate(
    { _id: session._id, companyId: ctx.companyId, status: SESSION_STATUS.OPEN },
    {
      $inc: { sequenceHigh: 1 },
      ...(level ? {} : {
        $set: {
          trackingLevel: TRACKING_LEVEL.PACKAGE,
          trackingOverrideReason: session.suggestedTrackingLevel && session.suggestedTrackingLevel !== TRACKING_LEVEL.PACKAGE
            ? "Printed labels adopted; each carries its own measured quantity." : "",
        },
      }),
    },
    { new: true },
  );
  if (!advanced) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  const seq = advanced.sequenceHigh;

  const now = new Date();
  const updated = await Barcode.findOneAndUpdate(
    {
      _id: label._id, receivingSessionId: null, goodsReceiptId: null,
      $or: [{ identityState: IDENTITY.ACTIVATED }, { identityState: { $exists: false } }, { identityState: null }],
    },
    {
      $set: {
        companyId: ctx.companyId,
        identityState: IDENTITY.APPLIED, appliedAt: now, adoptedAt: now,
        quantityMeasured: true,
        receivingSessionId: session._id, sessionSequence: seq,
        purchaseOrder: po._id, purchaseOrderNumber: str(po.poNumber), purchaseOrderItemId: line._id,
        vendor: po.vendor?._id || po.vendor || null, vendorName: str(po.vendorName),
        unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : (label.unitPrice ?? null),
        unit: str(label.unit) || str(line.unit),
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    /* Somebody took it into a count between the read and the write. The
       sequence number advanced for nothing; a gap is honest, a double is not. */
    throw fail("CONFLICT", "That label was taken into a count a moment ago. Refresh and scan again.", { reason: "LABEL_RACE" });
  }

  const labels = await labelsOf(session._id);
  return {
    label: labelView(updated),
    session: { ...sessionView(advanced, labels), outstanding: outstandingOf(line) },
    totals: totalsOf(labels),
    line: { poItemId: String(line._id), itemName: str(line.itemName) || str(label.rawItemName), variant: (line.variantCombination || []).map(str).filter(Boolean).join(" · "), unit: str(line.unit) },
    added: quantity,
  };
}

module.exports = {
  IDENTITY, MAX_BATCH, SESSION_STATUS, RECEIVING_MODE, TRACKING_LEVEL, TRACKING_LEVELS,
  openOrResume, readForOrder, setTrackingLevel,
  reserveBatch, markPrinted, applyLabel, undoLast, voidLabel, resolveScan, cancel, adoptLabel,
  assertCountsAgree, activateForReceipt,
  totalsOf, finalizeBlockers, labelView, sessionView,
};
