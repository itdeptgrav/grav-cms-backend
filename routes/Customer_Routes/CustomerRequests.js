// routes/Customer_Routes/CustomerRequests.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer-side request routes. The GET / handler is enriched with a
// `production` field per request so the frontend My Requests page can show
// real unit-level work-order progress (completed / in-progress / total units,
// work-order counts) without an extra round-trip.
//
// The production aggregation is the ONLY behavioural change vs the previous
// file. All other route handlers (create, cancel, delivery confirmation,
// available items, edit-request routes) are preserved verbatim.
//
// ⚠️  NOTE: a few edit-request handlers in this file use `req.user.id`
//    instead of `req.customerId` — that's the SALES auth context. Those
//    handlers were copy-pasted from the sales-side file historically;
//    they're kept here as-is to avoid changing existing behaviour, but
//    they likely belong in routes/CMS_Routes/Sales/customerRequests.js
//    instead. Migrate them at your convenience.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const Request = require("../../models/Customer_Models/CustomerRequest");
const CustomerRequest = Request; // alias used by edit-request handlers below
const Customer = require("../../models/Customer_Models/Customer");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const jwt = require("jsonwebtoken");
const CustomerEmailService = require("../../services/CustomerEmailService");

// ═══════════════════════════════════════════════════════════════════════════
// Auth middleware — verifies the customerToken cookie
// ═══════════════════════════════════════════════════════════════════════════
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. Please sign in.",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key_2024",
    );
    req.customerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid token. Please sign in again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Helper — aggregate production progress from WorkOrders
