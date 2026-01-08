// routes/CMS_Routes/Manufacturing/Planning/planningRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Planning = require("../../../../models/CMS_Models/Manufacturing/Planning/Planning");
const ManufacturingOrder = require("../../../../models/CMS_Models/Manufacturing/Manufacturing-Order/ManufacturingOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// Helper function to calculate raw material requirements
const calculateRawMaterialRequirements = async (stockItemId, quantity) => {
  const stockItem = await StockItem.findById(stockItemId).populate("rawItems.rawItemId");
  if (!stockItem) return [];
  
  const requirements = [];
  
  for (const rawItem of stockItem.rawItems || []) {
    const rawItemDoc = await RawItem.findById(rawItem.rawItemId);
    if (!rawItemDoc) continue;
    
    const requiredQuantity = (rawItem.quantity || 0) * quantity;
    const availableQuantity = rawItemDoc.quantity || 0;
    const assignedQuantity = Math.min(requiredQuantity, availableQuantity);
    const deficitQuantity = Math.max(0, requiredQuantity - availableQuantity);
    
    let status = "assigned";
    if (availableQuantity === 0) {
      status = "unavailable";
    } else if (deficitQuantity > 0) {
      status = "partially_assigned";
    }
    
    requirements.push({
      rawItemId: rawItem.rawItemId,
      name: rawItemDoc.name,
      sku: rawItemDoc.sku,
      unit: rawItemDoc.unit,
      requiredQuantity,
      assignedQuantity,
      availableQuantity,
      deficitQuantity,
      unitCost: rawItem.unitCost || 0,
      totalCost: requiredQuantity * (rawItem.unitCost || 0),
      status
    });
  }
  
  return requirements;
};

// Helper function to get operations from stock item
const getStockItemOperations = async (stockItemId) => {
  const stockItem = await StockItem.findById(stockItemId);
  if (!stockItem) return [];
  
  return stockItem.operations || [];
};

// Helper function to get available machines
const getAvailableMachines = async (machineCategory = null) => {
  let query = { status: "Operational" };
  
  if (machineCategory) {
    query.type = machineCategory;
  }
  
  return await Machine.find(query)
    .select("name type model status powerConsumption location lastMaintenance nextMaintenance")
    .lean();
};

// GET all planning records
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      workOrderId,
      manufacturingOrderId
    } = req.query;
    
    const query = {};
    
    if (status) query.status = status;
    if (workOrderId) query.workOrderId = workOrderId;
    if (manufacturingOrderId) query.manufacturingOrderId = manufacturingOrderId;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const planningRecords = await Planning.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("manufacturingOrderId", "moNumber")
      .populate("stockItemId", "name reference")
      .lean();
    
    const total = await Planning.countDocuments(query);
    
    res.json({
      success: true,
      planningRecords,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error("Error fetching planning records:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching planning records"
    });
  }
});

// GET planning by ID
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const planning = await Planning.findById(id)
      .populate("rawMaterialAssignments.rawItemId", "name sku unit status")
      .populate("machineAssignments.machines.machineId", "name type model status")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();
    
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    res.json({
      success: true,
      planning
    });
    
  } catch (error) {
    console.error("Error fetching planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching planning"
    });
  }
});

// GET planning by work order ID
router.get("/work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    
    const planning = await Planning.findOne({ workOrderId })
      .populate("rawMaterialAssignments.rawItemId", "name sku unit status")
      .populate("machineAssignments.machines.machineId", "name type model status")
      .lean();
    
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning not found for this work order"
      });
    }
    
    res.json({
      success: true,
      planning
    });
    
  } catch (error) {
    console.error("Error fetching planning by work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching planning"
    });
  }
});

// GET work order details for planning
router.get("/work-order/:workOrderId/details", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    
    // Find manufacturing order with this work order
    const manufacturingOrder = await ManufacturingOrder.findOne({
      "workOrders.workOrderId": workOrderId
    });
    
    if (!manufacturingOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }
    
    const workOrder = manufacturingOrder.workOrders.find(wo => wo.workOrderId === workOrderId);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }
    
    // Get raw material requirements
    const rawMaterialRequirements = await calculateRawMaterialRequirements(
      workOrder.stockItemId,
      workOrder.quantity
    );
    
    // Get operations
    const operations = await getStockItemOperations(workOrder.stockItemId);
    
    res.json({
      success: true,
      workOrder,
      rawMaterialRequirements,
      operations,
      manufacturingOrder: {
        moNumber: manufacturingOrder.moNumber,
        _id: manufacturingOrder._id
      }
    });
    
  } catch (error) {
    console.error("Error fetching work order details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order details"
    });
  }
});

