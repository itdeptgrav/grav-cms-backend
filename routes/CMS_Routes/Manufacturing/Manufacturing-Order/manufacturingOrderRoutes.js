// routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js - UPDATED

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 12, search = "", status = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
 
    // Base filter — always restrict to sales-approved (this is what an MO IS)
    const matchQuery = { status: "quotation_sales_approved" };
    if (search) {
      const re = new RegExp(search, "i");
      matchQuery.$or = [
        { "customerInfo.name": re },
        { requestId: re },
        { "customerInfo.email": re },
      ];
    }
 
    const pipeline = [
      { $match: matchQuery },
 
      // Compute totalQuantity in-DB from items[].totalQuantity (no need to ship items)
      {
        $addFields: {
          totalQuantity: {
            $sum: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "it",
                in: { $ifNull: ["$$it.totalQuantity", 0] }
              }
            }
          }
        }
      },
 
      // Join WO stats per MO in ONE query (replaces the per-MO countDocuments + aggregate)
      {
        $lookup: {
          from: "workorders",
          let: { reqId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$customerRequestId", "$$reqId"] } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                totalWoQty: { $sum: { $ifNull: ["$quantity", 0] } },
                totalCompleted: {
                  $sum: { $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }
                },
                cancelledCount: {
                  $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] }
                },
                anyInProgress: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ["$status", "in_progress"] },
                          { $gt: [{ $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }, 0] }
                        ]
                      },
                      1, 0
                    ]
                  }
                }
              }
            }
          ],
          as: "_woStats"
        }
      },
      { $addFields: { _stats: { $arrayElemAt: ["$_woStats", 0] } } },
 
      // Flatten + compute completion % at the MO level
      {
        $addFields: {
          workOrdersCount: { $ifNull: ["$_stats.count", 0] },
          _totalWoQty: { $ifNull: ["$_stats.totalWoQty", 0] },
          _totalCompleted: { $ifNull: ["$_stats.totalCompleted", 0] },
          _cancelledCount: { $ifNull: ["$_stats.cancelledCount", 0] },
          _anyInProgress: { $ifNull: ["$_stats.anyInProgress", 0] }
        }
      },
      {
        $addFields: {
          completionPercentage: {
            $cond: [
              { $gt: ["$_totalWoQty", 0] },
              {
                $round: [
                  { $multiply: [{ $divide: ["$_totalCompleted", "$_totalWoQty"] }, 100] },
                  0
                ]
              },
              0
            ]
          }
        }
      },
 
      // Derive the MO status from WO progress
      {
        $addFields: {
          derivedStatus: {
            $switch: {
              branches: [
                { case: { $eq: ["$workOrdersCount", 0] }, then: "pending" },
                {
                  case: {
                    $and: [
                      { $gt: ["$workOrdersCount", 0] },
                      { $eq: ["$_cancelledCount", "$workOrdersCount"] }
                    ]
                  },
                  then: "cancelled"
                },
                { case: { $gte: ["$completionPercentage", 100] }, then: "completed" },
                { case: { $gte: ["$completionPercentage", 70] }, then: "about_to_finish" },
                {
                  case: {
                    $or: [
                      { $gt: ["$completionPercentage", 0] },
                      { $gt: ["$_anyInProgress", 0] }
                    ]
                  },
                  then: "in_progress"
                }
              ],
              default: "pending"
            }
          }
        }
      },
 
      // Apply derived status filter if requested
      ...(status ? [{ $match: { derivedStatus: status } }] : []),
 
      // Paginate + count in one go
      {
        $facet: {
          paginated: [
            { $sort: { updatedAt: -1 } },
            { $skip: skip },
            { $limit: limitNum },
            {
              $project: {
                _id: 1,
                requestId: 1,
                customerInfo: { name: 1, email: 1 },
                finalOrderPrice: 1,
                totalQuantity: 1,
                priority: 1,
                createdAt: 1,
                requestType: 1,
                measurementName: 1,
                workOrdersCount: 1,
                completionPercentage: 1,
                completedQuantity: "$_totalCompleted",
                status: "$derivedStatus"
              }
            }
          ],
          totalCount: [{ $count: "count" }]
        }
      }
    ];
 
    const [result] = await CustomerRequest.aggregate(pipeline);
    const rows = result?.paginated || [];
    const total = result?.totalCount?.[0]?.count || 0;
 
    const manufacturingOrders = rows.map((r) => ({
      _id: r._id,
      moNumber: `MO-${r.requestId}`,
      customerInfo: {
        name: r.customerInfo?.name || "N/A",
        email: r.customerInfo?.email || "N/A",
      },
      finalOrderPrice: r.finalOrderPrice || 0,
      totalQuantity: r.totalQuantity || 0,
      workOrdersCount: r.workOrdersCount || 0,
      completedQuantity: r.completedQuantity || 0,
      completionPercentage: r.completionPercentage || 0,
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt,
      requestType: r.requestType || "customer_request",
      measurementName: r.measurementName || null,
    }));
 
    res.json({
      success: true,
      manufacturingOrders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching manufacturing orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching manufacturing orders",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid manufacturing order ID format",
      });
    }

    // OPTIMIZED: Only select fields actually used on frontend
    const customerRequest = await CustomerRequest.findById(id)
      .select(
        "requestId customerInfo finalOrderPrice priority status estimatedCompletion deliveryDeadline createdAt requestType measurementName",
      )
      .lean();

    if (!customerRequest) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    // OPTIMIZED: Only get needed work order fields
    const workOrders = await WorkOrder.find({
      customerRequestId: customerRequest._id,
    })
      .select(
        "workOrderNumber status quantity variantAttributes operations rawMaterials stockItemId",
      )
      .populate("stockItemId", "name reference") // REMOVED images
      .sort({ createdAt: 1 })
      .lean();

    // OPTIMIZED: Transform work orders for frontend
    const optimizedWorkOrders = workOrders.map((wo) => ({
      _id: wo._id,
      workOrderNumber: wo.workOrderNumber,
      status: wo.status,
      quantity: wo.quantity,
      variantAttributes: wo.variantAttributes || [],
      operations: wo.operations || [],
      stockItemName: wo.stockItemId?.name || "N/A",
      stockItemReference: wo.stockItemId?.reference || "N/A",
      rawMaterials: wo.rawMaterials || [],
      // Count raw materials (frontend only shows count)
      rawMaterialsCount: (wo.rawMaterials || []).length,
    }));

    // OPTIMIZED: Simplified raw material aggregation
    const rawMaterialMap = new Map();

    for (const wo of workOrders) {
      for (const rm of wo.rawMaterials || []) {
        const variantKey = rm.rawItemVariantCombination?.join("-") || "default";
        const key = `${rm.rawItemId}_${variantKey}`;

        if (rawMaterialMap.has(key)) {
          const existing = rawMaterialMap.get(key);
          existing.quantityRequired += rm.quantityRequired;
        } else {
          rawMaterialMap.set(key, {
            rawItemId: rm.rawItemId,
            name: rm.name,
            sku: rm.sku,
            unit: rm.unit,
            unitCost: rm.unitCost,
            rawItemVariantCombination: rm.rawItemVariantCombination || [],
            quantityRequired: rm.quantityRequired,
          });
        }
      }
    }

    // OPTIMIZED: Fetch only needed stock info
    const rawMaterialRequirements = [];

    for (const [key, material] of rawMaterialMap) {
      if (
        material.rawItemId &&
        mongoose.Types.ObjectId.isValid(material.rawItemId)
      ) {
        const rawItem = await RawItem.findById(material.rawItemId)
          .select("variants") // ONLY need variants, not full document
          .lean();

        let variantStock = 0;

        // Find variant by combination
        if (
          material.rawItemVariantCombination?.length > 0 &&
          rawItem?.variants
        ) {
          const variant = rawItem.variants.find((v) =>
            (v.combination || []).every(
              (val, idx) => val === material.rawItemVariantCombination[idx],
            ),
          );
          variantStock = variant?.quantity || 0;
        }

        // Determine status
        let status = "unavailable";
        if (variantStock >= material.quantityRequired) {
          status = "available";
        } else if (variantStock > 0) {
          status = "partial";
        }

        rawMaterialRequirements.push({
          name: material.name,
          sku: material.sku,
          unit: material.unit,
          unitCost: material.unitCost,
          rawItemVariantCombination: material.rawItemVariantCombination,
          variantName:
            material.rawItemVariantCombination?.join(" • ") || "Default",
          quantityRequired: material.quantityRequired,
          variantStock: variantStock,
          status: status,
        });
      }
    }

    // OPTIMIZED: Minimal response structure
    const manufacturingOrder = {
      _id: customerRequest._id,
      moNumber: `MO-${customerRequest.requestId}`,
      requestId: customerRequest.requestId,
      customerInfo: {
        name: customerRequest.customerInfo?.name,
        email: customerRequest.customerInfo?.email,
        phone: customerRequest.customerInfo?.phone,
        address: customerRequest.customerInfo?.address,
        city: customerRequest.customerInfo?.city,
        postalCode: customerRequest.customerInfo?.postalCode,
        description: customerRequest.customerInfo?.description,
      },
      finalOrderPrice: customerRequest.finalOrderPrice || 0,
      priority: customerRequest.priority,
      status: customerRequest.status,
      estimatedCompletion: customerRequest.estimatedCompletion,
      deliveryDeadline: customerRequest.deliveryDeadline,
      createdAt: customerRequest.createdAt,
      requestType: customerRequest.requestType || "customer_request",
      measurementName: customerRequest.measurementName || null,
      specialInstructions: customerRequest.customerInfo?.description,

      workOrders: optimizedWorkOrders,
      rawMaterialRequirements: rawMaterialRequirements,
    };

    res.json({
      success: true,
      manufacturingOrder,
    });
  } catch (error) {
    console.error("Error fetching manufacturing order details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching manufacturing order details",
    });
  }
});

