// routes/Accountant_Routes/Acc_proformaInvoices.js
// =============================================================================
// PROFORMA INVOICES — CRUD + status lifecycle
// -----------------------------------------------------------------------------
// PIs are standalone documents — no ledger posting, no GST filing impact.
// This file owns the entire lifecycle: create draft, edit, mark sent,
// mark accepted, mark cancelled, soft-expire when validTill passes.
//
// Numbering convention matches existing vouchers in the system:
//   PI/<FY-short>/<5-digit-seq>   e.g.  PI/2627/00001
// FY-short = lastTwo(startYear) + lastTwo(endYear), so FY 2026-27 → "2627".
// Sequence is per-company per-FY and is reset every April 1.
// =============================================================================

const express = require("express");
const router = express.Router();
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_ProformaInvoice,
} = require("../../models/Accountant_model/Acc_ProformaInvoice");
const {
  Acc_Company,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const {
  Acc_Settings,
} = require("../../models/Accountant_model/Acc_OperationalModels");

router.use(accountantAuth);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function computeFY(dateInput) {
  const d = new Date(dateInput);
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${fy}-${(fy + 1).toString().slice(2)}`;
}

function fyShortFromString(fy) {
  // "2026-27" → "2627"
  const [start, endShort] = fy.split("-");
  return `${start.slice(2)}${endShort}`;
}

// Allocate the next PI voucher number for a company in the given FY.
// Reads the latest existing PI for this (company, FY), parses the trailing
// digits, and increments. There's a unique index on (companyId, FY,
// voucherNumber) so two concurrent posts would result in one failing —
// in practice that's unlikely for PIs (low-volume document) but the
// guard exists.
async function nextPINumber(companyId, fyString) {
  const last = await Acc_ProformaInvoice.findOne({
    companyId,
    financialYear: fyString,
  })
    .sort({ createdAt: -1 })
    .select("voucherNumber")
    .lean();

  let seq = 1;
  if (last && last.voucherNumber) {
    const match = last.voucherNumber.match(/(\d+)$/);
    if (match) seq = parseInt(match[1], 10) + 1;
  }
  return `PI/${fyShortFromString(fyString)}/${seq.toString().padStart(5, "0")}`;
}

// Indian-numbering number-to-words. Duplicated from the PDF generator
// because the value gets stored on the PI doc at save time so the list
// view doesn't have to re-compute it.
function numberToINRWords(num) {
  if (num === null || num === undefined || isNaN(num)) return "Zero";
  const rupees = Math.floor(Math.abs(num));
  const paise = Math.round((Math.abs(num) - rupees) * 100);
  let result = rupeesToWords(rupees);
  if (paise > 0) result += ` and ${rupeesToWords(paise)} paise`;
  return result || "Zero";
}
function rupeesToWords(n) {
  if (n === 0) return "Zero";
  const a = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const b = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const twoDigit = (num) =>
    num < 20
      ? a[num]
      : b[Math.floor(num / 10)] + (num % 10 ? " " + a[num % 10] : "");
  const threeDigit = (num) => {
    const h = Math.floor(num / 100);
    const r = num % 100;
    return (
      (h ? a[h] + " Hundred" + (r ? " " : "") : "") + (r ? twoDigit(r) : "")
    );
  };
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thou = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  let out = "";
  if (crore) out += threeDigit(crore) + " Crore ";
  if (lakh) out += twoDigit(lakh) + " Lakh ";
  if (thou) out += twoDigit(thou) + " Thousand ";
  if (rest) out += threeDigit(rest);
  return out.trim();
}

// Recompute every line's tax + the document totals from scratch. Called on
// create AND on update so the stored numbers can't drift from the inputs.
function recomputeTotals(items, isInterState) {
  let subtotal = 0;
  let totalDiscount = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  const recomputedItems = items.map((line) => {
    const qty = Number(line.quantity || 0);
    const rate = Number(line.rate || 0);
    const discPct = Number(line.discountPercent || 0);
    const taxRate = Number(line.taxRate || 0);

    const grossLine = qty * rate;
    const discountAmount = (grossLine * discPct) / 100;
    const taxableAmount = grossLine - discountAmount;

    let cgst = 0,
      sgst = 0,
      igst = 0;
    if (isInterState) {
      igst = (taxableAmount * taxRate) / 100;
    } else {
      cgst = (taxableAmount * taxRate) / 200; // half
      sgst = (taxableAmount * taxRate) / 200;
    }
    const lineTotal = taxableAmount + cgst + sgst + igst;

    subtotal += taxableAmount;
    totalDiscount += discountAmount;
    totalCgst += cgst;
    totalSgst += sgst;
    totalIgst += igst;

    return {
      ...line,
      quantity: qty,
      rate,
      discountPercent: discPct,
      taxRate,
      taxableAmount: round2(taxableAmount),
      cgst: round2(cgst),
      sgst: round2(sgst),
      igst: round2(igst),
      lineTotal: round2(lineTotal),
    };
  });

  const totalTax = totalCgst + totalSgst + totalIgst;
  const preRound = subtotal + totalTax;
  const grandTotal = Math.round(preRound);
  const roundOff = round2(grandTotal - preRound);

  return {
    items: recomputedItems,
    subtotal: round2(subtotal),
    totalDiscount: round2(totalDiscount),
    totalCgst: round2(totalCgst),
    totalSgst: round2(totalSgst),
    totalIgst: round2(totalIgst),
    totalTax: round2(totalTax),
    roundOff,
    grandTotal,
    amountInWords: `INR ${numberToINRWords(grandTotal)} Only`,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------------------
// GET / — list with filters + pagination
// -----------------------------------------------------------------------------
// Query params:
//   companyId  — required (current company in switcher)
//   status     — optional filter: draft|sent|accepted|expired|cancelled
//   search     — voucherNumber / buyer.name match (case-insensitive)
//   from, to   — ISO date range on voucherDate
//   limit      — default 100
//   sort       — voucherDate-desc (default), voucherNumber-desc
// -----------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const {
      companyId,
      status,
      search,
      from,
      to,
      limit = 100,
      sort,
    } = req.query;
    if (!companyId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    }

    const filter = { companyId };
    if (status) filter.status = status;
    if (from || to) {
      filter.voucherDate = {};
      if (from) filter.voucherDate.$gte = new Date(from);
      if (to) filter.voucherDate.$lte = new Date(to);
    }
    if (search) {
      const rx = new RegExp(
        String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      filter.$or = [{ voucherNumber: rx }, { "buyer.name": rx }];
    }

    const sortSpec =
      sort === "voucherNumber-desc"
        ? { voucherNumber: -1 }
        : { voucherDate: -1, createdAt: -1 };

    const list = await Acc_ProformaInvoice.find(filter)
      .sort(sortSpec)
      .limit(parseInt(limit, 10))
      .lean();

    // KPI strip data — counts per status + total value of accepted PIs
    const counts = list.reduce(
      (acc, p) => {
        acc.total += 1;
        acc[p.status] = (acc[p.status] || 0) + 1;
        acc.totalValue += p.grandTotal || 0;
        if (p.status === "accepted") acc.acceptedValue += p.grandTotal || 0;
        return acc;
      },
      { total: 0, totalValue: 0, acceptedValue: 0 },
    );

    res.json({ success: true, proformaInvoices: list, summary: counts });
  } catch (e) {
    console.error("[proforma list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// GET /:id — single PI with seller + bank info for the detail page / PDF
// -----------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id).lean();
    if (!pi)
      return res.status(404).json({ success: false, message: "Not found" });

    // Mirror /invoices/:id: load Acc_Company + Acc_Settings so the
    // PDF can render the seller block with the same priority logic
    // (company wins, settings fallback).
    const [company, settings] = await Promise.all([
      Acc_Company.findById(pi.companyId)
        .select("companyName address contact gstin pan cin tan")
        .lean(),
      Acc_Settings.findOne()
        .select(
          "companyName companyGSTIN companyPAN companyAddress companyPhone companyEmail bankAccounts invoiceTerms",
        )
        .lean(),
    ]);

    const defaultBank =
      (settings?.bankAccounts || []).find((b) => b.isDefault) ||
      (settings?.bankAccounts || [])[0] ||
      null;

    res.json({
      success: true,
      proformaInvoice: pi,
      company,
      settings,
      defaultBank,
    });
  } catch (e) {
    console.error("[proforma get]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// POST / — create a new PI
// -----------------------------------------------------------------------------
// Required body fields:
//   companyId, voucherDate, buyer{name, gstin?, addressLines[], state, stateCode},
//   items[]
//
// Optional:
//   consignee (defaults to copy of buyer if omitted), validTill, partyLedgerId,
//   buyersReference, dispatchedThrough, destination, termsOfDelivery,
//   paymentTerms, otherReferences, narration, internalNotes
//
// Inter-state detection: compares buyer.stateCode against the seller
// company's address.stateCode. If they differ (and both are present),
// IGST applies; otherwise CGST+SGST split. If stateCode isn't set on
// either side, defaults to intra-state.
// -----------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.companyId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    }
    if (!body.buyer || !body.buyer.name) {
      return res
        .status(400)
        .json({ success: false, message: "buyer.name required" });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one line item required" });
    }

    const company = await Acc_Company.findById(body.companyId).lean();
    if (!company) {
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    }

    const voucherDate = body.voucherDate
      ? new Date(body.voucherDate)
      : new Date();
    const fyString = computeFY(voucherDate);
    const voucherNumber = await nextPINumber(body.companyId, fyString);

    // Inter-state detection. If either side is missing stateCode, fall
    // back to intra-state (CGST+SGST) — conservative since IGST when
    // intra-state would be a real billing error.
    //
    // The Boolean() wrap is load-bearing: JavaScript's && returns the
    // last truthy operand or the first falsy one. If sellerStateCode
    // is "", the expression evaluates to "" (empty string), not false.
    // Mongoose's Boolean schema then rejects that with a CastError.
    const sellerStateCode = company.address?.stateCode || "";
    const buyerStateCode = body.buyer.stateCode || "";
    const isInterState = Boolean(
      sellerStateCode && buyerStateCode && sellerStateCode !== buyerStateCode,
    );

    const totals = recomputeTotals(body.items, isInterState);

    // Consignee defaults to a clone of buyer when omitted — most PIs go
    // to the same place that gets billed.
    const consignee =
      body.consignee && body.consignee.name
        ? body.consignee
        : { ...body.buyer };

    const pi = await Acc_ProformaInvoice.create({
      companyId: body.companyId,
      voucherNumber,
      financialYear: fyString,
      voucherDate,
      validTill: body.validTill ? new Date(body.validTill) : undefined,
      buyer: body.buyer,
      consignee,
      partyLedgerId: body.partyLedgerId || undefined,
      buyersReference: body.buyersReference,
      dispatchedThrough: body.dispatchedThrough,
      destination: body.destination,
      termsOfDelivery: body.termsOfDelivery,
      paymentTerms: body.paymentTerms,
      otherReferences: body.otherReferences,
      isInterState,
      narration: body.narration,
      internalNotes: body.internalNotes,
      status: body.status || "draft",
      createdBy: req.user?.id,
      ...totals,
    });

    res.status(201).json({ success: true, proformaInvoice: pi });
  } catch (e) {
    console.error("[proforma create]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// PUT /:id — update a draft/sent PI
// -----------------------------------------------------------------------------
// Status-gated: cannot edit a PI in `accepted` or `cancelled` state
// (those are terminal and edits would be ambiguous re: what the buyer
// agreed to). To edit an accepted PI, the user must explicitly revert
// it to `draft` via PATCH /:id/status first.
// -----------------------------------------------------------------------------
router.put("/:id", async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id);
    if (!pi)
      return res.status(404).json({ success: false, message: "Not found" });

    if (pi.status === "accepted" || pi.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: `PI is ${pi.status} — revert to draft before editing.`,
      });
    }

    const body = req.body || {};

    // Allow updating most fields; never let the client change companyId,
    // voucherNumber, financialYear, or createdBy.
    const editable = [
      "voucherDate",
      "validTill",
      "buyer",
      "consignee",
      "partyLedgerId",
      "buyersReference",
      "dispatchedThrough",
      "destination",
      "termsOfDelivery",
      "paymentTerms",
      "otherReferences",
      "narration",
      "internalNotes",
    ];
    for (const key of editable) {
      if (body[key] !== undefined) pi[key] = body[key];
    }

    if (Array.isArray(body.items)) {
      // Detect inter-state freshly in case buyer state changed.
      // Boolean() coercion explanation: see the matching block in the
      // POST handler above.
      const company = await Acc_Company.findById(pi.companyId).lean();
      const sellerStateCode = company?.address?.stateCode || "";
      const buyerStateCode = pi.buyer?.stateCode || "";
      const isInterState = Boolean(
        sellerStateCode && buyerStateCode && sellerStateCode !== buyerStateCode,
      );
      pi.isInterState = isInterState;

      const totals = recomputeTotals(body.items, isInterState);
      Object.assign(pi, totals);
    }

    pi.updatedBy = req.user?.id;
    await pi.save();
    res.json({ success: true, proformaInvoice: pi });
  } catch (e) {
    console.error("[proforma update]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// PATCH /:id/status — transition the PI through its lifecycle
// -----------------------------------------------------------------------------
// Valid transitions:
//   draft  → sent | cancelled
//   sent   → accepted | cancelled | draft (e.g. buyer asked for revision)
//   accepted → draft (rare — revoke acceptance to edit)
//   expired → draft (re-quote with new validTill)
//   cancelled → (terminal — no further transitions)
// -----------------------------------------------------------------------------
const VALID_TRANSITIONS = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "cancelled", "draft"],
  accepted: ["draft"],
  expired: ["draft"],
  cancelled: [],
};

router.patch("/:id/status", async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id);
    if (!pi)
      return res.status(404).json({ success: false, message: "Not found" });

    const next = req.body?.status;
    if (!next) {
      return res
        .status(400)
        .json({ success: false, message: "status required" });
    }

    const allowed = VALID_TRANSITIONS[pi.status] || [];
    if (!allowed.includes(next)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition ${pi.status} → ${next}. Allowed: ${allowed.join(", ") || "(none)"}`,
      });
    }

    pi.status = next;
    pi.updatedBy = req.user?.id;
    await pi.save();
    res.json({ success: true, proformaInvoice: pi });
  } catch (e) {
    console.error("[proforma status]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// DELETE /:id — hard delete (drafts only)
// -----------------------------------------------------------------------------
// PIs in any state other than `draft` are NOT deletable — once a PI has
// been sent to a buyer, it's an audit-trail item even if cancelled.
// Use PATCH /:id/status with `cancelled` instead.
// -----------------------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id);
    if (!pi)
      return res.status(404).json({ success: false, message: "Not found" });

    if (pi.status !== "draft") {
      return res.status(400).json({
        success: false,
        message:
          "Only drafts can be deleted. Use status → cancelled for non-drafts.",
      });
    }
    await pi.deleteOne();
    res.json({ success: true });
  } catch (e) {
    console.error("[proforma delete]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
