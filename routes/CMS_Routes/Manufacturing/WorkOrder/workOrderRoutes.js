// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js - UPDATED

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");

const PDFDocument = require("pdfkit");
const streamBuffers = require("stream-buffers");

router.use(EmployeeAuthMiddleware);

// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js - ADD THIS ENDPOINT

// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js

// GET single work order details
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if id is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID",
      });
    }

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference")
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    res.json({
      success: true,
      workOrder,
    });
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order",
    });
  }
});

// Add this route to get stock item details with panel info
router.get("/stock-items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const stockItem = await StockItem.findById(id)
      .select("name reference numberOfPanels operations variants images")
      .lean();

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      });
    }

    res.json({
      success: true,
      stockItem,
    });
  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching stock item",
    });
  }
});

// In workOrderRoutes.js - Add this endpoint

// GET panel count for a work order
router.get("/:id/panel-count", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get stock item to get panel count
    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("numberOfPanels")
      .lean();
    const panelCount = stockItem?.numberOfPanels || 0;

    res.json({
      success: true,
      panelCount: panelCount,
      workOrder: {
        workOrderNumber: workOrder.workOrderNumber,
        quantity: workOrder.quantity,
        stockItemName: workOrder.stockItemName,
      },
    });
  } catch (error) {
    console.error("Error fetching panel count:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching panel count",
    });
  }
});

// GET work order with panel information
router.get("/:id/with-panels", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels")
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get panel count from stock item
    const stockItem = await StockItem.findById(workOrder.stockItemId);
    const numberOfPanels = stockItem?.numberOfPanels || 1; // Default to 1 if not specified

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        numberOfPanels: numberOfPanels,
      },
    });
  } catch (error) {
    console.error("Error fetching work order with panels:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order",
    });
  }
});

// Add this to your workOrderRoutes.js file (backend)

// GET work order details with stock item including panels
router.get("/:id/with-details", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if id is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID",
      });
    }

    const workOrder = await WorkOrder.findById(id)
      .populate(
        "stockItemId",
        "name reference numberOfPanels operations variants",
      ) // Add numberOfPanels
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .populate("rawMaterials.rawItemId", "name sku quantity") // Populate raw materials
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    res.json({
      success: true,
      workOrder,
      stockItem: workOrder.stockItemId, // Already populated
      numberOfPanels: workOrder.stockItemId?.numberOfPanels || 1,
    });
  } catch (error) {
    console.error("Error fetching work order with details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order details",
    });
  }
});