router.get("/:id/detailed", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid manufacturing order ID format",
      });
    }

    // Get customer request
    const customerRequest = await CustomerRequest.findById(id)
      .select(
        "requestId customerInfo finalOrderPrice priority status estimatedCompletion deliveryDeadline createdAt requestType measurementName",
      )
      .lean();

    if (!customerRequest) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    // Get all work orders for this manufacturing order WITH productionCompletion
    const workOrders = await WorkOrder.find({
      customerRequestId: customerRequest._id,
    })
      .select(
        "workOrderNumber status quantity variantAttributes operations timeline stockItemId productionCompletion",
      )
      .populate("stockItemId", "name reference")
      .sort({ createdAt: 1 })
      .lean();

    // Calculate accurate statistics from productionCompletion
    let totalUnitsCompleted = 0;
    let totalUnitsInProgress = 0;
    let totalUnitsPending = 0;
    let totalQuantity = 0;
    let completedWorkOrders = 0;
    let inProgressWorkOrders = 0;
    let pendingWorkOrders = 0;

    // Transform work orders with accurate progress data
    const transformedWorkOrders = workOrders.map((wo) => {
      const productionCompletion = wo.productionCompletion || {};
      const totalQuantity = wo.quantity;

      // Get completion data from productionCompletion
      const completedQuantity =
        productionCompletion.overallCompletedQuantity || 0;
      const completionPercentage =
        productionCompletion.overallCompletionPercentage || 0;

      // Calculate unit statuses
      let completedUnits = completedQuantity;
      let inProgressUnits = 0;
      let pendingUnits = totalQuantity - completedQuantity;

      // If work order is in progress but not all units completed, estimate in-progress units
      if (wo.status === "in_progress" && completedQuantity < totalQuantity) {
        // Look at operation completion to estimate in-progress units
        if (
          productionCompletion.operationCompletion &&
          productionCompletion.operationCompletion.length > 0
        ) {
          const maxOpCompleted = Math.max(
            ...productionCompletion.operationCompletion.map(
              (op) => op.completedQuantity,
            ),
          );
          inProgressUnits = Math.max(0, maxOpCompleted - completedQuantity);
          pendingUnits = totalQuantity - completedQuantity - inProgressUnits;
        } else {
          // If no operation data, assume 1 unit is in progress
          inProgressUnits = 1;
          pendingUnits = totalQuantity - completedQuantity - 1;
        }
      }

      // Update global totals
      totalUnitsCompleted += completedUnits;
      totalUnitsInProgress += inProgressUnits;
      totalUnitsPending += pendingUnits;
      totalQuantity += totalQuantity;

      // Determine work order status based on productionCompletion
      let status = wo.status;
      let derivedStatus = wo.status;

      if (completionPercentage === 100) {
        derivedStatus = "completed";
        completedWorkOrders++;
      } else if (completionPercentage > 0) {
        derivedStatus = "in_progress";
        inProgressWorkOrders++;
      } else {
        derivedStatus = "pending";
        pendingWorkOrders++;
      }

      // Get operation progress
      const operationProgress = (
        productionCompletion.operationCompletion || []
      ).map((op) => ({
        operationNumber: op.operationNumber,
        operationType: op.operationType,
        completedQuantity: op.completedQuantity,
        totalQuantity: op.totalQuantity,
        completionPercentage: op.completionPercentage,
        status: op.status,
        assignedMachines: op.assignedMachines || [],
      }));

      return {
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        status: status,
        derivedStatus: derivedStatus,
        quantity: totalQuantity,
        variantAttributes: wo.variantAttributes || [],
        stockItemName: wo.stockItemId?.name || "N/A",
        stockItemReference: wo.stockItemId?.reference || "N/A",

        // Progress data from productionCompletion
        progress: {
          completedUnits: completedUnits,
          inProgressUnits: inProgressUnits,
          pendingUnits: pendingUnits,
          completionPercentage: completionPercentage,
          lastUpdated: productionCompletion.lastSyncedAt,
        },

        // Operation progress
        operations: operationProgress,

        // Efficiency data if available
        efficiency:
          productionCompletion.efficiencyMetrics?.length > 0
            ? {
                avgEfficiency:
                  productionCompletion.efficiencyMetrics.reduce(
                    (sum, m) => sum + m.efficiencyPercentage,
                    0,
                  ) / productionCompletion.efficiencyMetrics.length,
                totalScans:
                  productionCompletion.operatorDetails?.reduce(
                    (sum, op) => sum + op.totalScans,
                    0,
                  ) || 0,
              }
            : null,

        // Invalid scans if any
        invalidScans: productionCompletion.invalidScansCount || 0,
      };
    });

    // Calculate overall manufacturing order progress
    const overallCompletionPercentage =
      totalQuantity > 0
        ? Math.round((totalUnitsCompleted / totalQuantity) * 100)
        : 0;

    // Determine manufacturing order status
    let overallStatus = "pending";
    if (overallCompletionPercentage === 100) {
      overallStatus = "completed";
    } else if (overallCompletionPercentage > 0) {
      overallStatus = "in_production";
    } else if (
      pendingWorkOrders === 0 &&
      (completedWorkOrders > 0 || inProgressWorkOrders > 0)
    ) {
      overallStatus = "planning";
    }

    // Get raw material requirements (simplified for this view)
    const rawMaterialMap = new Map();

    for (const wo of workOrders) {
      for (const rm of wo.rawMaterials || []) {
        const variantKey = rm.rawItemVariantCombination?.join("-") || "default";
        const key = `${rm.rawItemId}_${variantKey}`;

        if (rawMaterialMap.has(key)) {
          const existing = rawMaterialMap.get(key);
          existing.quantityRequired += rm.quantityRequired;
        } else {
          rawMaterialMap.set(key, {
            rawItemId: rm.rawItemId,
            name: rm.name,
            sku: rm.sku,
            unit: rm.unit,
            rawItemVariantCombination: rm.rawItemVariantCombination || [],
            quantityRequired: rm.quantityRequired,
          });
        }
      }
    }

    // Prepare response
    const manufacturingOrder = {
      _id: customerRequest._id,
      moNumber: `MO-${customerRequest.requestId}`,
      requestId: customerRequest.requestId,
      customerInfo: {
        name: customerRequest.customerInfo?.name,
        email: customerRequest.customerInfo?.email,
        phone: customerRequest.customerInfo?.phone,
        address: customerRequest.customerInfo?.address,
        city: customerRequest.customerInfo?.city,
        postalCode: customerRequest.customerInfo?.postalCode,
        description: customerRequest.customerInfo?.description,
      },
      finalOrderPrice: customerRequest.finalOrderPrice || 0,
      priority: customerRequest.priority,
      status: overallStatus,
      estimatedCompletion: customerRequest.estimatedCompletion,
      deliveryDeadline: customerRequest.deliveryDeadline,
      createdAt: customerRequest.createdAt,
      requestType: customerRequest.requestType || "customer_request",
      measurementName: customerRequest.measurementName || null,
      specialInstructions: customerRequest.customerInfo?.description,

      // Work orders with accurate progress
      workOrders: transformedWorkOrders,

      // Progress statistics
      progress: {
        totalWorkOrders: workOrders.length,
        completedWorkOrders: completedWorkOrders,
        inProgressWorkOrders: inProgressWorkOrders,
        pendingWorkOrders: pendingWorkOrders,

        units: {
          total: totalQuantity,
          completed: totalUnitsCompleted,
          inProgress: totalUnitsInProgress,
          pending: totalUnitsPending,
          completionPercentage: overallCompletionPercentage,
        },

        // Time tracking
        startedAt: workOrders.find((wo) => wo.timeline?.actualStartDate)
          ?.timeline?.actualStartDate,
        estimatedCompletion: workOrders[0]?.timeline?.plannedEndDate,
        lastSync: Math.max(
          ...workOrders.map((wo) =>
            wo.productionCompletion?.lastSyncedAt
              ? new Date(wo.productionCompletion.lastSyncedAt).getTime()
              : 0,
          ),
        ),
      },

      rawMaterialRequirements: Array.from(rawMaterialMap.values()),

      // Summary stats
      summary: {
        totalValue: customerRequest.finalOrderPrice || 0,
        totalItems: workOrders.reduce(
          (sum, wo) => sum + (wo.items?.length || 0),
          0,
        ),
        isMeasurementConversion:
          customerRequest.requestType === "measurement_conversion",
        measurementName: customerRequest.measurementName,
      },
    };

    res.json({
      success: true,
      manufacturingOrder,
    });
  } catch (error) {
    console.error("Error fetching manufacturing order details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching manufacturing order details",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET work orders for a manufacturing order
router.get("/:id/work-orders", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrders = await WorkOrder.find({
      customerRequestId: id,
    })
      .populate("stockItemId", "name reference images")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .sort({ createdAt: 1 });

    res.json({
      success: true,
      workOrders,
    });
  } catch (error) {
    console.error("Error fetching work orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work orders",
    });
  }
});

