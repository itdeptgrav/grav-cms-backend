// routes/CMS_Routes/Inventory/Operations/stockCountRoutes.js
// Mount: app.use("/api/cms/inventory/stock-counts", stockCountRoutes)
//
// Warehouse Stock Count V1 — a practical cycle-count workflow.
//
//   start → enter quantities → review variances → post one correction
//   DRAFT → IN_PROGRESS      → REVIEWED         → POSTED   (CANCELLED before post)
//
// It never changes stock itself. The post turns each reviewed non-zero variance
// into ONE correction through the canonical operation (see stockCount.service),
// inside a single transaction — and, because that promise cannot be kept without
// one, refuses to post at all where transactions are unavailable rather than
// writing a half-applied correction.

"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const StockCount = require("../../../../models/CMS_Models/Inventory/Operations/StockCount");
const LocationMovement = require("../../../../models/CMS_Models/Inventory/Operations/LocationMovement");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability, refuseLegacyWrite, withIdempotency, CAPABILITIES } =
  require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const locStock = require("../../../../services/storePurchase/locationStock.service");
const count = require("../../../../services/storePurchase/stockCount.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

const oid = (id) => (mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null);
const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};
const actorOf = (req) => ({ id: req.user?.id || null, name: req.user?.name || "" });

// ── SERIALIZE — the ONE presentation contract, blind-aware ────────────────────
// Expected quantities and everything derived from them (variance, large flags,
// the unit summary) are HIDDEN for a blind count until it reaches review. The
// counter must not see the number they are checking against, or the count
// proves nothing.
function revealExpected(doc) {
  return doc.mode !== "BLIND" || doc.status === "REVIEWED" || doc.status === "POSTED";
}

function serialize(doc, { conflicts = null } = {}) {
  const reveal = revealExpected(doc);
  const lines = (doc.lines || []).map((l) => {
    const v = count.lineVariance(l);
    const base = {
      lineId: String(l._id),
      rawItemId: String(l.rawItemId),
      rawItemName: l.rawItemName,
      rawItemSku: l.rawItemSku,
      variantId: l.variantId ? String(l.variantId) : null,
      variantCombination: l.variantCombination || [],
      variantSku: l.variantSku || "",
      baseUnit: l.baseUnit || "",
      counted: l.counted === true,
      countedQty: l.counted === true ? l.countedQty : null,
      varianceReason: l.varianceReason || "",
      addedDuringCount: l.addedDuringCount === true,
      posted: l.posted && l.posted.applied
        ? {
            direction: l.posted.direction, quantity: l.posted.quantity,
            companyBefore: l.posted.companyBefore, companyAfter: l.posted.companyAfter,
            locationBefore: l.posted.locationBefore, locationAfter: l.posted.locationAfter,
            movementId: l.posted.movementId ? String(l.posted.movementId) : null,
          }
        : null,
    };
    if (reveal) {
      base.expectedQty = l.expectedQty;
      base.variance = v.variance;
      base.hasVariance = v.hasVariance;
      base.direction = v.direction;
      base.largeVariance = count.isLargeVariance(l);
    }
    return base;
  });

  const out = {
    _id: String(doc._id),
    countNumber: doc.countNumber,
    status: doc.status,
    mode: doc.mode,
    warehouseId: String(doc.warehouseId),
    locationId: String(doc.locationId),
    warehouseName: doc.warehouseName,
    warehouseShortName: doc.warehouseShortName,
    locationCode: doc.locationCode,
    locationName: doc.locationName,
    filter: doc.filter || { search: "", category: "" },
    snapshotAt: doc.snapshotAt,
    recordVersion: doc.recordVersion || 0,
    startedByName: doc.startedByName || "",
    startedAt: doc.createdAt,
    reviewedAt: doc.reviewedAt || null,
    reviewedByName: doc.reviewedByName || "",
    postedAt: doc.postedAt || null,
    postedByName: doc.postedByName || "",
    cancelledAt: doc.cancelledAt || null,
    cancelReason: doc.cancelReason || "",
    lines,
    progress: count.countProgress(doc.lines || []),
    scope: count.countScope(doc),
    expectedHidden: !reveal,
    posting: {
      discrepanciesPosted: doc.posting?.discrepanciesPosted || 0,
      linesCounted: doc.posting?.linesCounted || 0,
    },
  };
  if (reveal) out.summary = count.summariseByUnit(doc.lines || []);
  if (conflicts) out.conflicts = conflicts;
  return out;
}

