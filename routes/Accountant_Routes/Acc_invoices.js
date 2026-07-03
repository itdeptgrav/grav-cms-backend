// routes/Accountant_Routes/Acc_invoices.js
//
// INVOICES — AR-side view of posted sales vouchers.
//
// This module does NOT have its own collection. Instead it reads from
// the unified Acc_Voucher collection (voucherType: "sales") and
// enriches each invoice with payment lifecycle data.
//
// ─── ADDITIONS (everything else is identical to the original) ────────────────
// GET  /next-number      — next invoice number from Settings prefix
//                          format: {prefix}/{4-digit-seq}/{FY-short-dash}
//                          e.g. RC/0016/26-27
// PUT  /:id              — edit a draft or posted invoice; handles ledger
//                          balance reversal + reapplication in a transaction
// PATCH/:id/status       — cancel (reverses balances) or void (does not)
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
  Acc_Ledger, // ← added for applyLedgerBalances
  Acc_Group, // ← added so edits can resolve/create ledgers by name (parity with create)
} = require("../../models/Accountant_model/Acc_MasterModels");
const {
  Acc_Settings,
} = require("../../models/Accountant_model/Acc_OperationalModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

router.use(accountantAuth);

/* ================================================================== */
/* DIAGNOSTIC — inspect what's actually stored for an invoice.         */
/* Visit: /api/accountant/invoices/:id/debug-dispatch                  */
/* Remove after debugging. Shows whether dispatchDetails is persisted. */
/* MUST be before "/:id" so Express doesn't treat the suffix as an id. */
/* ================================================================== */
router.get("/:id/debug-dispatch", async (req, res) => {
  try {
    const inv = await Acc_Voucher.findById(req.params.id).lean();
    if (!inv) return res.status(404).json({ error: "Not found" });
    res.json({
      voucherNumber: inv.voucherNumber,
      status: inv.status,
      hasDispatchDetailsField: Object.prototype.hasOwnProperty.call(
        inv,
        "dispatchDetails",
      ),
      dispatchDetails: inv.dispatchDetails || null,
      // legacy flat fields, in case anything wrote there instead
      flat: {
        dispatchDocNumber: inv.dispatchDocNumber ?? null,
        deliveryNote: inv.deliveryNote ?? null,
        dispatchedThrough: inv.dispatchedThrough ?? null,
        destination: inv.destination ?? null,
        buyersOrderNumber: inv.buyersOrderNumber ?? null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================================================================== */
/* NEW HELPERS (used only by the three new routes below)              */
/* ================================================================== */

function _computeFY(date) {
  const d = new Date(date);
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${fy}-${(fy + 1).toString().slice(2)}`;
}
function _fyShortDash(date) {
  const d = new Date(date);
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${fy.toString().slice(2)}-${(fy + 1).toString().slice(2)}`;
}
function _fyShortNoDash(date) {
  const d = new Date(date);
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${fy.toString().slice(2)}${(fy + 1).toString().slice(2)}`;
}
function _esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Next invoice number: reads Settings.numbering.invoicePrefix, scans all
// vouchers that share the prefix, returns max_seq+1 in the new format.
async function _nextInvoiceNum(companyId, voucherDate) {
  const st = await Acc_Settings.findOne()
    .select("numbering invoicePrefix invoiceStartNumber")
    .lean();
  const pfx = st?.numbering?.invoicePrefix || st?.invoicePrefix || "SL";

  // ── FY suffix: use the settings override if the accountant has set one,
  //    otherwise auto-derive from the invoice date. This lets the accountant
  //    manually switch to "27-28" before April, or correct a wrong FY without
  //    touching the code.
  const fyDash = (() => {
    const override = (st?.numbering?.fyOverride || "").trim();
    if (override) {
      // Normalise: accept "2627" → "26-27" as well as the canonical "26-27"
      if (/^\d{4}$/.test(override)) {
        return `${override.slice(0, 2)}-${override.slice(2)}`;
      }
      return override; // already "26-27" format
    }
    return _fyShortDash(voucherDate);
  })();
  const fyNoDash = fyDash.replace("-", "");

  const pe = _esc(pfx);
  const re1 = new RegExp(`^${pe}/(\\d+)/${_esc(fyDash)}$`);
  const re2 = new RegExp(`^${pe}/${fyNoDash}/(\\d+)$`);

  const rows = await Acc_Voucher.find({
    companyId,
    voucherNumber: { $regex: `^${pe}/` },
  })
    .select("voucherNumber")
    .lean();

  let maxSeq = 0;
  for (const r of rows) {
    const n = r.voucherNumber || "";
    const m1 = n.match(re1);
    if (m1) {
      maxSeq = Math.max(maxSeq, parseInt(m1[1], 10));
      continue;
    }
    const m2 = n.match(re2);
    if (m2) {
      maxSeq = Math.max(maxSeq, parseInt(m2[1], 10));
    }
  }
  // respect manual floor from settings
  const floor =
    (st?.numbering?.invoiceNextNum || st?.invoiceStartNumber || 1) - 1;
  maxSeq = Math.max(maxSeq, floor);

  return `${pfx}/${(maxSeq + 1).toString().padStart(4, "0")}/${fyDash}`;
}

// Apply / reverse ledger balances. direction = +1 post, -1 reverse.
async function _applyLedgerBalances(voucher, direction, session) {
  const ops = [];
  for (const entry of voucher.ledgerEntries || []) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const delta = (entry.signedAmount || 0) * direction;
    ops.push({
      updateOne: {
        filter: { _id: lid },
        update: { $inc: { currentBalance: delta } },
      },
    });
  }
  if (ops.length) {
    await Acc_Ledger.bulkWrite(ops, session ? { session } : {});
    for (const entry of voucher.ledgerEntries || []) {
      const lid = entry.ledgerId || entry.ledger;
      if (!lid) continue;
      const led = await Acc_Ledger.findById(lid).session(session || null);
      if (led) {
        led.balanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
        await led.save(session ? { session } : {});
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Resolve a ledger entry's name → an existing ledger, auto-creating it */
/* if it truly doesn't exist yet. Mirrors the create path in            */
/* Acc_vouchers.js so an EDITED invoice resolves/creates ledgers the    */
/* exact same way a NEW one does — otherwise a name-only line (e.g. a    */
/* "Round Off" or an as-yet-unmatched GST band) would be written to the */
/* voucher with no ledgerId and then silently skipped by the rebalance, */
/* leaving the edit out of the ledgers and the Balance Sheet.           */
/* ------------------------------------------------------------------ */
async function _resolveOrCreateByName(name, companyId, createdBy, session) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  let led = await Acc_Ledger.findOne({
    companyId,
    name: new RegExp(`^${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).session(session || null);
  if (led) return led;

  // Pick a sensible parent group: prefer Indirect Expenses (where Round Off
  // lives), then any expense-natured group, then anything for the company.
  const grp =
    (await Acc_Group.findOne({ companyId, name: /indirect expense/i }).session(
      session || null,
    )) ||
    (await Acc_Group.findOne({ companyId, nature: "expense" }).session(
      session || null,
    )) ||
    (await Acc_Group.findOne({ companyId }).session(session || null));
  if (!grp) return null;

  const created = await Acc_Ledger.create(
    [
      {
        companyId,
        name: clean,
        groupId: grp._id,
        groupName: grp.name,
        openingBalance: 0,
        openingBalanceType: "Dr",
        currentBalance: 0,
        sourceSystem: "auto_from_voucher",
        createdBy,
      },
    ],
    { session },
  );
  return created[0];
}

/* ================================================================== */
/* NEW ROUTE 1: GET /next-number                                       */
/* ================================================================== */
// MUST be before /:id routes so "next-number" isn't treated as an id.
router.get("/next-number", async (req, res) => {
  try {
    const { companyId, date } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const voucherNumber = await _nextInvoiceNum(
      companyId,
      date ? new Date(date) : new Date(),
    );
    res.json({ voucherNumber });
  } catch (e) {
    console.error("[invoices/next-number]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ================================================================== */
/* ORIGINAL HELPERS (unchanged)                                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Helper: enrich a batch of invoices with payment lifecycle data      */
/* ------------------------------------------------------------------ */
async function enrichInvoices(invoices, companyId) {
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map((i) => i._id);
  const invoiceNumbers = invoices.map((i) => i.voucherNumber);

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
      { amount: c.totalCredited, count: c.count },
    ]),
  );

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

/* ================================================================== */
/* ORIGINAL ROUTES (completely unchanged)                             */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* GET / — list invoices                                               */
/* ------------------------------------------------------------------ */
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

    const filter = { companyId, voucherType: "sales", status: "posted" };
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

    const skip = (parseInt(page) - 1) * parseInt(limit);
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

    let filtered = enriched;
    if (paymentStatus)
      filtered = filtered.filter((i) => i.paymentStatus === paymentStatus);
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

    const totalNoPostFilter = await Acc_Voucher.countDocuments(filter);
    res.json({
      invoices: filtered.slice(0, parseInt(limit)),
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
/* GET /summary                                                        */
/* ------------------------------------------------------------------ */
router.get("/summary", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

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
        const k = inv.partyLedgerName || "";
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
    res.json({ ...summary, byCustomer: undefined, topCustomers });
  } catch (e) {
    console.error("[invoices/summary]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /all                                                            */
/* ------------------------------------------------------------------ */
router.get("/all", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const raw = await Acc_Voucher.find({
      companyId,
      voucherType: "sales",
      status: "posted",
    })
      .sort({ voucherDate: -1 })
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
        const k = inv.partyLedgerName || "";
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
    res.json({ invoices: enriched, summary: { ...summary, topCustomers } });
  } catch (e) {
    console.error("[invoices/all]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:id/download-pdf — Tally-format Tax Invoice PDF                */
/* ------------------------------------------------------------------ */
/* MUST be before /:id so Express doesn't treat "download-pdf" as an id */
router.get("/:id/download-pdf", async (req, res) => {
  try {
    const PDFDocument = require("pdfkit");

    const inv = await Acc_Voucher.findById(req.params.id).lean();
    if (!inv) return res.status(404).json({ error: "Invoice not found" });

    // Company + Settings (same as /:id detail)
    const [co, settings] = await Promise.all([
      Acc_Company.findById(inv.companyId)
        .select(
          "companyName address contact gstin pan cin tan declaration bankDetails",
        )
        .lean(),
      Acc_Settings.findOne()
        .select(
          "companyName companyGSTIN companyPAN companyAddress companyPhone companyEmail bankAccounts invoiceTerms companyLogo companyStamp signature declaration",
        )
        .lean(),
    ]);

    const companyName =
      settings?.companyName ||
      co?.companyName ||
      "GRAV CLOTHING OPC PRIVATE LIMITED";
    const gstin = settings?.companyGSTIN || co?.gstin || "";
    const pan = settings?.companyPAN || co?.pan || "";
    const stateName = co?.address?.state || "Odisha";
    const stateCode = co?.address?.stateCode || "21";
    const address = co?.address
      ? [
          co.address.street,
          co.address.line1,
          co.address.city,
          co.address.state,
          co.address.pincode,
        ]
          .filter(Boolean)
          .join(", ")
      : settings?.companyAddress || "";
    const contactPhone = settings?.companyPhone || co?.contact?.phone || "";
    const declaration =
      settings?.declaration ||
      co?.declaration ||
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";
    const defaultBank =
      (settings?.bankAccounts || []).find((b) => b.isDefault) ||
      (settings?.bankAccounts || [])[0] ||
      co?.bankDetails ||
      null;
    const logoBase64 =
      settings?.companyLogo ||
      process.env.NEXT_PUBLIC_COMPANY_LOGO_BASE64 ||
      process.env.COMPANY_LOGO_BASE64 ||
      "";
    const stampBase64 =
      settings?.companyStamp ||
      settings?.signature ||
      process.env.NEXT_PUBLIC_COMPANY_SIGNATURE_BASE64 ||
      process.env.COMPANY_SIGNATURE_BASE64 ||
      "";

    const lines = inv.inventoryEntries || [];
    const cgst = inv.gstBreakup?.cgst || 0;
    const sgst = inv.gstBreakup?.sgst || 0;
    const igst = inv.gstBreakup?.igst || 0;
    const isInter = igst > 0;
    const subtotal = inv.subtotal || 0;
    const totalTax = cgst + sgst + igst;
    const grandTotal = inv.grandTotal || 0;
    const roundOff = inv.roundOff || 0;

    // HSN summary
    const taxMap = new Map();
    for (const ln of lines) {
      const hsn = ln.hsnCode || "";
      const rate = ln.taxRate || 0;
      const key = `${hsn}::${rate}`;
      const taxable = ln.amount || 0;
      const tax = ln.taxAmount || (taxable * rate) / 100;
      const prev = taxMap.get(key) || { hsn, rate, taxable: 0, tax: 0 };
      taxMap.set(key, {
        hsn,
        rate,
        taxable: prev.taxable + taxable,
        tax: prev.tax + tax,
      });
    }
    const hsnRows = Array.from(taxMap.values());

    // ── Build PDF ──
    const doc = new PDFDocument({ size: "A4", margin: 30 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Invoice-${(inv.voucherNumber || "").replace(/\//g, "-")}.pdf`,
    );
    doc.pipe(res);

    const W = 535,
      L = 30;
    let y = 30;
    const box = (x, by, w, h) => doc.rect(x, by, w, h).stroke();
    const hline = (x1, ly, x2) => doc.moveTo(x1, ly).lineTo(x2, ly).stroke();
    const vline = (x, y1, y2) => doc.moveTo(x, y1).lineTo(x, y2).stroke();
    doc.lineWidth(0.5).strokeColor("#000");

    const fN = (n, d = 2) =>
      Number(n || 0).toLocaleString("en-IN", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
    const fmtDt = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      const m = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return `${dt.getDate()}-${m[dt.getMonth()]}-${dt.getFullYear()}`;
    };

    // ─── Title ───
    box(L, y, W, 20);
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .fillColor("#000")
      .text("Tax Invoice", L, y + 4, { width: W, align: "center" });
    y += 20;

    // ─── Seller + Meta Grid ───
    const sellerH = 72;
    box(L, y, W, sellerH);
    vline(L + W * 0.5, y, y + sellerH);
    vline(L + W * 0.75, y, y + sellerH);
    const cellH = sellerH / 4;
    for (let i = 1; i < 4; i++) hline(L + W * 0.5, y + cellH * i, L + W);

    // Logo + seller
    let sy = y + 3;
    if (logoBase64) {
      try {
        const buf = Buffer.from(
          logoBase64.replace(/^data:image\/\w+;base64,/, ""),
          "base64",
        );
        doc.image(buf, L + 3, sy, { width: 28, height: 28 });
        doc
          .fontSize(11)
          .font("Helvetica-Bold")
          .text(companyName, L + 34, sy, { width: W * 0.5 - 40 });
      } catch (_) {
        doc
          .fontSize(11)
          .font("Helvetica-Bold")
          .text(companyName, L + 3, sy, { width: W * 0.5 - 8 });
      }
    } else {
      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(companyName, L + 3, sy, { width: W * 0.5 - 8 });
    }
    sy = y + 18;
    doc.fontSize(7).font("Helvetica").fillColor("#000");
    if (address) {
      doc.text(address, L + 3, sy, { width: W * 0.5 - 8 });
      sy += 9;
    }
    if (gstin) {
      doc.text(`GSTIN/UIN: ${gstin}`, L + 3, sy);
      sy += 8;
    }
    if (pan) {
      doc.text(`PAN: ${pan}`, L + 3, sy);
      sy += 8;
    }
    doc.text(`State Name: ${stateName}, Code: ${stateCode}`, L + 3, sy);
    sy += 8;
    if (contactPhone) {
      doc.text(`Contact: ${contactPhone}`, L + 3, sy);
    }

    // Meta cells
    const rx1 = L + W * 0.5,
      rx2 = L + W * 0.75,
      rw = W * 0.25;
    const mc = (x, ry, label, value) => {
      doc
        .fontSize(6)
        .font("Helvetica")
        .fillColor("#666")
        .text(label, x + 2, ry + 1, { width: rw - 4 });
      if (value)
        doc
          .fontSize(8)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(value, x + 2, ry + 9, { width: rw - 4 });
    };
    const dd = inv.dispatchDetails || {};
    mc(rx1, y, "Invoice No.", inv.voucherNumber);
    mc(rx2, y, "Dated", fmtDt(inv.voucherDate));
    mc(
      rx1,
      y + cellH,
      "Delivery Note",
      dd.deliveryNoteNumbers || inv.deliveryNote || "",
    );
    mc(
      rx2,
      y + cellH,
      "Mode/Terms of Payment",
      inv.paymentTerms || dd.termsOfDelivery || "",
    );
    mc(
      rx1,
      y + cellH * 2,
      "Buyer's Order No.",
      dd.buyersOrderNumber || inv.buyersOrderNumber || "",
    );
    mc(
      rx2,
      y + cellH * 2,
      "Dated",
      dd.buyersOrderDate ? fmtDt(dd.buyersOrderDate) : "",
    );
    mc(
      rx1,
      y + cellH * 3,
      "Dispatch Doc No.",
      dd.dispatchDocNumber || inv.dispatchDocNumber || "",
    );
    mc(
      rx2,
      y + cellH * 3,
      "Delivery Note Date",
      dd.deliveryNoteDate ? fmtDt(dd.deliveryNoteDate) : "",
    );
    y += sellerH;

    // ─── Consignee ───
    const consH = 36;
    box(L, y, W, consH);
    vline(L + W * 0.5, y, y + consH);
    vline(L + W * 0.75, y, y + consH);
    doc
      .fontSize(6)
      .font("Helvetica")
      .fillColor("#666")
      .text("Consignee (Ship to)", L + 2, y + 1);
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#000")
      .text(inv.partyLedgerName || "", L + 2, y + 9, { width: W * 0.5 - 6 });
    if (inv.partyGstin)
      doc
        .fontSize(7)
        .font("Helvetica")
        .text(`GSTIN/UIN: ${inv.partyGstin}`, L + 2, y + 19);
    if (inv.placeOfSupply)
      doc
        .fontSize(7)
        .text(
          `State Name: ${inv.placeOfSupply}${inv.placeOfSupplyCode ? `, Code: ${inv.placeOfSupplyCode}` : ""}`,
          L + 2,
          y + 27,
        );
    mc(
      rx1,
      y,
      "Dispatched through",
      dd.dispatchedThrough || inv.dispatchedThrough || "",
    );
    mc(rx2, y, "Destination", dd.destination || inv.destination || "");
    y += consH;

    // ─── Buyer ───
    const buyH = 36;
    box(L, y, W, buyH);
    vline(L + W * 0.5, y, y + buyH);
    doc
      .fontSize(6)
      .font("Helvetica")
      .fillColor("#666")
      .text("Buyer (Bill to)", L + 2, y + 1);
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#000")
      .text(inv.partyLedgerName || "", L + 2, y + 9, { width: W * 0.5 - 6 });
    if (inv.partyGstin)
      doc
        .fontSize(7)
        .font("Helvetica")
        .text(`GSTIN/UIN: ${inv.partyGstin}`, L + 2, y + 19);
    if (inv.placeOfSupply)
      doc
        .fontSize(7)
        .text(
          `State Name: ${inv.placeOfSupply}${inv.placeOfSupplyCode ? `, Code: ${inv.placeOfSupplyCode}` : ""}`,
          L + 2,
          y + 27,
        );
    doc
      .fontSize(6)
      .font("Helvetica")
      .fillColor("#666")
      .text("Terms of Delivery", rx1 + 2, y + 1);
    // Carrier / LR-RR / vehicle details + terms of delivery text, stacked in
    // the right half of the buyer row (mirrors Tally's layout).
    {
      const transportBits = [];
      if (dd.carrierName) transportBits.push(`Carrier: ${dd.carrierName}`);
      if (dd.billOfLadingNumber)
        transportBits.push(`LR/RR: ${dd.billOfLadingNumber}`);
      if (dd.motorVehicleNumber)
        transportBits.push(`Vehicle: ${dd.motorVehicleNumber}`);
      if (dd.dispatchDate)
        transportBits.push(`Date: ${fmtDt(dd.dispatchDate)}`);
      const termsText = dd.termsOfDelivery || inv.termsOfDelivery || "";
      const rightLines = [];
      if (termsText) rightLines.push(termsText);
      if (transportBits.length) rightLines.push(transportBits.join("  ·  "));
      if (rightLines.length)
        doc
          .fontSize(7)
          .font("Helvetica")
          .fillColor("#000")
          .text(rightLines.join("\n"), rx1 + 2, y + 9, { width: W * 0.5 - 6 });
    }
    y += buyH;

    // ─── Line Items ───
    const cols = [
      { l: "Sl\nNo.", x: L, w: 20, a: "center" },
      { l: "Description of Goods", x: L + 20, w: 165, a: "left" },
      { l: "HSN/SAC", x: L + 185, w: 50, a: "left" },
      { l: "GST\nRate", x: L + 235, w: 35, a: "center" },
      { l: "Quantity", x: L + 270, w: 62, a: "right" },
      { l: "Rate", x: L + 332, w: 55, a: "right" },
      { l: "per", x: L + 387, w: 23, a: "center" },
      { l: "Amount", x: L + 410, w: 125, a: "right" },
    ];

    // Header
    box(L, y, W, 18);
    cols.forEach((c, i) => {
      if (i > 0) vline(c.x, y, y + 18);
      doc
        .fontSize(6.5)
        .font("Helvetica-Bold")
        .fillColor("#000")
        .text(c.l, c.x + 2, y + 2, { width: c.w - 4, align: c.a });
    });
    y += 18;

    // Data rows
    const rowH = 14;
    lines.forEach((ln, i) => {
      if (y + rowH > 720) {
        doc.addPage();
        y = 30;
      }
      box(L, y, W, rowH);
      cols.forEach((c, ci) => {
        if (ci > 0) vline(c.x, y, y + rowH);
        let val = "";
        switch (ci) {
          case 0:
            val = String(i + 1);
            break;
          case 1:
            val = ln.stockItemName || "";
            break;
          case 2:
            val = ln.hsnCode || "";
            break;
          case 3:
            val = `${ln.taxRate || 0} %`;
            break;
          case 4:
            val = `${fN(ln.quantity || 0, 3)} ${ln.unit || "Pc"}`;
            break;
          case 5:
            val = fN(ln.rate || 0, 2);
            break;
          case 6:
            val = ln.unit || "Pc";
            break;
          case 7:
            val = fN(ln.amount || 0, 2);
            break;
        }
        doc
          .fontSize(7)
          .font(ci === 2 ? "Courier" : "Helvetica")
          .fillColor("#000")
          .text(val, c.x + 2, y + 3, { width: c.w - 4, align: c.a });
      });
      y += rowH;
    });

    // Subtotal
    const amtCol = cols[7];
    box(L, y, W, 12);
    vline(amtCol.x, y, y + 12);
    doc
      .fontSize(7)
      .font("Helvetica-Bold")
      .text("Subtotal", L + 2, y + 2, {
        width: amtCol.x - L - 4,
        align: "right",
      });
    doc.text(fN(subtotal, 2), amtCol.x + 2, y + 2, {
      width: amtCol.w - 4,
      align: "right",
    });
    y += 12;

    // Tax rows
    const taxRow = (label, amt) => {
      box(L, y, W, 12);
      vline(amtCol.x, y, y + 12);
      doc
        .fontSize(7)
        .font("Helvetica")
        .text(label, L + 2, y + 2, { width: amtCol.x - L - 4, align: "right" });
      doc.text(fN(amt, 2), amtCol.x + 2, y + 2, {
        width: amtCol.w - 4,
        align: "right",
      });
      y += 12;
    };
    if (isInter && igst > 0) taxRow("IGST", igst);
    else {
      if (cgst > 0) taxRow("CGST", cgst);
      if (sgst > 0) taxRow("SGST/UTGST", sgst);
    }
    if (Math.abs(roundOff) > 0.001) taxRow("Round Off", roundOff);

    // Grand Total
    box(L, y, W, 14);
    vline(amtCol.x, y, y + 14);
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .text("Total ₹", L + 2, y + 3, {
        width: amtCol.x - L - 4,
        align: "right",
      });
    doc.text(fN(grandTotal, 2), amtCol.x + 2, y + 3, {
      width: amtCol.w - 4,
      align: "right",
    });
    y += 14;

    // ─── Amount in Words ───
    box(L, y, W, 22);
    doc
      .fontSize(6)
      .font("Helvetica")
      .fillColor("#666")
      .text("Amount Chargeable (in words)", L + 3, y + 2);
    doc.fontSize(6).text("E. & O.E", L + W - 40, y + 2);
    doc
      .fontSize(7.5)
      .font("Helvetica-Bold")
      .fillColor("#000")
      .text(`INR ${_numToWords(grandTotal)} Only`, L + 3, y + 11, {
        width: W - 8,
      });
    y += 22;

    // ─── HSN Summary ───
    if (hsnRows.length > 0) {
      const hc = isInter
        ? [
            { l: "HSN/SAC", x: L, w: 100 },
            { l: "Taxable\nValue", x: L + 100, w: 80 },
            { l: "IGST\nRate", x: L + 180, w: 50 },
            { l: "IGST\nAmount", x: L + 230, w: 80 },
            { l: "Total\nTax Amount", x: L + 310, w: 225 },
          ]
        : [
            { l: "HSN/SAC", x: L, w: 90 },
            { l: "Taxable\nValue", x: L + 90, w: 75 },
            { l: "CGST\nRate", x: L + 165, w: 40 },
            { l: "CGST\nAmount", x: L + 205, w: 65 },
            { l: "SGST/UTGST\nRate", x: L + 270, w: 45 },
            { l: "SGST/UTGST\nAmount", x: L + 315, w: 65 },
            { l: "Total\nTax Amount", x: L + 380, w: 155 },
          ];

      if (y + 40 > 720) {
        doc.addPage();
        y = 30;
      }
      box(L, y, W, 22);
      hc.forEach((c, i) => {
        if (i > 0) vline(c.x, y, y + 22);
        doc
          .fontSize(6)
          .font("Helvetica-Bold")
          .fillColor("#000")
          .text(c.l, c.x + 2, y + 2, {
            width: c.w - 4,
            align: i === 0 ? "left" : "right",
          });
      });
      y += 22;

      hsnRows.forEach((row) => {
        box(L, y, W, 12);
        hc.forEach((c, i) => {
          if (i > 0) vline(c.x, y, y + 12);
        });
        const halfR = row.rate / 2,
          halfT = row.tax / 2;
        doc
          .fontSize(7)
          .font("Courier")
          .text(row.hsn, hc[0].x + 2, y + 2, { width: hc[0].w - 4 });
        doc.font("Helvetica");
        if (isInter) {
          doc.text(fN(row.taxable, 2), hc[1].x + 2, y + 2, {
            width: hc[1].w - 4,
            align: "right",
          });
          doc.text(`${row.rate}%`, hc[2].x + 2, y + 2, {
            width: hc[2].w - 4,
            align: "right",
          });
          doc.text(fN(row.tax, 2), hc[3].x + 2, y + 2, {
            width: hc[3].w - 4,
            align: "right",
          });
          doc.font("Helvetica-Bold").text(fN(row.tax, 2), hc[4].x + 2, y + 2, {
            width: hc[4].w - 4,
            align: "right",
          });
        } else {
          doc.text(fN(row.taxable, 2), hc[1].x + 2, y + 2, {
            width: hc[1].w - 4,
            align: "right",
          });
          doc.text(`${halfR}%`, hc[2].x + 2, y + 2, {
            width: hc[2].w - 4,
            align: "right",
          });
          doc.text(fN(halfT, 2), hc[3].x + 2, y + 2, {
            width: hc[3].w - 4,
            align: "right",
          });
          doc.text(`${halfR}%`, hc[4].x + 2, y + 2, {
            width: hc[4].w - 4,
            align: "right",
          });
          doc.text(fN(halfT, 2), hc[5].x + 2, y + 2, {
            width: hc[5].w - 4,
            align: "right",
          });
          doc.font("Helvetica-Bold").text(fN(row.tax, 2), hc[6].x + 2, y + 2, {
            width: hc[6].w - 4,
            align: "right",
          });
        }
        y += 12;
      });

      // HSN Total
      box(L, y, W, 12);
      hc.forEach((c, i) => {
        if (i > 0) vline(c.x, y, y + 12);
      });
      doc.fontSize(7).font("Helvetica-Bold");
      doc.text("Total", hc[0].x + 2, y + 2);
      if (isInter) {
        doc.text(fN(subtotal, 2), hc[1].x + 2, y + 2, {
          width: hc[1].w - 4,
          align: "right",
        });
        doc.text(fN(igst, 2), hc[3].x + 2, y + 2, {
          width: hc[3].w - 4,
          align: "right",
        });
        doc.text(fN(totalTax, 2), hc[4].x + 2, y + 2, {
          width: hc[4].w - 4,
          align: "right",
        });
      } else {
        doc.text(fN(subtotal, 2), hc[1].x + 2, y + 2, {
          width: hc[1].w - 4,
          align: "right",
        });
        doc.text(fN(cgst, 2), hc[3].x + 2, y + 2, {
          width: hc[3].w - 4,
          align: "right",
        });
        doc.text(fN(sgst, 2), hc[5].x + 2, y + 2, {
          width: hc[5].w - 4,
          align: "right",
        });
        doc.text(fN(totalTax, 2), hc[6].x + 2, y + 2, {
          width: hc[6].w - 4,
          align: "right",
        });
      }
      y += 12;
    }

    // ─── Tax in Words ───
    box(L, y, W, 14);
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#666")
      .text("Tax Amount (in words): ", L + 3, y + 3);
    doc
      .font("Helvetica-Bold")
      .fillColor("#000")
      .text(`INR ${_numToWords(totalTax)} Only`, L + 110, y + 3);
    y += 14;

    // ─── Declaration + Signature ───
    const declH = 72;
    if (y + declH > 780) {
      doc.addPage();
      y = 30;
    }
    box(L, y, W, declH);
    vline(L + W * 0.55, y, y + declH);

    doc
      .fontSize(6)
      .font("Helvetica-Bold")
      .fillColor("#666")
      .text("Declaration", L + 3, y + 2);
    doc
      .fontSize(6.5)
      .font("Helvetica")
      .fillColor("#000")
      .text(declaration, L + 3, y + 10, { width: W * 0.55 - 8 });

    if (defaultBank) {
      const bky = y + 30;
      doc
        .fontSize(6)
        .font("Helvetica-Bold")
        .fillColor("#666")
        .text("Company's Bank Details", L + 3, bky);
      let bky2 = bky + 8;
      if (defaultBank.bankName) {
        doc
          .fontSize(6.5)
          .font("Helvetica")
          .fillColor("#000")
          .text(`Bank Name: ${defaultBank.bankName}`, L + 3, bky2);
        bky2 += 8;
      }
      if (defaultBank.accountNumber) {
        doc.text(`A/c No.: ${defaultBank.accountNumber}`, L + 3, bky2);
        bky2 += 8;
      }
      if (defaultBank.ifsc) {
        doc.text(
          `Branch & IFS Code: ${defaultBank.branch || ""} & ${defaultBank.ifsc}`,
          L + 3,
          bky2,
        );
      }
    }

    // Right: company name + stamp + signature
    const sigX = L + W * 0.55,
      sigW = W * 0.45;
    doc
      .fontSize(7)
      .font("Helvetica")
      .text(`for ${companyName}`, sigX + 2, y + 2, {
        width: sigW - 6,
        align: "right",
      });

    if (stampBase64) {
      try {
        const sBuf = Buffer.from(
          stampBase64.replace(/^data:image\/\w+;base64,/, ""),
          "base64",
        );
        doc.image(sBuf, sigX + sigW / 2 - 25, y + 14, {
          width: 50,
          height: 35,
        });
      } catch (_) {}
    }

    const sigLineY = y + declH - 14;
    ["Prepared by", "Verified by", "Authorised Signatory"].forEach((lbl, i) => {
      const sx = sigX + i * (sigW / 3);
      doc
        .moveTo(sx + 4, sigLineY)
        .lineTo(sx + sigW / 3 - 4, sigLineY)
        .stroke();
      doc
        .fontSize(6)
        .font("Helvetica")
        .fillColor("#000")
        .text(lbl, sx + 2, sigLineY + 2, {
          width: sigW / 3 - 4,
          align: "center",
        });
    });
    y += declH;

    // ─── Jurisdiction ───
    const city = co?.address?.city || "BHUBANESWAR";
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#000")
      .text(`SUBJECT TO ${city.toUpperCase()} JURISDICTION`, L, y + 3, {
        width: W,
        align: "center",
      });
    doc
      .fontSize(6.5)
      .fillColor("#888")
      .text("This is a Computer Generated Invoice", L, y + 13, {
        width: W,
        align: "center",
      });

    doc.end();
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND")
      return res
        .status(500)
        .json({ error: "pdfkit not installed. Run: npm install pdfkit" });
    console.error("[invoices/download-pdf]", e);
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

    // ── Flatten dispatchDetails onto the invoice ──────────────────────────────
    // The React-PDF invoice generator (components/accountant/InvoicePDFGenerator.js)
    // reads FLAT fields (invoice.dispatchDocNumber, invoice.dispatchedThrough,
    // invoice.destination, invoice.deliveryNote, invoice.buyersOrderNumber,
    // invoice.termsOfDelivery, …) but the sales form saves these NESTED under
    // `dispatchDetails`. We copy the nested values up to the flat names the PDF
    // expects (only when a flat value isn't already set), so the PDF and the
    // on-screen detail render the dispatch data without changing the frontend.
    const dd = enriched.dispatchDetails || {};
    const flatFromDispatch = {
      deliveryNote: enriched.deliveryNote || dd.deliveryNoteNumbers || "",
      deliveryNoteDate:
        enriched.deliveryNoteDate || dd.deliveryNoteDate || null,
      buyersOrderNumber:
        enriched.buyersOrderNumber || dd.buyersOrderNumber || "",
      buyersOrderDate: enriched.buyersOrderDate || dd.buyersOrderDate || null,
      dispatchDocNumber:
        enriched.dispatchDocNumber || dd.dispatchDocNumber || "",
      dispatchedThrough:
        enriched.dispatchedThrough || dd.dispatchedThrough || "",
      destination: enriched.destination || dd.destination || "",
      otherReferences: enriched.otherReferences || dd.otherReferences || "",
      termsOfDelivery: enriched.termsOfDelivery || dd.termsOfDelivery || "",
      carrierName: enriched.carrierName || dd.carrierName || "",
      billOfLadingNumber:
        enriched.billOfLadingNumber || dd.billOfLadingNumber || "",
      motorVehicleNumber:
        enriched.motorVehicleNumber || dd.motorVehicleNumber || "",
      dispatchDate: enriched.dispatchDate || dd.dispatchDate || null,
    };
    Object.assign(enriched, flatFromDispatch);

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

    const defaultBank =
      (settings?.bankAccounts || []).find((b) => b.isDefault) ||
      (settings?.bankAccounts || [])[0] ||
      null;

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
            const { ledgerEntries, ...rest } = r;
            return { ...rest, allocatedToThisInvoice: allocated };
          }),
        ),
    ]);

    res.json({
      invoice: enriched,
      company,
      settings,
      defaultBank,
      linkedCreditNotes: linkedCNs,
      linkedReceipts,
    });
  } catch (e) {
    console.error("[invoices/:id]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ================================================================== */
/* NEW ROUTE 2: PUT /:id — edit a draft or posted invoice             */
/* ================================================================== */
router.put("/:id", async (req, res) => {
  // ── Approval gate ─────────────────────────────────────────────────────────
  // An editor (no direct-post privilege) editing a POSTED invoice must NOT
  // change the ledger in place. Hold the edit as an approval request — the SAME
  // queue + executor the generic voucher edit uses — and leave the invoice
  // untouched until an admin approves. Runs BEFORE any transaction so nothing is
  // half-applied. Owners/approvers/admins/accountants, and edits to a draft or a
  // still-pending invoice, fall straight through to the direct-edit path below.
  try {
    const inv0 = await Acc_Voucher.findOne({
      _id: req.params.id,
      voucherType: "sales",
    })
      .select(
        "status companyId voucherType voucherNumber partyLedgerName grandTotal",
      )
      .lean();
    if (!inv0) return res.status(404).json({ error: "Invoice not found" });

    const perms = req.user?.permissions || {};
    const role = req.user?.role;
    const canEditDirectly =
      perms.canPostDirectly ||
      ["owner", "approver", "admin", "accountant"].includes(role);

    if (!canEditDirectly && inv0.status === "posted") {
      if (!req.user?.organizationId) {
        return res
          .status(403)
          .json({ error: "Your role can't edit posted invoices." });
      }
      const body = req.body || {};

      // Canonicalise ledger entries so the held payload applies cleanly on
      // approval (same resolution the direct edit does). No session here — any
      // auto-created ledger commits immediately and is harmless if rejected.
      if (Array.isArray(body.ledgerEntries)) {
        for (const entry of body.ledgerEntries) {
          const ledId = entry.ledgerId || entry.ledger;
          if (ledId) {
            entry.ledgerId = ledId;
            if (!entry.ledgerName) {
              const led = await Acc_Ledger.findById(ledId).select("name");
              if (led) entry.ledgerName = led.name;
            }
          } else if (entry.ledgerName) {
            const led = await _resolveOrCreateByName(
              entry.ledgerName,
              inv0.companyId,
              req.user?.id,
            );
            if (led) {
              entry.ledgerId = led._id;
              entry.ledgerName = led.name;
            }
          }
          delete entry.ledger;
          delete entry.autoLedger;
        }
      }

      const {
        Acc_ApprovalRequest,
      } = require("../../models/Accountant_model/Acc_OrgModels");

      const dup = await Acc_ApprovalRequest.findOne({
        organizationId: req.user.organizationId,
        kind: "voucher",
        action: "update",
        "target.id": inv0._id,
        status: "pending",
      });
      if (dup) {
        return res.status(200).json({
          _pendingApproval: true,
          message: "An edit request is already pending for this invoice.",
        });
      }

      await Acc_ApprovalRequest.create({
        organizationId: req.user.organizationId,
        companyId: inv0.companyId,
        kind: "voucher",
        action: "update",
        title: `Edit ${inv0.voucherType} ${inv0.voucherNumber} · ${
          inv0.partyLedgerName || "—"
        } · ₹${Number(inv0.grandTotal || 0).toLocaleString("en-IN")}`,
        target: { collection: "Acc_Voucher", id: inv0._id },
        payload: body,
        diff: {
          before: {
            voucherNumber: inv0.voucherNumber,
            partyLedgerName: inv0.partyLedgerName || "",
            grandTotal: Number(inv0.grandTotal || 0),
          },
          after: {
            voucherNumber: body.voucherNumber ?? inv0.voucherNumber,
            partyLedgerName: body.partyLedgerName ?? inv0.partyLedgerName ?? "",
            grandTotal: Number(body.grandTotal ?? inv0.grandTotal ?? 0),
          },
        },
        requestedBy: req.user.id,
        requestedByName: req.user.name || "",
        status: "pending",
      });

      return res.status(202).json({
        _pendingApproval: true,
        message: "Edit request sent to an admin for approval.",
      });
    }
  } catch (gateErr) {
    console.error("[invoices/put approval-gate]", gateErr.message);
    return res.status(400).json({ error: gateErr.message });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const inv = await Acc_Voucher.findOne({
      _id: req.params.id,
      voucherType: "sales",
    }).session(session);
    if (!inv) throw new Error("Invoice not found");

    if (inv.status === "cancelled" || inv.status === "void") {
      throw new Error(`Cannot edit a ${inv.status} invoice.`);
    }

    const wasPosted = inv.status === "posted";
    if (wasPosted) await _applyLedgerBalances(inv, -1, session);

    const body = req.body || {};

    // ── Resolve ledger entries exactly like the create path ──────────────
    // Every entry must carry a real ledgerId before we save, otherwise the
    // re-apply below skips it and the edit never reaches the ledgers / Balance
    // Sheet. Entries that arrive with only a name (e.g. "Round Off", or a GST
    // band whose rate-specific ledger doesn't exist yet) are resolved or
    // auto-created here. Transient client flags are stripped.
    if (Array.isArray(body.ledgerEntries)) {
      for (const entry of body.ledgerEntries) {
        const ledId = entry.ledgerId || entry.ledger;
        if (ledId) {
          entry.ledgerId = ledId;
          if (!entry.ledgerName) {
            const led = await Acc_Ledger.findById(ledId)
              .select("name")
              .session(session);
            if (led) entry.ledgerName = led.name;
          }
        } else if (entry.ledgerName) {
          const led = await _resolveOrCreateByName(
            entry.ledgerName,
            inv.companyId,
            req.user?.id,
            session,
          );
          if (led) {
            entry.ledgerId = led._id;
            entry.ledgerName = led.name;
          }
        }
        delete entry.ledger;
        delete entry.autoLedger;
      }
    }

    const EDITABLE = [
      "voucherDate",
      "partyLedgerId",
      "partyLedgerName",
      "partyGstin",
      "placeOfSupply",
      "placeOfSupplyCode",
      "billDate",
      "dueDate",
      "billingAddress",
      "shippingAddress",
      "ledgerEntries",
      "inventoryEntries",
      "subtotal",
      "discountTotal",
      "gstBreakup",
      "totalTax",
      "roundOff",
      "grandTotal",
      "totalDebit",
      "totalCredit",
      "narration",
      "referenceNumber",
      "referenceDate",
      "buyersOrderNumber",
      "buyersOrderDate",
      "dispatchDocNumber",
      "deliveryNote",
      "deliveryNoteDate",
      "dispatchedThrough",
      "destination",
      "termsOfDelivery",
      "dispatchDetails",
      "paymentTerms",
      "eWayBillDetails",
      "eInvoiceDetails",
      "declaration",
    ];
    for (const key of EDITABLE) {
      if (body[key] !== undefined) inv[key] = body[key];
    }
    if (body.voucherDate) inv.financialYear = _computeFY(body.voucherDate);
    inv.updatedBy = req.user?.id;

    await inv.save({ session });
    if (wasPosted) await _applyLedgerBalances(inv, +1, session);

    await session.commitTransaction();
    res.json({ success: true, invoice: inv });
  } catch (e) {
    await session.abortTransaction();
    console.error("[invoices/put]", e);
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

/* ================================================================== */
/* NEW ROUTE 3: PATCH /:id/status — cancel or void                    */
/* ================================================================== */
router.patch("/:id/status", async (req, res) => {
  const { status, reason } = req.body || {};
  if (!["cancelled", "void"].includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be 'cancelled' or 'void'" });
  }
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const inv = await Acc_Voucher.findOne({
      _id: req.params.id,
      voucherType: "sales",
    }).session(session);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "cancelled" || inv.status === "void") {
      throw new Error(`Invoice is already ${inv.status}`);
    }

    // Cancel reverses ledger entries; Void does not
    if (status === "cancelled" && inv.status === "posted") {
      await _applyLedgerBalances(inv, -1, session);
    }

    inv.status = status;
    inv.cancelledBy = req.user?.id;
    inv.cancelledAt = new Date();
    inv.updatedBy = req.user?.id;
    if (reason) inv.cancellationReason = String(reason);

    await inv.save({ session });
    await session.commitTransaction();
    res.json({ success: true, invoice: inv });
  } catch (e) {
    await session.abortTransaction();
    console.error("[invoices/status]", e);
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

/* ------------------------------------------------------------------ */
/* POST /:id/reminder                                                  */
/* ------------------------------------------------------------------ */
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

// ── Number to INR words helper ──
function _numToWords(num) {
  if (!num || isNaN(num)) return "Zero";
  const rupees = Math.floor(Math.abs(num));
  const paise = Math.round((Math.abs(num) - rupees) * 100);
  let r = _r2w(rupees);
  if (paise > 0) r += ` and ${_r2w(paise)} paise`;
  return r || "Zero";
}
function _r2w(n) {
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
  const t2 = (x) =>
    x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? " " + a[x % 10] : "");
  const t3 = (x) => {
    const h = Math.floor(x / 100),
      r = x % 100;
    return (h ? a[h] + " Hundred" + (r ? " " : "") : "") + (r ? t2(r) : "");
  };
  const cr = Math.floor(n / 10000000),
    lk = Math.floor((n % 10000000) / 100000),
    th = Math.floor((n % 100000) / 1000),
    rest = n % 1000;
  let o = "";
  if (cr) o += t3(cr) + " Crore ";
  if (lk) o += t2(lk) + " Lakh ";
  if (th) o += t2(th) + " Thousand ";
  if (rest) o += t3(rest);
  return o.trim();
}

module.exports = router;