router.get("/emplloyeeTracking/:id", async (req, res) => {
  try {
    const { id } = req.params;
 
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid manufacturing order ID format",
      });
    }
 
    // ── CR: select only what the frontend uses ─────────────────────────────
    const customerRequest = await CustomerRequest.findById(id)
      .select(
        "requestId customerInfo finalOrderPrice totalPaidAmount totalDueAmount " +
        "priority status measurementId measurementName requestType " +
        "salesPersonAssigned quotations actualCompletion " +
        "estimatedCompletion createdAt updatedAt"
      )
      .populate("salesPersonAssigned", "name email phone")
      .lean();
 
    if (!customerRequest) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }
 
    // ── WOs: trimmed selection + add genderCategory ─────────────────────────
    const workOrders = await WorkOrder.find({
      customerRequestId: customerRequest._id,
    })
      .select(
        "workOrderNumber status quantity stockItemId stockItemName stockItemReference " +
        "operations forwardedToVendor productionCompletion variantAttributes rawMaterials"
      )
      .populate("stockItemId", "name reference genderCategory") // ← genderCategory added
      .populate("forwardedToVendor", "name vendorCode")
      .sort({ createdAt: 1 })
      .lean();
 
    // ── Stats ───────────────────────────────────────────────────────────────
    const totalWorkOrders = workOrders.length;
    const totalQuantity = workOrders.reduce((s, wo) => s + (wo.quantity || 0), 0);
    let plannedWorkOrders = 0, scheduledWorkOrders = 0,
        inProgressWorkOrders = 0, completedWorkOrders = 0;
    for (const wo of workOrders) {
      if (wo.status === "planned")       plannedWorkOrders++;
      if (wo.status === "scheduled")     scheduledWorkOrders++;
      if (wo.status === "in_progress")   inProgressWorkOrders++;
      if (wo.status === "completed")     completedWorkOrders++;
    }
 
    // ── Aggregate raw materials across WOs ──────────────────────────────────
    const rawMaterialMap = new Map();
    for (const wo of workOrders) {
      for (const rm of wo.rawMaterials || []) {
        const variantKey = rm.rawItemVariantCombination?.join("-") || "default";
        const key = `${rm.rawItemId}_${variantKey}`;
 
        if (rawMaterialMap.has(key)) {
          const existing = rawMaterialMap.get(key);
          existing.quantityRequired += rm.quantityRequired;
          existing.totalCost += rm.totalCost;
          existing.sourceWorkOrders.push(wo.workOrderNumber);
        } else {
          rawMaterialMap.set(key, {
            rawItemId: rm.rawItemId,
            name: rm.name,
            sku: rm.sku,
            rawItemVariantId: rm.rawItemVariantId,
            rawItemVariantCombination: rm.rawItemVariantCombination || [],
            variantName: rm.rawItemVariantCombination?.join(" • ") || "Default",
            quantityRequired: rm.quantityRequired,
            unit: rm.unit,
            unitCost: rm.unitCost,
            totalCost: rm.totalCost,
            sourceWorkOrders: [wo.workOrderNumber],
            sourceWorkOrderId: wo._id,
          });
        }
      }
    }
 
    // ── BATCH raw item lookups: N queries → 1 ──────────────────────────────
    const rawItemIds = [
      ...new Set(
        [...rawMaterialMap.values()]
          .map((m) => m.rawItemId?.toString())
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
      ),
    ];
 
    let rawItemMap = new Map();
    if (rawItemIds.length > 0) {
      const rawItems = await RawItem.find({ _id: { $in: rawItemIds } })
        .select("variants quantity status")
        .lean();
      rawItemMap = new Map(rawItems.map((r) => [r._id.toString(), r]));
    }
 
    // ── Compute variant stock + status for each requirement ────────────────
    const allRawMaterialRequirements = [];
    for (const material of rawMaterialMap.values()) {
      const rawItem = material.rawItemId
        ? rawItemMap.get(material.rawItemId.toString())
        : null;
 
      let variantStock = 0;
      const totalStock = rawItem?.quantity || 0;
 
      // Find specific variant if rawItemVariantId exists
      if (material.rawItemVariantId && rawItem?.variants) {
        const variant = rawItem.variants.find(
          (v) => v._id.toString() === material.rawItemVariantId.toString()
        );
        if (variant) variantStock = variant.quantity || 0;
      } else if (
        material.rawItemVariantCombination?.length > 0 &&
        rawItem?.variants
      ) {
        const variant = rawItem.variants.find((v) => {
          const vc = v.combination || [];
          const mc = material.rawItemVariantCombination;
          if (vc.length !== mc.length) return false;
          return vc.every((val, idx) => val === mc[idx]);
        });
        if (variant) variantStock = variant.quantity || 0;
      }
 
      let status = "unavailable";
      if (variantStock >= material.quantityRequired) status = "available";
      else if (variantStock > 0) status = "partial";
 
      const deficitQuantity = Math.max(0, material.quantityRequired - variantStock);
 
      allRawMaterialRequirements.push({
        ...material,
        variantStock,
        totalStock,
        availableQuantity: variantStock,
        deficitQuantity,
        status,
        rawItemStatus: rawItem?.status,
        requiresVariant:
          material.rawItemVariantCombination?.length > 0 ||
          !!material.rawItemVariantId,
        variantId: material.rawItemVariantId?.toString(),
      });
    }
 
    // ── Build response ──────────────────────────────────────────────────────
    const isMeasurementConversion = !!(
      customerRequest.requestType === "measurement_conversion" ||
      customerRequest.measurementId
    );
 
    const manufacturingOrder = {
      _id: customerRequest._id,
      moNumber: `MO-${customerRequest.requestId}`,
      requestId: customerRequest.requestId,
      customerInfo: customerRequest.customerInfo,
      finalOrderPrice: customerRequest.finalOrderPrice || 0,
      totalPaidAmount: customerRequest.totalPaidAmount || 0,
      totalDueAmount: customerRequest.totalDueAmount || 0,
      priority: customerRequest.priority,
      status: customerRequest.status,
      salesPerson: customerRequest.salesPersonAssigned,
      quotation: customerRequest.quotations?.[0] || null,
      estimatedCompletion: customerRequest.estimatedCompletion,
      specialInstructions: customerRequest.customerInfo?.description,
      deliveryDeadline: customerRequest.customerInfo?.deliveryDeadline,
      createdAt: customerRequest.createdAt,
      updatedAt: customerRequest.updatedAt,
 
      requestType: isMeasurementConversion ? "measurement_conversion" : "customer_request",
      requestTypeBadge: isMeasurementConversion ? "MEASUREMENT" : "CUSTOMER",
      measurementId: customerRequest.measurementId || null,
      measurementName: customerRequest.measurementName || null,
      isMeasurementConversion,
 
      workOrders,
      workOrderStats: {
        total: totalWorkOrders,
        planned: plannedWorkOrders,
        scheduled: scheduledWorkOrders,
        inProgress: inProgressWorkOrders,
        completed: completedWorkOrders,
        totalQuantity,
      },
 
      rawMaterialRequirements: allRawMaterialRequirements,
      totalRawMaterialCost: allRawMaterialRequirements.reduce(
        (sum, rm) => sum + (rm.totalCost || 0),
        0
      ),
 
      timeline: {
        requestCreated: customerRequest.createdAt,
        salesApproved: customerRequest.quotations?.[0]?.salesApproval?.approvedAt,
        estimatedCompletion: customerRequest.estimatedCompletion,
        actualCompletion: customerRequest.actualCompletion,
      },
    };
 
    res.json({ success: true, manufacturingOrder });
  } catch (error) {
    console.error("Error fetching manufacturing order details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching manufacturing order details",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});


