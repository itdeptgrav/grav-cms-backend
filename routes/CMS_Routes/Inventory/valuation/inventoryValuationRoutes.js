// routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes.js
//
// Inventory Valuation V1 — read-only, company-scoped valuation API.
// Mount: app.use("/api/cms/inventory/valuation", require("./routes/..."))
//
// Every figure comes from ONE engine (services/inventoryValuation.service.js);
// this router only fetches the company's items (tenant-scoped, lean), merges
// each item's compensating corrections into its movement stream so replay can
// reconcile, and paginates. It NEVER writes.

const express = require("express");
const router = express.Router();

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockLedger = require("../../../../models/CMS_Models/Inventory/Operations/StockLedger");
const LandedCostAllocation = require("../../../../models/CMS_Models/Inventory/Valuation/LandedCostAllocation");
const { Acc_Voucher } = require("../../../../models/Accountant_model/Acc_VoucherModels");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const {
  valueItem,
  summarizeValued,
  matchesStatus,
  STATUS,
  VALUATION_PROJECTION,
} = require("../../../../services/inventoryValuation.service");

router.use(EmployeeAuth);
router.use(requireTenant);

// The one line the report and this API both show. Kept here so the honesty
// statement lives with the numbers it qualifies.
const LANDED_COST_NOTE =
  "Weighted-average value is derived from recorded stock receipts and movements. GST, freight and other landed costs are not included unless they are present in the recorded unit cost.";

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Tenant-scoped filter with an optional extra clause, `$and`-merged so a search
// `$or` cannot silently widen the company boundary.
const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

// Search + category → a Mongo clause (indexable), so browsing pages in the DB.
function queryClause(req) {
  const extra = {};
  const search = (req.query.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    extra.$or = [{ name: rx }, { sku: rx }];
  }
  const category = (req.query.category || "").trim();
  if (category && category !== "all") extra.category = category;
  return Object.keys(extra).length ? scoped(req, extra) : scoped(req);
}

// A StockLedger COMPENSATING correction is a quantity fix with a direction and
// no captured cost. Map it into the movement stream so replay reconciles with
// the corrected balance: a credit adds (unvalued) quantity, a debit removes at
// the moving average — its real direction, applied exactly once.
function compensatingToMovements(rows) {
  return (rows || []).map((r) => ({
    _id: r._id,
    type: r.direction === "CREDIT" ? "ADD" : "REDUCE",
    quantity: r.quantity,
    variantId: r.variantId || null,
    reason: "Correction (compensating)",
    createdAt: r.createdAt || r.editedAt || null,
  }));
}

// Fetch compensating corrections for a set of item ids, grouped by item and
// split by whether they were actually APPLIED to stock. A correction row starts
// as a PENDING claim and may never move stock; only `applicationState:"APPLIED"`
// rows enter the movement stream. PENDING / unknown-state rows change nothing,
// but are surfaced as attention evidence.
async function compensatingByItem(itemIds) {
  const applied = new Map();
  const pendingCount = new Map();
  if (!itemIds.length) return { applied, pendingCount };
  const rows = await StockLedger.find({
    rawItem: { $in: itemIds },
    txnType: "COMPENSATING",
  })
    .select("rawItem variantId direction quantity createdAt editedAt applicationState")
    .lean();
  for (const r of rows) {
    const k = String(r.rawItem);
    if (r.applicationState === "APPLIED") {
      if (!applied.has(k)) applied.set(k, []);
      applied.get(k).push(r);
    } else {
      // PENDING, undefined (legacy) or any non-APPLIED value — never merged.
      pendingCount.set(k, (pendingCount.get(k) || 0) + 1);
    }
  }
  return { applied, pendingCount };
}

// Active landed-cost allocations for these items, keyed for the engine's
// overlay: itemId → Map(movementId → { perUnit, sources[] }). Only allocations
// whose SOURCE VOUCHER is currently posted contribute — a cancelled/void
// voucher's allocation is excluded by authoritative status without deleting it.
async function landedByItem(companyId, itemIds) {
  const out = new Map();
  if (!companyId || !itemIds.length) return out;
  const allocs = await LandedCostAllocation.find({
    companyId,
    status: "active",
    "targets.itemId": { $in: itemIds },
  }).lean();
  if (!allocs.length) return out;
  const voucherIds = [...new Set(allocs.map((a) => String(a.sourceVoucherId)))];
  const vouchers = await Acc_Voucher.find({ _id: { $in: voucherIds } })
    .select("status")
    .lean();
  const postedVoucher = new Set(
    vouchers.filter((v) => v.status === "posted").map((v) => String(v._id)),
  );
  for (const a of allocs) {
    if (!postedVoucher.has(String(a.sourceVoucherId))) continue; // excluded by status
    for (const t of a.targets || []) {
      const itemKey = String(t.itemId);
      if (!out.has(itemKey)) out.set(itemKey, new Map());
      const mm = out.get(itemKey);
      const mid = String(t.movementId);
      const prev = mm.get(mid) || { perUnit: 0, sources: [] };
      prev.perUnit += Number(t.allocatedPerUnit) || 0;
      prev.sources.push({
        allocationId: String(a._id),
        voucherId: String(a.sourceVoucherId),
        voucherNumber: a.sourceVoucherNumber || "",
      });
      mm.set(mid, prev);
    }
  }
  return out;
}