//
// Reads all WorkOrders linked to the request via `customerRequestId` and
// computes unit-level totals using the same `productionCompletion` fields
// the sales-side manufacturing-orders route uses. Returns null when there
// are no work orders yet (e.g. request still in quotation stage).
// ═══════════════════════════════════════════════════════════════════════════
async function aggregateProductionProgress(requestId) {
  const workOrders = await WorkOrder.find({ customerRequestId: requestId })
    .select("status quantity productionCompletion")
    .lean();

  if (!workOrders.length) return null;

  let totalUnits = 0;
  let completedUnits = 0;
  let inProgressUnits = 0;
  let workOrdersComplete = 0;
  let workOrdersInProgress = 0;
  let workOrdersPending = 0;

  workOrders.forEach((wo) => {
    const pc = wo.productionCompletion || {};
    const completed = pc.overallCompletedQuantity || 0;
    const percent = pc.overallCompletionPercentage || 0;

    totalUnits += wo.quantity || 0;
    completedUnits += completed;

    // Estimate in-progress units (started but not yet complete)
    if (wo.status === "in_progress" && completed < (wo.quantity || 0)) {
      const opCompletion = pc.operationCompletion || [];
      if (opCompletion.length > 0) {
        const maxOpCompleted = Math.max(
          ...opCompletion.map((op) => op.completedQuantity || 0),
        );
        inProgressUnits += Math.max(0, maxOpCompleted - completed);
      } else {
        inProgressUnits += 1;
      }
    }

    if (percent >= 100) workOrdersComplete++;
    else if (percent > 0) workOrdersInProgress++;
    else workOrdersPending++;
  });

  return {
    totalUnits,
    completedUnits,
    inProgressUnits,
    pendingUnits: Math.max(0, totalUnits - completedUnits - inProgressUnits),
    workOrdersTotal: workOrders.length,
    workOrdersComplete,
    workOrdersInProgress,
    workOrdersPending,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /available-items — stock items the customer can choose from
// ═══════════════════════════════════════════════════════════════════════════
router.get("/available-items", verifyCustomerToken, async (req, res) => {
  try {
    const { search = "", category = "" } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 12),
    );

    // ── 1. Load the customer's whitelist ────────────────────────────────
    const customer = await Customer.findById(req.customerId)
      .select("assignedStockItems")
      .lean();

    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    // The assignedStockItems schema stores objects like
    //   { stockItemId, stockItemName, stockItemReference, assignedAt, ... }
    // but historical data might be raw ObjectIds — handle both.
    const assignedIds = (customer.assignedStockItems || [])
      .map((a) => {
        if (!a) return null;
        if (typeof a === "string") return a;
        if (a.stockItemId) return a.stockItemId;
        if (a._id) return a._id;
        return null;
      })
      .filter(Boolean);

    // No whitelist → return empty, with a flag so the UI can show a
    // helpful "no products assigned" message instead of generic "no
    // products found".
    if (!assignedIds.length) {
      return res.status(200).json({
        success: true,
        items: [],
        categories: [],
        page: 1,
        limit,
        total: 0,
        totalPages: 0,
        hasMore: false,
        hasAssignments: false,
      });
    }

    // ── 2. Build the filter ─────────────────────────────────────────────
    const filter = { _id: { $in: assignedIds } };

    if (search && search.trim()) {
      const q = search.trim();
      const re = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i");
      // MongoDB applies a regex on an array field to each element
      // automatically, so { additionalNames: re } already matches any
      // element. An explicit $elemMatch around the regex is BOTH
      // redundant and invalid — $elemMatch expects an object query,
      // not a bare regex, and throws "$elemMatch needs an Object".
      // v20: removed that bad line; the plain match is enough.
      filter.$or = [
        { name: re },
        { reference: re },
        { category: re },
        { genderCategory: re },
        { additionalNames: re },
      ];
    }

    if (category && category.trim()) filter.category = category.trim();

    // ── 3. Count + fetch the current page ───────────────────────────────
    const total = await StockItem.countDocuments(filter);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const skip = (page - 1) * limit;

    const stockItems = await StockItem.find(filter)
      .select(
        "_id name reference category genderCategory baseSalesPrice salesPrice images attributes variants additionalNames",
      )
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // ── 4. Resolve best image URL per product ───────────────────────────
    // Tries top-level images first, then walks variants. Returned as
    // singular `product.image` so the frontend doesn't have to do this
    // fallback walk every render.
    const resolveImage = (item) => {
      if (Array.isArray(item.images) && item.images[0]) {
        const first = item.images[0];
        return typeof first === "string" ? first : first?.url || null;
      }
      if (Array.isArray(item.variants)) {
        for (const v of item.variants) {
          if (Array.isArray(v?.images) && v.images[0]) {
            const first = v.images[0];
            return typeof first === "string" ? first : first?.url || null;
          }
        }
      }
      return null;
    };

    // ── 5. Shape each product for the frontend ──────────────────────────
    const items = stockItems.map((item) => ({
      id: item._id,
      _id: item._id,
      name: item.name,
      reference: item.reference,
      category: item.category,
      genderCategory: item.genderCategory || null,
      baseSalesPrice: item.baseSalesPrice || item.salesPrice || 0,
      image: resolveImage(item),
      images: item.images || [],
      attributes: (item.attributes || []).map((a) => ({
        name: a.name,
        values: a.values || [],
      })),
      variants: (item.variants || []).map((v) => ({
        _id: v._id,
        sku: v.sku,
        attributes: v.attributes || [],
        salesPrice: v.salesPrice,
        images: v.images || [],
      })),
      hasVariants: (item.variants || []).length > 0,
    }));

    // ── 6. Categories scoped to the whitelist ───────────────────────────
    // Only categories the customer can actually pick from — not every
    // category in the entire StockItem collection.
    const categoryDocs = await StockItem.find({ _id: { $in: assignedIds } })
      .select("category")
      .lean();
    const categories = [
      ...new Set(
        categoryDocs.map((c) => c.category).filter((c) => c && c.trim()),
      ),
    ].sort();

    return res.status(200).json({
      success: true,
      items,
      categories,
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
      hasAssignments: true,
    });
  } catch (error) {
    console.error("[available-items] error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while loading catalogue",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:requestId/delivery-confirmation — customer submits delivery details
// (called from PaymentPopup after a payment is submitted)
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/:requestId/delivery-confirmation",
  verifyCustomerToken,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const customerId = req.customerId;
      const {
        address,
        city,
        postalCode,
        phone,
        preferredDate,
        timeSlot,
        specialInstructions,
        paymentStepNumber,
      } = req.body;

      if (!address || !city || !postalCode || !phone) {
        return res.status(400).json({
          success: false,
          message: "Address, city, postal code and phone are required",
        });
      }

      const request = await Request.findOne({ _id: requestId, customerId });
      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Request not found",
        });
      }

      request.deliveryConfirmation = {
        address: address.trim(),
        city: city.trim(),
        postalCode: postalCode.trim(),
        phone: phone.trim(),
        preferredDate: preferredDate ? new Date(preferredDate) : null,
        timeSlot: timeSlot || "anytime",
        specialInstructions: (specialInstructions || "").trim(),
        submittedAt: new Date(),
        submittedAfterPaymentStep: paymentStepNumber || null,
      };

      request.notes.push({
        text: `Customer submitted delivery confirmation after payment${
          paymentStepNumber ? ` (step ${paymentStepNumber})` : ""
        }`,
        addedBy: customerId,
        addedByModel: "Customer",
        createdAt: new Date(),
      });

      request.updatedAt = new Date();
      await request.save();

      return res.json({
        success: true,
        message: "Delivery details saved successfully",
        deliveryConfirmation: request.deliveryConfirmation,
      });
    } catch (err) {
      console.error("Delivery confirmation error:", err);
      return res.status(500).json({
        success: false,
        message: "Server error while saving delivery details",
      });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// POST / — create a new request with item variations
// ═══════════════════════════════════════════════════════════════════════════
router.post("/", verifyCustomerToken, async (req, res) => {
  try {
    const { customerInfo, items } = req.body;
    const customerId = req.customerId;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one item is required",
      });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    // ── Validate each item and its variants ──────────────────────────
    const validatedItems = [];
    for (const item of items) {
      const stockItem = await StockItem.findById(item.stockItemId);

      if (!stockItem) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.stockItemName || item.stockItemId} not found`,
        });
      }

      if (
        !item.variants ||
        !Array.isArray(item.variants) ||
        item.variants.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: `At least one variation is required for ${stockItem.name}`,
        });
      }

      const validatedVariants = [];
      let totalQuantity = 0;

      for (const variant of item.variants) {
        if (!variant.quantity || variant.quantity < 1) {
          return res.status(400).json({
            success: false,
            message: `Each variation must have at least 1 quantity for ${stockItem.name}`,
          });
        }

        totalQuantity += variant.quantity;

        let variantPrice = stockItem.baseSalesPrice * variant.quantity;
        let variantId = null;

        // Match against stockItem variants if attributes provided
        if (variant.attributes && stockItem.variants.length > 0) {
          const matchingVariant = stockItem.variants.find((sv) =>
            sv.attributes.every((svAttr) =>
              variant.attributes.some(
                (vAttr) =>
                  vAttr.name === svAttr.name && vAttr.value === svAttr.value,
              ),
            ),
          );

          if (matchingVariant) {
            variantPrice = matchingVariant.salesPrice * variant.quantity;
            variantId = matchingVariant._id;
          }
        }

        validatedVariants.push({
          variantId: variantId,
          attributes: variant.attributes || [],
          quantity: variant.quantity,
          specialInstructions:
            variant.specialInstructions?.filter((inst) => inst.trim()) || [],
          estimatedPrice: variantPrice,
        });
      }

      const totalEstimatedPrice = validatedVariants.reduce(
        (sum, v) => sum + v.estimatedPrice,
        0,
      );

      validatedItems.push({
        stockItemId: stockItem._id,
        stockItemName: stockItem.name,
        stockItemReference: stockItem.reference,
        variants: validatedVariants,
        totalQuantity,
        totalEstimatedPrice,
      });
    }

    // ── Generate request ID ──────────────────────────────────────────
    const requestCount = await Request.countDocuments();
    const requestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, "0")}`;

    // ── Create new request ───────────────────────────────────────────
    const newRequest = new Request({
      requestId,
      customerId,
      customerInfo: {
        name: customerInfo.name || customer.name,
        email: customerInfo.email || customer.email,
        phone: customerInfo.phone || customer.phone,
        address:
          customerInfo.address || customer.profile?.address?.street || "",
        city: customerInfo.city || customer.profile?.address?.city || "",
        postalCode:
          customerInfo.postalCode || customer.profile?.address?.pincode || "",
        description: customerInfo.description || "",
        deliveryDeadline: customerInfo.deliveryDeadline,
        preferredContactMethod: customerInfo.preferredContactMethod || "phone",
      },
      items: validatedItems,
      status: "pending",
      priority: customerInfo.priority || "medium",
      createdAt: new Date(),
    });

    await newRequest.save();

    // ── Populate with item details for response ──────────────────────
    const populatedRequest = await Request.findById(newRequest._id).populate({
      path: "items.stockItemId",
      select: "name reference category images",
    });

    // ── Send confirmation email (non-blocking) ───────────────────────
    try {
      await CustomerEmailService.sendRequestConfirmationEmail(
        {
          requestId: populatedRequest.requestId,
          createdAt: populatedRequest.createdAt,
          items: populatedRequest.items.map((item) => ({
            stockItemName: item.stockItemName,
            stockItemReference: item.stockItemReference,
            totalQuantity: item.totalQuantity,
            totalEstimatedPrice: item.totalEstimatedPrice,
            variants: (item.variants || []).map((v) => ({
              attributes: v.attributes || [],
              quantity: v.quantity,
              estimatedPrice: v.estimatedPrice,
              specialInstructions: (v.specialInstructions || []).filter((i) =>
                i?.trim(),
              ),
            })),
          })),
        },
        {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        },
      );
    } catch (emailError) {
      console.error("Request confirmation email failed:", emailError);
    }

    res.status(201).json({
      success: true,
      message:
        "Request created successfully. Confirmation email has been sent.",
      request: populatedRequest,
      totalEstimatedPrice: populatedRequest.items.reduce(
        (sum, item) => sum + item.totalEstimatedPrice,
        0,
      ),
    });
  } catch (error) {
    console.error("Create request error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(", "),
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET / — list all requests for the authenticated customer
//
// ⭐ ENHANCED: now includes a `production` field per request with unit-level
// work-order progress data. Frontend RequestList component renders this
// automatically when present. If aggregation fails for any single request,
// that request gets `production: null` rather than failing the whole list.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;

    const requests = await Request.find({ customerId })
      .sort({ createdAt: -1 })
      .select("-__v -updatedAt")
      .lean();

    // ── Pass 1: process edit-request flags (synchronous) ─────────────
    const processedRequests = requests.map((request) => {
      const pendingEditApprovals = request.editRequests
        ? request.editRequests.filter((e) => e.status === "pending_approval")
            .length
        : 0;

      const hasPendingCustomerApproval = request.editRequests
        ? request.editRequests.some((e) => e.status === "pending_approval")
        : false;

      const latestEditRequest =
        request.editRequests && request.editRequests.length > 0
          ? request.editRequests
              .slice()
              .sort(
                (a, b) =>
                  new Date(b.requestedAt || b.createdAt) -
                  new Date(a.requestedAt || a.createdAt),
              )[0]
          : null;

      return {
        ...request,
        hasPendingEditApproval: hasPendingCustomerApproval,
        pendingEditCount: pendingEditApprovals,
        latestEditRequest: latestEditRequest
          ? {
              _id: latestEditRequest._id,
              status: latestEditRequest.status,
              requestedAt:
                latestEditRequest.requestedAt || latestEditRequest.createdAt,
              reason: latestEditRequest.reason,
            }
          : null,
      };
    });

    // ── Pass 2: aggregate production progress (async, in parallel) ───
    const enrichedRequests = await Promise.all(
      processedRequests.map(async (request) => {
        try {
          const production = await aggregateProductionProgress(request._id);
          return { ...request, production };
        } catch (err) {
          console.warn(
            `Production aggregation failed for request ${request._id}:`,
            err.message,
          );
          return { ...request, production: null };
        }
      }),
    );

    res.status(200).json({
      success: true,
      requests: enrichedRequests,
      count: enrichedRequests.length,
      pendingEditCount: enrichedRequests.filter((r) => r.hasPendingEditApproval)
        .length,
    });
  } catch (error) {
    console.error("Get requests error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:requestId/cancel — customer cancels their own request
// ═══════════════════════════════════════════════════════════════════════════
router.patch("/:requestId/cancel", verifyCustomerToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const customerId = req.customerId;

    const request = await Request.findOne({ _id: requestId, customerId });
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      });
    }

    if (request.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel completed request",
      });
    }

    request.status = "cancelled";
    request.updatedAt = new Date();
    await request.save();

    res.status(200).json({
      success: true,
      message: "Request cancelled successfully",
    });
  } catch (error) {
    console.error("Cancel request error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EDIT-REQUEST HANDLERS (legacy — use req.user.id, sales-side auth context)
//
// ⚠️ These handlers were copy-pasted from the sales-side file historically
// and use `req.user.id`, not `req.customerId`. They likely don't function
// correctly when reached through the customer-side router unless protected
// by additional sales-auth middleware higher up the stack. Kept verbatim
// to preserve existing behaviour; migrate to routes/CMS_Routes/Sales/
// customerRequests.js when convenient.
// ═══════════════════════════════════════════════════════════════════════════

// CREATE edit request (sales-side context — uses req.user.id)
router.post("/:requestId/edit-request", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { customerInfo, reason, changes } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Reason for edit is required",
      });
    }

    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No changes specified",
      });
    }

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      });
    }

    if (request.status === "completed" || request.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Cannot edit completed or cancelled requests",
      });
    }

    const hasPendingEdit = request.editRequests.some(
      (edit) => edit.status === "pending_approval",
    );

    if (hasPendingEdit) {
      return res.status(400).json({
        success: false,
        message: "There is already a pending edit request for this order",
      });
    }

    const editRequestCount = await CustomerRequest.countDocuments({
      "editRequests.requestId": { $exists: true },
    });
    const editRequestId = `EDIT-${request.requestId}-${editRequestCount + 1}`;

    const editRequest = {
      requestId: editRequestId,
      requestedBy: req.user.id,
      requestedAt: new Date(),
      customerInfo: {
        name: customerInfo.name || request.customerInfo.name,
        email: customerInfo.email || request.customerInfo.email,
        phone: customerInfo.phone || request.customerInfo.phone,
        address: customerInfo.address || request.customerInfo.address,
        city: customerInfo.city || request.customerInfo.city,
        postalCode: customerInfo.postalCode || request.customerInfo.postalCode,
        description:
          customerInfo.description || request.customerInfo.description,
        deliveryDeadline:
          customerInfo.deliveryDeadline ||
          request.customerInfo.deliveryDeadline,
        preferredContactMethod:
          customerInfo.preferredContactMethod ||
          request.customerInfo.preferredContactMethod,
      },
      changes: changes,
      reason: reason.trim(),
      status: "pending_approval",
    };

    request.editRequests.unshift(editRequest);
    request.status = "pending_edit_approval";
    request.pendingEditRequest = editRequest._id;
    request.updatedAt = new Date();

    request.notes.push({
      text: `Edit request created: ${reason}`,
      addedBy: req.user.id,
      addedByModel: "SalesDepartment",
      createdAt: new Date(),
    });

    await request.save();

    res.json({
      success: true,
      message: "Edit request sent to customer for approval",
      editRequest,
      request,
    });
  } catch (error) {
    console.error("Error creating edit request:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating edit request",
    });
  }
});

