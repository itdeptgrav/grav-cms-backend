// models/CMS_Models/Manufacturing/QC/QCRawItemInspection.js
//
// RAW ITEM CHECKING (28 Sep 2026) — one record per raw-item sticker checked
// against ONE manufacturing order.
//
// A garment factory doing job work receives the customer's raw material and
// must check it before it is cut. This is that check. It is deliberately a
// SEPARATE book from `QCInspection` (the per-piece product check): a sticker
// is a quantity of material (say 40 metres of fabric), not a garment, and it
// passes or fails as a quantity — so the record carries `quantity`,
// `passedQuantity` and `defectiveQuantity`, never an operation code or a
// work-order unit. Nothing that reads the product book reads this one.
//
// The sticker is the Product Marking label (`itemid=<24 hex>`, the Barcode
// collection) the Store prints at receipt; its name, variant, quantity and
// unit are copied here at scan time so a record still reads correctly if the
// label is reprinted or the item renamed. The order is chosen by the checker
// BEFORE scanning (the sticker itself rarely names one), and a sticker
// checked twice on the same order supersedes its earlier record rather than
// counting twice.
//
// Collection: `qc_raw_item_inspections` — the empty, unreferenced orphan
// `trips` renamed, because the Atlas cluster is at its 500-collection cap.
"use strict";

const mongoose = require("mongoose");

const STATUSES = Object.freeze(["passed", "defective"]);

const defectEntrySchema = new mongoose.Schema({
  code:     { type: String, required: true, trim: true, uppercase: true },
  name:     { type: String, default: "", trim: true },
  category: { type: String, default: "", trim: true },
}, { _id: false });

const schema = new mongoose.Schema(
  {
    /* when — the IST day and the shift-hour bucket, for the daily and
       hour-wise reports without re-deriving them from the instant */
    date:    { type: String, required: true, index: true },   // "YYYY-MM-DD" IST
    hourKey: { type: String, default: "" },                   // shiftHours bucket key

    /* against which order */
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", required: true, index: true },
    moNumber:     { type: String, default: "", trim: true },
    customerName: { type: String, default: "", trim: true },
    isJobWork:    { type: Boolean, default: false },

    /* which sticker, and what it said at scan time */
    barcodeId:    { type: mongoose.Schema.Types.ObjectId, ref: "Barcode", required: true, index: true },
    rawItemId:    { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null, index: true },
    rawItemName:  { type: String, default: "", trim: true },
    rawItemSku:   { type: String, default: "", trim: true },
    variantId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    variantLabel: { type: String, default: "", trim: true },
    quantity:     { type: Number, required: true, min: 0 },
    unit:         { type: String, default: "", trim: true },
    purchaseOrderNumber: { type: String, default: "", trim: true },
    vendorName:   { type: String, default: "", trim: true },

    /* the verdict, as quantities */
    status:            { type: String, enum: STATUSES, required: true, index: true },
    passedQuantity:    { type: Number, required: true, min: 0 },
    defectiveQuantity: { type: Number, required: true, min: 0 },
    defects:           { type: [defectEntrySchema], default: [] },
    note:              { type: String, default: "", trim: true, maxlength: 500 },

    /* who */
    inspectedByEmail:       { type: String, default: "", lowercase: true, trim: true, index: true },
    inspectedByName:        { type: String, default: "", trim: true },
    inspectedByBiometricId: { type: String, default: "", trim: true },
    inspectedAt:            { type: Date, default: Date.now, index: true },

    /* a re-check of the same sticker on the same order supersedes this one */
    superseded:     { type: Boolean, default: false, index: true },
    supersededById: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededAt:   { type: Date, default: null },
  },
  { timestamps: true, collection: "qc_raw_item_inspections" },
);

schema.index({ manufacturingOrderId: 1, superseded: 1, inspectedAt: -1 });
schema.index({ barcodeId: 1, manufacturingOrderId: 1, superseded: 1 });
schema.index({ inspectedByEmail: 1, date: 1 });
schema.index({ date: 1, superseded: 1 });

module.exports = mongoose.models.QCRawItemInspection || mongoose.model("QCRawItemInspection", schema);
module.exports.STATUSES = STATUSES;
