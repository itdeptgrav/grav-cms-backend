// models/Customer_models/CustomerRequest.js

const mongoose = require("mongoose");

// ========== REQUEST ITEM SCHEMAS ==========
const requestItemVariantSchema = new mongoose.Schema(
  {
    variantId: {
      // ADD THIS FIELD
      type: String,
      default: () =>
        `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    },
    attributes: [
      {
        name: {
          type: String,
        },
        value: {
          type: String,
        },
      },
    ],
    quantity: {
      type: Number,

      min: 1,
    },
    specialInstructions: [
      {
        type: String,
        trim: true,
      },
    ],
    estimatedPrice: {
      type: Number,
      min: 0,
    },

    // ── WHO this quantity is for ──────────────────────────────────────────
    //
    // On a uniform order built from a measurement drive, `quantity: 12` is
    // twelve named people. The line stays aggregated because that is the right
    // commercial shape — nobody wants a 300-line invoice — but without this the
    // identities were simply gone: "did we make, or bill, Ramesh's uniform?"
    // could only be answered by reopening the drive and guessing by size, which
    // fails as soon as two people share one.
    //
    // Empty on an ordinary stock order, where there is nobody to name.
    // `services/personRoster.js` builds it and checks it sums to `quantity`.
    persons: [
      {
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc" },
        // The customer's OWN identifier for the person, and the one they will
        // quote back at us when they ask. Kept as a string alongside the ref so
        // the answer survives the employee record being archived.
        employeeUIN: { type: String, trim: true },
        employeeName: { type: String, trim: true },
        department: { type: String, trim: true },
        designation: { type: String, trim: true },
        quantity: { type: Number, min: 0, default: 1 },
      },
    ],
  },
  { _id: false },
);

const requestItemSchema = new mongoose.Schema(
  {
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
    },
    stockItemName: {
      type: String,
    },
    stockItemReference: {
      type: String,
    },
    variants: [requestItemVariantSchema],
    totalQuantity: {
      type: Number,
      min: 1,
    },
    totalEstimatedPrice: {
      type: Number,
      min: 0,
    },
  },
  { _id: false },
);

// ========== PAYMENT RECEIPT SCHEMA ==========
const paymentReceiptSchema = new mongoose.Schema(
  {
    receiptId: {
      type: String,
    },
    amount: {
      type: Number,

      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: [
        "bank_transfer",
        "upi",
        "cheque",
        "cash",
        "credit_card",
        "debit_card",
      ],
    },
    transactionId: {
      type: String,
      trim: true,
    },
    utrNumber: {
      type: String,
      trim: true,
    },
    receiptImage: {
      type: String, // Cloudinary URL
    },
    additionalNotes: {
      type: String,
      trim: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    verifiedAt: {
      type: Date,
    },
    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
    verificationNotes: {
      type: String,
      trim: true,
    },
 
    // ── On-behalf payment audit trail ─────────────────────────────────
    isOnBehalf: {
      type: Boolean,
      default: false,
    },
    onBehalfCustomerName: {
      type: String,
      trim: true,
    },
    recordedByName: {
      type: String,
      trim: true,
    },
    recordedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    signatoryName: {
      type: String,
      trim: true,
    },
    signatoryContact: {
      type: String,
      trim: true,
    },
    authorizationNote: {
      type: String,
      trim: true,
    },
    digitalSignature: {
      type: String,   // base64 PNG of drawn signature
    },
    recordedAt: {
      type: Date,
    },
  },
  { _id: true, timestamps: true },
);

// ========== PAYMENT SCHEDULE SCHEMA ==========
const paymentScheduleSchema = new mongoose.Schema(
  {
    stepNumber: {
      type: Number,

      min: 1,
    },
    name: {
      type: String,

      trim: true,
    },
    percentage: {
      type: Number,

      min: 0,
      max: 100,
    },
    amount: {
      type: Number,

      min: 0,
    },
    dueDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["pending", "paid", "overdue", "partially_paid"],
      default: "pending",
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    remainingAmount: {
      type: Number,
      min: 0,
    },
    paidDate: {
      type: Date,
    },
    paymentMethod: {
      type: String,
      trim: true,
    },
    paymentReceipts: [paymentReceiptSchema], // Multiple receipts can be attached to one payment step
    transactionId: {
      type: String,
      trim: true,
    },
  },
  { _id: true },
);

// ========== QUOTATION ITEM SCHEMA ==========
const quotationItemSchema = new mongoose.Schema(
  {
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
    },
    itemName: {
      type: String,
    },
    itemCode: {
      type: String,
    },
    hsnCode: {
      type: String,
    },
    description: {
      type: String,
    },
    quantity: {
      type: Number,

      min: 1,
    },
    unitPrice: {
      type: Number,

      min: 0,
    },
    // The target price this item was raised at — set once, at request
    // creation or when the item is first added to the PI, and never lowered
    // after (26 Aug 2026: "they can change the price just by increase the
    // price ok not decrease... that changed price also need to keep the
    // record"). unitPrice - basePrice is the increase a sales person sold
    // above target; preparedBy + updatedAt on the quotation say who and
    // when. Falls back to unitPrice itself for quotations saved before this
    // field existed — see quotationRoutes.js.
    basePrice: {
      type: Number,
      min: 0,
    },
    discountPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    gstPercentage: {
      type: Number,
      default: 18,
      min: 0,
      max: 100,
    },
    priceBeforeGST: {
      type: Number,
      min: 0,
    },
    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    priceIncludingGST: {
      type: Number,

      min: 0,
    },
    attributes: [
      {
        name: String,
        value: String,
      },
    ],
    stockInfo: {
      quantityOnHand: Number,
      status: String,
    },
  },
  { _id: true },
);

const paymentSubmissionSchema = new mongoose.Schema(
  {
    paymentStepNumber: {
      type: Number,
    },
    submissionDate: {
      type: Date,
      default: Date.now,
    },
    submittedAmount: {
      type: Number,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: [
        "bank_transfer",
        "upi",
        "cheque",
        "cash",
        "credit_card",
        "debit_card",
      ],
    },
    transactionId: {
      type: String,
      trim: true,
    },
    utrNumber: {
      type: String,
      trim: true,
    },
    receiptImage: {
      type: String,
    },
    additionalNotes: {
      type: String,
      trim: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    status: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    verifiedAt: {
      type: Date,
    },
    verificationNotes: {
      type: String,
      trim: true,
    },
 
    // ── On-behalf & audit trail fields ───────────────────────────────
    isOnBehalf: {
      type: Boolean,
      default: false,
    },
    onBehalfCustomerName: {
      type: String,
      trim: true,
      default: "",
    },
    recordedByName: {
      type: String,
      trim: true,
      default: "",
    },
    recordedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    signatoryName: {
      type: String,
      trim: true,
      default: "",
    },
    signatoryContact: {
      type: String,
      trim: true,
      default: "",
    },
    authorizationNote: {
      type: String,
      trim: true,
      default: "",
    },
    digitalSignature: {
      type: String,
      default: "",
    },
    recordedAt: {
      type: Date,
    },
  },
  { _id: true, timestamps: true },
);

// ========== QUOTATION SCHEMA ==========
const quotationSchema = new mongoose.Schema(
  {
    quotationNumber: {
      type: String,
      sparse: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    validUntil: {
      type: Date,
    },
    items: [quotationItemSchema],
    subtotalBeforeGST: {
      type: Number,

      min: 0,
    },
    totalDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalGST: {
      type: Number,

      min: 0,
    },
    // REMOVED: adjustment field
    // ADDED: customAdditionalCharges
    customAdditionalCharges: [
      {
        name: {
          type: String,

          trim: true,
        },
        amount: {
          type: Number,

          min: 0,
        },
        description: {
          type: String,
          trim: true,
        },
      },
    ],
    shippingCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    grandTotal: {
      type: Number,

      min: 0,
    },
    paymentSchedule: [paymentScheduleSchema],
    // ADDED: Payment submission tracking
    paymentSubmissions: [paymentSubmissionSchema],
    notes: {
      type: String,
      trim: true,
    },
    termsAndConditions: {
      type: String,
      trim: true,
    },
    preparedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },

    // ── NEGOTIATION ────────────────────────────────────────────────────────
    // A price that goes to a customer is rarely the price they accept. Each
    // round is a REVISION: `quotations[0]` is always the current one — thirty
    // readers across Sales, the accountant module and the dashboard assume
    // that and none of them had to change — and the round it replaced is
    // archived whole into `quotationRevisions` on the request.
    revision: {
      type: Number,
      default: 1,
      min: 1,
    },
    /** Why this round exists, in the salesperson's own words. */
    revisionReason: {
      type: String,
      trim: true,
    },
    /** The archived revision this one answers. Null on the first. */
    supersedesQuotationId: {
      type: mongoose.Schema.Types.ObjectId,
    },

    status: {
      type: String,
      enum: [
        "draft",
        "sent_to_customer",
        "customer_approved",
        "sales_approved",
        "rejected",
        "expired",
      ],
      default: "draft",
    },
    customerApproval: {
      approved: {
        type: Boolean,
        default: false,
      },
      approvedAt: Date,
      approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
      notes: String,
    },

    /**
     * The customer's own purchase order, as evidence that they approved this
     * quotation (25 Aug 2026, explicit request: "at the time of asking for
     * the Customer approve button it is needed to ask for the upload PO
     * proof, so here the file upload will happen, or else the customer
     * approve button will not be enabled").
     *
     * Sales recording an approval ON BEHALF of a customer is an assertion
     * about someone who is not in the room. Until now that assertion had
     * nothing behind it — approve-on-behalf wrote `customerApproval.approved
     * = true` on a click. The PO is the document the customer actually sent,
     * so it is the thing that makes the claim checkable later, which is why
     * the route now refuses without it rather than merely the button being
     * disabled.
     *
     * Either `fileId` (Google Drive, legacy) or `publicId`/`url`
     * (Cloudinary, current) identifies the file — same dual shape every other
     * upload in this app stores; see grav-clothing/lib/driveImage.js.
     *
     * NOT required for the two deliberate internal overrides — sales-approve
     * with `acknowledgeNoCustomerApproval`, and mark-internal-order — because
     * those exist precisely for orders with no customer approval to evidence.
     */
    poProof: {
      fileId: { type: String, trim: true },
      publicId: { type: String, trim: true },
      url: { type: String, trim: true },
      name: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      /** What the customer calls this PO on their side, and its own date/value. */
      poNumber: { type: String, trim: true },
      poDate: Date,
      poValue: { type: Number, min: 0 },
      uploadedAt: Date,
      uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SalesDepartment",
      },
    },
    salesApproval: {
      approved: {
        type: Boolean,
        default: false,
      },
      approvedAt: Date,
      approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SalesDepartment",
      },
      notes: String,
    },

    /**
     * A structured rejection record (26 Aug 2026, explicit request: "there
     * is no proper handler for the rejection of the pi... once rejected it
     * is needed to show the rejection reason and all"). Before this, a
     * reject only ever wrote free text into `salesApproval.notes` (a field
     * meant for approval notes, not a rejection) and into the request's
     * general timeline — nowhere the detail view or the list could read a
     * reason from directly. Mirrors the existing `pmRejected*`/
     * `pmRejectionNote` shape already on this same document (the
     * Project-Manager-approval layer, below) rather than inventing a new
     * convention.
     */
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    rejectedByName: { type: String, trim: true, default: "" },
    // Which side rejected it — Sales, on their own review, or the customer,
    // via the portal. Both routes write to this same field; only the actor
    // differs.
    rejectedByRole: { type: String, trim: true, enum: ["sales", "customer", null], default: null },
    rejectionReason: { type: String, trim: true, default: "" },

    sentToCustomerAt: Date,
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },

    accountantApproval: {
      approved: {
        type: Boolean,
        default: false,
      },
      approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AccountantDepartment",
      },
      approvedAt: {
        type: Date,
      },
      notes: {
        type: String,
      },
      // Track approval history if accountant changes decision
      approvalHistory: [
        {
          action: {
            type: String,
            enum: ["approved", "rejected", "revoked"],
          },
          actionBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AccountantDepartment",
          },
          actionAt: {
            type: Date,
            default: Date.now,
          },
          notes: String,
        },
      ],
    },
  },
  { timestamps: true },
);

// ========== EDIT REQUEST SCHEMA ==========
const editRequestSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    customerInfo: {
      name: {
        type: String,
      },
      email: {
        type: String,

        lowercase: true,
      },
      phone: {
        type: String,
      },
      address: {
        type: String,
      },
      city: {
        type: String,
      },
      postalCode: {
        type: String,
      },
      description: {
        type: String,
        trim: true,
      },
      deliveryDeadline: {
        type: Date,
      },
      preferredContactMethod: {
        type: String,
        enum: ["phone", "email", "whatsapp"],
        default: "phone",
      },
    },
    items: [requestItemSchema],
    changes: [
      {
        field: String,
        oldValue: mongoose.Schema.Types.Mixed,
        newValue: mongoose.Schema.Types.Mixed,
        changeType: {
          type: String,
          enum: ["modified", "added", "removed"],
        },
      },
    ],
    reason: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending_approval", "approved", "rejected", "cancelled"],
      default: "pending_approval",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    reviewedAt: {
      type: Date,
    },
    reviewNotes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

// ========== QUOTATION NOTIFICATION SCHEMA ==========
const quotationNotificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "customer_approval",
        "sales_approval_required",
        "quotation_expired",
        "payment_received",
        "payment_verified",
        "payment_rejected",
      ],
    },
    message: {
      type: String,
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId, // Could be quotation ID or payment receipt ID
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
    read: {
      type: Boolean,
      default: false,
    },
    actionRequired: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true, timestamps: true },
);

// ========== NOTE SCHEMA ==========
const noteSchema = new mongoose.Schema(
  {
    text: {
      type: String,
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "notes.addedByModel",
    },
    addedByModel: {
      type: String,
      enum: ["SalesDepartment", "Customer"],
    },
    relatedTo: {
      type: String,
      enum: ["request", "quotation", "payment", "edit_request"],
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
    },
  },
  { _id: true, timestamps: true },
);

// ========== MAIN CUSTOMER REQUEST SCHEMA ==========
const customerRequestSchema = new mongoose.Schema(
  {
    // Basic Information
    requestId: {
      type: String,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },

    requestType: {
      type: String,
      enum: ["customer_request", "measurement_conversion"],
      default: "customer_request",
    },
    isInternalOrder: {
      type: Boolean,
      default: false,
    },
    internalOrderMarkedAt: {
      type: Date,
      default: null,
    },
    measurementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Measurement",
      default: null,
    },
    measurementName: {
      type: String,
      trim: true,
    },

    // Customer Information
    customerInfo: {
      name: {
        type: String,
      },
      email: {
        type: String,

        lowercase: true,
      },
      phone: {
        type: String,
      },
      address: {
        type: String,
      },
      city: {
        type: String,
      },
      postalCode: {
        type: String,
      },
      description: {
        type: String,
        trim: true,
      },
      deliveryDeadline: {
        type: Date,
      },
      preferredContactMethod: {
        type: String,
        enum: ["phone", "email", "whatsapp"],
        default: "phone",
      },
    },

    // Order Items
    items: [requestItemSchema],

    // Status Tracking
    status: {
      type: String,
      enum: [
        "pending",
        "pending_edit_approval",
        "in_progress",
        "quotation_draft",
        "quotation_sent",
        "quotation_customer_approved",
        "quotation_sales_approved",
        // A rejected quotation used to fall straight back to "in_progress" —
        // indistinguishable in the list from a PI simply being priced
        // normally (26 Aug 2026, explicit request: "in the list it is needed
        // to show ki this Pi is rejected"). Not a dead end: sending a fresh
        // quotation moves `status` forward again the same way it always did
        // (see syncRequestStatusFromQuotation in quotationRoutes.js), so this
        // clears itself the moment Sales acts on the request again.
        "rejected",
        "production",
        "shipping",
        "delivered",
        "completed",
        "cancelled",
        "on_hold",
      ],
      default: "pending",
    },

    // Timeline
    estimatedCompletion: {
      type: Date,
    },
    actualCompletion: {
      type: Date,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },
    processingStartedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
      default: null,
    },

    // Quotation Management - ONLY ONE QUOTATION ALLOWED
    quotations: [quotationSchema],

    /**
     * Superseded rounds, oldest first. Append-only.
     *
     * A revision is history the moment it is replaced: what we offered, what it
     * came to, when it went out and what the customer said. Overwriting it —
     * which is what this route did before, `Object.assign` onto quotations[0] —
     * lost the entire negotiation and left nobody able to answer "what did we
     * quote them in August". Nothing writes to these once archived.
     */
    quotationRevisions: [quotationSchema],
    // REMOVED: currentQuotation field (not needed with single quotation)
    finalOrderPrice: {
      type: Number,
      min: 0,
    },

    // Tax Summary
    taxSummary: {
      totalGST: {
        type: Number,
        default: 0,
      },
      sgst: {
        type: Number,
        default: 0,
      },
      cgst: {
        type: Number,
        default: 0,
      },
      igst: {
        type: Number,
        default: 0,
      },
    },

    // Payment Tracking
    totalPaidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDueAmount: {
      type: Number,
      min: 0,
    },
    lastPaymentDate: {
      type: Date,
    },

    // Quotation Validity
    quotationValidUntil: {
      type: Date,
    },

    // Priority and Assignment
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    salesPersonAssigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },

    // Communication
    notes: [noteSchema],

    // Edit Requests
    editRequests: [editRequestSchema],
    pendingEditRequest: {
      type: mongoose.Schema.Types.ObjectId,
    },

    // Notifications
    quotationNotifications: [quotationNotificationSchema],


    // ── PM approval layer ──────────────────────────────────────────────
    pmApproved:      { type: Boolean, default: false },
    pmApprovedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmApprovedAt:    { type: Date, default: null },
    pmRejected:      { type: Boolean, default: false },
    pmRejectedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmRejectedAt:    { type: Date, default: null },
    pmRejectionNote: { type: String, default: "" },

    // Audit Fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "updatedByModel",
    },
    updatedByModel: {
      type: String,
      enum: ["Customer", "SalesDepartment"],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// This model had NONE until 27 Aug 2026 (explicit performance request: the
// Order Book "takes too much time to load"). Every list query was a full
// collection scan followed by an in-memory sort, which is invisible at 30 rows
// and gets linearly worse for the life of the business.
//
// Matched to what routes/CMS_Routes/Sales/customerRequests.js actually does:
//   • The list route filters on `status` and sorts `{ createdAt: -1 }` — a
//     compound index in that order serves filter-then-sort in one pass, and
//     also serves the unfiltered sort via its prefix.
//   • `createdAt` alone covers the no-filter case cleanly.
//   • `customerId` is the customer-scoped lookup (a customer's own orders).
//   • `requestId` is the human-facing reference searched by exact match.
customerRequestSchema.index({ status: 1, createdAt: -1 });
customerRequestSchema.index({ createdAt: -1 });
customerRequestSchema.index({ customerId: 1, createdAt: -1 });
customerRequestSchema.index({ requestId: 1 });

module.exports = mongoose.model("CustomerRequest", customerRequestSchema);
