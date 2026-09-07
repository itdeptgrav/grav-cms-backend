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

const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
  CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const idempotency = require("../../../../services/storePurchase/idempotency.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");

const ENTITY = "STOCK_LEDGER";

/* What this data is. Movements are embedded in RawItem with no sequence and no
   opening-balance evidence, so this is legacy movement history — not the
   canonical inventory ledger Chunk 3 will build, and not provably complete. */
const LEGACY_SOURCE = Object.freeze({
  kind: "LEGACY_EMBEDDED",
  label: "Legacy stock movement history",
  note: "Movements are embedded in the item record. There is no movement sequence and no opening-balance evidence, so completeness of the balance chain cannot be established here.",
});

router.use(EmployeeAuth);
router.use(requireTenant);

/**
 * A tenant-scoped filter. `$and`, because a search clause is an `$or` and
 * merging two `$or` keys onto one object drops the first — which is how a
 * search used to widen these queries to every company.
 */
const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ── THE CORRECTED QUANTITY ────────────────────────────────────────────────
   Four decimal places, matching the rest of Store & Purchase. Unlike an
   issued quantity, ZERO is valid here: correcting a movement to nothing is a
   legitimate thing to assert about what was recorded.

   `parseFloat` was the problem it replaces — "12abc" became 12, "1e3" became
   1000, and either would have been written into a stock balance. Excess
   precision is refused rather than rounded: 1.23456 silently becoming 1.2346
   is a different claim from the one the operator made. */
const CORRECTION_DECIMALS = 4;

function strictNonNegativeQuantity(value) {
  let n;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const t = value.trim();
    /* A complete plain decimal. No sign, exponent, separator or trailing dot. */
    if (!/^\d*\.?\d+$/.test(t)) return null;
    if ((t.split(".")[1] || "").length > CORRECTION_DECIMALS) return null;
    n = Number(t);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  /* Refused, never rounded. */
  if (Math.round(n * 10 ** CORRECTION_DECIMALS) / 10 ** CORRECTION_DECIMALS !== n) return null;
  return n;
}

/**
 * What a stored correction row proves.
 *
 * A row lacking `applicationState` predates the field. It cannot be shown to
 * have completed, so it is treated as UNKNOWN and handled exactly as PENDING
 * — fail closed. Reading it as APPLIED would let a historical interrupted
 * correction be reported as a success nobody verified.
 *
 * @returns {"APPLIED"|"PENDING"|"UNKNOWN"}
 */
const correctionState = (row) => {
  const s = row?.applicationState;
  if (s === "APPLIED") return "APPLIED";
  if (s === "PENDING") return "PENDING";
  return "UNKNOWN";
};

const RECONCILE_PENDING = Object.freeze({
  reason: "STOCK_RECONCILIATION_REQUIRED",
  message:
    "A correction of this movement was started but never confirmed, so it is not known whether the stock actually moved. Check the item's balance and its movement history before correcting it again — do not submit this as a new correction.",
});

/* A movement produced by another document's lifecycle, not by a person here. */
const AUTOMATIC_REASONS = ["Purchase Order Delivery"];
const AUTOMATIC_PREFIXES = ["Issued for Work Order:"];
function isAutomaticTxn(t) {
  if (!t) return false;
  if (t.purchaseOrderId || String(t.purchaseOrder || "").trim()) return true;
  if (t.type === "PURCHASE_ORDER" || t.type === "CONSUME") return true;
  const r = String(t.reason || "").trim();
  if (AUTOMATIC_REASONS.includes(r)) return true;
  return AUTOMATIC_PREFIXES.some((p) => r.startsWith(p));
}

