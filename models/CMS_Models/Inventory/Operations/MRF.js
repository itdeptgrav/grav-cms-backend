// models/CMS_Models/Inventory/Operations/MRF.js

const mongoose = require("mongoose");

// ── Per-item return history entry ─────────────────────────────────────────────
const returnEntrySchema = new mongoose.Schema(
  {
    returnedQty: { type: Number, required: true, min: 0 },
    returnedAt: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, refPath: "recordedByModel", default: null },
    recordedByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
  },
  { _id: true }
);

// ── Product image attached by the requester ──────────────────────────────────
// Uploaded from the cowork side before the MRF is submitted, so the TL and the
// Store Person both see exactly which product is being asked for.
//
// `publicId` (Cloudinary) and `fileId` (Google Drive) are both kept, not one
// replacing the other: the cowork uploader moved from Cloudinary to Drive
// (components/features/mrf/MrfPhotoUploader.tsx), so an MRF raised before that
// switch still carries `publicId` and one raised after carries `fileId` —
// dropping the field this schema didn't yet have would have silently thrown
// away every new upload's ability to render reliably. Without `fileId`
// specifically, a freshly uploaded photo has only its bare `url` to render
// from, which 404s until Google's CDN indexes the file and has no fallback —
// exactly the "uploaded image is not showing" bug this was added to fix.
const productImageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true },
    publicId: { type: String, trim: true, default: "" },
    fileId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// A single named value on an unmatched item ("Colour: Black, Navy") — mirrors
// RawItem's own attribute shape, so "register as new" can build variants the
// same way RawItemAddRequest's product.attributes used to.
const itemAttributeSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    values: [{ type: String, trim: true }],
  },
  { _id: false }
);

// ── Per-item sub-doc ──────────────────────────────────────────────────────────
const mrfItemSchema = new mongoose.Schema(
  {
    // Unset until the Store matches this line to a catalogue item (or
    // registers a new one) — see itemStatus "UNMATCHED" below. `rawItemName`
    // is required either way: before matching it's the requester's own name
    // for the thing they want, after matching it's the catalogue name.
    rawItem: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    rawItemName: { type: String, trim: true, required: true },
    rawItemSku: { type: String, trim: true, default: "" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],

    // Only meaningful pre-match, on an UNMATCHED line — carried onto the new
    // RawItem if the Store registers it rather than matching it to an
    // existing one. Ignored once `rawItem` is set.
    category: { type: String, trim: true, default: "" },
    attributes: [itemAttributeSchema],

    // Requester-supplied product context (free text — the catalogue record is
    // the source of truth for name/SKU, this is what the requester *meant*).
    description: { type: String, trim: true, default: "" },
    specifications: { type: String, trim: true, default: "" },
    images: { type: [productImageSchema], default: [] },

    // `unit` is the unit the REQUESTER chose and is authoritative for every
    // quantity on this line (requestedQty / issuedQty / returnedQty /
    // availableQty). `baseUnit` is only the catalogue unit — conversion to it
    // happens at the stock-adjustment boundary and nowhere else.
    requestedQty: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, required: true },
    baseUnit: { type: String, trim: true, default: "" },
    issuedQty: { type: Number, default: 0, min: 0 },
    returnedQty: { type: Number, default: 0, min: 0 },
    consumedQty: { type: Number, default: 0, min: 0 },

    itemStatus: {
      type: String,
      enum: [
        // TL-approved but `rawItem` isn't resolved yet — the Store must
        // match it to an existing catalogue item or register it as new
        // before it can be issued. Never set before TL approval; a
        // not-yet-decided line (matched or not) is just "PENDING".
        "UNMATCHED",
        "PENDING", "APPROVED", "PARTIALLY_ISSUED", "ISSUED",
        "PARTIALLY_RETURNED", "RETURNED", "OVERDUE", "REJECTED", "UNFULFILLED",
      ],
      default: "PENDING",
    },

    // ── Store availability reporting ──────────────────────────────────────
    // Set by the Store Person after the TL approves. Independent of
    // itemStatus: availability is "what the store found", itemStatus is
    // "how much has actually moved".
    availability: {
      type: String,
      enum: ["UNREVIEWED", "AVAILABLE", "PARTIAL", "NOT_AVAILABLE", "ALTERNATIVE"],
      default: "UNREVIEWED",
    },
    availableQty: { type: Number, default: null },     // in `unit`, as reported by store
    availabilityNote: { type: String, trim: true, default: "" },
    availabilityUpdatedAt: { type: Date, default: null },
    availabilityUpdatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    availabilityUpdatedByName: { type: String, trim: true, default: "" },

    // Populated when availability === "ALTERNATIVE"
    alternativeItem: {
      rawItem: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
      name: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "" },
    },

    returnHistory: [returnEntrySchema],
    issueHistory: [{
      issuedQty: { type: Number, required: true },
      notes: { type: String, default: "" },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      recordedAt: { type: Date, default: Date.now },
    }],
    // Also doubles as the store's note when rejecting a still-UNMATCHED line.
    storeNotes: { type: String, trim: true, default: "" },

    // A Purchase Form was raised for THIS line (not stocked, being bought) —
    // set by the requisition route once the form is saved. Lets the Store
    // screen show it was already actioned instead of offering the same
    // buttons again with no memory of it.
    purchaseFormRaised: { type: Boolean, default: false },
    purchaseRequisitionId: { type: mongoose.Schema.Types.ObjectId, ref: "Requisition", default: null },
    purchaseRequisitionNumber: { type: String, trim: true, default: "" },
    purchaseFormRaisedAt: { type: Date, default: null },
  },
  { _id: true }
);

