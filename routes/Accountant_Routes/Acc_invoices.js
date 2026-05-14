// routes/Accountant_Routes/Acc_invoices.js
//
// INVOICES — AR-side view of posted sales vouchers.
//
// This module does NOT have its own collection. Instead it reads from
// the unified Acc_Voucher collection (voucherType: "sales") and
// enriches each invoice with:
//
//   • paymentStatus   — derived from receipt allocations + credit notes
//                       against this invoice ("paid" / "partial" /
//                       "unpaid" / "overdue")
//   • receivedAmount  — sum of receipts allocated against this invoice
//   • creditedAmount  — sum of CNs linked to this invoice
//   • outstanding     — grandTotal − received − credited
//   • ageInDays       — days since voucherDate (or dueDate when set)
//   • isOverdue       — true if dueDate is past AND outstanding > 0
//
// The Sales Vouchers page = accountant's transaction-entry view of
// these same documents. The Invoices page = AR officer's collection
// view of those documents with payment lifecycle focus.
//
// LEGACY NOTE: The previous version of this file imported a non-existent
// "AccountantModels" module and crashed at module-load. This new version
// is a clean rewrite using Acc_Voucher.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");
const {
  Acc_Settings,
} = require("../../models/Accountant_model/Acc_OperationalModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

router.use(accountantAuth);

/* ------------------------------------------------------------------ */
/* Helper: enrich a batch of invoices with payment lifecycle data      */
/* ------------------------------------------------------------------ */
async function enrichInvoices(invoices, companyId) {
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map((i) => i._id);
  const invoiceNumbers = invoices.map((i) => i.voucherNumber);

  // ── Tally credit notes linked to each invoice ──
  const cnAgg = await Acc_Voucher.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        voucherType: "credit_note",
        status: "posted",
        "originalInvoice.voucherId": { $in: invoiceIds },
      },
    },
    {
      $group: {
        _id: "$originalInvoice.voucherId",
        totalCredited: { $sum: "$grandTotal" },
        count: { $sum: 1 },
      },
    },
  ]);
  const creditedMap = new Map(
    cnAgg.map((c) => [
      String(c._id),
      {
        amount: c.totalCredited,
        count: c.count,
      },
    ]),
  );

  // ── Tally receipt allocations against each invoice (by voucherNumber
  //    in billAllocations.agst_ref) ──
  const receipts = await Acc_Voucher.find({
    companyId,
    voucherType: "receipt",
    status: "posted",
    "ledgerEntries.billAllocations.billName": { $in: invoiceNumbers },
  })
    .select("ledgerEntries")
    .lean();

  const receivedMap = new Map();
  for (const rcpt of receipts) {
    for (const entry of rcpt.ledgerEntries || []) {
      for (const alloc of entry.billAllocations || []) {
        if (alloc.billType === "agst_ref" && alloc.billName) {
          const inv = invoices.find((i) => i.voucherNumber === alloc.billName);
          if (inv) {
            const k = String(inv._id);
            const prev = receivedMap.get(k) || { amount: 0, count: 0 };
            receivedMap.set(k, {
              amount: prev.amount + (alloc.amount || 0),
              count: prev.count + 1,
            });
          }
        }
      }
    }
  }

  // ── Compute per-invoice status ──
  const today = new Date();
  return invoices.map((inv) => {
    const k = String(inv._id);
    const credited = creditedMap.get(k) || { amount: 0, count: 0 };
    const received = receivedMap.get(k) || { amount: 0, count: 0 };
    const outstanding = Math.max(
      0,
      (inv.grandTotal || 0) - credited.amount - received.amount,
    );
    const ageRef = inv.dueDate
      ? new Date(inv.dueDate)
      : new Date(inv.voucherDate);
    const ageInDays = Math.floor((today - ageRef) / 86400000);
    const isOverdue =
      inv.dueDate && outstanding > 0.01 && today > new Date(inv.dueDate);

    let paymentStatus;
    if (outstanding < 0.01) paymentStatus = "paid";
    else if (received.amount > 0.01 || credited.amount > 0.01)
      paymentStatus = "partial";
    else if (isOverdue) paymentStatus = "overdue";
    else paymentStatus = "unpaid";

    return {
      ...inv,
      paymentStatus,
      receivedAmount: received.amount,
      receiptCount: received.count,
      creditedAmount: credited.amount,
      creditNoteCount: credited.count,
      outstanding,
      ageInDays,
      isOverdue,
    };
  });
}