// Attach ONLY applied compensating movements and value each item; pending
// corrections are passed as a count so they show as attention, not as stock.
// `landed` (itemId → movement landed map) overlays landed cost onto receipts.
function valueAll(items, comp, landed, withVariants) {
  const applied = comp.applied || new Map();
  const pendingCount = comp.pendingCount || new Map();
  const landedMap = landed || new Map();
  return items.map((it) => {
    const key = String(it._id);
    const rows = applied.get(key) || [];
    const merged = rows.length
      ? { ...it, stockTransactions: [...(it.stockTransactions || []), ...compensatingToMovements(rows)] }
      : it;
    return valueItem(merged, {
      withVariants,
      pendingCorrectionCount: pendingCount.get(key) || 0,
      landedByMovement: landedMap.get(key) || new Map(),
    });
  });
}

// Attention rank for the "needs attention" sort — worst first.
const attentionRank = (v) => (!v.reconciled ? 3 : v.hasExceptions ? 2 : !v.fullyValued ? 1 : 0);

function sortValued(rows, sort, dir) {
  const s = String(sort || "item");
  const d = dir === "asc" ? 1 : -1;
  const cmp = {
    item: (a, b) => (a.name || a.sku).localeCompare(b.name || b.sku) * (dir === "desc" ? -1 : 1),
    value: (a, b) => ((a.knownValue || 0) - (b.knownValue || 0)) * d,
    attention: (a, b) => (attentionRank(a) - attentionRank(b)) * d || (a.name || "").localeCompare(b.name || ""),
  }[s] || null;
  if (cmp) rows.sort(cmp);
  return rows;
}

const pageInt = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return max ? Math.min(n, max) : n;
};

// ── GET / — paginated, filtered, sorted valuation rows ───────────────────────
router.get("/", async (req, res) => {
  try {
    const page = pageInt(req.query.page, 1);
    const limit = pageInt(req.query.limit, 20, 100);
    const status = req.query.status;
    const sort = req.query.sort || "item";
    const dir = req.query.dir || (sort === "item" ? "asc" : "desc");
    const withVariants = req.query.withVariants === "true" || req.query.withVariants === "1";
    const clause = queryClause(req);

    const needsFullScan =
      (status && status !== "all") || sort === "value" || sort === "attention";

    let rows;
    let total;
    if (!needsFullScan) {
      // Default browse path — page in the database (skip/limit), value only
      // the page.
      total = await RawItem.countDocuments(clause);
      const mongoSort = { [sort === "sku" ? "sku" : "name"]: dir === "desc" ? -1 : 1 };
      const items = await RawItem.find(clause)
        .select(VALUATION_PROJECTION)
        .sort(mongoSort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
      const ids = items.map((i) => i._id);
      const [compMap, landed] = await Promise.all([
        compensatingByItem(ids),
        landedByItem(req.tenant && req.tenant.companyId, ids),
      ]);
      rows = valueAll(items, compMap, landed, withVariants);
    } else {
      // Analytic path — status filter or value/attention sort need every item
      // valued. Still scoped to this company and never shipped whole to the
      // browser: we value server-side, then return only the requested page.
      const items = await RawItem.find(clause).select(VALUATION_PROJECTION).lean();
      const ids = items.map((i) => i._id);
      const [compMap, landed] = await Promise.all([
        compensatingByItem(ids),
        landedByItem(req.tenant && req.tenant.companyId, ids),
      ]);
      let valued = valueAll(items, compMap, landed, withVariants);
      if (status && status !== "all") valued = valued.filter((v) => matchesStatus(v, status));
      sortValued(valued, sort, dir);
      total = valued.length;
      rows = valued.slice((page - 1) * limit, (page - 1) * limit + limit);
    }

    res.json({
      success: true,
      items: rows,
      pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
      note: LANDED_COST_NOTE,
    });
  } catch (e) {
    console.error("[inventory-valuation] list:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// The company-scoped summary, computed the ONE way. Exported so the Store
// overview consumes the identical valuation answer (never a second formula).
async function summarizeCompany(clause, companyId) {
  const items = await RawItem.find(clause).select(VALUATION_PROJECTION).lean();
  const ids = items.map((i) => i._id);
  const [compMap, landed] = await Promise.all([
    compensatingByItem(ids),
    landedByItem(companyId, ids),
  ]);
  const valued = valueAll(items, compMap, landed, false);
  return { summary: summarizeValued(valued), valued };
}

// ── GET /summary — company totals, honest about what is excluded ─────────────
router.get("/summary", async (req, res) => {
  try {
    const { summary } = await summarizeCompany(queryClause(req), req.tenant && req.tenant.companyId);
    res.json({ success: true, summary, note: LANDED_COST_NOTE });
  } catch (e) {
    console.error("[inventory-valuation] summary:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /item/:id — one item's valuation with variant evidence ───────────────
router.get("/item/:id", async (req, res) => {
  try {
    const item = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .select(VALUATION_PROJECTION)
      .lean();
    if (!item) return res.status(404).json({ success: false, message: "Item not found." });
    const [compMap, landed] = await Promise.all([
      compensatingByItem([item._id]),
      landedByItem(req.tenant && req.tenant.companyId, [item._id]),
    ]);
    const [valued] = valueAll([item], compMap, landed, true);
    res.json({ success: true, valuation: valued, note: LANDED_COST_NOTE });
  } catch (e) {
    console.error("[inventory-valuation] item:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
module.exports.LANDED_COST_NOTE = LANDED_COST_NOTE;
module.exports.summarizeCompany = summarizeCompany;
