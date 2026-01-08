// models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js - UPDATED

const mongoose = require("mongoose");

const additionalMachineSchema = new mongoose.Schema({
  assignedMachine: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Machine",
    default: null
  },
  assignedMachineName: {
    type: String,
    trim: true,
    default: null
  },
  assignedMachineSerial: {
    type: String,
    trim: true,
    default: null
  },
  notes: {
    type: String,
    trim: true,
    default: ""
  }
}, { _id: true });

const operationAssignmentSchema = new mongoose.Schema({
  operationType: {
    type: String,
    trim: true
  },
  machineType: {
    type: String,
    trim: true
  },
  assignedMachine: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Machine",
    default: null
  },
  assignedMachineName: {
    type: String,
    trim: true,
    default: null
  },
  assignedMachineSerial: {
    type: String,
    trim: true,
    default: null
  },
  additionalMachines: [additionalMachineSchema], // Support for multiple machines
  estimatedTimeSeconds: {
    type: Number,
    min: 0,
    default: 0
  },
  plannedTimeSeconds: {
    type: Number,
    min: 0,
    default: 0
  },
  maxAllowedSeconds: { // For 70% efficiency constraint
    type: Number,
    min: 0,
    default: 0
  },
  status: {
    type: String,
    enum: ["pending", "scheduled", "in_progress", "completed", "delayed"],
    default: "pending"
  },
  notes: {
    type: String,
    trim: true,
    default: ""
  }
}, { _id: true });

const rawMaterialAllocationSchema = new mongoose.Schema({
  rawItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "RawItem",
    
  },
  name: {
    type: String,
    trim: true,
    
  },
  sku: {
    type: String,
    trim: true,
    
  },
  quantityRequired: {
    type: Number,
    
    min: 0
  },
  quantityAllocated: {
    type: Number,
    default: 0,
    min: 0
  },
  quantityIssued: {
    type: Number,
    default: 0,
    min: 0
  },
  unit: {
    type: String,
    trim: true,
    
  },
  unitCost: {
    type: Number,
    
    min: 0
  },
  totalCost: {
    type: Number,
    
    min: 0
  },
  allocationStatus: {
    type: String,
    enum: ["not_allocated", "partially_allocated", "fully_allocated", "issued"],
    default: "not_allocated"
  },
  notes: {
    type: String,
    trim: true,
    default: ""
  }
}, { _id: true });

const timelineSchema = new mongoose.Schema({
  plannedStartDate: {
    type: Date,
    default: null
  },
  plannedEndDate: {
    type: Date,
    default: null
  },
  actualStartDate: {
    type: Date,
    default: null
  },
  actualEndDate: {
    type: Date,
    default: null
  },
  scheduledStartDate: {
    type: Date,
    default: null
  },
  scheduledEndDate: {
    type: Date,
    default: null
  },
  totalEstimatedSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  totalPlannedSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  efficiencyPercentage: { // Efficiency used (max 70%)
    type: Number,
    default: 100,
    min: 0,
    max: 100
  }
});

const workOrderSchema = new mongoose.Schema({
  workOrderNumber: {
    type: String,
    unique: true,
    trim: true
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
  variantAttributes: [{
    name: {
      type: String,
      trim: true
    },
    value: {
      type: String,
      trim: true
    }
  }],
  quantity: {
    type: Number,
    
    min: 1
  },
  originalQuantity: { // To track if quantity was reduced
    type: Number,
    min: 1
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    
  },
  customerName: {
    type: String,
    trim: true
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium"
  },
  status: {
    type: String,
    enum: ["pending","planned", "scheduled", "ready_to_start", "in_progress", "paused", "completed", "cancelled", "delayed", "partial_allocation"],
    default: "pending"
  },
  operations: [operationAssignmentSchema],
  rawMaterials: [rawMaterialAllocationSchema],
  timeline: timelineSchema,
  specialInstructions: [{
    type: String,
    trim: true
  }],
  estimatedCost: {
    type: Number,
    min: 0,
    default: 0
  },
  actualCost: {
    type: Number,
    min: 0,
    default: 0
  },
  productionNotes: [{
    note: {
      type: String,
      trim: true
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "productionNotes.addedByModel"
    },
    addedByModel: {
      type: String,
      enum: ["SalesDepartment", "ProjectManager", "Operator"]
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  qualityCheck: {
    passed: {
      type: Boolean,
      default: false
    },
    checkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager"
    },
    checkedAt: {
      type: Date
    },
    notes: {
      type: String,
      trim: true
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SalesDepartment",
    
  },
  plannedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager",
    default: null
  },
  plannedAt: {
    type: Date,
    default: null
  },
  planningNotes: {
    type: String,
    trim: true,
    default: ""
  },
  isSplitOrder: { // Flag if this was created from split
    type: Boolean,
    default: false
  },
  parentWorkOrderId: { // Reference to original WO if split
    type: mongoose.Schema.Types.ObjectId,
    ref: "WorkOrder",
    default: null
  },
  splitReason: {
    type: String,
    trim: true,
    default: ""
  }
}, { timestamps: true });

workOrderSchema.pre("save", function(next) {
  if (!this.workOrderNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(1000 + Math.random() * 9000);
    this.workOrderNumber = `WO-${year}${month}${day}-${random}`;
  }
  
  // Set original quantity if not set
  if (!this.originalQuantity) {
    this.originalQuantity = this.quantity;
  }
  
  this.estimatedCost = this.rawMaterials.reduce((total, item) => total + (item.totalCost || 0), 0);
  
  if (this.timeline) {
    this.timeline.totalEstimatedSeconds = this.operations.reduce((total, op) => total + (op.estimatedTimeSeconds || 0), 0);
    this.timeline.totalPlannedSeconds = this.operations.reduce((total, op) => total + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0), 0);
    
    // Calculate efficiency percentage (max 70% allowed)
    if (this.timeline.totalEstimatedSeconds > 0) {
      const efficiency = (this.timeline.totalEstimatedSeconds / this.timeline.totalPlannedSeconds) * 100;
      this.timeline.efficiencyPercentage = Math.min(Math.max(efficiency, 0), 70);
    }
  }
  
  // Calculate max allowed time for each operation (70% efficiency)
  this.operations.forEach(op => {
    if (op.estimatedTimeSeconds > 0) {
      op.maxAllowedSeconds = Math.ceil(op.estimatedTimeSeconds / 0.7); // Max 70% efficiency
    }
  });
  
});

module.exports = mongoose.model("WorkOrder", workOrderSchema);