// GET available machines for operation
router.get("/available-machines", async (req, res) => {
  try {
    const { machineCategory } = req.query;
    
    const machines = await getAvailableMachines(machineCategory);
    
    res.json({
      success: true,
      machines
    });
    
  } catch (error) {
    console.error("Error fetching available machines:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching machines"
    });
  }
});

// CREATE or UPDATE planning
router.post("/", async (req, res) => {
  try {
    const {
      workOrderId,
      rawMaterialAssignments,
      machineAssignments,
      timeline,
      notes,
      status = "draft"
    } = req.body;
    
    // Find work order details
    const manufacturingOrder = await ManufacturingOrder.findOne({
      "workOrders.workOrderId": workOrderId
    });
    
    if (!manufacturingOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }
    
    const workOrder = manufacturingOrder.workOrders.find(wo => wo.workOrderId === workOrderId);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }
    
    // Check if planning already exists
    let planning = await Planning.findOne({ workOrderId });
    
    if (planning) {
      // Update existing planning
      planning.rawMaterialAssignments = rawMaterialAssignments || planning.rawMaterialAssignments;
      planning.machineAssignments = machineAssignments || planning.machineAssignments;
      planning.timeline = timeline || planning.timeline;
      planning.notes = notes || planning.notes;
      planning.status = status;
      planning.updatedBy = req.user.id;
      
      // Update progress based on what's provided
      if (rawMaterialAssignments && rawMaterialAssignments.length > 0) {
        planning.progress.rawMaterialAssignment = {
          completed: true,
          completedAt: new Date(),
          completedBy: req.user.id
        };
      }
      
      if (machineAssignments && machineAssignments.length > 0) {
        planning.progress.machineAssignment = {
          completed: true,
          completedAt: new Date(),
          completedBy: req.user.id
        };
      }
      
      if (timeline && timeline.totalEstimatedTime) {
        planning.progress.timelineSet = {
          completed: true,
          completedAt: new Date(),
          completedBy: req.user.id
        };
      }
    } else {
      // Create new planning
      planning = new Planning({
        workOrderId,
        manufacturingOrderId: manufacturingOrder._id,
        stockItemId: workOrder.stockItemId,
        workOrderDetails: {
          variantAttributes: workOrder.variantAttributes,
          quantity: workOrder.quantity,
          stockItemReference: workOrder.stockItemReference
        },
        rawMaterialAssignments: rawMaterialAssignments || [],
        machineAssignments: machineAssignments || [],
        timeline: timeline || {},
        notes,
        status,
        createdBy: req.user.id,
        updatedBy: req.user.id
      });
      
      // Set progress if data is provided
      if (rawMaterialAssignments && rawMaterialAssignments.length > 0) {
        planning.progress.rawMaterialAssignment = {
          completed: true,
          completedAt: new Date(),
          completedBy: req.user.id
        };
      }
    }
    
    await planning.save();
    
    // Update work order status
    workOrder.status = "planning";
    workOrder.planningId = planning._id;
    await manufacturingOrder.save();
    
    res.json({
      success: true,
      message: planning.isNew ? "Planning created successfully" : "Planning updated successfully",
      planning
    });
    
  } catch (error) {
    console.error("Error saving planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving planning"
    });
  }
});