// Merge counted entries from the body into a loaded count's lines. Returns the
// number of lines touched. A "not counted" entry clears any prior number — the
// two states are kept distinct end to end.
function mergeEntries(doc, entries) {
  const byId = new Map((entries || []).map((e) => [String(e.lineId), e]));
  let touched = 0;
  for (const line of doc.lines) {
    const e = byId.get(String(line._id));
    if (!e) continue;
    touched += 1;
    if (e.counted === true && e.countedQty != null && Number.isFinite(Number(e.countedQty)) && Number(e.countedQty) >= 0) {
      line.counted = true;
      line.countedQty = count.round4(Number(e.countedQty));
    } else {
      // Explicit "not counted" — NOT a recorded zero.
      line.counted = false;
      line.countedQty = null;
    }
    if (typeof e.varianceReason === "string") line.varianceReason = e.varianceReason.trim().slice(0, 500);
  }
  return touched;
}

// ── GET /warehouses — active warehouses + active locations, for the picker ────
router.get("/warehouses", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rows = await Warehouse.find(scoped(req, { status: "Active" }))
      .select("name shortName status locations").lean();
    const warehouses = rows.map((w) => ({
      _id: String(w._id), name: w.name, shortName: w.shortName,
      locations: (w.locations || [])
        .filter((l) => l.status === "Active")
        .map((l) => ({ _id: String(l._id), code: l.code, name: l.name, type: l.type })),
    }));
    return res.json({ success: true, warehouses });
  } catch (err) { return sendError(res, err); }
});

// ── GET /item-search — find items to ADD to a count (never the whole master) ──
// Company-scoped, name/SKU, capped. The workspace never loads the entire Item
// Master; it searches on demand, so a count of one shelf does not pull thousands
// of items nobody is counting.
router.get("/item-search", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, items: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const items = await RawItem.find(scoped(req, {
      $or: [{ name: { $regex: esc, $options: "i" } }, { sku: { $regex: esc, $options: "i" } }],
    })).select("name sku unit customUnit variants").limit(12).lean();
    return res.json({
      success: true,
      items: items.map((it) => ({
        _id: String(it._id), name: it.name, sku: it.sku || "",
        baseUnit: it.customUnit || it.unit || "",
        variants: (it.variants || []).map((v) => ({ _id: String(v._id), combination: v.combination || [], sku: v.sku || "" })),
      })),
    });
  } catch (err) { return sendError(res, err); }
});

// ── GET / — list counts (open first, then recent) ─────────────────────────────
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { status = "", warehouseId = "", locationId = "", page = 1, limit = 20 } = req.query;
    const narrow = {};
    if (status && StockCount.STATUSES.includes(status)) narrow.status = status;
    if (oid(warehouseId)) narrow.warehouseId = oid(warehouseId);
    if (oid(locationId)) narrow.locationId = oid(locationId);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const filter = scoped(req, narrow);
    const total = await StockCount.countDocuments(filter);
    const docs = await StockCount.find(filter)
      .sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean();
    return res.json({
      success: true,
      counts: docs.map((d) => serialize(d)),
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (err) { return sendError(res, err); }
});

// ── GET /:id — one count ──────────────────────────────────────────────────────
router.get("/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    const doc = await StockCount.findOne(scoped(req, { _id: id })).lean();
    if (!doc) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    return res.json({ success: true, count: serialize(doc) });
  } catch (err) { return sendError(res, err); }
});

