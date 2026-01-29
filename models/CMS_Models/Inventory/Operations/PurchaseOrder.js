// models/CMS_Models/Inventory/Operations/PurchaseOrder.js

const mongoose = require("mongoose");

const purchaseOrderItemSchema = new mongoose.Schema({
    rawItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "RawItem",
        required: [true, "Raw item is required"]
    },
    itemName: {
        type: String,
        trim: true,
        required: [true, "Item name is required"]
    },
    sku: {
        type: String,
        trim: true,
        default: ""
    },
    unit: {
        type: String,
        trim: true,
        default: "unit"
    },
    quantity: {
        type: Number,
        min: [0, "Quantity cannot be negative"],
        required: [true, "Quantity is required"]
    },
    unitPrice: {
        type: Number,
        min: [0, "Unit price cannot be negative"],
        required: [true, "Unit price is required"]
    },
    totalPrice: {
        type: Number,
        min: [0, "Total price cannot be negative"],
        default: 0
    },
    receivedQuantity: {
        type: Number,
        min: [0, "Received quantity cannot be negative"],
        default: 0
    },
    pendingQuantity: {
        type: Number,
        min: [0, "Pending quantity cannot be negative"],
        default: 0
    },
    status: {
        type: String,
        enum: ["PENDING", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
        default: "PENDING"
    },

    variantId: {
        type: mongoose.Schema.Types.ObjectId
    },
   
    receivedQuantity: {
        type: Number,
        min: [0, "Received quantity cannot be negative"],
        default: 0
    },
    variantCombination: [{
        type: String,
        trim: true
    }],
    variantName: {
        type: String,
        trim: true,
        default: ""
    },
    variantSku: {
        type: String,
        trim: true,
        default: ""
    }
}, { _id: true });

const deliverySchema = new mongoose.Schema({
    deliveryDate: {
        type: Date,
        default: Date.now
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
        unique: true,
        required: [true, "PO number is required"]
    },
    vendor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Vendor",
        required: [true, "Vendor is required"]
    },
    vendorName: {
        type: String,
        trim: true,
        default: ""
    },

    // Order Details
    orderDate: {
        type: Date,
        default: Date.now
    },
    expectedDeliveryDate: {
        type: Date,
        default: null
    },

    // Items
    items: [purchaseOrderItemSchema],

    // Pricing
    subtotal: {
        type: Number,
        min: 0,
        default: 0
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
        min: 0,
        default: 0
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
        min: 0,
        default: 0
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
        trim: true,
        default: ""
    },

    // Additional Info
    notes: {
        type: String,
        trim: true,
        default: ""
    },
    termsConditions: {
        type: String,
        trim: true,
        default: ""
    },

    // References
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager",
        required: [true, "Created by is required"]
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProjectManager"
    }
}, {
    timestamps: true,
    // Disable strict mode to allow additional fields
    strict: false
});



module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);