/** The original movement, exactly as stored. Never marked edited. */
function formatOriginal(t, item) {
  const { direction, txnType } = mapTxn(t.type);
  return {
    _id: String(t._id),
    rawItemId: String(item._id),
    unit: item.customUnit || item.unit || "unit",
    type: t.type,
    direction,
    txnType,
    quantity: typeof t.quantity === "number" ? t.quantity : null,
    quantityBefore: typeof t.previousQuantity === "number" ? t.previousQuantity : null,
    quantityAfter: typeof t.newQuantity === "number" ? t.newQuantity : null,
    reason: t.reason || "",
    notes: t.notes || "",
    createdAt: t.createdAt,
    automatic: isAutomaticTxn(t),
    unchanged: true,
  };
}

const safe = id => {
  if (!id) return null;
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
};

// ── Map stockTransaction.type → direction + txnType ──────────────────────────
/**
 * A stored movement type, in terms this router understands.
 *
 * ── WHY THE DEFAULT IS NOT "CREDIT" ─────────────────────────────────────────
 * It used to be. A type this router had never heard of — a legacy value, or
 * one written by a future feature — was reported as stock coming IN, counted
 * in the credit totals, and offered for correction as though its balance
 * effect were known. Every one of those is a guess presented as a fact.
 *
 * An unknown type keeps its stored value and is reported as unrecognised.
 */
function mapTxn(type) {
  switch (type) {
    case "ADD":            return { direction: "CREDIT", txnType: "STOCK_ADJUSTMENT", directionKnown: true };
    case "PURCHASE_ORDER": return { direction: "CREDIT", txnType: "PURCHASE_ORDER",   directionKnown: true };
    case "VARIANT_ADD":    return { direction: "CREDIT", txnType: "STOCK_ADJUSTMENT", directionKnown: true };
    case "REDUCE":         return { direction: "DEBIT",  txnType: "STOCK_ADJUSTMENT", directionKnown: true };
    case "VARIANT_REDUCE": return { direction: "DEBIT",  txnType: "STOCK_ADJUSTMENT", directionKnown: true };
    case "CONSUME":        return { direction: "DEBIT",  txnType: "MRF_ISSUE",        directionKnown: true };
    default:
      return {
        direction: null,
        txnType: null,
        directionKnown: false,
        movementLabel: "Unrecognised movement",
      };
  }
}

/** A number, or null. Never a manufactured zero. */
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function formatTxn(t, item, editedMap, compMap) {
  const { direction, txnType, directionKnown, movementLabel } = mapTxn(t.type);
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
    directionKnown,
    ...(movementLabel ? { movementLabel } : {}),
    /* The stored value is preserved exactly, whatever this router makes of it. */
    rawTxnType:         t.type,
    /* `?? 0` turned "nobody recorded this" into a specific balance claim. */
    quantity:           numOrNull(t.quantity),
    quantityBefore:     numOrNull(t.previousQuantity),
    quantityAfter:      numOrNull(t.newQuantity),
    reason:             t.reason || "",
    notes:              t.notes || "",
    supplier:           t.supplier || "",
    supplierId:         t.supplierId ? String(t.supplierId) : null,
    purchaseOrderNo:    t.purchaseOrder || "",
    purchaseOrderId:    t.purchaseOrderId ? String(t.purchaseOrderId) : null,
    unitPrice:          numOrNull(t.unitPrice),
    invoiceNumber:      t.invoiceNumber || "",
    createdAt:          t.createdAt,
    isEdited:           !!ledgerEdit,
    editLog:            ledgerEdit?.editLog || [],
    ledgerEntryId:      ledgerEdit?._id ? String(ledgerEdit._id) : null,
    /* ── A CORRECTION CARRIES ITS OWN OUTCOME ──────────────────────────────
       Every compensating row is listed, including unfinished ones — hiding
       them would leave an unresolved stock claim invisible. But the row alone
       does not say the stock moved: it is written before the balance changes,
       as the claim on the movement. Without the state a reader has to assume,
       and the screen assumed "done".

       `applicationState` is normalised here so a row predating the field is
       UNKNOWN rather than absent, and never reads as applied by omission. */
    corrections:        (compMap?.get(String(t._id)) || []).map(c => ({
      _id:            String(c._id),
      direction:      c.direction,
      txnType:        c.txnType,
      quantity:       numOrNull(c.quantity),
      quantityBefore: numOrNull(c.quantityBefore),
      quantityAfter:  numOrNull(c.quantityAfter),
      reason:         c.reason,
      notes:          c.notes,
      createdAt:      c.createdAt,
      applicationState: c.applicationState === "APPLIED" ? "APPLIED"
        : c.applicationState === "PENDING" ? "PENDING" : "UNKNOWN",
      /* Only meaningful for an APPLIED row; null otherwise, so nothing can
         mistake a claim time for a completion time. */
      appliedAt:      c.applicationState === "APPLIED" ? (c.appliedAt || null) : null,
      isCompensating: true,
      unit,
    })),
  };
}