// GET work order details for planning - MODIFIED FOR VARIANT-WISE
router.get("/:id/planning", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference operations rawItems")
      .populate("customerRequestId", "customerInfo deliveryDeadline")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get stock item for operations reference
    const stockItem = await StockItem.findById(workOrder.stockItemId).lean();

    // Calculate maximum producible quantity based on raw material availability - MODIFIED FOR VARIANT-WISE
    let maxProducibleQuantity = workOrder.quantity;
    const rawMaterialsWithStock = await Promise.all(
      workOrder.rawMaterials.map(async (rm) => {
        if (rm.rawItemId) {
          const rawItem = await RawItem.findById(rm.rawItemId).lean();
          const requiredPerUnit = rm.quantityRequired / workOrder.quantity;
          let maxUnitsFromThisMaterial = 0;
          let currentStock = 0;
          let status = "insufficient";

          // Check variant-specific stock if specified
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            if (rm.rawItemVariantId && rawItem?.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                currentStock = variant.quantity || 0;
                maxUnitsFromThisMaterial = Math.floor(
                  currentStock / requiredPerUnit,
                );
              }
            } else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem?.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                currentStock = variant.quantity || 0;
                maxUnitsFromThisMaterial = Math.floor(
                  currentStock / requiredPerUnit,
                );
              }
            }
          } else {
            // No variant specified, use total stock
            currentStock = rawItem?.quantity || 0;
            maxUnitsFromThisMaterial = Math.floor(
              currentStock / requiredPerUnit,
            );
          }

          // Update max producible quantity
          maxProducibleQuantity = Math.min(
            maxProducibleQuantity,
            maxUnitsFromThisMaterial,
          );

          // Determine status
          if (maxUnitsFromThisMaterial >= workOrder.quantity) {
            status = "sufficient";
          } else if (maxUnitsFromThisMaterial > 0) {
            status = "partial";
          } else {
            status = "insufficient";
          }

          return {
            ...rm,
            currentStock: currentStock,
            requiredPerUnit: requiredPerUnit,
            maxUnitsFromThisMaterial: maxUnitsFromThisMaterial,
            status: status,
            // Add variant info for frontend display
            variantName:
              rm.rawItemVariantCombination?.join(" • ") ||
              (rm.rawItemVariantId
                ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}`
                : "Default"),
          };
        }
        return rm;
      }),
    );

    // Get available machines for each operation type
    const operationsWithMachines = await Promise.all(
      workOrder.operations.map(async (op) => {
        const availableMachines = await Machine.find({
          type: op.machineType,
          status: "Operational",
        }).lean();

        // Calculate max allowed time (70% efficiency)
        const maxAllowedSeconds = op.estimatedTimeSeconds
          ? Math.ceil(op.estimatedTimeSeconds / 0.7)
          : 0;

        return {
          ...op,
          availableMachines: availableMachines || [],
          maxAllowedSeconds: maxAllowedSeconds,
          plannedTimeSeconds:
            op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
        };
      }),
    );

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        operations: operationsWithMachines,
        rawMaterials: rawMaterialsWithStock,
        maxProducibleQuantity: Math.max(1, maxProducibleQuantity), // At least 1 unit
        stockItemOperations: stockItem?.operations || [],
      },
    });
  } catch (error) {
    console.error("Error fetching work order for planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order details",
    });
  }
});

// UPDATE raw material allocation with quantity adjustment AND create new WO for remaining - FIXED VERSION
router.put("/:id/allocate-raw-materials", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, splitRemaining = false, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    let newWorkOrder = null;
    const remainingQuantity = workOrder.quantity - quantity;

    // Validate quantity
    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1",
      });
    }

    if (quantity > workOrder.quantity) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot exceed original work order quantity",
      });
    }

    // Ensure originalQuantity exists
    if (!workOrder.originalQuantity) {
      workOrder.originalQuantity = workOrder.quantity;
    }

    // Calculate raw material requirements per unit and check stock - FIXED FOR VARIANT-WISE
    let canProduceQuantity = workOrder.quantity;

    for (const rm of workOrder.rawMaterials) {
      if (rm.rawItemId) {
        const rawItem = await RawItem.findById(rm.rawItemId);
        if (rawItem) {
          // FIX: Check for division by zero
          const requiredPerUnit =
            workOrder.quantity > 0
              ? rm.quantityRequired / workOrder.quantity
              : 0;

          // Check if raw material requires specific variant
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            let variantStock = 0;

            // Find variant by ID
            if (rm.rawItemVariantId && rawItem.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                variantStock = variant.quantity || 0;
              }
            }
            // Or find variant by combination
            else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                variantStock = variant.quantity || 0;
              }
            }

            // FIX: Check for division by zero
            const maxUnitsFromThisVariant =
              requiredPerUnit > 0
                ? Math.floor(variantStock / requiredPerUnit)
                : 0;
            canProduceQuantity = Math.min(
              canProduceQuantity,
              maxUnitsFromThisVariant,
            );
          } else {
            // No variant specified, use total stock
            const maxUnitsFromThisMaterial =
              requiredPerUnit > 0
                ? Math.floor(rawItem.quantity / requiredPerUnit)
                : 0;
            canProduceQuantity = Math.min(
              canProduceQuantity,
              maxUnitsFromThisMaterial,
            );
          }
        }
      }
    }

    // Check if requested quantity can be produced
    if (quantity > canProduceQuantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot produce ${quantity} units. Maximum producible is ${canProduceQuantity} units with current stock.`,
      });
    }

    // Create new work order for remaining quantity if splitRemaining is true
    if (splitRemaining && remainingQuantity > 0) {
      // Calculate raw material requirements for new work order
      const newRawMaterials = [];

      for (const rm of workOrder.rawMaterials) {
        // FIX: Check for division by zero
        const requiredPerUnit =
          workOrder.quantity > 0 ? rm.quantityRequired / workOrder.quantity : 0;
        const unitCost = rm.unitCost || 0;
        const quantityRequired = requiredPerUnit * remainingQuantity;
        const totalCost = unitCost * quantityRequired;

        newRawMaterials.push({
          rawItemId: rm.rawItemId,
          name: rm.name,
          sku: rm.sku,
          // PRESERVE VARIANT INFORMATION
          rawItemVariantId: rm.rawItemVariantId,
          rawItemVariantCombination: rm.rawItemVariantCombination || [],
          quantityRequired: quantityRequired,
          quantityAllocated: 0,
          quantityIssued: 0,
          unit: rm.unit,
          unitCost: unitCost,
          totalCost: totalCost,
          allocationStatus: "not_allocated",
          notes: rm.notes || "",
        });
      }

      // Create new work order
      const newWorkOrderData = {
        customerRequestId: workOrder.customerRequestId,
        stockItemId: workOrder.stockItemId,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        variantId: workOrder.variantId,
        variantAttributes: workOrder.variantAttributes,
        quantity: remainingQuantity,
        originalQuantity: remainingQuantity,
        customerId: workOrder.customerId,
        customerName: workOrder.customerName,
        priority: workOrder.priority,
        status: "pending",
        operations: workOrder.operations.map((op) => ({
          operationType: op.operationType,
          machineType: op.machineType,
          assignedMachine: null,
          assignedMachineName: null,
          assignedMachineSerial: null,
          additionalMachines: [],
          estimatedTimeSeconds: op.estimatedTimeSeconds,
          plannedTimeSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds,
          maxAllowedSeconds: op.maxAllowedSeconds,
          status: "pending",
          notes: op.notes || "",
        })),
        rawMaterials: newRawMaterials,
        timeline: {
          totalEstimatedSeconds:
            (workOrder.timeline?.totalEstimatedSeconds || 0) *
            (remainingQuantity / workOrder.quantity),
        },
        specialInstructions: workOrder.specialInstructions,
        createdBy: workOrder.createdBy,
        isSplitOrder: true,
        parentWorkOrderId: workOrder._id,
        splitReason: "Split due to raw material allocation",
      };

      newWorkOrder = new WorkOrder(newWorkOrderData);
      await newWorkOrder.save();
    }

    // Update current work order quantity and raw materials
    workOrder.quantity = quantity;

    // Update raw material quantities for current work order - FIXED
    for (const rm of workOrder.rawMaterials) {
      // FIX: Use workOrder.originalQuantity, not undefined variable
      const requiredPerUnit =
        workOrder.originalQuantity > 0
          ? rm.quantityRequired / workOrder.originalQuantity
          : 0;

      // FIX: Ensure we have a valid number
      const newQuantityRequired = requiredPerUnit * quantity;
      rm.quantityRequired = isNaN(newQuantityRequired)
        ? 0
        : newQuantityRequired;

      // Auto-allocate based on available stock - MODIFIED FOR VARIANT-WISE
      if (rm.rawItemId) {
        const rawItem = await RawItem.findById(rm.rawItemId);
        if (rawItem) {
          let availableStock = 0;

          // Check variant-specific stock if specified
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            if (rm.rawItemVariantId && rawItem.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                availableStock = variant.quantity || 0;
              }
            } else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                availableStock = variant.quantity || 0;
              }
            }
          } else {
            // No variant specified, use total stock
            availableStock = rawItem.quantity || 0;
          }

          const maxAllocatable = Math.min(rm.quantityRequired, availableStock);
          rm.quantityAllocated = isNaN(maxAllocatable) ? 0 : maxAllocatable;

          if (maxAllocatable >= rm.quantityRequired) {
            rm.allocationStatus = "fully_allocated";
          } else if (maxAllocatable > 0) {
            rm.allocationStatus = "partially_allocated";
          } else {
            rm.allocationStatus = "not_allocated";
          }
        } else {
          rm.quantityAllocated = 0;
          rm.allocationStatus = "not_allocated";
        }
      } else {
        rm.quantityAllocated = 0;
        rm.allocationStatus = "not_allocated";
      }
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;

    // If quantity changed, update status
    if (quantity < workOrder.originalQuantity) {
      workOrder.status = "partial_allocation";
    } else {
      workOrder.status = "planned";
    }

    await workOrder.save();

    res.json({
      success: true,
      message: `Raw materials allocated successfully for ${quantity} units`,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        quantity: workOrder.quantity,
      },
      newWorkOrder: newWorkOrder
        ? {
            _id: newWorkOrder._id,
            workOrderNumber: newWorkOrder.workOrderNumber,
            quantity: newWorkOrder.quantity,
          }
        : null,
      remainingQuantity: remainingQuantity,
      splitCreated: !!newWorkOrder,
    });
  } catch (error) {
    console.error("Error allocating raw materials:", error);
    res.status(500).json({
      success: false,
      message: "Server error while allocating raw materials",
      error: error.message,
    });
  }
});

