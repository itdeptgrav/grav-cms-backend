// routes/Accountant_Routes/customersRoutes.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

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

// GET all customers with basic info
router.get("/", verifyAccountantToken, async (req, res) => {
  try {
    const customers = await Customer.find()
      .select(
        "name email phone profile createdAt lastLogin isPhoneVerified isEmailVerified",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Get request counts for each customer
    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const requestCount = await CustomerRequest.countDocuments({
          customerId: customer._id,
        });

        return {
          ...customer,
          totalRequests: requestCount,
        };
      }),
    );

    res.status(200).json({
      success: true,
      customers: customersWithStats,
      count: customersWithStats.length,
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