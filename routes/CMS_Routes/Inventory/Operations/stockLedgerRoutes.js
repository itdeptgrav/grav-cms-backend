// routes/CMS_Routes/Inventory/Operations/stockLedgerRoutes.js
// Mount: app.use("/api/cms/inventory/stock-ledger", require("./routes/..."))
//
// DATA SOURCE: RawItem.stockTransactions[] (all real movements live here)
// StockLedger collection: only compensating entries + edit logs

const express   = require("express");
const router    = express.Router();
const mongoose  = require("mongoose");

const RawItem       = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockLedger   = require("../../../../models/CMS_Models/Inventory/Operations/StockLedger");
const EmployeeAuth  = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuth);

const safe = id => {
  if (!id) return null;
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
};

// ── Map stockTransaction.type → direction + txnType ──────────────────────────
function mapTxn(type) {
  switch (type) {
    case "ADD":            return { direction: "CREDIT", txnType: "STOCK_ADJUSTMENT"  };
    case "PURCHASE_ORDER": return { direction: "CREDIT", txnType: "PURCHASE_ORDER"    };
    case "VARIANT_ADD":    return { direction: "CREDIT", txnType: "STOCK_ADJUSTMENT"  };
    case "REDUCE":         return { direction: "DEBIT",  txnType: "STOCK_ADJUSTMENT"  };
    case "VARIANT_REDUCE": return { direction: "DEBIT",  txnType: "STOCK_ADJUSTMENT"  };
    case "CONSUME":        return { direction: "DEBIT",  txnType: "MRF_ISSUE"         };
    default:               return { direction: "CREDIT", txnType: "STOCK_ADJUSTMENT"  };
  }
}

function formatTxn(t, item, editedMap, compMap) {
  const { direction, txnType } = mapTxn(t.type);
  const unit       = item.customUnit || item.unit || "unit";
  const ledgerEdit = editedMap.get(String(t._id));
  return {
    _id:                String(t._id),
    rawItemId:          String(item._id),
    rawItemName:        item.name,
    rawItemSku:         item.sku,
    variantId:          t.variantId ? String(t.variantId) : null,
    variantCombination: t.variantCombination || [],
    unit,
    direction,
    txnType,
    rawTxnType:         t.type,
    quantity:           t.quantity,
    quantityBefore:     t.previousQuantity ?? 0,
    quantityAfter:      t.newQuantity ?? 0,
    reason:             t.reason || "",
    notes:              t.notes || "",
    supplier:           t.supplier || "",
    supplierId:         t.supplierId ? String(t.supplierId) : null,
    purchaseOrderNo:    t.purchaseOrder || "",
    purchaseOrderId:    t.purchaseOrderId ? String(t.purchaseOrderId) : null,
    unitPrice:          t.unitPrice || 0,
    invoiceNumber:      t.invoiceNumber || "",
    createdAt:          t.createdAt,
    isEdited:           !!ledgerEdit,
    editLog:            ledgerEdit?.editLog || [],
    ledgerEntryId:      ledgerEdit?._id ? String(ledgerEdit._id) : null,
    corrections:        (compMap?.get(String(t._id)) || []).map(c => ({
      _id:            String(c._id),
      direction:      c.direction,
      txnType:        c.txnType,
      quantity:       c.quantity,
      quantityBefore: c.quantityBefore,
      quantityAfter:  c.quantityAfter,
      reason:         c.reason,
      notes:          c.notes,
      createdAt:      c.createdAt,
      isCompensating: true,
      unit,
    })),
  };
}

