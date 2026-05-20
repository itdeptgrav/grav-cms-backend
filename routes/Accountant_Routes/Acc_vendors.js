// routes/Accountant_Routes/Acc_vendors.js - UPDATED WITH CORRECT MIDDLEWARE

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTED PARTY BRIDGE — Sundry Creditors from a Tally import shown here
// alongside CMS vendors, with spend/paid/outstanding from posted vouchers.
// A creditor's natural balance is a CREDIT (we owe them):
//   totalPayables ≈ total Credit posted (bills raised against us)
//   totalPaid     ≈ total Debit posted (payments we made)
//   outstanding   = abs(signed closing) (net still owed)
// ─────────────────────────────────────────────────────────────────────────────
async function importedVendorRows(companyId) {
  const Acc_Company =
    require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;
  let cId = null;
  if (companyId) {
    try {
      cId = new mongoose.Types.ObjectId(companyId);
    } catch {
      cId = null;
    }
  }
  if (!cId) {
    let comp = await Acc_Company.findOne({ isPrimary: true })
      .select("_id")
      .lean();
    if (!comp) {
      const all = await Acc_Company.find({}).select("_id").limit(2).lean();
      if (all.length === 1) comp = all[0];
    }
    if (comp) cId = comp._id;
  }
  if (!cId) return [];
  const groups = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName")
    .lean();
  if (!groups.length) return [];
  const rx = /sundry creditor/i;
  const ids = new Set(
    groups.filter((g) => rx.test(g.name || "")).map((g) => String(g._id)),
  );
  let added = true;
  let guard = 0;
  while (added && guard < 20) {
    added = false;
    guard++;
    for (const g of groups) {
      if (ids.has(String(g._id))) continue;
      const pName = g.parentName;
      const pId = g.parent && String(g.parent);
      if (
        (pId && ids.has(pId)) ||
        (pName &&
          groups.some((x) => x.name === pName && ids.has(String(x._id))))
      ) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  if (!ids.size) return [];
  const gIds = [...ids].map((s) => new mongoose.Types.ObjectId(s));
  const ledgers = await Acc_Ledger.find({
    companyId: cId,
    groupId: { $in: gIds },
    isActive: { $ne: false },
    // Skip ledgers already linked to a CMS Vendor — they're not
    // separate imported vendors, they're the vendor's accounting ledger.
    // Without this, a merged/relinked ghost keeps re-appearing as a
    // ghost in an infinite detection loop.
    linkedVendorId: { $in: [null, undefined] },
  })
    .select(
      "name gstin aliases groupName openingBalance openingBalanceType email phone isActive linkedVendorId",
    )
    .lean();
  // Also filter out any that slipped through (schema default might not set the field)
  const filteredLedgers = ledgers.filter((l) => !l.linkedVendorId);
  if (!filteredLedgers.length) return [];
  const ledgerIds = filteredLedgers.map((l) => l._id);
  const agg = await Acc_Voucher.aggregate([
    { $match: { companyId: cId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        dr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Dr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        cr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Cr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        totalPOs: { $sum: 1 },
      },
    },
  ]);
  const m = new Map(agg.map((a) => [String(a._id), a]));
  return filteredLedgers.map((l) => {
    const a = m.get(String(l._id)) || {};
    const dr = a.dr || 0;
    const cr = a.cr || 0;
    const openSigned =
      (l.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(l.openingBalance || 0);
    // closingSigned: Tally-signed net (Dr +, Cr −). This is the SAME basis
    // the Balance Sheet uses, so the figures reconcile exactly.
    const closingSigned = openSigned + dr - cr;
    // For a creditor:
    //   net CREDIT (closingSigned < 0) → we still owe them  → outstanding
    //   net DEBIT  (closingSigned > 0) → advance/overpaid    → no payable
    // We surface the NET only (not misleading gross spend/paid splits,
    // which were wrong and didn't tie to Tally).
    const owed = closingSigned < 0 ? Math.abs(closingSigned) : 0;
    const advance = closingSigned > 0 ? closingSigned : 0;
    return {
      id: l._id,
      ledgerId: l._id, // Acc_Ledger _id — used for View → Ledger link
      isImported: true,
      source: "tally_ledger",
      vendorId: `VEN-${l._id.toString().substring(18, 24).toUpperCase()}`,
      name: l.name,
      contactPerson: "",
      email: l.email || "",
      phone: l.phone || "",
      company: l.name,
      type: "Imported (Tally)",
      currency: "INR",
      // "Total Spend" = net business with this party = closing magnitude.
      totalPayables: parseFloat(Math.abs(closingSigned).toFixed(2)),
      outstandingPayables: parseFloat(owed.toFixed(2)),
      advanceToVendor: parseFloat(advance.toFixed(2)),
      balance: parseFloat(Math.abs(closingSigned).toFixed(2)),
      balanceType: closingSigned < 0 ? "Cr" : "Dr",
      unusedCredits: 0,
      paymentTerms: "—",
      gstin: l.gstin || "",
      pan: "",
      status: "Active",
      portalStatus: "Disabled",
      createdDate: "",
      createdBy: "Tally Import",
      totalExpenses6Months: 0,
      billingAddress: {
        street: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      totalPOs: a.totalPOs || 0,
      // "Paid" column: we don't fabricate a gross paid for imported
      // ledgers (it was wrong). Show the advance if any, else 0.
      totalPaid: parseFloat(advance.toFixed(2)),
      aliases: l.aliases || [],
      groupName: l.groupName || null,
      _normName: normalizePartyName(l.name),
      _gstinKey: (l.gstin || "").toUpperCase().replace(/\s+/g, ""),
    };
  });
}

// Normalised name for ghost-duplicate detection against CMS vendors.
function normalizePartyName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(
      /\b(pvt|private|ltd|limited|llp|opc|inc|co|company|enterprises?|traders?|and|&)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Apply accountant auth middleware to all routes
router.use(AccountantAuthMiddleware.accountantAuth);

// ✅ GET all vendors with financial stats
router.get("/", async (req, res) => {
  try {
    const { search = "", status } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { gstNumber: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    const vendors = await Vendor.find(filter)
      .select(
        "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms createdBy updatedBy createdAt",
      )
      .sort({ companyName: 1 });

    // Get financial statistics for each vendor — from BOTH PurchaseOrders
    // AND Acc_Voucher (accounting data from Tally imports / merged ghosts).
    const vendorsWithStats = await Promise.all(
      vendors.map(async (vendor) => {
        const purchaseOrders = await PurchaseOrder.find({
          vendor: vendor._id,
          status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
        });

        // PO-based stats
        let totalPayables = 0;
        let outstandingPayables = 0;
        let totalPaid = 0;
        let totalPOs = purchaseOrders.length;

        purchaseOrders.forEach((po) => {
          totalPayables += po.totalAmount || 0;
          const poPaid =
            po.payments?.reduce(
              (sum, payment) => sum + (payment.amount || 0),
              0,
            ) || 0;
          totalPaid += poPaid;
          outstandingPayables += (po.totalAmount || 0) - poPaid;
        });

        // Acc_Voucher-based stats (from Tally imports / merged data).
        // Find the vendor's linked Acc_Ledger and pull voucher totals.
        let vendorLedger = null;
        try {
          vendorLedger = await Acc_Ledger.findOne({
            linkedVendorId: vendor._id,
            isActive: { $ne: false },
          }).lean();
          if (!vendorLedger) {
            vendorLedger = await Acc_Ledger.findOne({
              name: new RegExp(
                "^" +
                  vendor.companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                  "$",
                "i",
              ),
              isActive: { $ne: false },
            }).lean();
          }
          if (vendorLedger) {
            const voucherAgg = await Acc_Voucher.aggregate([
              { $match: { partyLedgerId: vendorLedger._id, status: "posted" } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  totalDebit: { $sum: "$totalDebit" },
                  totalCredit: { $sum: "$totalCredit" },
                },
              },
            ]);
            if (voucherAgg.length > 0) {
              const agg = voucherAgg[0];
              // Add voucher count to POs (for display)
              totalPOs += agg.count || 0;
              // Compute net from ledger balance (more accurate)
              const openSigned =
                (vendorLedger.openingBalanceType === "Cr" ? -1 : 1) *
                Math.abs(vendorLedger.openingBalance || 0);
              // For creditors: negative closing = we owe them
              const closingSigned = vendorLedger.currentBalance || openSigned;
              const owed = closingSigned < 0 ? Math.abs(closingSigned) : 0;
              // Use the larger of PO-based or ledger-based outstanding
              if (owed > outstandingPayables) outstandingPayables = owed;
              // Use ledger's absolute balance as total spend if PO-based is zero
              if (totalPayables === 0 && Math.abs(closingSigned) > 0) {
                totalPayables = Math.abs(closingSigned);
              }
            }
          }
        } catch (_) {
          /* Acc_Ledger/Voucher not available — PO stats only */
        }

        // 6-month expenses
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const recentPOs = await PurchaseOrder.find({
          vendor: vendor._id,
          orderDate: { $gte: sixMonthsAgo },
          status: { $in: ["PARTIALLY_RECEIVED", "COMPLETED"] },
        });
        const totalExpenses6Months = recentPOs.reduce((sum, po) => {
          const poPaid =
            po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
          return sum + poPaid;
        }, 0);

        return {
          id: vendor._id,
          ledgerId: vendorLedger?._id || null, // Acc_Ledger _id for View → Ledger link
          vendorId: `VEN-${vendor._id.toString().substring(18, 24).toUpperCase()}`,
          name: vendor.companyName,
          contactPerson: vendor.contactPerson,
          email: vendor.email,
          phone: vendor.phone,
          company: vendor.companyName,
          type: vendor.vendorType || "Business",
          currency: "INR",
          totalPayables: parseFloat(totalPayables.toFixed(2)),
          outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
          unusedCredits: 0,
          paymentTerms: vendor.paymentTerms || "Net 30",
          gstin: vendor.gstNumber || "",
          pan: vendor.panNumber || "",
          status: vendor.status || "Active",
          portalStatus: "Disabled",
          createdDate: vendor.createdAt.toLocaleDateString("en-GB"),
          createdBy: "System",
          totalExpenses6Months: parseFloat(totalExpenses6Months.toFixed(2)),
          billingAddress: vendor.address || {
            street: "",
            city: "",
            state: "",
            pincode: "",
            country: "India",
          },
          totalPOs: totalPOs,
          totalPaid: parseFloat(totalPaid.toFixed(2)),
        };
      }),
    );

    // ── Merge in imported Tally parties (Sundry Creditors) ───────────
    let allVendors = vendorsWithStats;
    try {
      let imported = await importedVendorRows(req.query.companyId);

      // GHOST DETECTION: if an imported party's GSTIN or normalised name
      // matches an existing CMS vendor, mark it a "ghost" — same real
      // party, two records. The accountant resolves these on the Data
      // Cleanup page (merge keeps one, drops the other). Until merged we
      // still SHOW both, but the ghost is flagged so it's obvious.
      const cmsByGstin = new Map();
      const cmsByName = new Map();
      for (const v of vendorsWithStats) {
        const g = (v.gstin || "").toUpperCase().replace(/\s+/g, "");
        if (g) cmsByGstin.set(g, v);
        const n = normalizePartyName(v.name);
        if (n) cmsByName.set(n, v);
      }
      imported = imported.map((v) => {
        let match = null;
        if (v._gstinKey && cmsByGstin.has(v._gstinKey))
          match = cmsByGstin.get(v._gstinKey);
        else if (v._normName && cmsByName.has(v._normName))
          match = cmsByName.get(v._normName);
        if (match) {
          return {
            ...v,
            isGhost: true,
            ghostOf: { id: match.id, name: match.name },
            type: "Ghost (duplicate of registered)",
          };
        }
        return v;
      });

      const q = String(req.query.search || "")
        .trim()
        .toLowerCase();
      if (q) {
        imported = imported.filter(
          (v) =>
            (v.name || "").toLowerCase().includes(q) ||
            (v.gstin || "").toLowerCase().includes(q) ||
            (v.aliases || []).some((al) => al.toLowerCase().includes(q)),
        );
      }
      // Drop internal helper keys before sending.
      imported = imported.map(({ _normName, _gstinKey, ...rest }) => rest);
      if (imported.length) allVendors = [...vendorsWithStats, ...imported];
    } catch (impErr) {
      console.error("[vendors] imported-party merge skipped:", impErr.message);
    }

    // Calculate summary stats
    const totalVendors = allVendors.length;
    const totalPayables = allVendors.reduce(
      (sum, v) => sum + v.totalPayables,
      0,
    );
    const totalOutstanding = allVendors.reduce(
      (sum, v) => sum + v.outstandingPayables,
      0,
    );

    res.json({
      success: true,
      vendors: allVendors,
      stats: {
        total: totalVendors,
        totalPayables: parseFloat(totalPayables.toFixed(2)),
        totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
      },
    });
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors",
    });
  }
});

// ✅ GET vendor by ID with detailed information
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select(
      "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms bankDetails primaryProducts createdBy updatedBy createdAt",
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Get purchase orders for this vendor
    const purchaseOrders = await PurchaseOrder.find({
      vendor: vendor._id,
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
    })
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending paymentStatus payments",
      )
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    // Calculate financial stats
    let totalPayables = 0;
    let outstandingPayables = 0;
    let totalPaid = 0;
    let recentTransactions = [];

    purchaseOrders.forEach((po) => {
      totalPayables += po.totalAmount || 0;

      const poPaid =
        po.payments?.reduce((sum, payment) => sum + (payment.amount || 0), 0) ||
        0;
      totalPaid += poPaid;
      outstandingPayables += (po.totalAmount || 0) - poPaid;

      // Add payment transactions
      if (po.payments && po.payments.length > 0) {
        po.payments.forEach((payment) => {
          recentTransactions.push({
            id: payment._id,
            type: "PAYMENT",
            date: payment.paymentDate || payment.createdAt,
            poNumber: po.poNumber,
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            referenceNumber: payment.referenceNumber,
            notes: payment.notes,
            recordedBy: payment.recordedBy?.name || "System",
            status: "COMPLETED",
          });
        });
      }

      // Add purchase order transactions
      recentTransactions.push({
        id: po._id,
        type: "PURCHASE_ORDER",
        date: po.orderDate,
        poNumber: po.poNumber,
        amount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
      });
    });

    // Sort transactions by date (newest first)
    recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate 6-month expenses
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentPOs = await PurchaseOrder.find({
      vendor: vendor._id,
      orderDate: { $gte: sixMonthsAgo },
      status: { $in: ["PARTIALLY_RECEIVED", "COMPLETED"] },
    });

    const totalExpenses6Months = recentPOs.reduce((sum, po) => {
      const poPaid = po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
      return sum + poPaid;
    }, 0);

    const vendorData = {
      id: vendor._id,
      vendorId: `VEN-${vendor._id.toString().substring(18, 24).toUpperCase()}`,
      name: vendor.companyName,
      contactPerson: vendor.contactPerson,
      email: vendor.email,
      phone: vendor.phone,
      company: vendor.companyName,
      type: vendor.vendorType || "Business",
      currency: "INR",
      totalPayables: parseFloat(totalPayables.toFixed(2)),
      outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
      unusedCredits: 0,
      paymentTerms: vendor.paymentTerms || "Net 30",
      gstin: vendor.gstNumber || "",
      pan: vendor.panNumber || "",
      status: vendor.status || "Active",
      portalStatus: "Disabled",
      createdDate: vendor.createdAt.toLocaleDateString("en-GB"),
      createdBy: vendor.createdBy ? "User" : "System",
      totalExpenses6Months: parseFloat(totalExpenses6Months.toFixed(2)),
      billingAddress: vendor.address || {
        street: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      bankDetails: vendor.bankDetails || {},
      primaryProducts: vendor.primaryProducts || [],
      rating: vendor.rating || 3,
      notes: vendor.notes || "",
      purchaseOrders: purchaseOrders.map((po) => ({
        id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        totalAmount: po.totalAmount,
        status: po.status,
        totalReceived: po.totalReceived,
        totalPending: po.totalPending,
        paymentStatus: po.paymentStatus,
        totalPaid:
          po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0,
        remainingAmount:
          po.totalAmount -
          (po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0),
      })),
      recentTransactions: recentTransactions.slice(0, 50),
      stats: {
        totalOrders: purchaseOrders.length,
        completedOrders: purchaseOrders.filter(
          (po) => po.status === "COMPLETED",
        ).length,
        pendingOrders: purchaseOrders.filter(
          (po) => po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED",
        ).length,
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        avgPaymentDays: 30,
      },
    };

    res.json({
      success: true,
      vendor: vendorData,
    });
  } catch (error) {
    console.error("Error fetching vendor details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor details",
    });
  }
});

