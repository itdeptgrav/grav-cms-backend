// services/stockAccountability.service.js
//
// Reads every stock movement across every raw item as one ledger, for the
// store's Accountability view.
//
// Stock movements live inside RawItem.stockTransactions, so "all transactions
// between two dates" needs an unwind. The pipeline pre-filters documents on the
// array before unwinding so only raw items that actually moved in the window
// are expanded — without that, every unwind walks the entire catalogue's
// history.
//
// Classification is done HERE and nowhere else, so the table, the totals and
// the charts can never disagree about what counts as a debit.

const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");

// ── Categories ────────────────────────────────────────────────────────────
// `type` alone is not enough: an MRF return and a purchase receipt are both
// recorded as ADD/VARIANT_ADD. The reason string is what separates them, and
// it is written by the code that creates the movement (see mrfRoutes.js).
const CATEGORY = {
  CREDIT: "CREDIT",       // stock in — manual additions, corrections
  DEBIT: "DEBIT",         // stock out — issued or consumed
  RETURN: "RETURN",       // came back from an employee against an MRF
  PURCHASE: "PURCHASE",   // received against a purchase order
};

const CATEGORY_LABEL = {
  CREDIT: "Material Credit",
  DEBIT: "Material Debit",
  RETURN: "Material Return",
  PURCHASE: "Purchase Receipt",
};

const IN_TYPES = ["ADD", "VARIANT_ADD", "PURCHASE_ORDER"];
const OUT_TYPES = ["REDUCE", "VARIANT_REDUCE", "CONSUME"];

/** Which bucket a movement belongs to. */
function classify(tx) {
  const reason = String(tx.reason || "");
  const type = String(tx.type || "");

  if (/return/i.test(reason)) return CATEGORY.RETURN;
  if (type === "PURCHASE_ORDER" || tx.purchaseOrder || tx.purchaseOrderId) return CATEGORY.PURCHASE;
  if (OUT_TYPES.includes(type)) return CATEGORY.DEBIT;
  if (IN_TYPES.includes(type)) return CATEGORY.CREDIT;
  return CATEGORY.CREDIT;
}

/** Signed effect on stock — +1 in, -1 out. Drives the net-movement figure. */
function direction(tx) {
  return OUT_TYPES.includes(String(tx.type || "")) ? -1 : 1;
}

