// routes/CMS_Routes/Inventory/Operations/barcodes.js
//
// Mount in server.js:
//   const barcodeRoutes = require("./routes/CMS_Routes/Inventory/Operations/barcodes");
//   app.use("/api/cms/inventory/barcodes", barcodeRoutes);

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { identityRefusal } = require("../../../../services/storePurchase/labelIdentity");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");

router.use(EmployeeAuthMiddleware);

/* ── WHY TENANCY ARRIVED LATE, AND WHY IT HAD TO ─────────────────────────────
 * This router was written when a label disclosed nothing about anybody else, so
 * it carried authentication and no company scope: creation stamped no
 * `companyId`, the list returned every company's labels, and a material or
 * purchase order could be named by id from any company at all.
 *
 * Customer-owned labels closed half of that — a scan of one is refused across
 * companies — but only for those, and only on read. The other half is the write
 * path: a label is a claim about somebody's material, carrying their supplier,
 * their order and their prices, and nothing stopped one company minting labels
 * against another's purchase order.
 *
 * `requireTenant` is the same middleware every other Store router uses, so the
 * company is resolved the one way rather than a second way invented here. Reads
 * stay deliberately permissive about labels that predate this (`companyId:
 * null`), because refusing them would stop every existing sticker scanning —
 * writes are where the scope is enforced.
 */
router.use(requireTenant);

/* A filter that matches this company's labels and the unowned ones that predate
   company stamping. Folded into `$and` rather than assigned as `$or`, because
   `tenantFilter` may itself be an `$or` under legacy read-through and assigning
   over it would silently drop the company scope. */
