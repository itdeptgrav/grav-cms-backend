// routes/CMS_Routes/Inventory/overview/stock.js
//
// GET /api/cms/inventory/overview/stock
//
// The ONE company-scoped read model behind the Store "Stock" register — the
// authoritative answer to "what material do we physically hold, how much of it
// is available or reserved, whose material is it, and where is it stored?".
//
// It is READ-ONLY and it is NOT a second stock engine. Every figure is READ
// from the authority that already owns it; this endpoint only composes them into
// one per-item row so the browser makes ONE request instead of N:
//
//   physical on-hand   RawItem.quantity            — the honest physical total a
//                                                     stock-take should find (the
//                                                     model's own words); it
//                                                     INCLUDES customer material.
//   customer-owned     CustomerMaterialLot         — Σ availableQuantity (HELD),
//                                                     the lot's own authoritative
//                                                     held balance, in base units.
//   company-owned      = physical − customer-owned — ownership PARTITIONS the
//                                                     physical total; the whole
//                                                     quantity is never labelled
//                                                     company-owned.
//   reserved           LocationReservation.reserved — Σ over the item's locations
//                                                     (base units).
//   available          reservation rule            — Σ over USABLE locations of
//                                                     max(0, onHand − reserved),
//                                                     using the reservation
//                                                     service's own usable-location
//                                                     policy. Never the raw total,
//                                                     never unassigned/quarantine.
//   location coverage  LocationBalance (+ Warehouse) — per-location on-hand, the
//                                                     main location, the count of
//                                                     others, quarantine/receiving,
//                                                     and locationStock.reconcile's
//                                                     unassigned quantity.
//
// HONESTY (the same contract the overview/stock-exceptions read model keeps):
//   · tenant scope is the caller's company ONLY — never widened to legacy-global;
//   · a dimension whose read FAILS is "unavailable", never a silent zero — a
//     failed reservation read must not make stock look free, and a failed read of
//     the whole page must not look like an empty warehouse;
//   · a measured zero (out of stock) is a real answer and is reported as such;
//   · unlike units are NEVER summed — every row is ONE item in ONE base unit, and
//     there is no cross-item quantity total anywhere in the response;
//   · unassigned / quarantine / receiving stock is shown, never hidden and never
//     counted as available-at-a-usable-location;
//   · this endpoint performs no writes.

"use strict";

const express = require("express");
const router = express.Router();

