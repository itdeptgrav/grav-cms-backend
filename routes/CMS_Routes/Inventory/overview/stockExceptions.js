// routes/CMS_Routes/Inventory/overview/stockExceptions.js
//
// GET /api/cms/inventory/overview/stock-exceptions
//
// The ONE company-scoped read model behind the Store "Stock exceptions"
// workspace. It tells a Store manager which inventory records cannot currently
// be trusted, grouped into SEPARATE families, and points each at the existing
// workflow that resolves it. It never changes stock and never invents a figure.
//
// FAMILIES (each computed by an existing authority, never a second formula):
//   NEGATIVE_BALANCE          RawItem.quantity / variants.quantity / LocationBalance.onHand < 0
//   BALANCE_MISMATCH          locationStock.reconcile → overAssigned (placed > company)
//   MOVEMENT_UNCERTAIN        StockLedger COMPENSATING, not APPLIED (valuation's own attention rule)
//   RESERVATION_INCONSISTENCY StockReservation pickedQty > active reserved
//   COUNT_PENDING             StockCount in DRAFT/IN_PROGRESS (continue) or REVIEWED (post)
//   UNASSIGNED_PUTAWAY        locationStock.reconcile → placed but some on-hand unassigned
//   VALUATION_COVERAGE        link-only → the Inventory Valuation workspace
//   SHORTAGE                  StockReservation backorderedQty > 0  (a shortage, NOT a balance error)
//
// HONESTY: a family whose query fails is "unavailable" (never 0); tenant scope is
// the caller's company only (never widened to legacy-global); counts are counts,
// never a quantity summed across units; this endpoint performs no writes.

"use strict";

const express = require("express");
const router = express.Router();

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const LocationBalance = require("../../../../models/CMS_Models/Inventory/Operations/LocationBalance");
const StockLedger = require("../../../../models/CMS_Models/Inventory/Operations/StockLedger");
const StockReservation = require("../../../../models/CMS_Models/Inventory/Operations/StockReservation");
const StockCount = require("../../../../models/CMS_Models/Inventory/Operations/StockCount");
const locStock = require("../../../../services/storePurchase/locationStock.service");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { CAPABILITIES } = tenantContext;

router.use(EmployeeAuthMiddleware, requireTenant, requireCapability(CAPABILITIES.READ));

const TOL = 1e-4;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const RECONCILE_CAP = 500;      // bounded per-item scan for the mismatch families
const NEG_CAP = 300;            // bounded merge for the (rare) negative-balance family

// Resolution destinations — every one uses a param the target page actually reads.
const H = {
  ledger: (id) => `/store/dashboard/operations/stock-ledger?item=${id}`,
  count: "/store/dashboard/raw-items/stock-count",
  transfer: (id, v) => `/store/dashboard/raw-items/stock-transfer?itemId=${id}${v ? `&variantId=${v}` : ""}`,
  reservations: (g) => `/store/dashboard/operations/reservations?group=${g}`,
  mrf: (id) => `/store/dashboard/order-requests/mrf/${id}`,
  valuation: "/store/dashboard/operations/inventory-valuation",
};

const unitOf = (it) => it.customUnit || it.unit || "";
const paginate = (arr, page, pageSize) => {
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  return { rows: arr.slice((p - 1) * pageSize, (p - 1) * pageSize + pageSize), total, totalPages, page: p };
};

