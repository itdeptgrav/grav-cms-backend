// services/storePurchase/materialRequestSession.service.js
//
// RAW ITEM LABELS ON A MATERIAL-REQUEST RECEIPT  (7 Oct 2026)
//
// The owner: the material-request receive page must work exactly like the
// purchase-order one — print raw-item labels for a line, scan a printed label
// in and have its quantity counted. So a receiving count (GoodsReceiptSession)
// can hang off a material-request line too, and this service is that half:
// open or resume the line's count, print its labels, take a scanned one in,
// activate them when the receipt is recorded. Everything that does not care
// which kind of line a count belongs to — mark printed, apply, undo, resolve,
// cancel — is receivingSession.service's generic half, reused as it stands.
//
// The request lives on the order (`CustomerRequest.materialRequests[]`, source
// "merchandising"). Its stock is the COMPANY's: labels printed here carry no
// customer claim and no supplier or price — they are ordinary raw-item labels
// that become live when the receipt is recorded.
"use strict";

const mongoose = require("mongoose");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const GoodsReceiptSession = require("../../models/CMS_Models/StorePurchase/GoodsReceiptSession");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const receiving = require("./receivingSession.service");
const { fail } = require("./errors");

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");

const { SESSION_STATUS, RECEIVING_MODE, TRACKING_LEVEL, TRACKING_LEVELS } = GoodsReceiptSession;
const { IDENTITY, UNRESOLVED, labelView, sessionView, totalsOf, openSession, labelsOf } = receiving;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const validId = (v) => mongoose.isValidObjectId(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const MAX_BATCH = receiving.MAX_BATCH;

/* ── THE REQUEST AND THE LINE ─────────────────────────────────────────────── */
async function receivableRequest(ctx, requestId) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(requestId)) throw fail("NOT_FOUND", "That material request was not found.");
  const order = await CustomerRequest().findOne({ "materialRequests._id": requestId }).select("requestId materialRequests").lean();
  const request = order && (order.materialRequests || []).find((r) => str(r._id) === str(requestId));
  if (!request || str(request.source) !== "merchandising" || str(request.companyId) !== str(ctx.companyId)) {
    throw fail("NOT_FOUND", "That material request was not found.");
  }
  const status = str(request.status);
  if (status === "draft" || status === "cancelled") {
    throw fail("LIFECYCLE_BLOCKED", status === "draft"
      ? "This material request has not been submitted by Merchandising yet."
      : "This material request was withdrawn; nothing can be received against it.",
    { reason: "REQUEST_NOT_RECEIVABLE", status });
  }
  return { order, request };
}

function lineOf(request, lineId) {
  const line = (request.lines || []).find((l) => str(l._id) === str(lineId));
  if (!line) throw fail("NOT_FOUND", "That line was not found on this material request.");
  return line;
}

const pendingOf = (line) => Math.max(0, r4((Number(line.quantity) || 0) - (Number(line.receivedQuantity) || 0)));

const mrSessionView = (session, labels, line = null) => ({
  ...sessionView(session, labels),
  materialRequestId: str(session?.materialRequestId),
  materialLineId: str(session?.materialLineId),
  /* The receiving screen and its panels key a count by line; here the line
     is the request line. */
  poItemId: str(session?.materialLineId),
  outstanding: line ? pendingOf(line) : null,
});

