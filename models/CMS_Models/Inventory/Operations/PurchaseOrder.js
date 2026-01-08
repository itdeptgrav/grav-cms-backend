// models/CMS_Models/Inventory/Operations/PurchaseOrder.js

const mongoose = require("mongoose");

const purchaseOrderItemSchema = new mongoose.Schema({
    rawItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "RawItem"
    },
    itemName: {
        type: String,
        trim: true
    },
    sku: {
        type: String,
        trim: true
    },
    unit: {
        type: String,
        trim: true
    },
    quantity: {
        type: Number,
        min: 0
    },
    unitPrice: {
        type: Number,
        min: 0
    },
    totalPrice: {
        type: Number,
        min: 0
    },
    receivedQuantity: {
        type: Number,
        min: 0,
        default: 0
    },
    pendingQuantity: {
        type: Number,
        min: 0
    },
    status: {
        type: String,
        enum: ["PENDING", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
        default: "PENDING"
    }
}, { _id: true });

const deliverySchema = new mongoose.Schema({
    deliveryDate: {
        type: Date
    },
    quantityReceived: {
        type: Number,
        min: 0
    },
    invoiceNumber: {
        type: String,
        trim: true
    },
    notes: {
        type: String,
        trim: true
    },
    receivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    }
}, { timestamps: true });


const paymentSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: Date.now
  },
  amount: {
    type: Number,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ["CASH", "BANK_TRANSFER", "CHEQUE", "ONLINE", "OTHER"],
    default: "BANK_TRANSFER"
  },
  referenceNumber: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });

const purchaseOrderSchema = new mongoose.Schema({
    // Basic Information
    poNumber: {
        type: String,
        trim: true,
        unique: true
    },
    vendor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Vendor"
    },
    vendorName: {
        type: String,
        trim: true
    },

    // Order Details
    orderDate: {
        type: Date,
        default: Date.now
    },
    expectedDeliveryDate: {
        type: Date
    },

    // Items
    items: [purchaseOrderItemSchema],

    // Pricing
    subtotal: {
        type: Number,
        min: 0
    },
    taxRate: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
    },
    taxAmount: {
        type: Number,
        min: 0,
        default: 0
    },
    shippingCharges: {
        type: Number,
        min: 0,
        default: 0
    },
    discount: {
        type: Number,
        min: 0,
        default: 0
    },
    totalAmount: {
        type: Number,
        min: 0
    },

    // Delivery Tracking
    deliveries: [deliverySchema],
    totalReceived: {
        type: Number,
        min: 0,
        default: 0
    },
    totalPending: {
        type: Number,
        min: 0
    },

    // Status
    status: {
        type: String,
        enum: ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
        default: "DRAFT"
    },

    // Payment Information
    paymentStatus: {
        type: String,
        enum: ["PENDING", "PARTIAL", "COMPLETED"],
        default: "PENDING"
    },
    payments: [paymentSchema],
    paymentTerms: {
        type: String,
        trim: true
    },

    // Additional Info
    notes: {
        type: String,
        trim: true
    },
    termsConditions: {
        type: String,
        trim: true
    },

    // References
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    }
}, { timestamps: true });

// Calculate totals before saving
purchaseOrderSchema.pre("save", function (next) {
    // Calculate item totals
    this.items.forEach(item => {
        item.totalPrice = (item.quantity || 0) * (item.unitPrice || 0);
        item.pendingQuantity = (item.quantity || 0) - (item.receivedQuantity || 0);

        // Update item status
        if (item.receivedQuantity >= item.quantity) {
            item.status = "COMPLETED";
        } else if (item.receivedQuantity > 0) {
            item.status = "PARTIALLY_RECEIVED";
        } else {
            item.status = "PENDING";
        }
    });

    // Calculate subtotal
    this.subtotal = this.items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);

    // Calculate tax
    this.taxAmount = (this.subtotal * (this.taxRate || 0)) / 100;

    // Calculate total amount
    this.totalAmount = this.subtotal + this.taxAmount + (this.shippingCharges || 0) - (this.discount || 0);

    // Calculate total received and pending
    this.totalReceived = this.items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);
    this.totalPending = this.items.reduce((sum, item) => sum + (item.pendingQuantity || 0), 0);

    // Update overall PO status based on items
    if (this.totalPending === 0 && this.items.length > 0) {
        this.status = "COMPLETED";
    } else if (this.totalReceived > 0 && this.totalPending > 0) {
        this.status = "PARTIALLY_RECEIVED";
    }

});

module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);