// UPDATE operations planning (machines and timing with 70% efficiency constraint)
router.put("/:id/plan-operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { operations, totalPlannedSeconds, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Update operations with multiple machines
    for (const opUpdate of operations) {
      const operation = workOrder.operations.id(opUpdate._id);
      if (operation) {
        // Primary machine assignment
        if (opUpdate.assignedMachine) {
          const machine = await Machine.findById(opUpdate.assignedMachine);
          if (machine) {
            operation.assignedMachine = opUpdate.assignedMachine;
            operation.assignedMachineName = machine.name;
            operation.assignedMachineSerial = machine.serialNumber;
          }
        }

        // Additional machines
        if (
          opUpdate.additionalMachines &&
          Array.isArray(opUpdate.additionalMachines)
        ) {
          operation.additionalMachines = opUpdate.additionalMachines.map(
            (am) => ({
              assignedMachine: am.assignedMachine,
              assignedMachineName: am.assignedMachineName,
              assignedMachineSerial: am.assignedMachineSerial,
              notes: am.notes || "",
            }),
          );
        }

        // Apply planned time if within 70% efficiency constraint
        if (opUpdate.plannedTimeSeconds && operation.estimatedTimeSeconds > 0) {
          const maxAllowed = Math.ceil(operation.estimatedTimeSeconds / 0.7);
          operation.plannedTimeSeconds = Math.min(
            opUpdate.plannedTimeSeconds,
            maxAllowed,
          );
        }

        if (opUpdate.notes) {
          operation.notes = opUpdate.notes;
        }

        operation.status = "scheduled";
      }
    }

    // Update total planned time if provided
    if (totalPlannedSeconds) {
      const totalEstimated = workOrder.operations.reduce(
        (total, op) => total + (op.estimatedTimeSeconds || 0),
        0,
      );
      const maxAllowed = Math.ceil(totalEstimated / 0.7);
      const actualPlanned = Math.min(totalPlannedSeconds, maxAllowed);

      // Adjust individual operation times proportionally
      const ratio = actualPlanned / totalEstimated;
      workOrder.operations.forEach((op) => {
        if (op.estimatedTimeSeconds > 0) {
          op.plannedTimeSeconds = Math.ceil(op.estimatedTimeSeconds * ratio);
        }
      });
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();

    res.json({
      success: true,
      message: "Operations planned successfully",
      workOrder,
    });
  } catch (error) {
    console.error("Error planning operations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while planning operations",
    });
  }
});

