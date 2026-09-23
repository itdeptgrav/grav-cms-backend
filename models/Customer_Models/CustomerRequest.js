// models/Customer_models/CustomerRequest.js

const mongoose = require("mongoose");
const { ensureLineIdentities } = require("./customerRequestLineIdentity");

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
    // ── THIS LINE'S PERMANENT NAME ────────────────────────────────────────
    //
    // Server-minted, unique within the request, and never reissued. It is the
    // identity anything outside this record points at — the Sales →
    // Merchandising handover above all, which used to point at
    // `sampleStyleId` and therefore could not tell two commercial lines of
    // the same style apart.
    //
    // Position cannot be that identity: the quotation paths filter emptied
    // lines out and reassign the array. Neither can the style: one order
    // legitimately carries a style twice, for two destinations or two
    // delivery commitments. See customerRequestLineIdentity.js for how it is
    // minted and why a client can name one but never invent one.
    lineRef: {
      type: String,
      trim: true,
      index: true,
    },
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
    },
    // The approved style this customer-request line represents. This is the
    // durable identity bridge to Central Costing; the quotation never infers a
    // price from a product name or SKU.
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SampleStyle",
      default: null,
      index: true,
    },
    /* ── AND WHICH COMMERCIAL LINE IT IS ────────────────────────────────
       The style alone is not the key: the commercial line is keyed by the
       permanent `productLineRef` AND the style, because one enquiry can
       carry the same garment twice in two colourways. Stamped on a line
       raised from an enquiry, so the quantity on it can be traced back to
       the line it was read from. Absent on a request raised any other way. */
    productLineRef: {
      type: String,
      trim: true,
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

    /* ── WHICH COMMERCIAL DECISION PRICED THIS LINE ─────────────────────
       A proforma raised from an enquiry line is priced by an APPROVED
       costing version and the selling price that version was approved with.
       This records which one, so the figure on a customer-facing document
       can be accounted for without anybody reconstructing it from memory.
       Absent on a request raised any other way, and never accepted from a
       request body — `proformaRequest.service` resolves and stamps it.

       The floor and the standing are internal commercial facts. They live
       here, on the request record, and are not part of what a customer
       document renders. */
    commercialDecision: {
      type: new mongoose.Schema({
        costingId: { type: mongoose.Schema.Types.ObjectId, default: null },
        costingVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
        costingVersionNumber: { type: Number, default: null },
        scenarioKey: { type: String, trim: true, default: null },
        /* The confirmed quantity and the approved price, in the units each is
           authoritative in — minor units for money, so no rounding happens
           between the decision and the document. */
        quantity: { type: Number, default: null },
        unitPriceMinor: { type: Number, default: null },
        floorPriceMinor: { type: Number, default: null },
        standing: { type: String, trim: true, default: null },
        /* Said rather than inferred: a below-floor price is only invoiceable
           through a completed executive exception, and a reader must be able
           to see that this was one. */
        wasBelowFloorException: { type: Boolean, default: false },
        approvedAt: { type: Date, default: null },
        approvedByName: { type: String, trim: true, default: null },
        decisionReason: { type: String, trim: true, default: null },
      }, { _id: false }),
      default: undefined,
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

    // ── WHICH STYLE THIS LINE IS FOR (Central Costing handoff) ─────────────
    //
    // THE SMALLEST ADDITIVE REFERENCE THAT MAKES THE JOIN REAL. A quotation
    // line carried `stockItemId` and free text, and Central Costing is keyed
    // by `{enquiryId, productName}` — so there was no stored path between a
    // priced line and the costing that priced it. The only bridge available
    // was `SampleStyle.production.stockItemId`, and that is one-to-many: two
    // variant styles routinely share a finished good, so a reverse lookup
    // would price the navy line from the ecru costing and look perfectly
    // reasonable doing it.
    //
    // Matching on product name, SKU text, amount or array position was never
    // an option — a rename, a reorder or a coincidence of wording would each
    // silently repoint the price.
    //
    // Nullable, and absent on every existing line: a quotation without it
    // simply has no approved price to offer, which is the honest state for
    // the 25 quotations that predate this.
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SampleStyle",
      default: null,
      index: true,
    },

    /* ── AND WHICH ROW OF THE ENQUIRY IT IS ────────────────────────────────
       The permanent reference of the commercial line this quotation line was
       priced from. A style says which colourway; this says which of the
       enquiry's rows, which is what tells two rows of the same garment apart
       when they share a style or a finished good. Absent on every manual and
       historical line — nothing infers one. */
    productLineRef: { type: String, trim: true, default: undefined },

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
    // ── WHERE THIS PRICE CAME FROM ────────────────────────────────────────
    //
    // Present when Sales took an approved costing price; absent when they
    // typed one. The absence is the record of a manual price — there is no
    // "MANUAL" marker to forge, and a line that has never been linked cannot
    // claim to have been.
    //
    // Every field is resolved and stamped BY THE SERVER from the approved
    // version. A browser that could post its own `unitPriceMinor` or
    // `costingVersionId` could quote any number and have the record say a
    // costing approved it.
    //
    // Frozen, like every other provenance in this system: a later approval,
    // policy change or recosting cannot alter what a saved quotation says it
    // was priced from. See `services/centralCosting/approvedOutput.service.js`.
    costingSource: {
      source: { type: String, enum: ["APPROVED_COSTING"], default: undefined },
      costingId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      costingVersionId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      costingVersionNumber: { type: Number, default: undefined },
      sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      styleCode: { type: String, trim: true, default: undefined },
      productName: { type: String, trim: true, default: undefined },
      scenarioKey: { type: String, trim: true, default: undefined },
      // The quantity the price was APPROVED for. Kept beside the line's own
      // quantity so a later edit to the line is visible as a divergence
      // rather than silently inheriting an approval it no longer matches.
      quantity: { type: String, trim: true, default: undefined },
      /* ── WHICH APPROVED PRICE THIS LINE WAS TAKEN FROM ──────────────────
         `floor` on a costing approved under the pricing floor policy; one of
         the three retired tiers on a historical one. Both are kept: the tiers
         still describe quotations the company really sent, and reading a
         floor as a "target" would restate what was quoted. */
      priceTier: { type: String, enum: ["floor", "minimum", "target", "preferred"], default: undefined },
      /* ── OR NO TIER AT ALL, BECAUSE SALES ALREADY DECIDED ───────────────
         A tier is a price the costing OFFERS. A Sales-origin proforma line is
         not offered a choice: the enquiry's commercial review already settled
         which figure this customer is charged, and froze it on the customer
         request as `items[].commercialDecision`. That figure can sit BELOW the
         floor — an executive exception is exactly that — so resolving this
         line through the tier machinery would quote the floor and call it
         approved. It carries `priceBasis` and no tier instead.

         `approvalKind` is how it was cleared, and it is the whole of what the
         proforma may say about the decision. The floor it was measured
         against, the cost behind it and the reason somebody typed are internal
         commercial facts; a customer-facing document has no business
         carrying them. */
      priceBasis: { type: String, enum: ["SALES_APPROVED_DECISION"], default: undefined },
      approvalKind: { type: String, enum: ["COMMERCIAL", "EXECUTIVE"], default: undefined },
      // Minor units, and EXCLUDING GST — the quotation applies tax afterwards.
      unitPriceMinor: { type: Number, default: undefined },
      currency: { type: String, trim: true, default: undefined },
      linkedAt: { type: Date, default: undefined },
      approvedAt: { type: Date, default: undefined },
      assumptions: { type: [String], default: undefined },
      // Identity evidence over the ids and figures that produced the price.
      // Not a signature: it proves the saved line still describes the same
      // approved facts, not that nobody with database access changed them.
      fingerprint: { type: String, trim: true, default: undefined },
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
    /* ── WHERE A SALES-RAISED REQUEST CAME FROM ─────────────────────────
       A proforma raised from Cost & Invoicing is for ONE enquiry, and the
       quantity on every line was read from that enquiry's confirmed
       commercial lines rather than sent by the browser. Recording the
       enquiry makes that provenance readable, and `actionKey` is what makes
       an exact retry replay instead of creating a second document. */
    salesOrigin: {
      enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry" },
      actionKey: { type: String, trim: true },
      /* ── THE COMMERCIAL STATE THIS DOCUMENT WAS RAISED ON ────────────
         A server-derived digest of the company, the enquiry, and every
         invoiced line's confirmed quantity, approved selling price and the
         costing version that approved it — nothing a request body can
         influence.

         `actionKey` only ever answered "is this the SAME press again?", so
         two presses of one button minted two keys, the server saw two
         commands and honoured both: a live double-click produced two
         customer requests for one enquiry. The claim answers the question
         that actually matters — "has this commercial state already been
         invoiced?" — and the unique index below makes the answer the
         database's rather than a check-then-insert's.

         Absent on every request raised outside Cost & Invoicing (and on
         every record that predates this), which is why the index below is
         partial: those are not claims, and they must not collide. */
      commercialClaimId: { type: String, trim: true },
      /* Set only on a successor raised through the explicit supersession
         path. The earlier request is never deleted, never rewritten and
         stays readable — this is the forward pointer that makes the pair
         legible rather than a replacement. */
      supersedesRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },
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

    // ── WHAT KIND OF ORDER THIS ACTUALLY IS ──────────────────────────────
    //
    // Added 31 Aug 2026, explicit request: the Manufacturing Order screens and
    // the Project Manager's notification both need to say "which type of order
    // it is whether it is for sampling order, genuine customer order or like
    // testing order".
    //
    // WHY A FIELD AND NOT AN INFERENCE. Before this, the only way to guess was
    // `isInternalOrder`, which is overloaded — it is set BOTH by a salesperson
    // marking a real customer's order as company-funded AND by the sampling
    // pipeline, so the two were indistinguishable downstream. Every screen that
    // wanted the distinction would have had to re-derive it from a different
    // combination of fields, and they would have drifted apart. One stored
    // value, written once at creation, is what makes the badge, the PM email
    // and the order PDF agree.
    //
    // `customer` is the default so every existing row keeps its current
    // meaning without a backfill — a real customer's order is what this
    // collection has always held.
    orderOrigin: {
      type: String,
      enum: ["customer", "sampling", "internal", "testing"],
      default: "customer",
      index: true,
    },

    // The in-house sample this order was raised from, when `orderOrigin` is
    // "sampling". SampleStyle already points here via
    // `production.customerRequestId`; this is the other half, so the MO screens
    // and the PM's email can name the style without a reverse lookup.
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SampleStyle",
      default: null,
      index: true,
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

/* ── ONE COMMERCIAL STATE, ONE CURRENT REQUEST — ENFORCED BY THE DATABASE ──
 * The proforma command used to read first and insert second. Between those
 * two statements sits every concurrent press, every retried tab and every
 * duplicated request a proxy makes: both callers read "nothing yet" and both
 * inserted. A guard in the browser closes the double-click and nothing else,
 * because it is not where two processes meet.
 *
 * This is where they meet. The claim is derived from the company, the enquiry
 * and the approved commercial figures, so two calls for the same state carry
 * the same string and the SECOND INSERT FAILS — whatever key, actor, tab or
 * process it came from. The loser then reads the winner's request and returns
 * it, so a caller gets the one durable document rather than a second one.
 *
 * PARTIAL, and deliberately: every request raised outside Cost & Invoicing
 * carries no claim, and a plain unique index would let exactly one of them
 * exist in the whole collection. */
customerRequestSchema.index(
  { "salesOrigin.commercialClaimId": 1 },
  { unique: true, partialFilterExpression: { "salesOrigin.commercialClaimId": { $type: "string" } } },
);

/* ── WHICH BACKFILL RUN GAVE THIS ORDER'S LINES THEIR NAMES ───────────────
   Present only on records whose lines predated permanent line references and
   were filled in by `scripts/backfill-customer-request-line-refs.js`. It is
   what makes that run reversible: the batch identity, who authorised it, and
   exactly which references it assigned. Absent on every record created since,
   because those lines were minted by the hook below as they were written. */
customerRequestSchema.add({
  lineRefBackfill: {
    batchId: { type: String, trim: true },
    at: { type: Date },
    authorizedBy: { type: String, trim: true },
    assigned: [{ type: String, trim: true }],
  },
});

/* ── EVERY ORDER LINE LEAVES HERE WITH A NAME ──────────────────────────────
   Sixteen writers across customer self-service, Sales, measurement
   conversion, sampling, return cloning and six quotation paths all persist
   through `.save()`, so this is the one place identity has to be handled. It
   mints only for lines that have none, which makes a filtered-and-reassigned
   array, an in-place quantity edit and a pushed line all behave correctly
   without any of those writers knowing this exists. */
customerRequestSchema.pre("validate", function ensureCustomerRequestLineIdentities(next) {
  try {
    ensureLineIdentities(this.items);
    /* An edit proposal's lines are a payload, not the record — they are given
       identities only if and when they are adopted onto `items`. */
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model("CustomerRequest", customerRequestSchema);