// ✅ GET vendor purchase orders
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;

    let filter = { vendor: req.params.id };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status paymentStatus totalReceived totalPending items payments",
      )
      .populate("items.rawItem", "name sku unit")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    res.json({
      success: true,
      purchaseOrders: purchaseOrders.map((po) => ({
        id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        totalAmount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
        totalReceived: po.totalReceived,
        totalPending: po.totalPending,
        items: po.items.map((item) => ({
          id: item._id,
          itemName: item.itemName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
        })),
        payments: po.payments || [],
        totalPaid:
          po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0,
        remainingAmount:
          po.totalAmount -
          (po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0),
      })),
    });
  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase orders",
    });
  }
});

// ✅ GET vendor transactions (payments + purchase orders)
router.get("/:id/transactions", async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;

    // Get all purchase orders for vendor
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("poNumber orderDate totalAmount status paymentStatus payments")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    let transactions = [];

    purchaseOrders.forEach((po) => {
      // Add purchase order transaction
      transactions.push({
        id: po._id,
        type: "PURCHASE_ORDER",
        date: po.orderDate,
        poNumber: po.poNumber,
        description: `Purchase Order ${po.poNumber}`,
        amount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
        category: "PURCHASE",
        reference: po.poNumber,
      });

      // Add payment transactions
      if (po.payments && po.payments.length > 0) {
        po.payments.forEach((payment) => {
          transactions.push({
            id: payment._id,
            type: "PAYMENT",
            date: payment.paymentDate || payment.createdAt,
            poNumber: po.poNumber,
            description: `Payment for PO ${po.poNumber}`,
            amount: -payment.amount,
            paymentMethod: payment.paymentMethod,
            referenceNumber: payment.referenceNumber,
            notes: payment.notes,
            recordedBy: payment.recordedBy?.name || "System",
            status: "COMPLETED",
            category: "PAYMENT",
            reference:
              payment.referenceNumber ||
              `PAY-${payment._id.toString().substring(18, 24).toUpperCase()}`,
          });
        });
      }
    });

    // Apply filters
    if (type && type !== "all") {
      transactions = transactions.filter((t) => t.type === type);
    }

    if (startDate) {
      const start = new Date(startDate);
      transactions = transactions.filter((t) => new Date(t.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      transactions = transactions.filter((t) => new Date(t.date) <= end);
    }

    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate summary
    const totalPurchases = transactions
      .filter((t) => t.type === "PURCHASE_ORDER")
      .reduce((sum, t) => sum + t.amount, 0);

    const totalPayments = transactions
      .filter((t) => t.type === "PAYMENT")
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const balance = totalPurchases - totalPayments;

    res.json({
      success: true,
      transactions,
      summary: {
        totalPurchases: parseFloat(totalPurchases.toFixed(2)),
        totalPayments: parseFloat(totalPayments.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor transactions:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching transactions",
    });
  }
});

// ✅ RECORD PAYMENT for vendor purchase order
router.post("/:id/payment", async (req, res) => {
  try {
    const {
      purchaseOrderId,
      amount,
      paymentMethod,
      referenceNumber,
      paymentDate,
      notes,
    } = req.body;

    // Validation
    if (!purchaseOrderId) {
      return res.status(400).json({
        success: false,
        message: "Purchase Order ID is required",
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid payment amount is required",
      });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Payment method is required",
      });
    }

    // Verify purchase order belongs to vendor
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: purchaseOrderId,
      vendor: req.params.id,
    });

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found for this vendor",
      });
    }

    // Calculate current payment totals
    const totalPaid =
      purchaseOrder.payments?.reduce(
        (sum, payment) => sum + (payment.amount || 0),
        0,
      ) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    // Validate payment amount doesn't exceed remaining amount
    if (amount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (₹${amount}) exceeds remaining amount (₹${remainingAmount})`,
      });
    }

    // Create payment record
    const paymentRecord = {
      amount: parseFloat(amount),
      paymentMethod: paymentMethod,
      referenceNumber: referenceNumber || "",
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      notes: notes || "",
      recordedBy: req.user.id,
    };

    // Initialize payments array if it doesn't exist
    if (!purchaseOrder.payments) {
      purchaseOrder.payments = [];
    }

    // Add payment record
    purchaseOrder.payments.unshift(paymentRecord);

    // Calculate new total paid
    const newTotalPaid = totalPaid + amount;

    // Update payment status
    if (newTotalPaid >= purchaseOrder.totalAmount) {
      purchaseOrder.paymentStatus = "COMPLETED";
    } else if (newTotalPaid > 0) {
      purchaseOrder.paymentStatus = "PARTIAL";
    } else {
      purchaseOrder.paymentStatus = "PENDING";
    }

    await purchaseOrder.save();

    // Get updated purchase order with populated data
    const updatedPO = await PurchaseOrder.findById(purchaseOrderId).populate(
      "payments.recordedBy",
      "name email",
    );

    const latestPayment = updatedPO.payments[0];

    res.json({
      success: true,
      message: `Payment of ₹${amount} recorded successfully`,
      payment: latestPayment,
      purchaseOrder: {
        id: updatedPO._id,
        poNumber: updatedPO.poNumber,
        totalAmount: updatedPO.totalAmount,
        paymentStatus: updatedPO.paymentStatus,
        totalPaid: newTotalPaid,
        remainingAmount: updatedPO.totalAmount - newTotalPaid,
      },
    });
  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording payment",
    });
  }
});

// ✅ UPDATE vendor payment status
router.patch("/:id/purchase-orders/:poId/payment-status", async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Payment status is required",
      });
    }

    const validStatuses = ["PENDING", "PARTIAL", "COMPLETED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status",
      });
    }

    // Verify purchase order belongs to vendor
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.poId,
      vendor: req.params.id,
    });

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    purchaseOrder.paymentStatus = status;
    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Payment status updated to ${status}`,
      purchaseOrder: {
        id: purchaseOrder._id,
        poNumber: purchaseOrder.poNumber,
        paymentStatus: purchaseOrder.paymentStatus,
      },
    });
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment status",
    });
  }
});

