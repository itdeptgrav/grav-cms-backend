// routes/Customer_Routes/CustomerReturns.js
// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER-FACING return request endpoints.
//
// Uses the EXISTING ReturnRequest schema at:
//   models/CMS_Models/Manufacturing/Return/ReturnRequest.js
//
// The same schema is used by the sales/dispatch side, so once a customer
// creates a return here, it lands in the same collection and is immediately
// visible to the sales/store team. They process it through:
//   pending → store_processing → mo_created → completed
//
// The schema already supports `createdByType: "customer"` and the
// `createdByCustomer` field — we just populate them on creation.
//
// Mount in your main app file:
//   const customerReturnsRoutes = require("./routes/Customer_Routes/CustomerReturns");
//   app.use("/api/customer/returns", customerReturnsRoutes);
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const ReturnRequest = require("../../models/CMS_Models/Manufacturing/Return/ReturnRequest");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

// ─── Customer auth (mirrors the pattern in your other Customer_Routes) ──────
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Access denied. Please sign in." });
    }
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key_2024",
    );
    req.customerId = decoded.id;
    next();
  } catch (err) {
    return res
      .status(401)
      .json({
        success: false,
        message: "Invalid token. Please sign in again.",
      });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Generate a fresh return request number: RR-YYYYMMDD-NNNN (4-digit daily seq)
async function generateReturnRequestNumber() {
  const now = new Date();
  const yyyymmdd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );

  const count = await ReturnRequest.countDocuments({
    createdAt: { $gte: startOfDay, $lt: endOfDay },
  });

  return `RR-${yyyymmdd}-${String(count + 1).padStart(4, "0")}`;
}

