// models/Accountant_model/Acc_ProformaInvoice.js
// =============================================================================
// PROFORMA INVOICE — pre-sale quotation document
// -----------------------------------------------------------------------------
// A proforma invoice (PI) is NOT a tax invoice. It does not post to any
// ledger, does not move stock, does not accrue GST liability, and is not
// included in GSTR-1. It's a price quotation in invoice format that the
// buyer uses to raise a PO, arrange funds, or open an LC.
//
// Differences from Acc_Voucher (sales):
//   • Stored in a separate collection (`proforma_invoices`)
//   • No `ledgerEntries`, no `status: posted` reconciliation impact
//   • No `paymentStatus` / `receivedAmount` / `outstanding` fields —
//     PIs don't carry receivables
//   • Has a "Consignee (Ship to)" block separate from "Buyer (Bill to)" —
//     covers the common case where goods ship to a warehouse and the
//     invoice goes to head office
//
// Numbering: PI/<FY-string>/<seq>. Same convention as your invoices
// (SL/<FY>/<seq>) and credit notes (CR/<FY>/<seq>), just with `PI` prefix.
// Sequence is per-company per-FY.
//
// Conversion to tax invoice is intentionally NOT modelled here — the user
// chose to keep them separate. If we add a "Convert to Acc_Invoice" feature
// later, it would create a new Acc_Voucher and back-link by saving the
// PI's _id in the invoice's `referenceNumber` field.
// =============================================================================

const mongoose = require("mongoose");

// -----------------------------------------------------------------------------
// Line item — same shape as invoice line items so the Sales Voucher form
// can be reused with minimal field-name mapping for the PI form.
// -----------------------------------------------------------------------------
const proformaLineSchema = new mongoose.Schema(
  {
    // Stock-item link (optional — PIs frequently have free-text descriptions
    // for items not yet in the catalog, e.g. custom orders).
    stockItemId: { type: mongoose.Schema.Types.ObjectId },
    stockItemName: { type: String, required: true, trim: true },
    description: { type: String, trim: true }, // free-text extras

    hsnCode: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, default: "Nos", trim: true },
    rate: { type: Number, required: true, min: 0 },

    // Discount: per-line, expressed as a percentage of (qty × rate).
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },

    // Computed and stored at save-time so the line totals don't drift
    // if rates change later.
    taxableAmount: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 }, // GST % for this line
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

// -----------------------------------------------------------------------------
// Address sub-doc — copied at PI-creation time (snapshot). If the buyer's
// address changes later, this PI still prints what was current when issued.
// -----------------------------------------------------------------------------
const partyAddressSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    addressLines: [{ type: String, trim: true }], // free-form, one per line
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    stateCode: { type: String, trim: true }, // GST state code, e.g. "21"
    pincode: { type: String, trim: true },
    country: { type: String, default: "India", trim: true },
    gstin: { type: String, trim: true },
  },
  { _id: false },
);

const proformaInvoiceSchema = new mongoose.Schema(
  {
    // Scope
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    // Numbering
    voucherNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    }, // e.g. "PI/2627/00001"
    financialYear: { type: String, required: true, index: true }, // "2026-27"

    // Dates
    voucherDate: { type: Date, required: true },
    validTill: { type: Date }, // PI expiry — buyer should accept by this date

    // Buyer (bill-to)
    buyer: { type: partyAddressSchema, required: true },

    // Consignee (ship-to) — defaults to buyer if user doesn't change it,
    // but stored independently so changes to one don't affect the other.
    consignee: { type: partyAddressSchema, required: true },

    // Optional party-ledger link — only set if the buyer exists as a
    // ledger in the CoA. PIs for prospects (not-yet-customers) won't
    // have this. We use it for "find PIs for customer X" lookups.
    partyLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Ledger",
    },

    // Free-form metadata that prints on the PDF
    buyersReference: { type: String, trim: true }, // their RFQ no.
    dispatchedThrough: { type: String, trim: true }, // courier / transporter
    destination: { type: String, trim: true },
    termsOfDelivery: { type: String, trim: true },
    paymentTerms: { type: String, trim: true }, // "Advance 50%, balance on delivery"
    otherReferences: { type: String, trim: true },

    // Line items
    items: { type: [proformaLineSchema], required: true },

    // GST detection — set at save time based on buyer.stateCode vs seller's
    // stateCode. Intra-state = CGST+SGST split; inter-state = IGST only.
    isInterState: { type: Boolean, default: false },

    // Totals — denormalised so the list view doesn't have to recompute
    subtotal: { type: Number, required: true, min: 0 },
    totalDiscount: { type: Number, default: 0, min: 0 },
    totalCgst: { type: Number, default: 0, min: 0 },
    totalSgst: { type: Number, default: 0, min: 0 },
    totalIgst: { type: Number, default: 0, min: 0 },
    totalTax: { type: Number, default: 0, min: 0 },
    roundOff: { type: Number, default: 0 }, // signed
    grandTotal: { type: Number, required: true, min: 0 },
    amountInWords: { type: String, trim: true }, // computed at save

    // Notes — internal vs printed
    narration: { type: String, trim: true }, // prints under "Other References"
    internalNotes: { type: String, trim: true }, // staff-only

    // Lifecycle
    // - draft: editable, not yet sent
    // - sent: shared with buyer, can still be edited if buyer pushes back
    // - accepted: buyer signalled acceptance (manual flag — no auto-detect)
    // - expired: validTill passed without acceptance
    // - cancelled: voided before acceptance
    status: {
      type: String,
      enum: ["draft", "sent", "accepted", "expired", "cancelled"],
      default: "draft",
      index: true,
    },

    // Free-form attachments (e.g. spec sheets the buyer asked for)
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // Audit
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
  },
  { timestamps: true, collection: "acc_proforma_invoices" },
);

// Compound uniqueness: voucherNumber is unique within (companyId, FY).
// Different companies + different FYs can have overlapping PI sequences.
proformaInvoiceSchema.index(
  { companyId: 1, financialYear: 1, voucherNumber: 1 },
  { unique: true },
);
proformaInvoiceSchema.index({ companyId: 1, voucherDate: -1 });
proformaInvoiceSchema.index({ companyId: 1, partyLedgerId: 1 });

const Acc_ProformaInvoice = mongoose.model(
  "Acc_ProformaInvoice",
  proformaInvoiceSchema,
);

module.exports = { Acc_ProformaInvoice };