// ── GET /products ─────────────────────────────────────────────────────────────
router.get("/products", async (req, res) => {
  try {
    const { search = "" } = req.query;
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {};
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity status variants")
      .sort({ name: 1 }).limit(60).lean();
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const agg = await RawItem.aggregate([
      { $project: { txns: { $ifNull: ["$stockTransactions", []] } } },
      { $unwind: "$txns" },
      { $group: {
        _id:     null,
        total:   { $sum: 1 },
        credits: { $sum: { $cond: [{ $in: ["$txns.type", ["ADD","PURCHASE_ORDER","VARIANT_ADD"]] }, 1, 0] } },
        debits:  { $sum: { $cond: [{ $in: ["$txns.type", ["REDUCE","VARIANT_REDUCE","CONSUME"]] }, 1, 0] } },
      }},
    ]);
    const base   = agg[0] || { total: 0, credits: 0, debits: 0 };
    const edited = await StockLedger.countDocuments({ isEdited: true, isVoided: false });
    res.json({ success: true, stats: { ...base, edited } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /edit-sessions ────────────────────────────────────────────────────────
router.get("/edit-sessions", async (req, res) => {
  try {
    const { rawItemId, page = 1, limit = 30 } = req.query;
    const filter = { isEdited: true, isVoided: false };
    if (rawItemId && safe(rawItemId)) filter.rawItem = safe(rawItemId);
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await StockLedger.countDocuments(filter);
    const entries = await StockLedger.find(filter)
      .sort({ updatedAt: -1 }).skip(skip).limit(parseInt(limit)).lean();
    res.json({
      success: true, entries,
      pagination: { total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET / — paginated ledger from RawItem.stockTransactions ───────────────────
router.get("/", async (req, res) => {
  try {
    const {
      rawItemId, variantId, txnType, direction,
      dateFrom, dateTo, search,
      page = 1, limit = 40,
    } = req.query;

    if (!rawItemId) {
      return res.json({
        success: true, entries: [],
        pagination: { total: 0, page: 1, limit: parseInt(limit), totalPages: 0 },
      });
    }

    const item = await RawItem.findById(rawItemId)
      .select("name sku unit customUnit quantity status variants stockTransactions")
      .lean();
    if (!item) return res.status(404).json({ success: false, message: "Item not found." });

    // ── Apply filters on stockTransactions ───────────────────────────────
    let txns = [...(item.stockTransactions || [])];

    if (variantId) {
      txns = txns.filter(t => t.variantId && String(t.variantId) === variantId);
    }
    if (dateFrom) {
      const from = new Date(dateFrom);
      txns = txns.filter(t => new Date(t.createdAt) >= from);
    }
    if (dateTo) {
      const to = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
      txns = txns.filter(t => new Date(t.createdAt) <= to);
    }
    if (direction) {
      txns = txns.filter(t => mapTxn(t.type).direction === direction);
    }
    if (txnType) {
      txns = txns.filter(t => mapTxn(t.type).txnType === txnType);
    }
    if (search) {
      const re = new RegExp(search, "i");
      txns = txns.filter(t =>
        re.test(t.reason || "") ||
        re.test(t.purchaseOrder || "") ||
        re.test(t.supplier || "") ||
        re.test(t.notes || "") ||
        re.test(t.invoiceNumber || "")
      );
    }

    // Newest first
    txns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total    = txns.length;
    const pageNum  = parseInt(page);
    const limitNum = parseInt(limit);
    const paginated = txns.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    // Fetch edit records and compensating entries for this item
    const [editedDocs, compDocs] = await Promise.all([
      StockLedger.find({ rawItem: safe(rawItemId), isEdited: true, isVoided: false }).lean(),
      StockLedger.find({ rawItem: safe(rawItemId), txnType: "COMPENSATING", isVoided: false }).lean(),
    ]);

    const editedMap = new Map(editedDocs.map(e => [String(e.originalTxnId), e]));
    const compMap   = new Map();
    compDocs.forEach(c => {
      const key = String(c.compensatingFor);
      if (!compMap.has(key)) compMap.set(key, []);
      compMap.get(key).push(c);
    });

    const entries = paginated.map(t => formatTxn(t, item, editedMap, compMap));

    res.json({
      success: true,
      entries,
      itemName:     item.name,
      itemSku:      item.sku,
      unit:         item.customUnit || item.unit,
      currentStock: item.quantity,
      pagination:   { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (e) {
    console.error("[stock-ledger GET /]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:rawItemId/txn/:txnId/edit ────────────────────────────────────────
router.patch("/:rawItemId/txn/:txnId/edit", async (req, res) => {
  const dbSession = await mongoose.startSession();
  dbSession.startTransaction();
  try {
    const { rawItemId, txnId } = req.params;
    const { newQuantity, newReason, newNotes, editNote = "" } = req.body;
    if (!editNote.trim()) throw new Error("Reason for this edit is required.");

    const item = await RawItem.findById(rawItemId).session(dbSession);
    if (!item) throw new Error("Raw item not found.");

    const txn = item.stockTransactions.id(txnId);
    if (!txn) throw new Error("Transaction not found in this item.");

    const changes        = [];
    let compEntryId      = null;
    const { direction }  = mapTxn(txn.type);
    const { txnType }    = mapTxn(txn.type);
    const unit           = item.customUnit || item.unit || "unit";

    // ── Quantity correction ───────────────────────────────────────────────
    if (newQuantity != null) {
      const parsed = parseFloat(newQuantity);
      if (isNaN(parsed) || parsed < 0) throw new Error("Quantity must be a non-negative number.");
      if (parsed !== txn.quantity) {
        const diff    = parsed - txn.quantity;
        // Compensating direction: if original was DEBIT and we're increasing → more DEBIT
        const compDir = direction === "DEBIT"
          ? (diff > 0 ? "DEBIT" : "CREDIT")
          : (diff > 0 ? "CREDIT" : "DEBIT");
        const compQty = Math.abs(diff);

        // Get live stock
        let liveQty        = item.quantity;
        let variantSubDoc  = null;
        if (txn.variantId) {
          variantSubDoc = item.variants.id(txn.variantId);
          if (variantSubDoc) liveQty = variantSubDoc.quantity;
        }
        const qtyAfterComp = compDir === "CREDIT"
          ? liveQty + compQty
          : Math.max(0, liveQty - compQty);

        // Create compensating StockLedger entry
        const [comp] = await StockLedger.create([{
          rawItem:            item._id,
          rawItemName:        item.name,
          rawItemSku:         item.sku,
          variantId:          txn.variantId || null,
          variantCombination: txn.variantCombination || [],
          unit,
          direction:          compDir,
          quantity:           compQty,
          quantityBefore:     liveQty,
          quantityAfter:      qtyAfterComp,
          txnType:            "COMPENSATING",
          reason:             `Correction of txn ${txnId}: ${editNote}`,
          compensatingFor:    safe(txnId),
          originalTxnId:      null,
          performedBy:        safe(req.user.id),
          performedByName:    req.user.name || "",
          isEdited:           false,
        }], { session: dbSession });
        compEntryId = comp._id;

        // Adjust live stock
        const rootDiff = compDir === "CREDIT" ? compQty : -compQty;
        item.quantity  = Math.max(0, item.quantity + rootDiff);
        item.status    = item.quantity <= 0 ? "Out of Stock"
          : item.quantity <= (item.minStock || 0) ? "Low Stock" : "In Stock";
        if (variantSubDoc) {
          variantSubDoc.quantity = qtyAfterComp;
          variantSubDoc.status   = qtyAfterComp <= 0 ? "Out of Stock"
            : qtyAfterComp <= (variantSubDoc.minStock || item.minStock || 0) ? "Low Stock" : "In Stock";
        }

        changes.push({ field: "quantity", oldValue: txn.quantity, newValue: parsed, compEntryId });
        txn.quantity = parsed;
      }
    }

    if (newReason != null && newReason !== txn.reason) {
      changes.push({ field: "reason", oldValue: txn.reason || "", newValue: newReason });
      txn.reason = newReason;
    }
    if (newNotes != null && newNotes !== txn.notes) {
      changes.push({ field: "notes", oldValue: txn.notes || "", newValue: newNotes });
      txn.notes = newNotes;
    }

    if (!changes.length) {
      await dbSession.abortTransaction();
      return res.json({ success: true, message: "No changes detected." });
    }

    await item.save({ session: dbSession });

    // Upsert a StockLedger "edit record" for this txn
    const editLogEntries = changes.map(ch => ({
      editedBy:            safe(req.user.id),
      editedByName:        req.user.name || "",
      editedAt:            new Date(),
      field:               ch.field,
      oldValue:            ch.oldValue,
      newValue:            ch.newValue,
      compensatingEntryId: ch.field === "quantity" ? compEntryId : null,
      editNote,
    }));

    await StockLedger.findOneAndUpdate(
      { originalTxnId: safe(txnId), rawItem: item._id },
      {
        $set: {
          rawItem:      item._id,
          rawItemName:  item.name,
          rawItemSku:   item.sku,
          unit,
          direction,
          txnType,
          quantity:           txn.quantity,
          quantityBefore:     txn.previousQuantity ?? 0,
          quantityAfter:      txn.newQuantity ?? 0,
          reason:             txn.reason || "",
          originalTxnId:      safe(txnId),
          isEdited:           true,
          isVoided:           false,
        },
        $push: { editLog: { $each: editLogEntries } },
      },
      { upsert: true, new: true, session: dbSession }
    );

    await dbSession.commitTransaction();
    res.json({ success: true, message: `${changes.length} change(s) saved.`, txnId, changes });
  } catch (e) {
    await dbSession.abortTransaction();
    console.error("[stock-ledger edit]", e);
    res.status(400).json({ success: false, message: e.message });
  } finally {
    dbSession.endSession();
  }
});

// ── GET /verification-report ─────────────────────────────────────────────────
router.get("/verification-report", async (req, res) => {
  try {
    const { rawItemId, variantId, dateFrom, dateTo } = req.query;
    if (!rawItemId) return res.status(400).json({ success: false, message: "rawItemId required." });

    const item = await RawItem.findById(rawItemId)
      .select("name sku unit customUnit quantity minStock maxStock status variants stockTransactions")
      .lean();
    if (!item) return res.status(404).json({ success: false, message: "Item not found." });

    const unit = item.customUnit || item.unit || "unit";
    let txns   = [...(item.stockTransactions || [])];

    if (variantId) txns = txns.filter(t => t.variantId && String(t.variantId) === variantId);
    if (dateFrom)  txns = txns.filter(t => new Date(t.createdAt) >= new Date(dateFrom));
    if (dateTo)    txns = txns.filter(t => new Date(t.createdAt) <= new Date(new Date(dateTo).setHours(23,59,59,999)));

    txns.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const [editedDocs, compDocs] = await Promise.all([
      StockLedger.find({ rawItem: safe(rawItemId), isEdited: true }).lean(),
      StockLedger.find({ rawItem: safe(rawItemId), txnType: "COMPENSATING", isVoided: false }).lean(),
    ]);

    const editedMap = new Map(editedDocs.map(e => [String(e.originalTxnId), e]));
    const compMap   = new Map();
    compDocs.forEach(c => {
      const key = String(c.compensatingFor);
      if (!compMap.has(key)) compMap.set(key, []);
      compMap.get(key).push(c);
    });

    const tree = txns.map(t => formatTxn(t, item, editedMap, compMap));

    const credits     = txns.filter(t => mapTxn(t.type).direction === "CREDIT");
    const debits      = txns.filter(t => mapTxn(t.type).direction === "DEBIT");
    const totalCR     = credits.reduce((s, t) => s + t.quantity, 0);
    const totalDR     = debits.reduce((s, t)  => s + t.quantity, 0);
    const openingQty  = txns.length > 0 ? (txns[0].previousQuantity ?? 0) : 0;
    const closingQty  = txns.length > 0 ? (txns[txns.length - 1].newQuantity ?? 0) : 0;

    let variantQty = null;
    if (variantId) {
      const v = (item.variants || []).find(v => String(v._id) === variantId);
      if (v) variantQty = v.quantity;
    }

    res.json({
      success: true,
      rawItem: {
        _id:      item._id,
        name:     item.name,
        sku:      item.sku,
        unit,
        quantity: variantId != null ? variantQty : item.quantity,
        minStock: item.minStock,
        maxStock: item.maxStock,
        status:   item.status,
        variants: item.variants,
      },
      tree,
      summary: {
        totalEntries:  txns.length,
        totalCredits:  totalCR,
        totalDebits:   totalDR,
        netMovement:   totalCR - totalDR,
        openingQty,
        closingQty,
        editedEntries: editedDocs.length,
        creditCount:   credits.length,
        debitCount:    debits.length,
      },
    });
  } catch (e) {
    console.error("[verification-report]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;