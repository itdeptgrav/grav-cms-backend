/**
 * Tally Voucher Routes
 * Handles all voucher types (sales, purchase, receipt, payment, contra, journal, credit_note, debit_note, etc.)
 * - Auto-numbering per FY per voucher type
 * - Status transitions: draft → posted → cancelled/void
 * - Updates ledger balances atomically on post
 * - Filtering by type, party, date range, status
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
  Acc_StockItem,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const auth = accountantAuth;

const VOUCHER_TYPES = [
  "sales",
  "purchase",
  "receipt",
  "payment",
  "contra",
  "journal",
  "credit_note",
  "debit_note",
  "stock_journal",
  "delivery_note",
  "receipt_note",
  "rejection_in",
  "rejection_out",
  "memo",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeFY(dateInput) {
  const d = new Date(dateInput);
  const m = d.getMonth();
  const y = d.getFullYear();
  // India FY April-March
  return m >= 3
    ? `${y}-${String((y + 1) % 100).padStart(2, "0")}`
    : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

/**
 * Apply ledger balance updates from a voucher's ledger entries.
 * direction = +1 for posting, -1 for cancelling/voiding.
 *
 * Schema field is `ledgerId` (renamed from legacy `ledger`); guard both
 * so older drafts saved before the rename still apply correctly.
 */
async function applyLedgerBalances(voucher, direction = 1, session = null) {
  const ops = [];
  for (const entry of voucher.ledgerEntries) {
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
    await Acc_Ledger.bulkWrite(ops, { session });
  }
  // Refresh balanceType per ledger touched
  for (const entry of voucher.ledgerEntries) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const led = await Acc_Ledger.findById(lid).session(session);
    if (led) {
      led.balanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
      await led.save({ session });
    }
  }
}

/* ------------------------------------------------------------------ */
/* GET /cash-bank-ledgers                                              */
/* ------------------------------------------------------------------ */
/* Returns every ledger whose group descends from the reserved
 * "Bank Accounts" or "Cash-in-Hand" Tally groups. Used by the
 * Contra Voucher form to populate its From/To dropdowns.
 *
 * Handles arbitrarily-deep user-created sub-groups: if the user nested
 * "HDFC Current A/c" under Bank Accounts → that ledger is included.
 *
 * Returns:
 *   {
 *     ledgers: [...],      // sorted by groupName, then ledger name
 *     _diagnostic: {       // surfaces WHY the result is empty if it is
 *       rootGroupsFound,   // the reserved groups that matched
 *       descendantGroupCount,
 *       ledgerCount,
 *     }
 *   }
 */
// ─────────────────────────────────────────────────────────────────────────
// GET /stock-items — list stock items for the form pickers
// ─────────────────────────────────────────────────────────────────────────
// Pulls from TWO collections and merges:
//
//   1. CMS `StockItem` (models/CMS_Models/Inventory/Products/StockItem.js)
//      — the real product catalog the user manages in their inventory UI.
//      Not scoped by companyId (CMS catalog is org-wide).
//
//   2. Accounting `Acc_StockItem` — items created via Tally import or
//      the accountant module itself. Scoped by companyId.
//
// Merge convention: CMS items take priority when names collide. The
// "source" field on the response tells the form where the row came from
// (useful for the picker's tertiary text).
//
// Field mapping for CMS StockItem → picker shape:
//   name → name
//   hsnCode → hsnCode
//   unit (default unit string) → baseUnit
//   baseSalesPrice → standardSellingPrice
//   baseCost → standardCost
//   salesTax (string like "18%" or "GST 18") → taxRate (parsed)
//   additionalNames → aliases (used for fuzzy search)
//   totalQuantityOnHand → closingQuantity
//
// Query params:
//   companyId — required (only filters Acc_StockItem; CMS items returned anyway)
//   q         — optional substring search on name / aliases / HSN
//   limit     — default 500 per source
// ─────────────────────────────────────────────────────────────────────────

