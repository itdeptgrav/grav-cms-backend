// services/manufacturing/labelIssued.js — what the Store issued off a raw-item
// label, for Cutting's fabric scan (17 Oct 2026).
"use strict";
/* WHAT THE STORE ISSUED OFF A LABEL (17 Oct 2026, owner: "we issued 2 pcs …
   it should have taken the quantity assigned to them, but it takes 0"). An MRF
   issue takes the issued quantity OFF the label, so a roll issued whole reads
   0 by the time Cutting scans it. In order:
     1. the label's own issue log (`Barcode.issues`, written by every MRF issue
        since 17 Oct 2026) — net of returns;
     2. what the label still says, when it says more than 0 (a label handed
        over without an MRF issue);
     3. a label issued before the log existed: the latest MRF issue of its raw
        item and variant, in the label's unit — named, so the floor can see
        where the figure came from.
   Null when none gives a quantity. */
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
async function issuedOffLabel(b) {
  const r = (n) => Math.round(n * 1000) / 1000;
  const log = Array.isArray(b.issues) ? b.issues : [];
  let net = log.reduce((a, x) => a + (Number(x.quantity) || 0), 0);
  const refs = log.map((x) => x.mrfNumber).filter(Boolean);
  /* Inventory › Issues and returns writes the label's before/after on its own
     issuance record (stockissuances) — a debit took that much off the label,
     a credit put it back. */
  const issuances = await StockIssuance.find({ "items.barcodeId": b._id }).select("direction items.barcodeId items.barcodeQtyBefore items.barcodeQtyAfter").lean();
  for (const doc of issuances) for (const it of doc.items || []) {
    if (String(it.barcodeId) !== String(b._id) || it.barcodeQtyBefore == null || it.barcodeQtyAfter == null) continue;
    net += Number(it.barcodeQtyBefore) - Number(it.barcodeQtyAfter);
    refs.push("Issues and returns");
  }
  if (net > 0) return { quantity: r(net), unit: b.unit || "", source: "issued", mrfNumber: [...new Set(refs)].join(", ") };
  if ((Number(b.quantity) || 0) > 0) return { quantity: r(Number(b.quantity)), unit: b.unit || "", source: "label", mrfNumber: "" };
  if (!b.rawItem) return null;
  const same = (a, c) => String(a || "").trim().toLowerCase() === String(c || "").trim().toLowerCase();
  const mrfs = await MRF.find({ "items.rawItem": b.rawItem, "items.issueHistory.0": { $exists: true } })
    .select("mrfNumber requestedForDept items.rawItem items.variantId items.unit items.baseUnit items.issueHistory").sort({ updatedAt: -1 }).limit(20).lean();
  let best = null;
  for (const m of mrfs) for (const it of m.items || []) {
    if (String(it.rawItem) !== String(b.rawItem)) continue;
    if (b.variantId && it.variantId && String(it.variantId) !== String(b.variantId)) continue;
    if (!same(it.unit, b.unit)) continue;
    for (const h of it.issueHistory || []) {
      const at = new Date(h.recordedAt || 0).getTime();
      const cutting = /cut/i.test(m.requestedForDept || "") ? 1 : 0;
      if (!(Number(h.issuedQty) > 0)) continue;
      if (!best || cutting > best.cutting || (cutting === best.cutting && at > best.at)) best = { at, cutting, quantity: Number(h.issuedQty), mrfNumber: m.mrfNumber };
    }
  }
  return best ? { quantity: r(best.quantity), unit: b.unit || "", source: "mrf-history", mrfNumber: best.mrfNumber } : null;
}

module.exports = { issuedOffLabel };