// ── POST / — start a count (freeze the expected snapshot) ─────────────────────
router.post("/", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite, async (req, res) => {
  try {
    const { warehouseId, locationId, mode = "NORMAL", search = "", category = "" } = req.body || {};
    const wid = oid(warehouseId);
    const lid = oid(locationId);
    if (!wid || !lid) throw fail("VALIDATION", "A warehouse and a location are required to start a count.", { reason: "LOCATION_REQUIRED" });
    const theMode = StockCount.MODES.includes(mode) ? mode : "NORMAL";

    // The location must be usable in THIS company: active warehouse, active
    // location, owned here. A foreign or inactive one is refused before a
    // snapshot exists.
    const warehouse = await Warehouse.findOne(scoped(req, { _id: wid })).lean();
    const location = locStock.findLocation(warehouse, lid);
    const locErr = locStock.usableLocationError(warehouse, location, req.tenant.companyId);
    if (locErr) throw fail("VALIDATION", locErr.message, { reason: locErr.reason });

    // One OPEN count per location. Friendly refusal here; the unique partial
    // index is the backstop against a race.
    const open = await StockCount.findOne(scoped(req, {
      warehouseId: wid, locationId: lid, status: { $in: StockCount.OPEN_STATUSES },
    })).lean();
    if (open) {
      throw fail("CONFLICT",
        `${location.code} already has an open count (${open.countNumber}). Finish or cancel it before starting another.`,
        { reason: "OPEN_COUNT_EXISTS", countId: String(open._id), countNumber: open.countNumber });
    }

    const lines = await count.snapshotLines({
      companyId: req.tenant.companyId, warehouseId: wid, locationId: lid, search, category,
    });

    // Sequential, per-company count number. Retry a handful of times on the
    // unique-index race rather than serialising every start.
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const last = await StockCount.findOne(scoped(req, {})).sort({ seq: -1 }).select("seq").lean();
      const seq = (last?.seq || 0) + 1;
      try {
        created = await StockCount.create({
          ...tenantContext.stamp(req.tenant),
          countNumber: `SC-${String(seq).padStart(5, "0")}`,
          seq,
          warehouseId: wid, locationId: lid,
          warehouseName: warehouse.name || "", warehouseShortName: warehouse.shortName || "",
          locationCode: location.code || "", locationName: location.name || "",
          mode: theMode, status: "DRAFT",
          filter: { search: String(search || "").trim(), category: String(category || "").trim() },
          snapshotAt: new Date(),
          lines,
          startedBy: req.user?.id || null, startedByName: req.user?.name || "",
        });
      } catch (e) {
        if (e && e.code === 11000) continue; // seq/countNumber/open-count race — retry
        throw e;
      }
    }
    if (!created) throw fail("CONFLICT", "A count could not be started just now. Try again.", { reason: "START_RACE" });

    return res.status(201).json({ success: true, count: serialize(created.toObject()) });
  } catch (err) { return sendError(res, err); }
});

// ── PUT /:id — save entered quantities (progress) ─────────────────────────────
router.put("/:id", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    const { entries = [], recordVersion } = req.body || {};

    const doc = await StockCount.findOne(scoped(req, { _id: id }));
    if (!doc) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    if (!["DRAFT", "IN_PROGRESS"].includes(doc.status)) {
      throw fail("CONFLICT", `This count is ${doc.status.toLowerCase()} and its entries can no longer be changed.`, { reason: "NOT_EDITABLE", status: doc.status });
    }
    // Optimistic guard: a stale save (composed against an older version) is
    // refused rather than silently overwriting a newer one.
    if (recordVersion != null && Number(recordVersion) !== (doc.recordVersion || 0)) {
      throw fail("CONFLICT", "This count changed since you loaded it. Reload and enter again.", { reason: "STALE_ENTRY", recordVersion: doc.recordVersion || 0 });
    }

    mergeEntries(doc, entries);
    doc.status = "IN_PROGRESS";
    doc.recordVersion = (doc.recordVersion || 0) + 1;
    await doc.save();
    return res.json({ success: true, count: serialize(doc.toObject()) });
  } catch (err) { return sendError(res, err); }
});

