// models/CMS_Models/Store/WorkerWorkOrder.js
//
// Single schema for Store-department "Worker Work Orders".
// Holds worker details, line items, per-line unit + GST, work area/scope,
// and status workflow.
//
// Status workflow:  Draft → Issued → Completed
//
// NOTE: Almost every field is intentionally OPTIONAL so the create form
// never blocks the user. The ONLY non-removable value is workOrderNumber,
// which is auto-generated (and editable) — the status workflow, list view,
// and PDF filename all depend on it being present and unique.

const mongoose = require("mongoose");

// ── A single line item on the work order ──────────────────────────────────
const workOrderItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, trim: true, default: "" },

    // Multi-line description printed under the item name (like the sample PO).
    description: { type: String, trim: true, default: "" },

    // Free-text size — accepts anything: "30*30", "30x30", "2'6\" × 4'0\"".
    itemSize: { type: String, trim: true, default: "" },

    hsnCode: { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 0 },

    // Unit of measure for this line: Pieces / Nos. / Packs / Meters / Kg / etc.
    // Free text so the user is never blocked, but the form offers common ones.
    unit: { type: String, trim: true, default: "Pieces" },

    unitPrice: { type: Number, default: 0 },

    // GST % is a plain number the user types (0–100). Default 0.
    gstPercentage: { type: Number, default: 0 },

    // Derived snapshots (computed on save so the PDF/view are consistent)
    priceBeforeGST: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    priceIncludingGST: { type: Number, default: 0 },

    // Free-form extra columns the user "adds" themselves.
    customFields: [
      {
        name: { type: String, trim: true, default: "" },
        value: { type: String, trim: true, default: "" },
        _id: false,
      },
    ],
  },
  { _id: false },
);

const workerWorkOrderSchema = new mongoose.Schema(
  {
    // ── Identity ──
    workOrderNumber: {
      type: String,
      trim: true,
      required: true, // the one guaranteed value — auto-generated, editable
      unique: true,
      index: true,
    },

    // ── Worker details ──
    workerName: { type: String, trim: true, default: "" },
    workerPhone: { type: String, trim: true, default: "" },
    workerAddress: { type: String, trim: true, default: "" },
    workerGstin: { type: String, trim: true, default: "" },
    workerNotes: { type: String, trim: true, default: "" },

    // Editable label for the line-items section (these aren't always "items":
    // could be "Work", "Services", "Tasks", etc.). Shown as the table title.
    lineSectionLabel: { type: String, trim: true, default: "Items" },

    // ── Work area / scope (how big / where the work is done) ──
    // Free text description: e.g. "Cutting floor, Section B" or "Full garment".
    workArea: { type: String, trim: true, default: "" },
    // Optional numeric dimensions with a unit (area/length the work covers).
    workAreaSize: { type: Number, default: 0 },
    workAreaUnit: { type: String, trim: true, default: "sq ft" },

    // ── Line items ──
    items: [workOrderItemSchema],

    // ── Custom header-level fields the user adds (key/value) ──
    customHeaderFields: [
      {
        name: { type: String, trim: true, default: "" },
        value: { type: String, trim: true, default: "" },
        _id: false,
      },
    ],

    // ── Totals (snapshot, computed on save) ──
    subtotalBeforeGST: { type: Number, default: 0 },
    totalGST: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    // ── Status workflow (internal) ──
    status: {
      type: String,
      enum: ["Draft", "Issued", "Completed"],
      default: "Draft",
      index: true,
    },

    // ── Priority (shown on the PDF instead of workflow status) ──
    priority: {
      type: String,
      enum: ["Emergency", "Urgent", "Neutral"],
      default: "Neutral",
    },

    // Dates
    issueDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
  },
  { timestamps: true },
);

// Recompute line + order totals before every save.
workerWorkOrderSchema.pre("save", function (next) {
  let subtotal = 0;
  let totalGst = 0;

  (this.items || []).forEach((item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    let gstP = Number(item.gstPercentage) || 0;
    // safety clamp so a stray "180" can't 18x the tax
    if (gstP < 0) gstP = 0;
    if (gstP > 100) gstP = 100;
    item.gstPercentage = gstP;

    const base = qty * price;
    const gst = base * (gstP / 100);

    item.priceBeforeGST = base;
    item.gstAmount = gst;
    item.priceIncludingGST = base + gst;

    subtotal += base;
    totalGst += gst;
  });

  this.subtotalBeforeGST = subtotal;
  this.totalGST = totalGst;
  this.grandTotal = subtotal + totalGst;

  next();
});

workerWorkOrderSchema.index({ status: 1, createdAt: -1 });
workerWorkOrderSchema.index({ workerName: 1 });

module.exports = mongoose.model("WorkerWorkOrder", workerWorkOrderSchema);