// ── GET /products ─────────────────────────────────────────────────────────────
router.get("/products", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "" } = req.query;
    const esc = escapeRegex(search);
    const filter = scoped(req, search
      ? { $or: [{ name: { $regex: esc, $options: "i" } }, { sku: { $regex: esc, $options: "i" } }] }
      : {});
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity status variants")
      .sort({ name: 1 }).limit(60).lean();
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────
router.get("/stats", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const agg = await RawItem.aggregate([
      /* Scope FIRST. An unscoped $unwind counted every company's movements. */
      { $match: tenantContext.tenantFilter(req.tenant) },
      { $project: { txns: { $ifNull: ["$stockTransactions", []] } } },
      { $unwind: "$txns" },
      { $group: {
        _id:     null,
        total:   { $sum: 1 },
        credits: { $sum: { $cond: [{ $in: ["$txns.type", ["ADD","PURCHASE_ORDER","VARIANT_ADD"]] }, 1, 0] } },
        debits:  { $sum: { $cond: [{ $in: ["$txns.type", ["REDUCE","VARIANT_REDUCE","CONSUME"]] }, 1, 0] } },
      }},
    ]);
    const base = agg[0] || { total: 0, credits: 0, debits: 0 };
    /* Counted, never summed: these are movements in many different units. */
    const unrecognised = Math.max(0, base.total - base.credits - base.debits);
    const corrections = await StockLedger.countDocuments(
      scoped(req, { txnType: "COMPENSATING", isVoided: false }),
    );
    res.json({
      success: true,
      stats: { ...base, unrecognised, corrections },
      source: LEGACY_SOURCE,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /edit-sessions ────────────────────────────────────────────────────────
/* Named for compatibility. What it lists is correction history. */
router.get("/edit-sessions", requireCapability(CAPABILITIES.HISTORY_READ), async (req, res) => {
  try {
    const { rawItemId, page = 1, limit = 30 } = req.query;
    const narrow = { isVoided: false, $or: [{ isEdited: true }, { txnType: "COMPENSATING" }] };
    if (rawItemId && safe(rawItemId)) narrow.rawItem = safe(rawItemId);
    const filter = scoped(req, narrow);
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
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
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

    const item = await RawItem.findOne(scoped(req, { _id: safe(rawItemId) }))
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
      const re = new RegExp(escapeRegex(search), "i");
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
      StockLedger.find(scoped(req, { rawItem: safe(rawItemId), isEdited: true, isVoided: false })).lean(),
      StockLedger.find(scoped(req, { rawItem: safe(rawItemId), txnType: "COMPENSATING", isVoided: false })).lean(),
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
/* ══════════════════════════════════════════════════════════════════════════
 * PATCH /:rawItemId/txn/:txnId/edit — CORRECT a movement
 *
 * ── THE URL IS KEPT; THE BEHAVIOUR IS NOT ───────────────────────────────────
 * The path stays for compatibility with existing callers. What it does has
 * changed completely: it no longer edits anything.
 *
 * The previous version wrote `txn.quantity = parsed`, `txn.reason = …` and
 * `txn.notes = …` straight onto the stored movement. The figure the operator
 * originally recorded was gone — overwritten in place — while an `isEdited`
 * flag implied the history was intact. A correction is a NEW fact about an old
 * movement, never a rewrite of it: the original is what somebody actually
 * recorded at the time, and it is evidence.
 *
 * So this appends a compensating movement linked to the original and leaves
 * the original byte-for-byte. Both are returned separately.
 *
 * This is NOT the Chunk 3 canonical movement engine. It makes the legacy
 * embedded history safe to correct; it does not replace it.
 * ═════════════════════════════════════════════════════════════════════════ */
router.patch(
  "/:rawItemId/txn/:txnId/edit",
  requireCapability(CAPABILITIES.STOCK_ADJUST),
  refuseLegacyWrite,
  withIdempotency("STOCK_CORRECTION"),
  async (req, res) => {
  try {
    const { rawItemId, txnId } = req.params;
    const { newQuantity, editNote = "", correctionReason = "" } = req.body;

    const reasonText = String(correctionReason || editNote || "").trim();
    if (reasonText.length < 4) {
      throw fail("VALIDATION", "A correction must say why it is being made.", { reason: "REASON_REQUIRED" });
    }

    const itemOid = safe(rawItemId);
    const txnOid = safe(txnId);
    if (!itemOid || !txnOid) {
      throw fail("NOT_FOUND", "That movement was not found.", { reason: "MALFORMED_REFERENCE" });
    }

    /* Scoped: another company's movement is NOT FOUND, never forbidden. */
    const item = await RawItem.findOne(scoped(req, { _id: itemOid })).lean();
    if (!item) throw fail("NOT_FOUND", "That movement was not found.", { reason: "ITEM_NOT_FOUND" });

    const txn = (item.stockTransactions || []).find((t) => String(t._id) === String(txnOid));
    if (!txn) throw fail("NOT_FOUND", "That movement was not found.", { reason: "TXN_NOT_FOUND" });

    /* Automatic movements are the tail of another document's lifecycle — a PO
       receipt or a manufacturing issue. Correcting one here would put the
       stock and its source document permanently out of step, and no policy
       in this chunk permits it. */
    /* ── AN UNRECOGNISED MOVEMENT CANNOT BE CORRECTED ───────────────────
       A correction has to know whether the original added or removed stock in
       order to compute the compensating direction. For a type this router
       does not recognise that is unknowable, and the old default treated it
       as a CREDIT — so correcting one moved stock the wrong way. */
    if (!mapTxn(txn.type).directionKnown) {
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This movement's type is not recognised, so whether it added or removed stock cannot be established and it cannot be corrected here.",
        { reason: "UNRECOGNISED_MOVEMENT", storedType: txn.type ?? null },
      );
    }

    if (isAutomaticTxn(txn)) {
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This movement was created by a purchase order or manufacturing activity and cannot be corrected here. Correct it through the document that produced it.",
        { reason: "AUTOMATIC_MOVEMENT" },
      );
    }

    /* Refused BEFORE any claim is created or any stock is touched. */
    const parsed = strictNonNegativeQuantity(newQuantity);
    if (parsed === null) {
      throw fail(
        "VALIDATION",
        `The corrected quantity must be a plain number of zero or more, with at most ${CORRECTION_DECIMALS} decimal places.`,
        { reason: "INVALID_QUANTITY" },
      );
    }
    const originalQty = typeof txn.quantity === "number" ? txn.quantity : null;
    if (originalQty === null) {
      throw fail("VALIDATION", "This movement has no recorded quantity, so there is nothing to correct against.", { reason: "ORIGINAL_QUANTITY_MISSING" });
    }
    const diff = Math.round((parsed - originalQty) * 10000) / 10000;
    if (diff === 0) {
      throw fail("VALIDATION", "The corrected quantity is the same as the recorded one.", { reason: "NO_CHANGE" });
    }

    /* An already-corrected movement may be corrected again only by a NEW
       explicitly linked correction — never by reopening the first. */
    /* ── ONE CORRECTION PER MOVEMENT ─────────────────────────────────────
       The delta is computed against the ORIGINAL's stored quantity, which
       never changes. So a second correction of 10→14 after a first of 10→12
       would apply +4 again rather than +2, leaving +6 on the balance.
       Repeated correction needs a chain this legacy design cannot express,
       so at most one is permitted and a second is refused. The database
       enforces it — see the unique partial index on StockLedger — because a
       pre-read cannot stop two simultaneous requests. */
    const priorCorrections = await StockLedger.find(
      scoped(req, { compensatingFor: txnOid, txnType: "COMPENSATING", isVoided: false }),
    ).lean();
    /* ── WHAT AN EXISTING CLAIM ACTUALLY TELLS US ────────────────────────
       The claim row is written before the balance moves, so its existence
       proves an attempt was STARTED — not that it finished. Deciding the four
       cases on the row's state rather than on its existence is the difference
       between reporting a real correction and reporting one that may never
       have touched stock.

         same key  + APPLIED  → the stored success, replayed
         same key  + PENDING  → reconciliation required (never 2xx)
         other key + PENDING  → reconciliation required (never 2xx)
         other key + APPLIED  → already corrected
         either    + UNKNOWN  → treated as PENDING; a row from before this
                                field existed cannot be shown to have landed */
    const replay = priorCorrections.find((c) => c.idempotencyKey && c.idempotencyKey === req.idempotent?.key);
    const unfinished = priorCorrections.find((c) => correctionState(c) !== "APPLIED");

    if (unfinished) {
      /* Whether or not this is the same key, an unfinished correction is not
         something to complete, reverse or retry automatically. It blocks. */
      throw fail("LIFECYCLE_BLOCKED", RECONCILE_PENDING.message, {
        reason: RECONCILE_PENDING.reason,
        correctionId: String(unfinished._id),
        applicationState: correctionState(unfinished),
        sameAction: Boolean(replay && String(replay._id) === String(unfinished._id)),
      });
    }

    if (replay) {
      /* APPLIED, by elimination: the balance moved and the row was finished. */
      return await req.idempotent.succeed(200, {
        success: true, message: "This correction was already recorded.",
        original: formatOriginal(txn, item), correction: replay, replayed: true,
      }, { entityType: ENTITY, entityId: replay._id });
    }

    if (priorCorrections.length > 0) {
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This movement has already been corrected once. A further correction is not supported here — the original figure and its single correction are both preserved, and a second adjustment would apply on top of the first.",
        { reason: "ALREADY_CORRECTED", existingCorrectionId: String(priorCorrections[0]._id) },
      );
    }

    if (req.idempotent?.recovering) {
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY, entityId: itemOid, idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: String(txnOid), action: "STOCK_CORRECTION_RECONCILIATION_REQUIRED",
          reason: "Stock may have moved but no correction entry was written.",
          requestId: req.id || "", idempotencyKey: req.idempotent.key,
          metadata: { recovered: true },
        },
      });
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This correction was interrupted after stock may already have moved, and no correction entry was written. Check the item's stock before correcting it again.",
        { reason: "STOCK_RECONCILIATION_REQUIRED" },
      );
    }

    const { direction } = mapTxn(txn.type);
    const unit = item.customUnit || item.unit || "unit";
    /* Increasing a DEBIT takes more stock out; increasing a CREDIT puts more
       in. The compensating movement carries the difference only. */
    const compDir = direction === "DEBIT"
      ? (diff > 0 ? "DEBIT" : "CREDIT")
      : (diff > 0 ? "CREDIT" : "DEBIT");
    const compQty = Math.abs(diff);
    const inc = compDir === "CREDIT" ? compQty : -compQty;

    const variantOid = txn.variantId ? safe(txn.variantId) : null;

    /* Same window as the issue path: in standalone mode the effect marker has
       to exist BEFORE the balance moves, or a failure between the balance
       change and the compensating record lets a retry apply the delta twice. */
    const transactional = await unitOfWork.transactionsAvailable();
    if (!transactional && req.idempotent?.record) {
      await idempotency.markEffectApplied({
        record: req.idempotent.record, entityType: ENTITY, entityId: itemOid,
      });
    }

    const runner = transactional
      ? (opts) => unitOfWork.run(req.tenant, { idempotencyRecord: req.idempotent?.record || null, ...opts })
      : async ({ mutate }) => {
          const out = await mutate(null);
          await actionHistory.record(req.tenant, { ...out.entry, atomicityDegraded: true });
          if (req.idempotent?.record) {
            await idempotency.markEffectApplied({
              record: req.idempotent.record, entityType: out.entityType, entityId: out.entityId,
            });
          }
          return { result: out.result, mode: "MARKED" };
        };

    const { result } = await runner({
      mutate: async (session) => {
        /* ── CLAIM BEFORE MOVING ────────────────────────────────────────
           The compensating row is written FIRST. It is the atomic claim on
           this movement — the unique partial index means a simultaneous
           second correction loses here, before any balance has moved.

           Order matters in the failure case too. A claim with no balance
           change is visible and reconcilable; a balance change with no claim
           is invisible. So the visible failure is the one chosen. */
        const [comp] = await StockLedger.create([{
          ...tenantContext.stamp(req.tenant),
          rawItem: itemOid,
          rawItemName: item.name,
          rawItemSku: item.sku,
          variantId: variantOid,
          variantCombination: txn.variantCombination || [],
          unit,
          direction: compDir,
          quantity: compQty,
          /* Filled in from the atomic write below. Null until then, which is
             exactly what an interrupted correction should look like. */
          quantityBefore: null,
          quantityAfter: null,
          txnType: "COMPENSATING",
          reason: `Correction of movement ${txnId}: ${reasonText}`,
          correctionReason: reasonText,
          compensatingFor: txnOid,
          originalTxnId: null,
          correctsQuantityFrom: originalQty,
          correctsQuantityTo: parsed,
          originalQuantityBefore: typeof txn.previousQuantity === "number" ? txn.previousQuantity : null,
          originalQuantityAfter: typeof txn.newQuantity === "number" ? txn.newQuantity : null,
          idempotencyKey: req.idempotent?.key || "",
          /* A claim, not yet an outcome. */
          applicationState: "PENDING",
          appliedAt: null,
          performedBy: safe(req.user?.id),
          performedByName: req.user?.name || "",
          isEdited: false,
        }], { session });

        /* Atomic and conditional: the balance guard is part of the query, so a
           concurrent movement cannot be overwritten and negative stock cannot
           be reached. */
        const guard = inc < 0 ? { quantity: { $gte: compQty } } : {};
        let variantGuard = {};
        if (variantOid) {
          variantGuard = inc < 0
            ? { variants: { $elemMatch: { _id: variantOid, quantity: { $gte: compQty } } } }
            : { variants: { $elemMatch: { _id: variantOid } } };
        }

        /* ── BALANCE AND STATUS MOVE TOGETHER ────────────────────────────
           This used to be `$inc`, then `updated.status = …` on the returned
           snapshot, then `updated.save()`. Between the increment and the save
           another movement can land; the save then wrote a status derived
           from the snapshot's balance, which was already stale. The stored
           status could end up disagreeing with the stored quantity.

           An aggregation-pipeline update computes the status from the balance
           the database holds AT EXECUTION TIME, in the same operation that
           changes it, so there is no window between them and no snapshot to
           be stale. Nothing is saved afterwards.

           `deriveStatus` in the model is the rule being mirrored:
             q <= 0 → Out of Stock; q <= minStock → Low Stock; else In Stock. */
        const round4Expr = (expr) => ({ $round: [expr, 4] });
        const statusExpr = (qtyExpr, minExpr) => ({
          $switch: {
            branches: [
              { case: { $lte: [qtyExpr, 0] }, then: "Out of Stock" },
              { case: { $lte: [qtyExpr, { $ifNull: [minExpr, 0] }] }, then: "Low Stock" },
            ],
            default: "In Stock",
          },
        });

        const now = new Date();
        const pipeline = [
          /* 1 · the quantities */
          {
            $set: {
              quantity: round4Expr({ $add: [{ $ifNull: ["$quantity", 0] }, inc] }),
              ...(variantOid
                ? {
                    variants: {
                      $map: {
                        input: { $ifNull: ["$variants", []] },
                        as: "v",
                        in: {
                          $cond: [
                            { $eq: ["$$v._id", variantOid] },
                            { $mergeObjects: ["$$v", {
                              quantity: round4Expr({ $add: [{ $ifNull: ["$$v.quantity", 0] }, inc] }),
                            }] },
                            "$$v",
                          ],
                        },
                      },
                    },
                  }
                : {}),
            },
          },
          /* 2 · the statuses, from the balances stage 1 just wrote */
          {
            $set: {
              status: statusExpr("$quantity", "$minStock"),
              ...(variantOid
                ? {
                    variants: {
                      $map: {
                        input: "$variants",
                        as: "v",
                        in: {
                          $cond: [
                            { $eq: ["$$v._id", variantOid] },
                            { $mergeObjects: ["$$v", {
                              status: statusExpr("$$v.quantity", { $ifNull: ["$$v.minStock", "$minStock"] }),
                            }] },
                            "$$v",
                          ],
                        },
                      },
                    },
                  }
                : {}),
              /* `timestamps` does not run for a pipeline update. */
              updatedAt: now,
              ...(safe(req.user?.id) ? { updatedBy: safe(req.user?.id) } : {}),
            },
          },
        ];

        const updated = await RawItem.findOneAndUpdate(
          scoped(req, { _id: itemOid, ...guard, ...variantGuard }),
          pipeline,
          { new: true, session },
        );
        if (!updated) {
          /* Nothing moved. Release the claim so the movement stays
             correctable, then refuse. */
          await StockLedger.deleteOne({ _id: comp._id }, { session });
          throw fail("VALIDATION",
            "This correction would take the balance below zero, or the stock changed while it was being recorded. Check the current balance and try again.",
            { reason: "INSUFFICIENT_STOCK_OR_CONFLICT" });
        }

        const liveAfter = updated.quantity;
        const liveBefore = Math.round((liveAfter - inc) * 10000) / 10000;
        const updatedVariant = variantOid
          ? (updated.variants || []).find((v) => String(v._id) === String(variantOid))
          : null;
        const variantAfter = updatedVariant ? updatedVariant.quantity : null;
        const variantBefore = updatedVariant
          ? Math.round((variantAfter - inc) * 10000) / 10000 : null;

        /* The original embedded movement is not touched, and nothing is saved
           back from a snapshot — the write above was the whole change. */

        /* APPLIED and the balances land together: the state is only true once
           the figures it refers to are persisted with it. */
        const appliedAt = new Date();
        await StockLedger.updateOne(
          { _id: comp._id },
          { $set: {
            quantityBefore: variantOid ? variantBefore : liveBefore,
            quantityAfter: variantOid ? variantAfter : liveAfter,
            applicationState: "APPLIED",
            appliedAt,
          } },
          { session },
        );
        comp.quantityBefore = variantOid ? variantBefore : liveBefore;
        comp.quantityAfter = variantOid ? variantAfter : liveAfter;
        comp.applicationState = "APPLIED";
        comp.appliedAt = appliedAt;

        return {
          entityType: ENTITY,
          entityId: comp._id,
          entry: {
            entityType: ENTITY,
            entityId: comp._id,
            documentNumber: String(txnOid),
            action: "STOCK_CORRECTED",
            reason: reasonText,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: {
              compensatingDirection: compDir, quantity: compQty, unit,
              correctsFrom: originalQty, correctsTo: parsed,
            },
          },
          result: { correction: comp, liveBefore, liveAfter },
        };
      },
    });

    const body = {
      success: true,
      message: "Correction recorded. The original movement is unchanged.",
      /* Returned separately, and the original is never described as edited. */
      original: formatOriginal(txn, item),
      correction: result.correction,
      /* Kept only because existing callers read it. It is always false: this
         endpoint no longer edits anything. */
      isEdited: false,
      legacyFields: { isEdited: false, note: "Retained for compatibility. Corrections are appended; originals are never edited." },
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: result.correction._id })
      : res.json(body);
  } catch (e) {
    if (e?.name === "StorePurchaseError") return sendError(res, e);
    /* The unique claim lost a race with a simultaneous correction. The balance
       change and the entry are in one atomic create, so nothing was applied. */
    if (e?.code === 11000) {
      return sendError(res, fail(
        "LIFECYCLE_BLOCKED",
        "This movement has already been corrected once. A further correction is not supported here.",
        { reason: "ALREADY_CORRECTED" },
      ));
    }
    console.error("[stock-ledger correction]", e);
    res.status(400).json({ success: false, message: e.message });
  }
  },
);