// ── POST /:id/lines — ADD an item found that the snapshot did not list ────────
// The main point of a physical count: stock on the shelf the system did not
// expect. Allowed only while the count is still editable. The added line freezes
// its expected quantity NOW (the location's current on-hand for that scope, or 0
// if none) and then behaves exactly like a snapshot line — counting, reasons,
// conflict detection, review and posting all treat it identically.
router.post("/:id/lines", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    const { rawItemId, variantId = null, wholeItem = false } = req.body || {};
    const rid = oid(rawItemId);
    if (!rid) throw fail("VALIDATION", "Choose an item to add.", { reason: "ITEM_REQUIRED" });

    const doc = await StockCount.findOne(scoped(req, { _id: id }));
    if (!doc) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    // Additions only BEFORE review/post/cancel — a reviewed or posted count is
    // fixed evidence, and a cancelled one is closed.
    if (!["DRAFT", "IN_PROGRESS"].includes(doc.status)) {
      throw fail("CONFLICT", `Items can only be added while a count is being entered — this one is ${doc.status.toLowerCase()}.`, { reason: "NOT_EDITABLE", status: doc.status });
    }

    // Company ownership — a foreign item is NOT FOUND, never forbidden.
    const item = await RawItem.findOne(scoped(req, { _id: rid })).lean();
    if (!item) return sendError(res, fail("NOT_FOUND", "That item was not found in this company."));

    // Scope: an explicit variant, or an explicit Whole item. An item that HAS
    // variants must be told which — a silent whole-item line would count a total
    // the item does not hold as one figure.
    let variant = null;
    let vId = null;
    if (!wholeItem && variantId) {
      const vid = oid(variantId);
      variant = vid ? (item.variants || []).find((v) => String(v._id) === String(vid)) : null;
      if (!variant) throw fail("VALIDATION", "That variant is not on this item.", { reason: "INVALID_VARIANT" });
      vId = variant._id;
    } else if (!wholeItem && (item.variants || []).length) {
      throw fail("VALIDATION", "Choose a variant, or select Whole item.", { reason: "SCOPE_REQUIRED" });
    }

    // No duplicate (item, variant) line — the same scope twice would post twice.
    const dup = doc.lines.some((l) =>
      String(l.rawItemId) === String(rid) && String(l.variantId || "") === String(vId || ""));
    if (dup) throw fail("CONFLICT", "That item is already a line in this count.", { reason: "DUPLICATE_LINE" });

    // Freeze expected = the location's CURRENT on-hand for this scope (0 if the
    // location holds none). Frozen now, so a later movement is a conflict.
    const expected = await locStock.locationOnHand(null, req.tenant.companyId, rid, vId, doc.warehouseId, doc.locationId);

    doc.lines.push({
      rawItemId: rid, rawItemName: item.name || "", rawItemSku: item.sku || "",
      variantId: vId, variantCombination: variant ? variant.combination || [] : [], variantSku: variant ? variant.sku || "" : "",
      baseUnit: item.customUnit || item.unit || "",
      expectedQty: count.round4(expected),
      counted: false, countedQty: null, varianceReason: "",
      addedDuringCount: true, addedAt: new Date(),
    });
    doc.status = "IN_PROGRESS";
    doc.recordVersion = (doc.recordVersion || 0) + 1;
    await doc.save();
    return res.json({ success: true, count: serialize(doc.toObject()) });
  } catch (err) { return sendError(res, err); }
});

// Detect, per line, whether the location balance has moved since the snapshot.
// Informational at review; authoritative (and atomic) at post.
async function detectConflicts(req, doc) {
  const conflicts = [];
  for (const line of doc.lines) {
    const v = count.lineVariance(line);
    if (!v.counted || !v.hasVariance) continue; // only lines that would move stock
    const current = await locStock.locationOnHand(
      null, req.tenant.companyId, line.rawItemId, line.variantId || null, doc.warehouseId, doc.locationId,
    );
    if (Math.abs(current - count.round4(line.expectedQty)) > count.QTY_TOL) {
      conflicts.push({
        lineId: String(line._id), rawItemId: String(line.rawItemId),
        rawItemName: line.rawItemName, expected: count.round4(line.expectedQty), current,
      });
    }
  }
  return conflicts;
}

