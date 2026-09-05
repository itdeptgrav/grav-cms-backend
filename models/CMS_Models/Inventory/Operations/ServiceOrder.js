// models/CMS_Models/Inventory/Operations/ServiceOrder.js
//
// A SERVICE ORDER — an approved service quote, issued to a supplier, done, and
// accepted by the department that asked for it.
//
// ── WHY THIS IS NOT A PURCHASE ORDER ────────────────────────────────────────
// A purchase order receives goods: it has quantities that land on a shelf, a
// goods receipt, stock that moves, a barcode. A service has none of that. It
// is agreed, the supplier does it, and the department confirms it was done to
// their satisfaction. Forcing a service through the PO model would give it a
// received-quantity and a stock semantics that can only ever be wrong, and the
// wrongness would spread into receiving and valuation reports.
//
// So this is its own operational document. It creates NO PurchaseOrder, no
// goods receipt, no stock, no warehouse transaction, no barcode and no
// inventory movement — see the lifecycle routes.
//
// ── WHY IT IS NOT A "WORK ORDER" ────────────────────────────────────────────
// "Work order" already means production work — the manufacturing WorkOrder
// model — and reusing the word here would make two very different things share
// a name on the same shop floor. The visible name is "Service order".

const mongoose = require("mongoose");

/* ── THE LIFECYCLE ──────────────────────────────────────────────────────────
 *   DRAFT               created from the approval, not yet issued
 *   ISSUED              sent to the supplier
 *   IN_PROGRESS         Store started it / supplier is working
 *   COMPLETION_REPORTED the supplier says the agreed service is done
 *   ACCEPTED            the requesting department confirmed it was received
 *   REWORK_REQUIRED     the department asked for a correction
 *   CANCELLED           stopped before acceptance
 *
 * No paid/billed status: Accounting owns supplier-bill matching and payment,
 * and a half-built version of that recorded here would be a number somebody
 * trusts. */
const STATUSES = [
  "DRAFT",
  "ISSUED",
  "IN_PROGRESS",
  "COMPLETION_REPORTED",
  "ACCEPTED",
  "REWORK_REQUIRED",
  "CANCELLED",
];

/* One line of the order — one service, as it was approved. */
const serviceOrderLineSchema = new mongoose.Schema(
  {
    /* The SpendRequest line this came from, so the order → request chain is
       inspectable in both directions. */
    spendLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* The matched Service Master record and its snapshots. `service` may be
       null on a genuinely name-only line, but the conversion route requires a
       match for every line, so in practice it is set. */
    service: { type: mongoose.Schema.Types.ObjectId, ref: "Service", default: null },
    serviceCode: { type: String, trim: true, default: "" },
    serviceName: { type: String, trim: true, default: "" },

    /* The approved quote's own words for this line — never overwritten by the
       Service Master's current defaults. */
    description: { type: String, trim: true, default: "" },
    specification: { type: String, trim: true, default: "" },

    /* How it is billed — per visit, hour, month, licence, job. Snapshotted so
       it reads correctly even if the master's billing unit changes later. */
    billingUnit: { type: String, trim: true, default: "" },
    sacCode: { type: String, trim: true, default: "" },

    /* A service need not be quantity 1 — it may be several visits, hours or
       months. Straight off the approved quote. */
    quantity: { type: Number, min: 0, default: 1 },
    rate: { type: Number, min: 0, default: 0 },          // approved rate per billing unit
    netAmount: { type: Number, min: 0, default: 0 },     // quantity × rate

    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    gstAmount: { type: Number, min: 0, default: 0 },
    lineTotal: { type: Number, min: 0, default: 0 },     // net + gst

    quoteRef: { type: String, trim: true, default: "" },
    expectedCompletionDate: { type: Date, default: null },
  },
  { _id: true },
);

/* One actor/time/note fact, reused for every audited transition. */
const auditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, trim: true, default: "" },
    action: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const serviceOrderSchema = new mongoose.Schema(
  {
    /* ── Tenancy ──────────────────────────────────────────────────────────
       From the approved request's company, never a request body. Site stays
       null: SpendRequest carries none yet and this does not invent one. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Server-generated `SVO/<financial-year>/<sequence>`; never from a caller. */
    serviceOrderNumber: { type: String, required: true, trim: true },

    /* ── THE APPROVAL THIS FULFILS ────────────────────────────────────────
       Unique among non-null values (partial index below), so one approved
       request produces at most one service order. */
    spendRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "SpendRequest", required: true },
    spendRequestNumber: { type: String, trim: true, default: "" },

    /* Supplier snapshots — one supplier per order (see the conversion rule). */
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorName: { type: String, trim: true, default: "" },
    vendorGstin: { type: String, trim: true, default: "" },

    /* Request snapshots, so the register and detail read without resolving the
       request every time. */
    title: { type: String, trim: true, default: "" },
    purpose: { type: String, trim: true, default: "" },
    department: { type: String, trim: true, default: "" },
    /* The requester's stable Employee id — the primary ownership key. A
       biometric/identity string can be blank or change; an ObjectId does not.
       Additive: legacy orders without it fall back to `requestedById`. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    requestedById: { type: String, trim: true, default: "" },
    requestedByName: { type: String, trim: true, default: "" },

    /* Request-level approved budget head + commitment snapshots. Budget actual
       consumption is Accounting's, not this document's — nothing here spends. */
    budgetLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", default: null },
    budgetLedgerName: { type: String, trim: true, default: "" },
    commitmentId: { type: mongoose.Schema.Types.ObjectId, default: null },

    lines: { type: [serviceOrderLineSchema], default: [] },

    subtotal: { type: Number, min: 0, default: 0 },
    taxAmount: { type: Number, min: 0, default: 0 },
    totalAmount: { type: Number, min: 0, default: 0 },
    /* How to read the header — a mixed-rate order's per-line rates stay
       authoritative. Defaults SINGLE_RATE for compatibility. */
    taxMode: { type: String, enum: ["SINGLE_RATE", "MIXED_RATE"], default: "SINGLE_RATE" },
    taxRate: { type: Number, min: 0, max: 100, default: 0 },

    expectedStartDate: { type: Date, default: null },
    expectedCompletionDate: { type: Date, default: null },

    status: { type: String, enum: STATUSES, default: "DRAFT" },

    /* Audit facts for each stage — actor, time and note recorded once. */
    issued: { type: auditSchema, default: undefined },
    completion: { type: auditSchema, default: undefined },     // supplier reported done
    acceptance: { type: auditSchema, default: undefined },     // department accepted
    rework: { type: auditSchema, default: undefined },         // department asked for a correction
    cancellation: { type: auditSchema, default: undefined },

    history: { type: [historySchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/* Tenant-first register reads. */
serviceOrderSchema.index({ companyId: 1, status: 1, createdAt: -1 });
serviceOrderSchema.index({ companyId: 1, serviceOrderNumber: 1 });

/* ── ONE SERVICE ORDER PER APPROVED REQUEST ─────────────────────────────────
   Partial, on non-null values only, so a concurrent double submission or a
   retry cannot mint a second order for one approval — the database refuses the
   second write and the route returns the one that exists. */
serviceOrderSchema.index(
  { spendRequestId: 1 },
  {
    unique: true,
    name: "one_service_order_per_spend_request",
    partialFilterExpression: { spendRequestId: { $type: "objectId" } },
  },
);

module.exports = mongoose.models.ServiceOrder || mongoose.model("ServiceOrder", serviceOrderSchema);
module.exports.STATUSES = STATUSES;
