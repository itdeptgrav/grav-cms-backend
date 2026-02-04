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
    const { page = 1, limit = 10, search = "", status = "" } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let query = {
      status: "quotation_sales_approved",
    };

    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { "customerInfo.name": searchRegex },
        { requestId: searchRegex },
        { "customerInfo.email": searchRegex },
      ];
    }

    if (status) {
      query.status = status;
    }

    const total = await CustomerRequest.countDocuments(query);

    // OPTIMIZED: Only select needed fields, minimal population
    const customerRequests = await CustomerRequest.find(query)
      .select("requestId customerInfo status finalOrderPrice items priority createdAt requestType measurementName")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const manufacturingOrders = await Promise.all(
      customerRequests.map(async (request) => {
        // OPTIMIZED: Only get count of work orders, not full documents
        const workOrdersCount = await WorkOrder.countDocuments({
          customerRequestId: request._id,
        });

        const totalQuantity = request.items.reduce(
          (sum, item) => sum + (item.totalQuantity || 0),
          0,
        );

        // OPTIMIZED: Get status from work orders aggregation
        const statusAggregation = await WorkOrder.aggregate([
          { $match: { customerRequestId: request._id } },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 }
            }
          }
        ]);

        const statusCounts = {};
        statusAggregation.forEach(item => {
          statusCounts[item._id] = item.count;
        });

        // Determine overall status (simplified logic)
        let overallStatus = "pending";
        const totalWorkOrders = workOrdersCount;

        if (statusCounts["cancelled"] === totalWorkOrders) {
          overallStatus = "cancelled";
        } else if (statusCounts["completed"] === totalWorkOrders) {
          overallStatus = "completed";
        } else if (statusCounts["in_progress"] > 0) {
          overallStatus = "in_production";
        } else if (statusCounts["planned"] > 0) {
          overallStatus = "planning";
        }

        // OPTIMIZED: Minimal response data
        return {
          _id: request._id,
          moNumber: `MO-${request.requestId}`,
          customerInfo: {
            name: request.customerInfo?.name || "N/A",
            email: request.customerInfo?.email || "N/A"
          },
          finalOrderPrice: request.finalOrderPrice || 0,
          totalQuantity: totalQuantity,
          workOrdersCount: workOrdersCount,
          status: overallStatus,
          priority: request.priority,
          createdAt: request.createdAt,
          requestType: request.requestType || "customer_request",
          measurementName: request.measurementName || null,
        };
      }),
    );

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
      .select("requestId customerInfo finalOrderPrice priority status estimatedCompletion deliveryDeadline createdAt requestType measurementName")
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
      .select("workOrderNumber status quantity variantAttributes operations rawMaterials stockItemId")
      .populate("stockItemId", "name reference") // REMOVED images
      .sort({ createdAt: 1 })
      .lean();

    // OPTIMIZED: Transform work orders for frontend
    const optimizedWorkOrders = workOrders.map(wo => ({
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
      rawMaterialsCount: (wo.rawMaterials || []).length
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
            quantityRequired: rm.quantityRequired
          });
        }
      }
    }

    // OPTIMIZED: Fetch only needed stock info
    const rawMaterialRequirements = [];

    for (const [key, material] of rawMaterialMap) {
      if (material.rawItemId && mongoose.Types.ObjectId.isValid(material.rawItemId)) {
        const rawItem = await RawItem.findById(material.rawItemId)
          .select("variants") // ONLY need variants, not full document
          .lean();

        let variantStock = 0;
        
        // Find variant by combination
        if (material.rawItemVariantCombination?.length > 0 && rawItem?.variants) {
          const variant = rawItem.variants.find(v => 
            (v.combination || []).every((val, idx) => 
              val === material.rawItemVariantCombination[idx]
            )
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
          variantName: material.rawItemVariantCombination?.join(" • ") || "Default",
          quantityRequired: material.quantityRequired,
          variantStock: variantStock,
          status: status
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
        description: customerRequest.customerInfo?.description
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
      rawMaterialRequirements: rawMaterialRequirements
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

    // Check if id is a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid manufacturing order ID format",
      });
    }

    const customerRequest = await CustomerRequest.findById(id)
      .populate("customerId", "name email phone address")
      .populate("salesPersonAssigned", "name email phone")
      .populate("quotations.preparedBy", "name email")
      .lean();

    if (!customerRequest) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    const workOrders = await WorkOrder.find({
      customerRequestId: customerRequest._id,
    })
      .populate("stockItemId", "name reference images")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .sort({ createdAt: 1 })
      .lean();

    const totalWorkOrders = workOrders.length;
    const totalQuantity = workOrders.reduce((sum, wo) => sum + wo.quantity, 0);

    const plannedWorkOrders = workOrders.filter(
      (wo) => wo.status === "planned",
    ).length;
    const scheduledWorkOrders = workOrders.filter(
      (wo) => wo.status === "scheduled",
    ).length;
    const inProgressWorkOrders = workOrders.filter(
      (wo) => wo.status === "in_progress",
    ).length;
    const completedWorkOrders = workOrders.filter(
      (wo) => wo.status === "completed",
    ).length;

    // Get aggregated raw material requirements with variant-wise stock
    const rawMaterialMap = new Map();

    for (const wo of workOrders) {
      for (const rm of wo.rawMaterials) {
        // Create a unique key: rawItemId + variant combination
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
            // VARIANT-SPECIFIC FIELDS
            rawItemVariantId: rm.rawItemVariantId,
            rawItemVariantCombination: rm.rawItemVariantCombination || [],
            variantName: rm.rawItemVariantCombination?.join(" • ") || "Default",
            // QUANTITY AND COST
            quantityRequired: rm.quantityRequired,
            unit: rm.unit,
            unitCost: rm.unitCost,
            totalCost: rm.totalCost,
            // SOURCE INFO
            sourceWorkOrders: [wo.workOrderNumber],
            sourceWorkOrderId: wo._id,
          });
        }
      }
    }

    // Fetch current stock for each raw material - WITH VARIANT SUPPORT
    const allRawMaterialRequirements = [];

    for (const [key, material] of rawMaterialMap) {
      if (
        material.rawItemId &&
        mongoose.Types.ObjectId.isValid(material.rawItemId)
      ) {
        const rawItem = await RawItem.findById(material.rawItemId).lean();

        let variantStock = 0;
        const totalStock = rawItem?.quantity || 0;

        // Find specific variant if rawItemVariantId exists
        if (material.rawItemVariantId && rawItem?.variants) {
          const variant = rawItem.variants.find(
            (v) => v._id.toString() === material.rawItemVariantId.toString(),
          );
          if (variant) {
            variantStock = variant.quantity || 0;
          }
        }
        // Or find variant by combination
        else if (
          material.rawItemVariantCombination?.length > 0 &&
          rawItem?.variants
        ) {
          const variant = rawItem.variants.find((v) => {
            // Compare variant combinations
            const vCombination = v.combination || [];
            const mCombination = material.rawItemVariantCombination;

            if (vCombination.length !== mCombination.length) return false;

            return vCombination.every((val, idx) => val === mCombination[idx]);
          });

          if (variant) {
            variantStock = variant.quantity || 0;
          }
        }

        // Calculate status based on VARIANT stock, not total stock
        let status = "unavailable";
        if (variantStock >= material.quantityRequired) {
          status = "available";
        } else if (variantStock > 0) {
          status = "partial";
        }

        const deficitQuantity = Math.max(
          0,
          material.quantityRequired - variantStock,
        );

        allRawMaterialRequirements.push({
          ...material,
          // STOCK INFORMATION
          variantStock: variantStock, // Specific variant quantity
          totalStock: totalStock, // Total raw item quantity
          availableQuantity: variantStock, // For backward compatibility
          deficitQuantity: deficitQuantity,
          status: status,
          rawItemStatus: rawItem?.status,

          // ADDITIONAL INFO FOR UI
          requiresVariant:
            material.rawItemVariantCombination?.length > 0 ||
            !!material.rawItemVariantId,
          variantId: material.rawItemVariantId?.toString(),
        });
      }
    }

    // CRITICAL FIX: Properly determine requestType from the database
    // Check multiple fields to ensure accuracy
    const isMeasurementConversion = !!(
      customerRequest.requestType === "measurement_conversion" ||
      customerRequest.measurementId
    );

    // Log for debugging
    console.log("=== REQUEST TYPE DEBUG ===");
    console.log("CustomerRequest ID:", customerRequest._id);
    console.log("requestType field:", customerRequest.requestType);
    console.log("measurementId:", customerRequest.measurementId);
    console.log("Calculated isMeasurementConversion:", isMeasurementConversion);

    const requestType = isMeasurementConversion
      ? "measurement_conversion"
      : "customer_request";

    const requestTypeBadge = isMeasurementConversion
      ? "MEASUREMENT"
      : "CUSTOMER";

    console.log("Final requestType:", requestType);
    console.log("Final requestTypeBadge:", requestTypeBadge);
    console.log("========================");

    const manufacturingOrder = {
      _id: customerRequest._id,
      moNumber: `MO-${customerRequest.requestId}`,
      requestId: customerRequest.requestId,
      customerInfo: customerRequest.customerInfo,
      customer: customerRequest.customerId,
      items: customerRequest.items,
      finalOrderPrice: customerRequest.finalOrderPrice || 0,
      totalPaidAmount: customerRequest.totalPaidAmount || 0,
      totalDueAmount: customerRequest.totalDueAmount || 0,
      priority: customerRequest.priority,
      status: customerRequest.status,
      salesPerson: customerRequest.salesPersonAssigned,
      quotation: customerRequest.quotations[0],
      estimatedCompletion: customerRequest.estimatedCompletion,
      specialInstructions: customerRequest.customerInfo?.description,
      deliveryDeadline: customerRequest.customerInfo?.deliveryDeadline,
      createdAt: customerRequest.createdAt,
      updatedAt: customerRequest.updatedAt,

      // CRITICAL: These fields MUST be set correctly
      requestType: requestType,
      requestTypeBadge: requestTypeBadge,
      measurementId: customerRequest.measurementId || null,
      measurementName: customerRequest.measurementName || null,
      isMeasurementConversion: isMeasurementConversion,

      workOrders: workOrders,
      workOrderStats: {
        total: totalWorkOrders,
        planned: plannedWorkOrders,
        scheduled: scheduledWorkOrders,
        inProgress: inProgressWorkOrders,
        completed: completedWorkOrders,
        totalQuantity: totalQuantity,
      },

      rawMaterialRequirements: allRawMaterialRequirements,
      totalRawMaterialCost: allRawMaterialRequirements.reduce(
        (sum, rm) => sum + rm.totalCost,
        0,
      ),

      timeline: {
        requestCreated: customerRequest.createdAt,
        salesApproved: customerRequest.quotations[0]?.salesApproval?.approvedAt,
        estimatedCompletion: customerRequest.estimatedCompletion,
        actualCompletion: customerRequest.actualCompletion,
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

module.exports = router;