// ✅ GET vendor payment history
router.get("/:id/payments", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const purchaseOrders = await PurchaseOrder.find({
      vendor: req.params.id,
      "payments.0": { $exists: true },
    })
      .select("poNumber totalAmount payments")
      .populate("payments.recordedBy", "name email");

    let allPayments = [];

    purchaseOrders.forEach((po) => {
      po.payments.forEach((payment) => {
        allPayments.push({
          id: payment._id,
          poNumber: po.poNumber,
          date: payment.paymentDate || payment.createdAt,
          amount: payment.amount,
          paymentMethod: payment.paymentMethod,
          referenceNumber: payment.referenceNumber,
          notes: payment.notes,
          recordedBy: payment.recordedBy?.name || "System",
          status: "COMPLETED",
          poTotalAmount: po.totalAmount,
        });
      });
    });

    // Apply date filters
    if (startDate) {
      const start = new Date(startDate);
      allPayments = allPayments.filter((p) => new Date(p.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      allPayments = allPayments.filter((p) => new Date(p.date) <= end);
    }

    // Sort by date (newest first)
    allPayments.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    const totalPayments = allPayments.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      success: true,
      payments: allPayments,
      summary: {
        totalPayments: parseFloat(totalPayments.toFixed(2)),
        paymentCount: allPayments.length,
        avgPayment:
          allPayments.length > 0
            ? parseFloat((totalPayments / allPayments.length).toFixed(2))
            : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor payments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payments",
    });
  }
});

