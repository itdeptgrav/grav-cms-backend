// routes/CMS_Routes/Manufacturing/QC/qcIdentifyRoutes.js
//
// ONE ENDPOINT THAT SAYS WHAT WAS SCANNED — the hinge of the unified Inspect
// screen.
//
// ── WHY THE SERVER DECIDES ─────────────────────────────────────────────────
// QC used to ask the person which book they were working in before they could
// scan: one navigation entry for garment pieces, another for raw materials, and
// each screen able to read only its own format. The scanner already knows — a
// `WO-…` code cannot be a fabric roll and a 24-hex Barcode id cannot be a
// garment unit — so the question was one the input had already answered.
//
// The client may (and does) classify the same value locally for instant feedback
// and for working offline, but this endpoint is authoritative. Three reasons the
// client's answer is not enough:
//
//   1. A FORMAT MATCH IS NOT AN EXISTENCE PROOF. `itemid=<24 hex>` is a
//      well-formed label id for a label that may never have been printed.
//   2. PERMISSION IS NOT A CLIENT CONCERN. A raw-only checker scanning a garment
//      piece must be refused by the server, in words, whatever their bundle
//      believes about itself.
//   3. THE ORDER CANNOT BE RESOLVED IN THE BROWSER. Which manufacturing order a
//      roll of cloth belongs to is a join across work orders, receipts and
//      standing verdicts.
//
// ── MOUNTED BEFORE qcRoutes, LIKE THE ASSISTANT ────────────────────────────
// Both share the `/api/cms/manufacturing/qc` prefix, and a route added to
// qcRoutes on this path later would otherwise shadow this one silently. See the
// note above the assistant's mount in server.js.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const { verifyCmsToken, readToken } = require("../../../../config/jwt");
const { resolveQcActor, mayInspect } = require("../../../../services/manufacturing/qcActor");
const { findWorkOrderByShortId } = require("../../../../services/manufacturing/workOrderShortId");
const { classifyQcBarcode } = require("../../../../services/manufacturing/qcBarcodeIdentity");
const qcOrders = require("../../../../services/manufacturing/qcRawItemOrders");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const QCRawItemInspection = require("../../../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();

/* Same auth the raw-item router carries: self-contained, so this endpoint does
   not depend on which global middleware happens to run before it. */
function qcAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Please sign in." });
  let decoded = null;
  try { decoded = verifyCmsToken(token); } catch { decoded = null; }
  if (!decoded) return res.status(401).json({ success: false, message: "Your session has expired. Sign in again." });
  req.qcUser = {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    role: decoded.role,
    isAdmin: Boolean(decoded.isAdmin),
    employeeId: decoded.employeeId || "",
  };
  next();
}

/**
 * POST /api/cms/manufacturing/qc/identify-barcode  { barcode }
 *
 * Always 200 for a readable request — including for an unrecognised barcode and
 * for a barcode the caller may not inspect. Both are ANSWERS, not failures: the
 * station has to keep the scanned value on screen and say what happened, and a
 * 4xx would have it render a network error instead.
 *
 * The one 4xx is an empty body, which is a caller bug rather than a scan.
 */
