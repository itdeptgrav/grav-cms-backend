// models/CMS_Models/Inventory/Operations/Requisition.js
//
// A store-raised requisition — the paper form that precedes a Purchase Order.
//
// Deliberately loose: a requisition is often raised BEFORE the vendor or price
// is known, so only name/quantity/unit are required. The blanks are expected,
// and the generated PDF leaves ruled space for them to be filled in by pen
// after printing.

const mongoose = require("mongoose");

const requisitionItemSchema = new mongoose.Schema(
  {
    // Mandatory — a requisition with no item, quantity or unit is not a
    // requisition, and the PDF would be unusable.
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },

    // Optional — frequently unknown at the time the form is raised.
    vendorName: { type: String, trim: true, default: "" },
    price: { type: Number, default: null },

    notes: { type: String, trim: true, default: "" },
  },
  { _id: true }
);

// Line value, for the PDF total. Null price stays null rather than becoming
// zero — "unknown" and "free" are not the same thing.
requisitionItemSchema.virtual("lineTotal").get(function () {
  if (this.price === null || this.price === undefined) return null;
  return (Number(this.price) || 0) * (Number(this.quantity) || 0);
});

const requisitionSchema = new mongoose.Schema(
  {
    requisitionNumber: { type: String, unique: true, trim: true, required: true },

    items: {
      type: [requisitionItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "A requisition needs at least one item",
      },
    },

    // Who the requisition is FOR — picked from the HR employee list. Often
    // not the person operating the screen: the store frequently raises the
    // form on somebody else's behalf, and the printed form has to name them.
    requestedByEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    requestedByName: { type: String, trim: true, default: "" },
    requestedById: { type: String, trim: true, default: "" },   // biometric / badge

    department: { type: String, trim: true, default: "" },

    // Shown throughout the UI and on the PDF as "Due At". The stored name is
    // left as-is so existing requisitions keep their dates — renaming the
    // field would need a migration for a purely cosmetic change.
    requiredBy: { type: Date, default: null },

    reason: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },

    // ── Petty cash ────────────────────────────────────────────────────
    // Cash handed over so the requested items can be bought directly. Both
    // optional: plenty of requisitions involve no cash at all, and the amount
    // is often decided after the form is printed.
    pettyCashAmount: { type: Number, default: null },
    pettyCashGivenTo: { type: String, trim: true, default: "" },
    pettyCashGivenToEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    pettyCashNote: { type: String, trim: true, default: "" },

    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },

    status: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "CONVERTED", "CANCELLED"],
      default: "SUBMITTED",
    },

    // If this requisition later became a real PO, keep the link.
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },

    createdByRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

requisitionSchema.index({ createdAt: -1 });
requisitionSchema.index({ status: 1, createdAt: -1 });

// REQ-YYMM-0001, mirroring the MRF numbering the store already reads.
requisitionSchema.pre("validate", async function (next) {
  if (!this.requisitionNumber) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `REQ-${yy}${mm}-`;
    const last = await mongoose
      .model("Requisition")
      .findOne({ requisitionNumber: { $regex: `^${prefix}` } })
      .sort({ requisitionNumber: -1 })
      .lean();
    const seq = last ? parseInt(last.requisitionNumber.slice(-4), 10) + 1 : 1;
    this.requisitionNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  }
  next();
});

module.exports =
  mongoose.models.Requisition || mongoose.model("Requisition", requisitionSchema);