/* ── OPEN OR RESUME ───────────────────────────────────────────────────────── */
async function openOrResume(ctx, { requestId, lineId } = {}, actor = {}) {
  const { order, request } = await receivableRequest(ctx, requestId);
  const line = lineOf(request, lineId);

  const existing = await GoodsReceiptSession.findOne({
    companyId: ctx.companyId, materialLineId: line._id, status: SESSION_STATUS.OPEN,
  });
  if (existing) {
    const labels = await labelsOf(existing._id);
    return { session: mrSessionView(existing, labels, line), resumed: true };
  }

  const material = await RawItem.findOne({ _id: line.rawItemId }).select("name sku unit variants defaultTrackingLevel").lean();
  const variant = material ? (material.variants || []).find((v) => String(v._id) === str(line.variantId)) || null : null;
  const suggested = TRACKING_LEVELS.includes(str(material?.defaultTrackingLevel)) ? str(material.defaultTrackingLevel) : null;

  const created = await GoodsReceiptSession.create({
    companyId: ctx.companyId,
    materialRequestId: request._id,
    materialRequestNumber: str(request.requestNumber),
    materialLineId: line._id,
    orderRequestId: order._id,
    rawItemId: line.rawItemId,
    variantId: line.variantId || null,
    itemName: str(line.rawItemName) || str(material?.name),
    sku: str(line.rawItemSku) || str(material?.sku),
    variantSku: str(variant?.sku),
    variantCombination: (line.variantCombination || []).map(str).filter(Boolean),
    unit: str(line.unit) || str(material?.unit),
    receivingMode: RECEIVING_MODE.COUNT_AND_LABEL,
    trackingLevel: suggested || TRACKING_LEVEL.PACKAGE,
    suggestedTrackingLevel: suggested,
    sequenceHigh: 0,
    status: SESSION_STATUS.OPEN,
    openedBy: { id: actor.id || null, name: str(actor.name) },
    openedAt: new Date(),
  }).catch(async (err) => {
    if (err?.code === 11000) {
      const winner = await GoodsReceiptSession.findOne({ companyId: ctx.companyId, materialLineId: line._id, status: SESSION_STATUS.OPEN });
      if (winner) return winner;
    }
    throw err;
  });
  const labels = await labelsOf(created._id);
  return { session: mrSessionView(created, labels, line), resumed: false };
}

/** Every open count on this request — what the receive screen reads on load. */
async function readForRequest(ctx, { requestId } = {}) {
  const { request } = await receivableRequest(ctx, requestId).catch(async (err) => {
    /* A fully received or withdrawn request still answers its counts (none). */
    if (err?.code === "LIFECYCLE_BLOCKED") return { request: null };
    throw err;
  });
  if (!request) return { sessions: [] };
  const sessions = await GoodsReceiptSession.find({
    companyId: ctx.companyId, materialRequestId: request._id, status: SESSION_STATUS.OPEN,
  }).lean();
  const ids = sessions.map((s) => s._id);
  const labels = ids.length ? await Barcode.find({ receivingSessionId: { $in: ids } }).sort({ sessionSequence: 1 }).lean() : [];
  const bySession = new Map(ids.map((id) => [String(id), []]));
  for (const b of labels) bySession.get(String(b.receivingSessionId))?.push(b);
  return {
    sessions: sessions.map((s) => {
      const line = (request.lines || []).find((l) => str(l._id) === str(s.materialLineId)) || null;
      return mrSessionView(s, bySession.get(String(s._id)) || [], line);
    }),
  };
}

/* ── PRINTING ─────────────────────────────────────────────────────────────── */
async function reserveBatch(ctx, { sessionId, count = 1, quantityPerLabel = null } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);
  if (!session.materialRequestId) throw fail("VALIDATION", "That count does not belong to a material request.", { reason: "NOT_A_MATERIAL_REQUEST_COUNT" });
  await receivableRequest(ctx, session.materialRequestId);

  let level = str(session.trackingLevel);
  if (!TRACKING_LEVELS.includes(level)) {
    level = TRACKING_LEVEL.PACKAGE;
    await GoodsReceiptSession.updateOne({ _id: session._id }, { $set: { trackingLevel: level } });
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw fail("VALIDATION", "Print at least one label, as a whole number.", { field: "count" });
  if (n > MAX_BATCH) throw fail("VALIDATION", `Up to ${MAX_BATCH} labels can be reserved in one batch.`, { field: "count" });
  let per = Number(quantityPerLabel);
  if (!Number.isFinite(per) || per <= 0) {
    if (level === TRACKING_LEVEL.INDIVIDUAL) per = 1;
    else throw fail("VALIDATION", `Enter what one label holds, in ${str(session.unit) || "the line's unit"}.`, { field: "quantityPerLabel" });
  }
  per = r4(per);

  const advanced = await GoodsReceiptSession.findOneAndUpdate(
    { _id: session._id, companyId: ctx.companyId, status: SESSION_STATUS.OPEN },
    { $inc: { sequenceHigh: n } },
    { new: true },
  );
  if (!advanced) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  const from = advanced.sequenceHigh - n + 1;

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
      generatedBy: actor.id || null,
      identityState: IDENTITY.RESERVED,
      receivingSessionId: session._id,
      sessionSequence: from + i,
      quantityMeasured: true,
    });
  }
  let created;
  try {
    created = await Barcode.insertMany(rows, { ordered: true });
  } catch (err) {
    if (err?.code === 11000) {
      throw fail("CONFLICT", "Another terminal is counting this line at the same moment. Refresh and print again — no labels were created.", { reason: "SEQUENCE_COLLISION" });
    }
    throw err;
  }
  return {
    labels: created.map((b) => labelView(b.toObject ? b.toObject() : b)),
    sequenceFrom: from, sequenceTo: advanced.sequenceHigh, quantityPerLabel: per, total: r4(per * n),
  };
}

