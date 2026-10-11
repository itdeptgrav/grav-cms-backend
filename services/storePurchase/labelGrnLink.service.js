// services/storePurchase/labelGrnLink.service.js
//
// LINKING PRINTED LABELS TO A RECORDED GOODS RECEIPT  (11 Oct 2026, owner)
//
// The Material labels screen prints raw-item stickers with no receipt behind
// them. Often the goods those stickers are on DID arrive on a goods receipt —
// recorded with a typed quantity, the labels printed afterwards from stock on
// hand. The owner: "some raw item barcode are gonna generated without linked
// to an grn, so keep an interface in order to link to an grn … once linked,
// when the user scans the raw item barcode it will showcase that linked grn".
//
// So the Store scans the labels in bulk (step 1), picks the receipt they came
// on (step 2), and links them. A linked label then carries exactly what a label
// printed AT that receipt carries — the receipt, its line, and on a purchase
// receipt the order, the order line, the supplier and the price — so every
// reader that already follows `goodsReceiptId` (the scan page, QC Inspect, the
// GRN view's label count, QC's GRN book) sees it without learning anything new.
//
// Rules, each stated where it is enforced:
//
//   · NOTHING MOVES. The receipt already put the goods into stock and the
//     label was printed for stock on hand. Linking writes provenance only.
//   · A label claims a delivery only if the delivery contained its material —
//     matched by the label's material and variant against the receipt's
//     lines, never by a name (the same rule POST /barcodes applies).
//   · Purchase and material-request receipts only. A customer-owned delivery
//     labels its lots from its own receipt, with ownership on the sticker; a
//     company label linked to one would put our stock on a customer's GRN.
//   · A label already on a receipt, voided, customer-owned or inside an open
//     receiving count is refused with the reason, and stays as it was.
//   · More on labels than the line received is said, never refused — the
//     owner's rule for labels everywhere on the receiving screens.
//   · A link made HERE can be taken back (to exactly what the label carried
//     before) until QC has checked the label against that receipt.
"use strict";

const mongoose = require("mongoose");

const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const tenantContext = require("./tenantContext.service");
const unitOfWork = require("./unitOfWork.service");
const { IDENTITY_STATE, isUsableIdentity, usableIdentity } = require("./labelIdentity");
const { fail } = require("./errors");

const { SOURCE_TYPE } = GoodsReceipt;
const LINKABLE_SOURCES = Object.freeze([SOURCE_TYPE.PURCHASE_ORDER, SOURCE_TYPE.MATERIAL_REQUEST]);
/* One batch is what one person scans at a stack of goods; the cap keeps a
   runaway list from turning one request into a scan of the whole register. */
const MAX_LABELS = 200;
const MAX_CHOICES = 40;
const ENTITY = "GOODS_RECEIPT";

const str = (v) => String(v ?? "").trim();
const idStr = (v) => (v ? String(v._id || v) : "");
const isId = (v) => /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const sameUnit = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
const variantText = (arr) => (arr || []).map(str).filter(Boolean).join(" · ");

const KIND = Object.freeze({ PURCHASE: "purchase", MATERIAL_REQUEST: "material-request", CUSTOMER: "customer-material" });
const kindOf = (g) => (g?.sourceType === SOURCE_TYPE.MATERIAL_REQUEST ? KIND.MATERIAL_REQUEST
  : g?.sourceType === SOURCE_TYPE.CUSTOMER_MATERIAL ? KIND.CUSTOMER : KIND.PURCHASE);
const grnHref = (id) => `/store/dashboard/operations/goods-receipts/${id}/document`;

/* ── THE LABEL, AS THE SCREEN SHOWS IT ──────────────────────────────────── */
function labelFacts(b) {
  return {
    id: idStr(b._id),
    rawItemId: idStr(b.rawItem),
    rawItemName: str(b.rawItemName),
    rawItemSku: str(b.rawItemSku),
    variantId: idStr(b.variantId) || null,
    variant: variantText(b.variantCombination),
    quantity: r4(b.quantity),
    unit: str(b.unit),
    printedAt: b.createdAt || null,
    purchaseOrderNumber: str(b.purchaseOrderNumber),
  };
}

