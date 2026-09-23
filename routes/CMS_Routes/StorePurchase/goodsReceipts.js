// routes/CMS_Routes/StorePurchase/goodsReceipts.js
//
// GOODS RECEIPTS — register, detail, and the controlled INSPECTION / QUARANTINE
// / PUT-AWAY workspace (V1). The register and detail are read-only; inspection
// and put-away are internal LOCATION moves through the existing LocationBalance
// / LocationMovement machinery (no second stock authority) and never change
// company-wide on-hand. Receipts themselves are still created on the PO route.
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const GoodsReceipt = require("../../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const GoodsReceiptDisposition = require("../../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const PurchaseOrder = require("../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability, refuseLegacyWrite, withIdempotency } = require("../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../services/storePurchase/capabilities");
const tenantContext = require("../../../services/storePurchase/tenantContext.service");
const unitOfWork = require("../../../services/storePurchase/unitOfWork.service");
const idempotencyService = require("../../../services/storePurchase/idempotency.service");
const locStock = require("../../../services/storePurchase/locationStock.service");
const control = require("../../../services/storePurchase/goodsReceiptControl.service");
const { fail, sendError } = require("../../../services/storePurchase/errors");

const ENTITY = "GOODS_RECEIPT";
// Stage is DERIVED (needs the inspection/put-away join), so the register scans a
// bounded, newest-first set and states that scope honestly. Read per request
// (env-overridable) so the truncation wording can be exercised in tests.
const registerScanCap = () => Math.max(1, parseInt(process.env.GR_REGISTER_SCAN_CAP, 10) || 500);

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

// ALL active locations of a type — destinations are chosen explicitly by the
// user, never by array order. (Receiving is identified by the GRN's own id.)
const activeLocationsOfType = (warehouse, type) =>
  (warehouse?.locations || []).filter((l) => l.type === type && l.status === "Active");
const asChoice = (l) => ({ id: String(l._id), code: l.code || "", name: l.name || "" });

// Load the warehouse + the receiving location + the eligible destination LISTS
// for one GRN. No single quarantine/returns location is auto-selected.
async function loadWarehouseContext(tenant, grn) {
  if (!grn.warehouseId || !grn.locationId) {
    return { warehouse: null, receivingLocation: null, receivingLocationActive: false,
      quarantineLocations: [], returnsLocations: [], usableLocations: [], usableAvailable: false };
  }
  const warehouse = await Warehouse.findOne({ _id: grn.warehouseId, ...tenantContext.tenantFilter(tenant) }).lean();
  const receivingLocation = locStock.findLocation(warehouse, grn.locationId);
  const receivingLocationActive = Boolean(warehouse && warehouse.status === "Active"
    && receivingLocation && receivingLocation.status === "Active" && receivingLocation.type === "RECEIVING");
  const usableLocations = activeLocationsOfType(warehouse, "USABLE_STOCK");
  const quarantineLocations = activeLocationsOfType(warehouse, "QUARANTINE");
  const returnsLocations = activeLocationsOfType(warehouse, "RETURNS");
  return {
    warehouse, receivingLocation, receivingLocationActive,
    quarantineLocations, returnsLocations, usableLocations,
    usableAvailable: usableLocations.length > 0,
    quarantineAvailable: quarantineLocations.length > 0,
    returnsAvailable: returnsLocations.length > 0,
  };
}
// Load the supplier returns that ORIGINATED from a given goods receipt (PO
// returnRequests whose provenance names this receipt), for reconciliation +
// linked replacement facts. Returns [] when the receipt has no PO.
async function loadGrnSupplierReturns(tenant, grn) {
  if (!grn.purchaseOrderId) return [];
  const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId, ...tenantContext.tenantFilter(tenant) })
    .select("returnRequests poNumber").lean();
  return (po?.returnRequests || []).filter((r) => String(r.goodsReceiptId || "") === String(grn._id));
}
// Resolve a user-selected destination of an expected type; never guess, never
// accept a foreign / inactive / wrong-type location.
function resolveChosenLocation(warehouse, locationId, expectedType) {
  const loc = locStock.findLocation(warehouse, locationId);
  if (!loc || loc.status !== "Active" || loc.type !== expectedType) return null;
  return loc;
}

