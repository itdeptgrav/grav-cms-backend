// services/storePurchase/customerMaterialSession.service.js
//
// RAW ITEM LABELS ON A CUSTOMER-MATERIAL DELIVERY  (1 Oct 2026)
//
// The owner: the customer-owned receive screen must offer "exactly the same
// inputs" as the purchase one — print raw-item labels for a line, scan a
// printed label in, have its quantity added to the line. So a receiving count
// (GoodsReceiptSession) can now hang off a customer-material document line,
// and this service is that half: open or resume the count for a line, print
// its labels, count a scanned one, activate them when the delivery is
// recorded. Everything that does not care which kind of line a count belongs
// to — mark printed, apply, undo, resolve, cancel — is the generic half of
// receivingSession.service and is reused as it stands.
//
// ── WHAT A LABEL PRINTED HERE CARRIES ──────────────────────────────────────
// The material, the variant, the quantity typed for it, and — because there is
// no purchase order — the customer and the document (`customerMaterial.*`),
// never a supplier or a price. Recording the delivery activates every printed
// label of the line's count, stamps the lot, the GRN and the location the lot
// landed in, and claims the labelled quantity on the lot exactly as a label
// printed from the lot afterwards would (`customerMaterialLabel.postLabel`).
"use strict";

const mongoose = require("mongoose");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const GoodsReceiptSession = require("../../models/CMS_Models/StorePurchase/GoodsReceiptSession");
const { CustomerMaterialExpectation } = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const receiving = require("./receivingSession.service");
const { fail } = require("./errors");

const { SESSION_STATUS, RECEIVING_MODE, TRACKING_LEVEL, TRACKING_LEVELS } = GoodsReceiptSession;
const { IDENTITY, UNRESOLVED, COUNTED, labelView, sessionView, totalsOf, openSession, labelsOf } = receiving;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const validId = (v) => mongoose.isValidObjectId(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const MAX_BATCH = receiving.MAX_BATCH;

/* ── THE DOCUMENT AND THE LINE ────────────────────────────────────────────── */
async function issuedDocument(ctx, docId, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(docId)) throw fail("NOT_FOUND", "That document was not found.");
  const doc = await CustomerMaterialExpectation.findOne({ _id: docId, companyId: ctx.companyId }).session(session).lean();
  if (!doc) throw fail("NOT_FOUND", "That document was not found.");
  if (str(doc.state) !== "ISSUED") {
    throw fail("LIFECYCLE_BLOCKED", `This document is ${str(doc.state).toLowerCase()}, so nothing can be received against it.`, { reason: "DOCUMENT_NOT_RECEIVABLE", state: doc.state });
  }
  return doc;
}

function lineOf(doc, lineRef) {
  const line = (doc.lines || []).find((l) => str(l.lineRef) === str(lineRef));
  if (!line) throw fail("NOT_FOUND", "That line was not found on this document.");
  if (!line.rawItemId) throw fail("VALIDATION", "This line names no material, so a label printed for it would name nothing.", { reason: "MATERIAL_NOT_LINKED" });
  return line;
}

const cmSessionView = (session, labels) => ({
  ...sessionView(session, labels),
  customerMaterialId: str(session?.customerMaterialId),
  customerLineRef: str(session?.customerLineRef),
  /* The receiving screen keys sessions by line; on a customer document the
     line's key is its ref. */
  poItemId: str(session?.customerLineRef),
});