/**
 * Why this label cannot be linked to any receipt, or null when it can.
 * Pure — the screen's answer and the write's guard are the same function.
 */
function refusalOf(b) {
  if (!b) return { reason: "LABEL_UNKNOWN", message: "That label is not in this company's register." };
  const cm = b.customerMaterial || {};
  if (cm.lotId) {
    return {
      reason: "CUSTOMER_OWNED",
      message: `This is a customer-owned label${str(cm.goodsReceiptNumber) ? `, already on ${str(cm.goodsReceiptNumber)}` : ""}. Customer material is labelled from its own receipt.`,
    };
  }
  if (str(b.identityState) === IDENTITY_STATE.VOIDED || b.voidedAt) {
    return { reason: "LABEL_VOIDED", message: `This label was voided${str(b.voidReason) ? ` — ${str(b.voidReason)}` : ""}. It names nothing and cannot be linked.` };
  }
  if (b.goodsReceiptId) {
    const number = str(b.goodsReceiptNumber) || "a goods receipt";
    return {
      reason: "ALREADY_LINKED",
      message: b.grnLink?.linkedAt
        ? `Already linked to ${number}.`
        : `Already on ${number} — it was received on that receipt.`,
      linkedTo: { goodsReceiptId: idStr(b.goodsReceiptId), receiptNumber: str(b.goodsReceiptNumber), linkedHere: Boolean(b.grnLink?.linkedAt) },
    };
  }
  if (b.receivingSessionId || !isUsableIdentity(b)) {
    return {
      reason: "LABEL_IN_COUNT",
      message: `This label is in a receiving count${str(b.purchaseOrderNumber) ? ` on ${str(b.purchaseOrderNumber)}` : ""} that has not been recorded. Recording that receipt links it — it cannot be linked here.`,
    };
  }
  return null;
}

/**
 * The receipt lines a label may sit on: same material, and the label's variant
 * (a line with no variant takes any). A label with no variant is that
 * variant only where the receipt carries the material on ONE line — the rule
 * adoption and the store map already apply. Exact variants first. Pure.
 */
function candidateLines(grn, b) {
  const item = idStr(b.rawItem);
  const same = (grn?.lines || []).filter((l) => idStr(l.rawItemId) === item);
  if (!same.length) {
    return { lines: [], reason: "MATERIAL_NOT_ON_RECEIPT", message: `${str(b.rawItemName) || "This material"} is not on ${str(grn?.receiptNumber) || "this receipt"}.` };
  }
  const v = idStr(b.variantId);
  const exact = v ? same.filter((l) => idStr(l.variantId) === v) : [];
  const open = same.filter((l) => !l.variantId);
  let lines = [...exact, ...open];
  if (!lines.length && !v && same.length === 1) lines = same;
  if (!lines.length) {
    return {
      lines: [],
      reason: v ? "VARIANT_NOT_ON_RECEIPT" : "VARIANT_UNCLEAR",
      message: v
        ? `${str(grn?.receiptNumber) || "This receipt"} has ${str(b.rawItemName) || "this material"} only in another variant${variantText(b.variantCombination) ? ` — the label is ${variantText(b.variantCombination)}` : ""}.`
        : `The label names no variant and ${str(grn?.receiptNumber) || "this receipt"} has ${str(b.rawItemName) || "this material"} in ${same.length} variants, so the line cannot be told.`,
    };
  }
  return { lines, reason: null, message: "" };
}

/**
 * Where each label would go on one receipt, and what each line would then
 * carry. Pure: the preview the screen shows and the write that follows read
 * the same plan, so they cannot disagree.
 *
 * @param grn       the receipt (lean)
 * @param labels    linkable labels (lean)
 * @param labelled  Map(lineId → { count, byUnit: Map(unit → qty) }) already on the receipt
 */