// ── GET / — register with operational status filters + concise counts ────────
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));

    const filter = { ...tenantContext.tenantFilter(req.tenant) };
    if (typeof q.supplierId === "string" && mongoose.isValidObjectId(q.supplierId)) filter.supplierId = q.supplierId;
    if (q.dateFrom || q.dateTo) {
      filter.receiptDate = {};
      if (q.dateFrom && !Number.isNaN(Date.parse(q.dateFrom))) filter.receiptDate.$gte = new Date(q.dateFrom);
      if (q.dateTo && !Number.isNaN(Date.parse(q.dateTo))) filter.receiptDate.$lte = new Date(q.dateTo);
      if (!Object.keys(filter.receiptDate).length) delete filter.receiptDate;
    }
    const search = typeof q.search === "string" ? q.search.trim() : "";
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ receiptNumber: rx }, { poNumber: rx }, { supplierName: rx }, { invoiceNumber: rx }];
    }

    const stageFilter = typeof q.stage === "string" ? q.stage : "";  // derived filter
    const cap = registerScanCap();

    const storedMatchCount = await GoodsReceipt.countDocuments(filter);
    const docs = await GoodsReceipt.find(filter)
      .select("receiptNumber poNumber purchaseOrderId supplierName supplierId receiptDate warehouseName locationCode locationName warehouseId locationId invoiceNumber status recordedBy lines createdAt")
      .sort({ receiptDate: -1, _id: -1 }).limit(cap).lean();

    const ids = docs.map((d) => d._id);
    const poIds = [...new Set(docs.map((d) => d.purchaseOrderId).filter(Boolean).map(String))];
    const [inspections, putaways, dispositions, pos] = await Promise.all([
      ids.length ? GoodsReceiptInspection.find({ companyId: req.tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
      ids.length ? GoodsReceiptPutaway.find({ companyId: req.tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
      ids.length ? GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
      poIds.length ? PurchaseOrder.find({ _id: { $in: poIds }, ...tenantContext.tenantFilter(req.tenant) }).select("returnRequests").lean() : [],
    ]);
    const inspByGrn = new Map(inspections.map((i) => [String(i.goodsReceiptId), i]));
    const byGrn = (rows, out = new Map()) => { for (const r of rows) { const k = String(r.goodsReceiptId); if (!out.has(k)) out.set(k, []); out.get(k).push(r); } return out; };
    const putawaysByGrn = byGrn(putaways);
    const dispsByGrn = byGrn(dispositions);
    // Supplier returns are subdocs on the PO; group them by the GRN they originated from.
    const returnsByGrn = new Map();
    for (const po of pos) {
      for (const r of (po.returnRequests || [])) {
        if (!r.goodsReceiptId) continue;
        const k = String(r.goodsReceiptId);
        if (!returnsByGrn.has(k)) returnsByGrn.set(k, []);
        returnsByGrn.get(k).push(r);
      }
    }

    let rows = docs.map((g) => {
      const k = String(g._id);
      const c = control.deriveControl(g, inspByGrn.get(k) || null, putawaysByGrn.get(k) || [], {},
        { dispositions: dispsByGrn.get(k) || [], supplierReturns: returnsByGrn.get(k) || [] });
      return {
        id: String(g._id), receiptNumber: g.receiptNumber, purchaseOrderId: g.purchaseOrderId ? String(g.purchaseOrderId) : null,
        poNumber: g.poNumber || "", supplierName: g.supplierName || "",
        receiptDate: g.receiptDate || g.createdAt || null,
        warehouseName: g.warehouseName || "", locationLabel: [g.locationName, g.locationCode].filter(Boolean).join(" · "),
        lineCount: Array.isArray(g.lines) ? g.lines.length : 0,
        invoiceNumber: g.invoiceNumber || "", recordedByName: g.recordedBy?.name || "",
        stage: c.stage, flags: c.flags, counts: c.counts,
      };
    });

    if (stageFilter) {
      const matchers = {
        awaiting_inspection: (r) => r.flags.awaitingInspection,
        awaiting_putaway: (r) => r.flags.awaitingPutaway,
        quarantined: (r) => r.flags.hasQuarantined,
        rejected: (r) => r.flags.hasRejected,
        complete: (r) => r.flags.complete,
      };
      if (matchers[stageFilter]) rows = rows.filter(matchers[stageFilter]);
    }

    const totalItems = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const start = (Math.min(page, totalPages) - 1) * pageSize;
    const paged = rows.slice(start, start + pageSize);

    // HONEST SCOPE: stages are derived, so this describes only the newest
    // `cap` matching receipts — not a company-wide total. Say so plainly.
    const truncated = storedMatchCount > cap;
    res.json({
      success: true, goodsReceipts: paged,
      pagination: { page: Math.min(page, totalPages), pageSize, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1, scope: "inspectedSet" },
      coverage: {
        scannedCount: docs.length, scanCap: cap, storedMatchCount, truncated,
        note: truncated
          ? `Showing the newest ${cap} matching receipts; older matching receipts may exist. Stage counts and pagination describe only this inspected set.`
          : null,
      },
    });
  } catch (err) {
    console.error("[goods-receipts] register error:", err);
    res.status(500).json({ success: false, message: "Server error while loading goods receipts" });
  }
});

// GET /:grnId — one receipt with all lines and linked movement evidence.
router.get("/:grnId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.grnId)) return res.status(404).json({ success: false, message: "Goods receipt not found" });
    const g = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
    if (!g) return res.status(404).json({ success: false, message: "Goods receipt not found" });
    res.json({ success: true, goodsReceipt: g });
  } catch (err) {
    console.error("[goods-receipts] detail error:", err);
    res.status(500).json({ success: false, message: "Server error while loading the goods receipt" });
  }
});

