// routes/CMS_Routes/Inventory/Products/stockAdjustments.js
// Mount: app.use("/api/cms/inventory/stock-adjustments", stockAdjRoutes);

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const RawItem         = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem       = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Unit            = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const StockIssuance   = require("../../../../models/CMS_Models/Inventory/Operations/StockIssuance");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
  CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const idempotency = require("../../../../services/storePurchase/idempotency.service");

const ENTITY = "STOCK_ADJUSTMENT";

/**
 * Run a multi-document stock mutation safely in either transaction mode.
 *
 * ── WHY unitOfWork.run() IS NOT ENOUGH ON ITS OWN ───────────────────────────
 * In MARKED (standalone) mode `run()` writes the effect marker only AFTER
 * `mutate()` returns. A mutate that moves three items and then writes an
 * issuance record can fail on the second item, leaving the first moved with
 * NO marker — so a retry under the same key replays the whole thing and moves
 * the first item a second time. `run()` protects what happens after mutate
 * returns; it cannot protect what happened inside it.
 *
 * So the mode is settled BEFORE anything is written:
 *
 *   · TRANSACTIONAL — the whole multi-document action runs inside one
 *     transaction, and a failure rolls all of it back. `run()` is safe here.
 *   · MARKED — the effect is marked BEFORE the first irreversible write.
 *     From that instant no retry can replay anything; a failure part-way
 *     through surfaces as reconciliation-required, which is the honest answer
 *     when a partial multi-line change cannot be rolled back.
 *
 * Validation happens before either path, so a refusal never burns the key.
 *
 * @returns {{result, mode}}
 */
async function runStockMutation(req, { mutate }) {
  const transactional = await unitOfWork.transactionsAvailable();

  if (transactional) {
    return await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record || null,
      mutate,
    });
  }

  /* Standalone. Mark first — the marker is the only thing that can stop a
     retry, and it has to exist before the first stock write, not after the
     last one. */
  if (req.idempotent?.record) {
    await idempotency.markEffectApplied({
      record: req.idempotent.record, entityType: ENTITY, entityId: null,
    });
  }

  /* `mutate` always returns the entry describing what it did; there is no
     fallback, because a second copy of this label elsewhere would be dead code
     that can drift out of step with the one that is actually written. */
  const { entry: written, result, entityId, entityType } = await mutate(null);
  await actionHistory.record(req.tenant, { ...written, atomicityDegraded: true });
  if (req.idempotent?.record) {
    await idempotency.markEffectApplied({
      record: req.idempotent.record, entityType: entityType || ENTITY, entityId,
    });
  }
  return { result, mode: "MARKED" };
}

/* What this data actually is. Movements live embedded in RawItem, with no
   sequence and no opening-balance evidence, so nothing here may be presented
   as a canonical or provably complete inventory ledger. */
const LEGACY_SOURCE = Object.freeze({
  kind: "LEGACY_EMBEDDED",
  label: "Legacy stock movement history",
  note: "Movements are embedded in the item record. There is no movement sequence and no opening-balance evidence, so completeness of the balance chain cannot be established here.",
});

/* Authentication first, then the tenant. Authentication alone grants nothing:
   every route below still declares the capability it needs. */
router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

/**
 * A tenant-scoped filter.
 *
 * `$and` rather than a spread, because a search clause is itself an `$or` and
 * merging two `$or` keys onto one object silently drops the first. The old
 * search built `{ $or: [...] }` as the WHOLE filter, so a search widened the
 * query to every company at once.
 */
const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

/** An id that is not a valid ObjectId must read as absent, never as an error. */
const objectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);


/* ══════════════════════════════════════════════════════════════════════════
 * UNIT CONVERSION — FAIL CLOSED
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * The previous helpers returned the quantity UNCHANGED whenever a conversion
 * could not be found, and again inside a bare `catch`. So a lookup failure, a
 * missing conversion row, or a typo in a unit name turned 12 metres into 12
 * pieces and wrote that straight into stock. Nothing in the response said so.
 *
 * A conversion is either known or it is not. Where it is not, this refuses
 * BEFORE any stock is touched, and the refusal names the two units so somebody
 * can go and configure the missing row.
 *
 * A factor must be finite and strictly positive. Zero is not "no conversion",
 * it is a broken one — the old code's `d?.quantity` truthiness test silently
 * skipped it and fell through to returning the quantity unchanged.
 *
 * The Unit model and its router belong to another lane; this only reads them.
 * ═════════════════════════════════════════════════════════════════════════ */

