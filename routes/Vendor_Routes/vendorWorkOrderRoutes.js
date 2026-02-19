const express = require("express");
const router = express.Router();
const VendorAuthMiddleware = require("../../Middlewear/VendorAuthMiddleware");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Vendor = require("../../models/Vendor_Models/vendor");
const mongoose = require("mongoose");

// Apply vendor authentication to all routes
router.use(VendorAuthMiddleware);

// =============================================
// GET dashboard counts/stats - LIGHTWEIGHT
// =============================================
router.get("/dashboard/stats", async (req, res) => {
  try {
    const vendorId = req.vendor._id;

    const counts = await WorkOrder.aggregate([
      { 
        $match: { 
          forwardedToVendor: vendorId,
          status: { $in: ["forwarded", "planned", "in_progress", "completed"] }
        } 
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]);

    const stats = {
      forwarded: 0,
      planned: 0,
      in_progress: 0,
      completed: 0,
      total: 0
    };

    counts.forEach(item => {
      stats[item._id] = item.count;
      stats.total += item.count;
    });

    // Get recent activity count (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentActivity = await WorkOrder.countDocuments({
      forwardedToVendor: vendorId,
      forwardedAt: { $gte: sevenDaysAgo }
    });

    res.json({
      success: true,
      stats: {
        ...stats,
        recentActivity
      }
    });

  } catch (error) {
    console.error("Error fetching vendor dashboard stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =============================================
// GET all shared work orders (with minimal fields)
// =============================================
router.get("/work-orders", async (req, res) => {
  try {
    const vendorId = req.vendor._id;
    const { status = "all", page = 1, limit = 10, search = "" } = req.query;

    const query = {
      forwardedToVendor: vendorId,
      status: { $in: ["forwarded", "planned", "in_progress", "completed"] }
    };

    // Status filter
    if (status !== "all") {
      query.status = status;
    }

    // Search filter (work order number or product name)
    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { workOrderNumber: searchRegex },
        { stockItemName: searchRegex }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // SELECT only fields needed for list view - OPTIMIZED
    const workOrders = await WorkOrder.find(query)
      .select(
        "workOrderNumber stockItemName stockItemReference quantity variantAttributes status forwardedAt vendorWorkOrderReference"
      )
      .sort({ forwardedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await WorkOrder.countDocuments(query);

    res.json({
      success: true,
      workOrders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error("Error fetching vendor work orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =============================================
// GET single work order details (full view)
// =============================================
router.get("/work-orders/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const vendorId = req.vendor._id;

    if (!mongoose.Types.ObjectId.isValid(workOrderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID"
      });
    }

    const workOrder = await WorkOrder.findOne({
      _id: workOrderId,
      forwardedToVendor: vendorId
    })
      .select(
        "workOrderNumber stockItemName stockItemReference quantity variantAttributes " +
        "operations rawMaterials timeline status forwardedAt forwardedBy vendorWorkOrderReference " +
        "productionNotes specialInstructions createdAt estimatedCost"
      )
      .populate("forwardedBy", "name email")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }

    // Calculate summary stats
    const summary = {
      totalOperations: workOrder.operations?.length || 0,
      totalRawMaterials: workOrder.rawMaterials?.length || 0,
      estimatedCost: workOrder.estimatedCost || 0,
      daysSinceReceived: Math.floor(
        (new Date() - new Date(workOrder.forwardedAt)) / (1000 * 60 * 60 * 24)
      )
    };

    res.json({
      success: true,
      workOrder,
      summary
    });

  } catch (error) {
    console.error("Error fetching work order details:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =============================================
// ACCEPT work order with vendor reference
// =============================================
router.post("/work-orders/:workOrderId/accept", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const vendorId = req.vendor._id;
    const { vendorReference, estimatedCompletion, notes } = req.body;

    if (!vendorReference) {
      return res.status(400).json({
        success: false,
        message: "Vendor work order reference is required"
      });
    }

    const workOrder = await WorkOrder.findOne({
      _id: workOrderId,
      forwardedToVendor: vendorId,
      status: "forwarded"
    });

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found or already processed"
      });
    }

    // Update work order
    workOrder.status = "planned";
    workOrder.vendorWorkOrderReference = vendorReference;
    
    // Add note
    workOrder.productionNotes = workOrder.productionNotes || [];
    workOrder.productionNotes.push({
      note: `Vendor accepted. Reference: ${vendorReference}${notes ? ` - ${notes}` : ""}`,
      addedAt: new Date(),
      addedByModel: "Vendor"
    });

    // Update timeline if estimated completion provided
    if (estimatedCompletion) {
      workOrder.timeline = workOrder.timeline || {};
      workOrder.timeline.plannedEndDate = new Date(estimatedCompletion);
    }

    await workOrder.save();

    // Update vendor's total orders count
    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { totalOrders: 1 },
      lastOrder: new Date()
    });

    res.json({
      success: true,
      message: "Work order accepted successfully",
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        vendorWorkOrderReference: workOrder.vendorWorkOrderReference
      }
    });

  } catch (error) {
    console.error("Error accepting work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =============================================
// REJECT work order with reason
// =============================================
router.post("/work-orders/:workOrderId/reject", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const vendorId = req.vendor._id;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required"
      });
    }

    const workOrder = await WorkOrder.findOne({
      _id: workOrderId,
      forwardedToVendor: vendorId,
      status: "forwarded"
    });

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found or already processed"
      });
    }

    workOrder.status = "cancelled";
    workOrder.productionNotes = workOrder.productionNotes || [];
    workOrder.productionNotes.push({
      note: `Vendor rejected: ${reason}`,
      addedAt: new Date(),
      addedByModel: "Vendor"
    });

    await workOrder.save();

    res.json({
      success: true,
      message: "Work order rejected"
    });

  } catch (error) {
    console.error("Error rejecting work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =============================================
// UPDATE production progress (simple version)
// =============================================
router.post("/work-orders/:workOrderId/progress", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const vendorId = req.vendor._id;
    const { completedQuantity, notes } = req.body;

    const workOrder = await WorkOrder.findOne({
      _id: workOrderId,
      forwardedToVendor: vendorId,
      status: { $in: ["planned", "in_progress"] }
    });

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found or cannot be updated"
      });
    }

    // Initialize productionCompletion if not exists
    if (!workOrder.productionCompletion) {
      workOrder.productionCompletion = {
        overallCompletedQuantity: 0,
        overallCompletionPercentage: 0,
        operationCompletion: [],
        operatorDetails: [],
        lastSyncedAt: new Date()
      };
    }

    // Update completion
    workOrder.productionCompletion.overallCompletedQuantity = completedQuantity;
    workOrder.productionCompletion.overallCompletionPercentage = 
      Math.round((completedQuantity / workOrder.quantity) * 100);
    workOrder.productionCompletion.lastSyncedAt = new Date();

    // Update status if completed
    if (completedQuantity >= workOrder.quantity) {
      workOrder.status = "completed";
      workOrder.timeline = workOrder.timeline || {};
      workOrder.timeline.actualEndDate = new Date();
    } else if (completedQuantity > 0 && workOrder.status === "planned") {
      workOrder.status = "in_progress";
      workOrder.timeline = workOrder.timeline || {};
      workOrder.timeline.actualStartDate = workOrder.timeline.actualStartDate || new Date();
    }

    // Add note
    if (notes) {
      workOrder.productionNotes = workOrder.productionNotes || [];
      workOrder.productionNotes.push({
        note: `Progress update: ${completedQuantity}/${workOrder.quantity} units completed. ${notes}`,
        addedAt: new Date(),
        addedByModel: "Vendor"
      });
    }

    await workOrder.save();

    res.json({
      success: true,
      message: "Progress updated",
      progress: {
        completedQuantity: workOrder.productionCompletion.overallCompletedQuantity,
        completionPercentage: workOrder.productionCompletion.overallCompletionPercentage,
        status: workOrder.status
      }
    });

  } catch (error) {
    console.error("Error updating progress:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

module.exports = router;