// Parse "salesTax" strings ("18%", "GST 18%", "18", "0") into a number.
// Returns 0 if unparseable — the form's GST-rate dropdown will let the
// user fix it. This keeps the picker resilient to whatever the CMS
// inventory UI puts in that field.
function parseTaxRate(raw) {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return raw;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Lazy-require the CMS StockItem model. Doing this inside the handler
// keeps tallyVouchers.js loadable even on deployments that don't have
// the CMS inventory module installed yet. If require fails, we just
// skip the CMS source and fall back to Acc_StockItem only.
function loadCMSStockItem() {
  try {
    return require("../../models/CMS_Models/Inventory/Products/StockItem");
  } catch (e) {
    return null;
  }
}

router.get("/stock-items", auth, async (req, res) => {
  try {
    const { companyId, q, limit = 500 } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const lim = parseInt(limit);
    const rx = q
      ? new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : null;

    // ── Source 1: CMS StockItem catalog ────────────────────────────
    const CMSStockItem = loadCMSStockItem();
    let cmsItems = [];
    if (CMSStockItem) {
      const cmsFilter = {};
      if (rx) {
        cmsFilter.$or = [
          { name: rx },
          { additionalNames: rx },
          { hsnCode: rx },
          { reference: rx },
          { barcode: rx },
        ];
      }
      const cmsRaw = await CMSStockItem.find(cmsFilter)
        .sort({ name: 1 })
        .limit(lim)
        .select(
          "name additionalNames hsnCode unit baseSalesPrice baseCost salesTax totalQuantityOnHand reference category genderCategory",
        )
        .lean();

      cmsItems = cmsRaw.map((s) => ({
        _id: s._id,
        name: s.name,
        aliases: s.additionalNames || [],
        hsnCode: s.hsnCode || "",
        baseUnit: s.unit || "Nos",
        taxRate: parseTaxRate(s.salesTax),
        standardSellingPrice: s.baseSalesPrice || 0,
        standardCost: s.baseCost || 0,
        closingQuantity: s.totalQuantityOnHand || 0,
        gstApplicable: !!s.salesTax,
        source: "cms",
        // Extras the picker UI can show as tertiary text
        reference: s.reference,
        category: s.category,
      }));
    }

    // ── Source 2: Acc_StockItem (accountant-side, company-scoped) ──
    const tallyFilter = { companyId, isActive: true };
    if (rx) {
      tallyFilter.$or = [{ name: rx }, { aliases: rx }, { hsnCode: rx }];
    }
    const tallyRaw = await Acc_StockItem.find(tallyFilter)
      .sort({ name: 1 })
      .limit(lim)
      .select(
        "name aliases hsnCode taxRate baseUnit altUnit standardSellingPrice standardCost closingQuantity gstApplicable",
      )
      .lean();

    const tallyItems = tallyRaw.map((t) => ({ ...t, source: "tally" }));

    // ── Merge — CMS items win when names collide (case-insensitive) ──
    const seen = new Set(cmsItems.map((i) => (i.name || "").toLowerCase()));
    const merged = [
      ...cmsItems,
      ...tallyItems.filter((t) => !seen.has((t.name || "").toLowerCase())),
    ];

    res.json({ items: merged, count: merged.length });
  } catch (e) {
    console.error("[stock-items]", e);
    res.status(500).json({ error: e.message });
  }
});

router.get("/cash-bank-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    }

    // 1) Find the canonical reserved groups for cash and bank. Match by
    //    name case-insensitively to survive minor variants. Both the
    //    seeded chart and Tally XML imports use these exact names, so
    //    a strict regex with anchors is safe.
    const RESERVED_NAMES = [/^bank\s*accounts$/i, /^cash[-\s]?in[-\s]?hand$/i];
    const rootGroups = await Acc_Group.find({
      companyId,
      isActive: true,
      $or: RESERVED_NAMES.map((rx) => ({ name: rx })),
    }).lean();

    if (rootGroups.length === 0) {
      return res.json({
        success: true,
        ledgers: [],
        _diagnostic: {
          rootGroupsFound: [],
          descendantGroupCount: 0,
          ledgerCount: 0,
          hint: "Neither 'Bank Accounts' nor 'Cash-in-Hand' reserved groups exist on this company. Seed the chart or create them manually.",
        },
      });
    }

    // 2) Walk down to find every descendant group (sub-groups,
    //    sub-sub-groups, etc.) under those roots. BFS — start with the
    //    roots themselves and expand outward.
    const targetGroupIds = new Set(rootGroups.map((g) => String(g._id)));
    let frontier = rootGroups.map((g) => g._id);
    let safetyCounter = 0;
    while (frontier.length > 0 && safetyCounter < 50) {
      safetyCounter++;
      const children = await Acc_Group.find({
        companyId,
        isActive: true,
        parent: { $in: frontier },
      })
        .select("_id name parent")
        .lean();
      const newFrontier = [];
      for (const c of children) {
        const key = String(c._id);
        if (!targetGroupIds.has(key)) {
          targetGroupIds.add(key);
          newFrontier.push(c._id);
        }
      }
      frontier = newFrontier;
    }

    // 3) Find all active ledgers under those groups
    const ledgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
      groupId: { $in: Array.from(targetGroupIds) },
    })
      .sort({ groupName: 1, name: 1 })
      .lean();

    res.json({
      success: true,
      ledgers,
      _diagnostic: {
        rootGroupsFound: rootGroups.map((g) => ({
          _id: g._id,
          name: g.name,
          nature: g.nature,
        })),
        descendantGroupCount: targetGroupIds.size,
        ledgerCount: ledgers.length,
      },
    });
  } catch (err) {
    console.error("[cash-bank-ledgers]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* List & filter                                                       */
/* ------------------------------------------------------------------ */

router.get("/", auth, async (req, res) => {
  try {
    const {
      companyId,
      voucherType,
      party,
      status,
      dateFrom,
      dateTo,
      q,
      page = 1,
      limit = 50,
      sort = "-voucherDate",
    } = req.query;

    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const filter = { companyId };
    if (voucherType) filter.voucherType = voucherType;
    if (status) filter.status = status;
    if (party) filter.partyLedgerId = party;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) filter.voucherDate.$lte = new Date(dateTo);
    }
    if (q) {
      filter.$or = [
        { voucherNumber: new RegExp(q, "i") },
        { narration: new RegExp(q, "i") },
        { partyLedgerName: new RegExp(q, "i") },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Acc_Voucher.find(filter)
        .populate("partyLedgerId", "name groupName")
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Acc_Voucher.countDocuments(filter),
    ]);

    // For vouchers without a party name (common in Tally-imported payments),
    // derive a display name from the first Dr ledger entry.
    for (const v of items) {
      if (!v.partyLedgerName && (!v.partyLedgerId || !v.partyLedgerId.name)) {
        const firstDr = (v.ledgerEntries || []).find(
          (e) => e.type === "Dr" || (e.signedAmount || 0) > 0,
        );
        if (firstDr) {
          v.partyLedgerName = firstDr.ledgerName || "";
        }
      }
    }

    res.json({
      items,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Credit / Debit Note helpers + routes                                */
/* ------------------------------------------------------------------ */
/* MUST be declared BEFORE router.get("/:id") below — Express matches
 * routes in declaration order, and any single-segment GET would
 * otherwise be intercepted by /:id and trigger an ObjectId cast error.
 */

/**
 * Resolve (or auto-create) the "Sales Returns" ledger under "Sales
 * Accounts". This is the standard Tally convention for the debit leg of
 * a credit note — keeping it separate from "Sales" lets the P&L show
 * Gross Sales vs Net Sales cleanly.
 *
 * Idempotent: if the ledger already exists for this company, returns it.
 * If not, creates a fresh one and returns the new doc. Either way the
 * caller can rely on the returned ledger being ready to use.
 */
async function resolveSalesReturnsLedger(companyId) {
  const existing = await Acc_Ledger.findOne({
    companyId,
    isActive: true,
    name: /^sales\s*returns?$/i,
  });
  if (existing) return existing;

  // Find Sales Accounts group to nest under. If it doesn't exist (e.g.
  // user wiped the seed), fall back to ANY revenue-nature group.
  let group = await Acc_Group.findOne({
    companyId,
    isActive: true,
    name: /^sales\s*accounts$/i,
  });
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      nature: "revenue",
    });
  }
  if (!group) {
    throw new Error(
      "No revenue group found — cannot auto-create Sales Returns ledger. Create a 'Sales Accounts' group in Chart of Accounts first.",
    );
  }

  const led = await Acc_Ledger.create({
    companyId,
    name: "Sales Returns",
    groupId: group._id,
    groupName: group.name,
    nature: "revenue",
    openingBalance: 0,
    currentBalance: 0,
    balanceType: "Cr",
    isReserved: false, // user can rename/delete if they have their own
    isActive: true,
    description:
      "Auto-created on first credit note. Contra to Sales — shown as deduction from Gross Sales on the P&L.",
  });
  return led;
}

/* GET /invoice-lookup — list sales invoices to credit against         */
router.get("/invoice-lookup", auth, async (req, res) => {
  try {
    const { companyId, partyLedgerId, dateFrom, dateTo, includeCleared } =
      req.query;
    if (!companyId || !partyLedgerId) {
      return res
        .status(400)
        .json({ error: "companyId and partyLedgerId required" });
    }

    const from = dateFrom
      ? new Date(dateFrom)
      : new Date(Date.now() - 365 * 86400000);
    const to = dateTo ? new Date(dateTo) : new Date();

    const invoices = await Acc_Voucher.find({
      companyId,
      voucherType: "sales",
      status: "posted",
      partyLedgerId,
      voucherDate: { $gte: from, $lte: to },
    })
      .sort({ voucherDate: -1, voucherNumber: -1 })
      .select(
        "voucherNumber voucherDate grandTotal placeOfSupplyCode placeOfSupply gstBreakup",
      )
      .limit(200)
      .lean();

    if (invoices.length === 0) {
      return res.json({ invoices: [] });
    }

    // For each invoice, sum any prior CN amounts that link back to it
    const invoiceIds = invoices.map((i) => i._id);
    const priorCNs = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          voucherType: "credit_note",
          status: { $in: ["posted", "pending_approval"] },
          "originalInvoice.voucherId": { $in: invoiceIds },
        },
      },
      {
        $group: {
          _id: "$originalInvoice.voucherId",
          totalCredited: { $sum: "$grandTotal" },
        },
      },
    ]);
    const creditedMap = new Map(
      priorCNs.map((c) => [String(c._id), c.totalCredited]),
    );

    const enriched = invoices.map((inv) => {
      const already = creditedMap.get(String(inv._id)) || 0;
      const outstanding = Math.max(0, (inv.grandTotal || 0) - already);
      return {
        ...inv,
        alreadyCredited: already,
        outstandingForCredit: outstanding,
      };
    });

    const filtered =
      includeCleared === "1"
        ? enriched
        : enriched.filter((i) => i.outstandingForCredit > 0.01);

    res.json({ invoices: filtered });
  } catch (e) {
    console.error("[invoice-lookup]", e);
    res.status(500).json({ error: e.message });
  }
});