// APPROVE and book planning
router.post("/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    
    const planning = await Planning.findById(id);
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    // Check if planning is ready for approval
    if (!planning.progress.rawMaterialAssignment.completed || 
        !planning.progress.machineAssignment.completed || 
        !planning.progress.timelineSet.completed) {
      return res.status(400).json({
        success: false,
        message: "Planning is not complete. All steps must be completed."
      });
    }
    
    // Book raw materials
    await planning.bookRawMaterials();
    
    // Update planning status
    planning.status = "approved";
    planning.progress.approved = {
      completed: true,
      completedAt: new Date(),
      approvedBy: req.user.id
    };
    planning.updatedBy = req.user.id;
    
    await planning.save();
    
    // Update work order status
    const manufacturingOrder = await ManufacturingOrder.findById(planning.manufacturingOrderId);
    if (manufacturingOrder) {
      const workOrder = manufacturingOrder.workOrders.find(wo => wo.workOrderId === planning.workOrderId);
      if (workOrder) {
        workOrder.status = "scheduled";
        await manufacturingOrder.save();
      }
    }
    
    res.json({
      success: true,
      message: "Planning approved and raw materials booked successfully",
      planning
    });
    
  } catch (error) {
    console.error("Error approving planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while approving planning"
    });
  }
});

// UPDATE raw material assignments
router.put("/:id/raw-materials", async (req, res) => {
  try {
    const { id } = req.params;
    const { rawMaterialAssignments } = req.body;
    
    const planning = await Planning.findById(id);
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    // Only allow updates for draft or raw_material_assigned status
    if (!["draft", "raw_material_assigned"].includes(planning.status)) {
      return res.status(400).json({
        success: false,
        message: "Cannot update raw materials after approval"
      });
    }
    
    planning.rawMaterialAssignments = rawMaterialAssignments;
    planning.progress.rawMaterialAssignment = {
      completed: true,
      completedAt: new Date(),
      completedBy: req.user.id
    };
    planning.updatedBy = req.user.id;
    
    await planning.save();
    
    res.json({
      success: true,
      message: "Raw material assignments updated successfully",
      planning
    });
    
  } catch (error) {
    console.error("Error updating raw materials:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating raw materials"
    });
  }
});

// UPDATE machine assignments
router.put("/:id/machines", async (req, res) => {
  try {
    const { id } = req.params;
    const { machineAssignments } = req.body;
    
    const planning = await Planning.findById(id);
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    // Only allow updates for draft or raw_material_assigned or machine_assigned status
    if (!["draft", "raw_material_assigned", "machine_assigned"].includes(planning.status)) {
      return res.status(400).json({
        success: false,
        message: "Cannot update machine assignments after approval"
      });
    }
    
    planning.machineAssignments = machineAssignments;
    planning.progress.machineAssignment = {
      completed: true,
      completedAt: new Date(),
      completedBy: req.user.id
    };
    planning.updatedBy = req.user.id;
    
    await planning.save();
    
    res.json({
      success: true,
      message: "Machine assignments updated successfully",
      planning
    });
    
  } catch (error) {
    console.error("Error updating machine assignments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating machine assignments"
    });
  }
});

// UPDATE timeline
router.put("/:id/timeline", async (req, res) => {
  try {
    const { id } = req.params;
    const { timeline } = req.body;
    
    const planning = await Planning.findById(id);
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    planning.timeline = timeline;
    planning.progress.timelineSet = {
      completed: true,
      completedAt: new Date(),
      completedBy: req.user.id
    };
    planning.updatedBy = req.user.id;
    
    await planning.save();
    
    res.json({
      success: true,
      message: "Timeline updated successfully",
      planning
    });
    
  } catch (error) {
    console.error("Error updating timeline:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating timeline"
    });
  }
});

// DELETE planning
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const planning = await Planning.findById(id);
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: "Planning record not found"
      });
    }
    
    // Only allow deletion of draft planning
    if (planning.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft planning can be deleted"
      });
    }
    
    // Remove planning reference from work order
    const manufacturingOrder = await ManufacturingOrder.findById(planning.manufacturingOrderId);
    if (manufacturingOrder) {
      const workOrder = manufacturingOrder.workOrders.find(wo => wo.workOrderId === planning.workOrderId);
      if (workOrder) {
        workOrder.status = "pending";
        workOrder.planningId = null;
        await manufacturingOrder.save();
      }
    }
    
    await planning.deleteOne();
    
    res.json({
      success: true,
      message: "Planning deleted successfully"
    });
    
  } catch (error) {
    console.error("Error deleting planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting planning"
    });
  }
});

module.exports = router;