function planLinks(grn, labels, labelled = new Map()) {
  const lineState = new Map();
  for (const l of grn?.lines || []) {
    const id = idStr(l._id);
    const before = labelled.get(id) || { count: 0, byUnit: new Map() };
    let labelledQty = 0;
    for (const [u, q] of before.byUnit || []) if (sameUnit(u, l.poUnit)) labelledQty += q;
    lineState.set(id, {
      lineId: id, itemName: str(l.itemName), variant: variantText(l.variantCombination), unit: str(l.poUnit),
      received: r4(l.receivedQuantity), labelledCount: before.count || 0, labelledQty: r4(labelledQty),
      addingCount: 0, addingQty: 0, addingOtherUnits: 0, overBy: 0,
    });
  }
  const rows = [];
  for (const b of labels) {
    const c = candidateLines(grn, b);
    if (!c.lines.length) {
      rows.push({ labelId: idStr(b._id), lineId: null, reason: c.reason, message: c.message, unitMatches: false });
      continue;
    }
    /* Several lines can carry the same material (a purchase order may list it
       twice at two prices): fill the one with room left first. */
    const room = (l) => { const s = lineState.get(idStr(l._id)); return s.received - s.labelledQty - s.addingQty; };
    const chosen = c.lines.find((l) => sameUnit(l.poUnit, b.unit) && room(l) > 0) || c.lines.find((l) => room(l) > 0) || c.lines[0];
    const s = lineState.get(idStr(chosen._id));
    const unitMatches = sameUnit(chosen.poUnit, b.unit) || sameUnit(chosen.baseUnit, b.unit);
    s.addingCount += 1;
    if (sameUnit(chosen.poUnit, b.unit)) s.addingQty = r4(s.addingQty + (Number(b.quantity) || 0));
    else s.addingOtherUnits += 1;
    rows.push({
      labelId: idStr(b._id), lineId: idStr(chosen._id), reason: null, unitMatches,
      message: unitMatches ? "" : `The label is in ${str(b.unit) || "no unit"} and this line was received in ${str(chosen.poUnit) || "another unit"}, so its quantity is not added to the line's labelled total.`,
    });
  }
  const lines = [];
  for (const s of lineState.values()) {
    if (!s.addingCount) continue;
    const total = r4(s.labelledQty + s.addingQty);
    s.overBy = total > s.received ? r4(total - s.received) : 0;
    lines.push(s);
  }
  const cautions = lines.filter((s) => s.overBy > 0).map((s) => (
    `With these, the labels on ${[s.itemName, s.variant].filter(Boolean).join(" · ") || "a line"} come to ${r4(s.labelledQty + s.addingQty)} ${s.unit}; the receipt received ${s.received} ${s.unit} (${s.overBy} ${s.unit} more). Linking is allowed — check the labels if that is not expected.`
  ));
  for (const r of rows) if (r.lineId && !r.unitMatches) cautions.push(r.message);
  return { rows, lines, cautions, linkable: rows.filter((r) => r.lineId).length };
}

/* ── READS ─────────────────────────────────────────────────────────────── */

function cleanIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = str(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > MAX_LABELS) {
    throw fail("VALIDATION", `Link at most ${MAX_LABELS} labels at a time.`, { reason: "TOO_MANY_LABELS", max: MAX_LABELS });
  }
  return out;
}

async function loadLabels(ctx, ids) {
  const valid = ids.filter(isId);
  if (!valid.length) return new Map();
  const docs = await Barcode.find({ $and: [tenantContext.tenantFilter(ctx), { _id: { $in: valid.map(oid) } }] }).lean();
  return new Map(docs.map((d) => [idStr(d._id), d]));
}

/** Live labels already on these receipts, per line and unit. */
async function labelledByLine(grnIds) {
  const out = new Map();
  if (!grnIds.length) return out;
  const rows = await Barcode.aggregate([
    { $match: { $and: [{ goodsReceiptId: { $in: grnIds.map(oid) } }, { voidedAt: null }, usableIdentity()] } },
    { $group: { _id: { grn: "$goodsReceiptId", line: "$goodsReceiptLineId", unit: { $ifNull: ["$unit", ""] } }, count: { $sum: 1 }, qty: { $sum: { $ifNull: ["$quantity", 0] } } } },
  ]);
  for (const r of rows) {
    const g = idStr(r._id.grn);
    if (!out.has(g)) out.set(g, new Map());
    const byLine = out.get(g);
    const line = idStr(r._id.line);
    if (!byLine.has(line)) byLine.set(line, { count: 0, byUnit: new Map() });
    const e = byLine.get(line);
    e.count += r.count;
    e.byUnit.set(str(r._id.unit), r4((e.byUnit.get(str(r._id.unit)) || 0) + r.qty));
  }
  return out;
}