/* GET /cn-reason-codes — static list of GST reason codes              */
router.get("/cn-reason-codes", auth, (req, res) => {
  res.json({
    reasons: [
      {
        code: "sales_return",
        label: "Sales Return",
        description: "Goods physically returned by customer",
      },
      {
        code: "post_sale_discount",
        label: "Post-Sale Discount",
        description: "Discount agreed after the original invoice was raised",
      },
      {
        code: "deficiency_service",
        label: "Deficiency in Service",
        description: "Service was incomplete or below agreed quality",
      },
      {
        code: "correction_invoice",
        label: "Correction in Acc_Invoice",
        description: "Original invoice had wrong amount / tax / particulars",
      },
      {
        code: "change_pos",
        label: "Change in Place of Supply",
        description: "POS revised → tax type (CGST+SGST ↔ IGST) changed",
      },
      {
        code: "others",
        label: "Others",
        description: "Any reason not listed above",
      },
    ],
  });
});

/* GET /sales-returns-ledger — resolve or auto-create                  */
router.get("/sales-returns-ledger", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const led = await resolveSalesReturnsLedger(companyId);
    res.json({ ledger: led });
  } catch (e) {
    console.error("[sales-returns-ledger]", e);
    res.status(500).json({ error: e.message });
  }
});

/* GET /gst-output-ledgers — CGST/SGST/IGST Payable                    */
router.get("/gst-output-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const ledgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
      name: {
        $in: [/^cgst\s*payable$/i, /^sgst\s*payable$/i, /^igst\s*payable$/i],
      },
    }).lean();
    const map = {};
    for (const l of ledgers) {
      if (/cgst/i.test(l.name)) map.cgst = l;
      else if (/sgst/i.test(l.name)) map.sgst = l;
      else if (/igst/i.test(l.name)) map.igst = l;
    }
    res.json({ ledgers: map });
  } catch (e) {
    console.error("[gst-output-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /sales-ledgers — resolve / auto-create Sales — Local + Interstate */
/* ------------------------------------------------------------------ */
/* Returns the two sales ledgers the Sales Voucher form needs:
 *   • Sales — Local       (used when CGST+SGST applies)
 *   • Sales — Interstate  (used when IGST applies)
 *
 * If either is missing, auto-creates them under the "Sales Accounts"
 * group. Same idempotent pattern as resolveSalesReturnsLedger.
 *
 * Why two ledgers? Indian tax filing convention: GSTR-1 reports
 * intra-state and inter-state sales separately, and most accountants
 * want the running totals split on the P&L.
 */
async function resolveSalesLedger(
  companyId,
  kind /* "local" | "interstate" */,
) {
  const name = kind === "interstate" ? "Sales — Interstate" : "Sales — Local";
  const nameRx =
    kind === "interstate"
      ? /^sales\s*[—\-–]?\s*interstate$/i
      : /^sales\s*[—\-–]?\s*local$/i;

  const existing = await Acc_Ledger.findOne({
    companyId,
    isActive: true,
    name: nameRx,
  });
  if (existing) return existing;

  let group = await Acc_Group.findOne({
    companyId,
    isActive: true,
    name: /^sales\s*accounts$/i,
  });
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      nature: "revenue",
    });
  }
  if (!group) {
    throw new Error(
      "No revenue group found. Create a 'Sales Accounts' group in Chart of Accounts first.",
    );
  }

  const led = await Acc_Ledger.create({
    companyId,
    name,
    groupId: group._id,
    groupName: group.name,
    nature: "revenue",
    openingBalance: 0,
    currentBalance: 0,
    balanceType: "Cr",
    isReserved: false,
    isActive: true,
    description: `Auto-created on first sales voucher. Used for ${kind === "interstate" ? "inter-state (IGST)" : "intra-state (CGST+SGST)"} sales.`,
  });
  return led;
}

router.get("/sales-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const [local, interstate] = await Promise.all([
      resolveSalesLedger(companyId, "local"),
      resolveSalesLedger(companyId, "interstate"),
    ]);
    res.json({ ledgers: { local, interstate } });
  } catch (e) {
    console.error("[sales-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /purchase-ledgers — Purchase — Local + Interstate (AP mirror)   */
/* ------------------------------------------------------------------ */
/* Mirror of resolveSalesLedger but for the AP side. Returns the two
 * purchase ledgers the Purchase Voucher form needs:
 *   • Purchase — Local       (used when CGST+SGST applies)
 *   • Purchase — Interstate  (used when IGST applies)
 *
 * Auto-creates them under "Purchase Accounts" group if missing.
 * Same split rationale as sales: GSTR-2/3B treats local vs interstate
 * differently, and accountants want the P&L COGS line split for review.
 */
async function resolvePurchaseLedger(
  companyId,
  kind /* "local" | "interstate" */,
) {
  const name =
    kind === "interstate" ? "Purchase — Interstate" : "Purchase — Local";
  const nameRx =
    kind === "interstate"
      ? /^purchase\s*[—\-–]?\s*interstate$/i
      : /^purchase\s*[—\-–]?\s*local$/i;

  const existing = await Acc_Ledger.findOne({
    companyId,
    isActive: true,
    name: nameRx,
  });
  if (existing) return existing;

  // Resolve the purchase group. We try the standard name first, then
  // fall back to any group with nature "expense" since Purchase Accounts
  // typically sits under expenses in Indian COA. (Some schools of
  // thought put it under "Direct Expenses" or "Cost of Goods Sold" —
  // we pick whichever group the user has named.)
  let group = await Acc_Group.findOne({
    companyId,
    isActive: true,
    name: /^purchase\s*accounts$/i,
  });
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      name: /^direct\s*expenses$/i,
    });
  }
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      nature: "expense",
    });
  }
  if (!group) {
    throw new Error(
      "No expense group found. Create a 'Purchase Accounts' group in Chart of Accounts first.",
    );
  }

  const led = await Acc_Ledger.create({
    companyId,
    name,
    groupId: group._id,
    groupName: group.name,
    nature: "expense",
    openingBalance: 0,
    currentBalance: 0,
    balanceType: "Dr",
    isReserved: false,
    isActive: true,
    description: `Auto-created on first purchase voucher. Used for ${kind === "interstate" ? "inter-state (IGST)" : "intra-state (CGST+SGST)"} purchases.`,
  });
  return led;
}