// ── POST /:id/review — validate reasons, surface conflicts, mark REVIEWED ─────
router.post("/:id/review", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    const { entries = null, recordVersion } = req.body || {};

    const doc = await StockCount.findOne(scoped(req, { _id: id }));
    if (!doc) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    if (!["DRAFT", "IN_PROGRESS", "REVIEWED"].includes(doc.status)) {
      throw fail("CONFLICT", `This count is ${doc.status.toLowerCase()} and cannot be reviewed.`, { reason: "NOT_REVIEWABLE", status: doc.status });
    }
    if (recordVersion != null && Number(recordVersion) !== (doc.recordVersion || 0)) {
      throw fail("CONFLICT", "This count changed since you loaded it. Reload and review again.", { reason: "STALE_ENTRY", recordVersion: doc.recordVersion || 0 });
    }
    if (Array.isArray(entries)) mergeEntries(doc, entries);

    // Every non-zero variance needs a reason.
    const problems = count.reviewProblems(doc.lines);
    if (problems.length) {
      throw fail("VALIDATION", "Every discrepancy needs a reason before this count can be reviewed.", { reason: "REASON_REQUIRED", problems });
    }

    const conflicts = await detectConflicts(req, doc);

    doc.status = "REVIEWED";
    doc.reviewedAt = new Date();
    doc.reviewedBy = req.user?.id || null;
    doc.reviewedByName = req.user?.name || "";
    doc.recordVersion = (doc.recordVersion || 0) + 1;
    await doc.save();

    return res.json({ success: true, count: serialize(doc.toObject(), { conflicts }) });
  } catch (err) { return sendError(res, err); }
});

// ── POST /:id/cancel — cancel an open count with a reason ─────────────────────
router.post("/:id/cancel", requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3) throw fail("VALIDATION", "Say why this count is being cancelled.", { reason: "CANCEL_REASON_REQUIRED" });

    const doc = await StockCount.findOne(scoped(req, { _id: id }));
    if (!doc) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));
    if (doc.status === "POSTED") throw fail("CONFLICT", "A posted count cannot be cancelled — it is already the record behind real stock movements.", { reason: "ALREADY_POSTED" });
    if (doc.status === "CANCELLED") return res.json({ success: true, count: serialize(doc.toObject()) });

    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    doc.cancelledBy = req.user?.id || null;
    doc.cancelReason = reason;
    await doc.save();
    return res.json({ success: true, count: serialize(doc.toObject()) });
  } catch (err) { return sendError(res, err); }
});

