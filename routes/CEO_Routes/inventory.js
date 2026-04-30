/**
 * routes/CEO_Routes/inventory.js
 * Register: app.use("/api/ceo/inventory", require("./routes/CEO_Routes/inventory"));
 */
"use strict";
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

function ceoAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res.status(403).json({ success: false, message: "CEO access required" });
    req.ceoUser = d; next();
  } catch { return res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

// ── Proxy helper ──────────────────────────────────────────────────────────────
const proxy = (targetPath) => async (req, res) => {
  try {
    const http = require("http");
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : `?${new URLSearchParams(req.query)}`;
    const port = process.env.PORT || 5000;
    const data = await new Promise((resolve, reject) => {
      const r = http.request({
        hostname: "127.0.0.1", port, path: `${targetPath}${qs}`, method: "GET",
        headers: { "Cookie": req.headers.cookie || "", "Content-Type": "application/json" }
      },
        (response) => { let b = ""; response.on("data", c => b += c); response.on("end", () => { try { resolve(JSON.parse(b)) } catch { reject(new Error("JSON")) } }); });
      r.on("error", reject); r.end();
    });
    res.json(data);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── RAW ITEMS ─────────────────────────────────────────────────────────────────
router.get("/raw-items/data/categories", ceoAuth, proxy("/api/cms/raw-items/data/categories"));
router.get("/raw-items/stats", ceoAuth, async (req, res) => {
  try {
    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
    const items = await RawItem.find({}).select("quantity minStock variants").lean();
    let total = 0, inStock = 0, lowStock = 0, outOfStock = 0;
    const ds = (q, m) => { const qn = Number(q) || 0, mn = Number(m) || 0; if (qn <= 0) return "Out of Stock"; if (qn <= mn) return "Low Stock"; return "In Stock"; };
    for (const it of items) {
      if (it.variants?.length > 0) { for (const v of it.variants) { total++; const s = ds(v.quantity, v.minStock ?? it.minStock); if (s === "In Stock") inStock++; else if (s === "Low Stock") lowStock++; else outOfStock++; } }
      else { total++; const s = ds(it.quantity, it.minStock); if (s === "In Stock") inStock++; else if (s === "Low Stock") lowStock++; else outOfStock++; }
    }
    res.json({ success: true, stats: { total, inStock, lowStock, outOfStock, totalItems: items.length } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.get("/raw-items/:id", ceoAuth, async (req, res) => {
  try {
    const http = require("http"); const port = process.env.PORT || 5000;
    const data = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: "127.0.0.1", port, path: `/api/cms/raw-items/${req.params.id}`, method: "GET", headers: { "Cookie": req.headers.cookie || "" } },
        response => { let b = ""; response.on("data", c => b += c); response.on("end", () => { try { resolve(JSON.parse(b)) } catch { reject(new Error("")) } }) });
      r.on("error", reject); r.end();
    });
    res.json(data);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.get("/raw-items", ceoAuth, proxy("/api/cms/raw-items"));

// ── STOCK ITEMS ───────────────────────────────────────────────────────────────
router.get("/stock-items/stats", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const items = await StockItem.find({}).select("status inventoryValue potentialRevenue profitMargin").lean();
    const total = items.length;
    const inStock = items.filter(i => i.status === "In Stock").length;
    const lowStock = items.filter(i => i.status === "Low Stock").length;
    const outOfStock = items.filter(i => i.status === "Out of Stock").length;
    const totalInventoryValue = items.reduce((s, i) => s + (i.inventoryValue || 0), 0);
    const totalPotentialRevenue = items.reduce((s, i) => s + (i.potentialRevenue || 0), 0);
    const avgMargin = total > 0 ? Math.round((items.reduce((s, i) => s + (i.profitMargin || 0), 0) / total) * 10) / 10 : 0;
    res.json({ success: true, stats: { total, inStock, lowStock, outOfStock, totalInventoryValue, totalPotentialRevenue, avgMargin } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/stock-items/categories", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const cats = await StockItem.distinct("category");
    res.json({ success: true, categories: cats.filter(Boolean).sort() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/stock-items/:id", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const item = await StockItem.findById(req.params.id).select("-createdBy -updatedBy -__v").lean();
    if (!item) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, stockItem: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/stock-items", ceoAuth, async (req, res) => {
  try {
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const { search, category, status, gender, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name: { $regex: search, $options: "i" } }, { reference: { $regex: search, $options: "i" } }];
    if (category && category !== "all") filter.category = category;
    if (status && status !== "all") filter.status = status;
    if (gender && gender !== "all") filter.genderCategory = gender;
    const total = await StockItem.countDocuments(filter);
    const items = await StockItem.find(filter)
      .select("name reference category genderCategory status images variants attributes totalQuantityOnHand inventoryValue potentialRevenue profitMargin averageSalesPrice averageCost operations updatedAt createdAt")
      .sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean();
    res.json({
      success: true, stockItems: items,
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


router.get("/purchase-orders/stats", ceoAuth, async (req, res) => {
  try {
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const all = await PurchaseOrder.find({}).select("status totalAmount").lean();
    const stats = {
      total: all.length,
      draft: all.filter(p => p.status === "DRAFT").length,
      issued: all.filter(p => p.status === "ISSUED").length,
      partiallyReceived: all.filter(p => p.status === "PARTIALLY_RECEIVED").length,
      completed: all.filter(p => p.status === "COMPLETED").length,
      cancelled: all.filter(p => p.status === "CANCELLED").length,
      totalAmount: all.reduce((s, p) => s + (p.totalAmount || 0), 0),
      pendingAmount: all.filter(p => ["ISSUED", "PARTIALLY_RECEIVED"].includes(p.status)).reduce((s, p) => s + (p.totalAmount || 0), 0),
    };
    res.json({ success: true, stats });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/purchase-orders/vendors", ceoAuth, async (req, res) => {
  try {
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const vendors = await PurchaseOrder.distinct("vendorName");
    res.json({ success: true, vendors: vendors.filter(Boolean).sort() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/purchase-orders/:id", ceoAuth, async (req, res) => {
  try {
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const po = await PurchaseOrder.findById(req.params.id)
      .populate("vendor", "companyName contactPerson email phone")
      .lean();
    if (!po) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, purchaseOrder: po });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/purchase-orders", ceoAuth, async (req, res) => {
  try {
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const { search, status, vendor, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { poNumber: { $regex: search, $options: "i" } },
      { vendorName: { $regex: search, $options: "i" } },
      { "items.itemName": { $regex: search, $options: "i" } },
    ];
    if (status && status !== "all") filter.status = status;
    if (vendor && vendor !== "all") filter.vendorName = vendor;
    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }
    const total = await PurchaseOrder.countDocuments(filter);
    const pos = await PurchaseOrder.find(filter)
      .select("poNumber vendor vendorName orderDate expectedDeliveryDate status items subtotal taxRate taxAmount shippingCharges discount totalAmount paymentTerms notes createdAt updatedAt")
      .populate("vendor", "companyName contactPerson")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();
    res.json({
      success: true, purchaseOrders: pos,
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


router.get("/machines/:id", ceoAuth, async (req, res) => {
  try {
    const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
    const m = await Machine.findById(req.params.id).select("-createdBy -updatedBy -__v").lean();
    if (!m) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, machine: m });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/machines", ceoAuth, async (req, res) => {
  try {
    const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
    const { search, status, type, location } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { model: { $regex: search, $options: "i" } },
      { serialNumber: { $regex: search, $options: "i" } },
      { type: { $regex: search, $options: "i" } },
    ];
    if (status && status !== "all") filter.status = status;
    if (type && type !== "all") filter.type = type;
    if (location && location !== "all") filter.location = location;

    const machines = await Machine.find(filter)
      .select("-createdBy -updatedBy -__v")
      .sort({ name: 1 })
      .lean();

    // Stats
    const all = await Machine.find({}).select("status").lean();
    const stats = {
      total: all.length,
      operational: all.filter(m => m.status === "Operational").length,
      idle: all.filter(m => m.status === "Idle").length,
      maintenance: all.filter(m => m.status === "Under Maintenance").length,
      repairNeeded: all.filter(m => m.status === "Repair Needed").length,
    };

    // Filter options from current full dataset
    const allFull = await Machine.find({}).select("type location status").lean();
    const filters = {
      types: [...new Set(allFull.map(m => m.type).filter(Boolean))].sort(),
      locations: [...new Set(allFull.map(m => m.location).filter(Boolean))].sort(),
      statuses: ["Operational", "Idle", "Under Maintenance", "Repair Needed"],
    };

    res.json({ success: true, machines, stats, filters });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


router.get("/vendors/stats", ceoAuth, async (req, res) => {
  try {
    const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

    const all = await Vendor.find({}).select("status rating vendorType").lean();
    const total = all.length;
    const active = all.filter(v => v.status === "Active").length;
    const inactive = all.filter(v => v.status === "Inactive").length;
    const blacklisted = all.filter(v => v.status === "Blacklisted").length;
    const avgRating = total > 0
      ? Math.round((all.reduce((s, v) => s + (v.rating || 3), 0) / total) * 10) / 10
      : 0;

    // Total spend across all POs
    const pos = await PurchaseOrder.find({}).select("totalAmount").lean();
    const totalSpend = pos.reduce((s, p) => s + (p.totalAmount || 0), 0);

    res.json({ success: true, stats: { total, active, inactive, blacklisted, avgRating, totalSpend } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/vendors/:id", ceoAuth, async (req, res) => {
  try {
    const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");

    const vendor = await Vendor.findById(req.params.id).select("-createdBy -updatedBy -__v").lean();
    if (!vendor) return res.status(404).json({ success: false, message: "Not found" });

    // Purchase orders for this vendor
    const pos = await PurchaseOrder.find({
      $or: [{ vendor: vendor._id }, { vendorName: vendor.companyName }]
    }).select("poNumber status totalAmount orderDate expectedDeliveryDate items createdAt").sort({ createdAt: -1 }).limit(10).lean();

    const totalOrders = pos.length;
    const totalSpent = pos.reduce((s, p) => s + (p.totalAmount || 0), 0);
    const pending = pos.filter(p => ["ISSUED", "PARTIALLY_RECEIVED"].includes(p.status)).length;
    const completed = pos.filter(p => p.status === "COMPLETED").length;

    // Items supplied via vendorNicknames in RawItem
    const rawItems = await RawItem.find({
      "vendorNicknames.vendor": vendor._id
    }).select("name sku category quantity unit vendorNicknames").lean();

    res.json({
      success: true, vendor,
      purchaseOrders: pos,
      poStats: { totalOrders, totalSpent, pending, completed },
      itemsSupplied: rawItems,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/vendors", ceoAuth, async (req, res) => {
  try {
    const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
    const { search, status, type, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { companyName: { $regex: search, $options: "i" } },
      { contactPerson: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { "address.city": { $regex: search, $options: "i" } },
      { vendorType: { $regex: search, $options: "i" } },
    ];
    if (status && status !== "all") filter.status = status;
    if (type && type !== "all") filter.vendorType = type;

    const total = await Vendor.countDocuments(filter);
    const vendors = await Vendor.find(filter)
      .select("companyName vendorType contactPerson email phone address status rating primaryProducts gstNumber notes createdAt updatedAt")
      .sort({ companyName: 1 })
      .skip((page - 1) * limit).limit(Number(limit))
      .lean();

    // Vendor type options
    const types = await Vendor.distinct("vendorType");

    res.json({
      success: true, vendors, types: types.filter(Boolean).sort(),
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


module.exports = router;