// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js
// UPDATED:
//   • Operations store operationCode (from Operation registry) — no machine fields.
//   • plan-operations only updates plannedTimeSeconds + notes.
//   • complete-planning no longer blocks on unassigned machines.
//   • start-production no longer checks for assignedMachine.

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const workOrderStyleLink = require("../../../../services/industrialEngineering/workOrderStyleLink.service");
const salesLineLink = require("../../../../services/production/salesLineWorkOrderLink.service");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
/* Read to prove a stranded order really is stranded before it may be
   cancelled — never written by the cancellation itself. */
const ProductionCompletionScanRecord = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
/* `DefectRecord` is what QC inspections are stored as — the same model
   qcRoutes reads under this name. */
const QCInspection = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const CuttingMasterRecord = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
/* Cancelling a work order is only half the transition — the STYLE has to come
   back to R&D too, or the page that says "define the route" keeps hiding the
   panel that defines it. */
const sampleStyleReturn = require("../../../../services/manufacturing/sampleStyleReturn.service");
const Employee = require("../../../../models/Employee");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const mongoose = require("mongoose");
const departmentWrites = require("../../../../Middlewear/departmentWriteGuard");

router.use(EmployeeAuthMiddleware);

/* The read-only Sales line ↔ WorkOrder bridge. Mounted before every `/:id`
   route so "sales-line-links" is never read as a work-order id. */
router.use("/sales-line-links", require("./salesLineLinkRoutes"));

/*
 * ── AUTHORISED, NOT MERELY SIGNED IN ─────────────────────────────────────────
 * Every route in this file is authenticated-employee only. That is fine for
 * planning edits; it is not fine for cancelling an order, which is the one
 * write here that ends a record rather than advancing it.
 *
 * So the cancellation carries the codebase's OWN role mechanism —
 * `departmentWrites`, used as route middleware exactly as
 * manufacturingOrderRoutes.js already uses it — rather than a second
 * authorization model invented for one endpoint. Platform admins go round it
 * for the reason set out there: requireDepartmentRole ahead of requireApproval
 * would otherwise refuse an administrator holding no Production role.
 *
 * It fails open until an administrator grants the first Production role (see
 * services/departmentRoles.js), so this does not lock anybody out today; it
 * means the cancellation is governed the moment roles are configured, which a
 * bespoke check bolted on here would not be.
 */
const cancellationGuard = (req, res, next) => {
  if (req.user?.isAdmin) return next();
  return departmentWrites("project-manager", { entity: "work order" })(req, res, next);
};

/* ── AND THE SAME AUTHORITY FOR CREATING ONE (IE Chunk 1D) ──────────────────
 * `PUT /:id/allocate-raw-materials` with `splitRemaining` does not merely edit
 * a work order — it CREATES one. Creating and altering work orders is the
 * Project Manager's throughout Manufacturing (`pmOwnedWrite` in
 * manufacturingOrderRoutes.js, the cancellation above), so the split carries
 * the same guard rather than a second authorization model invented for it.
 *
 * Membership is NOT this check. The shared company-context service provides
 * identity and company scope, explicitly not capability; company membership is
 * proved separately inside the handler, and neither substitutes for the other.
 *
 * It is the same object as `cancellationGuard` because it is the same rule;
 * the alias exists so each call site says which act it is protecting. */