/** Void, with an optional replacement printed through THIS service. */
async function voidLabel(ctx, { sessionId, barcodeId, reason = "", replace = false } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);
  if (!validId(barcodeId)) throw fail("NOT_FOUND", "That label was not found in this count.");
  if (!str(reason)) throw fail("VALIDATION", "Say why this label is being voided.", { field: "reason" });
  const label = await Barcode.findOne({ _id: barcodeId, companyId: ctx.companyId, receivingSessionId: session._id }).lean();
  if (!label) throw fail("NOT_FOUND", "That label was not found in this count.");
  if (str(label.identityState) === IDENTITY.VOIDED) throw fail("CONFLICT", "That label is already voided.", { reason: "ALREADY_VOIDED" });
  if (str(label.identityState) === IDENTITY.ACTIVATED) {
    throw fail("LIFECYCLE_BLOCKED", "This label is live stock: its receipt has been recorded. Correcting live stock is a stock adjustment, not a void.", { reason: "LABEL_IS_LIVE" });
  }
  const voided = await Barcode.findOneAndUpdate(
    { _id: barcodeId, companyId: ctx.companyId, identityState: { $ne: IDENTITY.VOIDED } },
    { $set: { identityState: IDENTITY.VOIDED, voidedAt: new Date(), voidedBy: actor.id || null, voidReason: str(reason) } },
    { new: true },
  ).lean();
  if (!voided) throw fail("CONFLICT", "That label was settled a moment ago. Refresh the count.", { reason: "LABEL_RACE" });
  let replacement = null;
  if (replace) {
    const out = await reserveBatch(ctx, { sessionId, count: 1, quantityPerLabel: Number(label.quantity) || null }, actor);
    replacement = out.labels[0] || null;
    if (replacement) {
      await Barcode.updateOne({ _id: replacement.id }, { $set: { replacesBarcodeId: voided._id } });
      await Barcode.updateOne({ _id: voided._id }, { $set: { replacedByBarcodeId: replacement.id } });
      replacement.replacesBarcodeId = str(voided._id);
    }
  }
  const labels = await labelsOf(session._id);
  return { label: labelView(voided), replacement, session: mrSessionView(session, labels), totals: totalsOf(labels) };
}