const scopedToCompany = (req, extra = {}) => {
  const companyId = req.tenant?.companyId || null;
  return {
    $and: [
      extra,
      { $or: [{ companyId }, { companyId: null }, { companyId: { $exists: false } }] },
    ],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /suggested-units/:rawItemId
//
// Returns the units to suggest for printing.
// Logic: take the raw item's registered unit, then find every Unit that has
// a CONVERSION relationship with it — in EITHER direction. We don't care
// about parent/child; if there's any conversion link, it's a suggestion.
//
// Response: {
//   success, registeredUnit, suggestedUnits: [{_id, name}], allUnits: [...]
// }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suggested-units/:rawItemId", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.rawItemId)
      .select("name unit customUnit")
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const registeredUnitName = rawItem.customUnit || rawItem.unit || "";

    // Always include all active units so the user can pick anything
    const allUnits = await Unit.find({ status: "Active" })
      .select("_id name conversions")
      .populate("conversions.toUnit", "_id name")
      .lean();

    const suggestedIds = new Set();

    // Find the registered Unit document
    const registeredUnitDoc = allUnits.find(u => u.name === registeredUnitName);

    if (registeredUnitDoc) {
      // ALWAYS suggest the registered unit itself first
      suggestedIds.add(registeredUnitDoc._id.toString());

      // 1. Forward direction: any unit registeredUnit converts TO
      (registeredUnitDoc.conversions || []).forEach(c => {
        if (c.toUnit?._id) suggestedIds.add(c.toUnit._id.toString());
      });

      // 2. Reverse direction: any unit that converts TO registeredUnit
      allUnits.forEach(u => {
        const hasReverse = (u.conversions || []).some(
          c => c.toUnit?._id?.toString() === registeredUnitDoc._id.toString()
        );
        if (hasReverse) suggestedIds.add(u._id.toString());
      });
    }

    const suggestedUnits = allUnits
      .filter(u => suggestedIds.has(u._id.toString()))
      .map(u => ({ _id: u._id, name: u.name }));

    const allUnitsList = allUnits.map(u => ({ _id: u._id, name: u.name }));

    return res.json({
      success: true,
      registeredUnit: registeredUnitName,
      suggestedUnits,
      allUnits: allUnitsList
    });
  } catch (error) {
    console.error("Error fetching suggested units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// Body: { rawItemId, variantId?, quantity, unitId | unitName,
//         purchaseOrderId?, purchaseOrderItemId? }
// Creates one Barcode document. The returned _id is what gets QR-encoded.
//
// Two callers, two ways of naming the unit. Product Marking picks a Unit from a
// dropdown and sends `unitId`; goods-receipt only ever knows the unit as the
// string already on the PO line, so `unitName` is accepted as well. Exactly one
// is required.
//
// When `purchaseOrderItemId` is supplied the vendor and the purchase price are
// read off the PO line here rather than taken from the request. A price is a
// financial fact about a delivery and the client has no business asserting it.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      rawItemId, variantId, quantity, unitId, unitName,
      purchaseOrderId, purchaseOrderItemId,
      /* ── ONE PRINT RUN, HOWEVER MANY TIMES IT IS SENT ──────────────────
         `labelCount` makes the run one request instead of N, so a browser that
         dies halfway cannot leave a half-minted batch nobody knows the size of.
         `printBatchKey` is the client's stable intent for that run: pressing
         Print again with the same key RETURNS the same labels rather than
         minting a second set of identities for the same physical rolls. */
      labelCount, printBatchKey,
      goodsReceiptId, goodsReceiptLineId,
    } = req.body;

    const companyId = req.tenant?.companyId || null;
    const batchKey = String(printBatchKey || "").trim();
    const count = labelCount === undefined ? 1 : Number(labelCount);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return res.status(400).json({ success: false, message: "Number of labels must be a whole number between 1 and 100." });
    }

    /* ── A RETRY IS ANSWERED, NOT RE-RUN ────────────────────────────────────
       Before any validation, because the retry of a run that already succeeded
       must not be able to fail on a material that has since been edited. */
    if (batchKey) {
      const existing = await Barcode.find({ companyId, printBatchKey: batchKey })
        .sort({ printBatchSeq: 1 }).lean();
      if (existing.length >= count) {
        return res.json({
          success: true, barcodes: existing.slice(0, count), reused: true,
          message: "These labels were already created — the same ones are returned.",
        });
      }
    }

    if (!rawItemId || !mongoose.Types.ObjectId.isValid(rawItemId)) {
      return res.status(400).json({ success: false, message: "Valid rawItemId is required" });
    }
    if (!quantity || parseFloat(quantity) <= 0) {
      return res.status(400).json({ success: false, message: "Quantity must be > 0" });
    }
    if (!unitId && !unitName) {
      return res.status(400).json({ success: false, message: "A unit is required" });
    }
    if (unitId && !mongoose.Types.ObjectId.isValid(unitId)) {
      return res.status(400).json({ success: false, message: "Valid unit is required" });
    }

    const [rawItem, unit] = await Promise.all([
      /* Company-scoped: naming another company's material by id must not
         mint a label carrying their item, their SKU and their variants. */
      RawItem.findOne(scopedToCompany(req, { _id: rawItemId }))
        .select("name sku variants unit customUnit").lean(),
      unitId ? Unit.findById(unitId).select("name").lean() : Promise.resolve(null)
    ]);

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });
    if (unitId && !unit) return res.status(404).json({ success: false, message: "Unit not found" });

    // A name is taken as given — the PO line it came from is the authority on
    // what unit the goods were bought in, and it may legitimately be a unit
    // that was never registered in the Unit collection.
    const resolvedUnitName = unit ? unit.name : String(unitName).trim();
    if (!resolvedUnitName) {
      return res.status(400).json({ success: false, message: "A unit is required" });
    }

    // Resolve variant info if specified
    let variantCombination = [];
    let variantSku = "";
    let resolvedVariantId = null;

    if (variantId && mongoose.Types.ObjectId.isValid(variantId)) {
      const variant = (rawItem.variants || []).find(
        v => v._id.toString() === variantId.toString()
      );
      if (!variant) {
        return res.status(404).json({ success: false, message: "Variant not found on raw item" });
      }
      resolvedVariantId = variant._id;
      variantCombination = variant.combination || [];
      variantSku = variant.sku || "";
    }

    // Optional PO, and with it the provenance of this lot.
    let resolvedPoId = null;
    let poNumber = "";
    let resolvedPoItemId = null;
    let vendorId = null;
    let vendorName = "";
    let unitPrice = null;

    if (purchaseOrderId && mongoose.Types.ObjectId.isValid(purchaseOrderId)) {
      /* Likewise: a label carrying another company's order number, supplier
         and unit price would put their commercial terms on our sticker. */
      const po = await PurchaseOrder.findOne(scopedToCompany(req, { _id: purchaseOrderId }))
        .select("poNumber vendor vendorName items")
        .populate("vendor", "companyName")
        .lean();
      if (po) {
        resolvedPoId = po._id;
        poNumber = po.poNumber || "";
        vendorId = po.vendor?._id || po.vendor || null;
        vendorName = po.vendor?.companyName || po.vendorName || "";

        // The price belongs to a line, not to the order. Match the requested
        // line when one was given; otherwise fall back to the line for this
        // raw item and variant, which is unambiguous in the ordinary case
        // where a PO lists each item once.
        const items = po.items || [];
        const line =
          (purchaseOrderItemId &&
            mongoose.Types.ObjectId.isValid(purchaseOrderItemId) &&
            items.find((i) => String(i._id) === String(purchaseOrderItemId))) ||
          items.find(
            (i) =>
              String(i.rawItem) === String(rawItem._id) &&
              String(i.variantId || "") === String(resolvedVariantId || "")
          ) ||
          null;

        if (line) {
          resolvedPoItemId = line._id;
          unitPrice = Number.isFinite(Number(line.unitPrice))
            ? Number(line.unitPrice)
            : null;
        }
      }
    }

    /* ── THE ARRIVAL, WHEN THE LABEL WAS PRINTED FROM ONE ─────────────────
       Read under the company scope like everything else, and only accepted
       when the receipt actually names this material — a label must not be able
       to claim a delivery that did not contain what it is stuck to. */
    let receiptId = null, receiptNumber = "", receiptLineId = null;
    if (goodsReceiptId && mongoose.Types.ObjectId.isValid(goodsReceiptId)) {
      const gr = await GoodsReceipt.findOne({ _id: goodsReceiptId, companyId })
        .select("receiptNumber lines").lean();
      if (!gr) {
        return res.status(404).json({ success: false, message: "That goods receipt was not found." });
      }
      const line = (gr.lines || []).find((l) => (
        goodsReceiptLineId && mongoose.Types.ObjectId.isValid(goodsReceiptLineId)
          ? String(l._id) === String(goodsReceiptLineId)
          : String(l.rawItemId || "") === String(rawItem._id)
      ));
      if (!line) {
        return res.status(400).json({
          success: false,
          message: "That receipt does not have a line for this material, so a label cannot claim it.",
        });
      }
      receiptId = gr._id;
      receiptNumber = gr.receiptNumber || "";
      receiptLineId = line._id;
    }

    const base = {
      companyId,
      rawItem: rawItem._id,
      rawItemName: rawItem.name,
      rawItemSku: rawItem.sku,
      variantId: resolvedVariantId,
      variantCombination,
      variantSku,
      quantity: parseFloat(quantity),
      unit: resolvedUnitName,
      purchaseOrder: resolvedPoId,
      purchaseOrderNumber: poNumber,
      purchaseOrderItemId: resolvedPoItemId,
      vendor: vendorId,
      vendorName,
      unitPrice,
      goodsReceiptId: receiptId,
      goodsReceiptNumber: receiptNumber,
      goodsReceiptLineId: receiptLineId,
      generatedBy: req.user?.id || req.user?._id || null,
    };

    /* ── EACH PHYSICAL ROLL GETS ITS OWN IDENTITY ─────────────────────────
       Five rolls are five documents, never one document printed five times:
       two stickers sharing an id cannot be told apart on the floor, and the
       whole point of a label is that it names ONE physical thing.

       Positions are 1..count under the batch key, and the unique partial index
       on (companyId, printBatchKey, printBatchSeq) is what makes a concurrent
       second press collide rather than duplicate. */
    const docs = Array.from({ length: count }, (_, i) => ({
      ...base,
      ...(batchKey ? { printBatchKey: batchKey, printBatchSeq: i + 1 } : {}),
    }));

    let barcodes;
    try {
      barcodes = await Barcode.insertMany(docs, { ordered: true });
    } catch (e) {
      /* A duplicate key means another press of the same run got there first.
         Its labels are the answer — this one mints nothing. */
      if (batchKey && (e?.code === 11000 || e?.writeErrors?.some((w) => w?.code === 11000))) {
        const settled = await Barcode.find({ companyId, printBatchKey: batchKey })
          .sort({ printBatchSeq: 1 }).lean();
        if (settled.length) {
          return res.json({
            success: true, barcodes: settled, reused: true,
            message: "These labels were already created — the same ones are returned.",
          });
        }
      }
      throw e;
    }

    return res.json({
      success: true,
      barcodes,
      /* Kept so the existing single-label callers, which read `barcode`, are
         untouched by this becoming a batch. */
      barcode: barcodes[0],
    });
  } catch (error) {
    console.error("Error creating barcode:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id   — lookup a single barcode (this is what a scan resolves to)
//
// Returns everything the Item Info screen shows, so a scan is one request:
// the label's own facts, the raw item and variant behind it, and the purchase
// it arrived on. Dates come from two different places on purpose — `orderDate`
// is when it was bought, the barcode's own `createdAt` is when it was received
// and labelled, and a delivery can be weeks after an order.
// ─────────────────────────────────────────────────────────────────────────────
/* ── WHAT THE PRINTED LABELS OF A MATERIAL ADD UP TO (30 Sep 2026) ────────
   The material page shows, beside its stock position, the quantity carried by
   the raw-item labels printed for that material — the owner's request: "the
   total available qty as per the generated raw item barcode". It is NOT a
   stock figure: a label is an identity somebody printed, its quantity is what
   was typed or measured when it was printed, and a sticker that was never
   applied still counts here. So the answer is split the way the register is:
   LIVE labels (ACTIVATED, or pre-dating identity states), labels inside an
   open receiving count (reserved / printed / applied — not live until that
   receipt is recorded), and voided ones, which are named but never summed.
   Declared above `/:id` so the literal path wins. */
router.get("/summary", async (req, res) => {
  try {
    const { rawItemId } = req.query;
    if (!rawItemId || !mongoose.Types.ObjectId.isValid(rawItemId)) {
      return res.status(400).json({ success: false, message: "Valid rawItemId is required" });
    }
    const filter = scopedToCompany(req, { rawItem: rawItemId });
    const rows = await Barcode.find(filter)
      .select("variantId variantCombination unit quantity identityState receivingSessionId goodsReceiptId voidedAt")
      .lean();

    const bucketOf = (b) => {
      const st = String(b.identityState || "ACTIVATED");
      if (st === "VOIDED") return "voided";
      if (st === "ACTIVATED") return "live";
      return "inCount";
    };
    const byUnit = (list) => {
      const m = new Map();
      for (const b of list) {
        const u = String(b.unit || "").trim() || "—";
        m.set(u, (m.get(u) || 0) + (Number(b.quantity) || 0));
      }
      return [...m.entries()].map(([unit, quantity]) => ({ unit, quantity: Math.round(quantity * 10000) / 10000 }));
    };
    const buckets = { live: [], inCount: [], voided: [] };
    for (const b of rows) buckets[bucketOf(b)].push(b);

    const variants = new Map();
    for (const b of buckets.live) {
      const key = b.variantId ? String(b.variantId) : "";
      if (!variants.has(key)) variants.set(key, { variantId: key || null, variant: (b.variantCombination || []).join(" · "), labels: 0, rows: [] });
      const v = variants.get(key);
      v.labels += 1;
      v.rows.push(b);
    }

    return res.json({
      success: true,
      summary: {
        live: { labels: buckets.live.length, byUnit: byUnit(buckets.live) },
        inCount: { labels: buckets.inCount.length, byUnit: byUnit(buckets.inCount) },
        voided: { labels: buckets.voided.length },
        liveByVariant: [...variants.values()].map((v) => ({ variantId: v.variantId, variant: v.variant, labels: v.labels, byUnit: byUnit(v.rows) })),
        total: rows.length,
      },
    });
  } catch (error) {
    console.error("Error summarising barcodes:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }
    /* ── A SCAN IS COMPANY-SCOPED TOO ──────────────────────────────────────
       The customer-owned branch below has refused cross-company scans since it
       was written; an ordinary label was left open on the grounds that it
       disclosed nothing about anybody else. It does: the supplier, the purchase
       order number and the unit price on it are one company's commercial terms.

       Labels that predate company stamping carry no `companyId` and stay
       readable — refusing them would stop every sticker already on a shelf. */
    const barcode = await Barcode.findOne(scopedToCompany(req, { _id: req.params.id }))
      .populate("rawItem", "name sku unit customUnit category quantity minStock status variants")
      .populate("purchaseOrder", "poNumber orderDate expectedDeliveryDate status")
      .populate("vendor", "companyName contactPerson phone email gstNumber")
      .populate("generatedBy", "name email")
      .lean();

    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });

    // Attach the variant's own record. It lives inside the raw item's variants
    // array, so it cannot be populated — resolve it here rather than making
    // every caller re-implement the lookup.
    if (barcode.variantId && barcode.rawItem?.variants) {
      barcode.variant =
        barcode.rawItem.variants.find(
          (v) => String(v._id) === String(barcode.variantId)
        ) || null;
    } else {
      barcode.variant = null;
    }
    // The full variants array is only needed to find that one entry; sending
    // it back would be the largest thing in the response and is never read.
    if (barcode.rawItem) delete barcode.rawItem.variants;

    /* ── A SCAN MUST SAY WHOSE MATERIAL THIS IS ──────────────────────────────
       A customer-supplied roll scans exactly like our own, and until now the
       answer looked exactly like our own too — at which point somebody cuts a
       customer's fabric for a different order and nothing warned them.

       So a customer-owned label answers with an explicit ownership block and a
       banner. Every existing label is untouched: without `customerMaterial.lotId`
       the response is byte-for-byte what it has always been, which is what keeps
       the product-marking and purchase-receipt paths working unchanged. */
    const cm = barcode.customerMaterial || {};
    if (cm.lotId) {
      /* ── AND REFUSED ACROSS COMPANIES ────────────────────────────────────
         A customer-owned label carries the company that printed it, precisely so
         this can be refused. Scanning another tenant's label would disclose their
         customer, their order and their quantities to somebody with no
         relationship to them.

         This router carries no tenant middleware — it never needed one, because
         an ordinary label discloses nothing about anybody else — so the company
         is resolved HERE, and only for a customer-owned label. Two consequences,
         both deliberate: every existing scan is untouched, and a caller whose
         company cannot be resolved at all is refused rather than allowed through
         on the grounds that there was nothing to compare.

         Answered as NOT FOUND rather than forbidden, because the existence of the
         label is itself part of what is being protected: "you may not see this"
         confirms that another company holds material for a customer. */
      let scanning = req.tenant?.companyId || null;
      if (!scanning) {
        try {
          const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
          const resolved = await tenantContext.resolveForActor(req.user, {});
          scanning = resolved?.companyId || null;
        } catch {
          scanning = null;
        }
      }
      const owner = String(barcode.companyId || "");
      if (!scanning || !owner || owner !== String(scanning)) {
        return res.status(404).json({ success: false, message: "Barcode not found" });
      }
      const labels = require("../../../../services/storePurchase/customerMaterialLabel.service");
      const { CustomerMaterialLot } = require("../../../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
      const lot = await CustomerMaterialLot.findById(cm.lotId)
        .select("availableQuantity issuedQuantity returnedQuantity status baseUnit receivedAt")
        .lean();

      return res.json({
        success: true,
        barcode,
        /* First in the payload and impossible to miss. A screen that rendered
           only `barcode` would still be wrong, but it could not be wrong by
           accident about ownership. */
        ownership: {
          kind: "CUSTOMER_OWNED",
          banner: labels.OWNERSHIP_BANNER,
          customer: {
            id: String(cm.customerId || ""),
            label: String(cm.customerLabel || ""),
            code: String(cm.customerCode || ""),
          },
          orderRef: String(cm.orderRef || ""),
          orderLineRef: String(cm.orderLineRef || ""),
          documentRef: String(cm.documentRef || ""),
          againstRevisionNo: cm.expectationRevisionNo ?? null,
          expectationLineRef: String(cm.expectationLineRef || ""),
          lot: {
            id: String(cm.lotId),
            goodsReceiptNumber: String(cm.goodsReceiptNumber || ""),
            receivedAt: lot?.receivedAt || null,
            availableQuantity: lot?.availableQuantity ?? null,
            issuedQuantity: lot?.issuedQuantity ?? null,
            returnedToCustomerQuantity: lot?.returnedQuantity ?? null,
            status: String(lot?.status || ""),
            baseUnit: String(lot?.baseUnit || ""),
          },
          where: {
            warehouseName: String(cm.warehouseName || ""),
            locationCode: String(cm.locationCode || ""),
          },
          /* The one sentence a picker needs. */
          usableFor: `Only order ${String(cm.orderRef || "")}`
            + `${cm.orderLineRef ? `, line ${cm.orderLineRef}` : ""}.`,
          /* Said explicitly so nothing downstream treats it as free stock. */
          availableAsGeneralStock: false,
        },
      });
    }

    /* An ordinary label. The response shape is unchanged, and `ownership` says so
       rather than being absent — a reader that checks for it gets an answer on
       every scan instead of having to treat "missing" as "ours". */
    /* ── A SCAN GETS THE TRUTH, NOT A 404 ─────────────────────────────────
       A label reserved or printed during a count is a real identity for
       material GRAV has not received. Hiding it would be wrong — the person
       holding it needs to know what it is — but calling it available stock is
       worse. So the record is returned and the claim is corrected.

       The concrete case, because an abstract rule is easy to overrule in a
       cleanup: somebody is standing at a scanner holding a label off a roll in
       a count that has not been finished. A 404 tells them the sticker is
       rubbish and they bin it — and it was about to become a real stock
       identity the moment the receipt was recorded. Returning the record with
       `availableAsGeneralStock: false` and the reason tells them to go and
       finish the receipt instead. Do not turn this into a 404. */
    const idRefusal = identityRefusal(barcode);
    return res.json({
      success: true,
      barcode,
      identityState: barcode.identityState || "ACTIVATED",
      ownership: {
        kind: "COMPANY_OWNED",
        banner: idRefusal ? idRefusal.message : "",
        availableAsGeneralStock: !idRefusal,
      },
      ...(idRefusal ? { notStock: { reason: idRefusal.reason, message: idRefusal.message } } : {}),
    });
  } catch (error) {
    console.error("Error fetching barcode:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — list barcodes (with optional filters)
// Query: rawItemId, variantId, purchaseOrderId, page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rawItemId, variantId, purchaseOrderId, goodsReceiptId, page = 1, limit = 50 } = req.query;
    const inner = {};
    if (rawItemId && mongoose.Types.ObjectId.isValid(rawItemId)) inner.rawItem = rawItemId;
    if (variantId && mongoose.Types.ObjectId.isValid(variantId)) inner.variantId = variantId;
    if (purchaseOrderId && mongoose.Types.ObjectId.isValid(purchaseOrderId)) inner.purchaseOrder = purchaseOrderId;
    if (goodsReceiptId && mongoose.Types.ObjectId.isValid(goodsReceiptId)) inner.goodsReceiptId = goodsReceiptId;
    /* Company-scoped. This list used to return every company's labels — it is
       what a reprint reads, so it disclosed one company's suppliers, orders and
       quantities to another. Labels that predate company stamping are included,
       or every existing sticker would vanish from the screen that reprints it. */
    const filter = scopedToCompany(req, inner);

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [barcodes, total] = await Promise.all([
      Barcode.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("generatedBy", "name")
        .lean(),
      Barcode.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      barcodes,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error("Error listing barcodes:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;