// ✅ CREATE new vendor
router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      address,
      gstNumber,
      panNumber,
      paymentTerms,
      bankDetails,
      primaryProducts,
      notes,
    } = req.body;

    // Basic validation
    if (!companyName) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Check if vendor already exists
    const existingVendor = await Vendor.findOne({
      $or: [
        { companyName: { $regex: new RegExp(`^${companyName}$`, "i") } },
        { email: { $regex: new RegExp(`^${email}$`, "i") } },
      ],
    });

    if (existingVendor) {
      return res.status(400).json({
        success: false,
        message: "Vendor with this name or email already exists",
      });
    }

    // Create vendor
    const vendor = new Vendor({
      companyName,
      vendorType: vendorType || "Raw Material Supplier",
      contactPerson,
      email,
      phone,
      address: address || {
        street: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      gstNumber,
      panNumber,
      paymentTerms: paymentTerms || "Net 30",
      bankDetails: bankDetails || {},
      primaryProducts: primaryProducts || [],
      notes,
      status: "Active",
      rating: 3,
      createdBy: req.user.id,
    });

    await vendor.save();

    res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      vendor: {
        id: vendor._id,
        companyName: vendor.companyName,
        email: vendor.email,
        phone: vendor.phone,
        gstNumber: vendor.gstNumber,
        status: vendor.status,
      },
    });
  } catch (error) {
    console.error("Error creating vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating vendor",
    });
  }
});