const splitGuard = cancellationGuard;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: unit conversion
// ─────────────────────────────────────────────────────────────────────────────
// `unitMap` (optional) is a pre-fetched Map<unitName, unitDoc> — pass it to skip
// the per-call Unit.findOne round trips when the caller has already batched them
// (see PUT /:id/allocate-raw-materials). Omitted by other callers — behavior for
// them is unchanged.
async function convertQuantity(quantity, fromUnit, toUnit, unitMap = null) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;
  try {
    const fromDoc = unitMap
      ? (unitMap.get(fromUnit) || null)
      : await Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === toUnit
      );
      if (direct?.quantity) return quantity * direct.quantity;
    }
    const toDoc = unitMap
      ? (unitMap.get(toUnit) || null)
      : await Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === fromUnit
      );
      if (reverse?.quantity) return quantity / reverse.quantity;
    }
    console.warn(`[convertQuantity] No path "${fromUnit}"→"${toUnit}".`);
    return quantity;
  } catch (err) {
    console.error("[convertQuantity]", err.message);
    return quantity;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Barcode / piece-history helpers
// ─────────────────────────────────────────────────────────────────────────────
const _parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber:       parseInt(parts[2], 10),
        operationNumber:  parts[3] ? parseInt(parts[3], 10) : null,
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/piece-history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/piece-history", async (req, res) => {
  try {
    const { id } = req.params;
    const unitNumber = parseInt(req.query.unitNumber, 10);

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    if (isNaN(unitNumber) || unitNumber < 1)
      return res.status(400).json({ success: false, message: "unitNumber query param is required (integer ≥ 1)" });

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity operations stockItemName").lean();
    if (!workOrder)
      return res.status(404).json({ success: false, message: "Work order not found" });
    if (unitNumber > workOrder.quantity)
      return res.status(400).json({ success: false, message: `Unit ${unitNumber} exceeds WO quantity (${workOrder.quantity})` });

    const woShortId = workOrder._id.toString().slice(-8);

    const allTrackingDocs = await ProductionTracking.find({})
      .populate("machines.machineId", "name serialNumber type").lean();

    const matchingScans = [];
    const operatorIdsSet = new Set();

    for (const doc of allTrackingDocs) {
      for (const machine of doc.machines || []) {
        const machineId   = machine.machineId?._id?.toString();
        const machineName = machine.machineId?.name || "Unknown";
        for (const operator of machine.operators || []) {
          const opId = operator.operatorIdentityId;
          if (opId) operatorIdsSet.add(opId);
          for (const scan of operator.barcodeScans || []) {
            const parsed = _parseBarcode(scan.barcodeId);
            if (!parsed.success || parsed.workOrderShortId !== woShortId || parsed.unitNumber !== unitNumber) continue;
            matchingScans.push({
              machineId, machineName, operatorId: opId, operatorName: null,
              signInTime: operator.signInTime, signOutTime: operator.signOutTime,
              scanTime: scan.timeStamp, barcodeId: scan.barcodeId,
              operationNumber: parsed.operationNumber,
              // activeOps is now an array of operation codes
              activeOps: Array.isArray(scan.activeOps) ? scan.activeOps : [],
              scanDate: doc.date,
            });
          }
        }
      }
    }

    const employees = await Employee.find({ identityId: { $in: [...operatorIdsSet] } })
      .select("identityId firstName lastName").lean();
    const employeeMap = new Map(
      employees.map(e => [e.identityId, `${e.firstName || ""} ${e.lastName || ""}`.trim()])
    );
    matchingScans.forEach(s => { s.operatorName = employeeMap.get(s.operatorId) || s.operatorId || "Unknown"; });

    const opMap = new Map();
    for (const scan of matchingScans) {
      const key = scan.operationNumber ?? 0;
      if (!opMap.has(key)) opMap.set(key, new Map());
      const oprMap = opMap.get(key);
      if (!oprMap.has(scan.operatorId)) {
        oprMap.set(scan.operatorId, {
          operatorId: scan.operatorId, operatorName: scan.operatorName,
          scans: [], signInTime: scan.signInTime, signOutTime: scan.signOutTime,
        });
      }
      oprMap.get(scan.operatorId).scans.push(scan.scanTime);
    }

    const buildOperators = (oprMap) =>
      [...oprMap.values()].map(e => {
        const sorted    = e.scans.filter(Boolean).map(t => new Date(t)).sort((a, b) => a - b);
        const firstScan = sorted[0] || null;
        const lastScan  = sorted[sorted.length - 1] || null;
        const durationMs = e.signInTime && e.signOutTime
          ? new Date(e.signOutTime) - new Date(e.signInTime)
          : (firstScan && lastScan && lastScan - firstScan > 0 ? lastScan - firstScan : 0);
        return {
          operatorId: e.operatorId, operatorName: e.operatorName,
          firstScanTime: firstScan, lastScanTime: lastScan,
          durationMs, scansCount: e.scans.length,
          dates: [...new Set(sorted.map(t => t.toISOString().split("T")[0]))],
        };
      }).sort((a, b) => new Date(a.firstScanTime) - new Date(b.firstScanTime));

    const operations = workOrder.operations?.length > 0
      ? workOrder.operations.map((woOp, i) => {
          const opNum  = i + 1;
          const oprMap = opMap.get(opNum);
          return {
            operationNumber: opNum,
            operationType:   woOp.operationType || `Operation ${opNum}`,
            operationCode:   woOp.operationCode || "",
            operators:       oprMap ? buildOperators(oprMap) : [],
          };
        })
      : [...opMap.entries()]
          .filter(([k]) => k !== 0)
          .map(([opNum, oprMap]) => ({
            operationNumber: opNum,
            operationType:   `Operation ${opNum}`,
            operationCode:   "",
            operators:       buildOperators(oprMap),
          }));

    if (opMap.has(0)) {
      operations.push({
        operationNumber: null,
        operationType:   "Unknown Operation",
        operationCode:   "",
        operators:       buildOperators(opMap.get(0)),
      });
    }

    return res.json({
      success: true, unitNumber,
      workOrderId: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
      stockItemName: workOrder.stockItemName,
      totalScansFound: matchingScans.length, operations,
    });
  } catch (error) {
    console.error("Error fetching piece history:", error);
    res.status(500).json({ success: false, message: "Server error while fetching piece history", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /machine-status  (unchanged — machines still have a status dashboard)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/machine-status", async (req, res) => {
  try {
    const allMachines = await Machine.find({}).lean();

    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow    = new Date(Date.now() + istOffset);
    const todayDate = new Date(istNow.toISOString().split("T")[0]);
    todayDate.setHours(0, 0, 0, 0);

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type").lean();

    const activeTodayMap = new Map();
    if (todayTracking) {
      for (const m of todayTracking.machines || []) {
        const mId = m.machineId?._id?.toString();
        if (!mId) continue;
        activeTodayMap.set(mId, !!m.currentOperatorIdentityId);
      }
    }

    const activeWOs = await WorkOrder.find({
      status: { $in: ["in_progress", "scheduled", "ready_to_start"] },
    }).select("workOrderNumber stockItemName status quantity timeline productionCompletion").lean();

    const machines = allMachines.map(machine => {
      const mId        = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;

      let status = "free";
      if (machine.status === "Under Maintenance" || machine.status === "maintenance") status = "maintenance";
      else if (machine.status === "Offline" || machine.status === "offline") status = "offline";
      else if (isActiveNow) status = "busy";

      return {
        _id: machine._id, name: machine.name, serialNumber: machine.serialNumber,
        type: machine.type, model: machine.model || null, location: machine.location || null,
        status, isActiveToday: isActiveNow,
        freeFromDate:    status === "free" ? (machine.updatedAt || null) : null,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
      };
    });

    res.json({
      success: true, machines,
      summary: {
        total:       machines.length,
        free:        machines.filter(m => m.status === "free").length,
        busy:        machines.filter(m => m.status === "busy").length,
        maintenance: machines.filter(m => m.status === "maintenance").length,
        offline:     machines.filter(m => m.status === "offline").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machine status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
 
    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber status priority quantity stockItemName stockItemReference stockItemId " +
        "variantAttributes specialInstructions createdAt estimatedCost rawMaterials operations " +
        "planningNotes assignedDeadline assignedDeadlineMeta timeline"
      )
      .populate("plannedBy", "name")
      .populate("assignedDeadlineMeta.assignedBy", "name email")
      .lean();
    if (!workOrder)
      return res.status(404).json({ success: false, message: "Work order not found" });
 
    const stockItemDetails = await getStockItemDetails(workOrder.stockItemId);
 
    const optimizedRawMaterials = (workOrder.rawMaterials || []).map(rm => ({
      name: rm.name, sku: rm.sku, unit: rm.unit, unitCost: rm.unitCost, totalCost: rm.totalCost,
      quantityRequired: rm.quantityRequired, quantityAllocated: rm.quantityAllocated || 0,
      quantityIssued: rm.quantityIssued || 0, allocationStatus: rm.allocationStatus || "not_allocated",
      rawItemVariantId: rm.rawItemVariantId,
      rawItemVariantCombination: rm.rawItemVariantCombination || [],
      variantName: rm.rawItemVariantCombination?.join(" • ") ||
        (rm.rawItemVariantId ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}` : "Default"),
    }));
 
    const optimizedOperations = (workOrder.operations || []).map(op => ({
      _id:               op._id,
      operationType:     op.operationType,
      operationCode:     op.operationCode || "",
      plannedTimeSeconds: op.plannedTimeSeconds || 0,
      status:            op.status || "pending",
      notes:             op.notes || "",
    }));
 
    const totalPlannedSeconds = optimizedOperations.reduce(
      (s, op) => s + (op.plannedTimeSeconds || 0), 0
    );
 
    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status, priority: workOrder.priority,
        quantity: workOrder.quantity,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        variantAttributes: workOrder.variantAttributes || [],
        specialInstructions: workOrder.specialInstructions || [],
        estimatedCost: workOrder.estimatedCost || 0, createdAt: workOrder.createdAt,
        plannedBy: workOrder.plannedBy?.name || null,
 
        // ← NEW FIELDS for the View MO page
        assignedDeadline:     workOrder.assignedDeadline || null,
        assignedDeadlineMeta: workOrder.assignedDeadlineMeta || null,
        timeline:             workOrder.timeline || {},
 
        panelCount:    stockItemDetails.panelCount,
        genderCategory: stockItemDetails.genderCategory,
        totalBarcodes: stockItemDetails.panelCount > 0
          ? workOrder.quantity * stockItemDetails.panelCount
          : workOrder.quantity * optimizedOperations.length,
        totalPlannedSeconds,
        needsPlanning: optimizedRawMaterials.some(rm => rm.allocationStatus === "not_allocated"),
        rawMaterialStats: {
          total:              optimizedRawMaterials.length,
          fullyAllocated:     optimizedRawMaterials.filter(rm => ["fully_allocated", "issued"].includes(rm.allocationStatus)).length,
          partiallyAllocated: optimizedRawMaterials.filter(rm => rm.allocationStatus === "partially_allocated").length,
          notAllocated:       optimizedRawMaterials.filter(rm => rm.allocationStatus === "not_allocated").length,
        },
        rawMaterials: optimizedRawMaterials,
        operations:   optimizedOperations,
      },
    });
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({ success: false, message: "Server error while fetching work order" });
  }
});

async function getStockItemDetails(stockItemId) {
  try {
    if (!stockItemId) return { panelCount: 0, genderCategory: "" };
    const si = await StockItem.findById(stockItemId).select("numberOfPanels genderCategory").lean();
    return { panelCount: si?.numberOfPanels || 0, genderCategory: si?.genderCategory || "" };
  } catch { return { panelCount: 0, genderCategory: "" }; }
}

router.get("/stock-items/:id", async (req, res) => {
  try {
    const si = await StockItem.findById(req.params.id)
      .select("name reference numberOfPanels operations variants images").lean();
    if (!si) return res.status(404).json({ success: false, message: "Stock item not found" });
    res.json({ success: true, stockItem: si });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id/panel-count", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.id).lean();
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    const si = await StockItem.findById(wo.stockItemId).select("numberOfPanels").lean();
    res.json({
      success: true, panelCount: si?.numberOfPanels || 0,
      workOrder: { workOrderNumber: wo.workOrderNumber, quantity: wo.quantity, stockItemName: wo.stockItemName },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id/with-panels", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.id)
      .populate("stockItemId", "name reference numberOfPanels")
      .populate("customerRequestId", "customerInfo requestId").lean();
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    const si = await StockItem.findById(wo.stockItemId);
    res.json({ success: true, workOrder: { ...wo, numberOfPanels: si?.numberOfPanels || 1 } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id/with-details", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    const wo = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels operations variants")
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .populate("rawMaterials.rawItemId", "name sku quantity").lean();
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    res.json({ success: true, workOrder: wo, stockItem: wo.stockItemId, numberOfPanels: wo.stockItemId?.numberOfPanels || 1 });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/planning
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/planning", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference operations rawItems images genderCategory")
      .populate({
        path: "customerRequestId",
        select: "customerInfo deliveryDeadline",
        populate: { path: "customerId", select: "shippingAddress billingAddress" },
      }).lean();
    if (!workOrder)
      return res.status(404).json({ success: false, message: "Work order not found" });

    let customerWithAddress = null;
    if (workOrder.customerRequestId?.customerId) {
      const Customer = require("../../../../models/Customer_Models/Customer");
      customerWithAddress = await Customer.findById(workOrder.customerRequestId.customerId)
        .select("shippingAddress billingAddress phone email").lean();
    }
    const customerInfo = {
      ...workOrder.customerRequestId?.customerInfo,
      address:
        customerWithAddress?.shippingAddress?.fullAddress ||
        customerWithAddress?.billingAddress?.fullAddress ||
        workOrder.customerRequestId?.customerInfo?.address ||
        "Address not available",
    };

    const stockItem = await StockItem.findById(workOrder.stockItemId).lean();

    let maxProducibleQuantity = workOrder.quantity;
    const rawMaterialsWithStock = await Promise.all(
      workOrder.rawMaterials.map(async (rm) => {
        if (!rm.rawItemId) return rm;
        const rawItem = await RawItem.findById(rm.rawItemId).lean();
        if (!rawItem) return rm;

        const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
        const requiredPerUnitBom    = rm.quantityRequired / workOrder.quantity;
        const requiredPerUnit       =
          rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
            ? await convertQuantity(requiredPerUnitBom, rm.unit, rawItemRegisteredUnit)
            : requiredPerUnitBom;

        let maxUnitsFromThisMaterial = 0, currentStock = 0, status = "insufficient";

        if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
          let variant = null;
          if (rm.rawItemVariantId && rawItem.variants)
            variant = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
          else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants)
            variant = rawItem.variants.find(v =>
              v.combination?.length === rm.rawItemVariantCombination.length &&
              v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx])
            );
          if (variant) {
            currentStock = variant.quantity || 0;
            maxUnitsFromThisMaterial = requiredPerUnit > 0 ? Math.floor(currentStock / requiredPerUnit) : 0;
          }
        } else {
          currentStock = rawItem.quantity || 0;
          maxUnitsFromThisMaterial = requiredPerUnit > 0 ? Math.floor(currentStock / requiredPerUnit) : 0;
        }

        maxProducibleQuantity = Math.min(maxProducibleQuantity, maxUnitsFromThisMaterial);
        if (maxUnitsFromThisMaterial >= workOrder.quantity) status = "sufficient";
        else if (maxUnitsFromThisMaterial > 0)             status = "partial";
        else                                               status = "insufficient";

        return {
          ...rm, currentStock, requiredPerUnit, requiredPerUnitBom,
          maxUnitsFromThisMaterial, status, rawItemRegisteredUnit,
          variantName: rm.rawItemVariantCombination?.join(" • ") ||
            (rm.rawItemVariantId ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}` : "Default"),
        };
      })
    );

    // Return operations with name + code + timing only
    const operationsData = workOrder.operations.map(op => ({
      _id:               op._id,
      operationType:     op.operationType,
      operationCode:     op.operationCode || "",
      plannedTimeSeconds: op.plannedTimeSeconds || 0,
      status:            op.status || "pending",
      notes:             op.notes || "",
    }));

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        operations:          operationsData,
        rawMaterials:        rawMaterialsWithStock,
        maxProducibleQuantity: Math.max(1, maxProducibleQuantity),
        stockItemOperations: stockItem?.operations || [],
        customerRequestId:   workOrder.customerRequestId
          ? { ...workOrder.customerRequestId, customerInfo, deliveryDeadline: workOrder.customerRequestId.deliveryDeadline }
          : null,
      },
    });
  } catch (error) {
    console.error("Error fetching work order for planning:", error);
    res.status(500).json({ success: false, message: "Server error while fetching work order details" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/raw-item-requirement — WO-scoped equivalent of the MO-wide
// /api/cms/sales/requests/:requestId/raw-item-requirement endpoint, same
// { perProduct, totals, grand } response shape so the frontend can reuse
// <RawItemRequirementSlider /> unmodified, just scoped to this one work order.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/raw-item-requirement", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    }

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber stockItemName stockItemReference stockItemId variantAttributes quantity rawMaterials")
      .populate("stockItemId", "images variants")
      .lean();
    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    const rawMaterials = workOrder.rawMaterials || [];
    if (rawMaterials.length === 0) {
      return res.json({
        success: true,
        workOrderNumber: workOrder.workOrderNumber,
        perProduct: [],
        totals: [],
        grand: { totalLineItems: 0, totalRequired: 0, totalAvailable: 0, shortfallCount: 0 },
      });
    }

    // Live stock lookup for every unique raw item referenced by this WO
    const uniqueRawItemIds = [
      ...new Set(rawMaterials.map((rm) => rm.rawItemId?.toString()).filter(Boolean)),
    ];
    const rawItemDocs = uniqueRawItemIds.length
      ? await RawItem.find({
          _id: { $in: uniqueRawItemIds.map((rid) => new mongoose.Types.ObjectId(rid)) },
        }).lean()
      : [];
    const rawItemMap = new Map(rawItemDocs.map((r) => [r._id.toString(), r]));

    const productImage = (() => {
      const si = workOrder.stockItemId;
      if (si?.variants?.length) {
        const withImg = si.variants.find((v) => v.images?.length > 0);
        if (withImg) return withImg.images[0];
      }
      return si?.images?.[0] || null;
    })();

    const totals = [];
    let totalRequired = 0;
    let totalAvailable = 0;
    let shortfallCount = 0;

    for (const rm of rawMaterials) {
      const rawItemId = rm.rawItemId?.toString() || "";
      const doc = rawItemId ? rawItemMap.get(rawItemId) : null;

      let available = null;
      let minStock = 0;
      let unitConversions = [];
      let variantDoc = null;

      if (doc) {
        if (rm.rawItemVariantId && Array.isArray(doc.variants)) {
          variantDoc = doc.variants.find((v) => v._id?.toString() === rm.rawItemVariantId.toString());
        }
        if (!variantDoc && rm.rawItemVariantCombination?.length > 0 && Array.isArray(doc.variants)) {
          variantDoc = doc.variants.find(
            (v) =>
              v.combination?.length === rm.rawItemVariantCombination.length &&
              v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx])
          );
        }
        if (variantDoc) {
          available = variantDoc.quantity || 0;
          minStock = variantDoc.minStock ?? doc.minStock ?? 0;
        } else {
          available = doc.quantity || 0;
          minStock = doc.minStock || 0;
        }

        const convSourceVariant = variantDoc || doc.variants?.[0];
        if (convSourceVariant?.unitConversions?.length) unitConversions = convSourceVariant.unitConversions;
        else if (convSourceVariant?.unitConversion?.toUnit) unitConversions = [convSourceVariant.unitConversion];
      }

      const baseUnit = doc ? doc.customUnit || doc.unit : rm.unit;
      let availableInBomUnit = available;
      if (available !== null && baseUnit && rm.unit && baseUnit !== rm.unit) {
        const conv = unitConversions.find((c) => c.fromUnit === baseUnit && c.toUnit === rm.unit);
        const inv = unitConversions.find((c) => c.fromUnit === rm.unit && c.toUnit === baseUnit);
        if (conv?.quantity) availableInBomUnit = available * conv.quantity;
        else if (inv?.quantity) availableInBomUnit = available / inv.quantity;
      }

      const quantityRequired = rm.quantityRequired || 0;
      const shortfall = availableInBomUnit !== null ? Math.max(0, quantityRequired - availableInBomUnit) : null;

      let status = "unknown";
      if (availableInBomUnit !== null) {
        if (availableInBomUnit <= 0) status = "out_of_stock";
        else if (shortfall > 0) status = "shortage";
        else if (availableInBomUnit - quantityRequired <= minStock) status = "low";
        else status = "ok";
      }

      totalRequired += quantityRequired;
      if (available !== null) totalAvailable += available;
      if (shortfall && shortfall > 0) shortfallCount++;

      totals.push({
        rawItemId,
        variantId: rm.rawItemVariantId?.toString() || "",
        rawItemName: rm.name,
        rawItemSku: rm.sku || "",
        variantCombination: rm.rawItemVariantCombination || [],
        unit: rm.unit,
        baseUnit,
        // BOM breakdown snapshot — see rawMaterialAllocationSchema
        requiredQuantity: rm.requiredQuantity ?? quantityRequired,
        allowancePercent: rm.allowancePercent || 0,
        quantityRequired,
        unitCost: rm.unitCost || 0,
        totalCost: rm.totalCost || (rm.unitCost || 0) * quantityRequired,
        available,
        availableInBomUnit,
        shortfall,
        minStock,
        status,
        unitConversions,
        // WO-specific allocation bookkeeping (not present on the MO-wide endpoint)
        allocationStatus: rm.allocationStatus,
        quantityAllocated: rm.quantityAllocated || 0,
        quantityIssued: rm.quantityIssued || 0,
      });
    }

    const variantLabel = (workOrder.variantAttributes || []).map((a) => a.value).join(" / ") || "Default";
    const perPiece = (t) => (workOrder.quantity > 0 ? t.quantityRequired / workOrder.quantity : 0);
    const perPieceRequired = (t) => (workOrder.quantity > 0 ? t.requiredQuantity / workOrder.quantity : 0);

    const perProduct = [
      {
        productName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference || "",
        totalQuantity: workOrder.quantity || 0,
        image: productImage,
        rawItems: totals.map((t) => ({
          rawItemId: t.rawItemId,
          variantId: t.variantId,
          rawItemName: t.rawItemName,
          rawItemSku: t.rawItemSku,
          variantCombination: t.variantCombination,
          unit: t.unit,
          baseUnit: t.baseUnit,
          perPieceQty: perPiece(t),
          perPieceRequiredQty: perPieceRequired(t),
          allowancePercent: t.allowancePercent,
          quantityRequired: t.quantityRequired,
          requiredQuantity: t.requiredQuantity,
          unitCost: t.unitCost,
          totalCost: t.totalCost,
        })),
        variantBreakdowns: [
          {
            variantLabel,
            quantity: workOrder.quantity || 0,
            rawItems: totals.map((t) => ({
              rawItemId: t.rawItemId,
              variantId: t.variantId,
              rawItemName: t.rawItemName,
              perPieceQty: perPiece(t),
              perPieceRequiredQty: perPieceRequired(t),
              allowancePercent: t.allowancePercent,
              quantityRequired: t.quantityRequired,
              requiredQuantity: t.requiredQuantity,
              unit: t.unit,
            })),
          },
        ],
      },
    ];

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      perProduct,
      totals,
      grand: {
        totalLineItems: totals.length,
        totalRequired,
        totalAvailable,
        shortfallCount,
      },
    });
  } catch (error) {
    console.error("Error fetching WO raw-item-requirement:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw item requirement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/allocate-raw-materials
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/allocate-raw-materials", splitGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, splitRemaining = false, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    /* Strict input. `quantity <= 0` and `quantity > workOrder.quantity` were the
       only checks, and JavaScript coercion let three different kinds of junk
       past them:
         • "abc" / {}  cast-failed inside mongoose and surfaced as a 500;
         • true        passed both comparisons and was cast to 1, silently
                       reducing a ten-unit order to one;
         • omitted     passed both comparisons and assigning `undefined`
                       UNSET the stored quantity — `min: 1` never fires for an
                       absent field — leaving a work order with no quantity at
                       all, reported as success.
       Only a real, finite JSON number is accepted now. No coercion: a numeric
       STRING is refused too, because a caller sending "5" is a caller whose
       contract we cannot vouch for. Fractional values stay legal — nothing
       durable forbids them, and the schema says `min: 1`, not integer. */
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive number",
      });
    }

    /* The basis every per-unit figure below is derived from: the work order's
       quantity BEFORE this request changes it. Read once, here, because the
       loop further down used to divide the already-rescaled requirement by
       `originalQuantity`, so replaying the same allocation shrank the
       requirement every time (100 → 60 → 36 → 21.6). */
    const basisQuantity = workOrder.quantity;

    /* A work order whose own quantity is missing or unusable cannot be divided
       by. Refuse rather than invent a replacement — defect #3 above is exactly
       how such a record comes into existence. */
    if (typeof basisQuantity !== "number" || !Number.isFinite(basisQuantity) || basisQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "This work order has no usable quantity to allocate against",
      });
    }

    if (quantity > basisQuantity) {
      return res.status(400).json({ success: false, message: "Quantity cannot exceed original work order quantity" });
    }

    if (!workOrder.originalQuantity) workOrder.originalQuantity = basisQuantity;
    const remainingQuantity = basisQuantity - quantity;
    let newWorkOrder = null;

    // ── Batch-fetch RawItems + Units up front so the two loops below don't do
    // per-line DB round trips (previously: 2x RawItem.findById + up to 2x
    // Unit.findOne per raw-material line). Read-only lookups here — the code
    // never mutates or saves the RawItem docs in this route — so .lean() is
    // safe and fast.
    const rawItemIds = [...new Set(
      workOrder.rawMaterials
        .map(rm => rm.rawItemId)
        .filter(Boolean)
        .map(rid => rid.toString())
    )];
    const rawItemDocs = rawItemIds.length
      ? await RawItem.find({ _id: { $in: rawItemIds } }).lean()
      : [];
    const rawItemMap = new Map(rawItemDocs.map(doc => [doc._id.toString(), doc]));

    const unitNames = new Set();
    for (const rm of workOrder.rawMaterials) {
      if (rm.unit) unitNames.add(rm.unit);
      if (rm.rawItemId) {
        const ri = rawItemMap.get(rm.rawItemId.toString());
        const registeredUnit = ri && (ri.customUnit || ri.unit);
        if (registeredUnit) unitNames.add(registeredUnit);
      }
    }
    const unitDocs = unitNames.size
      ? await Unit.find({ name: { $in: [...unitNames] } })
          .populate("conversions.toUnit", "name").lean()
      : [];
    const unitMap = new Map(unitDocs.map(doc => [doc.name, doc]));

    // Verify stock can support requested quantity
    let canProduceQuantity = workOrder.quantity;
    for (const rm of workOrder.rawMaterials) {
      if (!rm.rawItemId) continue;
      const rawItem = rawItemMap.get(rm.rawItemId.toString());
      if (!rawItem) continue;
      const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
      const requiredPerUnitBom    = rm.quantityRequired / basisQuantity;
      const requiredPerUnit       =
        rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
          ? await convertQuantity(requiredPerUnitBom, rm.unit, rawItemRegisteredUnit, unitMap)
          : requiredPerUnitBom;

      let stock = 0;
      if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
        let v = null;
        if (rm.rawItemVariantId && rawItem.variants)
          v = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
        else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants)
          v = rawItem.variants.find(v =>
            v.combination?.length === rm.rawItemVariantCombination.length &&
            v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx])
          );
        if (v) stock = v.quantity || 0;
      } else {
        stock = rawItem.quantity || 0;
      }
      canProduceQuantity = Math.min(canProduceQuantity,
        requiredPerUnit > 0 ? Math.floor(stock / requiredPerUnit) : 0
      );
    }

    if (splitRemaining && remainingQuantity > 0) {
      /* ── IE CHUNK 1D — A SPLIT MUST KNOW ITS STYLE ─────────────────────
         Resolved from the exact order being split: its canonical link, or —
         for a legacy parent — the accepted resolver over that parent's own
         stored references. Never inherited as absence: a split that could not
         prove a style is not created at all. The parent is read, never
         written to. */
      const splitActingCompanyId = await workOrderStyleLink.resolveActingCompany(req, "work-order split");
      const splitStyleId = await workOrderStyleLink.styleForDerivative([workOrder._id], {
        label: "This split work order", expectedCompanyId: splitActingCompanyId,
      });
      /* The child makes the same confirmed Sales line as its parent: the
         parent's stored link, unchanged. A historical parent with no link
         yields a child with none — its absence is inherited, never filled. */
      const splitLineLink = salesLineLink.linkForSplit(workOrder, { actingCompanyId: splitActingCompanyId });
      const newRawMaterials = workOrder.rawMaterials.map(rm => {
        const req = rm.quantityRequired / basisQuantity;
        return {
          rawItemId: rm.rawItemId, name: rm.name, sku: rm.sku,
          rawItemVariantId: rm.rawItemVariantId,
          rawItemVariantCombination: rm.rawItemVariantCombination || [],
          quantityRequired: req * remainingQuantity,
          quantityAllocated: 0, quantityIssued: 0,
          unit: rm.unit, unitCost: rm.unitCost || 0,
          totalCost: (rm.unitCost || 0) * (req * remainingQuantity),
          allocationStatus: "not_allocated", notes: rm.notes || "",
        };
      });

      newWorkOrder = new WorkOrder({
        customerRequestId: workOrder.customerRequestId, stockItemId: workOrder.stockItemId,
        ...(splitLineLink ? { salesLineLink: splitLineLink } : {}),
        sampleStyleId: splitStyleId,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        variantId: workOrder.variantId, variantAttributes: workOrder.variantAttributes,
        quantity: remainingQuantity, originalQuantity: remainingQuantity,
        customerId: workOrder.customerId, customerName: workOrder.customerName,
        priority: workOrder.priority, status: "pending",
        // Copy operations — name + code only
        operations: workOrder.operations.map(op => ({
          operationType: op.operationType,
          operationCode: op.operationCode || "",
          plannedTimeSeconds: op.plannedTimeSeconds || 0,
          status: "pending", notes: op.notes || "",
        })),
        rawMaterials: newRawMaterials,
        timeline: { totalEstimatedSeconds: (workOrder.timeline?.totalEstimatedSeconds || 0) * (remainingQuantity / basisQuantity) },
        specialInstructions: workOrder.specialInstructions, createdBy: workOrder.createdBy,
        isSplitOrder: true, parentWorkOrderId: workOrder._id,
        splitReason: "Split due to raw material allocation",
      });

      /* No number is assigned here on purpose.
         Chunk 4A.1 set one on this line; Chunk 4A.2 moved the rule to the
         WorkOrder model's pre-validate hook, so EVERY creation path gets a
         canonical `WO-<full ObjectId>` before its first write — the two Sales
         generators and both return/rework generators included, not just this
         one. Re-assigning here would be a second numbering standard for the
         same records. The saved document carries the number, so the response
         below reports the real stored value. */
      await newWorkOrder.save();
    }

    workOrder.quantity = quantity;

    for (const rm of workOrder.rawMaterials) {
      const rawItem = rm.rawItemId ? (rawItemMap.get(rm.rawItemId.toString()) || null) : null;
      /* Scaled from `basisQuantity` — the quantity this work order had when the
         request arrived — not from `originalQuantity`. The old form divided the
         ALREADY-RESCALED stored requirement by the original quantity, so the
         same request applied twice compounded: 100 → 60 → 36 → 21.6. Using the
         current basis makes a replay a no-op and a genuine later reduction
         scale from where the record actually is. */
      const requiredPerUnitBom = rm.quantityRequired / basisQuantity;
      rm.quantityRequired = isNaN(requiredPerUnitBom * quantity) ? 0 : requiredPerUnitBom * quantity;

      if (!rawItem) { rm.quantityAllocated = 0; rm.allocationStatus = "not_allocated"; continue; }

      const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
      let availableStock = 0;
      if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
        let v = null;
        if (rm.rawItemVariantId && rawItem.variants)
          v = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
        else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants)
          v = rawItem.variants.find(v =>
            v.combination?.length === rm.rawItemVariantCombination.length &&
            v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx])
          );
        if (v) availableStock = v.quantity || 0;
      } else {
        availableStock = rawItem.quantity || 0;
      }

      const availableInBomUnit =
        rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
          ? await convertQuantity(availableStock, rawItemRegisteredUnit, rm.unit, unitMap)
          : availableStock;

      const maxAllocatable = Math.min(rm.quantityRequired, availableInBomUnit);
      rm.quantityAllocated = isNaN(maxAllocatable) ? 0 : maxAllocatable;

      if (rm.quantityAllocated >= rm.quantityRequired)      rm.allocationStatus = "fully_allocated";
      else if (rm.quantityAllocated > 0)                    rm.allocationStatus = "partially_allocated";
      else                                                   rm.allocationStatus = "not_allocated";
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    workOrder.status        = quantity < workOrder.originalQuantity ? "partial_allocation" : "planned";
    await workOrder.save();

    res.json({
      success: true,
      message: `Raw materials allocated successfully for ${quantity} units`,
      workOrder: { _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, quantity: workOrder.quantity },
      newWorkOrder: newWorkOrder ? { _id: newWorkOrder._id, workOrderNumber: newWorkOrder.workOrderNumber, quantity: newWorkOrder.quantity } : null,
      remainingQuantity, splitCreated: !!newWorkOrder,
    });
  } catch (error) {
    /* IE Chunk 1D: a typed linkage or company refusal keeps its registered
       status, code and actionable message. Anything else is still a 500. */
    if (error && error.name === "StorePurchaseError") {
      return workOrderStyleLink.sendTypedError(res, error, "");
    }
    console.error("Error allocating raw materials:", error);
    res.status(500).json({ success: false, message: "Server error while allocating raw materials", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/plan-operations
// Only updates plannedTimeSeconds + notes — no machine assignment.
// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/plan-operations
router.put("/:id/plan-operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { operations, totalPlannedSeconds, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    // ── Fetch the corresponding StockItem and build a name→operationCode map ──
    const stockItem = workOrder.stockItemId
      ? await StockItem.findById(workOrder.stockItemId).select("name operations").lean()
      : null;

    const stockItemOpMap = new Map(); // normalized operationType → operationCode
    if (stockItem?.operations?.length) {
      for (const op of stockItem.operations) {
        const key = (op.type || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (key && op.operationCode) {
          stockItemOpMap.set(key, op.operationCode);
        }
      }
      console.log(
        `[plan-operations] StockItem "${stockItem.name}" — built op map with ${stockItemOpMap.size} entries`
      );
    } else {
      console.warn(
        `[plan-operations] WO ${workOrder.workOrderNumber} — StockItem not found or has no operations, skipping code verification`
      );
    }

    for (const opUpdate of operations) {
      const operation = workOrder.operations.id(opUpdate._id);
      if (!operation) continue;

      // Update plannedTimeSeconds and notes as before
      if (opUpdate.plannedTimeSeconds !== undefined)
        operation.plannedTimeSeconds = opUpdate.plannedTimeSeconds || operation.plannedTimeSeconds || 0;
      if (opUpdate.notes !== undefined) operation.notes = opUpdate.notes;
      operation.status = "scheduled";

      // ── Cross-verify operationCode against StockItem ──────────────────────
      if (stockItemOpMap.size > 0) {
        const nameKey = (operation.operationType || "").trim().toLowerCase().replace(/\s+/g, " ");
        const correctCode = stockItemOpMap.get(nameKey);

        if (correctCode) {
          // Check if current code is wrong or missing — fix it
          if (operation.operationCode !== correctCode) {
            console.log(
              `[plan-operations] WO ${workOrder.workOrderNumber} — fixing operationCode for ` +
              `"${operation.operationType}": "${operation.operationCode || "(empty)"}" → "${correctCode}"`
            );
            operation.operationCode = correctCode;
          }
          // Also backfill plannedTimeSeconds from StockItem if still 0
          if (!operation.plannedTimeSeconds) {
            const siOp = stockItem.operations.find(
              o => (o.type || "").trim().toLowerCase().replace(/\s+/g, " ") === nameKey
            );
            if (siOp) {
              operation.plannedTimeSeconds =
                siOp.totalSeconds || (siOp.minutes * 60 + (siOp.seconds || 0)) || 0;
            }
          }
        } else {
          // No match in StockItem — log warning but don't clear existing code
          console.warn(
            `[plan-operations] WO ${workOrder.workOrderNumber} — no StockItem match for ` +
            `"${operation.operationType}" (current code: "${operation.operationCode || "(empty)"}")`
          );
        }
      }
    }

    if (totalPlannedSeconds) {
      workOrder.timeline = workOrder.timeline || {};
      workOrder.timeline.totalPlannedSeconds = totalPlannedSeconds;
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();

    res.json({ success: true, message: "Operations confirmed successfully", workOrder });
  } catch (error) {
    console.error("Error planning operations:", error);
    res.status(500).json({ success: false, message: "Server error while planning operations" });
  }
});

/**
 * POST /:id/cancel-unrouted — return a stranded sample order to R&D.
 *
 * ── THE STATE THIS EXISTS FOR ───────────────────────────────────────────────
 * A work order created before its product had any operations cannot progress:
 * there is nothing for a production scan to complete and nothing for QC to
 * inspect against. The guards now refuse to create one, but the ones already
 * out there are stuck — and the only previous way out was deleting records
 * somebody may need to explain.
 *
 * So it is CANCELLED, not deleted. The manufacturing order, the work order,
 * the cutting records and the customer request all stay exactly where they
 * are; what changes is the status and the account of why.
 *
 * ── AND IT REFUSES THE MOMENT THERE IS REAL WORK ────────────────────────────
 * A route, a production scan or a QC inspection each mean somebody has done
 * something against this order, and cancelling it would be discarding their
 * work on the strength of a status. Each is checked and each is named.
 * Cutting is deliberately NOT a refusal — cutting happens before the sewing
 * route matters — but it IS reported, because the fabric is cut and the
 * replacement order must not silently inherit it.
 */
/**
 * What was already cut against this work order.
 *
 * `CuttingMasterRecord` is one document per cutting master per DAY and keys
 * the work order on `entries[].woId` — there is no `workOrderId` on it at all.
 * The entries are matched and the units summed, because "2 sessions" and "180
 * pieces" are different facts and it is the pieces somebody has to go and find.
 */
async function cuttingAgainst(workOrderId) {
  const docs = await CuttingMasterRecord
    .find({ "entries.woId": workOrderId }).select("entries").lean().catch(() => []);
  const entries = docs.flatMap((d) => (d.entries || [])
    .filter((e) => String(e?.woId || "") === String(workOrderId)));
  const records = entries.length;
  const unitsCut = entries.reduce((n, e) => n + (Number(e.quantityCut) || 0), 0);
  if (!records) return { records: 0, unitsCut: 0, payload: null };
  return {
    records,
    unitsCut,
    payload: {
      records,
      unitsCut,
      note: `Cutting already recorded belongs to this cancelled attempt — ${unitsCut} piece${unitsCut === 1 ? "" : "s"} across ${records} session${records === 1 ? "" : "s"}. It is kept for the record and is NOT carried into a replacement order: the new work order starts at zero and those pieces will not be counted against it. Check the cut pieces before cutting again.`,
    },
  };
}

/**
 * Reconcile the style that governs this work order.
 *
 * Called on a first cancellation AND on a replay, because cancelling the work
 * order was only ever half the transition: `SampleStyle.production.status` is
 * what R&D's page branches on, and a work order that stopped short of it left
 * the style saying "sent to production" over a screen telling the reader to
 * define a route it was hiding.
 */
async function reconcileStyle({ workOrder, actor, reason, at }) {
  try {
    const style = await sampleStyleReturn.governingStyleFor(workOrder._id);
    if (!style) return null;
    const r = await sampleStyleReturn.returnStyleToRouteEditing({
      style, workOrder, actor, reason, at,
    });
    return { styleId: String(style._id), styleRef: style.sampleStyleId || "", ...r };
  } catch (err) {
    /* The work order IS cancelled — that is committed and correct. A style
       that could not be reconciled is reported as exactly that rather than
       turning a completed cancellation into a 500 the reader would retry. */
    console.error("[workOrders] cancel-unrouted: style return failed", err);
    return {
      returned: false, blockedBy: [], error: true,
      message: "The order is cancelled, but the style could not be returned to R&D automatically. Open the style and check its production status.",
    };
  }
}

/** The one response shape both the first cancellation and a replay return. */
function cancellationBody({ wo, account, cutting, styleReturn, replayed }) {
  return {
    success: true,
    replayed: Boolean(replayed),
    message: styleReturn?.returned
      ? `${wo.workOrderNumber || "The work order"} is cancelled and the style is back with R&D.`
      : `${wo.workOrderNumber || "The work order"} is cancelled.`,
    workOrder: { id: String(wo._id), number: wo.workOrderNumber || "", status: wo.status },
    /* ── THE ACCOUNT, READ BACK ON THE RESPONSE ──────────────────────
       Everything the panel needs to show what happened, so it never has to
       read a `workOrder` prop loaded before the cancellation and render a
       blank reason. On a replay these are the ORIGINAL facts, read off the
       stored record — never the replaying caller's. */
    cancellation: account,
    cutting: cutting.payload,
    styleReturn,
    nextStep: styleReturn && !styleReturn.returned && styleReturn.blockedBy?.length
      ? styleReturn.message
      : "Define the sample operation route in R&D, then send a new order to production.",
  };
}

router.post("/:id/cancel-unrouted", cancellationGuard, async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found." });

    /* ── A REPLAY STILL RECONCILES THE STYLE ───────────────────────────
       This used to return here, before the style was touched at all. Any
       order cancelled before the style-return existed — and any second call
       against one cancelled after it — left `production.status` at
       "submitted" for ever, which is the exact state the live walkthrough
       record was found in: work order cancelled, style still submitted, the
       route panel unreachable on a page correctly showing the cancelled
       attempt.

       So the replay does everything the first call does except cancel: it
       re-reads the recorded account, re-reads what was cut, and reconciles
       the style — using the ORIGINAL reason, actor and timestamp, not
       whoever is making this call now. */
    if (wo.status === "cancelled") {
      const recorded = wo.cancellation || {};
      const account = {
        reason: recorded.reason || "",
        at: recorded.at || null,
        by: { id: recorded.byActorId || "", name: recorded.byName || "" },
        cuttingRecorded: Boolean(recorded.cuttingRecorded),
        operationsAtCancellation: recorded.operationsAtCancellation ?? null,
        productionScansAtCancellation: recorded.productionScansAtCancellation ?? null,
        qcInspectionsAtCancellation: recorded.qcInspectionsAtCancellation ?? null,
      };
      const cutting = await cuttingAgainst(wo._id);
      const styleReturn = await reconcileStyle({
        workOrder: wo,
        actor: { id: recorded.byActorId || undefined, name: recorded.byName || "" },
        reason: recorded.reason || "",
        at: recorded.at || undefined,
      });
      return res.json(cancellationBody({ wo, account, cutting, styleReturn, replayed: true }));
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      /* Without one, a cancelled order is indistinguishable from a mistake,
         and nobody can tell whether to raise it again. */
      return res.status(400).json({
        success: false, code: "CANCEL_REASON_REQUIRED",
        message: "Say why this order is being cancelled and returned to R&D.",
      });
    }

    /* ── 1. IT MUST ACTUALLY BE UNROUTED ──────────────────────────────── */
    const operations = (wo.operations || []).length;
    if (operations) {
      return res.status(409).json({
        success: false, code: "WORK_ORDER_IS_ROUTED",
        message: `${wo.workOrderNumber || "This work order"} has ${operations} operations, so it is not stranded. Cancelling a routed order is a production decision, not a repair.`,
      });
    }

    /* ── 2. AND NOBODY MUST HAVE WORKED AGAINST IT ─────────────────────
       A scan already voided by the reconciliation is not activity: it was
       written against no route and has been withdrawn. Only LIVE scans
       count. */
    const shortId = String(wo._id).slice(-8);
    /* ── AND THE COUNT IS THIS ORDER'S SCANS, NOT THE DAY'S ────────────
       A ProductionCompletionScanRecord is one document PER DATE holding
       every work order scanned that day, so the documents the query matches
       carry other orders' scans too. Counting the array would refuse this
       cancellation because somebody scanned a different order on the same
       day — which is not activity against this one. Each barcode is matched
       individually. */
    const mine = new RegExp(`^WO-${shortId}-`);
    const scanDocs = await ProductionCompletionScanRecord
      .find({ "scans.barcodeId": { $regex: mine } }).select("scans.barcodeId").lean()
      .catch(() => []);
    const liveScans = scanDocs.reduce(
      (n, d) => n + (d.scans || []).filter((x) => mine.test(String(x?.barcodeId || ""))).length,
      0,
    );
    if (liveScans) {
      return res.status(409).json({
        success: false, code: "PRODUCTION_ACTIVITY_EXISTS",
        message: `${liveScans} production scan${liveScans === 1 ? " has" : "s have"} been recorded against this order. Cancelling it would discard work somebody did.`,
        productionScans: liveScans,
      });
    }

    const qcCount = await QCInspection.countDocuments({ workOrderId: wo._id }).catch(() => 0);
    if (qcCount) {
      return res.status(409).json({
        success: false, code: "QC_ACTIVITY_EXISTS",
        message: `${qcCount} QC inspection${qcCount === 1 ? " has" : "s have"} been recorded against this order.`,
        qcInspections: qcCount,
      });
    }

    /* ── 3. WHAT WAS ALREADY CUT, REPORTED RATHER THAN REUSED ────────── */
    const cutting = await cuttingAgainst(wo._id);

    const cancelledAt = new Date();
    const actor = { id: String(req.user?.id || ""), name: req.user?.name || "" };
    wo.status = "cancelled";
    wo.cancellation = {
      at: cancelledAt,
      byActorId: actor.id,
      byName: actor.name,
      reason,
      operationsAtCancellation: operations,
      productionScansAtCancellation: liveScans,
      qcInspectionsAtCancellation: qcCount,
      cuttingRecorded: cutting.records > 0,
    };
    await wo.save();

    /* ── 4. AND THE STYLE COMES BACK TO R&D ────────────────────────────
       The half that was missing. Cancelling the work order moved the work
       order; `SampleStyle.production.status` is what R&D's page reads to
       decide whether route editing is open, and it stayed at "submitted" —
       so the screen said "define the route" while hiding the panel that
       defines it. The service reopens the style only when no work order
       still governs it, and writes nothing at all when one does. */
    const styleReturn = await reconcileStyle({
      workOrder: wo, actor: { id: req.user?.id, name: actor.name }, reason, at: cancelledAt,
    });

    return res.json(cancellationBody({
      wo,
      account: {
        reason,
        at: cancelledAt,
        by: actor,
        cuttingRecorded: cutting.records > 0,
        operationsAtCancellation: operations,
        productionScansAtCancellation: liveScans,
        qcInspectionsAtCancellation: qcCount,
      },
      cutting,
      styleReturn,
      replayed: false,
    }));
  } catch (err) {
    console.error("[workOrders] POST /:id/cancel-unrouted", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/:id/complete-planning", async (req, res) => {
  try {
    const { id } = req.params;
    const { planningNotes } = req.body;
 
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder)
      return res.status(404).json({ success: false, message: "Work order not found" });
 
    
 
    // NOTE: Raw-item stock deduction intentionally removed.
    // Allocation status is preserved as-is — actual issuance will be handled
    // by the store/issuance flow.
 
    workOrder.status        = "scheduled";
    workOrder.plannedBy     = req.user.id;
    workOrder.plannedAt     = new Date();
    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();
 
    res.json({
      success: true,
      message: "Planning completed successfully",
      workOrder,
    });
  } catch (error) {
    console.error("Error completing planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while completing planning",
    });
  }
});
 

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/start-production
// Machine assignment check removed — only raw materials need to be issued.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/start-production", async (req, res) => {
  try {
    const { id } = req.params;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const canStart =
      (workOrder.status === "scheduled" || workOrder.status === "ready_to_start") &&
      !workOrder.rawMaterials?.some(rm => rm.allocationStatus !== "issued");

    if (!canStart) {
      return res.status(400).json({
        success: false,
        message: "Work order cannot start. Ensure raw materials are fully issued and status is scheduled/ready_to_start.",
      });
    }

    workOrder.status                   = "in_progress";
    workOrder.timeline.actualStartDate = new Date();
    workOrder.operations.forEach(op => { op.status = "pending"; });
    await workOrder.save();

    res.json({
      success: true, message: "Production started successfully",
      workOrder: { _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, status: workOrder.status, startedAt: workOrder.timeline.actualStartDate },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while starting production" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Operations CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/stock-item-operations", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.id).lean();
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    const si = await StockItem.findById(wo.stockItemId).select("operations").lean();
    res.json({ success: true, operations: si?.operations || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /:id/operations — now accepts and stores operationCode
router.post("/:id/operations", async (req, res) => {
  try {
    const { operationType, operationCode, plannedTimeSeconds } = req.body;
    const workOrder = await WorkOrder.findById(req.params.id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    workOrder.operations.push({
      operationType,
      operationCode:      operationCode || "",
      plannedTimeSeconds: plannedTimeSeconds || 0,
      status:             "pending",
      notes:              "",
    });
    await workOrder.save();
    const addedOp = workOrder.operations[workOrder.operations.length - 1];
    res.json({ success: true, message: "Operation added successfully", operation: addedOp });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while adding operation" });
  }
});

// DELETE /:id/operations/batch
router.delete("/:id/operations/batch", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationIds } = req.body;
    if (!Array.isArray(operationIds) || operationIds.length === 0)
      return res.status(400).json({ success: false, message: "operationIds array is required" });

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const idSet  = new Set(operationIds.map(String));
    const before = workOrder.operations.length;
    workOrder.operations = workOrder.operations.filter(op => !idSet.has(op._id.toString()));
    const removed = before - workOrder.operations.length;

    await workOrder.save();
    res.json({ success: true, message: `${removed} operation(s) removed successfully`, removed });
  } catch (error) {
    console.error("Error batch-deleting operations:", error);
    res.status(500).json({ success: false, message: "Server error while removing operations", error: error.message });
  }
});

router.delete("/:id/operations/:operationId", async (req, res) => {
  try {
    const { id, operationId } = req.params;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const idx = workOrder.operations.findIndex(op => op._id.toString() === operationId);
    if (idx === -1) return res.status(404).json({ success: false, message: "Operation not found" });

    workOrder.operations.splice(idx, 1);
    await workOrder.save();
    res.json({ success: true, message: "Operation removed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while removing operation" });
  }
});

router.put("/:id/operations/reorder", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationIds } = req.body;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const opsMap = {};
    workOrder.operations.forEach(op => { opsMap[op._id.toString()] = op; });
    const reordered = operationIds.map(opId => opsMap[opId]).filter(Boolean);
    workOrder.operations.forEach(op => {
      if (!operationIds.includes(op._id.toString())) reordered.push(op);
    });
    workOrder.operations = reordered;
    await workOrder.save();
    res.json({ success: true, message: "Operations reordered successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while reordering operations" });
  }
});

