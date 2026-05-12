// routes/Accountant_Routes/customersRoutes.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

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
    const sort = String(req.query.sort || "recent");
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

    // Sort spec
    const sortSpec = {
      name: { name: 1 },
      recent: { createdAt: -1 },
      // revenue & outstanding are derived; we sort post-fetch for those
    }[sort] || { createdAt: -1 };

    // Fetch the page of customers
    let customers = await Customer.find(baseQuery)
      .select(
        "name companyName email phone profile gstin createdAt lastLogin isPhoneVerified isEmailVerified",
      )
      .sort(sortSpec)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Aggregate per-customer financials in a single pass using $facet-style
    // aggregation per customer. For pagination correctness we only aggregate
    // for the page, so this is fast.
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

    // Apply derived filters AFTER computing financials
    if (filter === "with_outstanding") {
      customers = customers.filter((c) => c.totalOutstanding > 0);
    }

    // Sort by derived fields if needed
    if (sort === "revenue") {
      customers.sort((a, b) => b.totalRevenue - a.totalRevenue);
    } else if (sort === "outstanding") {
      customers.sort((a, b) => b.totalOutstanding - a.totalOutstanding);
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
