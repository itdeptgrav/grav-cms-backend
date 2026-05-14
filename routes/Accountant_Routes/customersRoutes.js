// routes/Accountant_Routes/customersRoutes.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Accounting-side models — used by the /accounting and /statement endpoints
// to bridge from the CRM Customer collection into the unified TallyVoucher
// accounting ledger. Best-effort name match on the Sundry Debtor ledger.
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");
const {
  TallyLedger,
} = require("../../models/Accountant_model/TallyMasterModels");

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

    const customers = allCustomers.map((c) => {
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

    res.json({
      success: true,
      customers,
      summary: {
        totalCustomers: customers.length,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
        customersWithOutstanding,
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
//   against TallyLedger here. It works for the common case where the
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
        ledger = await TallyLedger.findOne({
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
        TallyVoucher.find({ ...baseFilter, voucherType: "sales" })
          .sort({ voucherDate: -1 })
          .limit(200)
          .select(
            "voucherNumber voucherDate dueDate grandTotal subtotal totalTax",
          )
          .lean(),
        TallyVoucher.find({ ...baseFilter, voucherType: "receipt" })
          .sort({ voucherDate: -1 })
          .limit(200)
          .select(
            "voucherNumber voucherDate grandTotal paymentMode instrumentNumber ledgerEntries",
          )
          .lean(),
        TallyVoucher.find({ ...baseFilter, voucherType: "credit_note" })
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