// GET work orders for a manufacturing order
router.get("/employeeTracking/:id/work-orders", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrders = await WorkOrder.find({
      customerRequestId: id,
    })
      .populate("stockItemId", "name reference images")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .sort({ createdAt: 1 });

    res.json({
      success: true,
      workOrders,
    });
  } catch (error) {
    console.error("Error fetching work orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work orders",
    });
  }
});


// =============================================
// NEW ROUTE: Get active vendors for sharing
// =============================================
router.get("/vendors/active", async (req, res) => {
  try {
    const Vendor = require("../../../../models/Vendor_Models/vendor");
    
    const vendors = await Vendor.find({ 
      status: "active",
      isDeleted: false 
    })
    .select("name contactPerson email phone vendorCode category city state")
    .sort({ name: 1 })
    .lean();

    res.json({
      success: true,
      vendors
    });
  } catch (error) {
    console.error("Error fetching active vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors"
    });
  }
});

// =============================================
// NEW ROUTE: Share work orders to vendor
// =============================================
router.post("/share-to-vendor", async (req, res) => {
  try {
    const { workOrderIds, vendorId, forwardedBy } = req.body;

    if (!workOrderIds || !workOrderIds.length || !vendorId) {
      return res.status(400).json({
        success: false,
        message: "Work order IDs and vendor ID are required"
      });
    }

    // Validate vendor exists
    const Vendor = require("../../../../models/Vendor_Models/vendor");
    const vendor = await Vendor.findOne({ 
      _id: vendorId, 
      status: "active",
      isDeleted: false 
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Active vendor not found"
      });
    }

    // Update all selected work orders
    const updateData = {
      status: "forwarded",
      forwardedToVendor: vendorId,
      forwardedAt: new Date(),
      forwardedBy: forwardedBy || null,
      vendorWorkOrderReference: null // Will be set by vendor when they accept
    };

    const result = await WorkOrder.updateMany(
      { 
        _id: { $in: workOrderIds },
        status: { $nin: ["completed", "cancelled", "forwarded"] }
      },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid work orders found to share"
      });
    }

    // Fetch the updated work orders for response
    const updatedWorkOrders = await WorkOrder.find({
      _id: { $in: workOrderIds }
    })
    .select("workOrderNumber status forwardedToVendor forwardedAt")
    .populate("forwardedToVendor", "name vendorCode")
    .lean();

    res.json({
      success: true,
      message: `${result.modifiedCount} work order(s) shared successfully`,
      sharedCount: result.modifiedCount,
      workOrders: updatedWorkOrders,
      vendor: {
        id: vendor._id,
        name: vendor.name,
        vendorCode: vendor.vendorCode
      }
    });

  } catch (error) {
    console.error("Error sharing work orders to vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while sharing work orders"
    });
  }
});