// ── Negative balances (item / variant / location) — bounded merge ────────────
async function negativeRows(companyId) {
  const [items, variantItems, locs] = await Promise.all([
    RawItem.find({ companyId, quantity: { $lt: 0 } }).select("name sku unit customUnit quantity").limit(NEG_CAP).lean(),
    RawItem.find({ companyId, "variants.quantity": { $lt: 0 } }).select("name sku unit customUnit variants").limit(NEG_CAP).lean(),
    LocationBalance.find({ companyId, onHand: { $lt: 0 } }).select("itemId variantId warehouseId locationId onHand").limit(NEG_CAP).lean(),
  ]);
  const out = [];
  for (const it of items) {
    const unit = unitOf(it);
    out.push({
      key: `neg:item:${it._id}`, family: "NEGATIVE_BALANCE",
      item: { name: it.name, sku: it.sku, rawItemId: String(it._id) },
      figures: [{ label: "On hand", value: r4(it.quantity), unit }],
      explanation: `Company on-hand is ${r4(it.quantity)} ${unit} — below zero, so this record cannot be trusted.`,
      source: "RawItem.quantity", sourceIds: { rawItemId: String(it._id) },
      resolutionHref: H.ledger(it._id), resolutionLabel: "Investigate movements", actionability: "investigation",
      secondaryHref: H.count, secondaryLabel: "Start stock count",
    });
  }
  for (const it of variantItems) {
    const unit = unitOf(it);
    for (const v of (it.variants || [])) {
      if (!(Number(v.quantity) < -TOL)) continue;
      const variant = (v.combination || []).join(" • ");
      out.push({
        key: `neg:variant:${it._id}:${v._id}`, family: "NEGATIVE_BALANCE",
        item: { name: it.name, sku: it.sku, variant, rawItemId: String(it._id), variantId: String(v._id) },
        figures: [{ label: "On hand", value: r4(v.quantity), unit }],
        explanation: `Variant on-hand is ${r4(v.quantity)} ${unit} — below zero.`,
        source: "RawItem.variants.quantity", sourceIds: { rawItemId: String(it._id), variantId: String(v._id) },
        resolutionHref: H.ledger(it._id), resolutionLabel: "Investigate movements", actionability: "investigation",
        secondaryHref: H.count, secondaryLabel: "Start stock count",
      });
    }
  }
  if (locs.length) {
    const itemMap = new Map((await RawItem.find({ companyId, _id: { $in: [...new Set(locs.map((l) => String(l.itemId)))] } }).select("name sku unit customUnit").lean()).map((i) => [String(i._id), i]));
    for (const l of locs) {
      const it = itemMap.get(String(l.itemId));
      const unit = it ? unitOf(it) : "";
      out.push({
        key: `neg:loc:${l._id}`, family: "NEGATIVE_BALANCE",
        item: { name: it?.name || "Unknown item", sku: it?.sku || "", rawItemId: String(l.itemId), variantId: l.variantId ? String(l.variantId) : null },
        location: { warehouseId: String(l.warehouseId), locationId: String(l.locationId) },
        figures: [{ label: "On hand at location", value: r4(l.onHand), unit }],
        explanation: `A location holds ${r4(l.onHand)} ${unit} — a location balance below zero.`,
        source: "LocationBalance.onHand", sourceIds: { locationBalanceId: String(l._id), rawItemId: String(l.itemId) },
        resolutionHref: H.ledger(l.itemId), resolutionLabel: "Investigate movements", actionability: "investigation",
        secondaryHref: H.count, secondaryLabel: "Start stock count",
      });
    }
  }
  return { rows: out, capped: items.length >= NEG_CAP || variantItems.length >= NEG_CAP || locs.length >= NEG_CAP };
}

// ── The reconcile scan → BALANCE_MISMATCH (overAssigned) + UNASSIGNED_PUTAWAY ─
async function reconcileScan(companyId) {
  const items = await RawItem.find({ companyId }).select("name sku unit customUnit quantity").sort({ updatedAt: -1 }).limit(RECONCILE_CAP).lean();
  const ids = items.map((i) => i._id);
  const balances = ids.length
    ? await LocationBalance.find({ companyId, itemId: { $in: ids }, locationId: { $ne: null } }).select("itemId onHand").lean()
    : [];
  const byItem = new Map();
  for (const b of balances) { const k = String(b.itemId); if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(b); }
  const mismatch = [], unassigned = [];
  for (const it of items) {
    const unit = unitOf(it);
    const rows = byItem.get(String(it._id)) || [];
    if (!rows.length) continue;                 // never-placed items are not a placement exception
    const rec = locStock.reconcile({ onHand: it.quantity || 0, balances: rows });
    if (rec.overAssigned) {
      mismatch.push({
        key: `mismatch:${it._id}`, family: "BALANCE_MISMATCH",
        item: { name: it.name, sku: it.sku, rawItemId: String(it._id) },
        figures: [{ label: "Company on-hand", value: r4(rec.onHand), unit }, { label: "Placed in locations", value: r4(rec.assigned), unit }],
        explanation: `Company on-hand is ${r4(rec.onHand)} ${unit}, but locations total ${r4(rec.assigned)} ${unit}. The authorities disagree.`,
        source: "locationStock.reconcile (placed > company on-hand)", sourceIds: { rawItemId: String(it._id) },
        resolutionHref: H.ledger(it._id), resolutionLabel: "Investigate movements", actionability: "investigation",
        secondaryHref: H.count, secondaryLabel: "Start stock count",
      });
    } else if (rec.assigned > TOL && rec.unassigned > TOL) {
      unassigned.push({
        key: `unassigned:${it._id}`, family: "UNASSIGNED_PUTAWAY",
        item: { name: it.name, sku: it.sku, rawItemId: String(it._id) },
        figures: [{ label: "Unassigned", value: r4(rec.unassigned), unit }, { label: "Company on-hand", value: r4(rec.onHand), unit }],
        explanation: `${r4(rec.unassigned)} ${unit} are on hand but have not been assigned to a location — put them away.`,
        source: "locationStock.reconcile (company on-hand > placed)", sourceIds: { rawItemId: String(it._id) },
        resolutionHref: H.transfer(it._id), resolutionLabel: "Put away / transfer", actionability: "actionable",
      });
    }
  }
  return { mismatch, unassigned, capped: items.length >= RECONCILE_CAP };
}

