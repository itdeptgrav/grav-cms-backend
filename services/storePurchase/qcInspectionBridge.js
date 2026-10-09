// services/storePurchase/qcInspectionBridge.js
//
// QC'S RAW-MATERIAL CHECK IS THE INSPECTION OF A MATERIAL-REQUEST GRN  (8 Oct 2026)
//
// The Store's receipt control has its own inspection record
// (GoodsReceiptInspection), written on the Store's inspection form. For a
// material-request GRN the inspection happens on the QC dashboard instead: QC
// scans each label the Store printed and records passed / defective per label
// (QCRawItemInspection, stamped with the GRN). The owner: the Store must not
// say "awaiting inspection" for a receipt QC has checked in full.
//
// So this reads QC's standing records for a GRN and, when every line is
// checked in full, hands the control pipeline an inspection shaped like the
// Store's own — accepted = passed, rejected = defective, nothing quarantined —
// marked `source: "qc"`. While QC is part-way the receipt stays "awaiting
// inspection" and `progress` says how far QC has got. It reads; it writes no
// Store record, posts no stock move.
"use strict";

const mongoose = require("mongoose");
const QCRawItemInspection = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const idStr = (v) => (v ? String(v) : "");
const TOL = 0.0001;
const MATERIAL = "MATERIAL_REQUEST";

/* A record saved against a receipt but no line (a label the checker linked
   on the spot) belongs to the line carrying its material. */
function lineIdFor(grn, rec) {
  const own = idStr(rec.goodsReceiptLineId);
  if (own && (grn.lines || []).some((l) => idStr(l._id) === own)) return own;
  const line = (grn.lines || []).find((l) => idStr(l.rawItemId) === idStr(rec.rawItemId)
    && (!l.variantId || !rec.variantId || idStr(l.variantId) === idStr(rec.variantId)));
  return line ? idStr(line._id) : "";
}

/**
 * QC's standing on each material-request GRN among `grns`.
 * @returns Map<goodsReceiptId, { inspection: object|null, progress: {...} }>
 */
async function qcStandingFor(grns) {
  const material = (grns || []).filter((g) => g && g.sourceType === MATERIAL);
  const out = new Map();
  if (!material.length) return out;
  const ids = material.map((g) => g._id);
  const recs = await QCRawItemInspection.find({ goodsReceiptId: { $in: ids }, superseded: { $ne: true } })
    .select("goodsReceiptId goodsReceiptLineId rawItemId variantId quantity passedQuantity defectiveQuantity status inspectedAt inspectedByName unit").lean();
  const byGrn = new Map();
  for (const r of recs) {
    const k = idStr(r.goodsReceiptId);
    if (!byGrn.has(k)) byGrn.set(k, []);
    byGrn.get(k).push(r);
  }
  for (const g of material) {
    const k = idStr(g._id);
    const rows = byGrn.get(k) || [];
    const perLine = new Map();
    for (const l of g.lines || []) perLine.set(idStr(l._id), { received: r4(l.receivedQuantity), unit: String(l.poUnit || ""), checked: 0, passed: 0, defective: 0, labels: 0 });
    let lastAt = null;
    const checkers = new Set();
    for (const r of rows) {
      const lk = lineIdFor(g, r);
      const cur = perLine.get(lk);
      if (!cur) continue;
      cur.checked = r4(cur.checked + r.quantity); cur.passed = r4(cur.passed + r.passedQuantity); cur.defective = r4(cur.defective + r.defectiveQuantity); cur.labels += 1;
      if (r.inspectedByName) checkers.add(r.inspectedByName);
      if (!lastAt || r.inspectedAt > lastAt) lastAt = r.inspectedAt;
    }
    const lines = [...perLine.entries()].map(([lineId, v]) => ({ lineId, ...v, remaining: r4(Math.max(0, v.received - v.checked)) }));
    const anyChecked = lines.some((l) => l.checked > TOL);
    const complete = lines.length > 0 && lines.every((l) => l.remaining <= TOL);
    const text = lines.filter((l) => l.received > 0).map((l) => `${l.checked} of ${l.received} ${l.unit}`.trim()).join(" · ");
    const progress = { complete, anyChecked, lines, text, lastAt, checkers: [...checkers] };
    const inspection = complete ? {
      _id: null,
      source: "qc",
      goodsReceiptId: g._id,
      inspectedAt: lastAt,
      inspectedBy: { name: [...checkers].join(", ") || "QC" },
      note: "Checked by QC on the raw-material inspection (every label on this receipt).",
      lines: lines.map((l) => ({
        goodsReceiptLineId: l.lineId,
        /* accepted = what passed, capped at what the line received; the rest
           of what was checked is defective. Nothing is quarantined: QC's verdict
           is pass or defect per label. */
        acceptedQuantity: r4(Math.min(l.received, l.passed)),
        quarantinedQuantity: 0,
        rejectedQuantity: r4(Math.max(0, l.received - Math.min(l.received, l.passed))),
      })),
    } : null;
    out.set(k, { inspection, progress });
  }
  return out;
}

/** One GRN's standing, or null for a receipt that is not against a material request. */
async function qcStandingOf(grn) {
  const m = await qcStandingFor([grn]);
  return m.get(idStr(grn?._id)) || null;
}

module.exports = { qcStandingFor, qcStandingOf, MATERIAL };