/** A receipt as the dropdown and the scan page name it. */
function receiptSummary(g) {
  const kind = kindOf(g);
  const mr = g.materialRequest || {};
  return {
    goodsReceiptId: idStr(g._id),
    receiptNumber: str(g.receiptNumber),
    receiptDate: g.receiptDate || g.createdAt || null,
    kind,
    status: str(g.status) || "RECORDED",
    poNumber: kind === KIND.PURCHASE ? str(g.poNumber) : "",
    supplierName: kind === KIND.PURCHASE ? str(g.supplierName) : "",
    requestNumber: kind === KIND.MATERIAL_REQUEST ? str(mr.requestNumber || g.sourceDocumentNumber) : "",
    orderRef: kind === KIND.MATERIAL_REQUEST ? str(mr.orderRef) : kind === KIND.CUSTOMER ? str(g.customerMaterial?.orderRef) : "",
    customerName: kind === KIND.CUSTOMER ? str(g.customerMaterial?.customerLabel) : "",
    invoiceNumber: str(g.invoiceNumber),
    warehouseName: str(g.warehouseName),
    recordedBy: str(g.recordedBy?.name),
    href: grnHref(idStr(g._id)),
  };
}

/**
 * Step 1 and step 2 in one read: what each scanned label is and whether it can
 * be linked, and the recorded receipts that carry their materials, each with
 * the plan of what linking would do.
 */
async function check(ctx, { barcodeIds, goodsReceiptId = null } = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  const ids = cleanIds(barcodeIds);
  const docs = await loadLabels(ctx, ids);

  const labels = ids.map((id) => {
    if (!isId(id)) return { id, ok: false, reason: "NOT_A_LABEL", message: "That is not a raw-item label printed by GRAV.", label: null };
    const b = docs.get(id);
    const refusal = refusalOf(b);
    return {
      id,
      ok: !refusal,
      reason: refusal?.reason || null,
      message: refusal?.message || "",
      linkedTo: refusal?.linkedTo || null,
      label: b ? labelFacts(b) : null,
    };
  });

  const linkable = labels.filter((l) => l.ok).map((l) => docs.get(l.id));
  const choices = await receiptChoices(ctx, linkable, { focusId: goodsReceiptId });
  return {
    labels,
    counts: {
      scanned: labels.length,
      ready: linkable.length,
      alreadyLinked: labels.filter((l) => l.reason === "ALREADY_LINKED").length,
      refused: labels.filter((l) => !l.ok && l.reason !== "ALREADY_LINKED").length,
    },
    choices,
    limit: MAX_LABELS,
  };
}

async function receiptChoices(ctx, labels, { focusId = null } = {}) {
  const items = [...new Set(labels.map((b) => idStr(b.rawItem)).filter(isId))];
  const scope = (extra) => ({ $and: [tenantContext.tenantFilter(ctx), { sourceType: { $in: LINKABLE_SOURCES }, status: { $ne: "VOID" } }, extra] });
  let grns = items.length
    ? await GoodsReceipt.find(scope({ "lines.rawItemId": { $in: items.map(oid) } })).sort({ receiptDate: -1, _id: -1 }).limit(MAX_CHOICES).lean()
    : [];
  /* The receipt a person came here FROM (the GRN page's "Link labels") is
     always offered, even when nothing scanned is on it yet — the plan then
     says so instead of the receipt silently missing from the list. */
  if (isId(focusId) && !grns.some((g) => idStr(g._id) === str(focusId))) {
    const focus = await GoodsReceipt.findOne(scope({ _id: oid(focusId) })).lean();
    if (focus) grns = [focus, ...grns];
  }
  const labelled = await labelledByLine(grns.map((g) => idStr(g._id)));
  const out = grns.map((g) => {
    const plan = planLinks(g, labels, labelled.get(idStr(g._id)) || new Map());
    return {
      ...receiptSummary(g),
      matching: plan.linkable,
      notOnReceipt: labels.length - plan.linkable,
      plan,
      materials: [...new Set((g.lines || []).map((l) => [str(l.itemName), variantText(l.variantCombination)].filter(Boolean).join(" · ")).filter(Boolean))].slice(0, 6),
    };
  });
  /* The receipts that take the most of this batch first; newest among equals. */
  out.sort((a, b) => (b.matching - a.matching) || (new Date(b.receiptDate || 0) - new Date(a.receiptDate || 0)));
  return out;
}