// GET edit requests for a request
router.get("/:requestId/edit-requests", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId)
      .select("editRequests")
      .populate("editRequests.requestedBy", "name email")
      .populate("editRequests.reviewedBy", "name email");

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      });
    }

    res.json({
      success: true,
      editRequests: request.editRequests || [],
    });
  } catch (error) {
    console.error("Error fetching edit requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching edit requests",
    });
  }
});

// APPROVE edit request (sales-side context)
router.post("/:requestId/approve-edit", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body; // "approve_and_proceed"

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      });
    }

    const pendingEditIndex = request.editRequests.findIndex(
      (edit) => edit.status === "pending_approval",
    );

    if (pendingEditIndex === -1) {
      return res.status(400).json({
        success: false,
        message: "No pending edit request found",
      });
    }

    const pendingEdit = request.editRequests[pendingEditIndex];

    if (request.status !== "pending_edit_approval") {
      return res.status(400).json({
        success: false,
        message: "Request is not in edit approval status",
      });
    }

    request.editRequests[pendingEditIndex].status = "approved";
    request.editRequests[pendingEditIndex].reviewedBy = req.user.id;
    request.editRequests[pendingEditIndex].reviewedAt = new Date();
    request.editRequests[pendingEditIndex].reviewNotes =
      "Approved by sales team";

    if (action === "approve_and_proceed") {
      request.customerInfo = pendingEdit.customerInfo;
      request.status = "in_progress";
      request.pendingEditRequest = null;

      request.notes.push({
        text: "Edit request approved and applied. Order processing resumed.",
        addedBy: req.user.id,
        addedByModel: "SalesDepartment",
        createdAt: new Date(),
      });
    }

    request.updatedAt = new Date();
    await request.save();

    res.json({
      success: true,
      message: "Edit request approved",
      request,
    });
  } catch (error) {
    console.error("Error approving edit request:", error);
    res.status(500).json({
      success: false,
      message: "Server error while approving edit request",
    });
  }
});

