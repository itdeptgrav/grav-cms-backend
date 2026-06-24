// routes/Accountant_Routes/Acc_customers.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTED PARTY BRIDGE
// ─────────────────────────────────────────────────────────────────────────────
async function importedPartyRows(companyId, { groupRx, kind }) {
  const Acc_Group =
    require("../../models/Accountant_model/Acc_MasterModels").Acc_Group;
  const Acc_Company =
    require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

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

  // Only return ledgers NOT linked to any CRM customer. A ledger linked to a
  // customer IS that customer's own accounting ledger — it shows as part of the
  // customer's data (and on the detail page), never as a separate "ghost" row.
  // Per the import model, every matched/created Tally party gets linked, so the
  // real duplicates live at the CRM-customer level and are caught by the
  // CRM-to-CRM detection in /all. This prevents a customer's own ledger from
  // appearing as a phantom ghost of itself.
  const ledgers = await Acc_Ledger.find({
    companyId: cId,
    groupId: { $in: gIds },
    isActive: { $ne: false },
    linkedCustomerId: { $in: [null, undefined] },
  })
    .select(
      "name gstin aliases groupName openingBalance openingBalanceType email phone linkedCustomerId",
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
    const closingSigned = openSigned + dr - cr;
    const stillOwed = closingSigned > 0 ? closingSigned : 0;
    const advanceFrom = closingSigned < 0 ? Math.abs(closingSigned) : 0;
    const netMagnitude = Math.abs(closingSigned);
    return {
      _id: l._id,
      isImported: true,
      isLedgerOnly: true, // has a ledger but no real CRM account
      accountStatus: "ledger_only", // for the frontend badge
      source: "tally_ledger",
      // Give it a code derived from the ledger _id so it's identifiable and
      // searchable just like a real customer (was null before).
      customerCode: customerCodeForId(l._id),
      vendorCode: null,
      ledgerId: l._id,
      name: l.name,
      email: l.email || null,
      phone: l.phone || null,
      gstin: l.gstin || null,
      aliases: l.aliases || [],
      groupName: l.groupName || null,
      totalRevenue: netMagnitude,
      totalPaid: advanceFrom,
      totalOutstanding: stillOwed,
      // Ledger-only party: figures ARE the books figures; it has no CRM side.
      ledgerRevenue: netMagnitude,
      ledgerPaid: advanceFrom,
      ledgerOutstanding: stillOwed,
      voucherCount: a.orderCount || 0,
      ledgerLastDate: a.lastOrderDate || null,
      crmRevenue: 0,
      crmPaid: 0,
      crmOutstanding: 0,
      crmOrderCount: 0,
      crmLastOrderDate: null,
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
      // passed to ghost detection so it can skip already-linked ledgers
      _linkedCustomerId: l.linkedCustomerId || null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer code helpers
// ─────────────────────────────────────────────────────────────────────────────
function customerCodeForId(objectId) {
  const hex = String(objectId).slice(-6);
  const num = parseInt(hex, 16);
  if (Number.isNaN(num)) return "C-00000";
  return "C-" + num.toString(36).toUpperCase().padStart(5, "0");
}

function idSuffixFromCode(code) {
  const stripped = String(code || "")
    .replace(/^C[\s-]*/i, "")
    .trim()
    .toUpperCase();
  if (!stripped) return null;
  const num = parseInt(stripped, 36);
  if (Number.isNaN(num) || num < 0 || num > 0xffffff) return null;
  return num.toString(16).padStart(6, "0");
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────
// Delegate to the org-aware middleware so the owner AND sub-accounts
// (approver/editor/viewer) authenticate the same way as the rest of the
// accountant module. The old version read only the legacy `auth_token` cookie,
// so sub-accounts — who carry an `accountant_token` and no `auth_token` — always
// got 401 here. orgAuth accepts accountant_token / auth_token / Bearer, both token
// shapes, and also enforces isActive + "log out of all devices" on these routes.
const {
  orgAuth: _orgAuthForCustomers,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");
const verifyAccountantToken = (req, res, next) => {
  _orgAuthForCustomers(req, res, () => {
    // Some customer routes read req.accountantId — keep it populated.
    if (req.user && req.user.id) req.accountantId = req.user.id;
    next();
  });
};
// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER: getAllCustomersForExport
// ─────────────────────────────────────────────────────────────────────────────
async function getAllCustomersForExport(companyId) {
  // Filter out deactivated (merged ghost) customers
  const allCustomers = await Customer.find({ isActive: { $ne: false } })
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
// GET /  — paginated list
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", verifyAccountantToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );
    const search = String(req.query.search || "").trim();
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

    let baseQuery = { isActive: { $ne: false } };
    if (search) {
      const codeSuffix = idSuffixFromCode(search);
      const orConditions = [
        { name: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
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
      baseQuery = { ...baseQuery, $or: orConditions };
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (filter === "new") {
      baseQuery.createdAt = { $gte: monthStart };
    }

    let total = await Customer.countDocuments(baseQuery);
    const dir = sortDir === "asc" ? 1 : -1;
    const mongoSortMap = {
      created: { createdAt: dir },
      name: { name: dir },
      code: { _id: dir },
    };
    const mongoSortSpec = mongoSortMap[sortField] || { createdAt: -1 };

    let customers;

    if (isDerivedSort) {
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

      if (filter === "with_outstanding") {
        enriched = enriched.filter((c) => c.totalOutstanding > 0);
      }

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
      customers = enriched.slice((page - 1) * limit, page * limit);
    } else {
      customers = await Customer.find(baseQuery)
        .select(
          "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
        )
        .sort(mongoSortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

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

      if (filter === "with_outstanding") {
        customers = customers.filter((c) => c.totalOutstanding > 0);
      }
    }

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
      Customer.countDocuments({ isActive: { $ne: false } }),
      Customer.countDocuments({
        isActive: { $ne: false },
        createdAt: { $gte: monthStart },
      }),
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /all — full unpaginated list for the Customers page
// ─────────────────────────────────────────────────────────────────────────────
router.get("/all", verifyAccountantToken, async (req, res) => {
  try {
    // FIX: filter out deactivated (merged ghost) CRM customers
    const allCustomers = await Customer.find({ isActive: { $ne: false } })
      .select(
        "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
      )
      .lean();

    const allIds = allCustomers.map((c) => c._id);

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

    // Batch-lookup linked Acc_Ledgers.
    // ledgerVoucherBalByCustomerId accumulates the NET Acc_Voucher balance
    // for each keeper after a merge, so the list shows combined totals.
    let ledgerByCustomerId = new Map();
    let ledgerVoucherBalByCustomerId = new Map();

    try {
      const linkedLedgers = await Acc_Ledger.find({
        linkedCustomerId: { $in: allIds },
        isActive: { $ne: false },
      })
        .select("_id linkedCustomerId openingBalance openingBalanceType")
        .lean();

      for (const ll of linkedLedgers) {
        ledgerByCustomerId.set(String(ll.linkedCustomerId), ll);
      }

      if (linkedLedgers.length > 0) {
        const linkedLedgerIds = linkedLedgers.map((l) => l._id);

        const vAgg = await Acc_Voucher.aggregate([
          { $match: { status: "posted" } },
          { $unwind: "$ledgerEntries" },
          { $match: { "ledgerEntries.ledgerId": { $in: linkedLedgerIds } } },
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
              voucherCount: { $addToSet: "$_id" },
              lastVoucherDate: { $max: "$voucherDate" },
            },
          },
        ]);
        const vAggMap = new Map(vAgg.map((a) => [String(a._id), a]));

        for (const ll of linkedLedgers) {
          const a = vAggMap.get(String(ll._id)) || {};
          const openSigned =
            (ll.openingBalanceType === "Cr" ? -1 : 1) *
            Math.abs(ll.openingBalance || 0);
          // Sundry Debtor: positive closing = they owe us
          const closingSigned = openSigned + (a.dr || 0) - (a.cr || 0);
          const outstanding = closingSigned > 0 ? closingSigned : 0;
          const paid = closingSigned < 0 ? Math.abs(closingSigned) : 0;
          ledgerVoucherBalByCustomerId.set(String(ll.linkedCustomerId), {
            outstanding: parseFloat(outstanding.toFixed(2)),
            paid: parseFloat(paid.toFixed(2)),
            revenue: parseFloat(
              (Math.abs(closingSigned) + (a.cr || 0)).toFixed(2),
            ),
            orderCount: a.voucherCount ? a.voucherCount.length : 0,
            lastOrderDate: a.lastVoucherDate || null,
          });
        }
      }
    } catch (_) {
      // Acc_Ledger / Acc_Voucher not available — CRM figures only
    }

    const customers = allCustomers.map((c) => {
      const a = aggMap.get(String(c._id)) || {};
      const totalRevenue = a.totalRevenue || 0;
      const totalPaid = a.totalPaid || 0;
      const linkedLedger = ledgerByCustomerId.get(String(c._id));
      const codeSourceId = linkedLedger ? linkedLedger._id : c._id;

      // Supplement CRM figures with Acc_Ledger-based voucher balance.
      // After a merge, the ghost ledger is linked here so the keeper row
      // shows combined (CRM orders + Tally vouchers) totals immediately.
      const ledgerBal = ledgerVoucherBalByCustomerId.get(String(c._id));
      const combinedRevenue = totalRevenue + (ledgerBal?.revenue || 0);
      const combinedPaid = totalPaid + (ledgerBal?.paid || 0);
      const combinedOutstanding = Math.max(
        0,
        totalRevenue - totalPaid + (ledgerBal?.outstanding || 0),
      );
      const combinedOrderCount =
        (a.orderCount || 0) + (ledgerBal?.orderCount || 0);
      const crmLast = a.lastOrderDate ? new Date(a.lastOrderDate).getTime() : 0;
      const ledgerLast = ledgerBal?.lastOrderDate
        ? new Date(ledgerBal.lastOrderDate).getTime()
        : 0;
      const combinedLastOrder =
        crmLast || ledgerLast ? new Date(Math.max(crmLast, ledgerLast)) : null;

      return {
        ...c,
        customerCode: customerCodeForId(codeSourceId),
        ledgerId: linkedLedger?._id || null,
        // ── Side-separated figures (NO mixing of CRM and books) ──────────
        // CRM (orders/quotations) — shown on the Sales/CRM side
        crmRevenue: parseFloat(totalRevenue.toFixed(2)),
        crmPaid: parseFloat(totalPaid.toFixed(2)),
        crmOutstanding: parseFloat(
          Math.max(0, totalRevenue - totalPaid).toFixed(2),
        ),
        crmOrderCount: a.orderCount || 0,
        crmLastOrderDate: a.lastOrderDate || null,
        // Books (posted ledger vouchers) — shown on the Accounting side
        ledgerRevenue: parseFloat((ledgerBal?.revenue || 0).toFixed(2)),
        ledgerPaid: parseFloat((ledgerBal?.paid || 0).toFixed(2)),
        ledgerOutstanding: parseFloat((ledgerBal?.outstanding || 0).toFixed(2)),
        voucherCount: ledgerBal?.orderCount || 0,
        ledgerLastDate: ledgerBal?.lastOrderDate || null,
        // Legacy combined fields (kept so other callers don't break)
        totalRevenue: parseFloat(combinedRevenue.toFixed(2)),
        totalPaid: parseFloat(combinedPaid.toFixed(2)),
        totalOutstanding: parseFloat(combinedOutstanding.toFixed(2)),
        orderCount: combinedOrderCount,
        completedCount: a.completedCount || 0,
        lastOrderDate: combinedLastOrder,
      };
    });

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

    // ── Duplicate detection with SMART keeper selection ──────────────────
    // When parties-sync import runs, it creates NEW CRM Customer records for
    // Tally parties. These duplicates must be merged into the customer that
    // ALREADY HAS the real data.
    //
    // KEEPER selection (the customer to KEEP — never flagged as ghost):
    //   1. Has a linked accounting ledger (ledgerId set) — holds the vouchers
    //   2. Most orders
    //   3. Most revenue
    //   4. Oldest (smallest ObjectId) as final tie-breaker
    // Choosing the data-rich customer as keeper means the merge re-points the
    // ghost's vouchers INTO the keeper's existing ledger — exactly what's needed.
    const normalizeCrm = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(
          /\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|and|&)\b/g,
          " ",
        )
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // pickBetter — returns whichever of the two should be the keeper
    const pickBetter = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      const aL = a.ledgerId ? 1 : 0,
        bL = b.ledgerId ? 1 : 0;
      if (aL !== bL) return aL > bL ? a : b;
      const aO = a.orderCount || 0,
        bO = b.orderCount || 0;
      if (aO !== bO) return aO > bO ? a : b;
      const aR = a.totalRevenue || 0,
        bR = b.totalRevenue || 0;
      if (aR !== bR) return aR > bR ? a : b;
      return String(a._id) < String(b._id) ? a : b; // older wins ties
    };

    const crmKeeperByGstin = new Map(); // GSTIN → best keeper
    const crmKeeperByName = new Map(); // normalized name → best keeper

    for (const c of customers) {
      const g = (c.gstin || "").toUpperCase().replace(/\s+/g, "");
      const n = normalizeCrm(c.name || c.companyName || "");
      if (g) crmKeeperByGstin.set(g, pickBetter(crmKeeperByGstin.get(g), c));
      if (n) crmKeeperByName.set(n, pickBetter(crmKeeperByName.get(n), c));
    }

    // Flag every CRM customer that is NOT the keeper of its group as a ghost
    const customersWithCrmGhosts = customers.map((c) => {
      const g = (c.gstin || "").toUpperCase().replace(/\s+/g, "");
      const n = normalizeCrm(c.name || c.companyName || "");
      const keeper =
        (g && crmKeeperByGstin.get(g)) || (n && crmKeeperByName.get(n)) || null;
      if (keeper && String(keeper._id) !== String(c._id)) {
        return {
          ...c,
          isGhost: true,
          ghostOf: { id: keeper._id, name: keeper.name || keeper.companyName },
        };
      }
      return c;
    });

    let allRows = customersWithCrmGhosts;
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
        // For imported Tally entries, match against the OLDEST keeper (same maps)
        imported = imported.map((c) => {
          let match = null;
          if (c._gstinKey && crmKeeperByGstin.has(c._gstinKey))
            match = crmKeeperByGstin.get(c._gstinKey);
          else if (c._normName && crmKeeperByName.has(c._normName))
            match = crmKeeperByName.get(c._normName);

          // Skip if already properly linked to this exact CRM customer
          if (
            match &&
            c._linkedCustomerId &&
            String(c._linkedCustomerId) === String(match._id)
          ) {
            match = null;
          }

          const ghost = match
            ? {
                isGhost: true,
                ghostOf: {
                  id: match._id,
                  name: match.name || match.companyName,
                },
              }
            : {};
          const { _normName, _gstinKey, _linkedCustomerId, ...rest } = c;
          return { ...rest, ...ghost };
        });
        allRows = [...customersWithCrmGhosts, ...imported];
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
// GET /export/xlsx
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

    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Accounts";
    wb.created = new Date();
    const ws = wb.addWorksheet("Customer Master", {
      views: [{ state: "frozen", ySplit: 6 }],
    });

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

    ws.mergeCells("A2:K2");
    ws.getCell("A2").value =
      `Generated: ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })} · ${customers.length} customers`;
    ws.getCell("A2").font = {
      name: "Arial",
      size: 9,
      color: { argb: "FF64748B" },
    };

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
      valCell.value = summaryValues[i];
      if (i >= 1 && i <= 3) valCell.numFmt = "₹#,##0";
      valCell.font = {
        name: "Arial",
        size: 10,
        bold: true,
        color: { argb: i === 3 ? "FFDC2626" : "FF1E293B" },
      };
    });
    ws.getRow(4).height = 22;

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
      [6, 7, 8].forEach((col) => {
        row.getCell(col).numFmt = "₹#,##0.00";
      });
      row.getCell(1).font = {
        name: "Consolas",
        size: 9,
        color: { argb: "FF4F46E5" },
      };
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

    ws.autoFilter = { from: "A6", to: `K${6 + customers.length}` };

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
// GET /export/pdf
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
    doc
      .moveTo(40, 82)
      .lineTo(760, 82)
      .strokeColor("#e2e8f0")
      .lineWidth(1)
      .stroke();

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

    let y = tableTop + 20;
    const rowH = 16;
    let pageNum = 1;

    customers.forEach((c, idx) => {
      if (y + rowH > 540) {
        doc
          .fontSize(7)
          .font("Helvetica")
          .fillColor("#94a3b8")
          .text(`Page ${pageNum}`, 40, 550, { width: 720, align: "center" });
        doc.addPage();
        pageNum++;
        y = 40;
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
      if (idx % 2 === 0) {
        doc.rect(40, y, 720, rowH).fill("#f8fafc");
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:customerId", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await Customer.findById(customerId)
      .select("-password -__v -cart -orders -favorites")
      .lean();
    if (customer) {
      customer.customerCode = customerCodeForId(customer._id);
      return res.status(200).json({ success: true, customer });
    }

    // ── Fallback: ledger-only (Tally-imported) party with no CRM account ──
    // The customers list shows these "temp" parties; clicking view navigates
    // here with the LEDGER _id. Build a virtual customer from the ledger so the
    // detail page renders its books history instead of "Customer not found".
    let ledger = null;
    try {
      ledger = await Acc_Ledger.findById(customerId)
        .select(
          "name gstin email phone contactDetails currentBalance currentBalanceType openingBalance openingBalanceType groupName linkedCustomerId isActive",
        )
        .lean();
    } catch (_) {}

    if (ledger && !ledger.linkedCustomerId && ledger.isActive !== false) {
      const cd = ledger.contactDetails || {};
      const virtual = {
        _id: ledger._id,
        name: ledger.name,
        companyName: ledger.name,
        email: ledger.email || cd.email || "",
        phone: ledger.phone || cd.phone || "",
        gstin: ledger.gstin || "",
        address: cd.address || "",
        city: cd.city || "",
        state: cd.state || "",
        pincode: cd.pincode || "",
        customerCode: customerCodeForId(ledger._id),
        isLedgerOnly: true,
        accountStatus: "ledger_only",
        ledgerId: ledger._id,
      };
      return res.status(200).json({ success: true, customer: virtual });
    }

    return res
      .status(404)
      .json({ success: false, message: "Customer not found" });
  } catch (error) {
    console.error("Error fetching customer:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customer",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId/requests
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:customerId/requests", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const requests = await CustomerRequest.find({ customerId })
      .select("-__v -notes")
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, requests, count: requests.length });
  } catch (error) {
    console.error("Error fetching customer requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching customer requests",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId/payments
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:customerId/payments", verifyAccountantToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const requests = await CustomerRequest.find({ customerId })
      .select("quotations.paymentSubmissions requestId")
      .lean();
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId/financial-summary
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/:customerId/financial-summary",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId } = req.params;
      const requests = await CustomerRequest.find({ customerId })
        .select("quotations totalPaidAmount finalOrderPrice")
        .lean();
      let totalAmount = 0,
        totalPaid = 0,
        pendingPayments = 0,
        completedOrders = 0;
      requests.forEach((request) => {
        if (request.quotations && request.quotations.length > 0) {
          const quotation = request.quotations[0];
          if (quotation.grandTotal) totalAmount += quotation.grandTotal;
        }
        if (request.totalPaidAmount) totalPaid += request.totalPaidAmount;
        if (request.status === "completed") completedOrders++;
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
      res.status(200).json({
        success: true,
        summary: {
          totalAmount,
          totalPaid,
          totalDue: totalAmount - totalPaid,
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
// FIX: linkedCustomerId lookup first, then name match with isActive:{$ne:false}
// ─────────────────────────────────────────────────────────────────────────────
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

      let ledger = null;

      if (!customer) {
        // ── Ledger-only party: the id IS a ledger id (no CRM account) ────────
        try {
          ledger = await Acc_Ledger.findById(customerId)
            .select(
              "name currentBalance balanceType groupName groupId linkedCustomerId isActive",
            )
            .lean();
        } catch (_) {}
        if (!ledger || ledger.isActive === false) {
          return res
            .status(404)
            .json({ success: false, message: "Customer not found" });
        }
        // fall through to the voucher computation below using this ledger
      } else {
        // 1. Direct linkedCustomerId lookup — set by the merge route when a ghost
        //    ledger is relinked to the keeper.
        //    FIX: do NOT filter by companyId here. linkedCustomerId is the CRM
        //    Customer _id (not company-scoped). Removing companyId ensures the
        //    ledger is found even if Mongoose strict mode previously dropped the
        //    field and a re-merge was required.
        try {
          ledger = await Acc_Ledger.findOne({
            linkedCustomerId: customer._id,
            isActive: { $ne: false },
          })
            .select("name currentBalance balanceType groupName groupId")
            .lean();
        } catch (_) {}

        // 2. Name-match fallback — for ledgers not yet linked via ID.
        //    Use $ne: false (not isActive: true) so ledgers whose field was
        //    never explicitly set are still returned.
        if (!ledger) {
          const candidates = [customer.companyName, customer.name].filter(
            Boolean,
          );
          for (const candidate of candidates) {
            const rx = new RegExp(
              "^" + candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
              "i",
            );
            ledger = await Acc_Ledger.findOne({
              companyId,
              isActive: { $ne: false },
              name: rx,
            })
              .select("name currentBalance balanceType groupName groupId")
              .lean();
            if (ledger) break;
          }
        }
      }

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

      // ── Ledger-true statement + outstanding ──────────────────────────────
      // The document totals above (sales/receipt/credit-note grandTotal) do NOT
      // match the ledger: they skip journal/payment/contra vouchers that hit
      // this party, and they use the gross invoice value instead of the rounded
      // amount actually posted to the party line (sales vouchers carry a
      // "Rounding Off" line). So we rebuild the statement and the outstanding
      // straight from ledgerEntries across EVERY posted voucher touching this
      // ledger — identical to how the ledger page computes them.
      const stmtVouchers = await Acc_Voucher.find({
        companyId,
        status: "posted",
        "ledgerEntries.ledgerId": ledger._id,
      })
        .select(
          "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal",
        )
        .sort({ voucherDate: 1, createdAt: 1 })
        .lean();

      // Opening balance for this ledger (fetched explicitly — the `ledger`
      // object resolved earlier may not have selected the opening fields).
      const openingLed = await Acc_Ledger.findById(ledger._id)
        .select("openingBalance openingBalanceType")
        .lean();
      const openSigned =
        (openingLed && openingLed.openingBalanceType === "Cr" ? -1 : 1) *
        Math.abs((openingLed && openingLed.openingBalance) || 0);

      let stmtRunning = openSigned;
      let ledgerDr = 0;
      let ledgerCr = 0;
      const statement = [];
      for (const v of stmtVouchers) {
        let dr = 0;
        let cr = 0;
        for (const e of v.ledgerEntries || []) {
          if (String(e.ledgerId) !== String(ledger._id)) continue;
          if (e.type === "Dr") dr += e.amount || 0;
          else cr += e.amount || 0;
        }
        ledgerDr += dr;
        ledgerCr += cr;
        stmtRunning += dr - cr;
        statement.push({
          voucherId: v._id,
          date: v.voucherDate,
          voucherType: v.voucherType,
          voucherTypeName: v.voucherTypeName || v.voucherType,
          voucherNumber: v.voucherNumber || null,
          counterParty: v.partyLedgerName || null,
          narration: v.narration || null,
          debit: dr,
          credit: cr,
          runningBalance: Math.abs(stmtRunning),
          runningType: stmtRunning < 0 ? "Cr" : "Dr",
        });
      }
      const closingSigned = stmtRunning;

      res.status(200).json({
        success: true,
        ledger,
        stats: {
          totalInvoiced,
          totalReceived,
          totalCredited,
          // Outstanding now equals the ledger's closing balance (Dr = they owe us).
          outstanding:
            closingSigned > 0 ? parseFloat(closingSigned.toFixed(2)) : 0,
          advance:
            closingSigned < 0
              ? parseFloat(Math.abs(closingSigned).toFixed(2))
              : 0,
          ledgerDebit: parseFloat(ledgerDr.toFixed(2)),
          ledgerCredit: parseFloat(ledgerCr.toFixed(2)),
          openingBalance: parseFloat(Math.abs(openSigned).toFixed(2)),
          openingType: openSigned < 0 ? "Cr" : "Dr",
          closingBalance: parseFloat(Math.abs(closingSigned).toFixed(2)),
          closingType: closingSigned < 0 ? "Cr" : "Dr",
          invoiceCount: invoices.length,
          receiptCount: receipts.length,
          cnCount: creditNotes.length,
        },
        statement,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /payments/pending-verifications
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:customerId/payments/:paymentId/mark-reviewed
// ─────────────────────────────────────────────────────────────────────────────
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
      if (!request)
        return res
          .status(404)
          .json({ success: false, message: "Payment not found" });
      let paymentFound = false;
      request.quotations.forEach((quotation) => {
        if (quotation.paymentSubmissions) {
          const payment = quotation.paymentSubmissions.id(paymentId);
          if (payment) {
            if (!payment.accountantReview) payment.accountantReview = [];
            payment.accountantReview.push({
              reviewedBy: req.accountantId,
              reviewedAt: new Date(),
              notes: notes || "Reviewed by accountant",
            });
            paymentFound = true;
          }
        }
      });
      if (!paymentFound)
        return res
          .status(404)
          .json({ success: false, message: "Payment not found" });
      await request.save();
      res
        .status(200)
        .json({ success: true, message: "Payment marked as reviewed" });
    } catch (error) {
      console.error("Error marking payment as reviewed:", error);
      res.status(500).json({
        success: false,
        message: "Server error while marking payment",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /:customerId/statistics
// ─────────────────────────────────────────────────────────────────────────────
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
      let totalRevenue = 0,
        orderCount = 0;
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
      if (requests.length > 0) {
        const sortedRequests = requests.sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        );
        stats.lastOrderDate = sortedRequests[0].createdAt;
      }
      res.status(200).json({ success: true, statistics: stats });
    } catch (error) {
      console.error("Error fetching customer statistics:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching statistics",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /:customerId/requests/:requestId/quotations/:quotationId/approve
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:customerId/requests/:requestId/quotations/:quotationId/approve",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId, requestId, quotationId } = req.params;
      const { notes } = req.body;
      const request = await CustomerRequest.findOne({
        _id: requestId,
        customerId,
        "quotations._id": quotationId,
      });
      if (!request)
        return res
          .status(404)
          .json({ success: false, message: "Request or quotation not found" });
      const quotation = request.quotations.id(quotationId);
      if (!quotation)
        return res
          .status(404)
          .json({ success: false, message: "Quotation not found" });
      if (!quotation.customerApproval || !quotation.customerApproval.approved) {
        return res.status(400).json({
          success: false,
          message: "Cannot approve: Customer approval required first",
        });
      }
      if (
        quotation.accountantApproval &&
        quotation.accountantApproval.approved
      ) {
        return res.status(400).json({
          success: false,
          message: "Quotation already approved by accountant",
        });
      }
      if (!quotation.accountantApproval) quotation.accountantApproval = {};
      quotation.accountantApproval.approved = true;
      quotation.accountantApproval.approvedBy = req.accountantId;
      quotation.accountantApproval.approvedAt = new Date();
      quotation.accountantApproval.notes =
        notes || "Approved for payment processing";
      if (!quotation.accountantApproval.approvalHistory)
        quotation.accountantApproval.approvalHistory = [];
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:customerId/requests/:requestId/quotations/:quotationId/revoke-approval
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:customerId/requests/:requestId/quotations/:quotationId/revoke-approval",
  verifyAccountantToken,
  async (req, res) => {
    try {
      const { customerId, requestId, quotationId } = req.params;
      const { notes } = req.body;
      const request = await CustomerRequest.findOne({
        _id: requestId,
        customerId,
        "quotations._id": quotationId,
      });
      if (!request)
        return res
          .status(404)
          .json({ success: false, message: "Request or quotation not found" });
      const quotation = request.quotations.id(quotationId);
      if (
        !quotation ||
        !quotation.accountantApproval ||
        !quotation.accountantApproval.approved
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Quotation is not approved" });
      }
      quotation.accountantApproval.approved = false;
      quotation.accountantApproval.approvalHistory.push({
        action: "revoked",
        actionBy: req.accountantId,
        actionAt: new Date(),
        notes: notes || "Approval revoked",
      });
      await request.save();
      res
        .status(200)
        .json({ success: true, message: "Approval revoked successfully" });
    } catch (error) {
      console.error("Error revoking approval:", error);
      res.status(500).json({
        success: false,
        message: "Server error while revoking approval",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /pending-approvals
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/merge
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/merge", verifyAccountantToken, async (req, res) => {
  try {
    const keeperId = req.params.id;
    const { mergeFromId } = req.body || {};

    if (!mergeFromId)
      return res
        .status(400)
        .json({ success: false, message: "mergeFromId required" });
    if (String(keeperId) === String(mergeFromId))
      return res.status(400).json({
        success: false,
        message: "Cannot merge a customer into itself",
      });

    const keeper = await Customer.findById(keeperId);
    if (!keeper)
      return res
        .status(404)
        .json({ success: false, message: "Keeper customer not found" });

    const counts = { customerRequests: 0, vouchers: 0, ledgerEntries: 0 };

    let ghost = null;
    let ghostLedger = null;

    try {
      ghost = await Customer.findById(mergeFromId);
    } catch (_) {}

    if (ghost) {
      // Path A: Ghost is a CRM Customer
      const reqResult = await CustomerRequest.updateMany(
        { customerId: ghost._id },
        { $set: { customerId: keeper._id } },
      );
      counts.customerRequests = reqResult.modifiedCount || 0;

      // ── Copy any details the keeper is MISSING but the ghost has ──────────
      // (e.g. the duplicate may carry a GSTIN, email, phone or address that the
      // original customer never had). Fill those in before we deactivate the
      // ghost so no information is lost in the merge.
      const keeperPatch = {};
      const copyIfMissing = (field) => {
        const k = keeper[field];
        const g = ghost[field];
        if (
          (k === undefined || k === null || String(k).trim() === "") &&
          g !== undefined &&
          g !== null &&
          String(g).trim() !== ""
        ) {
          keeperPatch[field] = g;
        }
      };
      [
        "gstin",
        "email",
        "phone",
        "companyName",
        "panNumber",
        "address",
        "city",
        "state",
        "pincode",
      ].forEach(copyIfMissing);
      if (Object.keys(keeperPatch).length) {
        try {
          await Customer.updateOne({ _id: keeper._id }, { $set: keeperPatch });
          Object.assign(keeper, keeperPatch); // so downstream ledger relink uses the new GSTIN
          counts.fieldsCopied = Object.keys(keeperPatch);
        } catch (_) {}
      }

      ghostLedger = await Acc_Ledger.findOne({
        linkedCustomerId: ghost._id,
      }).catch(() => null);
      if (!ghostLedger) {
        const ghostName = (ghost.name || ghost.companyName || "").trim();
        if (ghostName) {
          ghostLedger = await Acc_Ledger.findOne({
            name: new RegExp(
              "^" + ghostName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
              "i",
            ),
            isActive: { $ne: false },
          }).catch(() => null);
        }
      }

      ghost.isActive = false;
      try {
        if (ghost.status !== undefined) ghost.status = "Inactive";
        ghost.notes = `[MERGED] Transactions moved to "${keeper.name || keeper.companyName}" on ${new Date().toISOString()}`;
      } catch (_) {}
      await ghost.save();
    } else {
      // Path B: Ghost is an Acc_Ledger (Tally import)
      ghostLedger = await Acc_Ledger.findById(mergeFromId).catch(() => null);
      if (!ghostLedger)
        return res
          .status(404)
          .json({ success: false, message: "Ghost customer/ledger not found" });

      // NOTE: We intentionally do NOT search for other CRM customers by GSTIN
      // here and deactivate them. That was causing the ORIGINAL customer (which
      // shares a GSTIN with the Tally-imported ghost) to be killed, destroying
      // all their orders and data. CRM-to-CRM deduplication is a separate
      // operation the user handles directly by merging the import-created CRM
      // customer into the original via the ghost detection on the customers page.
    }

    if (ghostLedger) {
      let keeperLedger = await Acc_Ledger.findOne({
        linkedCustomerId: keeper._id,
      }).catch(() => null);
      if (!keeperLedger) {
        const keeperName = (keeper.name || keeper.companyName || "").trim();
        if (keeperName) {
          const candidate = await Acc_Ledger.findOne({
            name: new RegExp(
              "^" + keeperName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
              "i",
            ),
            isActive: { $ne: false },
            _id: { $ne: ghostLedger._id },
          }).catch(() => null);
          // SAFETY: only adopt this ledger if it is NOT already linked to a
          // DIFFERENT customer. Otherwise we'd steal another customer's ledger
          // and the keeper would end up with no ledger of its own.
          if (
            candidate &&
            (!candidate.linkedCustomerId ||
              String(candidate.linkedCustomerId) === String(keeper._id))
          ) {
            keeperLedger = candidate;
            // Make sure it's actually linked to the keeper going forward
            if (!candidate.linkedCustomerId) {
              await Acc_Ledger.updateOne(
                { _id: candidate._id },
                { $set: { linkedCustomerId: keeper._id } },
              );
            }
          }
        }
      }

      // ── CRITICAL GUARD ────────────────────────────────────────────────────
      // If the "ghost" ledger we're merging IS the keeper's own ledger, there
      // is nothing to migrate. Proceeding would re-point its vouchers to itself
      // and then DEACTIVATE it — stripping the keeper of its ledger (the exact
      // "No linked accounting ledger found" symptom) and unbalancing the books.
      if (
        keeperLedger &&
        String(keeperLedger._id) === String(ghostLedger._id)
      ) {
        return res.json({
          success: true,
          message: `"${keeper.name || keeper.companyName}" is already consolidated; nothing to merge.`,
          counts,
          noop: true,
        });
      }

      if (keeperLedger) {
        const partyResult = await Acc_Voucher.updateMany(
          { partyLedgerId: ghostLedger._id },
          { $set: { partyLedgerId: keeperLedger._id } },
        );
        counts.vouchers = partyResult.modifiedCount || 0;

        const entryResult = await Acc_Voucher.updateMany(
          { "ledgerEntries.ledgerId": ghostLedger._id },
          { $set: { "ledgerEntries.$[elem].ledgerId": keeperLedger._id } },
          { arrayFilters: [{ "elem.ledgerId": ghostLedger._id }] },
        );
        counts.ledgerEntries = entryResult.modifiedCount || 0;

        // ── Transfer balances — SIGNED arithmetic ─────────────────────────
        // Acc_Ledger stores openingBalance / currentBalance SIGNED
        // (positive = Dr, negative = Cr) per the schema. Some import paths,
        // however, stored magnitude + a separate type field. signedBal() reads
        // BOTH conventions safely: a negative stored value is already signed;
        // a positive value gets its sign from the type field.
        //
        // The balance sheet reads openingBalance directly (and, for
        // balanceFromTrialBalance ledgers, uses it AS-IS as the closing). So we
        // must (a) ADD the ghost's signed balance to the keeper, and (b) ZERO
        // the ghost's balance so it isn't double-counted — the earlier bug
        // (storing Math.abs and never zeroing the ghost) made Assets jump by
        // exactly the ghost's balance.
        const signedBal = (val, type) => {
          const v = Number(val) || 0;
          if (v < 0) return v; // already signed
          return (type === "Cr" ? -1 : 1) * v; // magnitude + type
        };

        const newOpenSigned =
          signedBal(
            keeperLedger.openingBalance,
            keeperLedger.openingBalanceType,
          ) +
          signedBal(ghostLedger.openingBalance, ghostLedger.openingBalanceType);
        const newCurrSigned =
          signedBal(
            keeperLedger.currentBalance,
            keeperLedger.currentBalanceType,
          ) +
          signedBal(ghostLedger.currentBalance, ghostLedger.currentBalanceType);

        await Acc_Ledger.updateOne(
          { _id: keeperLedger._id },
          {
            $set: {
              openingBalance: newOpenSigned, // SIGNED
              openingBalanceType: newOpenSigned < 0 ? "Cr" : "Dr",
              currentBalance: newCurrSigned, // SIGNED
              currentBalanceType: newCurrSigned < 0 ? "Cr" : "Dr",
              // If either side carried an authoritative Trial-Balance closing,
              // the merged total is still TB-authoritative.
              ...(keeperLedger.balanceFromTrialBalance ||
              ghostLedger.balanceFromTrialBalance
                ? { balanceFromTrialBalance: true }
                : {}),
            },
          },
        );

        // Deactivate ghost ledger AND zero its balance so it cannot be
        // counted anywhere (regardless of whether the balance sheet filters
        // on isActive). This is what keeps the books balanced post-merge.
        await Acc_Ledger.updateOne(
          { _id: ghostLedger._id },
          {
            $set: {
              isActive: false,
              openingBalance: 0,
              currentBalance: 0,
              balanceFromTrialBalance: false,
              name: `[MERGED] ${ghostLedger.name}`,
            },
          },
        );
      } else {
        // No keeper ledger — give the keeper the ghost's ledger by relinking it
        // (do NOT deactivate it). The keeper then has a real ledger and its
        // detail page will show the full books history.
        await Acc_Ledger.updateOne(
          { _id: ghostLedger._id },
          {
            $set: {
              linkedCustomerId: keeper._id,
              name: keeper.name || keeper.companyName,
              ...(keeper.gstin && !ghostLedger.gstin
                ? { gstin: keeper.gstin }
                : {}),
            },
          },
        );

        counts.vouchers = await Acc_Voucher.countDocuments({
          partyLedgerId: ghostLedger._id,
          status: "posted",
        });
      }
    }

    const ghostLabel =
      ghostLedger?.name?.replace(/^\[MERGED\]\s*/, "") ||
      ghost?.name ||
      ghost?.companyName ||
      mergeFromId;
    const keeperLabel = keeper.name || keeper.companyName;

    res.json({
      success: true,
      message: `Merged "${ghostLabel}" → "${keeperLabel}". ${counts.customerRequests} orders, ${counts.vouchers} vouchers, ${counts.ledgerEntries} ledger entries transferred.`,
      counts,
    });
  } catch (error) {
    console.error("[customers/merge]", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