// Remaining quantity still owed on this line, in the requester's unit.
mrfItemSchema.virtual("remainingQty").get(function () {
  if (["REJECTED", "UNFULFILLED"].includes(this.itemStatus)) return 0;
  return Math.max(0, (this.requestedQty || 0) - (this.issuedQty || 0));
});

// ── Audit trail entry — powers "who did what, when" in the status UI ─────────
const statusEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, trim: true, required: true }, // CREATED | TL_APPROVED | ISSUED | …
    actorName: { type: String, trim: true, default: "" },
    actorRole: { type: String, trim: true, default: "" },  // employee | tl | store | system
    detail: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// ── Main MRF schema ───────────────────────────────────────────────────────────
const mrfSchema = new mongoose.Schema(
  {
    mrfNumber: { type: String, unique: true, trim: true, required: true },

    // Who the materials are FOR
    requestedFor: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    requestedForName: { type: String, trim: true, default: "" },
    requestedForDept: { type: String, trim: true, default: "" },
    requestedForId: { type: String, trim: true, default: "" }, // employee ID / badge

    // How the MRF was created
    // SELF     → employee raised it themselves via Cowork
    // BYPASS   → store raised it on behalf of the employee
    creationMode: {
      type: String,
      enum: ["SELF", "BYPASS"],
      default: "SELF",
    },

    // Who actually created it (employee if SELF, ProjectManager if BYPASS)
    createdByRef: { type: mongoose.Schema.Types.ObjectId, refPath: "createdByModel", required: true },
    createdByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "Employee" },
    createdByName: { type: String, trim: true, default: "" },

    requestType: {
      type: String,
      enum: ["TIME_BASED", "USES_BASED"],
      required: true,
    },

    // Return deadline — TIME_BASED requests only. When the material must come
    // BACK to the store.
    deadline: { type: Date, default: null },

    // When the requester needs the material IN HAND. Applies to every request
    // type, and is the date the TL and the Store plan around — distinct from
    // `deadline`, which is about returning it afterwards.
    neededBy: { type: Date, default: null },

    reason: { type: String, trim: true, default: "" },

    // Priority
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },

    // Cost centre / project reference (optional, for tracking)
    costCentre: { type: String, trim: true, default: "" },
    projectReference: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: [
        "PENDING",           // awaiting Primary Manager / TL approval
        "APPROVED",          // TL approved — with the store now
        "PARTIALLY_ISSUED",
        "ISSUED",
        "PARTIALLY_RETURNED",
        "COMPLETED",
        "REJECTED",          // TL said no
        "UNFULFILLED",       // TL said yes, store cannot supply it
        "CANCELLED",
      ],
      default: "PENDING",
    },

    items: [mrfItemSchema],

    // ═══════════════════════════════════════════════════════════════════════
    // Approval routing — Employee → Primary Manager/TL → Store
    // Resolved at creation time from the HR Employee record:
    //   requester.primaryManager.managerId → Employee → biometricId
    // The TL's approval queue is filtered on approverBiometricId, which is the
    // same id their cowork session carries (req.coworkUser.employeeId).
    // ═══════════════════════════════════════════════════════════════════════
    approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    approverBiometricId: { type: String, trim: true, default: "" },
    approverName: { type: String, trim: true, default: "" },

    // An HR record can carry both a biometricId and an identityId, and a
    // cowork session identifies itself with whichever one its
    // cowork_employees doc uses. Matching on a single field silently drops
    // the approval queue and every notification for anyone whose two ids
    // differ, so every id the approver could be logged in as is stored and
    // all of them are matched.
    approverAltIds: { type: [String], default: [] },

    // The requester's cowork session id — the id their notifications must be
    // addressed to. Kept separate from requestedForId, which is the HR badge
    // number shown on store screens; the two are usually equal but not always.
    requesterCoworkId: { type: String, trim: true, default: "" },

    // Why routing landed where it did — drives the contextual message shown to
    // the requester when no TL could be found.
    approverResolution: {
      type: String,
      enum: [
        "RESOLVED",
        "NO_MANAGER",             // employee has no primaryManager in HR
        "MANAGER_NOT_FOUND",      // managerId points at a missing Employee doc
        "MANAGER_INACTIVE",       // manager exists but is inactive/suspended
        "MANAGER_NO_BIOMETRIC",   // manager has no biometricId → cannot log in to cowork
        "SELF_MANAGED",           // requester is their own manager
      ],
      default: "RESOLVED",
    },

    // TL → Store, or straight to Store when no TL could be resolved.
    approvalRoute: { type: String, enum: ["TL", "AUTO_STORE"], default: "TL" },
    autoForwarded: { type: Boolean, default: false },
    autoForwardReason: { type: String, trim: true, default: "" },

    // ── TL approval layer ──────────────────────────────────────────────
    tlApproved: { type: Boolean, default: false },
    tlApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    tlApprovedByName: { type: String, trim: true, default: "" },
    tlApprovedAt: { type: Date, default: null },
    tlRejected: { type: Boolean, default: false },
    tlRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    tlRejectedByName: { type: String, trim: true, default: "" },
    tlRejectedAt: { type: Date, default: null },
    tlRejectionNote: { type: String, trim: true, default: "" },

    // ── PM approval layer — RETAINED FOR HISTORY ONLY ─────────────────────
    // PM approval is no longer part of the flow (Employee → TL → Store).
    // These fields stay so pre-existing MRFs keep rendering their audit trail;
    // nothing writes to them any more.
    pmApproved: { type: Boolean, default: false },
    pmApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmApprovedAt: { type: Date, default: null },
    pmRejected: { type: Boolean, default: false },
    pmRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmRejectedAt: { type: Date, default: null },
    pmRejectionNote: { type: String, default: "" },

    // Store actions audit
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    rejectedAt: { type: Date, default: null },
    rejectionNote: { type: String, trim: true, default: "" },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, refPath: "cancelledByModel", default: null },
    cancelledByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
    cancelledAt: { type: Date, default: null },
    cancellationNote: { type: String, trim: true, default: "" },

    // Store closed it as impossible to supply (TL approved, but no stock and no
    // alternative). Distinct from REJECTED so the requester can tell the two apart.
    unfulfilledAt: { type: Date, default: null },
    unfulfilledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    unfulfilledByName: { type: String, trim: true, default: "" },
    unfulfilledReason: { type: String, trim: true, default: "" },

    // Set the first time the store touches availability — used to tell
    // "sitting in the store queue" apart from "store is working on it".
    storeReviewedAt: { type: Date, default: null },

    storeNotes: { type: String, trim: true, default: "" },

    // ── MRF-scoped chat (messages live in the MrfChatMessage collection) ──
    chatMessageCount: { type: Number, default: 0 },
    chatLastMessageAt: { type: Date, default: null },
    chatLastMessageBy: { type: String, trim: true, default: "" },

    // Statuses / actions in chronological order.
    statusHistory: { type: [statusEventSchema], default: [] },
  },
  { timestamps: true }
);

