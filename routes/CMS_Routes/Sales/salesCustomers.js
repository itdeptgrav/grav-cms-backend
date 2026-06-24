// routes/CMS_Routes/Sales/salesCustomers.js
//
// Customer management for the Sales dashboard.
// Changes from v1:
//   - Password is optional on create; a temp password is auto-generated if omitted
//   - Welcome / password-reset / profile-update emails sent via salesEmailService
//   - hasPassword boolean added to list responses (password field has select:false)
//   - stock-items/search route moved BEFORE /:id to prevent param collision
//   - GET /:id/work-orders  — production work orders for a customer
//   - GET /:id/measurements — MPC measurement sessions for a customer
//   - profile.avatar field handled on create + update

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Measurement = require("../../../models/Customer_Models/Measurement");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { sendCustomerEmail } = require("../../../utils/salesEmailService");

// ── Temp password generator ───────────────────────────────────────────────────
const generateTempPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

// ─── GET /api/cms/sales/customers ─────────────────────────────────────────────
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 30,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      isActive,
    } = req.query;

    const filter = {};
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { customerId: re },
        { "profile.companyName": re },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const total = await Customer.countDocuments(filter);

    // Include password field to derive hasPassword boolean
    const rawCustomers = await Customer.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select("+password -cart -favorites -orders -__v")
      .lean();

    // Strip raw password, replace with boolean flag
    const customers = rawCustomers.map(({ password, ...c }) => ({
      ...c,
      hasPassword: !!password,
    }));

    const [total_all, active, withPassword, createdBySales] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ isActive: true }),
      Customer.countDocuments({ password: { $exists: true, $ne: null, $ne: "" } }),
      Customer.countDocuments({ createdBySales: true }),
    ]);

    res.json({
      success: true,
      customers,
      stats: { total: total_all, active, withPassword, createdBySales },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[salesCustomers] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers ───────────────────────────────────────────
router.post("/", salesAuth, async (req, res) => {
  try {
    const { name, password: rawPassword, profile = {} } = req.body;

    // ── Sanitise inputs first — trim whitespace so queries are clean ─────────
    const email = (req.body.email || "").trim().toLowerCase();
    const phone = (req.body.phone || "").trim();

    if (!name?.trim() || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
      });
    }

    // ── Check email uniqueness separately ────────────────────────────────────
    const emailExists = await Customer.findOne({ email }).select("_id").lean();
    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "A customer with this email address already exists",
      });
    }

    // ── Check phone uniqueness separately ────────────────────────────────────
    const phoneExists = await Customer.findOne({ phone }).select("_id").lean();
    if (phoneExists) {
      return res.status(409).json({
        success: false,
        message: "A customer with this phone number already exists",
      });
    }

    // Use provided password or auto-generate a secure temp password
    const tempPassword =
      rawPassword && rawPassword.trim().length >= 6
        ? rawPassword.trim()
        : generateTempPassword();

    const customer = await Customer.create({
      name: name.trim(),
      email,
      phone,
      password: tempPassword,        // hashed by pre-save hook
      profile: {
        ...profile,
        avatar: profile.avatar || null,
      },
      isActive: true,
      isEmailVerified: true,
      createdBySales: true,
      salesAssignedBy: req.user?.id,
      salesAssignedByName: req.user?.name || "Sales Team",
    });

    // Send welcome email (non-blocking — never fails the request)
    sendCustomerEmail("welcome", customer.email, {
      name: customer.name,
      customerId: customer.customerId,
      email: customer.email,
      password: tempPassword,
      salesRepName: req.user?.name,
      portalUrl: process.env.CUSTOMER_PORTAL_URL || "https://portal.gravclothing.com",
    }).catch(() => {});

    const safe = customer.toObject();
    delete safe.password;

    res.status(201).json({
      success: true,
      message: "Customer account created successfully",
      customer: safe,
      tempPassword,
    });
  } catch (err) {
    console.error("[salesCustomers] POST /", err);
    if (err.code === 11000) {
      // MongoDB unique index violation — tell the user exactly which field
      const field = Object.keys(err.keyValue || {})[0] || "field";
      const label = field === "email" ? "email address" : field === "phone" ? "phone number" : field;
      return res.status(409).json({
        success: false,
        message: `A customer with this ${label} already exists`,
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── IMPORTANT: Static sub-routes MUST come before /:id ──────────────────────

// ─── GET /api/cms/sales/customers/stock-items/search ─────────────────────────
router.get("/stock-items/search", salesAuth, async (req, res) => {
  try {
    const { q = "", limit = 200, category } = req.query;
    const filter = {};
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ name: re }, { reference: re }, { category: re }];
    }
    if (category && category !== "all") filter.category = category;

    const items = await StockItem.find(filter)
      .select("name reference category images variants baseSalesPrice attributes")
      .limit(parseInt(limit))
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id ────────────────────────────────────────
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const rawCustomer = await Customer.findById(req.params.id)
      .select("+password -cart -favorites -__v")
      .populate("assignedStockItems.stockItemId", "name reference category images variants")
      .lean();

    if (!rawCustomer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    const { password, ...customer } = rawCustomer;
    customer.hasPassword = !!password;

    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id ──────────────────────────────────────
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    delete req.body.password;

    // Capture what changed for the email notification
    const before = await Customer.findById(req.params.id)
      .select("name email phone profile")
      .lean();

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    ).select("-password -cart -favorites -__v");

    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    // Build changed-fields list for email
    const changedFields = [];
    if (before && req.body.name && before.name !== req.body.name)
      changedFields.push(["Name", req.body.name]);
    if (before && req.body.email && before.email !== req.body.email)
      changedFields.push(["Email", req.body.email]);
    if (before && req.body.phone && before.phone !== req.body.phone)
      changedFields.push(["Phone", req.body.phone]);
    if (req.body.profile?.companyName)
      changedFields.push(["Company", req.body.profile.companyName]);
    if (req.body.profile?.gstNumber)
      changedFields.push(["GST Number", req.body.profile.gstNumber]);

    if (changedFields.length > 0) {
      sendCustomerEmail("profileUpdate", customer.email, {
        name: customer.name,
        email: customer.email,
        updatedFields: changedFields,
        updatedBy: req.user?.name || "Sales Team",
      }).catch(() => {});
    }

    res.json({ success: true, message: "Customer updated", customer });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/reset-password ────────────────────────
router.post("/:id/reset-password", salesAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(newPassword, salt);

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { password: hashed },
      { new: true }
    ).select("name email");

    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    // Send password reset email (non-blocking)
    sendCustomerEmail("passwordReset", customer.email, {
      name: customer.name,
      email: customer.email,
      newPassword,
      resetBy: req.user?.name || "Sales Team",
      portalUrl: process.env.CUSTOMER_PORTAL_URL || "https://portal.gravclothing.com",
    }).catch(() => {});

    res.json({ success: true, message: "Password reset successfully. Notification sent to customer." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id/toggle-status ────────────────────────
router.patch("/:id/toggle-status", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    customer.isActive = !customer.isActive;
    await customer.save();

    res.json({
      success: true,
      message: `Customer ${customer.isActive ? "activated" : "deactivated"}`,
      isActive: customer.isActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/orders ─────────────────────────────────
// DEDICATED endpoint — always filters strictly by this customer's _id.
// Fixes the cross-contamination bug where the shared /requests route
// returned all requests when customerId param was ignored.
router.get("/:id/orders", salesAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
    const mongoose = require("mongoose");

    let custObjectId;
    try {
      custObjectId = new mongoose.Types.ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, message: "Invalid customer ID" });
    }

    const orders = await CustomerRequest.find({ customerId: custObjectId })
      .sort({ createdAt: -1 })
      .select(
        "requestId status priority requestType measurementName measurementId " +
        "customerInfo items finalOrderPrice totalPaidAmount totalDueAmount " +
        "quotations.quotationNumber quotations.grandTotal quotations.status " +
        "quotations.paymentSchedule quotations.paymentSubmissions " +
        "quotations.validUntil quotations.date quotations.notes " +
        "quotations.items quotations.totalGST quotations.subtotalBeforeGST " +
        "quotations.shippingCharges quotations.customAdditionalCharges " +
        "processingStartedAt estimatedCompletion actualCompletion " +
        "createdAt updatedAt"
      )
      .lean();

    res.json({ success: true, orders, total: orders.length });
  } catch (err) {
    console.error("[salesCustomers] GET /:id/orders", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/work-orders ────────────────────────────
router.get("/:id/work-orders", salesAuth, async (req, res) => {
  try {
    const workOrders = await WorkOrder.find({ customerId: req.params.id })
      .select(
        "workOrderNumber status quantity stockItemName stockItemReference variantAttributes priority timeline assignedDeadline createdAt isSplitOrder parentWorkOrderId productionCompletion.overallCompletionPercentage cuttingStatus"
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, workOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/measurements ───────────────────────────
// Returns measurement sessions for this customer.
// IMPORTANT: measured count = employeeMeasurements.length (anyone in the array
// has data entered — no status field needed per business rule).
router.get("/:id/measurements", salesAuth, async (req, res) => {
  try {
    const raw = await Measurement.find({ organizationId: req.params.id })
      .select(
        "name description registeredEmployeeIds employeeMeasurements " +
        "convertedToPO poConversionDate createdAt"
      )
      .sort({ createdAt: -1 })
      .lean();

    // Compute counts directly from array lengths — do NOT use stored
    // measuredEmployees / completionRate fields as they may be stale or
    // rely on isCompleted status which is not relevant here.
    const measurements = raw.map((m) => {
      const totalRegistered = m.registeredEmployeeIds?.length || m.employeeMeasurements?.length || 0;
      const actualMeasured  = m.employeeMeasurements?.length || 0;
      const pending         = Math.max(0, totalRegistered - actualMeasured);
      const completionRate  = totalRegistered > 0
        ? Math.round((actualMeasured / totalRegistered) * 100)
        : (actualMeasured > 0 ? 100 : 0);

      return {
        _id:                  m._id,
        name:                 m.name,
        description:          m.description,
        totalRegistered,
        actualMeasured,
        pending,
        completionRate,
        convertedToPO:        m.convertedToPO,
        poConversionDate:     m.poConversionDate,
        createdAt:            m.createdAt,
      };
    });

    res.json({ success: true, measurements });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id/assigned-items ─────────────────────────
router.get("/:id/assigned-items", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .select("assignedStockItems name customerId")
      .populate({
        path: "assignedStockItems.stockItemId",
        select: "name reference category images variants attributes baseSalesPrice",
      })
      .lean();

    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    res.json({ success: true, assignedItems: customer.assignedStockItems || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/assign-items ──────────────────────────
router.post("/:id/assign-items", salesAuth, async (req, res) => {
  try {
    const { stockItemIds = [], mode = "replace" } = req.body;

    if (!Array.isArray(stockItemIds))
      return res.status(400).json({ success: false, message: "stockItemIds must be an array" });

    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("name reference")
      .lean();

    const itemMap = {};
    stockItems.forEach((s) => { itemMap[s._id.toString()] = s; });

    const newAssignments = stockItemIds
      .filter((id) => itemMap[id])
      .map((id) => ({
        stockItemId: id,
        stockItemName: itemMap[id].name,
        stockItemReference: itemMap[id].reference,
        assignedAt: new Date(),
        assignedBy: req.user?.id,
        assignedByName: req.user?.name || "Sales",
      }));

    if (mode === "replace") {
      customer.assignedStockItems = newAssignments;
    } else {
      const existingIds = new Set(
        customer.assignedStockItems.map((a) => a.stockItemId.toString())
      );
      const toAdd = newAssignments.filter((a) => !existingIds.has(a.stockItemId.toString()));
      customer.assignedStockItems.push(...toAdd);
    }

    await customer.save();

    res.json({
      success: true,
      message: `${customer.assignedStockItems.length} item(s) assigned`,
      assignedCount: customer.assignedStockItems.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/cms/sales/customers/:id/assign-items/:itemId ────────────────
router.delete("/:id/assign-items/:itemId", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    customer.assignedStockItems = customer.assignedStockItems.filter(
      (a) =>
        a._id.toString() !== req.params.itemId &&
        a.stockItemId.toString() !== req.params.itemId
    );
    await customer.save();

    res.json({ success: true, message: "Item removed from customer" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;