const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Local YYYY-MM-DD, for grouping a day's movements together. */
function dayKey(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * Every movement in [from, to], flattened and classified.
 *
 * @param {Date}   from
 * @param {Date}   to
 * @param {object} opts { category, search, itemId }
 */
async function listMovements(from, to, opts = {}) {
  const { category, search = "", itemId } = opts;

  const match = {
    stockTransactions: {
      $elemMatch: { createdAt: { $gte: from, $lte: to } },
    },
  };
  if (itemId) match._id = new (require("mongoose").Types.ObjectId)(itemId);

  const docs = await RawItem.find(match)
    .select("name sku unit customUnit category variants stockTransactions")
    .populate("stockTransactions.performedBy", "firstName lastName name email")
    .populate("stockTransactions.supplierId", "companyName")
    .lean();

  const variantLabel = (doc, tx) => {
    if (Array.isArray(tx.variantCombination) && tx.variantCombination.length) {
      return tx.variantCombination.join(" · ");
    }
    if (!tx.variantId) return "";
    const v = (doc.variants || []).find(x => String(x._id) === String(tx.variantId));
    return v ? (v.combination || []).join(" · ") : "";
  };

  const rows = [];
  for (const doc of docs) {
    const unit = doc.customUnit || doc.unit || "";
    for (const tx of doc.stockTransactions || []) {
      const at = tx.createdAt ? new Date(tx.createdAt) : null;
      if (!at || at < from || at > to) continue;

      const cat = classify(tx);
      if (category && category !== "ALL" && cat !== category) continue;

      const performer = tx.performedBy
        ? ([tx.performedBy.firstName, tx.performedBy.lastName].filter(Boolean).join(" ")
          || tx.performedBy.name || tx.performedBy.email || "")
        : "";
      const vendor = tx.supplierId?.companyName || tx.supplier || "";

      const row = {
        _id: String(tx._id || `${doc._id}-${at.getTime()}`),
        at,
        day: dayKey(at),
        itemId: String(doc._id),
        itemName: doc.name,
        sku: doc.sku || "",
        itemCategory: doc.category || "",
        unit,
        variant: variantLabel(doc, tx),
        type: tx.type,
        category: cat,
        categoryLabel: CATEGORY_LABEL[cat],
        direction: direction(tx),
        quantity: round(tx.quantity),
        signedQuantity: round(direction(tx) * (tx.quantity || 0)),
        previousQuantity: round(tx.previousQuantity),
        newQuantity: round(tx.newQuantity),
        reason: tx.reason || "",
        notes: tx.notes || "",
        vendor,
        unitPrice: round(tx.unitPrice),
        value: round((tx.unitPrice || 0) * (tx.quantity || 0)),
        purchaseOrder: tx.purchaseOrder || "",
        invoiceNumber: tx.invoiceNumber || "",
        performedBy: performer,
      };

      if (search) {
        const q = search.toLowerCase();
        const hay = [
          row.itemName, row.sku, row.variant, row.reason, row.notes,
          row.vendor, row.purchaseOrder, row.invoiceNumber, row.performedBy,
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) continue;
      }

      rows.push(row);
    }
  }

  rows.sort((a, b) => b.at - a.at);
  return rows;
}

/**
 * Everything the charts need, derived from the same rows the table shows so
 * the two can never tell different stories.
 */
function summarise(rows, from, to) {
  const byCategory = {};
  Object.keys(CATEGORY).forEach(k => {
    byCategory[k] = { category: k, label: CATEGORY_LABEL[k], count: 0, quantity: 0, value: 0 };
  });

  const byDayMap = new Map();
  const byItemMap = new Map();
  let totalIn = 0, totalOut = 0, totalValue = 0;

  for (const r of rows) {
    const c = byCategory[r.category];
    c.count += 1;
    c.quantity = round(c.quantity + r.quantity);
    c.value = round(c.value + r.value);

    if (r.direction > 0) totalIn = round(totalIn + r.quantity);
    else totalOut = round(totalOut + r.quantity);
    totalValue = round(totalValue + r.value);

    if (!byDayMap.has(r.day)) {
      byDayMap.set(r.day, { day: r.day, CREDIT: 0, DEBIT: 0, RETURN: 0, PURCHASE: 0, count: 0 });
    }
    const d = byDayMap.get(r.day);
    d[r.category] = round(d[r.category] + r.quantity);
    d.count += 1;

    const key = r.itemId;
    if (!byItemMap.has(key)) {
      byItemMap.set(key, {
        itemId: key, itemName: r.itemName, sku: r.sku, unit: r.unit,
        in: 0, out: 0, count: 0,
      });
    }
    const it = byItemMap.get(key);
    if (r.direction > 0) it.in = round(it.in + r.quantity);
    else it.out = round(it.out + r.quantity);
    it.count += 1;
  }

  // Every day in the range, including quiet ones — gaps in a time axis read as
  // missing data rather than as "nothing moved".
  const byDay = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  // A very long range would make a per-day axis unreadable; cap the filled
  // series and let the table carry the detail.
  let guard = 0;
  while (cursor <= end && guard < 400) {
    const k = dayKey(cursor);
    byDay.push(byDayMap.get(k) || { day: k, CREDIT: 0, DEBIT: 0, RETURN: 0, PURCHASE: 0, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  const topItems = [...byItemMap.values()]
    .map(i => ({ ...i, total: round(i.in + i.out) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return {
    totals: {
      movements: rows.length,
      totalIn, totalOut,
      net: round(totalIn - totalOut),
      totalValue,
      itemsTouched: byItemMap.size,
    },
    byCategory: Object.values(byCategory),
    byDay,
    topItems,
  };
}

module.exports = {
  listMovements, summarise, classify, direction,
  CATEGORY, CATEGORY_LABEL, IN_TYPES, OUT_TYPES,
};