/* ── A LABEL SCANNED IN ───────────────────────────────────────────────────── */
async function adoptLabel(ctx, { requestId, barcodeId, lineId = null } = {}, actor = {}) {
  const { request } = await receivableRequest(ctx, requestId);
  if (!validId(barcodeId)) throw fail("VALIDATION", "That is not a material label printed by GRAV.", { reason: "NOT_A_LABEL" });
  const label = await Barcode.findOne({ _id: barcodeId }).lean();
  if (!label) throw fail("NOT_FOUND", "That label is not in this company's register.", { reason: "LABEL_UNKNOWN" });
  const state = str(label.identityState) || IDENTITY.ACTIVATED;
  if (state === IDENTITY.VOIDED) throw fail("CONFLICT", `That label was voided${str(label.voidReason) ? `: ${label.voidReason}` : ""}. It cannot be received.`, { reason: "LABEL_VOIDED" });
  if (label.goodsReceiptId) {
    throw fail("CONFLICT", `That label was already received${str(label.goodsReceiptNumber) ? ` on ${str(label.goodsReceiptNumber)}` : ""}. One sticker cannot be received twice.`, { reason: "LABEL_ALREADY_RECEIVED" });
  }
  if (label.customerMaterial?.lotId || label.customerMaterial?.customerId) {
    throw fail("CONFLICT", "That label is a customer's material, not the company's. It cannot be received against a material request.", { reason: "LABEL_IS_CUSTOMER_PROPERTY" });
  }

  /* This request's own printed label: scanning it counts it. */
  if (label.receivingSessionId) {
    const own = await GoodsReceiptSession.findOne({ _id: label.receivingSessionId }).select("materialRequestId materialLineId status unit itemName variantCombination poNumber customerDocumentRef materialRequestNumber").lean();
    const here = own && String(own.materialRequestId || "") === String(request._id);
    if (here && own.status === SESSION_STATUS.OPEN && UNRESOLVED.includes(state)) {
      const out = await receiving.applyLabel(ctx, { sessionId: own._id, barcodeId, quantity: label.quantity });
      const lineRef = str(own.materialLineId);
      return {
        ...out,
        session: { ...out.session, poItemId: lineRef, materialLineId: lineRef },
        line: { poItemId: lineRef, lineRef, itemName: str(own.itemName), variant: (own.variantCombination || []).map(str).filter(Boolean).join(" · "), unit: str(own.unit) },
        added: r4(Number(label.quantity) || 0),
        own: true,
      };
    }
    const where = [str(own?.itemName), (own?.variantCombination || []).map(str).filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
    throw fail("CONFLICT",
      here
        ? `Label ${label.sessionSequence ?? ""} was already scanned in on ${where || "this line"}${own?.status === SESSION_STATUS.OPEN ? "" : " (in a count that is closed)"} — its ${r4(Number(label.quantity) || 0)} ${str(label.unit || own?.unit)} are in that line's count already, even if this screen was reloaded since.`
        : `That label belongs to a count on ${str(own?.poNumber || own?.customerDocumentRef || own?.materialRequestNumber) || "another document"}. Do not count it here.`,
      { reason: here ? "LABEL_ALREADY_COUNTED" : "LABEL_FROM_ANOTHER_SESSION", sessionSequence: label.sessionSequence ?? null });
  }
  if (state !== IDENTITY.ACTIVATED) throw fail("CONFLICT", "That label is not a live material label, so it cannot be taken into a receipt.", { reason: "LABEL_NOT_LIVE", state });
  const quantity = r4(Number(label.quantity));
  if (!(quantity > 0)) throw fail("VALIDATION", "That label carries no quantity, so there is nothing to receive from it.", { reason: "LABEL_NO_QUANTITY" });

  /* The line it belongs to: material and variant, never a name. */
  const labelItem = str(label.rawItem?._id || label.rawItem);
  const labelVariant = str(label.variantId);
  const sameItem = (request.lines || []).filter((l) => str(l.rawItemId) === labelItem);
  if (!sameItem.length) throw fail("VALIDATION", `That label is for ${str(label.rawItemName) || "another material"}, which is not on this request.`, { reason: "LABEL_MATERIAL_NOT_ON_ORDER" });
  let candidates = sameItem.filter((l) => str(l.variantId) === labelVariant);
  if (!candidates.length && !labelVariant && sameItem.length === 1) candidates = sameItem;
  if (!candidates.length) throw fail("VALIDATION", `That label is ${str(label.rawItemName)}${(label.variantCombination || []).length ? ` · ${label.variantCombination.join(" · ")}` : ""}; this request has that material only in another variant.`, { reason: "LABEL_VARIANT_NOT_ON_ORDER" });
  if (lineId) {
    candidates = candidates.filter((l) => str(l._id) === str(lineId));
    if (!candidates.length) throw fail("VALIDATION", "That label is for a different material or variant than the line you chose.", { reason: "LABEL_LINE_MISMATCH" });
  }
  const line = candidates[0];
  if (str(label.unit) && str(line.unit) && str(label.unit).toLowerCase() !== str(line.unit).toLowerCase()) {
    throw fail("VALIDATION", `That label is in ${str(label.unit)} and this line is received in ${str(line.unit)}. A quantity in one unit cannot be counted into the other.`, { reason: "LABEL_UNIT_MISMATCH" });
  }

  const opened = await openOrResume(ctx, { requestId, lineId: str(line._id) }, actor);
  const advanced = await GoodsReceiptSession.findOneAndUpdate(
    { _id: opened.session.id, companyId: ctx.companyId, status: SESSION_STATUS.OPEN },
    { $inc: { sequenceHigh: 1 } },
    { new: true },
  );
  if (!advanced) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  const now = new Date();
  const updated = await Barcode.findOneAndUpdate(
    { _id: label._id, receivingSessionId: null, goodsReceiptId: null, $or: [{ identityState: IDENTITY.ACTIVATED }, { identityState: { $exists: false } }, { identityState: null }] },
    {
      $set: {
        companyId: ctx.companyId,
        identityState: IDENTITY.APPLIED, appliedAt: now, adoptedAt: now, quantityMeasured: true,
        receivingSessionId: advanced._id, sessionSequence: advanced.sequenceHigh,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw fail("CONFLICT", "That label was taken into a count a moment ago. Refresh and scan again.", { reason: "LABEL_RACE" });
  const labels = await labelsOf(advanced._id);
  const lineRef = str(line._id);
  return {
    label: labelView(updated),
    session: mrSessionView(advanced, labels, line),
    totals: totalsOf(labels),
    line: { poItemId: lineRef, lineRef, itemName: str(line.rawItemName), variant: (line.variantCombination || []).map(str).filter(Boolean).join(" · "), unit: str(line.unit) },
    added: quantity,
  };
}

/* ── RECORDING THE RECEIPT ACTIVATES THE LINE'S LABELS ────────────────────── */
/**
 * Inside the receipt's transaction. For every request line that has an open
 * count AND is on this receipt: its PRINTED and APPLIED labels become live,
 * stamped with the GRN (quantities into the base unit the stock moved in);
 * RESERVED identities (never printed) are voided; the count is finalised. A
 * line not on this receipt keeps its count open for the next delivery.
 */
async function activateForReceipt(ctx, { request, goodsReceipt, actor = {} } = {}, dbSession = null) {
  if (!request || !goodsReceipt) return { activated: 0, voided: 0 };
  const opts = dbSession ? { session: dbSession } : {};
  const sessions = await GoodsReceiptSession.find({ companyId: ctx.companyId, materialRequestId: request._id, status: SESSION_STATUS.OPEN }).session(dbSession);
  let activated = 0;
  let voided = 0;
  const now = new Date();
  for (const session of sessions) {
    const grnLine = (goodsReceipt.lines || []).find((l) => str(l.sourceLineId) === str(session.materialLineId)) || null;
    if (!grnLine) continue;
    const factor = Number(grnLine.receivedQuantity) > 0 && Number(grnLine.baseQuantity) > 0
      ? Number(grnLine.baseQuantity) / Number(grnLine.receivedQuantity) : 1;
    const live = await Barcode.find({ companyId: ctx.companyId, receivingSessionId: session._id, identityState: { $in: [IDENTITY.APPLIED, IDENTITY.PRINTED] } }).session(dbSession);
    for (const b of live) {
      await Barcode.updateOne({ _id: b._id }, {
        $set: {
          identityState: IDENTITY.ACTIVATED, activatedAt: now,
          goodsReceiptId: goodsReceipt._id, goodsReceiptNumber: str(goodsReceipt.receiptNumber), goodsReceiptLineId: grnLine._id || null,
          quantity: r4((Number(b.quantity) || 0) * factor), unit: str(grnLine.baseUnit) || str(b.unit),
        },
      }, opts);
      activated += 1;
    }
    const vd = await Barcode.updateMany(
      { companyId: ctx.companyId, receivingSessionId: session._id, identityState: IDENTITY.RESERVED },
      { $set: { identityState: IDENTITY.VOIDED, voidedAt: now, voidedBy: actor.id || null, voidReason: "Reserved during counting and never printed. Voided when the receipt was recorded." } },
      opts,
    );
    voided += vd.modifiedCount || 0;
    await GoodsReceiptSession.updateOne({ _id: session._id }, {
      $set: { status: SESSION_STATUS.FINALIZED, finalizedAt: now, goodsReceiptId: goodsReceipt._id, goodsReceiptNumber: str(goodsReceipt.receiptNumber), goodsReceiptLineId: grnLine._id || null },
    }, opts);
  }
  return { activated, voided };
}

module.exports = {
  openOrResume, readForRequest, reserveBatch, voidLabel, adoptLabel, activateForReceipt,
  /* The generic half, re-exported so the router has one module to call. */
  markPrinted: receiving.markPrinted, applyLabel: receiving.applyLabel, undoLast: receiving.undoLast,
  resolveScan: receiving.resolveScan, cancel: receiving.cancel,
};
