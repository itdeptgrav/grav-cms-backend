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
const mongoose = require("mongoose");
const router = express.Router();
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

/* Lane A Chunk 3A — canonical company isolation. Every route below that
   names a companyId is checked against req.organization.tallyCompanyIds by
   one shared guard; see Middlewear/AccountantOrgAuthMiddleware.js. */
const accOrgAuth = require("../../Middlewear/AccountantOrgAuthMiddleware");
/* Resolved per request, not at module load. The guard has ONE implementation —
   `requireCompanyScope` in AccountantOrgAuthMiddleware.js — and this keeps it
   that way while still loading under the partial `jest.mock`s several suites
   use for that module. A mock that omits it fails loudly on the first request
   to a company-scoped route, which is the correct signal. */
const companyScope = (req, res, next) =>
  accOrgAuth.requireCompanyScope(req, res, next);
const companyScopeOptional = (req, res, next) =>
  accOrgAuth.scopeCompanyIfPresent(req, res, next);
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
/* A line the user typed by hand has no stock item behind it, and the form
   sends that as `stockItemId: ""`.

   Mongoose casts an empty string to ObjectId and throws, so the whole save
   died with:

     Acc_ProformaInvoice validation failed: items.1.stockItemId:
     Cast to ObjectId failed for value "" (type string)

   — a quotation with one free-text line could not be saved at all, and the
   message named a field the user has never heard of. An absent reference is
   `undefined`, not "", so that is what is stored. Done here rather than only
   in the browser because the same empty string arrives from the edit form,
   from a copied PI, and from anything else that posts to this route. */
const OPTIONAL_OBJECT_ID_FIELDS = ["stockItemId"];

function sanitiseItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((line) => {
    const out = { ...line };
    for (const f of OPTIONAL_OBJECT_ID_FIELDS) {
      const v = out[f];
      if (v === "" || v === null || v === "undefined" || v === "null") {
        delete out[f];
      }
    }
    return out;
  });
}

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
router.get("/", companyScope, async (req, res) => {
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

    let list = await Acc_ProformaInvoice.find(filter)
      .sort(sortSpec)
      .limit(parseInt(limit, 10))
      .lean();

    /* ── EVERY PROFORMA FINDS ITS OWN ORDER ──────────────────────────────
       Sales raises a PI; approving it is what creates the MO. So a proforma
       with no order behind it was never approved, and the list shows only
       the ones that have one — `?withOrder=all` shows the rest, because
       hiding a document the company really issued is worse than listing it.

       Nothing stores the relationship (the accounting proforma and the sales
       PI are different documents in different systems), so it is derived —
       and only ever from evidence that cannot mean anything else: the order
       number written on the proforma, or a buyer with exactly one order.
       A buyer with several and no reference is left unmatched rather than
       guessed at. See services/accounting/proformaOrderMatch.js.

       A proven match is WRITTEN BACK, so it is resolved once and is
       auditable afterwards rather than re-derived on every read. */
    const matchInfo = new Map();
    try {
      const { resolveOrderForProforma, isProvenMatch } =
        require("../../services/accounting/proformaOrderMatch");
      const m = require("../../models/Customer_Models/CustomerRequest");
      const Request = m.CustomerRequest || m;
      const Cust = require("../../models/Customer_Models/Customer");

      const unresolved = list.filter((pi) => !pi.customerRequestId);
      if (unresolved.length) {
        /* One pass for every buyer on the page rather than a query per PI. */
        const gstins = [...new Set(unresolved.map((p) => String(p.buyer?.gstin || "").trim().toUpperCase()).filter(Boolean))];
        const names = [...new Set(unresolved.map((p) => p.buyer?.name).filter(Boolean))];
        const customers = await Cust.find({
          $or: [
            ...(gstins.length ? [{ gstin: { $in: gstins } }] : []),
            ...(names.length ? [{ name: { $in: names } }] : []),
          ],
        }).select("name companyName gstin").lean();

        const custIds = customers.map((c) => c._id);
        const orders = custIds.length
          ? await Request.find({ customerId: { $in: custIds } })
              .select("requestId customerName customerId")
              .lean()
          : [];
        const ordersByCustomer = new Map();
        for (const o of orders) {
          const k = String(o.customerId);
          if (!ordersByCustomer.has(k)) ordersByCustomer.set(k, []);
          ordersByCustomer.get(k).push(o);
        }
        const custByGstin = new Map(customers.filter((c) => c.gstin)
          .map((c) => [String(c.gstin).trim().toUpperCase(), c]));
        const custByName = new Map(customers.map((c) => [String(c.name || "").trim(), c]));

        const writes = [];
        for (const pi of unresolved) {
          const cust =
            custByGstin.get(String(pi.buyer?.gstin || "").trim().toUpperCase()) ||
            custByName.get(String(pi.buyer?.name || "").trim());
          const candidates = cust ? (ordersByCustomer.get(String(cust._id)) || []) : [];
          const r = resolveOrderForProforma(pi, candidates);
          matchInfo.set(String(pi._id), r);
          if (isProvenMatch(r)) {
            pi.customerRequestId = r.orderId;
            pi.requestRef = r.requestRef;
            writes.push({
              updateOne: {
                filter: { _id: pi._id },
                update: { $set: { customerRequestId: r.orderId, requestRef: r.requestRef } },
              },
            });
          }
        }
        if (writes.length) await Acc_ProformaInvoice.bulkWrite(writes, { ordered: false });
      }
    } catch (e) {
      /* The list must still open if the manufacturing side is unavailable;
         nothing is matched, and every PI simply reads as unlinked. */
      console.error("[proforma list] order matching skipped:", e.message);
    }

    const withOrder = list.filter((pi) => pi.customerRequestId);
    const withoutOrder = list.length - withOrder.length;
    if (String(req.query.withOrder || "linked") !== "all") list = withOrder;
    list = list.map((pi) => ({
      ...pi,
      orderMatch: matchInfo.get(String(pi._id)) || (pi.customerRequestId ? { how: "stored" } : null),
    }));

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

    res.json({
      success: true,
      proformaInvoices: list,
      summary: counts,
      /* How many were left out for having no order. Named so the screen can
         say it rather than quietly showing a shorter list. */
      withoutOrder,
    });
  } catch (e) {
    console.error("[proforma list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// -----------------------------------------------------------------------------
// GET /:id — single PI with seller + bank info for the detail page / PDF
// -----------------------------------------------------------------------------
/* GET /next-number?companyId=&date= — the number the form previews. The new-PI
   page asked for it and it did not exist, so "next-number" fell into /:id and
   came back "not a valid id" (pageSweep, 7 Oct 2026). Same allocator the save
   uses (nextPINumber); it reserves nothing — save allocates again and a typed
   number is still checked for clashes. MUST stay above /:id. */
router.get("/next-number", companyScope, async (req, res) => {
  try {
    const companyId = req.companyId || req.query.companyId;
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const voucherNumber = await nextPINumber(companyId, computeFY(isNaN(date) ? new Date() : date));
    res.json({ success: true, voucherNumber });
  } catch (e) {
    console.error("[proforma-invoices/next-number]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get("/:id", companyScope, async (req, res) => {
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
// GET /:id/dispatch — what has been dispatched against this PI's order
// -----------------------------------------------------------------------------
// The accounts department bills what LEFT the factory, so this answers "what
// has gone out against this proforma" in billable terms: product, variant,
// quantity, the rate from the proforma's own line, and which challans say so.
// The packing detail (which carton, which wearer) is deliberately rolled up —
// see services/accounting/proformaDispatch.js.
//
// A PI with no linked order is not an error. It answers `linked: false` and
// the screen offers to link one, because most proformas predate the link.
// -----------------------------------------------------------------------------
router.get("/:id/dispatch", companyScope, async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id)
      .select("customerRequestId requestRef items companyId")
      .lean();
    if (!pi) return res.status(404).json({ success: false, message: "Not found" });

    /* Opened directly rather than through the list, so the match may not
       have been derived yet. Same rule, same proof, same write-back — see
       the list route. */
    let orderMatch = pi.customerRequestId ? { how: "stored" } : null;
    if (!pi.customerRequestId) {
      try {
        const { resolveOrderForProforma, isProvenMatch } =
          require("../../services/accounting/proformaOrderMatch");
        const m = require("../../models/Customer_Models/CustomerRequest");
        const Request = m.CustomerRequest || m;
        const Cust = require("../../models/Customer_Models/Customer");
        const gstin = String(pi.buyer?.gstin || "").trim().toUpperCase();
        const cust = await Cust.findOne({
          $or: [
            ...(gstin ? [{ gstin }] : []),
            ...(pi.buyer?.name ? [{ name: pi.buyer.name }] : []),
          ],
        }).select("_id").lean();
        const candidates = cust
          ? await Request.find({ customerId: cust._id })
              .select("requestId customerName customerId").lean()
          : [];
        const r = resolveOrderForProforma(pi, candidates);
        orderMatch = r;
        if (isProvenMatch(r)) {
          await Acc_ProformaInvoice.updateOne(
            { _id: pi._id },
            { $set: { customerRequestId: r.orderId, requestRef: r.requestRef } },
          );
          pi.customerRequestId = r.orderId;
          pi.requestRef = r.requestRef;
        }
      } catch (e) {
        console.error("[proforma dispatch] order matching skipped:", e.message);
      }
    }

    if (!pi.customerRequestId) {
      return res.json({
        success: true,
        linked: false,
        orderMatch,
        order: null,
        challans: [],
        lines: [],
        totals: { challanCount: 0, cartonCount: 0, units: 0, value: 0, productCount: 0, unpriced: 0 },
      });
    }

    /* Required lazily and guarded: the manufacturing models live in another
       part of the tree, and accounting must not fail to open a PI because a
       CMS model moved. */
    let DispatchChallan = null;
    let CustomerRequest = null;
    try {
      DispatchChallan = require("../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
      CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    } catch (e) {
      console.error("[proforma dispatch] manufacturing models unavailable:", e.message);
      return res.json({
        success: true,
        linked: true,
        unavailable: "The dispatch module is not available on this deployment.",
        order: { _id: String(pi.customerRequestId), requestId: pi.requestRef || "" },
        challans: [], lines: [],
        totals: { challanCount: 0, cartonCount: 0, units: 0, value: 0, productCount: 0, unpriced: 0 },
      });
    }

    const Challan = DispatchChallan.DispatchChallan || DispatchChallan;
    const Request = CustomerRequest.CustomerRequest || CustomerRequest;

    const [challans, order] = await Promise.all([
      Challan.find({ manufacturingOrderId: pi.customerRequestId })
        .sort({ createdAt: 1 })
        .lean(),
      Request.findById(pi.customerRequestId)
        .select("requestId customerName status customerInfo")
        .lean(),
    ]);

    /* WHICH OF THESE HAS ALREADY BEEN BILLED.
       The invoice carries the reference (Acc_Voucher.sourceChallans), so this
       is one query and there is no flag on the challan to fall out of step
       with it. A challan with an invoice is shown as spent and cannot be
       ticked again — billing a dispatch twice is the fault the link exists
       to stop. */
    const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
    const challanIds = challans.map((c) => c._id);
    const billed = challanIds.length
      ? await Acc_Voucher.find({
          companyId: pi.companyId,
          "sourceChallans.challanId": { $in: challanIds },
        })
          .select("voucherNumber voucherDate voucherType sourceChallans")
          .lean()
      : [];
    const invoiceByChallan = new Map();
    for (const v of billed) {
      for (const sc of v.sourceChallans || []) {
        invoiceByChallan.set(String(sc.challanId), {
          _id: String(v._id),
          voucherNumber: v.voucherNumber,
          voucherDate: v.voucherDate,
        });
      }
    }
    const withInvoice = challans.map((c) => ({
      ...c,
      invoice: invoiceByChallan.get(String(c._id)) || null,
    }));

    const { dispatchRollup } = require("../../services/accounting/proformaDispatch");
    /* The figures default to what is still BILLABLE, because that is the
       question the panel is open to answer. The challan list still shows
       every challan, billed or not, so nothing is hidden. */
    const billable = withInvoice.filter((c) => !c.invoice).map((c) => String(c._id));

    /* A SELECTION, when the caller names one (?challans=a,b,c).
       The invoice form asks with the challans the user ticked, so the lines
       and the totals it prefills are exactly what those challans dispatched —
       and the same guard runs here as on the screen, because a URL can be
       typed and the screen's check is a courtesy, not the rule. */
    const asked = String(req.query.challans || "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    let guard = null;
    let only = billable;
    if (asked.length) {
      const known = new Set(withInvoice.map((c) => String(c._id)));
      const unknown = asked.filter((id) => !known.has(id));
      const chosen = withInvoice.filter((c) => asked.includes(String(c._id)));
      const { selectionGuard } = require("../../services/accounting/proformaDispatch");
      guard = unknown.length
        ? { ok: false, reason: `Not a challan of this order: ${unknown.join(", ")}.`, customers: [], alreadyInvoiced: [] }
        : selectionGuard(chosen);
      only = chosen.map((c) => String(c._id));
    }

    const rolled = dispatchRollup(withInvoice, pi.items, { only });
    /* …and the full list, so the panel can show the spent ones too. */
    const { challanSummary } = require("../../services/accounting/proformaDispatch");
    rolled.challans = withInvoice.map(challanSummary);

    res.json({
      success: true,
      linked: true,
      order: order
        ? {
            _id: String(order._id),
            requestId: order.requestId || pi.requestRef || "",
            customerName: order.customerName || "",
            status: order.status || "",
          }
        : { _id: String(pi.customerRequestId), requestId: pi.requestRef || "", missing: true },
      /* Present only when a selection was asked for. `ok: false` means the
         caller must not raise an invoice from it — the reason is the
         sentence to show. */
      orderMatch,
      guard,
      selection: asked.length ? asked : null,
      billableChallanIds: billable,
      ...rolled,
    });
  } catch (e) {
    console.error("[proforma dispatch]", e);
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
router.post("/", companyScope, async (req, res) => {
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
    /* The form shows the next number and lets it be edited, so a number typed
       there is honoured; anything else falls back to the allocator. Checked
       against live PIs first — the unique index would otherwise surface a
       duplicate as a 500 with a raw mongo error. */
    let voucherNumber = String(body.voucherNumber || "").trim();
    if (voucherNumber) {
      const clash = await Acc_ProformaInvoice.findOne({
        companyId: body.companyId,
        financialYear: fyString,
        voucherNumber,
      })
        .select("_id")
        .lean();
      if (clash) {
        return res.status(409).json({
          success: false,
          message: `Proforma invoice "${voucherNumber}" already exists for ${fyString}. Pick a different number.`,
        });
      }
    } else {
      voucherNumber = await nextPINumber(body.companyId, fyString);
    }

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

    const totals = recomputeTotals(sanitiseItems(body.items), isInterState);

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
      /* The order this proforma is for, when the form linked one. Both are
         optional and both are stored: the id is the join to dispatch, the
         ref is what a list prints. */
      customerRequestId: body.customerRequestId || null,
      requestRef: body.requestRef || "",
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
router.put("/:id", companyScope, async (req, res) => {
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
      "customerRequestId",
      "requestRef",
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

      const totals = recomputeTotals(sanitiseItems(body.items), isInterState);
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

// -----------------------------------------------------------------------------
// PATCH /:id/order-link — point this PI at a manufacturing order (or clear it)
// -----------------------------------------------------------------------------
// Separate from PUT /:id on purpose. That route refuses an accepted or
// cancelled PI because it edits FIGURES, and rightly so — but an ACCEPTED
// proforma is precisely the one somebody bills a dispatch against, so
// requiring a revert-to-draft to record which order it belongs to would mean
// unwinding an acceptance to add a reference.
//
// This changes no amount, no tax and no line: it writes an id and the order's
// human number, and nothing downstream recomputes. Cancelled is still refused
// — a voided document should not grow new links.
// -----------------------------------------------------------------------------
router.patch("/:id/order-link", companyScope, async (req, res) => {
  try {
    const pi = await Acc_ProformaInvoice.findById(req.params.id);
    if (!pi) return res.status(404).json({ success: false, message: "Not found" });
    if (pi.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "This proforma is cancelled — it cannot be linked to an order.",
      });
    }

    const { customerRequestId = null, requestRef = "" } = req.body || {};

    if (customerRequestId) {
      if (!mongoose.Types.ObjectId.isValid(String(customerRequestId))) {
        return res.status(400).json({ success: false, message: "That is not a valid order id." });
      }
      /* Proved to exist before it is stored: a dangling id would show the
         panel an order that is not there and read as a dispatch failure. */
      let Request = null;
      try {
        const m = require("../../models/Customer_Models/CustomerRequest");
        Request = m.CustomerRequest || m;
      } catch { Request = null; }
      if (Request) {
        const order = await Request.findById(customerRequestId).select("requestId").lean();
        if (!order) {
          return res.status(404).json({ success: false, message: "That order no longer exists." });
        }
        pi.requestRef = String(requestRef || order.requestId || "").trim();
      } else {
        pi.requestRef = String(requestRef || "").trim();
      }
      pi.customerRequestId = customerRequestId;
    } else {
      pi.customerRequestId = null;
      pi.requestRef = "";
    }

    pi.updatedBy = req.user?.id;
    await pi.save();
    res.json({
      success: true,
      customerRequestId: pi.customerRequestId ? String(pi.customerRequestId) : null,
      requestRef: pi.requestRef || "",
    });
  } catch (e) {
    console.error("[proforma order-link]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

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