const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const LocationBalance = require("../../../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationReservation = require("../../../../models/CMS_Models/Inventory/Operations/LocationReservation");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const { CustomerMaterialLot } = require("../../../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const locStock = require("../../../../services/storePurchase/locationStock.service");
const reservationSvc = require("../../../../services/storePurchase/reservation.service");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { CAPABILITIES } = tenantContext;

router.use(EmployeeAuthMiddleware, requireTenant, requireCapability(CAPABILITIES.READ));

const TOL = 1e-4;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
// A bounded scan so ownership/state filters can be applied server-side over the
// whole matching set and paginated honestly, without ever shipping the catalogue
// to the browser. The same bounded-scan idea the exceptions/valuation read models
// use; when it bites, `coverage.capped` says so out loud.
const SCAN_CAP = 1000;
const COMBO_LIMIT = 4;               // variant combinations named inline before "+N more"

const OWNERSHIP_FILTERS = new Set(["all", "company", "customer", "mixed"]);
const STATE_FILTERS = new Set([
  "all", "available", "fully_reserved", "unassigned", "not_usable", "out_of_stock",
]);
// The attention LENSES — a READ-ONLY slice over the rows this endpoint already
// computes (no new arithmetic, no reservation/movement/write change). Each reuses
// the very fields the rows already carry, so a lens is always exactly consistent
// with the register beneath it and is server-driven (never a page-only client cut).
const LENS_FILTERS = new Set(["all", "needs_storage", "needs_review", "customer", "low_stock"]);
const lensMatch = (lens) => {
  if (lens === "needs_storage") return (r) => r.stockState === "unassigned";
  if (lens === "needs_review") return (r) => r.stockState === "not_usable" || (r.ownership && r.ownership.label === "indeterminate");
  if (lens === "customer") return (r) => Boolean(r.ownership && r.ownership.hasCustomerOwned);
  // The reorder rule the Materials catalogue used to monitor (rawItems.computeStatus):
  // held but at or below the item's own minimum. Out-of-stock stays its own state.
  if (lens === "low_stock") return (r) => r.reorder && r.reorder.low === true;
  return () => true;
};

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const key = (w, l) => `${String(w)}:${String(l)}`;
const baseUnitOf = (it) => (it && (it.customUnit || it.unit)) || "";
const comboLabel = (v) => (Array.isArray(v?.combination) ? v.combination.filter(Boolean).join(" • ") : "");

// A source read wrapped so a failure is "unavailable", never a silent zero.
async function safe(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { console.error("[inventory-stock]", e && e.message); return { ok: false, value: null }; }
}

// ── OWNERSHIP: physical is company + customer; customer property is the lot's own
//    held balance, and company-owned is the remainder. Never the whole quantity. ─
function ownershipOf(physicalOnHand, customerHeld, dimOk) {
  if (!dimOk) {
    return { available: false, companyOwnedOnHand: null, customerOwnedOnHand: null, hasCustomerOwned: null, label: null, limitation: null };
  }
  const physical = r4(physicalOnHand);
  const customer = r4(Math.max(0, customerHeld));
  // Customer material recorded as held cannot exceed the physical total on the
  // shelf. If a data gap makes it so, we do NOT invent a negative company figure —
  // we report the split as not reliably determinable and say why.
  if (customer - physical > TOL) {
    return {
      available: true,
      companyOwnedOnHand: null,
      customerOwnedOnHand: customer,
      hasCustomerOwned: true,
      label: "indeterminate",
      limitation: "Recorded customer-held material exceeds the physical total — the company/customer split cannot be stated reliably for this item.",
    };
  }
  const company = r4(Math.max(0, physical - customer));
  let label;
  if (customer <= TOL) label = "company";
  else if (company <= TOL) label = "customer";
  else label = "mixed";
  return { available: true, companyOwnedOnHand: company, customerOwnedOnHand: customer, hasCustomerOwned: customer > TOL, label, limitation: null };
}

// ── STOCK STATE: derived from the composed figures + flags, priority-ordered.
//    Genuine zero, not-yet-put-away, quarantine/receiving-only, all-reserved and
//    available are four different situations and each sends a reader somewhere
//    different. "partial" rides alongside when a dimension could not be read. ─
function stockStateOf({ physicalOnHand, locationOk, availableOk, available, usableOnHand, assigned, unassigned, notUsable }) {
  if (r4(physicalOnHand) <= TOL) return "out_of_stock";           // a measured zero
  // Without location OR availability we still know it is physically in stock; we
  // do not over-claim which bin or how much is free.
  if (!locationOk) return "in_stock";
  if (r4(assigned) <= TOL && r4(physicalOnHand) > TOL) return "unassigned";  // held, none put away
  if (r4(usableOnHand) <= TOL && r4(notUsable) > TOL) return "not_usable";    // only in quarantine/receiving
  if (r4(unassigned) > TOL && r4(usableOnHand) <= TOL) return "unassigned";
  if (availableOk) {
    if (r4(available) > TOL) return "available";
    if (r4(usableOnHand) > TOL) return "fully_reserved";           // usable exists but all reserved
  }
  return "in_stock";
}

router.get("/", async (req, res) => {
  try {
    const companyId = req.tenant.companyId;         // caller's company ONLY
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    // Invalid filter values fail SAFE: they fall back to "all" rather than 500.
    const ownershipFilter = OWNERSHIP_FILTERS.has(req.query.ownership) ? req.query.ownership : "all";
    const stateFilter = STATE_FILTERS.has(req.query.state) ? req.query.state : "all";
    const lens = LENS_FILTERS.has(req.query.lens) ? req.query.lens : "all";

    // ── The item set (bounded scan, tenant-scoped, optional search) ──────────
    const clause = { companyId };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      clause.$and = [{ $or: [{ name: rx }, { sku: rx }] }];  // $and keeps the boundary intact
    }
    const matchingSearch = await RawItem.countDocuments(clause);
    const items = await RawItem.find(clause)
      .select("name sku unit customUnit quantity minStock variants")
      .sort({ name: 1 })
      .limit(SCAN_CAP)
      .lean();
    const capped = items.length >= SCAN_CAP;
    const ids = items.map((i) => i._id);

    // ── Bulk enrichment — ONE query per dimension over the scanned ids ───────
    const [lots, reservations, balances] = await Promise.all([
      safe(() => CustomerMaterialLot.find({ companyId, rawItemId: { $in: ids }, status: "HELD" })
        .select("rawItemId variantId availableQuantity").lean()),
      safe(() => LocationReservation.find({ companyId, itemId: { $in: ids } })
        .select("itemId variantId warehouseId locationId reserved").lean()),
      safe(() => LocationBalance.find({ companyId, itemId: { $in: ids } })
        .select("itemId variantId warehouseId locationId onHand").lean()),
    ]);

    // Warehouses are fetched by the ids the balances actually reference — so a
    // legacy warehouse (companyId absent) is still classified — and give each
    // location its TYPE and label. One bounded query.
    let warehouseMap = new Map();      // "wh:loc" -> { type, code, name, warehouseName, warehouseShortName, usable }
    let whOk = true;
    if (balances.ok && balances.value.length) {
      const whIds = [...new Set(balances.value.map((b) => b.warehouseId).filter(Boolean).map(String))];
      const wRes = await safe(() => Warehouse.find({ _id: { $in: whIds } }).select("name shortName status locations").lean());
      whOk = wRes.ok;
      if (wRes.ok) {
        for (const w of wRes.value) {
          const usableLocs = new Set(reservationSvc.usableLocationsOf(w).map((c) => String(c.location._id)));
          for (const loc of (w.locations || [])) {
            warehouseMap.set(key(w._id, loc._id), {
              type: loc.type || "",
              code: loc.code || "",
              name: loc.name || "",
              warehouseName: w.name || "",
              warehouseShortName: w.shortName || "",
              usable: usableLocs.has(String(loc._id)),
            });
          }
        }
      }
    }

    // Group the bulk rows by item id (and, where it matters, by variant/location).
    const custByItem = new Map();      // itemId -> Σ availableQuantity (HELD)
    if (lots.ok) for (const l of lots.value) custByItem.set(String(l.rawItemId), r4((custByItem.get(String(l.rawItemId)) || 0) + (l.availableQuantity || 0)));
    const resByItemLoc = new Map();    // itemId -> Map("wh:loc" -> reserved)
    const resByItem = new Map();       // itemId -> Σ reserved
    if (reservations.ok) for (const rr of reservations.value) {
      const k = String(rr.itemId);
      if (!resByItemLoc.has(k)) resByItemLoc.set(k, new Map());
      const m = resByItemLoc.get(k);
      m.set(key(rr.warehouseId, rr.locationId), r4((m.get(key(rr.warehouseId, rr.locationId)) || 0) + (rr.reserved || 0)));
      resByItem.set(k, r4((resByItem.get(k) || 0) + (rr.reserved || 0)));
    }
    const balByItem = new Map();       // itemId -> [rows] (locations only, onHand>tol)
    if (balances.ok) for (const b of balances.value) {
      if (!b.locationId) continue;     // the assigned-total sentinel is not a location
      if (!(Math.abs(b.onHand) > TOL)) continue;
      const k = String(b.itemId);
      if (!balByItem.has(k)) balByItem.set(k, []);
      balByItem.get(k).push(b);
    }

    const ownershipOk = lots.ok;
    const reservedOk = reservations.ok;
    const locationOk = balances.ok && whOk;
    // "available" needs BOTH the location balances and the reservation holds; with
    // only one we would either ignore reservations (overstating free stock) or
    // ignore on-hand — neither is honest, so available is unavailable then.
    const availableDimOk = balances.ok && reservations.ok && whOk;

    // ── Compose one row per item ─────────────────────────────────────────────
    const composed = items.map((it) => {
      const unit = baseUnitOf(it);
      const physicalOnHand = r4(it.quantity);
      const ownership = ownershipOf(physicalOnHand, custByItem.get(String(it._id)) || 0, ownershipOk);

      const reserved = reservedOk ? r4(resByItem.get(String(it._id)) || 0) : null;

      const locRows = balByItem.get(String(it._id)) || [];
      const locResMap = resByItemLoc.get(String(it._id)) || new Map();
      let usableOnHand = 0, available = 0, quarantine = 0, receiving = 0, assigned = 0;
      let main = null, extraCount = 0;
      if (locationOk) {
        const enriched = locRows.map((b) => {
          const meta = warehouseMap.get(key(b.warehouseId, b.locationId)) || {};
          return { onHand: r4(b.onHand), meta, reserved: r4(locResMap.get(key(b.warehouseId, b.locationId)) || 0) };
        });
        for (const e of enriched) {
          assigned = r4(assigned + e.onHand);
          if (e.meta.usable) {
            usableOnHand = r4(usableOnHand + e.onHand);
            available = r4(available + Math.max(0, e.onHand - e.reserved));   // reservation rule, per usable location
          } else if (e.meta.type === "QUARANTINE") quarantine = r4(quarantine + e.onHand);
          else if (e.meta.type === "RECEIVING") receiving = r4(receiving + e.onHand);
        }
        // The main location is the usable bin holding the most; fall back to the
        // largest of any type when nothing usable holds stock.
        const usableSorted = enriched.filter((e) => e.meta.usable).sort((a, b) => b.onHand - a.onHand);
        const anySorted = [...enriched].sort((a, b) => b.onHand - a.onHand);
        const top = usableSorted[0] || anySorted[0] || null;
        if (top) {
          main = { code: top.meta.code || "", name: top.meta.name || "", warehouseName: top.meta.warehouseName || "", warehouseShortName: top.meta.warehouseShortName || "", onHand: top.onHand };
          extraCount = Math.max(0, enriched.length - 1);
        }
      }
      const notUsable = r4(quarantine + receiving);
      const unassigned = locationOk ? r4(physicalOnHand - assigned) : null;

      const location = locationOk
        ? {
            available: true,
            tracked: locRows.length > 0,
            main,
            extraCount,
            // `stored` is the already-computed assigned total (Σ location on-hand) —
            // surfaced so the register can SHOW how much is placed vs unassigned
            // without the browser re-deriving a quantity. Not a new calculation.
            stored: assigned > TOL ? r4(assigned) : 0,
            unassigned: unassigned > TOL ? unassigned : 0,
            quarantine,
            receiving,
          }
        : { available: false, tracked: null, main: null, extraCount: 0, stored: null, unassigned: null, quarantine: null, receiving: null };

      const availableOut = availableDimOk ? available : null;

      const stockState = stockStateOf({
        physicalOnHand, locationOk, availableOk: availableDimOk, available,
        usableOnHand, assigned, unassigned: unassigned || 0, notUsable,
      });

      const variantsAll = Array.isArray(it.variants) ? it.variants : [];
      const combos = variantsAll.map(comboLabel).filter(Boolean);
      const variants = {
        count: variantsAll.length,
        combos: combos.slice(0, COMBO_LIMIT),
        more: Math.max(0, combos.length - COMBO_LIMIT),
      };

      const partial = !ownershipOk || !reservedOk || !locationOk || !availableDimOk;

      return {
        rowId: String(it._id),
        rawItemId: String(it._id),
        name: it.name || "",
        sku: it.sku || "",
        unit,
        physicalOnHand,
        ownership,
        reserved,
        available: availableOut,
        usableOnHand: availableDimOk ? usableOnHand : null,
        variants,
        location,
        stockState,
        // The item's own reorder minimum, READ from the record — not a new rule.
        // `low` mirrors rawItems.computeStatus: 0 < held <= minStock.
        reorder: {
          minStock: Number.isFinite(Number(it.minStock)) ? Number(it.minStock) : null,
          low: physicalOnHand > TOL && Number(it.minStock) > 0 && physicalOnHand <= Number(it.minStock),
        },
        partial,
      };
    });

    // ── Server-side filters over the composed set, THEN paginate ─────────────
    const ownershipMatch = (row) => {
      if (ownershipFilter === "all") return true;
      if (!row.ownership.available) return false;           // cannot claim a split we do not have
      if (ownershipFilter === "company") return row.ownership.label === "company";
      if (ownershipFilter === "customer") return row.ownership.label === "customer";
      if (ownershipFilter === "mixed") return row.ownership.label === "mixed";
      return true;
    };
    const stateMatch = (row) => stateFilter === "all" || row.stockState === stateFilter;
    const lensMatchFn = lensMatch(lens);

    const filtered = composed.filter((r) => lensMatchFn(r) && ownershipMatch(r) && stateMatch(r));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const rows = filtered.slice((safePage - 1) * pageSize, (safePage - 1) * pageSize + pageSize);

    const anyFilter = Boolean(search) || ownershipFilter !== "all" || stateFilter !== "all" || lens !== "all";

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      rows,
      pagination: { page: safePage, pageSize, total, totalPages },
      counts: {
        // `matchingSearch` is the DB count for the search clause (before the
        // in-memory ownership/state filters); `afterFilters` is what the register
        // is actually showing across all its pages. Neither is a page length.
        matchingSearch,
        afterFilters: total,
        filtered: anyFilter,
      },
      dimensions: {
        ownership: { available: ownershipOk, reason: ownershipOk ? null : "Customer-ownership records could not be read." },
        reserved: { available: reservedOk, reason: reservedOk ? null : "Reservations could not be read." },
        available: { available: availableDimOk, reason: availableDimOk ? null : "Available stock needs both location balances and reservations, and one could not be read." },
        location: { available: locationOk, reason: locationOk ? null : "Location balances could not be read." },
      },
      coverage: {
        capped,
        scanCap: SCAN_CAP,
        note: capped
          ? `Showing the first ${SCAN_CAP} materials by name. Narrow with search to see the rest.`
          : null,
      },
      filters: { search, ownership: ownershipFilter, state: stateFilter, lens },
    });
  } catch (error) {
    console.error("[inventory-stock] failed:", error);
    res.status(500).json({ success: false, message: "The Stock register could not be read." });
  }
});

module.exports = router;