/** A usable conversion factor, or null. Never zero, negative or non-finite. */
const usableFactor = (value) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const conversionRefused = (fromUnit, toUnit, why) =>
  fail(
    "VALIDATION",
    `No usable conversion from ${fromUnit} to ${toUnit} is configured, so this quantity cannot be recorded in stock. ${why}`,
    { reason: "CONVERSION_UNAVAILABLE", fromUnit, toUnit },
  );

/**
 * Convert through the Unit catalogue — inside the caller's tenant only.
 *
 * ── WHY THE SCOPE MATTERS AS MUCH AS THE FACTOR ─────────────────────────────
 * Unit names are not globally unique; they are unique PER COMPANY
 * (`{companyId, name}`). Two companies each define "box", and each defines its
 * own factor. An unscoped `findOne({ name })` therefore returned whichever
 * document happened to match first, so a stock write could be converted using
 * another company's factor — a silent, invisible cross-company data leak that
 * lands as a wrong quantity in this company's stock.
 *
 * Both ends are resolved inside the scope, and the conversion row is matched
 * on the SCOPED target's `_id` rather than on a name, so a row pointing at
 * another company's same-named unit cannot satisfy it either.
 *
 * A unit that exists only in another company reads as UNAVAILABLE, never as
 * forbidden — a refusal that distinguished the two would confirm it exists.
 *
 * Legacy-global units are reachable only in legacy mode, and `refuseLegacyWrite`
 * blocks every stock write in that mode, so a legacy unit can never convert a
 * quantity that is about to move stock.
 */
async function convertViaUnitModel(qty, fromUnit, toUnit, req) {
  if (!fromUnit || !toUnit) {
    throw conversionRefused(fromUnit || "(none)", toUnit || "(none)", "A unit was not recorded.");
  }
  if (fromUnit === toUnit) {
    return { quantity: qty, factor: 1, direction: "same-unit", source: "identity" };
  }

  let fromDoc;
  let toDoc;
  try {
    [fromDoc, toDoc] = await Promise.all([
      Unit.findOne(scoped(req, { name: fromUnit })).lean(),
      Unit.findOne(scoped(req, { name: toUnit })).lean(),
    ]);
  } catch {
    /* A lookup failure is not a licence to proceed unconverted. */
    throw conversionRefused(fromUnit, toUnit, "The unit catalogue could not be read.");
  }

  if (!fromDoc || !toDoc) {
    throw conversionRefused(
      fromUnit, toUnit,
      "One of these units is not available in this company's unit catalogue.",
    );
  }

  /* Matched on the SCOPED target's id, so a row aimed at another company's
     identically-named unit does not qualify. */
  const forward = (fromDoc.conversions || []).find(
    (c) => String(c.toUnit) === String(toDoc._id),
  );
  const forwardFactor = usableFactor(forward?.quantity);
  if (forwardFactor !== null) {
    return {
      quantity: qty * forwardFactor,
      factor: forwardFactor,
      direction: `1 ${fromUnit} = ${forwardFactor} ${toUnit}`,
      source: "unit-catalogue-forward",
    };
  }

  const reverse = (toDoc.conversions || []).find(
    (c) => String(c.toUnit) === String(fromDoc._id),
  );
  const reverseFactor = usableFactor(reverse?.quantity);
  if (reverseFactor !== null) {
    return {
      quantity: qty / reverseFactor,
      factor: reverseFactor,
      direction: `1 ${toUnit} = ${reverseFactor} ${fromUnit}`,
      source: "unit-catalogue-reverse",
    };
  }

  const brokenRow = forward !== undefined || reverse !== undefined;
  throw conversionRefused(
    fromUnit, toUnit,
    brokenRow
      ? "A conversion is recorded but its factor is not a usable positive number."
      : "No conversion is recorded between these units.",
  );
}

