// routes/CMS_Routes/Sales/salesCustomers.js
//
// All customer management actions done by the Sales team:
//   • List / search customers
//   • Create customer (with hashed password, auto login-ready)
//   • View customer detail
//   • Update customer info
//   • Reset customer password (sales admin action)
//   • Assign / remove stock items visible to the customer
//   • Soft-delete (deactivate) customer

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Customer = require("../../../models/Customer_Models/Customer");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

// ─── Helper ───────────────────────────────────────────────────────────────────
const generateCustomerId = async () => {
  const count = await Customer.countDocuments();
  return `CUST-${String(count + 1).padStart(4, "0")}`;
};

// ─── GET /api/cms/sales/customers ─────────────────────────────────────────────
// List customers with search + pagination + stats
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
    const customers = await Customer.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select("-password -cart -favorites -orders -__v")
      .lean();

    const stats = {
      total: await Customer.countDocuments(),
      active: await Customer.countDocuments({ isActive: true }),
      withPassword: await Customer.countDocuments({
        password: { $exists: true, $ne: null },
      }),
      createdBySales: await Customer.countDocuments({ createdBySales: true }),
    };

    res.json({
      success: true,
      customers,
      stats,
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
// Create a new customer account (sales-created, password-ready for portal login)
router.post("/", salesAuth, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password, // plain text — will be hashed by pre-save hook
      profile = {},
    } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
      });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    // Check duplicates
    const existing = await Customer.findOne({
      $or: [{ email: email.toLowerCase() }, { phone }],
    });
    if (existing) {
      const field = existing.email === email.toLowerCase() ? "email" : "phone";
      return res.status(409).json({
        success: false,
        message: `A customer with this ${field} already exists`,
      });
    }

    const customer = await Customer.create({
      name,
      email: email.toLowerCase(),
      phone,
      password, // hashed by pre-save
      profile,
      isActive: true,
      isEmailVerified: true,
      createdBySales: true,
      salesAssignedBy: req.user?.id,
      salesAssignedByName: req.user?.name || "Sales",
    });

    // Return without password
    const safe = customer.toObject();
    delete safe.password;

    res.status(201).json({
      success: true,
      message: "Customer account created successfully",
      customer: safe,
    });
  } catch (err) {
    console.error("[salesCustomers] POST /", err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res
        .status(409)
        .json({ success: false, message: `${field} already exists` });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/:id ────────────────────────────────────────
// Full detail view — includes assigned stock items populated
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .select("-password -cart -favorites -__v")
      .populate(
        "assignedStockItems.stockItemId",
        "name reference category images variants",
      )
      .lean();

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    // Total orders count
    const orderCount = customer.orders?.length || 0;

    res.json({ success: true, customer, orderCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id ──────────────────────────────────────
// Update customer basic info (not password — use separate endpoint)
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    // Never allow password changes through this generic endpoint
    delete req.body.password;

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    ).select("-password -cart -favorites -__v");

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    res.json({ success: true, message: "Customer updated", customer });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/reset-password ────────────────────────
// Sales admin sets a new password for the customer
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

    await Customer.findByIdAndUpdate(req.params.id, { password: hashed });

    res.json({
      success: true,
      message: "Customer password has been reset successfully",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/customers/:id/toggle-status ────────────────────────
router.patch("/:id/toggle-status", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

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

// ─── GET /api/cms/sales/customers/:id/assigned-items ─────────────────────────
// Get the assigned stock items for a customer (with full stock item details)
router.get("/:id/assigned-items", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .select("assignedStockItems name customerId")
      .populate({
        path: "assignedStockItems.stockItemId",
        select:
          "name reference category images variants attributes baseSalesPrice",
      })
      .lean();

    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    res.json({
      success: true,
      assignedItems: customer.assignedStockItems || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/sales/customers/:id/assign-items ──────────────────────────
// Assign stock items to a customer (replaces entire list OR appends)
// Body: { stockItemIds: ["id1", "id2", ...], mode: "replace" | "append" }
router.post("/:id/assign-items", salesAuth, async (req, res) => {
  try {
    const { stockItemIds = [], mode = "replace" } = req.body;

    if (!Array.isArray(stockItemIds)) {
      return res
        .status(400)
        .json({ success: false, message: "stockItemIds must be an array" });
    }

    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    // Fetch the stock items to get their names/refs
    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("name reference")
      .lean();

    const itemMap = {};
    stockItems.forEach((s) => {
      itemMap[s._id.toString()] = s;
    });

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
      // Append — avoid duplicates
      const existingIds = new Set(
        customer.assignedStockItems.map((a) => a.stockItemId.toString()),
      );
      const toAdd = newAssignments.filter(
        (a) => !existingIds.has(a.stockItemId.toString()),
      );
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
// Remove a single assigned item from a customer
router.delete("/:id/assign-items/:itemId", salesAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer)
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });

    customer.assignedStockItems = customer.assignedStockItems.filter(
      (a) =>
        a._id.toString() !== req.params.itemId &&
        a.stockItemId.toString() !== req.params.itemId,
    );
    await customer.save();

    res.json({ success: true, message: "Item removed from customer" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/sales/customers/stock-items/search ─────────────────────────
// Search stock items to assign to a customer
router.get("/stock-items/search", salesAuth, async (req, res) => {
  try {
    const { q = "", limit = 20 } = req.query;
    const filter = {};
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ name: re }, { reference: re }, { category: re }];
    }

    const items = await StockItem.find(filter)
      .select(
        "name reference category images variants baseSalesPrice attributes",
      )
      .limit(parseInt(limit))
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