mrfSchema.index({ requestedFor: 1, status: 1, createdAt: -1 });
mrfSchema.index({ status: 1, createdAt: -1 });
mrfSchema.index({ requestType: 1, deadline: 1 });
mrfSchema.index({ creationMode: 1, createdAt: -1 });
// TL approval queue lookup — the hot path for the cowork approvals page.
mrfSchema.index({ approverBiometricId: 1, status: 1, createdAt: -1 });
mrfSchema.index({ approverAltIds: 1, status: 1 });

// Append an audit event. Callers should use this rather than pushing directly
// so every entry carries a consistent shape.
mrfSchema.methods.logEvent = function ({ action, actorName = "", actorRole = "", detail = "" }) {
  this.statusHistory.push({ at: new Date(), action, actorName, actorRole, detail });
  return this;
};

// Auto-generate MRF number
mrfSchema.pre("validate", async function (next) {
  if (!this.mrfNumber) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `MRF-${yy}${mm}-`;
    const last = await mongoose
      .model("MRF")
      .findOne({ mrfNumber: { $regex: `^${prefix}` } })
      .sort({ mrfNumber: -1 })
      .lean();
    const seq = last ? parseInt(last.mrfNumber.slice(-4), 10) + 1 : 1;
    this.mrfNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.models.MRF || mongoose.model("MRF", mrfSchema);