// GET /:grnId/control — the operational workspace facts.
router.get("/:grnId/control", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.grnId)) return res.status(404).json({ success: false, message: "Goods receipt not found" });
    const grn = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
    if (!grn) return res.status(404).json({ success: false, message: "Goods receipt not found" });

    const [inspection, putaways, dispositions, ctx, supplierReturns] = await Promise.all([
      GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
      GoodsReceiptPutaway.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).sort({ createdAt: 1 }).lean(),
      GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).sort({ createdAt: 1 }).lean(),
      loadWarehouseContext(req.tenant, grn),
      loadGrnSupplierReturns(req.tenant, grn),
    ]);
    const c = control.deriveControl(grn, inspection, putaways, ctx, { dispositions, supplierReturns });

    // The receipt's supplier returns + their replacement facts, linked (not
    // recomputed) to the existing supplier-return lifecycle on the PO.
    const supplierReturnFacts = supplierReturns.map((r) => ({
      id: String(r._id), goodsReceiptLineId: String(r.goodsReceiptLineId || ""), itemName: r.itemName || "",
      quantity: r.damagedQuantity || 0, unit: r.unit || "", status: r.status || "PENDING",
      returnedQuantity: r.returnedQuantity || 0, pendingReturnQty: r.pendingReturnQty || 0,
      reason: r.reason || "", reportedAt: r.reportedAt || r.createdAt || null,
      replacementsReceived: (r.receipts || []).reduce((s, rc) => s + (Number(rc.quantityReceived) || 0), 0),
      // Deep-link to the existing supplier-return / replacement workspace for this PO.
      href: grn.purchaseOrderId ? `/store/dashboard/operations/delivery/${String(grn._id)}` : null,
    }));

    res.json({
      success: true,
      goodsReceipt: {
        id: String(grn._id), receiptNumber: grn.receiptNumber, poNumber: grn.poNumber, purchaseOrderId: grn.purchaseOrderId ? String(grn.purchaseOrderId) : null,
        supplierName: grn.supplierName, receiptDate: grn.receiptDate, invoiceNumber: grn.invoiceNumber,
        warehouseName: grn.warehouseName, receivingLocation: [grn.locationName, grn.locationCode].filter(Boolean).join(" · "),
      },
      stage: c.stage, flags: c.flags, counts: c.counts, lines: c.lines,
      inspection: inspection ? { inspectedAt: inspection.inspectedAt, inspectedByName: inspection.inspectedBy?.name || "", note: inspection.note || "" } : null,
      putaways: putaways.map((p) => ({ id: String(p._id), goodsReceiptLineId: String(p.goodsReceiptLineId), itemName: p.itemName, quantity: p.quantity, unit: p.unit, toLocation: [p.toLocationName, p.toLocationCode].filter(Boolean).join(" · "), transferId: p.transferId ? String(p.transferId) : null, at: p.at })),
      // Immutable quarantine disposition history.
      dispositions: dispositions.map((d) => ({
        id: String(d._id), goodsReceiptLineId: String(d.goodsReceiptLineId), itemName: d.itemName,
        type: d.dispositionType, quantity: d.quantity, unit: d.unit,
        fromLocation: [d.fromLocationName, d.fromLocationCode].filter(Boolean).join(" · "),
        toLocation: [d.toLocationName, d.toLocationCode].filter(Boolean).join(" · "),
        reason: d.reason || "", note: d.note || "", byName: d.actor?.name || "", at: d.at,
      })),
      supplierReturns: supplierReturnFacts,
      // Eligible destinations for the review screens — chosen explicitly, never guessed.
      usableLocations: ctx.usableLocations.map(asChoice),
      quarantineLocations: ctx.quarantineLocations.map(asChoice),
      returnsLocations: ctx.returnsLocations.map(asChoice),
      actions: c.actions, blockers: c.blockers,
    });
  } catch (err) {
    console.error("[goods-receipts] control error:", err);
    res.status(500).json({ success: false, message: "Server error while loading the receipt workspace" });
  }
});

