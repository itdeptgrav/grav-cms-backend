// routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js - UPDATED

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// GET all manufacturing orders (sales-approved customer requests)
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

    const customerRequests = await CustomerRequest.find(query)
      .populate("customerId", "name email phone")
      .populate("salesPersonAssigned", "name email")
      .populate("quotations.preparedBy", "name email")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js
    // Update the manufacturing orders list response

    const manufacturingOrders = await Promise.all(
      customerRequests.map(async (request) => {
        const workOrders = await WorkOrder.find({
          customerRequestId: request._id,
        }).select("status"); // Only select status field

        const totalQuantity = request.items.reduce(
          (sum, item) => sum + (item.totalQuantity || 0),
          0,
        );

        // Determine overall manufacturing order status based on work orders
        let overallStatus = "pending";
        const statusCounts = {};

        workOrders.forEach((wo) => {
          statusCounts[wo.status] = (statusCounts[wo.status] || 0) + 1;
        });

        // Priority-based status determination
        if (
          statusCounts["cancelled"] &&
          statusCounts["cancelled"] === workOrders.length
        ) {
          overallStatus = "cancelled";
        } else if (
          statusCounts["completed"] &&
          statusCounts["completed"] === workOrders.length
        ) {
          overallStatus = "completed";
        } else if (statusCounts["in_progress"]) {
          overallStatus = "in_production";
        } else if (statusCounts["scheduled"]) {
          overallStatus = "in_production"; // or "scheduled"
        } else if (statusCounts["planned"]) {
          overallStatus = "planning";
        } else if (statusCounts["pending"]) {
          overallStatus = "pending";
        }

        return {
          _id: request._id,
          moNumber: `MO-${request.requestId}`,
          requestId: request.requestId,
          customerInfo: request.customerInfo,
          finalOrderPrice: request.finalOrderPrice || 0,
          totalQuantity: totalQuantity,
          workOrdersCount: workOrders.length,
          workOrdersStatusSummary: statusCounts, // Add this field
          status: overallStatus, // Use the calculated status
          priority: request.priority,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          salesPerson: request.salesPersonAssigned,
          quotationNumber: request.quotations[0]?.quotationNumber,
          quotationDate: request.quotations[0]?.date,
          requestType: request.requestType || "customer_request",
          measurementId: request.measurementId || null,
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

// GET single manufacturing order details - MODIFIED FOR VARIANT-WISE QUANTITIES
// routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js

// GET single manufacturing order details - FIXED VERSION
router.get("/:id", async (req, res) => {
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

module.exports = router;
