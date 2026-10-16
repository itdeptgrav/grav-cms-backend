"use strict";

/**
 * What the raw-material price and value rules read, loaded ONCE in one place
 * (16 Oct 2026). Both the Stock Summary (GET /api/accountant/stock-summary)
 * and the purchase-side voucher item list (GET /api/accountant/vouchers/
 * raw-materials) load through here, so the two cannot read different data:
 *
 *   raws              RawItem — quantity, variants (quantity, supplier prices),
 *                     every stock movement (CMS Store › Inventory)
 *   orders            live purchase orders, newest first — the latest price
 *                     per material / variant (CMS Store › Purchase orders)
 *   units             the unit master — converting a price per box into a
 *                     price per piece (CMS Store › Configurations › Units)
 *   factorByMovement  a goods receipt line's conversion factor, by the stock
 *                     movement it wrote (CMS Store › Receive / GRN)
 *   poPriceOf         materialPrices.latestPoPrices over the above
 */

const { latestPoPrices } = require("./materialPrices");

const RAW_FIELDS = [
  "name sku category customCategory unit customUnit quantity primaryVendor",
  "stockTransactions._id stockTransactions.type stockTransactions.quantity stockTransactions.createdAt stockTransactions.updatedAt",
  "stockTransactions.previousQuantity stockTransactions.newQuantity stockTransactions.unitPrice stockTransactions.variantId",
  "stockTransactions.variantPreviousQuantity stockTransactions.variantNewQuantity",
  "variants._id variants.combination variants.sku variants.quantity variants.vendorNicknames.price variants.vendorNicknames.vendor",
].join(" ");

/**
 * @param {object} [o]
 * @param {Date}   [o.ordersUpTo]  only purchase orders created up to this instant
 * @param {string} [o.extraRawFields] more RawItem fields the caller needs
 */
async function loadRawInputs({ ordersUpTo = null, extraRawFields = "" } = {}) {
  const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
  const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
  const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
  const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");

  const live = { status: { $nin: ["CANCELLED", "Cancelled", "DRAFT", "Draft"] } };
  if (ordersUpTo) live.createdAt = { $lte: ordersUpTo };
  const [raws, orders, receipts, units] = await Promise.all([
    RawItem.find({}).sort({ name: 1 }).select(`${RAW_FIELDS} ${extraRawFields}`.trim()).lean(),
    PurchaseOrder.find(live)
      .sort({ orderDate: -1, createdAt: -1 })
      .select("items.rawItem items.variantId items.unit items.unitPrice items.gstRate")
      .limit(1000)
      .lean(),
    GoodsReceipt.find({ "lines.conversionFactor": { $nin: [1, null] } })
      .select("lines.conversionFactor lines.stockLedgerRef.transactionId")
      .lean(),
    Unit.find({}).select("name conversions").populate("conversions.toUnit", "name").lean(),
  ]);

  const factorByMovement = new Map();
  for (const g of receipts)
    for (const l of g.lines || [])
      if (l.stockLedgerRef && l.stockLedgerRef.transactionId && Number(l.conversionFactor) > 0)
        factorByMovement.set(String(l.stockLedgerRef.transactionId), Number(l.conversionFactor));
  const stockUnit = new Map(raws.map((r) => [String(r._id), r.customUnit || r.unit || ""]));
  const poPriceOf = latestPoPrices(orders, (id) => stockUnit.get(id) || "", units);
  return { raws, orders, units, factorByMovement, poPriceOf };
}

module.exports = { loadRawInputs };