// ✅ UPDATE vendor
router.put("/:id", async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      address,
      gstNumber,
      panNumber,
      paymentTerms,
      bankDetails,
      primaryProducts,
      status,
      notes,
    } = req.body;

    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Update fields
    if (companyName) vendor.companyName = companyName;
    if (vendorType) vendor.vendorType = vendorType;
    if (contactPerson !== undefined) vendor.contactPerson = contactPerson;
    if (email) vendor.email = email;
    if (phone !== undefined) vendor.phone = phone;
    if (address) vendor.address = address;
    if (gstNumber !== undefined) vendor.gstNumber = gstNumber;
    if (panNumber !== undefined) vendor.panNumber = panNumber;
    if (paymentTerms !== undefined) vendor.paymentTerms = paymentTerms;
    if (bankDetails !== undefined) vendor.bankDetails = bankDetails;
    if (primaryProducts !== undefined) vendor.primaryProducts = primaryProducts;
    if (status) vendor.status = status;
    if (notes !== undefined) vendor.notes = notes;

    vendor.updatedBy = req.user.id;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: {
        id: vendor._id,
        companyName: vendor.companyName,
        email: vendor.email,
        phone: vendor.phone,
        status: vendor.status,
      },
    });
  } catch (error) {
    console.error("Error updating vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating vendor",
    });
  }
});

