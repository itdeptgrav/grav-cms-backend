// routes/CMS_Routes/Store/purchaseOrderRoutes.js
//
// Mount in server.js:
//   const purchaseOrderRoutes = require("./routes/CMS_Routes/Store/purchaseOrderRoutes");
//   app.use("/api/cms/store/purchase-orders", purchaseOrderRoutes);

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const PurchaseOrder = require("../../../models/CMS_Models/Store/PurchaseOrder");
const PurchaseOrderSettings = require("../../../models/CMS_Models/Store/PurchaseOrderSettings");

router.use(EmployeeAuthMiddleware);

const ALLOWED_STATUSES = ["Draft", "Ordered", "Received"];
const ALLOWED_PRIORITIES = ["Emergency", "Urgent", "Neutral"];

async function consumeNextNumber() {
  const s = await PurchaseOrderSettings.getSettings();
  s.counter = (s.counter || 0) + 1;
  await s.save();
  const padded = String(s.counter).padStart(s.padding || 0, "0");
  return `${s.prefix}${padded}${s.suffix}`;
}

// ── LIST + stats ──
router.get("/", async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status && ALLOWED_STATUSES.includes(status)) filter.status = status;
    if (search) {
      filter.$or = [
        { poNumber: { $regex: search, $options: "i" } },
        { vendorName: { $regex: search, $options: "i" } },
      ];
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const stats = {
      total: purchaseOrders.length,
      draft: purchaseOrders.filter((p) => p.status === "Draft").length,
      ordered: purchaseOrders.filter((p) => p.status === "Ordered").length,
      received: purchaseOrders.filter((p) => p.status === "Received").length,
    };

    return res.json({ success: true, purchaseOrders, stats });
  } catch (err) {
    console.error("PO list error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PEEK next number ──
router.get("/next-number", async (req, res) => {
  try {
    const nextNumber = await PurchaseOrderSettings.peekNextNumber();
    return res.json({ success: true, nextNumber });
  } catch (err) {
    console.error("PO next-number error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── SETTINGS ──
router.get("/settings", async (req, res) => {
  try {
    const s = await PurchaseOrderSettings.getSettings();
    return res.json({
      success: true,
      settings: {
        prefix: s.prefix,
        suffix: s.suffix,
        padding: s.padding,
        counter: s.counter,
      },
    });
  } catch (err) {
    console.error("PO get-settings error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const { prefix, suffix, padding } = req.body || {};
    const s = await PurchaseOrderSettings.getSettings();
    if (prefix !== undefined) s.prefix = String(prefix);
    if (suffix !== undefined) s.suffix = String(suffix);
    if (padding !== undefined) s.padding = Number(padding) || 0;
    await s.save();
    return res.json({
      success: true,
      message: "Purchase order numbering settings updated",
      settings: {
        prefix: s.prefix,
        suffix: s.suffix,
        padding: s.padding,
        counter: s.counter,
      },
    });
  } catch (err) {
    console.error("PO put-settings error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── VENDOR NAME SUGGESTIONS ──
router.get("/vendor-suggestions", async (req, res) => {
  try {
    const { q } = req.query;
    const match = { vendorName: { $nin: [null, ""] } };
    if (q) match.vendorName = { $regex: q, $options: "i" };

    const docs = await PurchaseOrder.find(match)
      .select(
        "vendorName vendorPhone vendorAddress vendorGstin shipToAddress billToAddress",
      )
      .sort({ updatedAt: -1 })
      .lean();

    const seen = new Set();
    const suggestions = [];
    for (const d of docs) {
      const key = d.vendorName.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        name: d.vendorName,
        phone: d.vendorPhone || "",
        address: d.vendorAddress || "",
        gstin: d.vendorGstin || "",
        shipTo: d.shipToAddress || "",
        billTo: d.billToAddress || "",
      });
    }

    return res.json({ success: true, suggestions });
  } catch (err) {
    console.error("PO vendor-suggestions error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── SINGLE ──
router.get("/:id", async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id).lean();
    if (!po)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });
    return res.json({ success: true, purchaseOrder: po });
  } catch (err) {
    console.error("PO get error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── CREATE ──
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    let poNumber = (body.poNumber || "").trim();
    if (!poNumber) {
      poNumber = await consumeNextNumber();
    } else {
      const clash = await PurchaseOrder.findOne({ poNumber });
      if (clash) {
        return res.status(409).json({
          success: false,
          message: `Purchase order number "${poNumber}" already exists`,
        });
      }
    }

    const po = new PurchaseOrder({
      poNumber,
      orderType: body.orderType || "",
      vendorName: body.vendorName || "",
      vendorPhone: body.vendorPhone || "",
      vendorAddress: body.vendorAddress || "",
      vendorGstin: body.vendorGstin || "",
      shipToAddress: body.shipToAddress || "",
      billToAddress: body.billToAddress || "",
      reasonForPurchase: body.reasonForPurchase || "",
      paymentTerms: body.paymentTerms || "",
      deliveryTerms: body.deliveryTerms || "",
      invoiceNumber: body.invoiceNumber || "",
      lineSectionLabel: body.lineSectionLabel || "Items",
      items: Array.isArray(body.items) ? body.items : [],
      customHeaderFields: Array.isArray(body.customHeaderFields)
        ? body.customHeaderFields
        : [],
      status: ALLOWED_STATUSES.includes(body.status) ? body.status : "Draft",
      priority: ALLOWED_PRIORITIES.includes(body.priority)
        ? body.priority
        : "Neutral",
      poDate: body.poDate || null,
      expectedDate: body.expectedDate || null,
      createdBy: req.user?.id || null,
    });

    await po.save();
    return res.status(201).json({
      success: true,
      message: "Purchase order created",
      purchaseOrder: po,
    });
  } catch (err) {
    console.error("PO create error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── UPDATE ──
router.put("/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    if (body.poNumber !== undefined) {
      const newNum = String(body.poNumber).trim();
      if (newNum && newNum !== po.poNumber) {
        const clash = await PurchaseOrder.findOne({
          poNumber: newNum,
          _id: { $ne: po._id },
        });
        if (clash) {
          return res.status(409).json({
            success: false,
            message: `Purchase order number "${newNum}" already exists`,
          });
        }
        po.poNumber = newNum;
      }
    }

    if (body.orderType !== undefined) po.orderType = body.orderType;
    if (body.vendorName !== undefined) po.vendorName = body.vendorName;
    if (body.vendorPhone !== undefined) po.vendorPhone = body.vendorPhone;
    if (body.vendorAddress !== undefined) po.vendorAddress = body.vendorAddress;
    if (body.vendorGstin !== undefined) po.vendorGstin = body.vendorGstin;
    if (body.shipToAddress !== undefined) po.shipToAddress = body.shipToAddress;
    if (body.billToAddress !== undefined) po.billToAddress = body.billToAddress;
    if (body.reasonForPurchase !== undefined)
      po.reasonForPurchase = body.reasonForPurchase;
    if (body.paymentTerms !== undefined) po.paymentTerms = body.paymentTerms;
    if (body.deliveryTerms !== undefined) po.deliveryTerms = body.deliveryTerms;
    if (body.invoiceNumber !== undefined) po.invoiceNumber = body.invoiceNumber;
    if (body.lineSectionLabel !== undefined)
      po.lineSectionLabel = body.lineSectionLabel || "Items";
    if (body.items !== undefined)
      po.items = Array.isArray(body.items) ? body.items : [];
    if (body.customHeaderFields !== undefined)
      po.customHeaderFields = Array.isArray(body.customHeaderFields)
        ? body.customHeaderFields
        : [];
    if (body.status && ALLOWED_STATUSES.includes(body.status))
      po.status = body.status;
    if (body.priority && ALLOWED_PRIORITIES.includes(body.priority))
      po.priority = body.priority;
    if (body.poDate !== undefined) po.poDate = body.poDate || null;
    if (body.expectedDate !== undefined)
      po.expectedDate = body.expectedDate || null;
    po.updatedBy = req.user?.id || null;

    await po.save();
    return res.json({
      success: true,
      message: "Purchase order updated",
      purchaseOrder: po,
    });
  } catch (err) {
    console.error("PO update error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── CHANGE STATUS (Draft → Ordered → Received) ──
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`,
      });
    }

    const po = await PurchaseOrder.findById(req.params.id);
    if (!po)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    po.status = status;
    if (status === "Received" && !po.receivedDate) po.receivedDate = new Date();
    po.updatedBy = req.user?.id || null;
    await po.save();

    return res.json({
      success: true,
      message: `Status updated to ${status}`,
      purchaseOrder: po,
    });
  } catch (err) {
    console.error("PO status error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE ──
router.delete("/:id", async (req, res) => {
  try {
    const po = await PurchaseOrder.findByIdAndDelete(req.params.id);
    if (!po)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });
    return res.json({ success: true, message: "Purchase order deleted" });
  } catch (err) {
    console.error("PO delete error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