router.get("/purchase-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const [local, interstate] = await Promise.all([
      resolvePurchaseLedger(companyId, "local"),
      resolvePurchaseLedger(companyId, "interstate"),
    ]);
    res.json({ ledgers: { local, interstate } });
  } catch (e) {
    console.error("[purchase-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /gst-input-ledgers — CGST/SGST/IGST INPUT ledgers (claimable)   */
/* ------------------------------------------------------------------ */
/* The AP-side counterpart to /gst-output-ledgers. Used by the Purchase
 * Voucher form (and any other "we paid GST that we can claim back"
 * voucher). Returns whichever input ledgers exist; doesn't auto-create
 * since input ledger setup is part of CoA seeding.
 */
router.get("/gst-input-ledgers", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const ledgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
      name: { $in: [/^cgst\s*input$/i, /^sgst\s*input$/i, /^igst\s*input$/i] },
    }).lean();
    const map = {};
    for (const l of ledgers) {
      if (/cgst/i.test(l.name)) map.cgst = l;
      else if (/sgst/i.test(l.name)) map.sgst = l;
      else if (/igst/i.test(l.name)) map.igst = l;
    }
    res.json({ ledgers: map });
  } catch (e) {
    console.error("[gst-input-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* DEBIT NOTE SUPPORT — AP-side mirror of credit-note endpoints        */
/* ------------------------------------------------------------------ */
/* Indian GST treats debit notes from the buyer's side: when we return
 * goods to a vendor (or get a price correction), we issue a DN that
 * reduces our payable and reverses the input GST we'd claimed. The
 * mirror of CN's Sales Returns ledger is a "Purchase Returns" ledger,
 * which sits as a contra to Purchase on the P&L (Cr balance reducing
 * net purchases). Same idempotent auto-create pattern as CN.
 */
async function resolvePurchaseReturnsLedger(companyId) {
  const existing = await Acc_Ledger.findOne({
    companyId,
    isActive: true,
    name: /^purchase\s*returns?$/i,
  });
  if (existing) return existing;

  // Resolve the parent group. Try Purchase Accounts first (most CoA
  // setups have it), then Direct Expenses, then any expense group.
  let group = await Acc_Group.findOne({
    companyId,
    isActive: true,
    name: /^purchase\s*accounts$/i,
  });
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      name: /^direct\s*expenses$/i,
    });
  }
  if (!group) {
    group = await Acc_Group.findOne({
      companyId,
      isActive: true,
      nature: "expense",
    });
  }
  if (!group) {
    throw new Error(
      "No expense group found — cannot auto-create Purchase Returns ledger. Create a 'Purchase Accounts' group in Chart of Accounts first.",
    );
  }

  const led = await Acc_Ledger.create({
    companyId,
    name: "Purchase Returns",
    groupId: group._id,
    groupName: group.name,
    nature: "expense",
    openingBalance: 0,
    currentBalance: 0,
    balanceType: "Cr",
    isReserved: false,
    isActive: true,
    description:
      "Auto-created on first debit note. Contra to Purchases — shown as deduction from Gross Purchases on the P&L.",
  });
  return led;
}