/* ── THE WRITE ─────────────────────────────────────────────────────────── */

/**
 * Link the scanned labels to one recorded receipt. Labels that cannot go on it
 * are answered one by one and left exactly as they were; the rest are linked
 * in one unit of work with one history entry on the receipt.
 */
async function link(ctx, { goodsReceiptId, barcodeIds } = {}, actor = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!isId(goodsReceiptId)) throw fail("VALIDATION", "Choose the goods receipt to link the labels to.", { reason: "NO_RECEIPT" });
  const ids = cleanIds(barcodeIds);
  if (!ids.length) throw fail("VALIDATION", "Scan at least one label first.", { reason: "NO_LABELS" });

  const grn = await GoodsReceipt.findOne({ $and: [tenantContext.tenantFilter(ctx), { _id: oid(goodsReceiptId) }] }).lean();
  if (!grn) throw fail("NOT_FOUND", "That goods receipt was not found.");
  if (str(grn.status) === "VOID") {
    throw fail("LIFECYCLE_BLOCKED", `${str(grn.receiptNumber)} was voided, so nothing can be linked to it.`, { reason: "RECEIPT_VOID" });
  }
  if (!LINKABLE_SOURCES.includes(grn.sourceType)) {
    throw fail("VALIDATION",
      `${str(grn.receiptNumber)} is a customer-owned delivery. Its lots are labelled from that receipt, with the customer on the sticker — a company label cannot be linked to it.`,
      { reason: "CUSTOMER_RECEIPT" });
  }

  const docs = await loadLabels(ctx, ids);
  const results = [];
  const linkable = [];
  for (const id of ids) {
    if (!isId(id)) { results.push({ id, outcome: "refused", reason: "NOT_A_LABEL", message: "That is not a raw-item label printed by GRAV." }); continue; }
    const b = docs.get(id);
    const refusal = refusalOf(b);
    if (refusal?.reason === "ALREADY_LINKED" && refusal.linkedTo?.goodsReceiptId === idStr(grn._id)) {
      results.push({ id, outcome: "already", reason: "ALREADY_ON_THIS_RECEIPT", message: `Already on ${str(grn.receiptNumber)}.`, label: labelFacts(b) });
      continue;
    }
    if (refusal) { results.push({ id, outcome: "refused", ...refusal, label: b ? labelFacts(b) : null }); continue; }
    linkable.push(b);
  }

  const plan = planLinks(grn, linkable, (await labelledByLine([idStr(grn._id)])).get(idStr(grn._id)) || new Map());
  const lineById = new Map((grn.lines || []).map((l) => [idStr(l._id), l]));
  const poItems = new Map();
  let poVendor = null;
  if (grn.sourceType === SOURCE_TYPE.PURCHASE_ORDER && grn.purchaseOrderId) {
    const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId }).select("vendor vendorName items").lean();
    for (const i of po?.items || []) poItems.set(idStr(i._id), i);
    poVendor = po?.vendor || null;
  }

  const now = new Date();
  const byId = new Map(linkable.map((b) => [idStr(b._id), b]));
  const toWrite = [];
  for (const row of plan.rows) {
    const b = byId.get(row.labelId);
    if (!row.lineId) { results.push({ id: row.labelId, outcome: "refused", reason: row.reason, message: row.message, label: labelFacts(b) }); continue; }
    const line = lineById.get(row.lineId);
    const set = {
      goodsReceiptId: grn._id,
      goodsReceiptNumber: str(grn.receiptNumber),
      goodsReceiptLineId: line._id,
      grnLink: {
        linkedAt: now,
        linkedBy: isId(actor.id) ? oid(actor.id) : null,
        linkedByName: str(actor.name),
        previous: {
          purchaseOrder: b.purchaseOrder || null,
          purchaseOrderNumber: str(b.purchaseOrderNumber),
          purchaseOrderItemId: b.purchaseOrderItemId || null,
          vendor: b.vendor || null,
          vendorName: str(b.vendorName),
          unitPrice: b.unitPrice ?? null,
        },
      },
    };
    /* A label that predates company stamping takes this company now, as
       adoption does — it is this company's receipt it is joining. */
    if (!b.companyId) set.companyId = ctx.companyId;
    /* A purchase receipt's label names the order, its line, the supplier and
       the price — what POST /barcodes writes on a label printed at the
       receipt. The price is the order line's, and only where the label is in
       that line's unit: a price per metre on a label counted in pieces would
       value it wrongly. */
    if (grn.sourceType === SOURCE_TYPE.PURCHASE_ORDER) {
      const poLine = poItems.get(idStr(line.poItemId)) || null;
      set.purchaseOrder = grn.purchaseOrderId || null;
      set.purchaseOrderNumber = str(grn.poNumber);
      set.purchaseOrderItemId = line.poItemId || null;
      set.vendor = grn.supplierId || poVendor || null;
      set.vendorName = str(grn.supplierName);
      if (poLine && Number.isFinite(Number(poLine.unitPrice)) && sameUnit(poLine.unit || line.poUnit, b.unit)) {
        set.unitPrice = Number(poLine.unitPrice);
      }
    }
    toWrite.push({ b, line, row, set });
  }

  let linked = [];
  if (toWrite.length) {
    const out = await unitOfWork.run(ctx, {
      mutate: async (session) => {
        /* Re-run whole on a transaction retry, so the answer is rebuilt each
           attempt rather than appended to. */
        const done = [];
        const opts = session ? { session } : {};
        for (const w of toWrite) {
          const r = await Barcode.updateOne(
            { $and: [
              { _id: w.b._id, goodsReceiptId: null, receivingSessionId: null, voidedAt: null, "customerMaterial.lotId": null },
              usableIdentity(),
            ] },
            { $set: w.set },
            opts,
          );
          done.push({ w, written: r.modifiedCount === 1 });
        }
        const written = done.filter((d) => d.written);
        return {
          entityType: ENTITY, entityId: grn._id, result: done,
          entry: {
            entityType: ENTITY, entityId: grn._id, documentNumber: str(grn.receiptNumber),
            action: written.length ? "LABELS_LINKED" : "LABELS_LINK_REFUSED",
            metadata: {
              labels: written.length,
              barcodeIds: written.map((d) => idStr(d.w.b._id)),
              lines: [...new Set(written.map((d) => idStr(d.w.line._id)))].length,
              note: "Printed labels linked to this recorded receipt afterwards. No stock moved.",
            },
          },
        };
      },
    });
    for (const d of out.result) {
      const label = labelFacts(d.w.b);
      if (d.written) {
        linked.push(d.w.b._id);
        results.push({
          id: label.id, outcome: "linked", label,
          line: { lineId: idStr(d.w.line._id), itemName: str(d.w.line.itemName), variant: variantText(d.w.line.variantCombination), unit: str(d.w.line.poUnit) },
          message: d.w.row.message || "",
        });
      } else {
        results.push({ id: label.id, outcome: "refused", reason: "LABEL_CHANGED", message: "That label changed a moment ago (linked, voided or counted elsewhere). Scan it again to see where it stands.", label });
      }
    }
  }

  /* In the order the labels were scanned. */
  const order = new Map(ids.map((id, i) => [id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    receipt: receiptSummary(grn),
    linked: results.filter((r) => r.outcome === "linked").length,
    already: results.filter((r) => r.outcome === "already").length,
    refused: results.filter((r) => r.outcome === "refused").length,
    cautions: plan.cautions,
    results,
  };
}

/**
 * Take back a link made on this screen: the label returns to exactly what it
 * carried before. Refused for a label received AT its receipt (that is the
 * receipt's own record), and once QC has checked the label against the
 * receipt — the verdict would otherwise lose the delivery it was given for.
 */
async function unlink(ctx, { barcodeId } = {}, actor = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!isId(barcodeId)) throw fail("VALIDATION", "That is not a raw-item label printed by GRAV.", { reason: "NOT_A_LABEL" });
  const b = await Barcode.findOne({ $and: [tenantContext.tenantFilter(ctx), { _id: oid(barcodeId) }] }).lean();
  if (!b) throw fail("NOT_FOUND", "That label is not in this company's register.", { reason: "LABEL_UNKNOWN" });
  if (!b.goodsReceiptId) throw fail("CONFLICT", "That label is not linked to a goods receipt.", { reason: "NOT_LINKED" });
  if (!b.grnLink?.linkedAt) {
    throw fail("CONFLICT",
      `That label was received on ${str(b.goodsReceiptNumber) || "its goods receipt"} when the receipt was recorded (or linked by QC while checking it), not linked here — so it is not undone here.`,
      { reason: "NOT_LINKED_HERE" });
  }
  const QCRawItemInspection = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");
  const checked = await QCRawItemInspection.exists({ barcodeId: b._id, goodsReceiptId: b.goodsReceiptId, superseded: { $ne: true } });
  if (checked) {
    throw fail("CONFLICT",
      `QC has already checked this label against ${str(b.goodsReceiptNumber)}. Unlinking it would separate that verdict from its receipt, so the link stays.`,
      { reason: "QC_CHECKED" });
  }

  const prev = b.grnLink.previous || {};
  const grnId = b.goodsReceiptId;
  const number = str(b.goodsReceiptNumber);
  await unitOfWork.run(ctx, {
    mutate: async (session) => {
      const r = await Barcode.updateOne(
        { _id: b._id, goodsReceiptId: grnId, "grnLink.linkedAt": b.grnLink.linkedAt },
        { $set: {
          goodsReceiptId: null, goodsReceiptNumber: "", goodsReceiptLineId: null,
          purchaseOrder: prev.purchaseOrder || null, purchaseOrderNumber: str(prev.purchaseOrderNumber),
          purchaseOrderItemId: prev.purchaseOrderItemId || null,
          vendor: prev.vendor || null, vendorName: str(prev.vendorName),
          unitPrice: prev.unitPrice ?? null,
          grnLink: null,
        } },
        session ? { session } : {},
      );
      if (r.modifiedCount !== 1) throw fail("CONFLICT", "That label changed a moment ago. Scan it again to see where it stands.", { reason: "LABEL_CHANGED" });
      return {
        entityType: ENTITY, entityId: grnId, result: true,
        entry: {
          entityType: ENTITY, entityId: grnId, documentNumber: number, action: "LABEL_UNLINKED",
          metadata: { barcodeId: idStr(b._id), by: str(actor.name), note: "A label linked here afterwards was taken off this receipt. No stock moved." },
        },
      };
    },
  });
  const after = await Barcode.findById(b._id).lean();
  return { label: labelFacts(after), unlinkedFrom: { goodsReceiptId: idStr(grnId), receiptNumber: number } };
}