// ── POST /:id/post — apply the reviewed correction, atomically ────────────────
router.post(
  "/:id/post",
  requireCapability(CAPABILITIES.STOCK_ADJUST),
  refuseLegacyWrite,
  withIdempotency("STOCK_COUNT_POST", { target: (req) => `stock-count:${req.params.id}` }),
  async (req, res) => {
    try {
      const id = oid(req.params.id);
      if (!id) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));

      const existing = await StockCount.findOne(scoped(req, { _id: id })).lean();
      if (!existing) return sendError(res, fail("NOT_FOUND", "That stock count was not found."));

      const requestHash = count.hashCountRequest(existing.lines);
      const key = req.idempotent?.key || "";

      // ── DURABLE RECEIPT — outlives the temporary idempotency row ────────────
      // The posted count IS the receipt. A replay under the same key with the
      // same figures returns the same outcome; a DIFFERENT body under the same
      // key is a conflict, not a second post.
      if (existing.status === "POSTED") {
        if (existing.posting?.idempotencyKey === key && existing.posting?.requestHash === requestHash) {
          const body = { success: true, replayed: true, count: serialize(existing), outcome: outcomeOf(existing) };
          return req.idempotent
            ? await req.idempotent.succeed(200, body, { entityType: "STOCK_COUNT", entityId: existing._id })
            : res.json(body);
        }
        throw fail("CONFLICT", "This count was already posted. Start a new count for a further correction.", { reason: "ALREADY_POSTED", countNumber: existing.countNumber });
      }
      if (existing.status !== "REVIEWED") {
        throw fail("CONFLICT", "A count must be reviewed before it can be posted.", { reason: "NOT_REVIEWED", status: existing.status });
      }

      // ── TRANSACTIONAL, OR REFUSED BEFORE ANY WRITE ──────────────────────────
      // One correction across the company on-hand, the location ledger and the
      // valuation input. Without a transaction that cannot be all-or-nothing, so
      // it is refused rather than half-applied.
      if (!(await unitOfWork.transactionsAvailable())) {
        throw fail("STOCK_COUNT_TRANSACTION_REQUIRED",
          "Posting a stock count needs a database that supports transactions, so the whole correction is applied together or not at all.");
      }

      const actor = actorOf(req);
      const session = await mongoose.startSession();
      let posted = null;
      try {
        await session.withTransaction(async () => {
          // Atomically claim the REVIEWED → POSTED transition. Two concurrent
          // posts race here; the loser matches nothing and is refused, so they
          // can never both apply. Claimed leanly and its evidence written back
          // with a guard-free updateOne, so the model's immutable-once-posted
          // save guard is never in tension with the transition that creates it.
          const claimed = await StockCount.findOneAndUpdate(
            { _id: id, companyId: req.tenant.companyId, status: "REVIEWED" },
            { $set: { status: "POSTED", postedAt: new Date(), postedBy: actor.id, postedByName: actor.name } },
            { new: true, session },
          ).lean();
          if (!claimed) throw fail("CONFLICT", "This count was posted by someone else. Reload to see the result.", { reason: "ALREADY_POSTED" });

          const applied = [];
          for (const line of claimed.lines) {
            const r = await count.applyLineCorrection(session, {
              tenant: req.tenant, count: claimed, line, actor, opKey: key, fail,
            });
            if (!r) continue;
            applied.push(r);
            line.posted = {
              applied: true, direction: r.direction, quantity: r.quantity,
              companyBefore: r.companyBefore, companyAfter: r.companyAfter,
              locationBefore: r.locationBefore, locationAfter: r.locationAfter,
              movementId: r.movementId,
            };
          }

          const posting = {
            idempotencyKey: key, requestHash,
            discrepanciesPosted: applied.length,
            linesCounted: (claimed.lines || []).filter((l) => l.counted === true).length,
          };
          // Persist the per-line posted evidence + the receipt in the same commit.
          await StockCount.updateOne(
            { _id: id, companyId: req.tenant.companyId },
            { $set: { lines: claimed.lines, posting } },
            { session },
          );
          posted = { ...claimed, posting };
        });
      } finally {
        await session.endSession().catch(() => {});
      }

      const doc = posted;
      const body = { success: true, replayed: false, count: serialize(doc), outcome: outcomeOf(doc) };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: "STOCK_COUNT", entityId: doc._id })
        : res.json(body);
    } catch (err) { return sendError(res, err); }
  },
);

// The outcome facts for the result screen: what was counted, what posted, and
// the real before→after per applied line (movements link is filtered per item).
function outcomeOf(doc) {
  const all = doc.lines || [];
  const applied = all.filter((l) => l.posted && l.posted.applied);
  // Rows left blank do NOT disappear from the result — they are reported as what
  // they are, so a partially-counted session reads honestly.
  const notCounted = all.filter((l) => l.counted !== true);
  return {
    countNumber: doc.countNumber,
    warehouseName: doc.warehouseName, warehouseShortName: doc.warehouseShortName,
    locationCode: doc.locationCode, locationName: doc.locationName,
    scope: count.countScope(doc),
    totalLines: all.length,
    linesCounted: all.filter((l) => l.counted === true).length,
    linesAdded: all.filter((l) => l.addedDuringCount === true).length,
    notCountedCount: notCounted.length,
    notCounted: notCounted.map((l) => ({
      lineId: String(l._id), rawItemName: l.rawItemName,
      variantCombination: l.variantCombination || [], unit: l.baseUnit || "",
    })),
    discrepanciesPosted: applied.length,
    lines: applied.map((l) => ({
      lineId: String(l._id), rawItemId: String(l.rawItemId), rawItemName: l.rawItemName,
      variantId: l.variantId ? String(l.variantId) : null, variantCombination: l.variantCombination || [],
      unit: l.baseUnit || "",
      direction: l.posted.direction, quantity: l.posted.quantity,
      companyBefore: l.posted.companyBefore, companyAfter: l.posted.companyAfter,
      locationBefore: l.posted.locationBefore, locationAfter: l.posted.locationAfter,
    })),
  };
}

module.exports = router;
