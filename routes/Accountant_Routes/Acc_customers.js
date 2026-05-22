// routes/Accountant_Routes/Acc_customers.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Accounting-side models — used by the /accounting and /statement endpoints
// to bridge from the CRM Customer collection into the unified Acc_Voucher
// accounting ledger. Best-effort name match on the Sundry Debtor ledger.
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTED PARTY BRIDGE
// ─────────────────────────────────────────────────────────────────────────────
// The Customers page reads the CRM `Customer` collection. Parties that came
// in from a Tally import live as Acc_Ledger records under the "Sundry
// Debtors" group and were therefore invisible here. This helper pulls those
// imported ledgers, computes each one's revenue/paid/outstanding from its
// POSTED vouchers, and returns them shaped exactly like a customer row so
// they can be merged into the same list (no separate page, no data copy).
//
// A Sundry Debtor's natural balance is a DEBIT (they owe us):
//   revenue  ≈ total Debit posted to the ledger (sales raised)
//   paid     ≈ total Credit posted (receipts/settlements)
//   outstanding = max(0, signed closing balance) (net still owed)
async function importedPartyRows(companyId, { groupRx, kind }) {
  const Acc_Group =
    require("../../models/Accountant_model/Acc_MasterModels").Acc_Group;
  const Acc_Company =
    require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

  // The Customers/Vendors pages don't pass companyId. Resolve it: use the
  // passed value if any, else the primary company, else the only company.
  let cId = null;
  if (companyId) {
    try {
      cId = new mongoose.Types.ObjectId(companyId);
    } catch {
      cId = null;
    }
  }
  if (!cId) {
    let comp = await Acc_Company.findOne({ isPrimary: true })
      .select("_id")
      .lean();
    if (!comp) {
      const all = await Acc_Company.find({}).select("_id").limit(2).lean();
      if (all.length === 1) comp = all[0];
    }
    if (comp) cId = comp._id;
  }
  if (!cId) return [];

  const groups = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName")
    .lean();
  if (!groups.length) return [];

  const ids = new Set(
    groups.filter((g) => groupRx.test(g.name || "")).map((g) => String(g._id)),
  );
  let added = true;
  let guard = 0;
  while (added && guard < 20) {
    added = false;
    guard++;
    for (const g of groups) {
      if (ids.has(String(g._id))) continue;
      const pName = g.parentName;
      const pId = g.parent && String(g.parent);
      const parentResolved =
        (pId && ids.has(pId)) ||
        (pName &&
          groups.some((x) => x.name === pName && ids.has(String(x._id))));
      if (parentResolved) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  if (!ids.size) return [];
  const gIds = [...ids].map((s) => new mongoose.Types.ObjectId(s));

  const ledgers = await Acc_Ledger.find({
    companyId: cId,
    groupId: { $in: gIds },
  })
    .select(
      "name gstin aliases groupName openingBalance openingBalanceType email phone",
    )
    .lean();
  if (!ledgers.length) return [];

  const ledgerIds = ledgers.map((l) => l._id);
  const agg = await Acc_Voucher.aggregate([
    { $match: { companyId: cId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        dr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Dr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        cr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Cr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        orderCount: { $sum: 1 },
        lastOrderDate: { $max: "$voucherDate" },
      },
    },
  ]);
  const m = new Map(agg.map((a) => [String(a._id), a]));

  return ledgers.map((l) => {
    const a = m.get(String(l._id)) || {};
    const dr = a.dr || 0;
    const cr = a.cr || 0;
    const openSigned =
      (l.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(l.openingBalance || 0);
    // Use the NET-per-ledger basis so the page totals reconcile with the
    // Balance Sheet's Sundry Debtors figures (which net each ledger first,
    // then split Dr-balance vs Cr-balance ledgers). closingSigned = the
    // ledger's net balance including any opening.
    const closingSigned = openSigned + dr - cr;
    // Present the NET only, on the same basis as the Balance Sheet
    // (Sundry Debtors). For a customer:
    //   net DEBIT  (closingSigned > 0) → they still owe us → outstanding
    //   net CREDIT (closingSigned < 0) → advance from them  → no receivable
    // We don't fabricate gross revenue/paid splits (they don't tie to
    // Tally and were the source of the wrong figures).
    const stillOwed = closingSigned > 0 ? closingSigned : 0;
    const advanceFrom = closingSigned < 0 ? Math.abs(closingSigned) : 0;
    const netMagnitude = Math.abs(closingSigned);
    return {
      _id: l._id,
      isImported: true,
      source: "tally_ledger",
      customerCode: null,
      vendorCode: null,
      name: l.name,
      email: l.email || null,
      phone: l.phone || null,
      gstin: l.gstin || null,
      aliases: l.aliases || [],
      groupName: l.groupName || null,
      // Revenue = net business (closing magnitude); Paid = advance, if
      // they're in credit; Outstanding = what they still owe (net Dr).
      totalRevenue: netMagnitude,
      totalPaid: advanceFrom,
      totalOutstanding: stillOwed,
      balance: netMagnitude,
      balanceType: closingSigned < 0 ? "Cr" : "Dr",
      outstandingType: closingSigned < 0 ? "Cr" : "Dr",
      orderCount: a.orderCount || 0,
      completedCount: 0,
      lastOrderDate: a.lastOrderDate || null,
      _normName: String(l.name || "")
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(
          /\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|and|&)\b/g,
          " ",
        )
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      _gstinKey: (l.gstin || "").toUpperCase().replace(/\s+/g, ""),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer code — derived from MongoDB ObjectId, no schema change required.
//
// Why derive instead of store? Adding a new field to the Customer schema would
// leave existing records with null codes and require a backfill migration.
// Deriving is deterministic: every customer (existing or new) gets a stable,
// unique, searchable code computed at read time.
//
// Algorithm: take the last 3 bytes (6 hex chars) of the ObjectId — that's the
// counter portion, which is sequential — convert to base36, uppercase, pad to
// 5 chars. Result: "C-12K6B" (~16M unique codes per company, plenty).
//
// Searchability: the user can search by full code "C-12K6B" or just "12K6B" —
// the search handler matches either form against the computed codes of all
// customers.
// ─────────────────────────────────────────────────────────────────────────────
function customerCodeForId(objectId) {
  const hex = String(objectId).slice(-6);
  const num = parseInt(hex, 16);
  if (Number.isNaN(num)) return "C-00000";
  return "C-" + num.toString(36).toUpperCase().padStart(5, "0");
}

// Reverse the function for search: given a code, what does the trailing hex
// look like? Used to filter at the DB level for performance (rather than
// iterating every customer and computing each code).
function idSuffixFromCode(code) {
  // Strip prefix and any whitespace
  const stripped = String(code || "")
    .replace(/^C[\s-]*/i, "")
    .trim()
    .toUpperCase();
  if (!stripped) return null;
  const num = parseInt(stripped, 36);
  if (Number.isNaN(num) || num < 0 || num > 0xffffff) return null;
  return num.toString(16).padStart(6, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSortParam — normalize the sort query string into {field, direction}.
//
// Accepts both the legacy short forms and the new field-direction form so
// the existing dropdown ("Newest first" etc.) keeps working while column-
// header clicks send precise field-direction tokens.
//
// Legacy mappings:
//   "recent"      → { field: "created",      direction: "desc" }
//   "name"        → { field: "name",         direction: "asc"  }
//   "revenue"     → { field: "revenue",      direction: "desc" }
//   "outstanding" → { field: "outstanding",  direction: "desc" }
//
// New form: "<field>-<asc|desc>" where field is one of:
//   created | name | code | revenue | outstanding | paid | orders | lastOrder
//
// Unknown inputs fall back to { field: "created", direction: "desc" } so
// a stray query param can never break the listing.
// ─────────────────────────────────────────────────────────────────────────────
function parseSortParam(raw) {
  const legacy = {
    recent: { field: "created", direction: "desc" },
    name: { field: "name", direction: "asc" },
    revenue: { field: "revenue", direction: "desc" },
    outstanding: { field: "outstanding", direction: "desc" },
  };
  if (legacy[raw]) return legacy[raw];

  const [field, direction] = String(raw || "").split("-");
  const allowedFields = [
    "created",
    "name",
    "code",
    "revenue",
    "outstanding",
    "paid",
    "orders",
    "lastOrder",
  ];
  const allowedDirs = ["asc", "desc"];
  if (allowedFields.includes(field) && allowedDirs.includes(direction)) {
    return { field, direction };
  }
  return { field: "created", direction: "desc" };
}

// Import the accountant authentication middleware
// Alternatively, you can use the inline middleware below
// const AccountantAuthMiddleware = require('../../Middleware/AccountantAuthMiddleware');

// Middleware to verify accountant token (inline version)
const verifyAccountantToken = async (req, res, next) => {
  try {
    // 🔐 Read token from cookie (same as login system)
    const token = req.cookies.auth_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please sign in.",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );

    // Verify that user is an accountant
    if (decoded.role !== "accountant" || decoded.userType !== "accountant") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Accountant privileges required.",
      });
    }

    // Attach user info to request
    req.accountantId = decoded.id;
    req.user = {
      id: decoded.id,
      role: decoded.role,
      employeeId: decoded.employeeId,
      userType: decoded.userType,
    };

    next();
  } catch (error) {
    console.error("Accountant auth middleware error:", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER: getAllCustomersForExport
// Same logic as /all — merges CRM + imported Tally Sundry Debtors
// ─────────────────────────────────────────────────────────────────────────────
async function getAllCustomersForExport(companyId) {
  const allCustomers = await Customer.find({})
    .select("name companyName email phone gstin createdAt")
    .lean();
  const allIds = allCustomers.map((c) => c._id);

  let ledgerByCustomerId = new Map();
  try {
    const linked = await Acc_Ledger.find({
      linkedCustomerId: { $in: allIds },
      isActive: { $ne: false },
    })
      .select("_id linkedCustomerId")
      .lean();
    for (const ll of linked)
      ledgerByCustomerId.set(String(ll.linkedCustomerId), ll);
  } catch (_) {}

  const requestAgg = await CustomerRequest.aggregate([
    { $match: { customerId: { $in: allIds } } },
    {
      $project: {
        customerId: 1,
        totalPaidAmount: 1,
        createdAt: 1,
        firstQuotation: { $arrayElemAt: ["$quotations", 0] },
      },
    },
    {
      $group: {
        _id: "$customerId",
        totalRevenue: { $sum: { $ifNull: ["$firstQuotation.grandTotal", 0] } },
        totalPaid: { $sum: { $ifNull: ["$totalPaidAmount", 0] } },
        orderCount: { $sum: 1 },
        lastOrderDate: { $max: "$createdAt" },
      },
    },
  ]);
  const aggMap = new Map(requestAgg.map((a) => [String(a._id), a]));

  const crmRows = allCustomers.map((c) => {
    const a = aggMap.get(String(c._id)) || {};
    const ll = ledgerByCustomerId.get(String(c._id));
    const codeId = ll ? ll._id : c._id;
    return {
      code: customerCodeForId(codeId),
      name: c.name || c.companyName || "Unnamed",
      email: c.email || "",
      phone: c.phone || "",
      gstin: c.gstin || "",
      revenue: a.totalRevenue || 0,
      paid: a.totalPaid || 0,
      outstanding: Math.max(0, (a.totalRevenue || 0) - (a.totalPaid || 0)),
      orders: a.orderCount || 0,
      lastOrder: a.lastOrderDate
        ? new Date(a.lastOrderDate).toLocaleDateString("en-IN")
        : "",
      created: c.createdAt
        ? new Date(c.createdAt).toLocaleDateString("en-IN")
        : "",
      source: "crm",
    };
  });

  // Merge imported Tally Sundry Debtors
  let importedRows = [];
  try {
    const imported = await importedPartyRows(companyId, {
      groupRx: /sundry debtor/i,
      kind: "customer",
    });
    importedRows = imported.map((c) => ({
      code: c.customerCode || customerCodeForId(c._id),
      name: c.name || c.companyName || "Unnamed",
      email: c.email || "",
      phone: c.phone || "",
      gstin: c.gstin || "",
      revenue: c.totalRevenue || 0,
      paid: c.totalPaid || 0,
      outstanding: c.totalOutstanding || 0,
      orders: c.orderCount || 0,
      lastOrder: c.lastOrderDate
        ? new Date(c.lastOrderDate).toLocaleDateString("en-IN")
        : "",
      created: "",
      source: "tally",
    }));
  } catch (_) {}

  const all = [...crmRows, ...importedRows].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const totalRevenue = all.reduce((s, c) => s + c.revenue, 0);
  const totalPaid = all.reduce((s, c) => s + c.paid, 0);
  const totalOutstanding = all.reduce((s, c) => s + c.outstanding, 0);
  const withOutstanding = all.filter((c) => c.outstanding > 0).length;

  return {
    customers: all,
    totalRevenue,
    totalPaid,
    totalOutstanding,
    withOutstanding,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/customers
//
// List customers with financial summary per row + page-level KPIs.
//
// Query params:
//   page    — 1-indexed page number (default 1)
//   limit   — page size (default 20, max 100)
//   search  — matches customer code (full or partial), name, email, phone
//   sort    — name | revenue | outstanding | recent (default recent)
//   filter  — all | with_outstanding | new (default all)
//
// Response shape:
//   {
//     summary:    { totalCustomers, totalRevenue, totalPaid, totalOutstanding,
//                   customersWithOutstanding, newThisMonth },
//     customers:  [ { _id, customerCode, name, email, phone, gstin, ...
//                     totalRevenue, totalPaid, totalOutstanding, orderCount,
//                     lastOrderDate, createdAt } ],
//     pagination: { page, limit, total, totalPages }
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", verifyAccountantToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );
    const search = String(req.query.search || "").trim();
    // Sort param accepts:
    //   - legacy: "recent" | "name" | "revenue" | "outstanding"
    //   - new:    "<field>-<asc|desc>" e.g. "revenue-desc", "outstanding-asc",
    //             "name-asc", "code-desc", "paid-desc", "orders-asc",
    //             "lastOrder-desc", "created-desc".
    //
    // Derived fields (revenue/outstanding/paid/orders/lastOrder) are
    // computed AFTER fetching customers, so we route those through a
    // "full fetch → aggregate all → sort → paginate" path. Mongo-side
    // fields (name/code/created) use the regular indexed sort.
    const rawSort = String(req.query.sort || "recent");
    const { field: sortField, direction: sortDir } = parseSortParam(rawSort);
    const isDerivedSort = [
      "revenue",
      "outstanding",
      "paid",
      "orders",
      "lastOrder",
    ].includes(sortField);
    const filter = String(req.query.filter || "all");

    // Build the customer query.
    // Search matches: customer code (derived), name, email, phone.
    let baseQuery = {};
    if (search) {
      const codeSuffix = idSuffixFromCode(search);
      const orConditions = [
        { name: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
      // If search parses as a valid customer code, also match by ObjectId suffix.
      // We use a regex on the string form of _id since Mongo can't filter on
      // raw byte suffix without aggregation.
      if (codeSuffix) {
        orConditions.push({
          $expr: {
            $regexMatch: {
              input: { $toString: "$_id" },
              regex: `${codeSuffix}$`,
              options: "i",
            },
          },
        });
      }
      baseQuery = { $or: orConditions };
    }

    // Date filter for "new this month" KPI and the "new" filter
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (filter === "new") {
      baseQuery.createdAt = { $gte: monthStart };
    }

    // Total count (before pagination, after filtering)
    const total = await Customer.countDocuments(baseQuery);

    // ─── Build the sort spec for Mongo-side fields ───
    // We map the abstract sort field to the actual Customer document
    // field. "code" sorts by _id since the code is derived from the
    // ObjectId — same order. lastOrder/orders/revenue/etc. are derived
    // and handled in the derived path below.
    const dir = sortDir === "asc" ? 1 : -1;
    const mongoSortMap = {
      created: { createdAt: dir },
      name: { name: dir },
      code: { _id: dir }, // code is derived from _id, so same ordering
    };
    const mongoSortSpec = mongoSortMap[sortField] || { createdAt: -1 };

    // ─── Two fetch paths depending on whether the sort is derived ───
    //
    // Path A — Mongo-side sort (name/code/created): page first, then
    //   aggregate financials for only this page. Fast. This is the
    //   original flow.
    //
    // Path B — derived sort (revenue/outstanding/paid/orders/lastOrder):
    //   fetch ALL filtered customers, aggregate financials for all,
    //   sort the full set in memory, then paginate. Slower but
    //   required for correctness — sorting just the current page would
    //   only sort 20 rows and the "highest revenue" customer might be
    //   on page 4 entirely.
    let customers;

    if (isDerivedSort) {
      // Path B
      const allCustomers = await Customer.find(baseQuery)
        .select(
          "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
        )
        .lean();
      const allIds = allCustomers.map((c) => c._id);
      const fullAgg = await CustomerRequest.aggregate([
        { $match: { customerId: { $in: allIds } } },
        {
          $project: {
            customerId: 1,
            status: 1,
            totalPaidAmount: 1,
            finalOrderPrice: 1,
            createdAt: 1,
            firstQuotation: { $arrayElemAt: ["$quotations", 0] },
          },
        },
        {
          $group: {
            _id: "$customerId",
            totalRevenue: {
              $sum: { $ifNull: ["$firstQuotation.grandTotal", 0] },
            },
            totalPaid: { $sum: { $ifNull: ["$totalPaidAmount", 0] } },
            orderCount: { $sum: 1 },
            completedCount: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
            lastOrderDate: { $max: "$createdAt" },
          },
        },
      ]);
      const fullAggMap = new Map(fullAgg.map((a) => [String(a._id), a]));

      let enriched = allCustomers.map((c) => {
        const a = fullAggMap.get(String(c._id)) || {};
        const totalRevenue = a.totalRevenue || 0;
        const totalPaid = a.totalPaid || 0;
        return {
          ...c,
          customerCode: customerCodeForId(c._id),
          totalRevenue,
          totalPaid,
          totalOutstanding: Math.max(0, totalRevenue - totalPaid),
          orderCount: a.orderCount || 0,
          completedCount: a.completedCount || 0,
          lastOrderDate: a.lastOrderDate || null,
        };
      });

      // Apply derived filter (with_outstanding) BEFORE sorting +
      // paginating so "Page 2 of customers with outstanding" makes sense.
      if (filter === "with_outstanding") {
        enriched = enriched.filter((c) => c.totalOutstanding > 0);
      }

      // Sort by the requested derived field
      const sortFn = (a, b) => {
        const sign = sortDir === "asc" ? 1 : -1;
        switch (sortField) {
          case "revenue":
            return sign * ((a.totalRevenue || 0) - (b.totalRevenue || 0));
          case "outstanding":
            return (
              sign * ((a.totalOutstanding || 0) - (b.totalOutstanding || 0))
            );
          case "paid":
            return sign * ((a.totalPaid || 0) - (b.totalPaid || 0));
          case "orders":
            return sign * ((a.orderCount || 0) - (b.orderCount || 0));
          case "lastOrder": {
            const av = a.lastOrderDate
              ? new Date(a.lastOrderDate).getTime()
              : 0;
            const bv = b.lastOrderDate
              ? new Date(b.lastOrderDate).getTime()
              : 0;
            return sign * (av - bv);
          }
          default:
            return 0;
        }
      };
      enriched.sort(sortFn);

      // Paginate the sorted in-memory set
      customers = enriched.slice((page - 1) * limit, page * limit);
    } else {
      // Path A — Mongo-side sort
      customers = await Customer.find(baseQuery)
        .select(
          "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
        )
        .sort(mongoSortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      // Aggregate per-customer financials for THIS PAGE only (fast)
      const customerIds = customers.map((c) => c._id);
      const requestAgg = await CustomerRequest.aggregate([
        { $match: { customerId: { $in: customerIds } } },
        {
          $project: {
            customerId: 1,
            status: 1,
            totalPaidAmount: 1,
            finalOrderPrice: 1,
            createdAt: 1,
            firstQuotation: { $arrayElemAt: ["$quotations", 0] },
          },
        },
        {
          $group: {
            _id: "$customerId",
            totalRevenue: {
              $sum: { $ifNull: ["$firstQuotation.grandTotal", 0] },
            },
            totalPaid: { $sum: { $ifNull: ["$totalPaidAmount", 0] } },
            orderCount: { $sum: 1 },
            completedCount: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
            lastOrderDate: { $max: "$createdAt" },
          },
        },
      ]);
      const aggMap = new Map(requestAgg.map((a) => [String(a._id), a]));

      customers = customers.map((c) => {
        const a = aggMap.get(String(c._id)) || {};
        const totalRevenue = a.totalRevenue || 0;
        const totalPaid = a.totalPaid || 0;
        return {
          ...c,
          customerCode: customerCodeForId(c._id),
          totalRevenue,
          totalPaid,
          totalOutstanding: Math.max(0, totalRevenue - totalPaid),
          orderCount: a.orderCount || 0,
          completedCount: a.completedCount || 0,
          lastOrderDate: a.lastOrderDate || null,
        };
      });

      // Apply derived filters AFTER computing financials. NOTE: this
      // filter post-fetch is technically buggy at page boundaries
      // (the page count won't reflect the filtered count), but it's
      // the legacy behavior — preserved here to avoid changing
      // pagination semantics in this round.
      if (filter === "with_outstanding") {
        customers = customers.filter((c) => c.totalOutstanding > 0);
      }
    }

    // ── Page-level summary KPIs ──────────────────────────────────────────
    // These cover ALL customers (not just the current page), so we compute
    // separately. Cheap because the aggregation only runs over CustomerRequest.
    const [
      allRequestStats,
      totalCustomers,
      newThisMonthCount,
      customersWithReqIds,
    ] = await Promise.all([
      CustomerRequest.aggregate([
        {
          $project: {
            customerId: 1,
            totalPaidAmount: 1,
            firstQuotation: { $arrayElemAt: ["$quotations", 0] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: { $ifNull: ["$firstQuotation.grandTotal", 0] },
            },
            totalPaid: { $sum: { $ifNull: ["$totalPaidAmount", 0] } },
          },
        },
      ]),
      Customer.countDocuments({}),
      Customer.countDocuments({ createdAt: { $gte: monthStart } }),
      // For "customers with outstanding", we need per-customer outstanding > 0
      CustomerRequest.aggregate([
        {
          $project: {
            customerId: 1,
            outstanding: {
              $subtract: [
                {
                  $ifNull: [{ $arrayElemAt: ["$quotations.grandTotal", 0] }, 0],
                },
                { $ifNull: ["$totalPaidAmount", 0] },
              ],
            },
          },
        },
        { $group: { _id: "$customerId", total: { $sum: "$outstanding" } } },
        { $match: { total: { $gt: 0 } } },
        { $count: "withOutstanding" },
      ]),
    ]);

    const summary = {
      totalCustomers,
      totalRevenue: allRequestStats[0]?.totalRevenue || 0,
      totalPaid: allRequestStats[0]?.totalPaid || 0,
      totalOutstanding: Math.max(
        0,
        (allRequestStats[0]?.totalRevenue || 0) -
          (allRequestStats[0]?.totalPaid || 0),
      ),
      customersWithOutstanding: customersWithReqIds[0]?.withOutstanding || 0,
      newThisMonth: newThisMonthCount,
    };

    // ── Merge in imported Tally parties (Sundry Debtors) ─────────────
    // So everything that came from the import shows up here too, in the
    // same list, with revenue/paid/outstanding from its posted vouchers.
    try {
      const imported = await importedPartyRows(req.query.companyId, {
        groupRx: /sundry debtor/i,
        kind: "customer",
      });
      if (imported.length) {
        let merged = imported;
        if (search) {
          const sx = search.toLowerCase();
          merged = merged.filter(
            (c) =>
              (c.name || "").toLowerCase().includes(sx) ||
              (c.gstin || "").toLowerCase().includes(sx) ||
              (c.aliases || []).some((al) => al.toLowerCase().includes(sx)),
          );
        }
        if (filter === "with_outstanding") {
          merged = merged.filter((c) => c.totalOutstanding > 0);
        }
        // Imported parties are appended after CRM customers. They don't
        // paginate with the CRM set (different source) — show them all so
        // none are hidden. The page-level summary below counts them.
        customers = [...customers, ...merged];

        const impRevenue = imported.reduce(
          (s, c) => s + (c.totalRevenue || 0),
          0,
        );
        const impPaid = imported.reduce((s, c) => s + (c.totalPaid || 0), 0);
        const impOutstanding = imported.reduce(
          (s, c) => s + (c.totalOutstanding || 0),
          0,
        );
        summary.totalCustomers =
          (summary.totalCustomers || 0) + imported.length;
        summary.totalRevenue = (summary.totalRevenue || 0) + impRevenue;
        summary.totalPaid = (summary.totalPaid || 0) + impPaid;
        summary.totalOutstanding =
          (summary.totalOutstanding || 0) + impOutstanding;
        summary.customersWithOutstanding =
          (summary.customersWithOutstanding || 0) +
          imported.filter((c) => c.totalOutstanding > 0).length;
        total += imported.length;
      }
    } catch (impErr) {
      console.error(
        "[customers] imported-party merge skipped:",
        impErr.message,
      );
    }

    res.status(200).json({
      success: true,
      summary,
      customers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customers",
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /all — return EVERY customer with financials in a single response.
//
// Designed for client-side filtering, sorting, and pagination. The customers
// list page calls this once on initial load and never again (unless the user
// clicks Refresh), then handles all subsequent UI state changes in-browser.
//
// Why a separate endpoint instead of just removing pagination from `/`?
//   The paginated `/` endpoint is also consumed by other surfaces (some
//   reports / dashboards) that expect the page+limit+pagination response
//   shape. Splitting cleanly avoids breaking those callers.
//
// Performance notes:
//   • Single Customer.find() over the whole collection — fine for SMB
//     scale (hundreds → low thousands). Add pagination back if the
//     collection grows past ~10k.
//   • One CustomerRequest.aggregate() with all customer IDs $in — Mongo
//     handles this efficiently with an index on customerId.
//   • Total payload size: ~1KB per customer × ~thousands = manageable.
//
// Response shape mirrors `/` so existing summary KPI code keeps working,
// but instead of `pagination`, returns just `customers[]` + `summary`.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/all", verifyAccountantToken, async (req, res) => {
  try {
    // Fetch every customer (no filter, no pagination). The frontend
    // owns search/filter/sort from here on.
    const allCustomers = await Customer.find({})
      .select(
        "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
      )
      .lean();

    const allIds = allCustomers.map((c) => c._id);

    // One aggregation for all of them. Same shape as the paginated path.
    const requestAgg = await CustomerRequest.aggregate([
      { $match: { customerId: { $in: allIds } } },
      {
        $project: {
          customerId: 1,
          status: 1,
          totalPaidAmount: 1,
          finalOrderPrice: 1,
          createdAt: 1,
          firstQuotation: { $arrayElemAt: ["$quotations", 0] },
        },
      },
      {
        $group: {
          _id: "$customerId",
          totalRevenue: {
            $sum: { $ifNull: ["$firstQuotation.grandTotal", 0] },
          },
          totalPaid: { $sum: { $ifNull: ["$totalPaidAmount", 0] } },
          orderCount: { $sum: 1 },
          completedCount: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          lastOrderDate: { $max: "$createdAt" },
        },
      },
    ]);
    const aggMap = new Map(requestAgg.map((a) => [String(a._id), a]));

    // Batch-lookup linked Acc_Ledgers for all customers so the customer
    // code is derived from the LEDGER _id (matching Ledger Balances / CoA
    // search). Falls back to Customer._id when no ledger is linked.
    let ledgerByCustomerId = new Map();
    try {
      const linkedLedgers = await Acc_Ledger.find({
        linkedCustomerId: { $in: allIds },
        isActive: { $ne: false },
      })
        .select("_id linkedCustomerId")
        .lean();
      for (const ll of linkedLedgers) {
        ledgerByCustomerId.set(String(ll.linkedCustomerId), ll);
      }
    } catch (_) {
      /* Acc_Ledger may not be available */
    }

    const customers = allCustomers.map((c) => {
      const a = aggMap.get(String(c._id)) || {};
      const totalRevenue = a.totalRevenue || 0;
      const totalPaid = a.totalPaid || 0;
      const linkedLedger = ledgerByCustomerId.get(String(c._id));
      const codeSourceId = linkedLedger ? linkedLedger._id : c._id;
      return {
        ...c,
        customerCode: customerCodeForId(codeSourceId),
        ledgerId: linkedLedger?._id || null,
        totalRevenue,
        totalPaid,
        totalOutstanding: Math.max(0, totalRevenue - totalPaid),
        orderCount: a.orderCount || 0,
        completedCount: a.completedCount || 0,
        lastOrderDate: a.lastOrderDate || null,
      };
    });

    // ─── Page-level summary KPIs (same as `/`) ───
    // Aggregated across the FULL set, so the KPI strip on the page
    // matches what the user sees in the table when no filter is on.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalRevenue = customers.reduce((s, c) => s + c.totalRevenue, 0);
    const totalPaid = customers.reduce((s, c) => s + c.totalPaid, 0);
    const totalOutstanding = customers.reduce(
      (s, c) => s + c.totalOutstanding,
      0,
    );
    const customersWithOutstanding = customers.filter(
      (c) => c.totalOutstanding > 0,
    ).length;
    const newThisMonth = customers.filter(
      (c) => c.createdAt && new Date(c.createdAt) >= monthStart,
    ).length;

    // ── Merge in imported Tally parties (Sundry Debtors) ─────────────
    // /all is the endpoint the Customers page actually calls. Append the
    // imported Sundry Debtor ledgers so they show in the same list with
    // revenue/paid/outstanding from their posted vouchers.
    let allRows = customers;
    let impSummary = {
      count: 0,
      revenue: 0,
      paid: 0,
      outstanding: 0,
      withOutstanding: 0,
    };
    try {
      let imported = await importedPartyRows(req.query.companyId, {
        groupRx: /sundry debtor/i,
        kind: "customer",
      });
      if (imported.length) {
        // GHOST DETECTION vs CRM customers (by GSTIN, else norm name).
        const crmByGstin = new Map();
        const crmByName = new Map();
        for (const c of customers) {
          const g = (c.gstin || "").toUpperCase().replace(/\s+/g, "");
          if (g) crmByGstin.set(g, c);
          const n = String(c.name || "")
            .toLowerCase()
            .replace(/\(.*?\)/g, " ")
            .replace(
              /\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|and|&)\b/g,
              " ",
            )
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (n) crmByName.set(n, c);
        }
        imported = imported.map((c) => {
          let match = null;
          if (c._gstinKey && crmByGstin.has(c._gstinKey))
            match = crmByGstin.get(c._gstinKey);
          else if (c._normName && crmByName.has(c._normName))
            match = crmByName.get(c._normName);
          const ghost = match
            ? {
                isGhost: true,
                ghostOf: { id: match._id, name: match.name },
              }
            : {};
          const { _normName, _gstinKey, ...rest } = c;
          return { ...rest, ...ghost };
        });
        allRows = [...customers, ...imported];
        impSummary.count = imported.length;
        impSummary.revenue = imported.reduce(
          (s, c) => s + (c.totalRevenue || 0),
          0,
        );
        impSummary.paid = imported.reduce((s, c) => s + (c.totalPaid || 0), 0);
        impSummary.outstanding = imported.reduce(
          (s, c) => s + (c.totalOutstanding || 0),
          0,
        );
        impSummary.withOutstanding = imported.filter(
          (c) => c.totalOutstanding > 0,
        ).length;
      }
    } catch (impErr) {
      console.error("[customers/all] imported merge skipped:", impErr.message);
    }

    res.json({
      success: true,
      customers: allRows,
      summary: {
        totalCustomers: customers.length + impSummary.count,
        totalRevenue: parseFloat(
          (totalRevenue + impSummary.revenue).toFixed(2),
        ),
        totalPaid: parseFloat((totalPaid + impSummary.paid).toFixed(2)),
        totalOutstanding: parseFloat(
          (totalOutstanding + impSummary.outstanding).toFixed(2),
        ),
        customersWithOutstanding:
          customersWithOutstanding + impSummary.withOutstanding,
        newThisMonth,
      },
    });
  } catch (error) {
    console.error("Error fetching all customers:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching all customers",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /export/xlsx — Professional Excel export of all customers
// ─────────────────────────────────────────────────────────────────────────────
router.get("/export/xlsx", verifyAccountantToken, async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const {
      customers,
      totalRevenue,
      totalPaid,
      totalOutstanding,
      withOutstanding,
    } = await getAllCustomersForExport(req.query.companyId);

    // Build workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Accounts";
    wb.created = new Date();
    const ws = wb.addWorksheet("Customer Master", {
      views: [{ state: "frozen", ySplit: 6 }],
    });

    // Column widths
    ws.columns = [
      { width: 12 },
      { width: 35 },
      { width: 28 },
      { width: 16 },
      { width: 20 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 10 },
      { width: 14 },
      { width: 14 },
    ];

    // Title row
    ws.mergeCells("A1:K1");
    const titleCell = ws.getCell("A1");
    titleCell.value = "GRAV CLOTHING — Customer Master";
    titleCell.font = {
      name: "Arial",
      size: 14,
      bold: true,
      color: { argb: "FF1E293B" },
    };
    titleCell.alignment = { horizontal: "left", vertical: "middle" };
    ws.getRow(1).height = 30;

    // Subtitle
    ws.mergeCells("A2:K2");
    ws.getCell("A2").value =
      `Generated: ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })} · ${customers.length} customers`;
    ws.getCell("A2").font = {
      name: "Arial",
      size: 9,
      color: { argb: "FF64748B" },
    };

    // Summary strip (row 4)
    const summaryLabels = [
      "Total Customers",
      "Total Revenue",
      "Total Paid",
      "Total Outstanding",
      "With Outstanding",
    ];
    const summaryValues = [
      customers.length,
      totalRevenue,
      totalPaid,
      totalOutstanding,
      withOutstanding,
    ];
    summaryLabels.forEach((label, i) => {
      const col = i * 2 + 1;
      const labelCell = ws.getCell(4, col);
      labelCell.value = label;
      labelCell.font = {
        name: "Arial",
        size: 8,
        bold: true,
        color: { argb: "FF64748B" },
      };
      const valCell = ws.getCell(4, col + 1);
      valCell.value =
        typeof summaryValues[i] === "number" && i > 0
          ? summaryValues[i]
          : summaryValues[i];
      if (i >= 1 && i <= 3) valCell.numFmt = "₹#,##0";
      valCell.font = {
        name: "Arial",
        size: 10,
        bold: true,
        color: { argb: i === 3 ? "FFDC2626" : "FF1E293B" },
      };
    });
    ws.getRow(4).height = 22;

    // Header row (row 6)
    const headers = [
      "Code",
      "Customer Name",
      "Email",
      "Phone",
      "GSTIN",
      "Revenue",
      "Paid",
      "Outstanding",
      "Orders",
      "Last Order",
      "Registered",
    ];
    headers.forEach((h, i) => {
      const cell = ws.getCell(6, i + 1);
      cell.value = h;
      cell.font = {
        name: "Arial",
        size: 9,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4F46E5" },
      };
      cell.alignment = {
        horizontal: i >= 5 ? "right" : "left",
        vertical: "middle",
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FF4F46E5" } },
        bottom: { style: "thin", color: { argb: "FF4F46E5" } },
        left: { style: "thin", color: { argb: "FF4F46E5" } },
        right: { style: "thin", color: { argb: "FF4F46E5" } },
      };
    });
    ws.getRow(6).height = 24;

    // Data rows
    customers.forEach((c, idx) => {
      const row = ws.getRow(7 + idx);
      row.values = [
        c.code,
        c.name,
        c.email,
        c.phone,
        c.gstin,
        c.revenue,
        c.paid,
        c.outstanding,
        c.orders,
        c.lastOrder,
        c.created,
      ];

      // Formatting
      [6, 7, 8].forEach((col) => {
        row.getCell(col).numFmt = "₹#,##0.00";
      });
      row.getCell(1).font = {
        name: "Consolas",
        size: 9,
        color: { argb: "FF4F46E5" },
      };

      // Highlight outstanding > 0
      if (c.outstanding > 0) {
        row.getCell(8).font = {
          name: "Arial",
          size: 9,
          bold: true,
          color: { argb: "FFDC2626" },
        };
        row.getCell(8).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEF2F2" },
        };
      }

      // Zebra striping
      if (idx % 2 === 0) {
        for (let col = 1; col <= 11; col++) {
          if (!row.getCell(col).fill || !row.getCell(col).fill.fgColor) {
            row.getCell(col).fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF8FAFC" },
            };
          }
        }
      }

      // Default font for data cells
      const thinBorder = { style: "thin", color: { argb: "FFE2E8F0" } };
      for (let col = 1; col <= 11; col++) {
        const cell = row.getCell(col);
        if (!cell.font) cell.font = { name: "Arial", size: 9 };
        else if (!cell.font.name) cell.font.name = "Arial";
        cell.border = {
          top: thinBorder,
          bottom: thinBorder,
          left: thinBorder,
          right: thinBorder,
        };
      }
      row.height = 20;
    });

    // Auto-filter
    ws.autoFilter = { from: "A6", to: `K${6 + customers.length}` };

    // Send
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=customer-master-${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      return res
        .status(500)
        .json({ error: "exceljs not installed. Run: npm install exceljs" });
    }
    console.error("[customers/export/xlsx]", e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /export/pdf — Professional PDF export of all customers
// ─────────────────────────────────────────────────────────────────────────────
router.get("/export/pdf", verifyAccountantToken, async (req, res) => {
  try {
    const PDFDocument = require("pdfkit");
    const { customers, totalRevenue, totalPaid, totalOutstanding } =
      await getAllCustomersForExport(req.query.companyId);
    const fmtAmt = (n) =>
      "₹" +
      Number(n || 0).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    // Build PDF
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 40,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=customer-master-${new Date().toISOString().slice(0, 10)}.pdf`,
    );
    doc.pipe(res);

    // Header
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .fillColor("#1e293b")
      .text("GRAV CLOTHING", 40, 30);
    doc
      .fontSize(12)
      .font("Helvetica")
      .fillColor("#4f46e5")
      .text("Customer Master", 40, 52);
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#64748b")
      .text(
        `Generated: ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })} · ${customers.length} customers`,
        40,
        68,
      );

    // Divider
    doc
      .moveTo(40, 82)
      .lineTo(760, 82)
      .strokeColor("#e2e8f0")
      .lineWidth(1)
      .stroke();

    // Summary KPIs
    const kpis = [
      { label: "Total Customers", value: String(customers.length) },
      { label: "Total Revenue", value: fmtAmt(totalRevenue) },
      { label: "Total Paid", value: fmtAmt(totalPaid) },
      { label: "Outstanding", value: fmtAmt(totalOutstanding) },
    ];
    let kx = 40;
    kpis.forEach((k) => {
      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#64748b")
        .text(k.label.toUpperCase(), kx, 90);
      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .fillColor(k.label === "Outstanding" ? "#dc2626" : "#1e293b")
        .text(k.value, kx, 102);
      kx += 180;
    });

    // Table
    const tableTop = 125;
    const cols = [
      { label: "Code", x: 40, w: 65 },
      { label: "Customer", x: 105, w: 160 },
      { label: "Email", x: 265, w: 140 },
      { label: "Phone", x: 405, w: 80 },
      { label: "Revenue", x: 485, w: 80, align: "right" },
      { label: "Paid", x: 565, w: 80, align: "right" },
      { label: "Outstanding", x: 645, w: 80, align: "right" },
      { label: "Orders", x: 725, w: 35, align: "center" },
    ];

    // Header row
    doc.rect(40, tableTop, 720, 18).fill("#4f46e5");
    cols.forEach((col) => {
      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#ffffff")
        .text(col.label.toUpperCase(), col.x + 3, tableTop + 5, {
          width: col.w - 6,
          align: col.align || "left",
        });
    });

    // Data rows
    let y = tableTop + 20;
    const rowH = 16;
    let pageNum = 1;

    customers.forEach((c, idx) => {
      // Page break
      if (y + rowH > 540) {
        // Footer
        doc
          .fontSize(7)
          .font("Helvetica")
          .fillColor("#94a3b8")
          .text(`Page ${pageNum}`, 40, 550, { width: 720, align: "center" });
        doc.addPage();
        pageNum++;
        y = 40;
        // Re-draw header on new page
        doc.rect(40, y, 720, 18).fill("#4f46e5");
        cols.forEach((col) => {
          doc
            .fontSize(7)
            .font("Helvetica-Bold")
            .fillColor("#ffffff")
            .text(col.label.toUpperCase(), col.x + 3, y + 5, {
              width: col.w - 6,
              align: col.align || "left",
            });
        });
        y += 20;
      }

      // Zebra
      if (idx % 2 === 0) {
        doc.rect(40, y, 720, rowH).fill("#f8fafc");
      }

      // Outstanding highlight
      if (c.outstanding > 0) {
        doc.rect(645, y, 80, rowH).fill("#fef2f2");
      }

      doc.fillColor("#1e293b");
      doc
        .fontSize(7)
        .font("Courier")
        .fillColor("#4f46e5")
        .text(c.code, cols[0].x + 3, y + 4, { width: cols[0].w - 6 });
      doc
        .font("Helvetica")
        .fillColor("#1e293b")
        .text(c.name, cols[1].x + 3, y + 4, { width: cols[1].w - 6 });
      doc
        .fontSize(6)
        .fillColor("#64748b")
        .text(c.email, cols[2].x + 3, y + 4, { width: cols[2].w - 6 });
      doc.text(c.phone, cols[3].x + 3, y + 4, { width: cols[3].w - 6 });
      doc.fontSize(7).font("Courier").fillColor("#1e293b");
      doc.text(c.revenue > 0 ? fmtAmt(c.revenue) : "—", cols[4].x + 3, y + 4, {
        width: cols[4].w - 6,
        align: "right",
      });
      doc.text(c.paid > 0 ? fmtAmt(c.paid) : "—", cols[5].x + 3, y + 4, {
        width: cols[5].w - 6,
        align: "right",
      });
      doc.fillColor(c.outstanding > 0 ? "#dc2626" : "#1e293b");
      doc.text(
        c.outstanding > 0 ? fmtAmt(c.outstanding) : "—",
        cols[6].x + 3,
        y + 4,
        { width: cols[6].w - 6, align: "right" },
      );
      doc.fillColor("#1e293b").font("Helvetica");
      doc.text(c.orders > 0 ? String(c.orders) : "—", cols[7].x + 3, y + 4, {
        width: cols[7].w - 6,
        align: "center",
      });

      y += rowH;
    });

    // Total row
    doc.rect(40, y, 720, 18).fill("#eef2ff");
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#1e293b")
      .text("TOTAL", cols[1].x + 3, y + 5);
    doc.font("Courier-Bold");
    doc.text(fmtAmt(totalRevenue), cols[4].x + 3, y + 5, {
      width: cols[4].w - 6,
      align: "right",
    });
    doc.text(fmtAmt(totalPaid), cols[5].x + 3, y + 5, {
      width: cols[5].w - 6,
      align: "right",
    });
    doc
      .fillColor("#dc2626")
      .text(fmtAmt(totalOutstanding), cols[6].x + 3, y + 5, {
        width: cols[6].w - 6,
        align: "right",
      });

    // Footer
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#94a3b8")
      .text(`Page ${pageNum} · GRAV Accounts · Confidential`, 40, 550, {
        width: 720,
        align: "center",
      });

    doc.end();
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      return res
        .status(500)
        .json({ error: "pdfkit not installed. Run: npm install pdfkit" });
    }
    console.error("[customers/export/pdf]", e);
    res.status(500).json({ error: e.message });
  }
});

// GET single customer details
router.get("/:customerId", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = await Customer.findById(customerId)
      .select("-password -__v -cart -orders -favorites")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    // Attach the derived customer code so the detail view can show it
    customer.customerCode = customerCodeForId(customer._id);

    res.status(200).json({
      success: true,
      customer,
    });
  } catch (error) {
    console.error("Error fetching customer:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customer",
    });
  }
});

// GET customer requests with quotations and payment info
router.get("/:customerId/requests", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const requests = await CustomerRequest.find({ customerId })
      .select("-__v -notes")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      requests,
      count: requests.length,
    });
  } catch (error) {
    console.error("Error fetching customer requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customer requests",
    });
  }
});

// GET customer payment submissions
router.get("/:customerId/payments", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    // Get all requests with payment submissions
    const requests = await CustomerRequest.find({ customerId })
      .select("quotations.paymentSubmissions requestId")
      .lean();

    // Extract all payment submissions
    const allPayments = [];
    requests.forEach((request) => {
      if (request.quotations && request.quotations.length > 0) {
        request.quotations.forEach((quotation) => {
          if (
            quotation.paymentSubmissions &&
            quotation.paymentSubmissions.length > 0
          ) {
            quotation.paymentSubmissions.forEach((payment) => {
              allPayments.push({
                ...payment,
                requestId: request.requestId,
                quotationId: quotation._id,
              });
            });
          }
        });
      }
    });

    // Sort by submission date (newest first)
    allPayments.sort(
      (a, b) => new Date(b.submissionDate) - new Date(a.submissionDate),
    );

    res.status(200).json({
      success: true,
      payments: allPayments,
      count: allPayments.length,
    });
  } catch (error) {
    console.error("Error fetching customer payments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customer payments",
    });
  }
});

// GET customer financial summary
router.get(
  "/:customerId/financial-summary",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId } = req.params;

      const requests = await CustomerRequest.find({ customerId })
        .select("quotations totalPaidAmount finalOrderPrice")
        .lean();

      let totalAmount = 0;
      let totalPaid = 0;
      let pendingPayments = 0;
      let completedOrders = 0;

      requests.forEach((request) => {
        if (request.quotations && request.quotations.length > 0) {
          const quotation = request.quotations[0];
          if (quotation.grandTotal) {
            totalAmount += quotation.grandTotal;
          }
        }

        if (request.totalPaidAmount) {
          totalPaid += request.totalPaidAmount;
        }

        if (request.status === "completed") {
          completedOrders++;
        }

        // Check for pending payments
        if (request.quotations && request.quotations.length > 0) {
          const quotation = request.quotations[0];
          if (quotation.paymentSchedule) {
            const hasPending = quotation.paymentSchedule.some(
              (step) =>
                step.status === "pending" || step.status === "partially_paid",
            );
            if (hasPending) pendingPayments++;
          }
        }
      });

      const totalDue = totalAmount - totalPaid;

      res.status(200).json({
        success: true,
        summary: {
          totalAmount,
          totalPaid,
          totalDue,
          totalRequests: requests.length,
          completedOrders,
          pendingPayments,
        },
      });
    } catch (error) {
      console.error("Error fetching financial summary:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching financial summary",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId/accounting
// ─────────────────────────────────────────────────────────────────────────────
// Bridges the CRM `Customer` record to the unified accounting world.
//
// Why this endpoint exists:
//   The customer list page already shows revenue/paid/outstanding from the
//   CRM-side `CustomerRequest` collection (quotations → orders). But the
//   detail page also needs to show what's in the BOOKS — actual sales
//   vouchers, receipts, and credit notes posted to a Sundry Debtor ledger.
//
//   Those two worlds aren't yet linked at the schema level (no
//   linkedLedgerId field on Customer). So we do a best-effort name match
//   against Acc_Ledger here. It works for the common case where the
//   accountant created a Sundry Debtor ledger with the same name as the
//   CRM customer. When no match is found, we return an empty accounting
//   block — the UI shows a hint to create the ledger.
//
// Query params:
//   companyId — required (which set of books to look in)
//
// Response:
//   {
//     success: true,
//     ledger: { _id, name, currentBalance, balanceType, groupName } | null,
//     stats: {
//       totalInvoiced,   // sum of posted sales vouchers
//       totalReceived,   // sum of posted receipts
//       totalCredited,   // sum of posted credit notes
//       outstanding,     // invoiced - received - credited
//       invoiceCount, receiptCount, cnCount
//     },
//     recentInvoices: [...],     // last 10
//     recentReceipts: [...],     // last 10
//     recentCreditNotes: [...],  // last 10
//   }
router.get(
  "/:customerId/accounting",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId } = req.params;
      const { companyId } = req.query;
      if (!companyId) {
        return res.status(400).json({
          success: false,
          message: "companyId query param is required",
        });
      }

      const customer = await Customer.findById(customerId)
        .select("name companyName email")
        .lean();
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: "Customer not found",
        });
      }

      // Best-effort name match: try companyName first, then name. Both
      // case-insensitive exact match. We don't fuzzy-match because that
      // can silently link to the wrong ledger (a big accounting hazard).
      const candidates = [customer.companyName, customer.name].filter(Boolean);
      let ledger = null;
      for (const candidate of candidates) {
        const rx = new RegExp(
          "^" + candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
          "i",
        );
        ledger = await Acc_Ledger.findOne({
          companyId,
          isActive: true,
          name: rx,
        })
          .select("name currentBalance balanceType groupName groupId")
          .lean();
        if (ledger) break;
      }

      // If no linked ledger, return empty accounting view (UI shows a
      // call-to-action to create one).
      if (!ledger) {
        return res.status(200).json({
          success: true,
          ledger: null,
          stats: {
            totalInvoiced: 0,
            totalReceived: 0,
            totalCredited: 0,
            outstanding: 0,
            invoiceCount: 0,
            receiptCount: 0,
            cnCount: 0,
          },
          recentInvoices: [],
          recentReceipts: [],
          recentCreditNotes: [],
        });
      }

      // Pull all posted vouchers for this ledger. Limit to recent 200
      // each for performance — accountants who want the full history
      // can click through to the ledger statement page.
      const baseFilter = {
        companyId,
        status: "posted",
        partyLedgerId: ledger._id,
      };

      const [invoices, receipts, creditNotes] = await Promise.all([
        Acc_Voucher.find({ ...baseFilter, voucherType: "sales" })
          .sort({ voucherDate: -1 })
          .limit(200)
          .select(
            "voucherNumber voucherDate dueDate grandTotal subtotal totalTax",
          )
          .lean(),
        Acc_Voucher.find({ ...baseFilter, voucherType: "receipt" })
          .sort({ voucherDate: -1 })
          .limit(200)
          .select(
            "voucherNumber voucherDate grandTotal paymentMode instrumentNumber ledgerEntries",
          )
          .lean(),
        Acc_Voucher.find({ ...baseFilter, voucherType: "credit_note" })
          .sort({ voucherDate: -1 })
          .limit(200)
          .select(
            "voucherNumber voucherDate grandTotal originalInvoice creditNoteReason",
          )
          .lean(),
      ]);

      const totalInvoiced = invoices.reduce(
        (s, v) => s + (v.grandTotal || 0),
        0,
      );
      const totalReceived = receipts.reduce(
        (s, v) => s + (v.grandTotal || 0),
        0,
      );
      const totalCredited = creditNotes.reduce(
        (s, v) => s + (v.grandTotal || 0),
        0,
      );

      // Strip heavy ledgerEntries from receipts before sending, but keep
      // a derived "appliedToBills" summary for the UI's "what bill did
      // this settle" column.
      const slimReceipts = receipts.map((r) => {
        const bills = [];
        for (const entry of r.ledgerEntries || []) {
          for (const alloc of entry.billAllocations || []) {
            if (alloc.billType === "agst_ref" && alloc.billName) {
              bills.push({ billName: alloc.billName, amount: alloc.amount });
            }
          }
        }
        const { ledgerEntries, ...rest } = r;
        return { ...rest, appliedToBills: bills };
      });

      res.status(200).json({
        success: true,
        ledger,
        stats: {
          totalInvoiced,
          totalReceived,
          totalCredited,
          outstanding: Math.max(
            0,
            totalInvoiced - totalReceived - totalCredited,
          ),
          invoiceCount: invoices.length,
          receiptCount: receipts.length,
          cnCount: creditNotes.length,
        },
        recentInvoices: invoices.slice(0, 10),
        recentReceipts: slimReceipts.slice(0, 10),
        recentCreditNotes: creditNotes.slice(0, 10),
      });
    } catch (error) {
      console.error("Error fetching customer accounting:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching customer accounting",
      });
    }
  },
);

// GET pending payment verifications across all customers
router.get(
  "/payments/pending-verifications",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const requests = await CustomerRequest.find({
        "quotations.paymentSubmissions": { $exists: true, $ne: [] },
      })
        .populate("customerId", "name email phone")
        .select("requestId quotations.paymentSubmissions customerId")
        .lean();

      const pendingVerifications = [];

      requests.forEach((request) => {
        if (request.quotations && request.quotations.length > 0) {
          request.quotations.forEach((quotation) => {
            if (
              quotation.paymentSubmissions &&
              quotation.paymentSubmissions.length > 0
            ) {
              quotation.paymentSubmissions.forEach((payment) => {
                if (payment.status === "pending") {
                  pendingVerifications.push({
                    ...payment,
                    requestId: request.requestId,
                    customer: request.customerId,
                  });
                }
              });
            }
          });
        }
      });

      // Sort by submission date (oldest first for pending items)
      pendingVerifications.sort(
        (a, b) => new Date(a.submissionDate) - new Date(b.submissionDate),
      );

      res.status(200).json({
        success: true,
        pendingVerifications,
        count: pendingVerifications.length,
      });
    } catch (error) {
      console.error("Error fetching pending verifications:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching pending verifications",
      });
    }
  },
);

// MARK payment as verified (read-only marking for accountant tracking)
router.post(
  "/:customerId/payments/:paymentId/mark-reviewed",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId, paymentId } = req.params;
      const { notes } = req.body;

      const request = await CustomerRequest.findOne({
        customerId,
        "quotations.paymentSubmissions._id": paymentId,
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      // Find and update the payment submission
      let paymentFound = false;
      request.quotations.forEach((quotation) => {
        if (quotation.paymentSubmissions) {
          const payment = quotation.paymentSubmissions.id(paymentId);
          if (payment) {
            // Add accountant review note (doesn't change status, just adds tracking)
            if (!payment.accountantReview) {
              payment.accountantReview = [];
            }
            payment.accountantReview.push({
              reviewedBy: req.accountantId,
              reviewedAt: new Date(),
              notes: notes || "Reviewed by accountant",
            });
            paymentFound = true;
          }
        }
      });

      if (!paymentFound) {
        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      await request.save();

      res.status(200).json({
        success: true,
        message: "Payment marked as reviewed",
      });
    } catch (error) {
      console.error("Error marking payment as reviewed:", error);
      res.status(500).json({
        success: false,
        message: "Server error while marking payment",
      });
    }
  },
);

// GET customer statistics
router.get(
  "/:customerId/statistics",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId } = req.params;

      const requests = await CustomerRequest.find({ customerId })
        .select("status createdAt quotations totalPaidAmount")
        .lean();

      const stats = {
        totalRequests: requests.length,
        pendingRequests: requests.filter((r) => r.status === "pending").length,
        inProgressRequests: requests.filter((r) => r.status === "in_progress")
          .length,
        completedRequests: requests.filter((r) => r.status === "completed")
          .length,
        cancelledRequests: requests.filter((r) => r.status === "cancelled")
          .length,
        averageOrderValue: 0,
        totalRevenue: 0,
        lastOrderDate: null,
      };

      let totalRevenue = 0;
      let orderCount = 0;

      requests.forEach((request) => {
        if (request.quotations && request.quotations.length > 0) {
          const quotation = request.quotations[0];
          if (quotation.grandTotal) {
            totalRevenue += quotation.grandTotal;
            orderCount++;
          }
        }
      });

      stats.totalRevenue = totalRevenue;
      stats.averageOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

      // Get last order date
      if (requests.length > 0) {
        const sortedRequests = requests.sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        );
        stats.lastOrderDate = sortedRequests[0].createdAt;
      }

      res.status(200).json({
        success: true,
        statistics: stats,
      });
    } catch (error) {
      console.error("Error fetching customer statistics:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching statistics",
      });
    }
  },
);

// ✅ POST - Approve quotation (accountant approval for payment processing)
router.post(
  "/:customerId/requests/:requestId/quotations/:quotationId/approve",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId, requestId, quotationId } = req.params;
      const { notes } = req.body;

      // Find the request with the quotation
      const request = await CustomerRequest.findOne({
        _id: requestId,
        customerId: customerId,
        "quotations._id": quotationId,
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Request or quotation not found",
        });
      }

      // Find the specific quotation
      const quotation = request.quotations.id(quotationId);

      if (!quotation) {
        return res.status(404).json({
          success: false,
          message: "Quotation not found",
        });
      }

      // Check if customer has approved first
      if (!quotation.customerApproval || !quotation.customerApproval.approved) {
        return res.status(400).json({
          success: false,
          message: "Cannot approve: Customer approval required first",
        });
      }

      // Check if already approved
      if (
        quotation.accountantApproval &&
        quotation.accountantApproval.approved
      ) {
        return res.status(400).json({
          success: false,
          message: "Quotation already approved by accountant",
        });
      }

      // Approve the quotation
      if (!quotation.accountantApproval) {
        quotation.accountantApproval = {};
      }

      quotation.accountantApproval.approved = true;
      quotation.accountantApproval.approvedBy = req.accountantId;
      quotation.accountantApproval.approvedAt = new Date();
      quotation.accountantApproval.notes =
        notes || "Approved for payment processing";

      // Add to approval history
      if (!quotation.accountantApproval.approvalHistory) {
        quotation.accountantApproval.approvalHistory = [];
      }

      quotation.accountantApproval.approvalHistory.push({
        action: "approved",
        actionBy: req.accountantId,
        actionAt: new Date(),
        notes: notes || "Approved for payment processing",
      });

      await request.save();

      res.status(200).json({
        success: true,
        message: "Quotation approved successfully",
        quotation: {
          id: quotation._id,
          quotationNumber: quotation.quotationNumber,
          accountantApproval: quotation.accountantApproval,
        },
      });
    } catch (error) {
      console.error("Error approving quotation:", error);
      res.status(500).json({
        success: false,
        message: "Server error while approving quotation",
      });
    }
  },
);

// ✅ POST - Revoke quotation approval
router.post(
  "/:customerId/requests/:requestId/quotations/:quotationId/revoke-approval",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId, requestId, quotationId } = req.params;
      const { notes } = req.body;

      const request = await CustomerRequest.findOne({
        _id: requestId,
        customerId: customerId,
        "quotations._id": quotationId,
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Request or quotation not found",
        });
      }

      const quotation = request.quotations.id(quotationId);

      if (
        !quotation ||
        !quotation.accountantApproval ||
        !quotation.accountantApproval.approved
      ) {
        return res.status(400).json({
          success: false,
          message: "Quotation is not approved",
        });
      }

      // Revoke approval
      quotation.accountantApproval.approved = false;
      quotation.accountantApproval.approvalHistory.push({
        action: "revoked",
        actionBy: req.accountantId,
        actionAt: new Date(),
        notes: notes || "Approval revoked",
      });

      await request.save();

      res.status(200).json({
        success: true,
        message: "Approval revoked successfully",
      });
    } catch (error) {
      console.error("Error revoking approval:", error);
      res.status(500).json({
        success: false,
        message: "Server error while revoking approval",
      });
    }
  },
);

// GET pending quotations awaiting accountant approval
router.get("/pending-approvals", verifyAccountantToken, async (req, res) => {
  try {
    const requests = await CustomerRequest.find({
      "quotations.customerApproval.approved": true,
      "quotations.accountantApproval.approved": { $ne: true },
    })
      .populate("customerId", "name email phone")
      .select("requestId quotations customerId")
      .lean();

    const pendingApprovals = [];

    requests.forEach((request) => {
      if (request.quotations && request.quotations.length > 0) {
        request.quotations.forEach((quotation) => {
          // Check if customer approved but accountant hasn't
          if (
            quotation.customerApproval?.approved &&
            (!quotation.accountantApproval ||
              !quotation.accountantApproval.approved)
          ) {
            pendingApprovals.push({
              requestId: request.requestId,
              quotationId: quotation._id,
              quotationNumber: quotation.quotationNumber,
              grandTotal: quotation.grandTotal,
              customer: request.customerId,
              customerApprovedAt: quotation.customerApproval.approvedAt,
              createdAt: quotation.createdAt,
            });
          }
        });
      }
    });

    // Sort by oldest first (FIFO)
    pendingApprovals.sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    );

    res.status(200).json({
      success: true,
      pendingApprovals,
      count: pendingApprovals.length,
    });
  } catch (error) {
    console.error("Error fetching pending approvals:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching pending approvals",
    });
  }
});

module.exports = router;
