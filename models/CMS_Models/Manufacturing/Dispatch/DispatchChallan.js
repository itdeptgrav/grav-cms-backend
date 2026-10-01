// models/CMS_Models/Manufacturing/Dispatch/DispatchChallan.js

const mongoose = require("mongoose");

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const challanProductSchema = new mongoose.Schema(
  {
    progressDocId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
    workOrderNumber:  { type: String, default: "" },
    productName:      { type: String, required: true },
    productRef:       { type: String, default: "" },
    variantAttributes: [
      {
        name:  { type: String },
        value: { type: String },
      },
    ],
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const challanPersonSchema = new mongoose.Schema(
  {
    employeeId:   { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc", default: null },
    employeeName: { type: String, required: true },
    employeeUIN:  { type: String, default: "" },
    department:   { type: String, default: "" },
    designation:  { type: String, default: "" },
    products:     [challanProductSchema],
    totalUnits:   { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const dispatchChallanSchema = new mongoose.Schema(
  {
    challanNumber: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
      trim:     true,
    },
    manufacturingOrderId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "CustomerRequest",
      required: true,
      index:    true,
    },
    requestId:    { type: String, default: "" },
    customerName: { type: String, default: "" },
    // Full customerInfo stored for PDF re-generation without re-fetching
    customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },

    dispatchType: {
      type:     String,
      enum:     ["person_wise", "bulk"],
      required: true,
    },

    // Person-wise order → populated
    persons:      [challanPersonSchema],
    // Bulk order → populated
    bulkProducts: [challanProductSchema],

    totalUnits:    { type: Number, default: 0 },
    totalPersons:  { type: Number, default: 0 },
    totalProducts: { type: Number, default: 0 },

    /* ── CARTON-WISE DISPATCH (25 Sep 2026) ─────────────────────────────────
     * A challan is now made only by scanning sealed cartons on the Dispatch
     * tab; typing a quantity is gone. `cartons` is exactly which boxes left
     * with this challan and what each one held at that moment, copied so the
     * paper can be re-printed even if a carton is later corrected. `persons`
     * and `bulkProducts` are still filled from the same lines, because the
     * PPC ledger, the order-target reader, the closing verdict and the CEO
     * dispatch view all read them. A challan with no `cartons` is a legacy
     * one made from typed quantities. */
    source:       { type: String, enum: ["carton", "manual"], default: "manual" },
    cartons: [
      new mongoose.Schema(
        {
          cartonId:      { type: mongoose.Schema.Types.ObjectId, ref: "PackingCarton", default: null },
          cartonNumber:  { type: String, required: true },
          totalQuantity: { type: Number, default: 0 },
          weightKg:      { type: Number, default: null },
          lines: [
            new mongoose.Schema(
              {
                workOrderId:     { type: mongoose.Schema.Types.ObjectId, default: null },
                workOrderNumber: { type: String, default: "" },
                productName:     { type: String, default: "" },
                productRef:      { type: String, default: "" },
                variantText:     { type: String, default: "" },
                quantity:        { type: Number, default: 0 },
                employeeName:    { type: String, default: "" },
                employeeUIN:     { type: String, default: "" },
              },
              { _id: false },
            ),
          ],
        },
        { _id: false },
      ),
    ],
    cartonCount:  { type: Number, default: 0 },
    /* How it travelled — optional, printed on the challan when given. */
    transport: {
      vehicleNumber: { type: String, trim: true, default: "" },
      driverName:    { type: String, trim: true, default: "" },
      driverPhone:   { type: String, trim: true, default: "" },
      transporter:   { type: String, trim: true, default: "" },
      lrNumber:      { type: String, trim: true, default: "" },
    },

    notes:        { type: String, trim: true, default: "" },
    dispatchedBy: { type: String, default: "" },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
dispatchChallanSchema.index({ manufacturingOrderId: 1, createdAt: -1 });
dispatchChallanSchema.index({ challanNumber: 1 });

module.exports = mongoose.model("DispatchChallan", dispatchChallanSchema);