// Enrich a return-product line with WorkOrder data so sales/store side
// can immediately see real product names + variant attrs (matches what the
// existing sales endpoint does).
async function enrichProduct(prod) {
  const out = {
    workOrderId: prod.workOrderId || null,
    workOrderNumber: prod.workOrderNumber || "",
    stockItemId: prod.stockItemId || null,
    variantId: prod.variantId || "",
    productName: prod.productName || "—",
    productRef: prod.productRef || "",
    variantAttributes: prod.variantAttributes || [],
    returnQuantity: Number(prod.returnQuantity) || 0,
  };

  if (prod.workOrderId && mongoose.Types.ObjectId.isValid(prod.workOrderId)) {
    const wo = await WorkOrder.findById(prod.workOrderId)
      .select(
        "workOrderNumber stockItemId stockItemName stockItemReference variantId variantAttributes quantity dispatchedQuantity",
      )
      .lean();
    if (wo) {
      out.workOrderNumber = wo.workOrderNumber || out.workOrderNumber;
      out.stockItemId = wo.stockItemId || out.stockItemId;
      out.variantId = wo.variantId || out.variantId;
      out.productName = wo.stockItemName || out.productName;
      out.productRef = wo.stockItemReference || out.productRef;
      if (
        (!out.variantAttributes || out.variantAttributes.length === 0) &&
        wo.variantAttributes
      ) {
        out.variantAttributes = wo.variantAttributes;
      }
      // Customer cannot return more than was actually dispatched to them
      const dispatched = Number(wo.dispatchedQuantity || 0);
      if (dispatched > 0 && out.returnQuantity > dispatched) {
        out.returnQuantity = dispatched;
      }
    }
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/customer/returns
//
// Body:
//   {
//     originalMoId:   "<CustomerRequest._id this return is for>",
//     dispatchType:   "bulk" | "person_wise",
//     bulkProducts:   [ { workOrderId, productName, returnQuantity, variantAttributes? } ],
//     persons:        [ ... ]  (person_wise only)
//     notes:          "reason for return"
//   }
//
// Auth: customer token (cookie)
// Ownership check: customerId on the original MO must match req.customerId
// ═════════════════════════════════════════════════════════════════════════════
router.post("/", verifyCustomerToken, async (req, res) => {
  try {
    const {
      originalMoId,
      dispatchType,
      bulkProducts = [],
      persons = [],
      notes = "",
    } = req.body || {};

    // ── Validate dispatchType
    if (!["person_wise", "bulk"].includes(dispatchType)) {
      return res.status(400).json({
        success: false,
        message: 'dispatchType must be "bulk" or "person_wise"',
      });
    }

    // ── Validate originalMoId
    if (!originalMoId || !mongoose.Types.ObjectId.isValid(originalMoId)) {
      return res.status(400).json({
        success: false,
        message: "originalMoId is required and must be a valid ObjectId",
      });
    }

    // ── Ownership check — customer can only return on their own orders
    const originalMo = await CustomerRequest.findOne({
      _id: originalMoId,
      customerId: req.customerId,
    })
      .select("requestId customerId customerInfo status")
      .lean();

    if (!originalMo) {
      return res.status(404).json({
        success: false,
        message: "Original order not found or you don't have access to it",
      });
    }

    // Only allow returns once the order has been dispatched / completed at
    // least partially. Block returns on orders that haven't even shipped yet.
    const allowedStatuses = [
      "ready_to_dispatch",
      "production",
      "completed",
      "quotation_sales_approved", // sales-approved orders that may already be dispatching
    ];
    if (originalMo.status && !allowedStatuses.includes(originalMo.status)) {
      // Don't 400 — many older orders may not have one of these statuses set;
      // just log a hint and continue. Sales side will validate too.
      console.warn(
        `[customer-returns] order ${originalMo.requestId} has status "${originalMo.status}" — proceeding anyway`,
      );
    }

    // ── Enrich + validate the products / persons
    let enrichedPersons = [];
    let enrichedBulk = [];
    let totalReturnUnits = 0;
    let totalPersons = 0;
    let totalProducts = 0;

    if (dispatchType === "bulk") {
      enrichedBulk = await Promise.all(
        (bulkProducts || [])
          .filter((p) => Number(p.returnQuantity) > 0)
          .map(enrichProduct),
      );
      if (enrichedBulk.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "Please select at least one product with a return quantity > 0",
        });
      }
      totalReturnUnits = enrichedBulk.reduce(
        (s, p) => s + (p.returnQuantity || 0),
        0,
      );
      totalProducts = enrichedBulk.length;
    } else {
      // person_wise
      for (const person of persons || []) {
        const validProds = (person.products || []).filter(
          (p) => Number(p.returnQuantity) > 0,
        );
        if (validProds.length === 0) continue;
        const enrichedProducts = await Promise.all(
          validProds.map(enrichProduct),
        );
        const personSum = enrichedProducts.reduce(
          (s, p) => s + (p.returnQuantity || 0),
          0,
        );
        if (personSum > 0) {
          enrichedPersons.push({
            employeeId: person.employeeId || null,
            employeeName: person.employeeName || "—",
            employeeUIN: person.employeeUIN || "",
            department: person.department || "",
            designation: person.designation || "",
            gender: person.gender || "",
            products: enrichedProducts,
            totalReturnUnits: personSum,
          });
          totalReturnUnits += personSum;
          totalProducts += enrichedProducts.length;
          totalPersons += 1;
        }
      }
      if (enrichedPersons.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Please add at least one person with a return quantity > 0",
        });
      }
    }

    // ── Create the return request
    const returnRequestNumber = await generateReturnRequestNumber();

    const created = await ReturnRequest.create({
      returnRequestNumber,
      originalMoId,
      originalRequestId: originalMo.requestId || "",
      customerId: originalMo.customerId || req.customerId,
      customerName: originalMo.customerInfo?.name || "—",
      customerInfo: originalMo.customerInfo || null,
      dispatchType,
      persons: dispatchType === "person_wise" ? enrichedPersons : [],
      bulkProducts: dispatchType === "bulk" ? enrichedBulk : [],
      totalReturnUnits,
      totalPersons,
      totalProducts,
      createdByType: "customer",
      createdByCustomer: req.customerId,
      status: "pending",
      notes: notes || "",
    });

    return res.status(201).json({
      success: true,
      message: `Return request ${returnRequestNumber} created successfully`,
      returnRequest: created,
      returnRequestNumber,
    });
  } catch (err) {
    console.error("[customer-returns] POST / error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while creating return request",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/customer/returns
// List ALL returns belonging to the authenticated customer.
// Optional query: ?status=pending|store_processing|mo_created|completed|rejected
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", verifyCustomerToken, async (req, res) => {
  try {
    const filter = { customerId: req.customerId };
    if (req.query.status) filter.status = String(req.query.status);

    const returns = await ReturnRequest.find(filter)
      .sort({ createdAt: -1 })
      .select("-__v")
      .lean();

    return res.json({
      success: true,
      returns,
      count: returns.length,
    });
  } catch (err) {
    console.error("[customer-returns] GET / error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/customer/returns/by-request/:requestId
// List returns linked to a specific original MO (CustomerRequest).
// Verifies ownership of the request.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/by-request/:requestId", verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request ID" });
    }

    // Verify ownership
    const exists = await CustomerRequest.exists({
      _id: requestId,
      customerId: req.customerId,
    });
    if (!exists) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const returns = await ReturnRequest.find({
      originalMoId: requestId,
      customerId: req.customerId,
    })
      .sort({ createdAt: -1 })
      .select("-__v")
      .lean();

    return res.json({
      success: true,
      returns,
      count: returns.length,
    });
  } catch (err) {
    console.error("[customer-returns] GET /by-request/:requestId error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/customer/returns/:returnId
// Get a single return request — ownership-verified.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:returnId", verifyCustomerToken, async (req, res) => {
  try {
    const { returnId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(returnId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid return ID" });
    }

    const rr = await ReturnRequest.findOne({
      _id: returnId,
      customerId: req.customerId,
    })
      .select("-__v")
      .lean();

    if (!rr) {
      return res
        .status(404)
        .json({ success: false, message: "Return request not found" });
    }

    return res.json({ success: true, returnRequest: rr });
  } catch (err) {
    console.error("[customer-returns] GET /:returnId error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