// ── GET /verification-report ─────────────────────────────────────────────────
router.get("/verification-report", requireCapability(CAPABILITIES.HISTORY_READ), async (req, res) => {
  try {
    const { rawItemId, variantId, dateFrom, dateTo } = req.query;
    if (!rawItemId) return res.status(400).json({ success: false, message: "rawItemId required." });

    const item = await RawItem.findOne(scoped(req, { _id: safe(rawItemId) }))
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
      StockLedger.find(scoped(req, { rawItem: safe(rawItemId), isEdited: true })).lean(),
      StockLedger.find(scoped(req, { rawItem: safe(rawItemId), txnType: "COMPENSATING", isVoided: false })).lean(),
    ]);

    const editedMap = new Map(editedDocs.map(e => [String(e.originalTxnId), e]));
    const compMap   = new Map();
    compDocs.forEach(c => {
      const key = String(c.compensatingFor);
      if (!compMap.has(key)) compMap.set(key, []);
      compMap.get(key).push(c);
    });

    const tree = txns.map(t => formatTxn(t, item, editedMap, compMap));

    /* Every movement here belongs to ONE item, so these totals share one unit
       and may legitimately be summed. A movement whose quantity was never
       recorded is counted as missing, not treated as zero. */
    const known = (t) => typeof t.quantity === "number" && Number.isFinite(t.quantity);
    const credits = txns.filter(t => mapTxn(t.type).direction === "CREDIT");
    const debits  = txns.filter(t => mapTxn(t.type).direction === "DEBIT");
    const totalCR = credits.filter(known).reduce((s, t) => s + t.quantity, 0);
    const totalDR = debits.filter(known).reduce((s, t) => s + t.quantity, 0);
    const missingQuantities = txns.filter(t => !known(t)).length;

    /* ── NO INVENTED OPENING BALANCE ───────────────────────────────────────
       `?? 0` asserted that an unrecorded opening balance was zero, which is a
       specific claim about stock nobody wrote down — and it is what made the
       chain look closed when it was not. Absent stays absent. */
    const first = txns[0];
    const last  = txns[txns.length - 1];
    const openingQty = first && typeof first.previousQuantity === "number" ? first.previousQuantity : null;
    const closingQty = last && typeof last.newQuantity === "number" ? last.newQuantity : null;

    /* Whether the chain can be checked at all, stated rather than assumed. */
    const chainVerifiable = openingQty !== null && closingQty !== null && missingQuantities === 0;
    const chain = {
      verifiable: chainVerifiable,
      openingRecorded: openingQty !== null,
      closingRecorded: closingQty !== null,
      missingQuantities,
      note: chainVerifiable
        ? "Opening and closing balances are recorded on the movements shown, for the filters applied."
        : "This item's movements do not carry the opening balance or quantities needed to verify an unbroken chain. No completeness claim is made.",
    };

    let variantQty = null;
    if (variantId) {
      const v = (item.variants || []).find(v => String(v._id) === variantId);
      if (v) variantQty = v.quantity;
    }

    res.json({
      success: true,
      source: LEGACY_SOURCE,
      chain,
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