router.post("/identify-barcode", qcAuth, async (req, res) => {
  try {
    const raw = str(req.body?.barcode);
    if (!raw) return res.status(400).json({ success: false, message: "barcode is required" });

    const [actor, id] = await Promise.all([resolveQcActor(req), Promise.resolve(classifyQcBarcode(raw))]);

    const base = {
      success: true,
      type: id.type,
      normalizedBarcode: id.normalizedBarcode,
      scanned: id.scanned,
      /* What the person may do at all, so the screen can offer the right
         fallback — "you check raw materials, scan one of those instead". */
      capabilities: { productCheck: actor.productCheck, rawCheck: actor.rawCheck, owner: actor.owner },
    };

    /* ── NOT A QC BARCODE ───────────────────────────────────────────────────
       The value stays on screen and the reason is named where it can be. */
    if (id.type === "unknown") {
      return res.json({
        ...base,
        context: null,
        message: id.refusal
          || "This barcode is not recognized as a garment piece or a raw-material label.",
      });
    }

    /* ── RECOGNISED, BUT NOT THIS PERSON'S TO INSPECT ──────────────────────
       The TYPE is reported — the person needs to know the scanner read the
       label correctly and that the refusal is about them, not about it — and no
       CONTEXT is. A garment-only inspector must not receive a roll's supplier,
       quantity and order list merely because they scanned it. */
    const may = mayInspect(actor, id.type);
    if (!may.permitted) {
      return res.json({ ...base, permitted: false, code: may.code, context: null, message: may.message });
    }

    if (id.type === "garment_piece") {
      /* Deliberately thin. `/lookup-piece` does the real work — the operations
         catalogue, the checkpoint guards, the piece's history — and duplicating
         any of it here would be a second opinion about the same piece. What is
         worth one cheap query is whether the work order exists at all, so a
         mistyped short id is reported as a bad barcode rather than opening an
         empty inspection form. */
      /* ── THE SHORT ID IS DERIVED FROM `_id`, NOT STORED ──────────────────
         This was `WorkOrder.findOne({ workOrderShortId })` against a path that
         is on NO document — `WorkOrder.js` has no such field — so every garment
         scanned here came back "no work order on record", for every work order,
         while `/lookup-piece` opened the same label correctly from the same
         string a moment later. One rule now, in the service, shared with that
         lookup. See services/manufacturing/workOrderShortId.js. */
      const wo = await findWorkOrderByShortId(id.parsed.workOrderShortId, {
        project: { _id: 1, workOrderNumber: 1, stockItemName: 1, quantity: 1, status: 1 },
      }).catch(() => null);

      if (!wo) {
        return res.json({
          ...base,
          permitted: true,
          context: { ...id.parsed, exists: false },
          message: `No work order ${id.parsed.workOrderShortId} is on record. Check the number on the label.`,
        });
      }
      const outOfRange = wo.quantity > 0 && id.parsed.unitNumber > wo.quantity;
      return res.json({
        ...base,
        permitted: true,
        context: {
          ...id.parsed,
          exists: true,
          workOrderId: String(wo._id),
          workOrderNumber: str(wo.workOrderNumber),
          productName: str(wo.stockItemName),
          quantity: wo.quantity || 0,
          status: str(wo.status),
          /* Said, not refused: the station's own lookup is the authority on
             whether a unit may be inspected, and a label printed beyond the
             work order's quantity is a real thing that happens when a quantity
             is revised down. */
          unitOutOfRange: outOfRange,
        },
        message: null,
      });
    }

    /* ── RAW MATERIAL ──────────────────────────────────────────────────────── */
    const b = await Barcode.findById(id.normalizedBarcode).lean().catch(() => null);
    if (!b) {
      return res.json({
        ...base,
        permitted: true,
        context: null,
        message: "That is a raw-material label, but no raw item with that label is on record. It may never have been printed, or it may belong to another company.",
      });
    }

    const [resolution, priors] = await Promise.all([
      qcOrders.resolveOrdersForLabel(b),
      QCRawItemInspection.find({ barcodeId: b._id, superseded: { $ne: true } })
        .select("moNumber manufacturingOrderId status passedQuantity defectiveQuantity inspectedAt inspectedByName")
        .lean(),
    ]);
    const src = qcOrders.labelSource(b);

    const warnings = [];
    if (!(b.quantity > 0)) warnings.push("This label shows no quantity left — it was used up.");
    if (priors.length) {
      warnings.push(
        `Already checked on ${priors.map((p) => p.moNumber || "an order").join(", ")}. Checking it again replaces that verdict.`,
      );
    }

    return res.json({
      ...base,
      permitted: true,
      context: {
        barcodeId: String(b._id),
        rawItemId: b.rawItem ? String(b.rawItem) : null,
        rawItemName: str(b.rawItemName) || "—",
        rawItemSku: str(b.rawItemSku),
        variantId: b.variantId ? String(b.variantId) : null,
        variantLabel: (b.variantCombination || []).join(" · "),
        variantSku: str(b.variantSku),
        quantity: r4(b.quantity),
        unit: str(b.unit),
        /* ── PROVENANCE, AS CONTEXT AND NOT AS A GATE ───────────────────────
           Who owns this material and where it came from. The checker sees it;
           nothing here decides whether they may inspect it. */
        ...src,
        vendorName: str(b.vendorName),
        purchaseOrderNumber: str(b.purchaseOrderNumber),
        goodsReceiptNumber: str(b.goodsReceiptNumber) || str(b.customerMaterial?.goodsReceiptNumber),
        customerOrderRef: str(b.customerMaterial?.orderRef),
        customerLabel: str(b.customerMaterial?.customerLabel),
        printedAt: b.createdAt || null,
      },
      orders: resolution.candidates,
      orderResolution: resolution.resolution,
      orderReason: resolution.reason,
      priors: priors.map((p) => ({
        manufacturingOrderId: String(p.manufacturingOrderId),
        moNumber: str(p.moNumber),
        status: str(p.status),
        passedQuantity: r4(p.passedQuantity),
        defectiveQuantity: r4(p.defectiveQuantity),
        inspectedAt: p.inspectedAt,
        inspectedByName: str(p.inspectedByName),
      })),
      warnings,
      message: null,
    });
  } catch (err) {
    console.error("[qc identify-barcode]", err);
    res.status(500).json({ success: false, message: "Could not identify that barcode. Try again." });
  }
});

module.exports = router;