router.get("/purchase-returns-ledger", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const led = await resolvePurchaseReturnsLedger(companyId);
    res.json({ ledger: led });
  } catch (e) {
    console.error("[purchase-returns-ledger]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /dn-reason-codes — debit-note reason codes for the form picker  */
/* ------------------------------------------------------------------ */
router.get("/dn-reason-codes", auth, (req, res) => {
  res.json({
    reasons: [
      { code: "purchase_return", label: "Purchase return (goods returned)" },
      { code: "price_correction", label: "Price correction (overcharged)" },
      { code: "rate_difference", label: "Rate difference / renegotiation" },
      { code: "shortage_quantity", label: "Shortage / less than billed" },
      { code: "deficiency_service", label: "Deficiency in service" },
      { code: "others", label: "Other reason" },
    ],
  });
});

/* ------------------------------------------------------------------ */
/* GET /bill-lookup — list posted purchase bills to debit against      */
/* ------------------------------------------------------------------ */
/* AP mirror of /invoice-lookup. Returns posted purchase vouchers for
 * a given vendor that haven't been fully reversed, so the DN form can
 * pick which bill the debit note applies to.
 *
 * Query: companyId, partyLedgerId (vendor), q (optional voucher # /
 *        supplier invoice # search), limit
 *
 * "Outstanding for debit" = grandTotal MINUS (sum of prior DN amounts
 * linked to this bill via originalBill.voucherId).
 */
router.get("/bill-lookup", auth, async (req, res) => {
  try {
    const { companyId, partyLedgerId, q, limit = 50 } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!partyLedgerId)
      return res.status(400).json({ error: "partyLedgerId required" });

    const filter = {
      companyId,
      voucherType: "purchase",
      status: "posted",
      partyLedgerId,
    };
    if (q) {
      const rx = new RegExp(
        String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      filter.$or = [{ voucherNumber: rx }, { referenceNumber: rx }];
    }

    const bills = await Acc_Voucher.find(filter)
      .sort({ voucherDate: -1 })
      .limit(parseInt(limit))
      .select(
        "voucherNumber voucherDate grandTotal referenceNumber referenceDate",
      )
      .lean();

    // For each bill, compute already-debited amount from prior DNs
    const billIds = bills.map((b) => b._id);
    const priorDNs = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          voucherType: "debit_note",
          status: "posted",
          "originalBill.voucherId": { $in: billIds },
        },
      },
      {
        $group: {
          _id: "$originalBill.voucherId",
          totalDebited: { $sum: "$grandTotal" },
          count: { $sum: 1 },
        },
      },
    ]);
    const debitedMap = new Map(priorDNs.map((d) => [String(d._id), d]));

    const enriched = bills.map((b) => {
      const prior = debitedMap.get(String(b._id)) || {
        totalDebited: 0,
        count: 0,
      };
      const outstanding = Math.max(0, (b.grandTotal || 0) - prior.totalDebited);
      return {
        ...b,
        alreadyDebited: prior.totalDebited,
        priorDebitNoteCount: prior.count,
        outstandingForDebit: outstanding,
      };
    });

    res.json({ bills: enriched });
  } catch (e) {
    console.error("[bill-lookup]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Returns pending sales invoices for a customer with the outstanding
 * amount per invoice. Used by the Receipt form's bill-wise allocation
 * picker so the accountant can apply incoming money to specific bills.
 *
 * "Outstanding" here = grandTotal MINUS (sum of receipts already applied
 * to this bill via billAllocations.agst_ref) MINUS (sum of CN amounts
 * linked to this invoice).
 *
 * Query params:
 *   companyId      — required
 *   partyLedgerId  — required (customer)
 *   dateFrom       — optional, defaults to one year ago
 *   dateTo         — optional, defaults to today
 *   includeCleared — "1" to include fully-settled invoices (default off)
 *
 * Response:
 *   {
 *     invoices: [
 *       {
 *         _id, voucherNumber, voucherDate, grandTotal,
 *         alreadyReceived,           // from prior receipts
 *         alreadyCredited,           // from CNs
 *         outstanding,               // grandTotal - alreadyReceived - alreadyCredited
 *         ageInDays,                 // days since invoice date
 *       }
 *     ]
 *   }
 */
router.get("/unpaid-invoices", auth, async (req, res) => {
  try {
    const { companyId, partyLedgerId, dateFrom, dateTo, includeCleared } =
      req.query;
    if (!companyId || !partyLedgerId) {
      return res
        .status(400)
        .json({ error: "companyId and partyLedgerId required" });
    }

    const from = dateFrom
      ? new Date(dateFrom)
      : new Date(Date.now() - 365 * 86400000);
    const to = dateTo ? new Date(dateTo) : new Date();

    const invoices = await Acc_Voucher.find({
      companyId,
      voucherType: "sales",
      status: "posted",
      partyLedgerId,
      voucherDate: { $gte: from, $lte: to },
    })
      .sort({ voucherDate: 1 }) // oldest first — natural FIFO order
      .select(
        "voucherNumber voucherDate grandTotal placeOfSupplyCode placeOfSupply",
      )
      .limit(200)
      .lean();

    if (invoices.length === 0) {
      return res.json({ invoices: [] });
    }

    // ── Tally prior CN amounts (same logic as CN invoice-lookup) ──
    const invoiceIds = invoices.map((i) => i._id);
    const priorCNs = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          voucherType: "credit_note",
          status: { $in: ["posted", "pending_approval"] },
          "originalInvoice.voucherId": { $in: invoiceIds },
        },
      },
      {
        $group: {
          _id: "$originalInvoice.voucherId",
          totalCredited: { $sum: "$grandTotal" },
        },
      },
    ]);
    const creditedMap = new Map(
      priorCNs.map((c) => [String(c._id), c.totalCredited]),
    );

    // ── Tally prior receipt allocations against each invoice ──
    // Look at receipt vouchers for this party, scan their ledgerEntries
    // for billAllocations with billType "agst_ref" and a billName that
    // matches one of these invoice numbers. Sum those.
    const invoiceNumbers = invoices.map((i) => i.voucherNumber);
    const priorReceipts = await Acc_Voucher.find({
      companyId,
      voucherType: "receipt",
      status: "posted",
      partyLedgerId,
      "ledgerEntries.billAllocations.billName": { $in: invoiceNumbers },
    })
      .select("ledgerEntries")
      .lean();

    const receivedMap = new Map();
    for (const rcpt of priorReceipts) {
      for (const entry of rcpt.ledgerEntries || []) {
        for (const alloc of entry.billAllocations || []) {
          if (alloc.billType === "agst_ref" && alloc.billName) {
            // Match by invoice number; sum the allocated amount
            const inv = invoices.find(
              (i) => i.voucherNumber === alloc.billName,
            );
            if (inv) {
              const k = String(inv._id);
              receivedMap.set(
                k,
                (receivedMap.get(k) || 0) + (alloc.amount || 0),
              );
            }
          }
        }
      }
    }

    const today = new Date();
    const enriched = invoices.map((inv) => {
      const credited = creditedMap.get(String(inv._id)) || 0;
      const received = receivedMap.get(String(inv._id)) || 0;
      const outstanding = Math.max(
        0,
        (inv.grandTotal || 0) - credited - received,
      );
      const ageInDays = Math.floor(
        (today - new Date(inv.voucherDate)) / 86400000,
      );
      return {
        ...inv,
        alreadyCredited: credited,
        alreadyReceived: received,
        outstanding,
        ageInDays,
      };
    });

    const filtered =
      includeCleared === "1"
        ? enriched
        : enriched.filter((i) => i.outstanding > 0.01);

    res.json({ invoices: filtered });
  } catch (e) {
    console.error("[unpaid-invoices]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /unpaid-bills — AP mirror of /unpaid-invoices                    */
/* ------------------------------------------------------------------ */
/* Returns pending purchase bills for a vendor with the outstanding
 * amount per bill. Used by the Payment form's bill-wise allocation
 * picker so the accountant can apply outgoing money to specific bills.
 *
 * "Outstanding" = grandTotal MINUS (sum of payments already applied to
 *                 this bill via billAllocations.agst_ref) MINUS (sum
 *                 of DNs linked to this bill via originalBill.voucherId).
 *
 * Match nuance: payments may have been allocated using EITHER our
 * internal voucher # OR the supplier's invoice # as the billName, since
 * accountants type whichever they have in hand. We search by both.
 *
 * Query params:
 *   companyId      — required
 *   partyLedgerId  — required (vendor)
 *   dateFrom       — optional, defaults to one year ago
 *   dateTo         — optional, defaults to today
 *   includeCleared — "1" to include fully-settled bills (default off)
 */
router.get("/unpaid-bills", auth, async (req, res) => {
  try {
    const { companyId, partyLedgerId, dateFrom, dateTo, includeCleared } =
      req.query;
    if (!companyId || !partyLedgerId) {
      return res
        .status(400)
        .json({ error: "companyId and partyLedgerId required" });
    }

    const from = dateFrom
      ? new Date(dateFrom)
      : new Date(Date.now() - 365 * 86400000);
    const to = dateTo ? new Date(dateTo) : new Date();

    const bills = await Acc_Voucher.find({
      companyId,
      voucherType: "purchase",
      status: "posted",
      partyLedgerId,
      voucherDate: { $gte: from, $lte: to },
    })
      .sort({ voucherDate: 1 })
      .select(
        "voucherNumber voucherDate referenceNumber referenceDate dueDate grandTotal",
      )
      .limit(200)
      .lean();

    if (bills.length === 0) {
      return res.json({ bills: [] });
    }

    // ── Prior DN amounts against each bill ──
    const billIds = bills.map((b) => b._id);
    const priorDNs = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          voucherType: "debit_note",
          status: { $in: ["posted", "pending_approval"] },
          "originalBill.voucherId": { $in: billIds },
        },
      },
      {
        $group: {
          _id: "$originalBill.voucherId",
          totalDebited: { $sum: "$grandTotal" },
        },
      },
    ]);
    const debitedMap = new Map(
      priorDNs.map((d) => [String(d._id), d.totalDebited]),
    );

    // ── Prior payment allocations against each bill ──
    // Match by either our voucher # OR supplier ref, since the
    // allocating accountant types whichever they have on the bill.
    const billNumbers = bills.map((b) => b.voucherNumber).filter(Boolean);
    const supplierNumbers = bills.map((b) => b.referenceNumber).filter(Boolean);
    const lookupNames = [...new Set([...billNumbers, ...supplierNumbers])];

    const priorPayments = await Acc_Voucher.find({
      companyId,
      voucherType: "payment",
      status: "posted",
      partyLedgerId,
      "ledgerEntries.billAllocations.billName": { $in: lookupNames },
    })
      .select("ledgerEntries")
      .lean();

    const paidMap = new Map();
    for (const pay of priorPayments) {
      for (const entry of pay.ledgerEntries || []) {
        for (const alloc of entry.billAllocations || []) {
          if (alloc.billType === "agst_ref" && alloc.billName) {
            // Match against either voucher # or supplier ref
            const bill = bills.find(
              (b) =>
                b.voucherNumber === alloc.billName ||
                b.referenceNumber === alloc.billName,
            );
            if (bill) {
              const k = String(bill._id);
              paidMap.set(k, (paidMap.get(k) || 0) + (alloc.amount || 0));
            }
          }
        }
      }
    }

    const today = new Date();
    const enriched = bills.map((b) => {
      const debited = debitedMap.get(String(b._id)) || 0;
      const paid = paidMap.get(String(b._id)) || 0;
      const outstanding = Math.max(0, (b.grandTotal || 0) - debited - paid);
      const ageRef = b.dueDate ? new Date(b.dueDate) : new Date(b.voucherDate);
      const ageInDays = Math.floor((today - ageRef) / 86400000);
      const isOverdue =
        b.dueDate && outstanding > 0.01 && today > new Date(b.dueDate);
      return {
        ...b,
        alreadyDebited: debited,
        alreadyPaid: paid,
        outstanding,
        ageInDays,
        isOverdue,
      };
    });

    const filtered =
      includeCleared === "1"
        ? enriched
        : enriched.filter((b) => b.outstanding > 0.01);

    res.json({ bills: filtered });
  } catch (e) {
    console.error("[unpaid-bills]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /dispatch-lookup — Customer orders/dispatches for sales invoice  */
/* ------------------------------------------------------------------ */
router.get("/dispatch-lookup", auth, async (req, res) => {
  try {
    const { q, customerId, limit = 30 } = req.query;
    let CustomerRequest;
    try {
      CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    } catch {
      return res.json({
        orders: [],
        message: "CustomerRequest module not available",
      });
    }

    const filter = {};
    // Show orders that need invoicing — not yet fully invoiced
    if (!q) {
      filter.status = { $nin: ["cancelled", "rejected"] };
    }
    if (customerId) filter.customerId = customerId;
    if (q) {
      filter.$or = [
        {
          requestId: new RegExp(
            String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i",
          ),
        },
      ];
    }

    const requests = await CustomerRequest.find(filter)
      .populate("customerId", "name companyName email phone gstin")
      .select(
        "requestId quotations totalPaidAmount customerId status createdAt finalOrderPrice measurements",
      )
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const result = requests.map((r) => {
      const q0 = r.quotations?.[0];
      const items = q0?.items || q0?.lineItems || q0?.products || [];
      const grandTotal = q0?.grandTotal || r.finalOrderPrice || 0;
      const paid = r.totalPaidAmount || 0;
      return {
        _id: r._id,
        requestId: r.requestId,
        orderDate: r.createdAt,
        status: r.status,
        grandTotal,
        paid,
        outstanding: Math.max(0, grandTotal - paid),
        customer: r.customerId
          ? {
              _id: r.customerId._id,
              name: r.customerId.name || r.customerId.companyName,
              companyName: r.customerId.companyName,
              email: r.customerId.email,
              phone: r.customerId.phone,
              gstin: r.customerId.gstin,
            }
          : null,
        items: items.map((item) => ({
          name: item.productName || item.name || item.description || "",
          variant: item.variant || item.variantName || "",
          sku: item.sku || "",
          hsnCode: item.hsnCode || item.hsn || "",
          quantity: item.quantity || item.qty || 0,
          unit: item.unit || "Nos",
          rate: item.rate || item.unitPrice || item.price || 0,
          gstRate: item.gstRate || item.taxRate || 18,
          amount: item.amount || item.total || 0,
          discount: item.discount || 0,
        })),
        measurements: r.measurements || null,
        itemCount: items.length,
      };
    });

    res.json({ orders: result, count: result.length });
  } catch (e) {
    console.error("[dispatch-lookup]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /po-lookup — Search POs for purchase voucher auto-fill          */
/* ------------------------------------------------------------------ */
router.get("/po-lookup", auth, async (req, res) => {
  try {
    const { q, vendorId, limit = 20 } = req.query;
    let PurchaseOrder;
    try {
      PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    } catch {
      return res.json({
        purchaseOrders: [],
        message: "PO module not available",
      });
    }
    const filter = {};
    if (!q) filter.status = { $nin: ["CANCELLED", "cancelled", "Cancelled"] };
    if (vendorId) filter.vendor = vendorId;
    if (q)
      filter.poNumber = new RegExp(
        String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );

    const pos = await PurchaseOrder.find(filter)
      .populate("vendor", "companyName gstNumber email phone contactPerson")
      .populate("items.rawItem", "name sku unit category hsnCode gstRate")
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status items vendor gstDetails",
      )
      .sort({ orderDate: -1 })
      .limit(parseInt(limit))
      .lean();

    const result = pos.map((po) => ({
      _id: po._id,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      expectedDeliveryDate: po.expectedDeliveryDate,
      totalAmount: po.totalAmount,
      status: po.status,
      vendor: po.vendor
        ? {
            _id: po.vendor._id,
            companyName: po.vendor.companyName,
            gstNumber: po.vendor.gstNumber,
            email: po.vendor.email,
            phone: po.vendor.phone,
          }
        : null,
      items: (po.items || []).map((item) => ({
        _id: item._id,
        itemName: item.itemName || item.rawItem?.name || "",
        rawItemId: item.rawItem?._id || null,
        sku: item.rawItem?.sku || "",
        unit: item.rawItem?.unit || item.unit || "Nos",
        hsnCode: item.rawItem?.hsnCode || item.hsnCode || "",
        gstRate: item.rawItem?.gstRate || item.gstRate || 18,
        quantity: item.quantity || 0,
        unitPrice: item.unitPrice || 0,
        totalPrice: item.totalPrice || 0,
        receivedQuantity: item.receivedQuantity || 0,
        pendingQuantity:
          item.pendingQuantity || item.quantity - (item.receivedQuantity || 0),
        category: item.rawItem?.category || "",
      })),
    }));
    res.json({ purchaseOrders: result, count: result.length });
  } catch (e) {
    console.error("[po-lookup]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /raw-materials — Raw material items for purchase voucher        */
/* ------------------------------------------------------------------ */
router.get("/raw-materials", auth, async (req, res) => {
  try {
    const { companyId, q, limit = 500 } = req.query;
    const lim = parseInt(limit);
    const rx = q
      ? new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : null;
    let rawItems = [];
    try {
      const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
      const filter = {};
      if (rx) filter.$or = [{ name: rx }, { sku: rx }, { hsnCode: rx }];
      const items = await RawItem.find(filter)
        .sort({ name: 1 })
        .limit(lim)
        .select("name sku unit category hsnCode gstRate basePrice")
        .lean();
      rawItems = items.map((r) => ({
        _id: r._id,
        name: r.name,
        sku: r.sku || "",
        hsnCode: r.hsnCode || "",
        baseUnit: r.unit || "Nos",
        taxRate: r.gstRate || 0,
        standardCost: r.basePrice || 0,
        category: r.category || "",
        source: "cms_raw",
      }));
    } catch {
      try {
        const Product = require("../../models/CMS_Models/Inventory/Products/Product");
        const filter = {
          type: { $in: ["raw_material", "rawMaterial", "raw"] },
        };
        if (rx) filter.$or = [{ name: rx }, { sku: rx }];
        const items = await Product.find(filter)
          .sort({ name: 1 })
          .limit(lim)
          .lean();
        rawItems = items.map((r) => ({
          _id: r._id,
          name: r.name,
          sku: r.sku || "",
          hsnCode: r.hsnCode || "",
          baseUnit: r.unit || "Nos",
          taxRate: r.gstRate || 0,
          standardCost: r.basePrice || r.costPrice || 0,
          source: "cms_product",
        }));
      } catch {
        /* no CMS product model */
      }
    }
    if (companyId) {
      const tallyFilter = { companyId, isActive: true };
      if (rx)
        tallyFilter.$or = [{ name: rx }, { aliases: rx }, { hsnCode: rx }];
      const tallyRaw = await Acc_StockItem.find(tallyFilter)
        .sort({ name: 1 })
        .limit(lim)
        .select("name aliases hsnCode taxRate baseUnit standardCost")
        .lean();
      const seen = new Set(rawItems.map((r) => r.name?.toLowerCase()));
      for (const t of tallyRaw) {
        if (!seen.has(t.name?.toLowerCase()))
          rawItems.push({ ...t, source: "tally" });
      }
    }
    res.json({ items: rawItems, count: rawItems.length });
  } catch (e) {
    console.error("[raw-materials]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /roundoff-ledger — auto-find or create the Round Off ledger     */
/* ------------------------------------------------------------------ */
router.get("/roundoff-ledger", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    let led = await Acc_Ledger.findOne({
      companyId,
      isActive: true,
      name: /^rounding\s*off$/i,
    });
    if (!led) {
      led = await Acc_Ledger.findOne({
        companyId,
        isActive: true,
        name: { $in: [/^round\s*off$/i, /^round\s*off\s*a\/c$/i] },
      });
    }
    if (!led) {
      let grp =
        (await Acc_Group.findOne({ companyId, name: /indirect expense/i })) ||
        (await Acc_Group.findOne({ companyId, nature: "expense" }));
      if (grp) {
        led = await Acc_Ledger.create({
          companyId,
          name: "Rounding Off",
          groupId: grp._id,
          groupName: grp.name,
          nature: "expense",
          openingBalance: 0,
          isActive: true,
          description: "Auto-created for rounding adjustments",
        });
      }
    }
    res.json({ ledger: led || null });
  } catch (e) {
    console.error("[roundoff-ledger]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get one                                                             */
/* ------------------------------------------------------------------ */

router.get("/:id", auth, async (req, res) => {
  try {
    // Populate paths must match the schema field names exactly:
    //   ledgerEntries[].ledgerId   (NOT ledger — renamed in the unified schema)
    //   inventoryEntries[].stockItemId  (NOT stockItem)
    // Wrap the populate in try/catch so a single bad ref doesn't 500 the
    // whole voucher view — the denormalised name fields are already on
    // the entries themselves.
    let voucher;
    try {
      voucher = await Acc_Voucher.findById(req.params.id)
        .populate("partyLedgerId", "name groupName gstin")
        .populate("ledgerEntries.ledgerId", "name groupName")
        .populate("inventoryEntries.stockItemId", "name unit hsnCode")
        .lean();
    } catch (popErr) {
      console.warn(
        "[voucher/:id] populate failed, falling back to plain lookup:",
        popErr.message,
      );
      voucher = await Acc_Voucher.findById(req.params.id).lean();
    }
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    res.json(voucher);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get next voucher number (used by frontend on form open)             */
/* ------------------------------------------------------------------ */

router.get("/next-number/:companyId/:voucherType", auth, async (req, res) => {
  try {
    const { companyId, voucherType } = req.params;
    const { prefix } = req.query;
    const number = await Acc_Voucher.nextVoucherNumber(
      companyId,
      voucherType,
      prefix,
    );
    res.json({ voucherNumber: number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

router.post("/", auth, async (req, res) => {
  try {
    const body = req.body || {};
    // DEBUG: log what dispatch data arrives so we can confirm the client is
    // sending it. Remove once verified. Shows in the Node server console.
    if (body.voucherType === "sales") {
      console.log(
        "[vouchers POST] dispatchDetails received:",
        JSON.stringify(body.dispatchDetails || null),
      );
    }
    if (!body.companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!body.voucherType || !VOUCHER_TYPES.includes(body.voucherType))
      return res.status(400).json({ error: "Valid voucherType required" });
    if (!body.voucherDate)
      return res.status(400).json({ error: "voucherDate required" });
    if (!Array.isArray(body.ledgerEntries) || body.ledgerEntries.length === 0)
      return res
        .status(400)
        .json({ error: "At least one ledger entry required" });

    // Auto-number if not provided
    if (!body.voucherNumber) {
      body.voucherNumber = await Acc_Voucher.nextVoucherNumber(
        body.companyId,
        body.voucherType,
        body.numberingPrefix,
      );
    }

    body.financialYear = computeFY(body.voucherDate);
    body.createdBy = req.user?.id;

    // Resolve partyLedgerName if missing. Accept both legacy `partyLedger`
    // and current `partyLedgerId` field names from clients to avoid
    // breaking existing voucher-create payloads.
    const partyId = body.partyLedgerId || body.partyLedger;
    if (partyId) {
      body.partyLedgerId = partyId;
      if (!body.partyLedgerName) {
        const led = await Acc_Ledger.findById(partyId).select("name");
        if (led) body.partyLedgerName = led.name;
      }
    }
    delete body.partyLedger; // canonicalise — only partyLedgerId is saved

    // Resolve ledger names. Accept both legacy `ledger` and current
    // `ledgerId` from clients; canonicalise to `ledgerId`.
    //
    // If an entry has a NAME but no ID (e.g. the "Round Off" line the
    // sales form now emits), resolve it — and auto-create it if it truly
    // doesn't exist yet — so the voucher posts balanced instead of
    // silently dropping the rounding paise. This mirrors the idempotent
    // auto-create pattern already used for Sales/Purchase Returns ledgers.
    async function resolveOrCreateByName(name, companyId) {
      const clean = String(name || "").trim();
      if (!clean) return null;
      let led = await Acc_Ledger.findOne({
        companyId,
        name: new RegExp(
          `^${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      });
      if (led) return led;
      // Round Off is an indirect-expense-natured nominal ledger. Find a
      // sensible parent group; fall back to any expense-nature group.
      let grp =
        (await Acc_Group.findOne({
          companyId,
          name: /indirect expense/i,
        })) ||
        (await Acc_Group.findOne({ companyId, nature: "expense" })) ||
        (await Acc_Group.findOne({ companyId }));
      if (!grp) return null;
      led = await Acc_Ledger.create({
        companyId,
        name: clean,
        groupId: grp._id,
        groupName: grp.name,
        openingBalance: 0,
        openingBalanceType: "Dr",
        sourceSystem: "auto_from_voucher",
      });
      return led;
    }

    for (const entry of body.ledgerEntries) {
      const ledId = entry.ledgerId || entry.ledger;
      if (ledId) {
        entry.ledgerId = ledId;
        if (!entry.ledgerName) {
          const led = await Acc_Ledger.findById(ledId).select("name");
          if (led) entry.ledgerName = led.name;
        }
      } else if (entry.ledgerName) {
        const led = await resolveOrCreateByName(
          entry.ledgerName,
          body.companyId,
        );
        if (led) {
          entry.ledgerId = led._id;
          entry.ledgerName = led.name;
        }
      }
      delete entry.ledger;
      delete entry.autoLedger;
    }

    const voucher = new Acc_Voucher(body);

    // ── Approval workflow (sales vouchers only) ──────────────────────────────
    // An Editor (a user WITHOUT canPostDirectly) cannot post to the ledgers
    // directly. We save their sales voucher as a DRAFT (not posted — no ledger
    // impact) and register it in the unified approval queue (Acc_ApprovalRequest)
    // as a kind="voucher" action="post" request. An Owner/Approver then approves
    // it from the Approvals page, which runs the existing executor to flip the
    // draft to posted and apply balances. Owners/Approvers (canPostDirectly) are
    // unaffected and post directly as before.
    const perms = req.user?.permissions || {};
    const role = req.user?.role;
    // Roles that may always post directly, regardless of how the permissions
    // object was populated (guards against legacy/edge token shapes where
    // permissions might be incomplete). Editors/viewers do NOT post directly.
    const fullAccessRole =
      role === "owner" ||
      role === "approver" ||
      role === "admin" ||
      role === "accountant";
    const canPostDirectly = !!perms.canPostDirectly || fullAccessRole;
    const isSales = body.voucherType === "sales";
    const needsApproval = isSales && !canPostDirectly;

    if (needsApproval) {
      // Status pending_approval: NOT posted (no ledger impact) and the UI shows
      // it's awaiting review. The existing approval executor accepts both
      // "draft" and "pending_approval" when posting, so this is safe.
      voucher.status = "pending_approval";
      voucher.submittedBy = req.user?.id;
      voucher.submittedByName = req.user?.name || "";
      voucher.submittedAt = new Date();
      await voucher.save();

      // Register it in the unified approval queue so it shows on the
      // Approvals page for owners/approvers. We require an organizationId
      // (present on new-role tokens). If it's somehow missing we still leave
      // the voucher pending and tell the client it needs approval.
      try {
        const {
          Acc_ApprovalRequest,
        } = require("../../models/Accountant_model/Acc_OrgModels");
        if (req.user?.organizationId) {
          await Acc_ApprovalRequest.create({
            organizationId: req.user.organizationId,
            companyId: voucher.companyId,
            kind: "voucher",
            action: "post",
            title: `Post sales invoice ${voucher.voucherNumber} · ${
              voucher.partyLedgerName || "—"
            } · ₹${Number(voucher.grandTotal || 0).toLocaleString("en-IN")}`,
            target: { collection: "Acc_Voucher", id: voucher._id },
            payload: { voucherId: voucher._id },
            requestedBy: req.user.id,
            requestedByName: req.user.name || "",
            status: "pending",
          });
        }
      } catch (approvalErr) {
        // Don't fail the whole save if the queue write hiccups — the voucher
        // is safely pending and can be posted by an approver later.
        console.error(
          "[vouchers] approval-request create failed:",
          approvalErr.message,
        );
      }

      return res
        .status(201)
        .json({ ...voucher.toObject(), _pendingApproval: true });
    }

    await voucher.save();

    // Auto-post if requested and balanced (owners / approvers only reach here)
    if (body.autoPost && voucher.isBalanced) {
      voucher.status = "posted";
      voucher.postedBy = req.user?.id;
      voucher.postedAt = new Date();
      await voucher.save();
      await applyLedgerBalances(voucher, +1);
    }

    res.status(201).json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Update (only if draft)                                              */
/* ------------------------------------------------------------------ */

router.put("/:id", auth, async (req, res) => {
  try {
    const existing = await Acc_Voucher.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Voucher not found" });
    if (existing.status !== "draft")
      return res.status(400).json({
        error: `Cannot edit voucher in '${existing.status}' status. Cancel and create new.`,
      });

    const body = req.body || {};
    body.updatedBy = req.user?.id;
    if (body.voucherDate) body.financialYear = computeFY(body.voucherDate);

    Object.assign(existing, body);
    await existing.save();
    res.json(existing);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

router.post("/:id/post", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await Acc_Voucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "draft")
      throw new Error(`Voucher already ${voucher.status}`);
    if (!voucher.isBalanced)
      throw new Error("Voucher Dr/Cr totals do not balance — cannot post");

    voucher.status = "posted";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });
    await applyLedgerBalances(voucher, +1, session);

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/cancel", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await Acc_Voucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (!["posted", "draft"].includes(voucher.status))
      throw new Error(`Cannot cancel voucher in '${voucher.status}' status`);

    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1, session);
    }
    voucher.status = "cancelled";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/void", auth, async (req, res) => {
  try {
    const voucher = await Acc_Voucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1);
    }
    voucher.status = "void";
    voucher.updatedBy = req.user?.id;
    await voucher.save();
    res.json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Approval workflow — approve / reject a pending_approval voucher     */
/* ------------------------------------------------------------------ */

// Approve: only a user with canApprove (owner/approver) may approve. The
// voucher must be in pending_approval. On approve it becomes posted and its
// ledger balances are applied — exactly as if an approver had posted it.
router.post("/:id/approve", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const perms = req.user?.permissions || {};
    if (!perms.canApprove) {
      session.endSession();
      return res
        .status(403)
        .json({ error: "Only an approver or owner can approve vouchers." });
    }

    session.startTransaction();
    const voucher = await Acc_Voucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "pending_approval")
      throw new Error(
        `Only vouchers awaiting approval can be approved (this one is '${voucher.status}').`,
      );
    if (!voucher.isBalanced)
      throw new Error("Voucher Dr/Cr totals do not balance — cannot approve.");

    voucher.status = "posted";
    voucher.approvedBy = req.user?.id;
    voucher.approvedByName = req.user?.name || "";
    voucher.approvedAt = new Date();
    voucher.postedBy = req.user?.id;
    voucher.postedAt = new Date();
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });
    await applyLedgerBalances(voucher, +1, session);

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

// Reject: only canApprove. Moves a pending_approval voucher to cancelled with
// a reason. No ledger impact (it was never posted).
router.post("/:id/reject", auth, async (req, res) => {
  try {
    const perms = req.user?.permissions || {};
    if (!perms.canApprove) {
      return res
        .status(403)
        .json({ error: "Only an approver or owner can reject vouchers." });
    }

    const voucher = await Acc_Voucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status !== "pending_approval")
      return res.status(400).json({
        error: `Only vouchers awaiting approval can be rejected (this one is '${voucher.status}').`,
      });

    voucher.status = "cancelled";
    voucher.rejectedBy = req.user?.id;
    voucher.rejectedByName = req.user?.name || "";
    voucher.rejectedAt = new Date();
    voucher.rejectionReason =
      (req.body && req.body.reason) || "Rejected by approver";
    voucher.cancellationReason = voucher.rejectionReason;
    voucher.updatedBy = req.user?.id;
    await voucher.save();
    res.json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Delete (only drafts can be hard-deleted)                            */
/* ------------------------------------------------------------------ */

router.delete("/:id", auth, async (req, res) => {
  try {
    const voucher = await Acc_Voucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status !== "draft")
      return res.status(400).json({
        error:
          "Only draft vouchers can be deleted. Use cancel/void for posted.",
      });
    await voucher.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Bulk summary by type for a date range — for dashboards              */
/* ------------------------------------------------------------------ */

router.get("/summary/by-type", auth, async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const match = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: "posted",
    };
    if (dateFrom || dateTo) {
      match.voucherDate = {};
      if (dateFrom) match.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) match.voucherDate.$lte = new Date(dateTo);
    }

    const summary = await Acc_Voucher.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          totalDebit: { $sum: "$totalDebit" },
          totalCredit: { $sum: "$totalCredit" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
