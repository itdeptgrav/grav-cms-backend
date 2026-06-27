// models/CMS_Models/Inventory/Operations/PurchaseOrder.js

const mongoose = require("mongoose");

const purchaseOrderItemSchema = new mongoose.Schema({
    rawItem:    { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemName:   { type: String, trim: true, required: true },
    sku:        { type: String, trim: true, default: "" },
    unit:       { type: String, trim: true, default: "unit" },
    baseUnit:   { type: String, trim: true, default: "" },
    quantity:   { type: Number, min: 0, required: true },
    unitPrice:  { type: Number, min: 0, required: true },
    totalPrice: { type: Number, min: 0, default: 0 },
    // ── Per-item GST (replaces global taxRate) ──
    gstRate:    { type: Number, min: 0, max: 100, default: 0 },
    gstAmount:  { type: Number, min: 0, default: 0 },
    receivedQuantity: { type: Number, min: 0, default: 0 },
    pendingQuantity:  { type: Number, min: 0, default: 0 },
    status: {
        type: String,
        enum: ["PENDING", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
        default: "PENDING"
    },
    variantId:           { type: mongoose.Schema.Types.ObjectId },
    variantCombination:  [{ type: String, trim: true }],
    variantName:         { type: String, trim: true, default: "" },
    variantSku:          { type: String, trim: true, default: "" },
    vendorNickname:      { type: String, trim: true, default: "" },
    expectedDeliveryDate: { type: Date, default: null }
}, { _id: true });

const deliverySchema = new mongoose.Schema({
    deliveryDate:     { type: Date, default: Date.now },
    quantityReceived: { type: Number, min: 0 },
    invoiceNumber:    { type: String, trim: true },
    notes:            { type: String, trim: true },
    receivedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" }
}, { timestamps: true });

const returnReceiptSchema = new mongoose.Schema({
    quantityReceived: { type: Number, required: true, min: 0 },
    receivedDate:     { type: Date, default: Date.now },
    notes:            { type: String, trim: true, default: "" },
    receivedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
}, { timestamps: true });

const returnRequestSchema = new mongoose.Schema({
    poItemId:           { type: mongoose.Schema.Types.ObjectId, required: true },
    rawItem:            { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemName:           { type: String, trim: true, required: true },
    sku:                { type: String, trim: true, default: "" },
    unit:               { type: String, trim: true, default: "unit" },
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    damagedQuantity:    { type: Number, required: true, min: 0 },
    returnedQuantity:   { type: Number, default: 0, min: 0 },
    pendingReturnQty:   { type: Number, default: 0, min: 0 },
    status: {
        type: String,
        enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"],
        default: "PENDING"
    },
    reason:     { type: String, trim: true, default: "" },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    reportedAt: { type: Date, default: Date.now },
    receipts:   [returnReceiptSchema],
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
    date:            { type: Date, default: Date.now },
    amount:          { type: Number, min: 0 },
    paymentMethod: {
        type: String,
        enum: ["CASH", "BANK_TRANSFER", "CHEQUE", "ONLINE", "OTHER"],
        default: "BANK_TRANSFER"
    },
    referenceNumber: { type: String, trim: true },
    notes:           { type: String, trim: true },
    recordedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" }
}, { timestamps: true });

const purchaseOrderSchema = new mongoose.Schema({
    poNumber: {
        type: String, trim: true, unique: true,
        required: [true, "PO number is required"]
    },
    vendor: {
        type: mongoose.Schema.Types.ObjectId, ref: "Vendor",
        required: [true, "Vendor is required"]
    },
    vendorName: { type: String, trim: true, default: "" },

    orderDate:            { type: Date, default: Date.now },
    expectedDeliveryDate: { type: Date, default: null },

    // ── PI Invoice ──────────────────────────────────────────────────────────
    piInvoiceNumber: { type: String, trim: true, default: "" },
    piInvoicePhoto:  { type: String, trim: true, default: "" }, // Cloudinary URL

    items: [purchaseOrderItemSchema],

    // Pricing — taxAmount is now sum of per-item gstAmounts
    subtotal:        { type: Number, min: 0, default: 0 },
    taxRate:         { type: Number, min: 0, max: 100, default: 0 }, // kept for backward compat, not used in UI
    taxAmount:       { type: Number, min: 0, default: 0 },           // = sum of items[].gstAmount
    shippingCharges: { type: Number, min: 0, default: 0 },
    discount:        { type: Number, min: 0, default: 0 },
    totalAmount:     { type: Number, min: 0, default: 0 },

    deliveries:    [deliverySchema],
    returnRequests:[returnRequestSchema],

    totalReceived: { type: Number, min: 0, default: 0 },
    totalPending:  { type: Number, min: 0, default: 0 },

    status: {
        type: String,
        enum: ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
        default: "DRAFT"
    },
    paymentStatus: {
        type: String,
        enum: ["PENDING", "PARTIAL", "COMPLETED"],
        default: "PENDING"
    },
    payments:     [paymentSchema],
    paymentTerms: { type: String, trim: true, default: "" },
    notes:            { type: String, trim: true, default: "" },
    termsConditions:  { type: String, trim: true, default: "" },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager",
        required: [true, "Created by is required"]
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" }
}, {
    timestamps: true,
    strict: false
});

module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);