// ── Movement / correction uncertainty (StockLedger) ──────────────────────────
async function movementRows(companyId, page, pageSize) {
  const q = { companyId, txnType: "COMPENSATING", isVoided: false, applicationState: { $ne: "APPLIED" } };
  const total = await StockLedger.countDocuments(q);
  const docs = await StockLedger.find(q).select("rawItem variantId correctionReason applicationState createdAt compensatingFor").sort({ createdAt: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
  const itemMap = new Map((await RawItem.find({ companyId, _id: { $in: [...new Set(docs.map((d) => String(d.rawItem)))] } }).select("name sku unit customUnit").lean()).map((i) => [String(i._id), i]));
  const rows = docs.map((d) => {
    const it = itemMap.get(String(d.rawItem));
    return {
      key: `move:${d._id}`, family: "MOVEMENT_UNCERTAIN",
      item: { name: it?.name || "Unknown item", sku: it?.sku || "", rawItemId: String(d.rawItem), variantId: d.variantId ? String(d.variantId) : null },
      figures: [],
      explanation: "This correction was recorded, but its stock effect could not be confirmed.",
      source: "StockLedger (COMPENSATING, not applied)", sourceIds: { stockLedgerId: String(d._id), compensatingFor: d.compensatingFor ? String(d.compensatingFor) : null },
      lastObserved: d.createdAt || null,
      resolutionHref: H.ledger(d.rawItem), resolutionLabel: "Open movement history", actionability: "read_only",
    };
  });
  return { total, rows };
}

// ── Reservation inconsistency: picked > active reserved (within the record) ───
async function reservationInconsistencyRows(companyId, page, pageSize) {
  const q = { companyId, active: true, $expr: { $gt: ["$pickedQty", { $subtract: ["$reservedQty", { $add: [{ $ifNull: ["$issuedQty", 0] }, { $ifNull: ["$releasedQty", 0] }] }] }] } };
  const total = await StockReservation.countDocuments(q);
  const docs = await StockReservation.find(q).select("mrfNumber mrfId itemName sku unit pickedQty reservedQty issuedQty releasedQty updatedAt").sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
  const rows = docs.map((d) => {
    const active = r4((d.reservedQty || 0) - (d.issuedQty || 0) - (d.releasedQty || 0));
    return {
      key: `resincon:${d._id}`, family: "RESERVATION_INCONSISTENCY",
      item: { name: d.itemName || "—", sku: d.sku || "" },
      figures: [{ label: "Picked", value: r4(d.pickedQty), unit: d.unit || "" }, { label: "Active reserved", value: active, unit: d.unit || "" }],
      explanation: `${r4(d.pickedQty)} ${d.unit || ""} are marked picked but only ${active} ${d.unit || ""} are actively reserved.`,
      source: "StockReservation (picked > active reserved)", sourceIds: { reservationId: String(d._id), mrfId: d.mrfId ? String(d.mrfId) : null },
      lastObserved: d.updatedAt || null,
      resolutionHref: d.mrfId ? H.mrf(d.mrfId) : H.reservations("PARTLY_ISSUED"), resolutionLabel: "Open request", actionability: "investigation",
    };
  });
  return { total, rows };
}

// ── Counts to resolve (open → continue; reviewed → post) ─────────────────────
async function countRows(companyId, page, pageSize) {
  const q = { companyId, status: { $in: StockCount.OPEN_STATUSES } };
  const total = await StockCount.countDocuments(q);
  const docs = await StockCount.find(q).select("countNumber warehouseName status createdAt").sort({ createdAt: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
  const rows = docs.map((d) => {
    const reviewed = d.status === "REVIEWED";
    return {
      key: `count:${d._id}`, family: "COUNT_PENDING",
      item: { name: d.countNumber || "Stock count", sku: "" },
      location: d.warehouseName ? { warehouseName: d.warehouseName } : null,
      figures: [],
      explanation: reviewed ? "This stock count has been reviewed and is waiting to be posted." : "This stock count is still open and needs to be completed.",
      source: `StockCount (${d.status})`, sourceIds: { stockCountId: String(d._id) },
      lastObserved: d.createdAt || null,
      resolutionHref: H.count, resolutionLabel: reviewed ? "Review & post count" : "Continue count", actionability: "actionable",
    };
  });
  return { total, rows };
}

// ── Stock shortage (backorder) — operational, NOT a balance error ────────────
async function shortageRows(companyId, page, pageSize) {
  const q = { companyId, active: true, backorderedQty: { $gt: 0 } };
  const total = await StockReservation.countDocuments(q);
  const docs = await StockReservation.find(q).select("mrfNumber mrfId itemName sku unit requestedQty reservedQty backorderedQty updatedAt").sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
  const rows = docs.map((d) => ({
    key: `short:${d._id}`, family: "SHORTAGE",
    item: { name: d.itemName || "—", sku: d.sku || "" },
    figures: [{ label: "Backordered", value: r4(d.backorderedQty), unit: d.unit || "" }, { label: "Reserved", value: r4(d.reservedQty), unit: d.unit || "" }],
    explanation: `${r4(d.backorderedQty)} ${d.unit || ""} are short of stock — a purchasing signal, not a balance error.`,
    source: "StockReservation (backorderedQty > 0)", sourceIds: { reservationId: String(d._id), mrfId: d.mrfId ? String(d.mrfId) : null },
    lastObserved: d.updatedAt || null,
    resolutionHref: H.reservations("BACKORDERED"), resolutionLabel: "Open reservations", actionability: "actionable",
  }));
  return { total, rows };
}

// A family summary + a way to fetch its paginated rows.
function familyEntry({ available = true, count = null, capped = false, linkOnly = false, href = null, source = null, unavailableReason = null }) {
  if (!available) return { available: false, unavailableReason };
  if (linkOnly) return { available: true, linkOnly: true, href, source };
  return { available: true, count, capped, href, source };
}

router.get("/", async (req, res) => {
  try {
    const companyId = req.tenant.companyId;   // caller's company ONLY — never legacy-global
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const wantFamily = typeof req.query.family === "string" ? req.query.family : "";

    // Wrap each source so a failure becomes "unavailable", never a silent zero.
    const safe = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { console.error("[stock-exceptions]", e.message); return { ok: false }; } };

    const [neg, recon, moveCount, resInconCount, cntCount, shortCount] = await Promise.all([
      safe(() => negativeRows(companyId)),
      safe(() => reconcileScan(companyId)),
      safe(() => StockLedger.countDocuments({ companyId, txnType: "COMPENSATING", isVoided: false, applicationState: { $ne: "APPLIED" } })),
      safe(() => StockReservation.countDocuments({ companyId, active: true, $expr: { $gt: ["$pickedQty", { $subtract: ["$reservedQty", { $add: [{ $ifNull: ["$issuedQty", 0] }, { $ifNull: ["$releasedQty", 0] }] }] }] } })),
      safe(() => StockCount.countDocuments({ companyId, status: { $in: StockCount.OPEN_STATUSES } })),
      safe(() => StockReservation.countDocuments({ companyId, active: true, backorderedQty: { $gt: 0 } })),
    ]);

    const families = {
      NEGATIVE_BALANCE: neg.ok
        ? familyEntry({ count: neg.value.rows.length, capped: neg.value.capped, source: "RawItem / LocationBalance below zero" })
        : familyEntry({ available: false, unavailableReason: "Negative-balance checks could not be run." }),
      BALANCE_MISMATCH: recon.ok
        ? familyEntry({ count: recon.value.mismatch.length, capped: recon.value.capped, source: "Location reconciliation (placed > company)" })
        : familyEntry({ available: false, unavailableReason: "Location reconciliation could not be run." }),
      MOVEMENT_UNCERTAIN: moveCount.ok
        ? familyEntry({ count: moveCount.value, source: "StockLedger corrections not yet applied" })
        : familyEntry({ available: false, unavailableReason: "Movement corrections could not be read." }),
      RESERVATION_INCONSISTENCY: resInconCount.ok
        ? familyEntry({ count: resInconCount.value, source: "StockReservation picked > active reserved" })
        : familyEntry({ available: false, unavailableReason: "Reservations could not be read." }),
      COUNT_PENDING: cntCount.ok
        ? familyEntry({ count: cntCount.value, source: "StockCount open / reviewed" })
        : familyEntry({ available: false, unavailableReason: "Stock counts could not be read." }),
      UNASSIGNED_PUTAWAY: recon.ok
        ? familyEntry({ count: recon.value.unassigned.length, capped: recon.value.capped, source: "Location reconciliation (company > placed)" })
        : familyEntry({ available: false, unavailableReason: "Location reconciliation could not be run." }),
      // Valuation coverage is reviewed in its own workspace — a link, not a rerun
      // of the valuation engine on this page.
      VALUATION_COVERAGE: familyEntry({ linkOnly: true, href: H.valuation, source: "Inventory Valuation workspace" }),
      SHORTAGE: shortCount.ok
        ? familyEntry({ count: shortCount.value, source: "StockReservation backordered" })
        : familyEntry({ available: false, unavailableReason: "Reservations could not be read." }),
    };

    // Pick the family whose rows to return: the requested one, else the highest-
    // severity family that is actionable/active.
    const severityOrder = ["NEGATIVE_BALANCE", "BALANCE_MISMATCH", "MOVEMENT_UNCERTAIN", "RESERVATION_INCONSISTENCY", "COUNT_PENDING", "UNASSIGNED_PUTAWAY", "SHORTAGE"];
    const activeKeys = severityOrder.filter((k) => families[k].available && families[k].count > 0);
    const selected = (wantFamily && severityOrder.includes(wantFamily)) ? wantFamily : (activeKeys[0] || null);

    // A DB-paginated {total, rows} result → the uniform page shape.
    const dbPage = (result) => ({ rows: result.rows, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)), page });

    let rowsPage = { rows: [], total: 0, totalPages: 1, page: 1 };
    if (selected && families[selected].available) {
      if (selected === "NEGATIVE_BALANCE" && neg.ok) rowsPage = paginate(neg.value.rows, page, pageSize);
      else if (selected === "BALANCE_MISMATCH" && recon.ok) rowsPage = paginate(recon.value.mismatch, page, pageSize);
      else if (selected === "UNASSIGNED_PUTAWAY" && recon.ok) rowsPage = paginate(recon.value.unassigned, page, pageSize);
      else if (selected === "MOVEMENT_UNCERTAIN") rowsPage = dbPage(await movementRows(companyId, page, pageSize));
      else if (selected === "RESERVATION_INCONSISTENCY") rowsPage = dbPage(await reservationInconsistencyRows(companyId, page, pageSize));
      else if (selected === "COUNT_PENDING") rowsPage = dbPage(await countRows(companyId, page, pageSize));
      else if (selected === "SHORTAGE") rowsPage = dbPage(await shortageRows(companyId, page, pageSize));
    }

    // Optional in-page text search over the returned page's rows (identity only).
    let outRows = rowsPage.rows;
    if (search) outRows = outRows.filter((r) => [r.item?.name, r.item?.sku, r.location?.warehouseName].filter(Boolean).some((s) => String(s).toLowerCase().includes(search)));

    const summaryTotal = severityOrder.reduce((t, k) => t + (families[k].available && typeof families[k].count === "number" ? families[k].count : 0), 0);
    const anyCapped = (neg.ok && neg.value.capped) || (recon.ok && recon.value.capped);

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      families,
      selectedFamily: selected,
      rows: outRows,
      pagination: { page: rowsPage.page, pageSize, total: rowsPage.total, totalPages: rowsPage.totalPages },
      summary: {
        total: summaryTotal,
        // The summary total is a cheap, authoritative sum of the family counts —
        // safe to show on the Store home. Ordering within a family is by oldest
        // unresolved evidence where a real date exists, else most-recently changed.
        countCheap: true,
        ordering: "family severity, then oldest reliable evidence (createdAt/updatedAt)",
      },
      coverage: {
        capped: anyCapped,
        reconcileScanCap: RECONCILE_CAP,
        note: anyCapped ? "Placement/negative checks inspect the most recent records; open a family for the full paged list." : null,
      },
    });
  } catch (error) {
    console.error("[stock-exceptions] failed:", error);
    res.status(500).json({ success: false, message: "The stock-exceptions overview could not be read." });
  }
});

module.exports = router;