// COMPLETE planning and issue raw materials - FIXED VERSION
router.post("/:id/complete-planning", async (req, res) => {
  try {
    const { id } = req.params;
    const { planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check if all raw materials are allocated
    const insufficientAllocations = workOrder.rawMaterials.filter(
      (rm) => rm.allocationStatus === "not_allocated",
    );

    if (insufficientAllocations.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some raw materials are not allocated at all",
        insufficientAllocations,
      });
    }

    // Check if all operations have at least primary machine assigned
    const operationsWithoutMachine = workOrder.operations.filter(
      (op) => !op.assignedMachine,
    );

    if (operationsWithoutMachine.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some operations do not have machines assigned",
        operationsWithoutMachine,
      });
    }

    // Update raw material stock and create transactions - FIXED ENUM VALUE
    const stockTransactions = [];

    for (const rawMaterial of workOrder.rawMaterials) {
      if (rawMaterial.rawItemId && rawMaterial.quantityAllocated > 0) {
        const rawItem = await RawItem.findById(rawMaterial.rawItemId);

        if (rawItem) {
          // Determine which quantity to reduce
          let previousQuantity = rawItem.quantity;
          let newQuantity = previousQuantity;
          let transactionType = "CONSUME";
          let variantInfo = "";
          let variantPreviousQuantity = null;
          let variantNewQuantity = null;

          // Check if this is variant-specific
          if (
            rawMaterial.rawItemVariantId ||
            (rawMaterial.rawItemVariantCombination &&
              rawMaterial.rawItemVariantCombination.length > 0)
          ) {
            // Find the specific variant
            let variant = null;

            if (rawMaterial.rawItemVariantId && rawItem.variants) {
              variant = rawItem.variants.id(rawMaterial.rawItemVariantId);
            } else if (
              rawMaterial.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !==
                    rawMaterial.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) =>
                    val === rawMaterial.rawItemVariantCombination[idx],
                );
              });
            }

            if (variant) {
              // Reduce variant-specific quantity
              variantPreviousQuantity = variant.quantity;
              variantNewQuantity = Math.max(
                0,
                variantPreviousQuantity - rawMaterial.quantityAllocated,
              );
              variant.quantity = variantNewQuantity;

              // Also update total raw item quantity
              previousQuantity = rawItem.quantity;
              newQuantity = Math.max(
                0,
                rawItem.quantity - rawMaterial.quantityAllocated,
              );
              rawItem.quantity = newQuantity;

              // FIXED: Use VARIANT_REDUCE instead of VARIANT_CONSUME
              transactionType = "VARIANT_REDUCE";
              variantInfo =
                rawMaterial.rawItemVariantCombination?.join(" • ") ||
                `Variant ID: ${rawMaterial.rawItemVariantId?.toString().slice(-6)}`;
            } else {
              // Variant not found, fallback to total stock
              previousQuantity = rawItem.quantity;
              newQuantity = Math.max(
                0,
                previousQuantity - rawMaterial.quantityAllocated,
              );
              rawItem.quantity = newQuantity;

              variantInfo = "Variant not found, used total stock";
            }
          } else {
            // No variant specified, reduce total quantity
            previousQuantity = rawItem.quantity;
            newQuantity = Math.max(
              0,
              previousQuantity - rawMaterial.quantityAllocated,
            );
            rawItem.quantity = newQuantity;
          }

          rawMaterial.quantityIssued = rawMaterial.quantityAllocated;
          rawMaterial.allocationStatus = "issued";

          // Add stock transaction with variant info
          const transactionData = {
            type: transactionType,
            quantity: rawMaterial.quantityAllocated,
            previousQuantity: previousQuantity,
            newQuantity: newQuantity,
            reason: `Issued for Work Order: ${workOrder.workOrderNumber}`,
            notes: `Work Order: ${workOrder.workOrderNumber}, Product: ${workOrder.stockItemName}, Quantity: ${workOrder.quantity} units${variantInfo ? `, ${variantInfo}` : ""}`,
            performedBy: req.user.id,
          };

          // Add variant-specific fields if applicable
          if (rawMaterial.rawItemVariantId) {
            transactionData.variantId = rawMaterial.rawItemVariantId;
          }
          if (rawMaterial.rawItemVariantCombination?.length > 0) {
            transactionData.variantCombination =
              rawMaterial.rawItemVariantCombination;
          }
          if (variantPreviousQuantity !== null) {
            transactionData.variantPreviousQuantity = variantPreviousQuantity;
            transactionData.variantNewQuantity = variantNewQuantity;
          }

          rawItem.stockTransactions.push(transactionData);

          await rawItem.save();
          stockTransactions.push({
            rawItemId: rawItem._id,
            name: rawItem.name,
            sku: rawItem.sku,
            variantId: rawMaterial.rawItemVariantId,
            variantCombination: rawMaterial.rawItemVariantCombination,
            quantityIssued: rawMaterial.quantityAllocated,
            transactionType: transactionType,
          });
        }
      }
    }

    // Update work order status
    workOrder.status = "scheduled";
    workOrder.plannedBy = req.user.id;
    workOrder.plannedAt = new Date();
    workOrder.planningNotes = planningNotes || workOrder.planningNotes;

    await workOrder.save();

    res.json({
      success: true,
      message: "Planning completed successfully",
      workOrder,
      stockTransactions,
    });
  } catch (error) {
    console.error("Error completing planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while completing planning",
    });
  }
});