// POST /:grnId/inspection — record the one inspection + post quarantine/returns moves.
router.post("/:grnId/inspection",
  requireCapability(CAPABILITIES.RECEIPT_RECORD), refuseLegacyWrite,
  withIdempotency("GR_INSPECTION", { target: (req) => req.params.grnId }),
  async (req, res) => {
    try {
      const grn = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
      if (!grn) return res.status(404).json({ success: false, message: "Goods receipt not found" });

      if (req.idempotent?.recovering) {
        const existing = await GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id, idempotencyKey: req.idempotent.key }).lean();
        await unitOfWork.recover(req.tenant, { entityType: ENTITY, entityId: grn._id, idempotencyKey: req.idempotent.key,
          entry: { documentNumber: grn.receiptNumber, action: existing ? "INSPECTED" : "INSPECTION_RECONCILIATION_REQUIRED", resultingState: "", requestId: req.id || "", idempotencyKey: req.idempotent.key } });
        if (!existing) throw fail("LIFECYCLE_BLOCKED", "This inspection was interrupted after its stock moves were marked. Check the stock and reconcile — do not record it again.", { reason: "PARTIAL_INSPECTION_NEEDS_RECONCILIATION" });
        return await req.idempotent.succeed(200, { success: true, message: "This inspection was already recorded.", inspection: existing }, { entityType: ENTITY, entityId: grn._id });
      }

      const already = await GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean();
      if (already) return res.status(409).json({ success: false, message: "This receipt has already been inspected.", reason: "ALREADY_INSPECTED" });

      const ctx = await loadWarehouseContext(req.tenant, grn);
      if (!ctx.receivingLocationActive) {
        return res.status(400).json({ success: false, message: "This receipt has no recorded Receiving location, so inspection movements cannot be posted safely.", reason: "NO_RECEIVING_LOCATION" });
      }
      const { plans } = control.validateInspection({ goodsReceipt: grn, lines: req.body?.lines || [] });
      if (typeof req.body?.note === "string") plans.overallNote = req.body.note;

      // Destinations are chosen explicitly during inspection — never by array
      // order. Resolve+validate only what the decisions actually need.
      const needsQuarantine = plans.some((p) => p.quarantined > 0);
      const needsReturns = plans.some((p) => p.rejected > 0);
      let quarantineLocation = null, returnsLocation = null;
      if (needsQuarantine) {
        quarantineLocation = resolveChosenLocation(ctx.warehouse, req.body?.quarantineLocationId, "QUARANTINE");
        if (!quarantineLocation) return res.status(400).json({ success: false, message: "Choose an active quarantine location for the quarantined stock.", reason: "INVALID_QUARANTINE_LOCATION" });
      }
      if (needsReturns) {
        returnsLocation = resolveChosenLocation(ctx.warehouse, req.body?.returnsLocationId, "RETURNS");
        if (!returnsLocation) return res.status(400).json({ success: false, message: "Choose an active returns location for the rejected stock.", reason: "INVALID_RETURNS_LOCATION" });
      }

      if (req.idempotent?.record) await idempotencyService.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: grn._id });

      let created = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        mutate: async (session) => {
          const out = await control.applyInspection({
            session, tenant: req.tenant, goodsReceipt: grn, warehouse: ctx.warehouse, receivingLocation: ctx.receivingLocation,
            quarantineLocation, returnsLocation, plans,
            actor: { id: req.user.id, name: req.user.name }, idempotencyKey: req.idempotent?.key || "",
          });
          created = out.inspection;
          return { entityType: ENTITY, entityId: grn._id, result: true,
            entry: { entityType: ENTITY, entityId: grn._id, documentNumber: grn.receiptNumber, action: "INSPECTED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { lineCount: plans.length } } };
        },
      });

      const body = { success: true, message: "Inspection recorded.", inspection: created };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: grn._id }) : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[goods-receipts] inspection error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