/* ── OPEN OR RESUME ───────────────────────────────────────────────────────── */
async function openOrResume(ctx, { docId, lineRef } = {}, actor = {}) {
  const doc = await issuedDocument(ctx, docId);
  const line = lineOf(doc, lineRef);

  const existing = await GoodsReceiptSession.findOne({
    companyId: ctx.companyId, customerMaterialId: doc._id, customerLineRef: str(line.lineRef), status: SESSION_STATUS.OPEN,
  });
  if (existing) {
    const labels = await labelsOf(existing._id);
    return { session: cmSessionView(existing, labels), outstanding: null, resumed: true };
  }

  const material = await RawItem.findOne({ _id: line.rawItemId }).select("name sku unit customUnit variants defaultTrackingLevel").lean();
  const variant = material ? (material.variants || []).find((v) => String(v._id) === str(line.variantId)) || null : null;
  const suggested = TRACKING_LEVELS.includes(str(material?.defaultTrackingLevel)) ? str(material.defaultTrackingLevel) : null;

  const created = await GoodsReceiptSession.create({
    companyId: ctx.companyId,
    siteId: doc.siteId || null,
    customerMaterialId: doc._id,
    customerDocumentRef: str(doc.documentRef),
    customerLineRef: str(line.lineRef),
    rawItemId: line.rawItemId,
    variantId: line.variantId || null,
    itemName: str(line.rawItemName) || str(material?.name),
    sku: str(line.rawItemSku) || str(material?.sku),
    variantSku: str(variant?.sku),
    variantCombination: (line.variantCombination || []).map(str).filter(Boolean),
    unit: str(line.unit),
    receivingMode: RECEIVING_MODE.COUNT_AND_LABEL,
    trackingLevel: suggested || TRACKING_LEVEL.PACKAGE,
    suggestedTrackingLevel: suggested,
    sequenceHigh: 0,
    status: SESSION_STATUS.OPEN,
    openedBy: { id: actor.id || null, name: str(actor.name) },
    openedAt: new Date(),
  }).catch(async (err) => {
    if (err?.code === 11000) {
      const winner = await GoodsReceiptSession.findOne({
        companyId: ctx.companyId, customerMaterialId: doc._id, customerLineRef: str(line.lineRef), status: SESSION_STATUS.OPEN,
      });
      if (winner) return winner;
    }
    throw err;
  });
  const labels = await labelsOf(created._id);
  return { session: cmSessionView(created, labels), outstanding: null, resumed: false };
}

/** Every open count on this document — what the receive screen reads on load. */
async function readForDocument(ctx, { docId } = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(docId)) throw fail("NOT_FOUND", "That document was not found.");
  const sessions = await GoodsReceiptSession.find({
    companyId: ctx.companyId, customerMaterialId: docId, status: SESSION_STATUS.OPEN,
  }).lean();
  const ids = sessions.map((s) => s._id);
  const labels = ids.length ? await Barcode.find({ receivingSessionId: { $in: ids } }).sort({ sessionSequence: 1 }).lean() : [];
  const bySession = new Map(ids.map((id) => [String(id), []]));
  for (const b of labels) bySession.get(String(b.receivingSessionId))?.push(b);
  return { sessions: sessions.map((s) => ({ ...cmSessionView(s, bySession.get(String(s._id)) || []), outstanding: null })) };
}

/* ── PRINTING ─────────────────────────────────────────────────────────────── */
async function reserveBatch(ctx, { sessionId, count = 1, quantityPerLabel = null } = {}, actor = {}) {
  const session = await openSession(ctx, sessionId);
  if (!session.customerMaterialId) throw fail("VALIDATION", "That count belongs to a purchase order.", { reason: "NOT_A_CUSTOMER_MATERIAL_COUNT" });
  const doc = await issuedDocument(ctx, session.customerMaterialId);

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

  const snap = doc.customerSnapshot || {};
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
      /* Whose goods, against which document — no supplier, no price. The lot
         and the GRN are stamped when the delivery is recorded. */
      customerMaterial: {
        customerId: doc.customerId || null,
        customerLabel: str(snap.customerLabel),
        customerCode: str(snap.customerCode),
        orderRef: str(doc.orderRef),
        orderLineRef: str(doc.salesOrderLineRef),
        executionFileId: doc.executionFileId || null,
        documentRef: str(doc.documentRef),
        expectationRevisionNo: doc.revisionNo,
        expectationLineRef: str(session.customerLineRef),
        printCount: 1,
      },
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
    throw fail("LIFECYCLE_BLOCKED", "This label is live stock: its delivery has been recorded. Correcting live stock is a stock adjustment, not a void.", { reason: "LABEL_IS_LIVE" });
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
  return { label: labelView(voided), replacement, session: cmSessionView(session, labels), totals: totalsOf(labels) };
}