// GET available machines by type
router.get("/machines/:machineType", async (req, res) => {
  try {
    const { machineType } = req.params;

    const machines = await Machine.find({
      type: machineType,
      status: "Operational",
    }).lean();

    res.json({
      success: true,
      machines,
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching machines",
    });
  }
});

// Create new machine
router.post("/machines", async (req, res) => {
  try {
    const machineData = req.body;

    const machine = new Machine({
      ...machineData,
      createdBy: req.user.id,
    });

    await machine.save();

    res.json({
      success: true,
      message: "Machine created successfully",
      machine,
    });
  } catch (error) {
    console.error("Error creating machine:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating machine",
    });
  }
});

router.post("/:id/start-production", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check if work order can start production
    const canStart =
      (workOrder.status === "scheduled" ||
        workOrder.status === "ready_to_start") &&
      !workOrder.rawMaterials?.some((rm) => rm.allocationStatus !== "issued") &&
      !workOrder.operations?.some((op) => !op.assignedMachine);

    if (!canStart) {
      return res.status(400).json({
        success: false,
        message:
          "Work order cannot start production. Check raw material allocation and machine assignments.",
      });
    }

    // Update status
    workOrder.status = "in_progress";
    workOrder.timeline.actualStartDate = new Date();

    // Update all operations to pending (they'll start when scanned)
    workOrder.operations.forEach((op) => {
      op.status = "pending";
    });

    await workOrder.save();

    res.json({
      success: true,
      message: "Production started successfully",
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        startedAt: workOrder.timeline.actualStartDate,
      },
    });
  } catch (error) {
    console.error("Error starting production:", error);
    res.status(500).json({
      success: false,
      message: "Server error while starting production",
    });
  }
});

// Export the router
module.exports = router;