/**
 * The receipt a scanned label belongs to, for the scan page — or null for a
 * label printed from stock on hand that nobody has linked.
 */
async function receiptOfLabel(ctx, b) {
  if (!b?.goodsReceiptId || b?.customerMaterial?.lotId) return null;
  const g = await GoodsReceipt.findOne({ $and: [tenantContext.tenantFilter(ctx), { _id: b.goodsReceiptId }] }).lean().catch(() => null);
  if (!g) {
    return { goodsReceiptId: idStr(b.goodsReceiptId), receiptNumber: str(b.goodsReceiptNumber), missing: true, href: null, line: null, linkedLater: null };
  }
  const line = (g.lines || []).find((l) => idStr(l._id) === idStr(b.goodsReceiptLineId)) || null;
  return {
    ...receiptSummary(g),
    line: line ? {
      lineId: idStr(line._id), itemName: str(line.itemName), variant: variantText(line.variantCombination),
      unit: str(line.poUnit), received: r4(line.receivedQuantity),
    } : null,
    linkedLater: b.grnLink?.linkedAt ? { at: b.grnLink.linkedAt, byName: str(b.grnLink.linkedByName) } : null,
  };
}

module.exports = {
  MAX_LABELS,
  LINKABLE_SOURCES,
  refusalOf,
  candidateLines,
  planLinks,
  check,
  link,
  unlink,
  receiptOfLabel,
};