// POST /:grnId/putaways — put away accepted stock (Receiving → Usable Stock).
router.post("/:grnId/putaways",
  requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite,
  withIdempotency("GR_PUTAWAY", { target: (req) => req.params.grnId }),
  async (req, res) => {
    try {
      const grn = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
      if (!grn) return res.status(404).json({ success: false, message: "Goods receipt not found" });

      if (req.idempotent?.recovering) {
        const existing = await GoodsReceiptPutaway.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id, idempotencyKey: req.idempotent.key }).lean();
        await unitOfWork.recover(req.tenant, { entityType: ENTITY, entityId: grn._id, idempotencyKey: req.idempotent.key,
          entry: { documentNumber: grn.receiptNumber, action: existing ? "PUT_AWAY" : "PUTAWAY_RECONCILIATION_REQUIRED", resultingState: "", requestId: req.id || "", idempotencyKey: req.idempotent.key } });
        if (!existing) throw fail("LIFECYCLE_BLOCKED", "This put-away was interrupted after its stock move was marked. Check the stock and reconcile — do not record it again.", { reason: "PARTIAL_PUTAWAY_NEEDS_RECONCILIATION" });
        return await req.idempotent.succeed(200, { success: true, message: "This put-away was already recorded.", putaway: existing }, { entityType: ENTITY, entityId: grn._id });
      }

      const inspection = await GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean();
      if (!inspection) return res.status(400).json({ success: false, message: "Inspect this receipt before putting stock away.", reason: "NOT_INSPECTED" });

      const [putaways, dispositions, ctx, supplierReturns] = await Promise.all([
        GoodsReceiptPutaway.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        loadWarehouseContext(req.tenant, grn),
        loadGrnSupplierReturns(req.tenant, grn),
      ]);
      if (!ctx.receivingLocationActive) return res.status(400).json({ success: false, message: "This receipt has no recorded Receiving location.", reason: "NO_RECEIVING_LOCATION" });

      // Include dispositions so RELEASED quarantine counts toward put-away capacity.
      const c = control.deriveControl(grn, inspection, putaways, ctx, { dispositions, supplierReturns });
      const goodsReceiptLineId = String(req.body?.goodsReceiptLineId || "");
      const line = c.lines.find((x) => x.goodsReceiptLineId === goodsReceiptLineId);
      if (!line) return res.status(400).json({ success: false, message: "That line is not part of this receipt.", reason: "UNKNOWN_LINE" });
      const quantity = Number(req.body?.quantity);
      if (!(quantity > 0)) return res.status(400).json({ success: false, message: "A positive quantity is required.", reason: "INVALID_QUANTITY" });
      if (Math.round(quantity * 10000) / 10000 > line.remainingToPutAway + 0.0001) {
        return res.status(400).json({ success: false, message: `Only ${line.remainingToPutAway} ${line.unit} of accepted stock remains to put away for "${line.itemName}".`, reason: "OVER_PUTAWAY", remaining: line.remainingToPutAway });
      }
      // Destination must be an active USABLE_STOCK location in this warehouse.
      const toLocation = locStock.findLocation(ctx.warehouse, req.body?.toLocationId);
      if (!toLocation || toLocation.status !== "Active" || toLocation.type !== "USABLE_STOCK") {
        return res.status(400).json({ success: false, message: "Choose an active usable-stock location to put stock away into.", reason: "INVALID_USABLE_LOCATION" });
      }

      // Attach the inspection line's rawItem/variant/base-unit facts for the move.
      const il = (inspection.lines || []).find((x) => String(x.goodsReceiptLineId) === goodsReceiptLineId) || {};
      // Pass the STORED conversion evidence verbatim — applyPutaway fails closed
      // via resolveFactor if it is missing/invalid; no `|| 1` fallback.
      const controlLine = { ...line, rawItemId: il.rawItemId, variantId: il.variantId, poItemId: il.poItemId, baseUnit: il.baseUnit, conversionFactor: il.conversionFactor };

      if (req.idempotent?.record) await idempotencyService.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: grn._id });

      let created = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        mutate: async (session) => {
          const out = await control.applyPutaway({
            session, tenant: req.tenant, goodsReceipt: grn, inspection, controlLine,
            warehouse: ctx.warehouse, receivingLocation: ctx.receivingLocation, usableLocation: toLocation,
            quantity, actor: { id: req.user.id, name: req.user.name }, idempotencyKey: req.idempotent?.key || "", note: req.body?.note || "",
          });
          created = out.putaway;
          return { entityType: ENTITY, entityId: grn._id, result: true,
            entry: { entityType: ENTITY, entityId: grn._id, documentNumber: grn.receiptNumber, action: "PUT_AWAY", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { goodsReceiptLineId, quantity } } };
        },
      });

      const body = { success: true, message: "Stock put away.", putaway: created };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: grn._id }) : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[goods-receipts] putaway error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