/* ------------------------------------------------------------------ */
/* GET / — list invoices with computed payment status                  */
/* ------------------------------------------------------------------ */
/* Query params:
 *   companyId       — required
 *   paymentStatus   — filter: paid / partial / unpaid / overdue
 *   customerId      — partyLedgerId filter
 *   dateFrom        — ISO date
 *   dateTo          — ISO date
 *   search          — voucherNumber / partyLedgerName / narration
 *   ageBucket       — "0-30" / "31-60" / "61-90" / "90+" (only overdue)
 *   page, limit
 *   sort            — default "-voucherDate"
 */
router.get("/", async (req, res) => {
  try {
    const {
      companyId,
      paymentStatus,
      customerId,
      dateFrom,
      dateTo,
      search,
      ageBucket,
      page = 1,
      limit = 50,
      sort = "-voucherDate",
    } = req.query;

    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    // Build base filter — always sales + posted (drafts don't show in AR)
    const filter = {
      companyId,
      voucherType: "sales",
      status: "posted",
    };
    if (customerId) filter.partyLedgerId = customerId;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) filter.voucherDate.$lte = new Date(dateTo);
    }
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { voucherNumber: rx },
        { partyLedgerName: rx },
        { narration: rx },
        { referenceNumber: rx },
      ];
    }

    // We compute paymentStatus/aging AFTER the DB query, since they
    // depend on data from other voucher types. Apply paymentStatus and
    // ageBucket filters post-enrich.
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Read more than needed and trim after enrich+filter, to keep the
    // post-filtered pagination reasonable. Cap at limit*5 or 500 max.
    const overFetchLimit = Math.min(500, parseInt(limit) * 5);

    const sortObj = {};
    const sortKey = sort.replace(/^-/, "");
    sortObj[sortKey] = sort.startsWith("-") ? -1 : 1;

    const raw = await Acc_Voucher.find(filter)
      .sort(sortObj)
      .skip(skip)
      .limit(overFetchLimit)
      .lean();

    const enriched = await enrichInvoices(raw, companyId);

    // Apply payment-status filter
    let filtered = enriched;
    if (paymentStatus) {
      filtered = filtered.filter((i) => i.paymentStatus === paymentStatus);
    }

    // Apply age-bucket filter (only meaningful for overdue / unpaid)
    if (ageBucket) {
      filtered = filtered.filter((i) => {
        if (!i.isOverdue && i.paymentStatus !== "unpaid") return false;
        const d = i.ageInDays;
        if (ageBucket === "0-30") return d >= 0 && d <= 30;
        if (ageBucket === "31-60") return d > 30 && d <= 60;
        if (ageBucket === "61-90") return d > 60 && d <= 90;
        if (ageBucket === "90+") return d > 90;
        return true;
      });
    }

    // Total count for pagination — accurate when no post-filter,
    // approximate otherwise (we tell the client this).
    const totalNoPostFilter = await Acc_Voucher.countDocuments(filter);
    const filteredAndTrimmed = filtered.slice(0, parseInt(limit));

    res.json({
      invoices: filteredAndTrimmed,
      total: totalNoPostFilter,
      filteredCount: filtered.length,
      page: parseInt(page),
      pages: Math.ceil(totalNoPostFilter / parseInt(limit)),
      hasPostFilter: !!(paymentStatus || ageBucket),
    });
  } catch (e) {
    console.error("[invoices]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /summary — receivables KPIs + aging breakdown                   */
/* ------------------------------------------------------------------ */
router.get("/summary", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    // Fetch ALL posted sales for this company. We need them all to
    // compute aggregates correctly. For very large datasets (10k+
    // invoices) this becomes slow; would need to move computation into
    // aggregation pipelines. For our scale this is fine.
    const raw = await Acc_Voucher.find({
      companyId,
      voucherType: "sales",
      status: "posted",
    })
      .select(
        "voucherNumber voucherDate dueDate grandTotal partyLedgerId partyLedgerName",
      )
      .limit(2000)
      .lean();

    const enriched = await enrichInvoices(raw, companyId);

    const summary = {
      totalInvoiced: 0,
      totalReceived: 0,
      totalCredited: 0,
      totalOutstanding: 0,
      counts: { paid: 0, partial: 0, unpaid: 0, overdue: 0 },
      aging: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
      byCustomer: new Map(),
    };

    for (const inv of enriched) {
      summary.totalInvoiced += inv.grandTotal || 0;
      summary.totalReceived += inv.receivedAmount || 0;
      summary.totalCredited += inv.creditedAmount || 0;
      summary.totalOutstanding += inv.outstanding || 0;
      summary.counts[inv.paymentStatus] =
        (summary.counts[inv.paymentStatus] || 0) + 1;

      if (inv.outstanding > 0.01) {
        const d = inv.ageInDays;
        if (d <= 30) summary.aging["0-30"] += inv.outstanding;
        else if (d <= 60) summary.aging["31-60"] += inv.outstanding;
        else if (d <= 90) summary.aging["61-90"] += inv.outstanding;
        else summary.aging["90+"] += inv.outstanding;

        const k = inv.partyLedgerName || "—";
        const prev = summary.byCustomer.get(k) || {
          outstanding: 0,
          count: 0,
          customerId: inv.partyLedgerId,
        };
        summary.byCustomer.set(k, {
          outstanding: prev.outstanding + inv.outstanding,
          count: prev.count + 1,
          customerId: prev.customerId,
        });
      }
    }

    const topCustomers = [...summary.byCustomer.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10);

    res.json({
      ...summary,
      byCustomer: undefined, // strip Map from response
      topCustomers,
    });
  } catch (e) {
    console.error("[invoices/summary]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /all — return ALL posted invoices + summary in one call.        */
/*                                                                     */
/* Designed for client-side filtering, sorting, and pagination. The    */
/* invoices page calls this once on initial load and never again       */
/* (unless the user clicks Refresh or logs a reminder). After that,    */
/* every state change (filter pills, status pills, period preset,      */
/* search, column-header sort, Next/Prev) is handled in-browser.       */
/*                                                                     */
/* Returns:                                                            */
/*   invoices  — every posted sales invoice for this company,          */
/*               enriched with paymentStatus, outstanding, ageInDays,  */
/*               receivedAmount, creditedAmount, etc.                  */
/*   summary   — the same KPI block the old /summary endpoint returns: */
/*               totalInvoiced / Received / Credited / Outstanding,    */
/*               counts by status, aging buckets, top customers.       */
/*                                                                     */
/* Same scale caveat as /summary: caps the fetch at 2000 invoices.     */
/* If you have more than that, the older Mongo-paginated / endpoint    */
/* is still available.                                                 */
/* ------------------------------------------------------------------ */
router.get("/all", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    // Fetch every posted sales voucher for this company. No filter, no
    // pagination — the frontend owns everything after this. Sort the
    // raw list by voucherDate desc so client-side default ordering
    // matches what /summary would have shown.
    const raw = await Acc_Voucher.find({
      companyId,
      voucherType: "sales",
      status: "posted",
    })
      .sort({ voucherDate: -1 })
      .limit(2000)
      .lean();

    const enriched = await enrichInvoices(raw, companyId);

    // Compute summary KPIs from the enriched set — mirrors the logic
    // in /summary so the frontend shape doesn't change.
    const summary = {
      totalInvoiced: 0,
      totalReceived: 0,
      totalCredited: 0,
      totalOutstanding: 0,
      counts: { paid: 0, partial: 0, unpaid: 0, overdue: 0 },
      aging: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
    };
    const byCustomer = new Map();

    for (const inv of enriched) {
      summary.totalInvoiced += inv.grandTotal || 0;
      summary.totalReceived += inv.receivedAmount || 0;
      summary.totalCredited += inv.creditedAmount || 0;
      summary.totalOutstanding += inv.outstanding || 0;
      summary.counts[inv.paymentStatus] =
        (summary.counts[inv.paymentStatus] || 0) + 1;

      if (inv.outstanding > 0.01) {
        const d = inv.ageInDays;
        if (d <= 30) summary.aging["0-30"] += inv.outstanding;
        else if (d <= 60) summary.aging["31-60"] += inv.outstanding;
        else if (d <= 90) summary.aging["61-90"] += inv.outstanding;
        else summary.aging["90+"] += inv.outstanding;

        const k = inv.partyLedgerName || "—";
        const prev = byCustomer.get(k) || {
          outstanding: 0,
          count: 0,
          customerId: inv.partyLedgerId,
        };
        byCustomer.set(k, {
          outstanding: prev.outstanding + inv.outstanding,
          count: prev.count + 1,
          customerId: prev.customerId,
        });
      }
    }

    const topCustomers = [...byCustomer.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10);

    res.json({
      invoices: enriched,
      summary: { ...summary, topCustomers },
    });
  } catch (e) {
    console.error("[invoices/all]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:id — single invoice with full bill trail                      */
/* ------------------------------------------------------------------ */
router.get("/:id", async (req, res) => {
  try {
    const inv = await Acc_Voucher.findOne({
      _id: req.params.id,
      voucherType: "sales",
    }).lean();
    if (!inv) return res.status(404).json({ error: "Acc_Invoice not found" });

    const [enriched] = await enrichInvoices([inv], inv.companyId);

    // Fetch (in parallel):
    //   • The seller Acc_Company doc — used as fallback for the seller
    //     block when Acc_Settings doesn't have a value.
    //   • The Acc_Settings singleton — this is where the visible
    //     Settings page (Organization / Address / Tax / Bank Accounts)
    //     persists its data. The PDF reads from settings FIRST (it's the
    //     accountant-controlled invoice identity), then falls back to
    //     the Acc_Company doc for anything not set there.
    const [company, settings] = await Promise.all([
      Acc_Company.findById(inv.companyId)
        .select("companyName address contact gstin pan cin tan")
        .lean(),
      Acc_Settings.findOne()
        .select(
          "companyName companyGSTIN companyPAN companyAddress companyPhone companyEmail bankAccounts invoiceTerms",
        )
        .lean(),
    ]);

    // The default bank account that prints on the invoice is whichever
    // entry in settings.bankAccounts[] has isDefault: true. If none has
    // the flag (shouldn't normally happen since the Settings UI marks
    // the first one default), we fall back to the first entry so the
    // PDF isn't empty when there's clearly a bank configured.
    const defaultBank =
      (settings?.bankAccounts || []).find((b) => b.isDefault) ||
      (settings?.bankAccounts || [])[0] ||
      null;

    // Also fetch the linked CNs and receipts for the trail
    const [linkedCNs, linkedReceipts] = await Promise.all([
      Acc_Voucher.find({
        companyId: inv.companyId,
        voucherType: "credit_note",
        status: "posted",
        "originalInvoice.voucherId": inv._id,
      })
        .select("voucherNumber voucherDate grandTotal creditNoteReason")
        .lean(),

      Acc_Voucher.find({
        companyId: inv.companyId,
        voucherType: "receipt",
        status: "posted",
        "ledgerEntries.billAllocations.billName": inv.voucherNumber,
      })
        .select(
          "voucherNumber voucherDate grandTotal paymentMode ledgerEntries",
        )
        .lean()
        .then((receipts) =>
          receipts.map((r) => {
            // Calculate the amount actually allocated to THIS invoice
            let allocated = 0;
            for (const entry of r.ledgerEntries || []) {
              for (const alloc of entry.billAllocations || []) {
                if (
                  alloc.billName === inv.voucherNumber &&
                  alloc.billType === "agst_ref"
                ) {
                  allocated += alloc.amount || 0;
                }
              }
            }
            // Strip the heavy ledgerEntries from response
            const { ledgerEntries, ...rest } = r;
            return { ...rest, allocatedToThisInvoice: allocated };
          }),
        ),
    ]);

    res.json({
      invoice: enriched,
      company,
      settings, // full Acc_Settings doc (singleton)
      defaultBank, // bankAccounts entry with isDefault:true (or first)
      linkedCreditNotes: linkedCNs,
      linkedReceipts,
    });
  } catch (e) {
    console.error("[invoices/:id]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:id/reminder — log a payment reminder                         */
/* ------------------------------------------------------------------ */
/* Records that a reminder was issued. Does NOT actually send anything
 * (that's a future integration with email/WhatsApp). Just an audit
 * trail accountants use during AR follow-up.
 *
 * Body: { channel, note }
 */
router.post("/:id/reminder", async (req, res) => {
  try {
    const { channel = "other", note = "" } = req.body || {};
    const inv = await Acc_Voucher.findOne({
      _id: req.params.id,
      voucherType: "sales",
    });
    if (!inv) return res.status(404).json({ error: "Acc_Invoice not found" });

    inv.reminderLog = inv.reminderLog || [];
    inv.reminderLog.push({
      sentAt: new Date(),
      sentBy: req.user?.id,
      sentByName: req.user?.name || req.user?.email || "Unknown",
      channel,
      note,
    });
    await inv.save();

    res.json({ success: true, reminderCount: inv.reminderLog.length });
  } catch (e) {
    console.error("[invoices/reminder]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
