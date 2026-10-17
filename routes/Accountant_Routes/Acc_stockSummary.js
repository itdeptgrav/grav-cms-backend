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
const { loadRawInputs } = require("../../services/accounting/stockSummaryData");

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

    let StockItem = null;
    try {
      StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    } catch { /* no product catalogue */ }

    /* raw materials through the loader the purchase voucher's item list
       uses too (services/accounting/stockSummaryData.js) */
    const empty = { raws: [], factorByMovement: new Map(), poPriceOf: () => null };
    const [raw, products] = await Promise.all([
      kind === "product" ? empty : loadRawInputs({ ordersUpTo: to }),
      kind === "raw" || !StockItem
        ? []
        : StockItem.find({ deletedAt: null, isActive: { $ne: false } })
            .select("name reference category genderCategory unit totalQuantityOnHand averageCost baseCost variants.quantityOnHand variants.cost variants.status")
            .lean(),
    ]);
    const { raws, factorByMovement, poPriceOf } = raw;

    let rows = [
      ...raws.map((r) => rawItemRow(r, { from, to, now, factorByMovement, poPrice: (variantId) => poPriceOf(r._id, variantId) })),
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