// POST /:grnId/dispositions — resolve quarantined stock: RELEASE → Receiving, or
// REJECT → Returns. Immutable event; original inspection untouched.
router.post("/:grnId/dispositions",
  requireCapability(CAPABILITIES.STOCK_ADJUST), refuseLegacyWrite,
  withIdempotency("GR_DISPOSITION", { target: (req) => req.params.grnId }),
  async (req, res) => {
    try {
      const grn = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
      if (!grn) return res.status(404).json({ success: false, message: "Goods receipt not found" });

      if (req.idempotent?.recovering) {
        const existing = await GoodsReceiptDisposition.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id, idempotencyKey: req.idempotent.key }).lean();
        await unitOfWork.recover(req.tenant, { entityType: ENTITY, entityId: grn._id, idempotencyKey: req.idempotent.key,
          entry: { documentNumber: grn.receiptNumber, action: existing ? "QUARANTINE_DISPOSED" : "DISPOSITION_RECONCILIATION_REQUIRED", resultingState: "", requestId: req.id || "", idempotencyKey: req.idempotent.key } });
        if (!existing) throw fail("LIFECYCLE_BLOCKED", "This disposition was interrupted after its stock move was marked. Check the stock and reconcile — do not record it again.", { reason: "PARTIAL_DISPOSITION_NEEDS_RECONCILIATION" });
        return await req.idempotent.succeed(200, { success: true, message: "This disposition was already recorded.", disposition: existing }, { entityType: ENTITY, entityId: grn._id });
      }

      const inspection = await GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean();
      if (!inspection) return res.status(400).json({ success: false, message: "Inspect this receipt before resolving quarantined stock.", reason: "NOT_INSPECTED" });
      const [putaways, dispositions, ctx, supplierReturns] = await Promise.all([
        GoodsReceiptPutaway.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        loadWarehouseContext(req.tenant, grn),
        loadGrnSupplierReturns(req.tenant, grn),
      ]);
      if (!ctx.receivingLocationActive) return res.status(400).json({ success: false, message: "This receipt has no recorded Receiving location.", reason: "NO_RECEIVING_LOCATION" });

      const c = control.deriveControl(grn, inspection, putaways, ctx, { dispositions, supplierReturns });
      const goodsReceiptLineId = String(req.body?.goodsReceiptLineId || "");
      const line = c.lines.find((x) => x.goodsReceiptLineId === goodsReceiptLineId);
      if (!line) return res.status(400).json({ success: false, message: "That line is not part of this receipt.", reason: "UNKNOWN_LINE" });

      const dispositionType = String(req.body?.dispositionType || "").toUpperCase();
      if (dispositionType !== "RELEASE" && dispositionType !== "REJECT") {
        return res.status(400).json({ success: false, message: "Choose whether to release or reject the quarantined stock.", reason: "INVALID_DISPOSITION_TYPE" });
      }
      const quantity = Number(req.body?.quantity);
      if (!(quantity > 0)) return res.status(400).json({ success: false, message: "A positive quantity is required.", reason: "INVALID_QUANTITY" });
      if (Math.round(quantity * 10000) / 10000 > line.unresolvedQuarantine + 0.0001) {
        return res.status(400).json({ success: false, message: `Only ${line.unresolvedQuarantine} ${line.unit} of "${line.itemName}" is still in quarantine.`, reason: "OVER_DISPOSITION", remaining: line.unresolvedQuarantine });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ success: false, message: "A reason is required to release or reject quarantined stock.", reason: "REASON_REQUIRED" });

      // Source is the QUARANTINE location the stock sits in (chosen explicitly).
      const quarantineLocation = resolveChosenLocation(ctx.warehouse, req.body?.quarantineLocationId, "QUARANTINE");
      if (!quarantineLocation) return res.status(400).json({ success: false, message: "Choose the active quarantine location the stock is held in.", reason: "INVALID_QUARANTINE_LOCATION" });
      // Destination: Receiving for a release (unambiguous), an explicit Returns for a rejection.
      let toLocation;
      if (dispositionType === "RELEASE") {
        toLocation = ctx.receivingLocation;
      } else {
        toLocation = resolveChosenLocation(ctx.warehouse, req.body?.returnsLocationId, "RETURNS");
        if (!toLocation) return res.status(400).json({ success: false, message: "Choose an active returns location for the rejected stock.", reason: "INVALID_RETURNS_LOCATION" });
      }

      const il = (inspection.lines || []).find((x) => String(x.goodsReceiptLineId) === goodsReceiptLineId) || {};
      const controlLine = { ...line, rawItemId: il.rawItemId, variantId: il.variantId, poItemId: il.poItemId, sku: il.sku, variantCombination: il.variantCombination, baseUnit: il.baseUnit, conversionFactor: il.conversionFactor };

      if (req.idempotent?.record) await idempotencyService.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: grn._id });

      let created = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        mutate: async (session) => {
          const out = await control.applyDisposition({
            session, tenant: req.tenant, goodsReceipt: grn, inspection, controlLine, dispositionType,
            warehouse: ctx.warehouse, quarantineLocation, toLocation,
            quantity, reason, note: req.body?.note || "", evidenceRef: req.body?.evidenceRef || "",
            actor: { id: req.user.id, name: req.user.name }, idempotencyKey: req.idempotent?.key || "",
          });
          created = out.disposition;
          return { entityType: ENTITY, entityId: grn._id, result: true,
            entry: { entityType: ENTITY, entityId: grn._id, documentNumber: grn.receiptNumber, action: "QUARANTINE_DISPOSED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { goodsReceiptLineId, dispositionType, quantity } } };
        },
      });

      const body = { success: true, message: dispositionType === "RELEASE" ? "Quarantined stock released for use." : "Quarantined stock rejected for supplier return.", disposition: created };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: grn._id }) : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[goods-receipts] disposition error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