router.post("/bulk-plan", async (req, res) => {
  try {
    const { workOrderIds } = req.body;
 
    if (!workOrderIds || !Array.isArray(workOrderIds) || workOrderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "workOrderIds array is required",
      });
    }
 
    const results = {
      success: [],
      failed: [],
      totalProcessed: 0,
      totalSuccess: 0,
      totalFailed: 0,
    };
 
    for (const workOrderId of workOrderIds) {
      try {
        if (!mongoose.Types.ObjectId.isValid(workOrderId)) {
          results.failed.push({ id: workOrderId, reason: "Invalid work order ID" });
          results.totalFailed++;
          continue;
        }
 
        const workOrder = await WorkOrder.findById(workOrderId);
 
        if (!workOrder) {
          results.failed.push({ id: workOrderId, reason: "Work order not found" });
          results.totalFailed++;
          continue;
        }
 
        if (workOrder.status !== "pending") {
          results.failed.push({
            id: workOrderId,
            workOrderNumber: workOrder.workOrderNumber,
            reason: `Cannot plan work order with status: ${workOrder.status}`,
          });
          results.totalFailed++;
          continue;
        }
 
        
 
        // NOTE: Raw-item stock deduction intentionally removed.
        // No RawItem.quantity / variant.quantity / stockTransactions touched here.
        // Issuance is handled by the store/issuance flow.
 
        workOrder.status        = "scheduled";
        workOrder.plannedBy     = req.user.id;
        workOrder.plannedAt     = new Date();
        workOrder.planningNotes =
          workOrder.planningNotes || "Bulk planned from Manufacturing Order page";
 
        workOrder.operations.forEach(op => { op.status = "scheduled"; });
 
        await workOrder.save();
 
        results.success.push({
          id: workOrderId,
          workOrderNumber: workOrder.workOrderNumber,
          stockItemName: workOrder.stockItemName,
          quantity: workOrder.quantity,
        });
        results.totalSuccess++;
      } catch (error) {
        console.error(`Error planning work order ${workOrderId}:`, error);
        results.failed.push({
          id: workOrderId,
          reason: error.message || "Unknown error",
        });
        results.totalFailed++;
      }
 
      results.totalProcessed++;
    }
 
    res.json({
      success: results.totalSuccess > 0,
      message: `Planned ${results.totalSuccess} work order(s) successfully. ${results.totalFailed} failed.`,
      results,
    });
  } catch (error) {
    console.error("Error in bulk planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while planning work orders",
      error: error.message,
    });
  }
});


module.exports = router;