/**
 * The quantity in the item's own stock unit.
 *
 * Prefers the variant's own conversion table, then the company's unit
 * catalogue. Refuses if neither can establish the relationship.
 */
async function toNative(issuedQty, issuedUnit, nativeUnit, unitConversions = [], req = null) {
  if (!nativeUnit) {
    throw conversionRefused(issuedUnit || "(none)", "(none)", "The item has no recorded stock unit.");
  }
  if (!issuedUnit) {
    throw conversionRefused("(none)", nativeUnit, "No unit was given for the quantity entered.");
  }
  if (issuedUnit === nativeUnit) {
    return { quantity: issuedQty, factor: 1, direction: "same-unit", source: "identity" };
  }

  const conv = (unitConversions || []).find(
    (uc) =>
      (uc.fromUnit === nativeUnit && uc.toUnit === issuedUnit) ||
      (uc.fromUnit === issuedUnit && uc.toUnit === nativeUnit),
  );
  const factor = usableFactor(conv?.quantity);
  if (factor !== null) {
    return conv.fromUnit === nativeUnit
      ? {
          quantity: issuedQty / factor, factor,
          direction: `1 ${nativeUnit} = ${factor} ${issuedUnit}`, source: "variant-conversion",
        }
      : {
          quantity: issuedQty * factor, factor,
          direction: `1 ${issuedUnit} = ${factor} ${nativeUnit}`, source: "variant-conversion",
        };
  }
  return await convertViaUnitModel(issuedQty, issuedUnit, nativeUnit, req);
}

/** Quantities are recorded to four places, matching the rest of Store & Purchase. */
const round4 = (n) => Math.round(n * 10000) / 10000;

/* ── THE SUPPORTED PRECISION, STATED AND ENFORCED ──────────────────────────
   Four decimal places, matching the `.toFixed(4)` the rest of Store & Purchase
   already uses for outstanding and surplus arithmetic. The smallest quantity
   that can be recorded is therefore 0.0001; a positive number below that is
   refused rather than rounded to a valid-looking zero. */
const QTY_DECIMALS = 4;
const MIN_QTY = 0.0001;
const MIN_REASON = 4;

/**
 * A quantity, or null.
 *
 * Accepts a finite positive number or a plain decimal string. Refuses
 * exponent notation, signs, separators, trailing points and anything with a
 * trailing tail — all of which `parseFloat` silently truncates into a number.
 */
function strictQuantity(value) {
  let n;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const t = value.trim();
    if (!/^\d*\.?\d+$/.test(t)) return null;
    if ((t.split(".")[1] || "").length > QTY_DECIMALS) return null;
    n = Number(t);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n <= 0 || n < MIN_QTY) return null;
  if (round4(n) !== n) return null;          // more precision than can be stored
  return n;
}