router.get("/stats/overview", async (req, res) => {
  try {
    // Total Manufacturing Orders (all with sales approved status)
    const totalMO = await CustomerRequest.countDocuments({
      status: "quotation_sales_approved",
    });

    // Total Work Orders
    const totalWO = await WorkOrder.countDocuments({});

    // Ongoing Work Orders (in_progress)
    const ongoingWO = await WorkOrder.countDocuments({
      status: "in_progress",
    });

    // Completed Work Orders
    const completedWO = await WorkOrder.countDocuments({
      status: "completed",
    });

    // Pending Work Orders (pending + planned + scheduled)
    const pendingWO = await WorkOrder.countDocuments({
      status: { $in: ["pending", "planned", "scheduled", "ready_to_start"] },
    });

    // Forwarded Work Orders (to vendor)
    const forwardedWO = await WorkOrder.countDocuments({
      status: "forwarded",
    });

    // MOs created this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const newMOThisMonth = await CustomerRequest.countDocuments({
      status: "quotation_sales_approved",
      createdAt: { $gte: startOfMonth },
    });

    // WOs completed this month
    const completedWOThisMonth = await WorkOrder.countDocuments({
      status: "completed",
      updatedAt: { $gte: startOfMonth },
    });

    res.json({
      success: true,
      stats: {
        totalMO,
        totalWO,
        ongoingWO,
        completedWO,
        pendingWO,
        forwardedWO,
        newMOThisMonth,
        completedWOThisMonth,
      },
    });
  } catch (error) {
    console.error("Error fetching production stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching production stats",
    });
  }
});



module.exports = router;