// POST /:grnId/supplier-returns — hand rejected stock to the CANONICAL supplier-
// return operation (reused, not reproduced), carrying GRN provenance.
router.post("/:grnId/supplier-returns",
  requireCapability(CAPABILITIES.STOCK_RETURN), refuseLegacyWrite,
  withIdempotency("GR_SUPPLIER_RETURN", { target: (req) => req.params.grnId }),
  async (req, res) => {
    try {
      const grn = await GoodsReceipt.findOne({ _id: req.params.grnId, ...tenantContext.tenantFilter(req.tenant) }).lean();
      if (!grn) return res.status(404).json({ success: false, message: "Goods receipt not found" });
      const operationId = req.idempotent?.record?._id || null;

      if (req.idempotent?.recovering) {
        const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId, ...tenantContext.tenantFilter(req.tenant) }).select("returnRequests").lean();
        const existing = (po?.returnRequests || []).find((r) => String(r.operationId || "") === String(operationId));
        const stockMoved = operationId ? Boolean(await RawItem.exists({ "stockTransactions.operationId": operationId })) : false;
        await unitOfWork.recover(req.tenant, { entityType: ENTITY, entityId: grn._id, idempotencyKey: req.idempotent.key,
          entry: { documentNumber: grn.receiptNumber, action: (existing && stockMoved) ? "SUPPLIER_RETURN_RAISED" : "SUPPLIER_RETURN_RECONCILIATION_REQUIRED", resultingState: "", requestId: req.id || "", idempotencyKey: req.idempotent.key } });
        if (!(existing && stockMoved)) throw fail("LIFECYCLE_BLOCKED", "This supplier return was interrupted. Check the stock and the order, then reconcile — do not raise it again.", { reason: "PARTIAL_SUPPLIER_RETURN_NEEDS_RECONCILIATION" });
        return await req.idempotent.succeed(200, { success: true, message: "This supplier return was already raised.", returnRequest: existing }, { entityType: ENTITY, entityId: grn._id });
      }

      const inspection = await GoodsReceiptInspection.findOne({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean();
      if (!inspection) return res.status(400).json({ success: false, message: "Inspect this receipt before returning stock to the supplier.", reason: "NOT_INSPECTED" });
      const [putaways, dispositions, ctx, supplierReturns] = await Promise.all([
        GoodsReceiptPutaway.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, goodsReceiptId: grn._id }).lean(),
        loadWarehouseContext(req.tenant, grn),
        loadGrnSupplierReturns(req.tenant, grn),
      ]);

      const c = control.deriveControl(grn, inspection, putaways, ctx, { dispositions, supplierReturns });
      const goodsReceiptLineId = String(req.body?.goodsReceiptLineId || "");
      const line = c.lines.find((x) => x.goodsReceiptLineId === goodsReceiptLineId);
      if (!line) return res.status(400).json({ success: false, message: "That line is not part of this receipt.", reason: "UNKNOWN_LINE" });
      const quantity = Number(req.body?.quantity);
      if (!(quantity > 0)) return res.status(400).json({ success: false, message: "A positive quantity is required.", reason: "INVALID_QUANTITY" });
      if (Math.round(quantity * 10000) / 10000 > line.rejectedAwaitingReturn + 0.0001) {
        return res.status(400).json({ success: false, message: `Only ${line.rejectedAwaitingReturn} ${line.unit} of "${line.itemName}" is awaiting supplier return.`, reason: "OVER_SUPPLIER_RETURN", remaining: line.rejectedAwaitingReturn });
      }
      // A reason is REQUIRED — the server never substitutes one for the user's
      // decision. Refuse blank / whitespace-only BEFORE anything is reserved.
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ success: false, message: "A reason is required to return stock to the supplier.", reason: "REASON_REQUIRED" });

      // Source is the RETURNS location the rejected stock sits in (chosen explicitly).
      const returnsLoc = resolveChosenLocation(ctx.warehouse, req.body?.returnsLocationId, "RETURNS");
      if (!returnsLoc) return res.status(400).json({ success: false, message: "Choose the active returns location the rejected stock is held in.", reason: "INVALID_RETURNS_LOCATION" });

      // ── PROVENANCE: prove every linked record still agrees BEFORE reserving ────
      // GRN line ↔ inspection line ↔ PO line must name the SAME company, item and
      // variant (null vs non-null distinguished). A mismatch writes nothing.
      const sameId = (a, b) => String(a ?? "") === String(b ?? "");
      const grnLine = (grn.lines || []).find((x) => String(x._id) === goodsReceiptLineId);
      const il = (inspection.lines || []).find((x) => String(x.goodsReceiptLineId) === goodsReceiptLineId);
      const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId, ...tenantContext.tenantFilter(req.tenant) });
      const provConflict = (detail) => res.status(409).json({ success: false, message: "This receipt line, its inspection and its order line no longer agree, so a supplier return cannot be raised.", reason: "PROVENANCE_CONFLICT", ...detail });
      if (!grnLine) return provConflict({ detail: "GRN_LINE_MISSING" });
      if (!il) return provConflict({ detail: "INSPECTION_LINE_MISSING" });
      if (!po) return res.status(400).json({ success: false, message: "The originating purchase order could not be found for this receipt.", reason: "PO_NOT_FOUND" });
      if (!sameId(inspection.companyId, req.tenant.companyId) || !sameId(grn.companyId, req.tenant.companyId)) return provConflict({ detail: "COMPANY_MISMATCH" });
      const poItem = il.poItemId ? po.items.id(il.poItemId) : null;
      if (!poItem) return provConflict({ detail: "PO_LINE_MISSING" });
      if (!sameId(grnLine.rawItemId, il.rawItemId) || !sameId(il.rawItemId, poItem.rawItem)) return provConflict({ detail: "RAW_ITEM_MISMATCH" });
      if (!sameId(grnLine.variantId, il.variantId) || !sameId(il.variantId, poItem.variantId)) return provConflict({ detail: "VARIANT_MISMATCH" });
      // Business units must agree, and a differing frozen base needs valid evidence.
      if (!sameId(il.unit, poItem.unit)) return provConflict({ detail: "UNIT_MISMATCH" });
      if (il.baseUnit && il.baseUnit !== il.unit && !(Number.isFinite(Number(il.conversionFactor)) && Number(il.conversionFactor) > 0)) {
        return res.status(400).json({ success: false, message: `No valid unit conversion is recorded for "${il.itemName}", so it cannot be returned.`, reason: "UOM_CONVERSION_MISSING" });
      }

      const rawUnit = await RawItem.findById(poItem.rawItem).select("unit customUnit").lean();
      const controlLine = { goodsReceiptLineId, itemName: line.itemName, rawItemId: il.rawItemId, variantId: il.variantId, poItemId: il.poItemId, unit: il.unit, baseUnit: il.baseUnit, conversionFactor: il.conversionFactor };
      // Ordered rejected sources for deterministic allocation: inspection rejection
      // first, then the line's REJECT dispositions by creation time.
      const rejectDispositions = dispositions
        .filter((d) => String(d.goodsReceiptLineId) === goodsReceiptLineId && d.dispositionType === "REJECT")
        .sort((a, b) => new Date(a.createdAt || a.at || 0) - new Date(b.createdAt || b.at || 0));

      if (req.idempotent?.record) await idempotencyService.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: grn._id });

      let created = null;
      await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record,
        mutate: async (session) => {
          const out = await control.applyGrnSupplierReturn({
            session, tenant: req.tenant, goodsReceipt: grn, inspection, controlLine, po, poItem,
            returnsLocation: { warehouse: ctx.warehouse, location: returnsLoc }, rawUnit,
            quantity, reason,
            inspectionRejected: il.rejectedQuantity || 0, rejectDispositions,
            actor: { id: req.user.id, name: req.user.name }, operationId, idempotencyKey: req.idempotent?.key || "",
          });
          created = out.returnRequest;
          return { entityType: ENTITY, entityId: grn._id, result: true,
            entry: { entityType: ENTITY, entityId: grn._id, documentNumber: grn.receiptNumber, action: "SUPPLIER_RETURN_RAISED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { goodsReceiptLineId, quantity, returnId: String(out.returnRequest._id) } } };
        },
      });

      const body = { success: true, message: "Supplier return raised.", returnRequest: created };
      return req.idempotent ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: grn._id }) : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[goods-receipts] supplier-return error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

module.exports = router;
