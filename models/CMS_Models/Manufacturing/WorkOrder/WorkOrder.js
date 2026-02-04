// models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js - UPDATED

const mongoose = require("mongoose");

const additionalMachineSchema = new mongoose.Schema(
  {
    assignedMachine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      default: null,
    },
    assignedMachineName: {
      type: String,
      trim: true,
      default: null,
    },
    assignedMachineSerial: {
      type: String,
      trim: true,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: true },
);

const operationAssignmentSchema = new mongoose.Schema(
  {
    operationType: {
      type: String,
      trim: true,
    },
    machineType: {
      type: String,
      trim: true,
    },
    assignedMachine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      default: null,
    },
    assignedMachineName: {
      type: String,
      trim: true,
      default: null,
    },
    assignedMachineSerial: {
      type: String,
      trim: true,
      default: null,
    },
    additionalMachines: [additionalMachineSchema], // Support for multiple machines
    estimatedTimeSeconds: {
      type: Number,
      min: 0,
      default: 0,
    },
    plannedTimeSeconds: {
      type: Number,
      min: 0,
      default: 0,
    },
    maxAllowedSeconds: {
      // For 70% efficiency constraint
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "scheduled", "in_progress", "completed", "delayed"],
      default: "pending",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: true },
);

const rawMaterialAllocationSchema = new mongoose.Schema(
  {
    rawItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
      required: true,
    },
    name: {
      type: String,
      trim: true,
      required: true,
    },
    sku: {
      type: String,
      trim: true,
      required: true,
    },
    // ADD THESE FIELDS FOR VARIANT-BASED RAW ITEMS
    rawItemVariantId: {
      // Which variant of raw item is required
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    rawItemVariantCombination: [
      {
        // Specific variant combination needed
        type: String,
        trim: true,
      },
    ],
    quantityRequired: {
      type: Number,
      required: true,
      min: 0,
    },
    quantityAllocated: {
      type: Number,
      default: 0,
      min: 0,
    },
    quantityIssued: {
      type: Number,
      default: 0,
      min: 0,
    },
    unit: {
      type: String,
      trim: true,
      required: true,
    },
    unitCost: {
      type: Number,
      required: true,
      min: 0,
    },
    totalCost: {
      type: Number,
      required: true,
      min: 0,
    },
    allocationStatus: {
      type: String,
      enum: [
        "not_allocated",
        "partially_allocated",
        "fully_allocated",
        "issued",
      ],
      default: "not_allocated",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: true },
);

const timelineSchema = new mongoose.Schema({
  plannedStartDate: {
    type: Date,
    default: null,
  },
  plannedEndDate: {
    type: Date,
    default: null,
  },
  actualStartDate: {
    type: Date,
    default: null,
  },
  actualEndDate: {
    type: Date,
    default: null,
  },
  scheduledStartDate: {
    type: Date,
    default: null,
  },
  scheduledEndDate: {
    type: Date,
    default: null,
  },
  totalEstimatedSeconds: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalPlannedSeconds: {
    type: Number,
    default: 0,
    min: 0,
  },
  efficiencyPercentage: {
    // Efficiency used (max 70%)
    type: Number,
    default: 100,
    min: 0,
    max: 100,
  },
});

const workOrderSchema = new mongoose.Schema(
  {
    workOrderNumber: {
      type: String,
      unique: true,
      trim: true,
    },
    customerRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
    },
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
    },
    stockItemName: {
      type: String,
      trim: true,
    },
    stockItemReference: {
      type: String,
      trim: true,
    },
    variantId: {
      type: String,
    },
    variantAttributes: [
      {
        name: {
          type: String,
          trim: true,
        },
        value: {
          type: String,
          trim: true,
        },
      },
    ],
    quantity: {
      type: Number,

      min: 1,
    },
    originalQuantity: {
      // To track if quantity was reduced
      type: Number,
      min: 1,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    customerName: {
      type: String,
      trim: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: [
        "pending",
        "planned",
        "scheduled",
        "ready_to_start",
        "in_progress",
        "paused",
        "completed",
        "cancelled",
        "delayed",
        "partial_allocation",
      ],
      default: "pending",
    },
    operations: [operationAssignmentSchema],
    rawMaterials: [rawMaterialAllocationSchema],
    timeline: timelineSchema,
    specialInstructions: [
      {
        type: String,
        trim: true,
      },
    ],
    estimatedCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    actualCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    productionNotes: [
      {
        note: {
          type: String,
          trim: true,
        },
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          refPath: "productionNotes.addedByModel",
        },
        addedByModel: {
          type: String,
          enum: ["SalesDepartment", "ProjectManager", "Operator"],
        },
        addedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    qualityCheck: {
      passed: {
        type: Boolean,
        default: false,
      },
      checkedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager",
      },
      checkedAt: {
        type: Date,
      },
      notes: {
        type: String,
        trim: true,
      },
    },

    cuttingStatus: {
      type: String,
      enum: ["pending", "in_progress", "completed"],
      default: "pending"
    },

    cuttingProgress: {
      completed: {
        type: Number,
        default: 0,
        min: 0
      },
      remaining: {
        type: Number,
        default: function() {
          return this.quantity || 0;
        },
        min: 0
      }
    },
    
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    plannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
    plannedAt: {
      type: Date,
      default: null,
    },
    planningNotes: {
      type: String,
      trim: true,
      default: "",
    },
    isSplitOrder: {
      // Flag if this was created from split
      type: Boolean,
      default: false,
    },
    parentWorkOrderId: {
      // Reference to original WO if split
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      default: null,
    },
    splitReason: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("WorkOrder", workOrderSchema);
