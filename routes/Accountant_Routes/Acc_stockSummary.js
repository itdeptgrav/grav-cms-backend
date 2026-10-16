"use strict";

/**
 * GET /api/accountant/stock-summary?companyId=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &kind=raw|product|all&q=
 *
 * The inventory's stock, for accounts (13 Oct 2026). Raw materials as a
 * period statement — opening, inward, outward, closing, rate, value — from
 * their movement history; finished products as today's quantity and cost.
 * Every rule is services/accounting/stockSummary.js. Read only.
 */

const express = require("express");
const { accountantAuth, requireCompanyScope } = require("../../Middlewear/AccountantAuthMiddleware");
const { rawItemRow, productRow, istDay, summarise } = require("../../services/accounting/stockSummary");

const router = express.Router();
router.use(accountantAuth);

router.get("/", (req, res, next) => requireCompanyScope(req, res, next), async (req, res) => {
  try {
    const { companyId, q } = req.query;
    if (!companyId) return res.status(400).json({ success: false, message: "companyId required" });
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const toStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : today;
    const fromStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : toStr;
    if (fromStr > toStr) return res.status(400).json({ success: false, message: "From is after To." });
    const from = istDay(fromStr, false);
    const to = istDay(toStr, true);
    const now = new Date();
    const kind = ["raw", "product"].includes(req.query.kind) ? req.query.kind : "all";

    const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    let StockItem = null;
    try {
      StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    } catch { /* no product catalogue */ }

    const [raws, orders, products] = await Promise.all([
      kind === "product"
        ? []
        : RawItem.find({})
            .select("name sku category customCategory unit customUnit quantity stockTransactions.createdAt stockTransactions.updatedAt stockTransactions.previousQuantity stockTransactions.newQuantity stockTransactions.unitPrice variants.vendorNicknames.price")
            .lean(),
      kind === "product"
        ? []
        : PurchaseOrder.find({ status: { $nin: ["CANCELLED", "Cancelled", "DRAFT", "Draft"] }, createdAt: { $lte: to } })
            .sort({ orderDate: -1, createdAt: -1 })
            .select("items.rawItem items.unitPrice")
            .limit(1000)
            .lean(),
      kind === "raw" || !StockItem
        ? []
        : StockItem.find({ deletedAt: null, isActive: { $ne: false } })
            .select("name reference category genderCategory unit totalQuantityOnHand averageCost baseCost variants.quantityOnHand variants.cost variants.status")
            .lean(),
    ]);
    const lastPo = new Map();
    for (const o of orders)
      for (const l of o.items || [])
        if (l.rawItem && Number(l.unitPrice) > 0 && !lastPo.has(String(l.rawItem))) lastPo.set(String(l.rawItem), Number(l.unitPrice));

    let rows = [
      ...raws.map((r) => rawItemRow(r, { from, to, now, lastPoPrice: lastPo.get(String(r._id)) })),
      ...products.map(productRow),
    ];
    if (q) {
      const n = String(q).toLowerCase();
      rows = rows.filter((r) => [r.name, r.sku, r.category].some((v) => String(v || "").toLowerCase().includes(n)));
    }
    rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "raw" ? -1 : 1) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    res.json({
      success: true,
      from: fromStr,
      to: toStr,
      endsToday: to >= now,
      raw: summarise(rows.filter((r) => r.kind === "raw")),
      products: summarise(rows.filter((r) => r.kind === "product")),
      rows,
    });
  } catch (e) {
    console.error("[stock-summary]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