// REJECT edit request (sales-side context)
router.post("/:requestId/reject-edit", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      });
    }

    const pendingEditIndex = request.editRequests.findIndex(
      (edit) => edit.status === "pending_approval",
    );

    if (pendingEditIndex === -1) {
      return res.status(400).json({
        success: false,
        message: "No pending edit request found",
      });
    }

    request.editRequests[pendingEditIndex].status = "rejected";
    request.editRequests[pendingEditIndex].reviewedBy = req.user.id;
    request.editRequests[pendingEditIndex].reviewedAt = new Date();
    request.editRequests[pendingEditIndex].reviewNotes =
      reason || "No reason provided";

    request.status = "in_progress";
    request.pendingEditRequest = null;

    request.notes.push({
      text: `Edit request rejected. Reason: ${reason || "No reason provided"}`,
      addedBy: req.user.id,
      addedByModel: "SalesDepartment",
      createdAt: new Date(),
    });

    request.updatedAt = new Date();
    await request.save();

    res.json({
      success: true,
      message: "Edit request rejected successfully",
      request,
    });
  } catch (error) {
    console.error("Error rejecting edit request:", error);
    res.status(500).json({
      success: false,
      message: "Server error while rejecting edit request",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /stock-items/available-items — legacy stock-items endpoint
// (older variant of /available-items, kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  "/stock-items/available-items",
  verifyCustomerToken,
  async (req, res) => {
    try {
      const { search = "", category = "" } = req.query;

      let query = { status: "In Stock" };

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { reference: { $regex: search, $options: "i" } },
          { category: { $regex: search, $options: "i" } },
        ];
      }

      if (category) query.category = category;

      const stockItems = await StockItem.find(query)
        .select(
          "_id name reference category baseSalesPrice salesPrice images attributes variants",
        )
        .limit(50)
        .lean();

      const processedItems = stockItems.map((item) => {
        const attributeData =
          item.attributes?.map((attr) => ({
            name: attr.name,
            values: attr.values || [],
          })) || [];

        const variants =
          item.variants?.map((variant) => ({
            _id: variant._id,
            attributes: variant.attributes || [],
            salesPrice: variant.salesPrice,
            quantityOnHand: variant.quantityOnHand || 0,
            images: variant.images || [],
          })) || [];

        return {
          _id: item._id,
          id: item._id,
          name: item.name,
          reference: item.reference,
          category: item.category,
          baseSalesPrice: item.baseSalesPrice || item.salesPrice || 0,
          images: item.images || [],
          attributes: attributeData,
          variants,
          hasVariants: variants.length > 0,
        };
      });

      const uniqueCategories = [
        ...new Set(processedItems.map((item) => item.category).filter(Boolean)),
      ];

      res.status(200).json({
        success: true,
        items: processedItems,
        categories: uniqueCategories,
      });
    } catch (error) {
      console.error("Error fetching available items:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching available items",
      });
    }
  },
);

module.exports = router;
