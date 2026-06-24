// routes/Accountant_Routes/Acc_search.js
//
// GET /api/accountant/search?q=...&companyId=...&scope=all|invoice
//
// Omnisearch across Acc_Ledger, Acc_Voucher, and Acc_StockItem.
// Navigation items are matched entirely on the frontend.
//
// scope:
//   "all"     (default) — ledgers + vouchers (incl. matched by their inventory
//                         item name) + stock items
//   "invoice"           — ONLY vouchers, matched EXACTLY on voucher number, so
//                         typing "1" returns the voucher numbered exactly "1",
//                         not every voucher that merely contains a 1.
//
// Ledger fields searched:  name, gstin, panNumber, aliases,
//                          contactDetails.address / phone / email / city
// Voucher fields searched: voucherNumber, partyLedgerName, narration,
//                          referenceNumber, partyGstin,
//                          inventoryEntries.stockItemName
// Stock  fields searched:  name, aliases, hsnCode, stockGroupName
//
// Returns:
//   { ledgers: [...], vouchers: [...], stockItems: [...] }

"use strict";

const express = require("express");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_StockItem,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const router = express.Router();
const auth = accountantAuth;

// Project the matched inventory item name too, so the UI can show
// "contains <item>" on vouchers found via a product search.
const VOUCHER_FIELDS =
  "_id voucherNumber voucherType voucherDate partyLedgerName " +
  "grandTotal narration status referenceNumber inventoryEntries.stockItemName";

router.get("/", auth, async (req, res) => {
  try {
    const { q, companyId, scope } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const raw = (q || "").trim();
    const empty = { ledgers: [], vouchers: [], stockItems: [] };

    // Escape regex special chars then build case-insensitive pattern
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // ── Invoice-number EXACT scope ───────────────────────────────────────────
    // Match ONLY the voucher number, anchored. "1" → voucher numbered exactly
    // "1". A single character is enough here (numbers are short).
    if (scope === "invoice") {
      if (raw.length < 1) return res.json(empty);
      const exact = new RegExp("^" + escaped + "$", "i");
      const vouchers = await Acc_Voucher.find({
        companyId,
        voucherNumber: exact,
      })
        .select(VOUCHER_FIELDS)
        .sort({ voucherDate: -1 })
        .limit(20)
        .lean();
      return res.json({ ledgers: [], vouchers, stockItems: [] });
    }

    // ── Default scope ────────────────────────────────────────────────────────
    if (raw.length < 2) return res.json(empty);
    const rx = new RegExp(escaped, "i");

    const [ledgers, vouchers, stockItems] = await Promise.all([
      // ── Ledgers ──────────────────────────────────────────────────────────
      Acc_Ledger.find({
        companyId,
        isActive: { $ne: false },
        $or: [
          { name: rx },
          { gstin: rx },
          { panNumber: rx },
          { aliases: rx },
          { "contactDetails.address": rx },
          { "contactDetails.phone": rx },
          { "contactDetails.email": rx },
          { "contactDetails.city": rx },
        ],
      })
        .select(
          "_id name groupName nature gstin panNumber currentBalance balanceType " +
            "contactDetails.address contactDetails.city contactDetails.state",
        )
        .limit(8)
        .lean(),

      // ── Vouchers (now also matched by their inventory item name) ──────────
      Acc_Voucher.find({
        companyId,
        $or: [
          { voucherNumber: rx },
          { partyLedgerName: rx },
          { narration: rx },
          { referenceNumber: rx },
          { partyGstin: rx },
          { "inventoryEntries.stockItemName": rx },
        ],
      })
        .select(VOUCHER_FIELDS)
        .sort({ voucherDate: -1 })
        .limit(12)
        .lean(),

      // ── Stock items ───────────────────────────────────────────────────────
      Acc_StockItem.find({
        companyId,
        isActive: { $ne: false },
        $or: [
          { name: rx },
          { aliases: rx },
          { hsnCode: rx },
          { stockGroupName: rx },
        ],
      })
        .select(
          "_id name baseUnit hsnCode closingQuantity closingValue " +
            "stockGroupName taxRate",
        )
        .limit(8)
        .lean(),
    ]);

    res.json({ ledgers, vouchers, stockItems });
  } catch (e) {
    console.error("[search]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
