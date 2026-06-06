// routes/Accountant_Routes/Acc_search.js
//
// GET /api/accountant/search?q=...&companyId=...
//
// Omnisearch across Acc_Ledger and Acc_Voucher.
// Navigation items are matched entirely on the frontend.
//
// Ledger fields searched:  name, gstin, panNumber, aliases,
//                          contactDetails.address / phone / email
// Voucher fields searched: voucherNumber, partyLedgerName, narration,
//                          referenceNumber, partyGstin
//
// Returns:
//   { ledgers: [...], vouchers: [...] }

"use strict";

const express = require("express");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const router = express.Router();
const auth = accountantAuth;

router.get("/", auth, async (req, res) => {
  try {
    const { q, companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const raw = (q || "").trim();
    if (raw.length < 2) return res.json({ ledgers: [], vouchers: [] });

    // Escape regex special chars then build case-insensitive pattern
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");

    const [ledgers, vouchers] = await Promise.all([
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

      // ── Vouchers ─────────────────────────────────────────────────────────
      Acc_Voucher.find({
        companyId,
        $or: [
          { voucherNumber: rx },
          { partyLedgerName: rx },
          { narration: rx },
          { referenceNumber: rx },
          { partyGstin: rx },
        ],
      })
        .select(
          "_id voucherNumber voucherType voucherDate partyLedgerName " +
            "grandTotal narration status referenceNumber",
        )
        .sort({ voucherDate: -1 })
        .limit(10)
        .lean(),
    ]);

    res.json({ ledgers, vouchers });
  } catch (e) {
    console.error("[search]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