const AUTOMATIC_REASONS  = ["Purchase Order Delivery"];
const AUTOMATIC_PREFIXES = ["Issued for Work Order:"];
const isAutomatic = (tx) => {
  if (tx.purchaseOrderId || (tx.purchaseOrder || "").trim()) return true;
  const r = (tx.reason || "").trim();
  if (AUTOMATIC_REASONS.includes(r)) return true;
  return AUTOMATIC_PREFIXES.some(p => r.startsWith(p));
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /raw-items  — search raw items for the drawer
// ═════════════════════════════════════════════════════════════════════════════
router.get("/raw-items", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "", limit = 8 } = req.query;
    /* The search NARROWS the tenant scope; it can never replace it. */
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = scoped(req, search
      ? { $or: [{ name: { $regex: escaped, $options: "i" } }, { sku: { $regex: escaped, $options: "i" } }] }
      : {});
    const items = await RawItem.find(filter).select("name sku unit customUnit quantity variants").limit(Number(limit)).lean();
    return res.json({
      success: true,
      items: items.map(item => ({
        _id: item._id, name: item.name, sku: item.sku,
        nativeUnit: item.customUnit || item.unit || "",
        quantity: item.quantity || 0,
        variants: (item.variants || []).map(v => ({
          _id: v._id, combination: v.combination || [], quantity: v.quantity || 0,
          sku: v.sku || "", unitConversions: v.unitConversions || [],
        })),
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /manufacturing-orders  — latest MOs for the drawer dropdown
// ═════════════════════════════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════════════════════════
 * MANUFACTURING INTEGRATION — CLOSED
 *
 * `CustomerRequest` (manufacturing orders) and `StockItem` (BOM lines) carry
 * NO company ownership, and both live outside this lane. There is therefore no
 * query that can return only this company's manufacturing data.
 *
 * Putting `sp.read` in front of a global query does not create tenancy — it
 * only requires the caller to be signed in before they are handed every
 * company's request numbers, customer names, BOM lines and item counts. So
 * these endpoints do not query at all. They refuse, structurally, and say why.
 *
 * Reopening them needs company ownership on CustomerRequest and StockItem,
 * which is a cross-domain change for a later chunk.
 * ═════════════════════════════════════════════════════════════════════════ */
const MANUFACTURING_UNAVAILABLE = Object.freeze({
  code: "INTEGRATION_UNAVAILABLE",
  integration: "MANUFACTURING",
  message:
    "The manufacturing-order integration is unavailable until company ownership can be proved for manufacturing orders and their bill-of-material items. Stock adjustments can still be recorded manually.",
  dependency: "Company ownership on CustomerRequest and StockItem (cross-domain, later chunk).",
});

const refuseManufacturing = (_req, res) =>
  res.status(503).json({ success: false, unavailable: MANUFACTURING_UNAVAILABLE, error: MANUFACTURING_UNAVAILABLE });

router.get("/manufacturing-orders", requireCapability(CAPABILITIES.READ), refuseManufacturing);
router.get("/manufacturing-orders/:moId/bom-items", requireCapability(CAPABILITIES.READ), refuseManufacturing);

// ═════════════════════════════════════════════════════════════════════════════
// POST /issue  — multi-item issuance with optional MO reference
// ═════════════════════════════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════════════════════════
 * POST /issue — the stock movement
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * The previous version was authenticated and nothing more. It read each item,
 * computed a new balance in JavaScript and saved — a read-modify-write, so two
 * simultaneous issues each read the same balance and the second overwrote the
 * first. It clamped with `Math.max(0, …)`, which silently absorbed an
 * over-issue instead of refusing it. It saved item by item inside a loop, so a
 * failure halfway left some items moved and some not, with no record of which.
 * And it carried no idempotency key, so a retried request issued the stock a
 * second time.
 * ═════════════════════════════════════════════════════════════════════════ */
router.post(
  "/issue",
  requireCapability(CAPABILITIES.STOCK_ADJUST),
  refuseLegacyWrite,
  /* Mandatory. This is the endpoint a lost response would otherwise have the
     operator retry into a second, real stock movement. */
  withIdempotency("STOCK_ISSUE"),
  async (req, res) => {
  try {
    const { direction, manufacturingOrderId, moNumber, customerName, items: incomingItems = [], reason = "", notes = "" } = req.body;
    if (!["debit", "credit"].includes(direction))
      return res.status(400).json({ success: false, message: "direction must be debit or credit" });
    if (!Array.isArray(incomingItems) || !incomingItems.length)
      return res.status(400).json({ success: false, message: "No items provided" });

    /* ── A REASON IS AUDIT EVIDENCE, NOT A PLACEHOLDER ────────────────────
       The old handler substituted "Stock Debit"/"Stock Credit" when none was
       given, so the permanent movement record carried a sentence the server
       invented. A generated fallback proves nothing about why stock moved. */
    const reasonText = String(reason ?? "").trim();
    if (reasonText.length < MIN_REASON) {
      throw fail("VALIDATION",
        `Say why this stock is being adjusted. The reason is recorded permanently against the item (at least ${MIN_REASON} characters).`,
        { reason: "REASON_REQUIRED" });
    }

    /* ── MANUFACTURING SNAPSHOTS ARE NOT TRUSTED ──────────────────────────
       There is no way to prove a manufacturing order belongs to this company,
       so a client-supplied MO id, number or customer name cannot be recorded
       as fact. It is refused rather than stored unverified. */
    if (objectId(manufacturingOrderId) || String(moNumber ?? "").trim() || String(customerName ?? "").trim()) {
      return res.status(503).json({
        success: false, unavailable: MANUFACTURING_UNAVAILABLE,
        error: {
          ...MANUFACTURING_UNAVAILABLE,
          message:
            "This adjustment cannot be linked to a manufacturing order: ownership of manufacturing orders cannot be proved, so the reference cannot be recorded. Record it as a manual adjustment instead.",
        },
      });
    }

    /* ── RECOVERY ───────────────────────────────────────────────────────────
       A previous attempt under this key already moved stock and something
       after it failed. Re-running would issue the same stock twice. */
    if (req.idempotent?.recovering) {
      const existing = await StockIssuance.findOne(
        scoped(req, { idempotencyKey: req.idempotent.key }),
      ).lean();

      if (!existing) {
        /* The effect was marked but no issuance record exists: stock moved and
           the action did not finish. Never re-run — the marker is the only
           reason this retry is not a second movement. There is no entity to
           write history against, so the refusal itself is the record. */
        throw fail(
          "LIFECYCLE_BLOCKED",
          "This adjustment was interrupted after stock may already have moved, and no adjustment record was written. Check the item's stock and movement history and correct it — do not submit this again as a new adjustment.",
          { reason: "STOCK_RECONCILIATION_REQUIRED", idempotencyKey: req.idempotent.key },
        );
      }

      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: existing._id,
        idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: String(existing._id),
          action: existing.direction === "debit" ? "STOCK_ADJUSTED_OUT" : "STOCK_ADJUSTED_IN",
          reason: "",
          requestId: req.id || "",
          idempotencyKey: req.idempotent.key,
          metadata: { recovered: true },
        },
      });
      return await req.idempotent.succeed(200, {
        success: true, message: "This adjustment was already recorded.",
        issuance: existing, stockUpdates: [], replayed: true,
      }, { entityType: ENTITY, entityId: existing._id });
    }

    /* ── PLAN ───────────────────────────────────────────────────────────────
       Everything that can refuse is resolved BEFORE any stock is touched:
       tenant ownership, the conversion, and the resulting balance. */
    const plan = [];
    for (const incoming of incomingItems) {
      const { rawItemId, variantId, issuedQty, issuedUnit, notes: itemNotes = "" } = incoming;
      const oid = objectId(rawItemId);
      if (!oid) return res.status(400).json({ success: false, message: `Invalid rawItemId: ${rawItemId}` });

      /* Strict: `parseFloat("12abc")` is 12, which is how a malformed entry
         used to become a real stock movement. */
      const qty = strictQuantity(issuedQty);
      if (qty === null) {
        throw fail("VALIDATION",
          `The quantity for item ${rawItemId} must be a plain positive number with at most ${QTY_DECIMALS} decimal places.`,
          { reason: "INVALID_QUANTITY", rawItemId: String(rawItemId) });
      }

      /* Scoped, so another company's item is NOT FOUND rather than forbidden —
         a 403 here would confirm the record exists. */
      const rawItem = await RawItem.findOne(scoped(req, { _id: oid })).lean();
      if (!rawItem) return res.status(404).json({ success: false, message: `Raw item ${rawItemId} not found` });

      const nativeUnit = rawItem.customUnit || rawItem.unit || "";
      let variant = null;
      let unitConversions = [];
      if (variantId) {
        const vid = objectId(variantId);
        if (!vid) return res.status(400).json({ success: false, message: `Invalid variantId: ${variantId}` });
        variant = (rawItem.variants || []).find((v) => String(v._id) === String(vid)) || null;
        if (!variant) return res.status(404).json({ success: false, message: "Variant not found on this item" });
        unitConversions = variant.unitConversions || [];
      }

      /* Refuses rather than silently returning the entered number. */
      const conversion = await toNative(qty, issuedUnit || nativeUnit, nativeUnit, unitConversions, req);
      const nativeQty = round4(conversion.quantity);
      if (!Number.isFinite(nativeQty) || nativeQty <= 0) {
        throw fail("VALIDATION", `The converted quantity for ${rawItem.name} is not a usable number.`, {
          reason: "CONVERSION_UNAVAILABLE", fromUnit: issuedUnit || nativeUnit, toUnit: nativeUnit,
        });
      }

      const currentTotal = typeof rawItem.quantity === "number" ? rawItem.quantity : 0;
      const currentVariant = variant ? (typeof variant.quantity === "number" ? variant.quantity : 0) : null;

      /* ── NEGATIVE STOCK IS REFUSED ──────────────────────────────────────
         No policy authorises it, and this chunk does not invent one. The old
         code clamped at zero, which turned an over-issue into a silent
         partial one. Checked against the STORED balance, never one supplied
         by the browser. */
      if (direction === "debit") {
        if (round4(currentTotal - nativeQty) < 0) {
          throw fail("VALIDATION",
            `${rawItem.name} holds ${currentTotal} ${nativeUnit}; ${nativeQty} ${nativeUnit} cannot be issued. Negative stock is not permitted.`,
            { reason: "INSUFFICIENT_STOCK", available: currentTotal, requested: nativeQty, unit: nativeUnit });
        }
        if (variant && round4(currentVariant - nativeQty) < 0) {
          throw fail("VALIDATION",
            `That variant holds ${currentVariant} ${nativeUnit}; ${nativeQty} ${nativeUnit} cannot be issued. Negative stock is not permitted.`,
            { reason: "INSUFFICIENT_STOCK", available: currentVariant, requested: nativeQty, unit: nativeUnit });
        }
      }

      plan.push({
        rawItem, variant, oid, qty, issuedUnit: issuedUnit || nativeUnit, nativeUnit,
        nativeQty, conversion, itemNotes, currentTotal, currentVariant,
      });
    }

    const delta = (n) => (direction === "debit" ? -n : n);

    const { result } = await runStockMutation(req, {
      mutate: async (session) => {
        const issuanceItems = [];
        const stockUpdates = [];

        for (const p of plan) {
          const inc = delta(p.nativeQty);

          /* ── ATOMIC CONDITIONAL UPDATE ──────────────────────────────────
             The guard is part of the query, so two simultaneous issues cannot
             both pass it: whichever loses matches no document and is refused
             rather than overwriting the winner's balance. */
          const guard = direction === "debit" ? { quantity: { $gte: p.nativeQty } } : {};
          const variantGuard = p.variant && direction === "debit"
            ? { variants: { $elemMatch: { _id: p.variant._id, quantity: { $gte: p.nativeQty } } } }
            : p.variant
              ? { variants: { $elemMatch: { _id: p.variant._id } } }
              : {};

          const update = { $inc: { quantity: inc } };
          const arrayFilters = [];
          if (p.variant) {
            update.$inc["variants.$[v].quantity"] = inc;
            arrayFilters.push({ "v._id": p.variant._id });
          }

          const updated = await RawItem.findOneAndUpdate(
            scoped(req, { _id: p.oid, ...guard, ...variantGuard }),
            update,
            { new: true, session, ...(arrayFilters.length ? { arrayFilters } : {}) },
          );

          if (!updated) {
            /* Either it moved under us, or the balance no longer covers this. */
            throw fail("VALIDATION",
              `${p.rawItem.name} could not be adjusted: its stock changed while this was being recorded. Check the current balance and try again.`,
              { reason: "CONCURRENT_STOCK_CHANGE", rawItemId: String(p.oid) });
          }

          const newTotal = updated.quantity;
          const updatedVariant = p.variant
            ? (updated.variants || []).find((v) => String(v._id) === String(p.variant._id))
            : null;

          /* Before/after come from the ATOMIC write, not from what was read
             during planning — otherwise they describe a balance that may no
             longer have been current. */
          const prevTotal = round4(newTotal - inc);
          const variantNewQty = updatedVariant ? updatedVariant.quantity : null;
          const variantPrevQty = updatedVariant ? round4(variantNewQty - inc) : null;

          updated.status = newTotal <= 0 ? "Out of Stock"
            : newTotal <= (updated.minStock || 0) ? "Low Stock" : "In Stock";

          const txType = direction === "debit"
            ? (p.variant ? "VARIANT_REDUCE" : "REDUCE")
            : (p.variant ? "VARIANT_ADD" : "ADD");

          const tx = {
            type: txType, quantity: p.nativeQty,
            previousQuantity: prevTotal, newQuantity: newTotal,
            reason: reasonText,
            notes: [p.itemNotes, moNumber ? `MO: ${moNumber}` : "",
              p.conversion.source === "identity" ? ""
                : `Issued as ${p.qty} ${p.issuedUnit} → ${p.nativeQty} ${p.nativeUnit} (${p.conversion.direction})`,
            ].filter(Boolean).join(" | "),
            performedBy: req.user?.id || null,
          };
          if (p.variant) { tx.variantId = p.variant._id; tx.variantCombination = p.variant.combination || []; }
          if (variantPrevQty !== null) { tx.variantPreviousQuantity = variantPrevQty; tx.variantNewQuantity = variantNewQty; }

          updated.stockTransactions.push(tx);
          await updated.save({ session });

          issuanceItems.push({
            rawItem: updated._id, rawItemName: updated.name, rawItemSku: updated.sku,
            variantId: p.variant?._id || null, variantCombination: p.variant?.combination || [],
            issuedQty: p.qty, issuedUnit: p.issuedUnit, nativeQty: p.nativeQty, nativeUnit: p.nativeUnit,
            notes: p.itemNotes,
          });
          stockUpdates.push({
            rawItemId: updated._id, rawItemName: updated.name,
            prevQty: prevTotal, newQty: newTotal, nativeUnit: p.nativeUnit,
            issuedQty: p.qty, issuedUnit: p.issuedUnit, nativeQty: p.nativeQty,
            /* The conversion is stated, not left to be inferred. */
            conversion: {
              from: p.issuedUnit, to: p.nativeUnit,
              factor: p.conversion.factor, direction: p.conversion.direction, source: p.conversion.source,
            },
            variantPrevQty, variantNewQty,
          });
        }

        const [issuance] = await StockIssuance.create([{
          ...tenantContext.stamp(req.tenant),
          idempotencyKey: req.idempotent?.key || "",
          direction,
          manufacturingOrder: objectId(manufacturingOrderId),
          moNumber: moNumber || "",
          customerName: customerName || "",
          items: issuanceItems, reason: reasonText, notes,
          performedBy: req.user?.id || null,
        }], { session });

        return {
          entityType: ENTITY,
          entityId: issuance._id,
          entry: {
            entityType: ENTITY,
            entityId: issuance._id,
            documentNumber: String(issuance._id),
            /* A credit is not an issue. And with manufacturing ownership
               unprovable, neither direction may be described as issued to a
               manufacturing order — both are manual adjustments. */
            action: direction === "debit" ? "STOCK_ADJUSTED_OUT" : "STOCK_ADJUSTED_IN",
            reason: reasonText,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: { direction, lines: issuanceItems.length },
          },
          result: { issuance, stockUpdates },
        };
      },
    });

    const body = { success: true, issuance: result.issuance, stockUpdates: result.stockUpdates };
    return req.idempotent
      ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: result.issuance._id })
      : res.json(body);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("issue error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// GET /by-mo  — issuance records paginated
// ═════════════════════════════════════════════════════════════════════════════
router.get("/by-mo", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { page = 1, limit = 20, direction = "all", search = "" } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
    const narrow   = {};
    if (direction !== "all") narrow.direction = direction;
    const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (search) narrow.$or = [
      { moNumber:     { $regex: esc, $options: "i" } },
      { customerName: { $regex: esc, $options: "i" } },
      { reason:       { $regex: esc, $options: "i" } },
    ];
    const filter  = scoped(req, narrow);
    const total   = await StockIssuance.countDocuments(filter);
    const records = await StockIssuance.find(filter)
      .sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
      .populate("performedBy", "name").lean();
    return res.json({ success: true, issuances: records, pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /  — all manual stock adjustments
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { page = 1, limit = 20, type = "all", search = "", rawItemId = "" } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
    const narrow = {};
    if (rawItemId) {
      const oid = objectId(rawItemId);
      /* A malformed id reads as absent, exactly as another company's id does. */
      if (!oid) {
        return res.json({
          success: true, transactions: [],
          pagination: { total: 0, page: pageNum, limit: limitNum, totalPages: 1 },
          stats: { totalAdjustments: 0, totalCredits: 0, totalDebits: 0, quantitiesByUnit: [] },
          source: LEGACY_SOURCE,
        });
      }
      narrow._id = oid;
    }
    const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (search) narrow.$or = [{ name: { $regex: esc, $options: "i" } }, { sku: { $regex: esc, $options: "i" } }];
    const itemFilter = scoped(req, narrow);

    const rawItems = await RawItem.find(itemFilter)
      .select("name sku unit customUnit stockTransactions variants")
      .populate("stockTransactions.performedBy", "name email")
      .lean();

    let allTx = [];
    for (const item of rawItems) {
      for (const tx of (item.stockTransactions || [])) {
        if (isAutomatic(tx)) continue;
        const isCredit = ["ADD", "VARIANT_ADD", "PURCHASE_ORDER"].includes(tx.type);
        const isDebit  = ["REDUCE", "VARIANT_REDUCE", "CONSUME"].includes(tx.type);
        /* A type this router does not know is NOT stock-in. Saying so was the
           old default, and it turned an unreadable movement into a credit. */
        const known = isCredit || isDebit;
        if (type === "credit" && !isCredit) continue;
        if (type === "debit"  && !isDebit)  continue;
        if ((type === "credit" || type === "debit") && !known) continue;
        let variantCombo = tx.variantCombination || [];
        if (!variantCombo.length && tx.variantId) {
          const v = (item.variants || []).find(x => x._id?.toString() === tx.variantId.toString());
          if (v) variantCombo = v.combination || [];
        }
        allTx.push({
          _id: tx._id, rawItemId: item._id, rawItemName: item.name, rawItemSku: item.sku,
          unit: item.customUnit || item.unit || "",
          type: tx.type,
          direction: known ? (isCredit ? "credit" : "debit") : null,
          directionKnown: known,
          movementLabel: known ? undefined : "Unrecognised movement",
          quantity: tx.quantity, previousQuantity: tx.previousQuantity, newQuantity: tx.newQuantity,
          variantId: tx.variantId, variantCombination: variantCombo,
          reason: tx.reason || "", notes: tx.notes || "",
          performedBy: tx.performedBy || null, createdAt: tx.createdAt,
        });
      }
    }

    allTx.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const totalCredits = allTx.filter(t => t.direction === "credit").length;
    const totalDebits  = allTx.filter(t => t.direction === "debit").length;
    const unrecognised = allTx.filter(t => !t.directionKnown).length;
    const total        = allTx.length;

    /* ── NO COMBINED QUANTITY ──────────────────────────────────────────────
       `creditQty`/`debitQty` used to sum `quantity` across every item in the
       result — metres, kilograms and pieces added into one number and served
       as a statistic. Quantities are grouped by their own unit instead, and a
       movement whose quantity was never recorded is counted as missing rather
       than as zero. */
    const byUnit = new Map();
    for (const t of allTx) {
      const unit = (t.unit || "").trim();
      const key = unit || "(no recorded unit)";
      const row = byUnit.get(key) || { unit: unit || null, credit: 0, debit: 0, missing: 0 };
      if (typeof t.quantity !== "number" || !Number.isFinite(t.quantity)) row.missing += 1;
      else if (t.direction === "credit") row.credit = round4(row.credit + t.quantity);
      else if (t.direction === "debit") row.debit = round4(row.debit + t.quantity);
      else row.missing += 1;
      byUnit.set(key, row);
    }

    return res.json({
      success: true, transactions: allTx.slice((pageNum - 1) * limitNum, pageNum * limitNum),
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
      stats: {
        totalAdjustments: total, totalCredits, totalDebits, unrecognised,
        quantitiesByUnit: [...byUnit.values()],
      },
      source: LEGACY_SOURCE,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;