/* ── A LABEL SCANNED IN ───────────────────────────────────────────────────── */
async function adoptLabel(ctx, { docId, barcodeId, lineRef = null } = {}, actor = {}) {
  const doc = await issuedDocument(ctx, docId);
  if (!validId(barcodeId)) throw fail("VALIDATION", "That is not a material label printed by GRAV.", { reason: "NOT_A_LABEL" });
  const label = await Barcode.findOne({ _id: barcodeId }).lean();
  if (!label) throw fail("NOT_FOUND", "That label is not in this company's register.", { reason: "LABEL_UNKNOWN" });
  const state = str(label.identityState) || IDENTITY.ACTIVATED;
  if (state === IDENTITY.VOIDED) throw fail("CONFLICT", `That label was voided${str(label.voidReason) ? `: ${label.voidReason}` : ""}. It cannot be received.`, { reason: "LABEL_VOIDED" });
  if (label.goodsReceiptId || label.customerMaterial?.goodsReceiptId) {
    throw fail("CONFLICT", `That label was already received${str(label.goodsReceiptNumber || label.customerMaterial?.goodsReceiptNumber) ? ` on ${str(label.goodsReceiptNumber || label.customerMaterial?.goodsReceiptNumber)}` : ""}. One sticker cannot be received twice.`, { reason: "LABEL_ALREADY_RECEIVED" });
  }

  /* This document's own printed label: scanning it counts it. */
  if (label.receivingSessionId) {
    const own = await GoodsReceiptSession.findOne({ _id: label.receivingSessionId }).select("customerMaterialId customerLineRef status unit itemName variantCombination poNumber customerDocumentRef").lean();
    const here = own && String(own.customerMaterialId || "") === String(doc._id);
    if (here && own.status === SESSION_STATUS.OPEN && UNRESOLVED.includes(state)) {
      const out = await receiving.applyLabel(ctx, { sessionId: own._id, barcodeId, quantity: label.quantity });
      return {
        ...out,
        session: { ...out.session, poItemId: str(own.customerLineRef), customerLineRef: str(own.customerLineRef) },
        line: { poItemId: str(own.customerLineRef), lineRef: str(own.customerLineRef), itemName: str(own.itemName), variant: (own.variantCombination || []).map(str).filter(Boolean).join(" · "), unit: str(own.unit) },
        added: r4(Number(label.quantity) || 0),
        own: true,
      };
    }
    /* Said with the line and the label's number (1 Oct 2026) — see the
       purchase-order twin in receivingSession.service.js. */
    const where = [str(own?.itemName), (own?.variantCombination || []).map(str).filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
    throw fail("CONFLICT",
      here
        ? `Label ${label.sessionSequence ?? ""} was already scanned in on ${where || "this line"}${own?.status === SESSION_STATUS.OPEN ? "" : " (in a count that is closed)"} — its ${r4(Number(label.quantity) || 0)} ${str(label.unit || own?.unit)} are in that line's count already, even if this screen was reloaded since.`
        : `That label belongs to a count on ${str(own?.poNumber || own?.customerDocumentRef) || "another document"}. Do not count it here.`,
      { reason: here ? "LABEL_ALREADY_COUNTED" : "LABEL_FROM_ANOTHER_SESSION", sessionSequence: label.sessionSequence ?? null, line: here ? { poItemId: str(own.customerLineRef), lineRef: str(own.customerLineRef), itemName: str(own.itemName), unit: str(own.unit) } : null });
  }
  if (state !== IDENTITY.ACTIVATED) throw fail("CONFLICT", "That label is not a live material label, so it cannot be taken into a delivery.", { reason: "LABEL_NOT_LIVE", state });
  const quantity = r4(Number(label.quantity));
  if (!(quantity > 0)) throw fail("VALIDATION", "That label carries no quantity, so there is nothing to receive from it.", { reason: "LABEL_NO_QUANTITY" });

  /* The line it belongs to: material and variant, never a name. */
  const labelItem = str(label.rawItem?._id || label.rawItem);
  const labelVariant = str(label.variantId);
  const sameItem = (doc.lines || []).filter((l) => str(l.rawItemId) === labelItem);
  if (!sameItem.length) throw fail("VALIDATION", `That label is for ${str(label.rawItemName) || "another material"}, which is not on this document.`, { reason: "LABEL_MATERIAL_NOT_ON_ORDER" });
  let candidates = sameItem.filter((l) => str(l.variantId) === labelVariant);
  if (!candidates.length && !labelVariant && sameItem.length === 1) candidates = sameItem;
  if (!candidates.length) throw fail("VALIDATION", `That label is ${str(label.rawItemName)}${(label.variantCombination || []).length ? ` · ${label.variantCombination.join(" · ")}` : ""}; this document has that material only in another variant.`, { reason: "LABEL_VARIANT_NOT_ON_ORDER" });
  if (lineRef) {
    candidates = candidates.filter((l) => str(l.lineRef) === str(lineRef));
    if (!candidates.length) throw fail("VALIDATION", "That label is for a different material or variant than the line you chose.", { reason: "LABEL_LINE_MISMATCH" });
  }
  const line = candidates[0];
  if (str(label.unit) && str(line.unit) && str(label.unit).toLowerCase() !== str(line.unit).toLowerCase()) {
    throw fail("VALIDATION", `That label is in ${str(label.unit)} and this line is received in ${str(line.unit)}. A quantity in one unit cannot be counted into the other.`, { reason: "LABEL_UNIT_MISMATCH" });
  }

  const opened = await openOrResume(ctx, { docId, lineRef: str(line.lineRef) }, actor);
  const session = await GoodsReceiptSession.findOne({ _id: opened.session.id, companyId: ctx.companyId });
  const advanced = await GoodsReceiptSession.findOneAndUpdate(
    { _id: session._id, companyId: ctx.companyId, status: SESSION_STATUS.OPEN },
    { $inc: { sequenceHigh: 1 } },
    { new: true },
  );
  if (!advanced) throw fail("LIFECYCLE_BLOCKED", "This count is no longer open.", { reason: "SESSION_NOT_OPEN" });
  const now = new Date();
  const snap = doc.customerSnapshot || {};
  const updated = await Barcode.findOneAndUpdate(
    { _id: label._id, receivingSessionId: null, goodsReceiptId: null, $or: [{ identityState: IDENTITY.ACTIVATED }, { identityState: { $exists: false } }, { identityState: null }] },
    {
      $set: {
        companyId: ctx.companyId,
        identityState: IDENTITY.APPLIED, appliedAt: now, adoptedAt: now, quantityMeasured: true,
        receivingSessionId: session._id, sessionSequence: advanced.sequenceHigh,
        /* Customer property from here on: the stock it stands for is theirs. */
        customerMaterial: {
          customerId: doc.customerId || null, customerLabel: str(snap.customerLabel), customerCode: str(snap.customerCode),
          orderRef: str(doc.orderRef), orderLineRef: str(doc.salesOrderLineRef), executionFileId: doc.executionFileId || null,
          documentRef: str(doc.documentRef), expectationRevisionNo: doc.revisionNo, expectationLineRef: str(line.lineRef), printCount: 1,
        },
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw fail("CONFLICT", "That label was taken into a count a moment ago. Refresh and scan again.", { reason: "LABEL_RACE" });
  const labels = await labelsOf(session._id);
  return {
    label: labelView(updated),
    session: { ...cmSessionView(advanced, labels), outstanding: null },
    totals: totalsOf(labels),
    line: { poItemId: str(line.lineRef), lineRef: str(line.lineRef), itemName: str(line.rawItemName), variant: (line.variantCombination || []).map(str).filter(Boolean).join(" · "), unit: str(line.unit) },
    added: quantity,
  };
}

/* ── RECORDING THE DELIVERY ACTIVATES THE LINE'S LABELS ───────────────────── */
/**
 * Inside the receipt's transaction, after the lots exist. For every line that
 * has an open count: its PRINTED and APPLIED labels become live, stamped with
 * the lot, the GRN and where the lot landed, and the lot's labelled quantity
 * is claimed for them the way a label printed from the lot would claim it.
 * RESERVED identities (never printed) are voided. The count is finalised.
 */
async function activateForReceipt(ctx, { doc, goodsReceipt, lots = [], actor = {} } = {}, dbSession = null) {
  if (!doc || !goodsReceipt) return { activated: 0, voided: 0 };
  const opts = dbSession ? { session: dbSession } : {};
  const sessions = await GoodsReceiptSession.find({ companyId: ctx.companyId, customerMaterialId: doc._id, status: SESSION_STATUS.OPEN }).session(dbSession);
  let activated = 0;
  let voided = 0;
  const now = new Date();
  for (const session of sessions) {
    const lot = lots.find((l) => str(l.expectationLineRef) === str(session.customerLineRef)) || null;
    const grnLine = (goodsReceipt.lines || []).find((l) => str(l.sourceLineRef) === str(session.customerLineRef)) || null;
    if (!lot) continue; // the line was not on this delivery: the count stays open for the next one

    const live = await Barcode.find({ companyId: ctx.companyId, receivingSessionId: session._id, identityState: { $in: [IDENTITY.APPLIED, IDENTITY.PRINTED] } }).session(dbSession);
    /* Label quantities are in the line's unit; the lot holds its base unit. */
    const factor = Number(lot.receiptQuantity) > 0 && Number(lot.baseQuantity) > 0 ? Number(lot.baseQuantity) / Number(lot.receiptQuantity) : 1;
    let seq = Number(lot.lastAllocationSeq) || 0;
    let claimed = 0;
    for (const b of live) {
      seq += 1;
      const baseQty = r4((Number(b.quantity) || 0) * factor);
      claimed += baseQty;
      await Barcode.updateOne({ _id: b._id }, {
        $set: {
          identityState: IDENTITY.ACTIVATED, activatedAt: now,
          goodsReceiptId: goodsReceipt._id, goodsReceiptNumber: str(goodsReceipt.receiptNumber), goodsReceiptLineId: grnLine?._id || null,
          quantity: baseQty, unit: str(lot.baseUnit) || str(b.unit),
          "customerMaterial.lotId": lot._id,
          "customerMaterial.goodsReceiptId": goodsReceipt._id,
          "customerMaterial.goodsReceiptNumber": str(goodsReceipt.receiptNumber),
          "customerMaterial.goodsReceiptLineId": grnLine?._id || lot.goodsReceiptLineId || null,
          "customerMaterial.warehouseId": lot.warehouseId || null,
          "customerMaterial.warehouseName": str(lot.warehouseName),
          "customerMaterial.locationId": lot.locationId || null,
          "customerMaterial.locationCode": str(lot.locationCode),
          "customerMaterial.allocationRef": `${str(lot.goodsReceiptNumber) || str(lot._id)}/L${seq}`,
          "customerMaterial.allocationSeq": seq,
          "customerMaterial.printCount": Math.max(1, Number(b.customerMaterial?.printCount) || 0),
          "customerMaterial.lastPrintedAt": b.printedAt || now,
        },
      }, opts);
      activated += 1;
    }
    if (live.length) {
      await CustomerMaterialLot.updateOne({ _id: lot._id }, {
        $inc: { labelledQuantity: r4(claimed), labelCount: live.length, lastAllocationSeq: live.length },
        $set: { lastLabelledAt: now },
      }, opts);
    }
    const vd = await Barcode.updateMany(
      { companyId: ctx.companyId, receivingSessionId: session._id, identityState: IDENTITY.RESERVED },
      { $set: { identityState: IDENTITY.VOIDED, voidedAt: now, voidedBy: actor.id || null, voidReason: "Reserved during counting and never printed. Voided when the delivery was recorded." } },
      opts,
    );
    voided += vd.modifiedCount || 0;
    await GoodsReceiptSession.updateOne({ _id: session._id }, {
      $set: { status: SESSION_STATUS.FINALIZED, finalizedAt: now, goodsReceiptId: goodsReceipt._id, goodsReceiptNumber: str(goodsReceipt.receiptNumber), goodsReceiptLineId: grnLine?._id || null },
    }, opts);
  }
  return { activated, voided };
}

module.exports = {
  openOrResume, readForDocument, reserveBatch, voidLabel, adoptLabel, activateForReceipt,
  /* The generic half, re-exported so the router has one module to call. */
  markPrinted: receiving.markPrinted, applyLabel: receiving.applyLabel, undoLast: receiving.undoLast,
  resolveScan: receiving.resolveScan, cancel: receiving.cancel,
};