// ✅ DELETE vendor
/* ------------------------------------------------------------------ */
/* POST /:id/merge — Merge a ghost vendor's transactions into keeper   */
/* ------------------------------------------------------------------ */
/* Ghost vendors from Tally import are Acc_Ledger records, NOT CMS
 * Vendor documents. The merge handles both cases:
 *   • Ghost is a CMS Vendor → find in Vendor collection
 *   • Ghost is an Acc_Ledger → find in Acc_Ledger collection
 * Moves transactions, deactivates ghost. Does NOT touch keeper details.
 */
router.post("/:id/merge", async (req, res) => {
  try {
    const keeperId = req.params.id;
    const { mergeFromId } = req.body || {};
    if (!mergeFromId)
      return res
        .status(400)
        .json({ success: false, message: "mergeFromId required" });
    if (keeperId === mergeFromId)
      return res
        .status(400)
        .json({ success: false, message: "Cannot merge into itself" });

    // Find the KEEPER — always a CMS Vendor
    const keeper = await Vendor.findById(keeperId);
    if (!keeper)
      return res
        .status(404)
        .json({ success: false, message: "Keeper vendor not found" });

    const counts = {
      purchaseOrders: 0,
      vouchers: 0,
      ledgerEntries: 0,
      payments: 0,
    };

    // Try finding ghost as CMS Vendor first, then as Acc_Ledger
    let ghost = await Vendor.findById(mergeFromId).catch(() => null);
    let ghostLedger = null;

    if (ghost) {
      // Ghost is a CMS Vendor — move POs and payments
      const poResult = await PurchaseOrder.updateMany(
        { vendor: ghost._id },
        { $set: { vendor: keeper._id } },
      );
      counts.purchaseOrders = poResult.modifiedCount || 0;

      try {
        const Payment = require("mongoose").model("Payment");
        const payResult = await Payment.updateMany(
          { vendor: ghost._id },
          { $set: { vendor: keeper._id } },
        );
        counts.payments = payResult.modifiedCount || 0;
      } catch (_) {}

      // Find the ghost's linked Acc_Ledger
      ghostLedger = await Acc_Ledger.findOne({ linkedVendorId: ghost._id });
      if (!ghostLedger) {
        // Try by name match
        ghostLedger = await Acc_Ledger.findOne({
          name: new RegExp(
            "^" +
              ghost.companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "$",
            "i",
          ),
          isActive: true,
        });
      }

      // Deactivate the CMS ghost vendor
      ghost.status = "Inactive";
      ghost.notes = `[MERGED] Transactions moved to ${keeper.companyName} on ${new Date().toISOString()}`;
      await ghost.save();
    } else {
      // Ghost is an Acc_Ledger (Tally import) — not a CMS Vendor directly.
      // But there may ALSO be a CMS Vendor for the same entity (matched by
      // GSTIN/name in the ghost detection). Find and transfer its POs too.
      ghostLedger = await Acc_Ledger.findById(mergeFromId);
      if (!ghostLedger)
        return res
          .status(404)
          .json({ success: false, message: "Ghost vendor/ledger not found" });

      // Search for a CMS Vendor that matches the ghost ledger by GSTIN or name
      let ghostCmsVendor = null;
      if (ghostLedger.gstin) {
        ghostCmsVendor = await Vendor.findOne({
          _id: { $ne: keeper._id },
          gstNumber: new RegExp(
            "^" +
              ghostLedger.gstin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "$",
            "i",
          ),
        });
      }
      if (!ghostCmsVendor) {
        ghostCmsVendor = await Vendor.findOne({
          _id: { $ne: keeper._id },
          companyName: new RegExp(
            "^" + ghostLedger.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
            "i",
          ),
        });
      }
      if (ghostCmsVendor) {
        // Transfer POs from ghost CMS Vendor → keeper
        const poResult = await PurchaseOrder.updateMany(
          { vendor: ghostCmsVendor._id },
          { $set: { vendor: keeper._id } },
        );
        counts.purchaseOrders = poResult.modifiedCount || 0;
        try {
          const Payment = require("mongoose").model("Payment");
          const payResult = await Payment.updateMany(
            { vendor: ghostCmsVendor._id },
            { $set: { vendor: keeper._id } },
          );
          counts.payments = payResult.modifiedCount || 0;
        } catch (_) {}
        // Deactivate ghost CMS Vendor
        ghostCmsVendor.status = "Inactive";
        ghostCmsVendor.notes = `[MERGED] into ${keeper.companyName} on ${new Date().toISOString()}`;
        await ghostCmsVendor.save();
      }
    }

    // Find the keeper's Acc_Ledger
    let keeperLedger = await Acc_Ledger.findOne({
      linkedVendorId: keeper._id,
      isActive: { $ne: false },
    });
    if (!keeperLedger) {
      keeperLedger = await Acc_Ledger.findOne({
        name: new RegExp(
          "^" + keeper.companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
          "i",
        ),
        isActive: { $ne: false },
      });
    }

    // Move accounting data from ghost ledger → keeper ledger
    if (
      ghostLedger &&
      keeperLedger &&
      String(ghostLedger._id) !== String(keeperLedger._id)
    ) {
      try {
        // Move party-level voucher references
        const vResult = await Acc_Voucher.updateMany(
          { partyLedgerId: ghostLedger._id },
          {
            $set: {
              partyLedgerId: keeperLedger._id,
              partyLedgerName: keeperLedger.name,
            },
          },
        );
        counts.vouchers = vResult.modifiedCount || 0;

        // Move ledger entries inside vouchers (Dr/Cr lines)
        const leResult = await Acc_Voucher.updateMany(
          { "ledgerEntries.ledgerId": ghostLedger._id },
          {
            $set: {
              "ledgerEntries.$[e].ledgerId": keeperLedger._id,
              "ledgerEntries.$[e].ledgerName": keeperLedger.name,
            },
          },
          { arrayFilters: [{ "e.ledgerId": ghostLedger._id }] },
        );
        counts.ledgerEntries = leResult.modifiedCount || 0;

        // Transfer balance
        const ghostBal = ghostLedger.openingBalance || 0;
        if (ghostBal !== 0) {
          await Acc_Ledger.updateOne(
            { _id: keeperLedger._id },
            { $inc: { openingBalance: ghostBal, currentBalance: ghostBal } },
          );
        }

        // Deactivate ghost ledger
        ghostLedger.isActive = false;
        ghostLedger.deletedAt = new Date();
        await ghostLedger.save();
      } catch (e) {
        console.error("[vendor-merge] ledger migration:", e.message);
      }
    } else if (ghostLedger && !keeperLedger) {
      // Keeper has no ledger yet — relink the ghost ledger to the keeper
      // instead of deactivating it. This preserves all voucher data.
      ghostLedger.linkedVendorId = keeper._id;
      ghostLedger.name = keeper.companyName; // rename to keeper's name
      if (keeper.gstNumber && !ghostLedger.gstin)
        ghostLedger.gstin = keeper.gstNumber;
      await ghostLedger.save();
      counts.vouchers = await Acc_Voucher.countDocuments({
        partyLedgerId: ghostLedger._id,
        status: "posted",
      });
    }

    res.json({
      success: true,
      message: `Merged "${ghostLedger?.name || ghost?.companyName}" → "${keeper.companyName}". ${counts.purchaseOrders} POs, ${counts.vouchers} vouchers, ${counts.ledgerEntries} ledger entries transferred.`,
      counts,
    });
  } catch (error) {
    console.error("Error merging vendors:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Check if vendor has any purchase orders
    const purchaseOrders = await PurchaseOrder.find({ vendor: vendor._id });

    if (purchaseOrders.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete vendor with existing purchase orders. Mark as inactive instead.",
      });
    }

    await vendor.deleteOne();

    res.json({
      success: true,
      message: "Vendor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting vendor",
    });
  }
});

module.exports = router;
