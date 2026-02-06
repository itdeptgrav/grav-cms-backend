// models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js - UPDATED WITH PRODUCTION COMPLETION

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
    additionalMachines: [additionalMachineSchema],
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
    rawItemVariantId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    rawItemVariantCombination: [
      {
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
    type: Number,
    default: 100,
    min: 0,
    max: 100,
  },
});

// NEW: Production Completion Tracking Schema
const operationCompletionSchema = new mongoose.Schema(
  {
    operationNumber: {
      type: Number,
      required: true,
    },
    operationType: {
      type: String,
      trim: true,
    },
    machineType: {
      type: String,
      trim: true,
    },
    completedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalQuantity: {
      type: Number,
      required: true,
    },
    completionPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed"],
      default: "pending",
    },
    assignedMachines: [
      {
        machineId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Machine",
        },
        machineName: String,
        machineSerial: String,
      },
    ],
  },
  { _id: false },
);

const operatorDetailSchema = new mongoose.Schema(
  {
    operatorId: {
      type: String,
      required: true,
    },
    operatorName: {
      type: String,
      required: true,
    },
    operationNumber: {
      type: Number,
      required: true,
    },
    operationType: {
      type: String,
    },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    machineName: {
      type: String,
    },
    totalScans: {
      type: Number,
      default: 0,
    },
    signInTime: {
      type: Date,
    },
    signOutTime: {
      type: Date,
    },
  },
  { _id: false },
);

const efficiencyMetricSchema = new mongoose.Schema(
  {
    operationNumber: {
      type: Number,
      required: true,
    },
    operationType: {
      type: String,
    },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    machineName: {
      type: String,
    },
    operatorId: {
      type: String,
    },
    operatorName: {
      type: String,
    },
    unitsCompleted: {
      type: Number,
      default: 0,
    },
    avgTimePerUnit: {
      type: Number, // in seconds
      default: 0,
    },
    estimatedTimePerUnit: {
      type: Number,
      default: 0,
    },
    plannedTimePerUnit: {
      type: Number,
      default: 0,
    },
    efficiencyPercentage: {
      type: Number,
      default: 0,
    },
    utilizationRate: {
      type: Number, // percentage of productive time vs total session time
      default: 0,
    },
    totalProductiveTime: {
      type: Number, // seconds
      default: 0,
    },
    totalSessionTime: {
      type: Number, // seconds
      default: 0,
    },
  },
  { _id: false },
);

const timeMetricSchema = new mongoose.Schema(
  {
    operationNumber: {
      type: Number,
      required: true,
    },
    operationType: {
      type: String,
    },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    machineName: {
      type: String,
    },
    avgCompletionTimeSeconds: {
      type: Number,
      default: 0,
    },
    minCompletionTimeSeconds: {
      type: Number,
      default: 0,
    },
    maxCompletionTimeSeconds: {
      type: Number,
      default: 0,
    },
    totalUnitsAnalyzed: {
      type: Number,
      default: 0,
    },
  },
  { _id: false },
);

const invalidScanSchema = new mongoose.Schema(
  {
    barcodeId: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
    },
    unitNumber: {
      type: Number,
      default: null,
    },
    operatorId: {
      type: String,
    },
    operatorName: {
      type: String,
    },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
    },
    machineName: {
      type: String,
    },
    reason: {
      type: String,
      enum: ["invalid_format", "exceeds_quantity", "duplicate", "other"],
      default: "other",
    },
    details: {
      type: String,
    },
  },
  { _id: false },
);

const productionCompletionSchema = new mongoose.Schema(
  {
    overallCompletedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    overallCompletionPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    operationCompletion: [operationCompletionSchema],
    operatorDetails: [operatorDetailSchema],
    efficiencyMetrics: [efficiencyMetricSchema],
    timeMetrics: [timeMetricSchema],
    invalidScansCount: {
      type: Number,
      default: 0,
    },
    invalidScans: [invalidScanSchema],
    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

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

    // NEW: Production completion tracking (populated by cron job)
    productionCompletion: productionCompletionSchema,

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
      type: Boolean,
      default: false,
    },
    parentWorkOrderId: {
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