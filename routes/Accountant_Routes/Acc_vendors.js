// routes/Accountant_Routes/Acc_vendors.js

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
// IMPORTED PARTY BRIDGE — Sundry Creditors from a Tally import
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
    // Skip ledgers already linked to a CMS Vendor — those are the keeper's
    // ledger after a merge, not separate ghost rows.
    linkedVendorId: { $in: [null, undefined] },
  })
    .select(
      "name gstin aliases groupName openingBalance openingBalanceType email phone isActive linkedVendorId",
    )
    .lean();

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
        lastDate: { $max: "$voucherDate" },
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
    const closingSigned = openSigned + dr - cr;
    const owed = closingSigned < 0 ? Math.abs(closingSigned) : 0;
    const advance = closingSigned > 0 ? closingSigned : 0;
    return {
      id: l._id,
      ledgerId: l._id,
      isLedgerOnly: true,
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
      // Books side only — imported ledger parties have no purchase orders.
      ledgerPayables: parseFloat(Math.abs(closingSigned).toFixed(2)),
      ledgerOutstanding: parseFloat(owed.toFixed(2)),
      ledgerAdvance: parseFloat(advance.toFixed(2)),
      voucherCount: a.totalPOs || 0,
      ledgerLastDate: a.lastDate || null,
      // Procurement side is empty for a ledger-only party.
      poPayables: 0,
      poOutstanding: 0,
      poPaid: 0,
      poCount: 0,
      poLastDate: null,
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
      aliases: l.aliases || [],
      groupName: l.groupName || null,
      _normName: normalizePartyName(l.name),
      _gstinKey: (l.gstin || "").toUpperCase().replace(/\s+/g, ""),
    };
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// GET / — All vendors with financial stats
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { search = "", status } = req.query;

    let cId = null;
    if (req.query.companyId) {
      try {
        cId = new mongoose.Types.ObjectId(req.query.companyId);
      } catch {
        cId = null;
      }
    }

    let filter = {};
    if (search) {
      const vendorCodeMatch = search.match(/^VEN-?([A-Fa-f0-9]{4,12})$/i);
      if (vendorCodeMatch) {
        const suffix = vendorCodeMatch[1].toLowerCase();
        const allVendorsRaw = await Vendor.find({}).select("_id").lean();
        const matchingIds = allVendorsRaw
          .filter((v) => v._id.toString().endsWith(suffix))
          .map((v) => v._id);
        filter._id = matchingIds.length > 0 ? { $in: matchingIds } : null;
      } else {
        filter.$or = [
          { companyName: { $regex: search, $options: "i" } },
          { contactPerson: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { gstNumber: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ];
      }
    }
    if (status && status !== "all") filter.status = status;

    const vendors = await Vendor.find(filter)
      .select(
        "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms createdBy updatedBy createdAt",
      )
      .sort({ companyName: 1 });

    const vendorsWithStats = await Promise.all(
      vendors.map(async (vendor) => {
        // ── PROCUREMENT SIDE — purchase orders & PO payments only ──────────
        // These figures NEVER mix with books figures. A vendor that also has
        // an accounting ledger carries both sets, shown on separate tabs.
        const purchaseOrders = await PurchaseOrder.find({
          vendor: vendor._id,
          status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
        });

        let poPayables = 0;
        let poOutstanding = 0;
        let poPaid = 0;
        const poCount = purchaseOrders.length;
        let poLastDate = null;

        purchaseOrders.forEach((po) => {
          poPayables += po.totalAmount || 0;
          const paid =
            po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
          poPaid += paid;
          poOutstanding += (po.totalAmount || 0) - paid;
          if (po.orderDate) {
            const d = new Date(po.orderDate).getTime();
            if (!poLastDate || d > poLastDate) poLastDate = d;
          }
        });

        // ── BOOKS SIDE — posted accounting vouchers only ────────────────────
        // Computed from ledgerEntries aggregation (not vendorLedger
        // .currentBalance, which goes stale). Scoped to the active company —
        // the old code omitted companyId and summed across every company.
        let vendorLedger = null;
        let ledgerPayables = 0;
        let ledgerOutstanding = 0;
        let ledgerAdvance = 0;
        let voucherCount = 0;
        let ledgerLastDate = null;

        try {
          const ledgerQuery = {
            linkedVendorId: vendor._id,
            isActive: { $ne: false },
          };
          if (cId) ledgerQuery.companyId = cId;
          vendorLedger = await Acc_Ledger.findOne(ledgerQuery).lean();

          if (!vendorLedger) {
            const nameQuery = {
              name: new RegExp(
                "^" +
                  String(vendor.companyName || "").replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                  ) +
                  "$",
                "i",
              ),
              isActive: { $ne: false },
            };
            if (cId) nameQuery.companyId = cId;
            vendorLedger = await Acc_Ledger.findOne(nameQuery).lean();
          }

          if (vendorLedger) {
            const match = { status: "posted" };
            if (cId) match.companyId = cId;
            const ledgerAgg = await Acc_Voucher.aggregate([
              { $match: match },
              { $unwind: "$ledgerEntries" },
              { $match: { "ledgerEntries.ledgerId": vendorLedger._id } },
              {
                $group: {
                  _id: null,
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
                  voucherIds: { $addToSet: "$_id" },
                  lastDate: { $max: "$voucherDate" },
                },
              },
            ]);

            if (ledgerAgg.length > 0) {
              const a = ledgerAgg[0];
              voucherCount = a.voucherIds ? a.voucherIds.length : 0;
              ledgerLastDate = a.lastDate || null;
              const openSigned =
                (vendorLedger.openingBalanceType === "Cr" ? -1 : 1) *
                Math.abs(vendorLedger.openingBalance || 0);
              // Sundry Creditor: negative closing = we still owe them
              const closingSigned = openSigned + (a.dr || 0) - (a.cr || 0);
              ledgerPayables = Math.abs(closingSigned);
              ledgerOutstanding =
                closingSigned < 0 ? Math.abs(closingSigned) : 0;
              ledgerAdvance = closingSigned > 0 ? closingSigned : 0;
            }
          }
        } catch (_) {
          // Acc_Ledger / Acc_Voucher not available — procurement stats only
        }

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const recentPOs = await PurchaseOrder.find({
          vendor: vendor._id,
          orderDate: { $gte: sixMonthsAgo },
          status: { $in: ["PARTIALLY_RECEIVED", "COMPLETED"] },
        });
        const totalExpenses6Months = recentPOs.reduce((sum, po) => {
          const paid =
            po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
          return sum + paid;
        }, 0);

        const R = (n) => parseFloat(Number(n || 0).toFixed(2));

        return {
          id: vendor._id,
          ledgerId: vendorLedger?._id || null,
          isLedgerOnly: false,
          vendorId: `VEN-${(vendorLedger?._id || vendor._id).toString().substring(18, 24).toUpperCase()}`,
          name: vendor.companyName,
          contactPerson: vendor.contactPerson,
          email: vendor.email,
          phone: vendor.phone,
          company: vendor.companyName,
          type: vendor.vendorType || "Business",
          currency: "INR",

          // ── Procurement side (purchase orders) ──────────────────────────
          poPayables: R(poPayables),
          poOutstanding: R(poOutstanding),
          poPaid: R(poPaid),
          poCount,
          poLastDate: poLastDate ? new Date(poLastDate) : null,

          // ── Books side (posted vouchers) ────────────────────────────────
          ledgerPayables: R(ledgerPayables),
          ledgerOutstanding: R(ledgerOutstanding),
          ledgerAdvance: R(ledgerAdvance),
          voucherCount,
          ledgerLastDate,

          unusedCredits: 0,
          paymentTerms: vendor.paymentTerms || "Net 30",
          gstin: vendor.gstNumber || "",
          pan: vendor.panNumber || "",
          status: vendor.status || "Active",
          portalStatus: "Disabled",
          createdDate: vendor.createdAt
            ? vendor.createdAt.toLocaleDateString("en-GB")
            : "",
          createdBy: "System",
          totalExpenses6Months: R(totalExpenses6Months),
          billingAddress: vendor.address || {
            street: "",
            city: "",
            state: "",
            pincode: "",
            country: "India",
          },
        };
      }),
    );

    // ── Imported Tally ledger parties — books side only, no PO figures ─────
    // These are appended as SEPARATE rows. They are never merged into, or
    // summed with, a CMS vendor. Ghost/duplicate detection is intentionally
    // gone: "Binod Textile (procurement)" and "Binod Textile (books)" are
    // two distinct records living on two distinct tabs.
    let allVendors = vendorsWithStats;
    try {
      let imported = await importedVendorRows(req.query.companyId);

      const q = String(req.query.search || "")
        .trim()
        .toLowerCase();
      if (q) {
        imported = imported.filter(
          (v) =>
            (v.name || "").toLowerCase().includes(q) ||
            (v.gstin || "").toLowerCase().includes(q) ||
            (v.vendorId || "").toLowerCase().includes(q) ||
            (v.aliases || []).some((al) => al.toLowerCase().includes(q)),
        );
      }
      imported = imported.map(({ _normName, _gstinKey, ...rest }) => rest);

      // ── Dedupe by ledgerId — a hard identity, never by name ──────────────
      // A CMS vendor resolves its ledger either via linkedVendorId OR via the
      // name-regex fallback. In the fallback case the ledger's linkedVendorId
      // is still null, so importedVendorRows legitimately emits it too — and
      // the same ledger ends up listed twice under the same VEN- code.
      //
      // The CMS vendor wins: it carries contact details, status and purchase
      // orders. The bare imported row is dropped. We match on ledgerId only.
      // Matching on name is what produced the ghost/merge mess in the first
      // place — two genuinely different parties can share a name, and fusing
      // them silently destroys data.
      const claimedLedgerIds = new Set(
        vendorsWithStats
          .filter((v) => v.ledgerId)
          .map((v) => String(v.ledgerId)),
      );
      imported = imported.filter(
        (v) => !v.ledgerId || !claimedLedgerIds.has(String(v.ledgerId)),
      );

      if (imported.length) allVendors = [...vendorsWithStats, ...imported];
    } catch (impErr) {
      console.error("[vendors] imported-party load skipped:", impErr.message);
    }

    // ── Per-side stat blocks — summed within a side, never across ──────────
    // A vendor with both a ledger and purchase orders contributes its books
    // figures to `books` and its PO figures to `procurement`. Nothing is
    // counted twice, and the two blocks are not expected to add up to
    // anything meaningful — they measure different things.
    const booksRows = allVendors.filter((v) => !!v.ledgerId);
    const procurementRows = allVendors.filter((v) => !v.isLedgerOnly);

    const sum = (rows, key) =>
      parseFloat(rows.reduce((s, v) => s + (v[key] || 0), 0).toFixed(2));

    res.json({
      success: true,
      vendors: allVendors,
      stats: {
        total: allVendors.length,
        books: {
          total: booksRows.length,
          totalPayables: sum(booksRows, "ledgerPayables"),
          totalOutstanding: sum(booksRows, "ledgerOutstanding"),
        },
        procurement: {
          total: procurementRows.length,
          totalPayables: sum(procurementRows, "poPayables"),
          totalOutstanding: sum(procurementRows, "poOutstanding"),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while fetching vendors" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — Single vendor details
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select(
      "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms bankDetails primaryProducts createdBy updatedBy createdAt",
    );
    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found" });
    }

    const purchaseOrders = await PurchaseOrder.find({
      vendor: vendor._id,
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
    })
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending paymentStatus payments",
      )
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    let totalPayables = 0,
      outstandingPayables = 0,
      totalPaid = 0;
    let recentTransactions = [];

    purchaseOrders.forEach((po) => {
      totalPayables += po.totalAmount || 0;
      const poPaid =
        po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      totalPaid += poPaid;
      outstandingPayables += (po.totalAmount || 0) - poPaid;
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
    recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

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

    // Scope the ledger lookup to the active company. Without companyId the
    // name-regex fallback can resolve a same-named ledger from ANOTHER
    // company, which is how the detail page ended up pointing at a ledger
    // that didn't belong to this vendor.
    let detailCId = null;
    if (req.query.companyId) {
      try {
        detailCId = new mongoose.Types.ObjectId(req.query.companyId);
      } catch {
        detailCId = null;
      }
    }

    let detailLedger = null;
    try {
      const linkQuery = {
        linkedVendorId: vendor._id,
        isActive: { $ne: false },
      };
      if (detailCId) linkQuery.companyId = detailCId;
      detailLedger = await Acc_Ledger.findOne(linkQuery).select("_id").lean();

      if (!detailLedger) {
        const nameQuery = {
          name: new RegExp(
            "^" +
              String(vendor.companyName || "").replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              ) +
              "$",
            "i",
          ),
          isActive: { $ne: false },
        };
        if (detailCId) nameQuery.companyId = detailCId;
        detailLedger = await Acc_Ledger.findOne(nameQuery).select("_id").lean();
      }
    } catch (_) {}

    res.json({
      success: true,
      vendor: {
        id: vendor._id,
        ledgerId: detailLedger?._id || null,
        vendorId: `VEN-${(detailLedger?._id || vendor._id).toString().substring(18, 24).toUpperCase()}`,
        name: vendor.companyName,
        contactPerson: vendor.contactPerson,
        email: vendor.email,
        phone: vendor.phone,
        company: vendor.companyName,
        type: vendor.vendorType || "Business",
        currency: "INR",
        // These are PROCUREMENT-side figures — purchase orders and PO
        // payments only. They are NOT the ledger balance. For the books
        // balance, open the ledger via ledgerId. The two are never summed.
        poPayables: parseFloat(totalPayables.toFixed(2)),
        poOutstanding: parseFloat(outstandingPayables.toFixed(2)),
        poPaid: parseFloat(totalPaid.toFixed(2)),
        poCount: purchaseOrders.length,
        // Legacy names retained so existing callers don't break. Same
        // procurement-side numbers — deliberately NOT ledger figures.
        totalPayables: parseFloat(totalPayables.toFixed(2)),
        outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
        unusedCredits: 0,
        paymentTerms: vendor.paymentTerms || "Net 30",
        gstin: vendor.gstNumber || "",
        pan: vendor.panNumber || "",
        status: vendor.status || "Active",
        portalStatus: "Disabled",
        createdDate: vendor.createdAt
          ? vendor.createdAt.toLocaleDateString("en-GB")
          : "",
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
            (po) =>
              po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED",
          ).length,
          totalPaid: parseFloat(totalPaid.toFixed(2)),
          avgPaymentDays: 30,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching vendor details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor details",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/purchase-orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    let filter = { vendor: req.params.id };
    if (status && status !== "all") filter.status = status;
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/transactions
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/transactions", async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("poNumber orderDate totalAmount status paymentStatus payments")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    let transactions = [];
    purchaseOrders.forEach((po) => {
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

    if (type && type !== "all")
      transactions = transactions.filter((t) => t.type === type);
    if (startDate) {
      const s = new Date(startDate);
      transactions = transactions.filter((t) => new Date(t.date) >= s);
    }
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      transactions = transactions.filter((t) => new Date(t.date) <= e);
    }
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalPurchases = transactions
      .filter((t) => t.type === "PURCHASE_ORDER")
      .reduce((sum, t) => sum + t.amount, 0);
    const totalPayments = transactions
      .filter((t) => t.type === "PAYMENT")
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    res.json({
      success: true,
      transactions,
      summary: {
        totalPurchases: parseFloat(totalPurchases.toFixed(2)),
        totalPayments: parseFloat(totalPayments.toFixed(2)),
        balance: parseFloat((totalPurchases - totalPayments).toFixed(2)),
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/payment
// ─────────────────────────────────────────────────────────────────────────────
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
    if (!purchaseOrderId)
      return res
        .status(400)
        .json({ success: false, message: "Purchase Order ID is required" });
    if (!amount || amount <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Valid payment amount is required" });
    if (!paymentMethod)
      return res
        .status(400)
        .json({ success: false, message: "Payment method is required" });

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: purchaseOrderId,
      vendor: req.params.id,
    });
    if (!purchaseOrder)
      return res.status(404).json({
        success: false,
        message: "Purchase order not found for this vendor",
      });

    const totalPaid =
      purchaseOrder.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;
    if (amount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (₹${amount}) exceeds remaining amount (₹${remainingAmount})`,
      });
    }

    if (!purchaseOrder.payments) purchaseOrder.payments = [];
    purchaseOrder.payments.unshift({
      amount: parseFloat(amount),
      paymentMethod,
      referenceNumber: referenceNumber || "",
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      notes: notes || "",
      recordedBy: req.user.id,
    });
    const newTotalPaid = totalPaid + amount;
    purchaseOrder.paymentStatus =
      newTotalPaid >= purchaseOrder.totalAmount
        ? "COMPLETED"
        : newTotalPaid > 0
          ? "PARTIAL"
          : "PENDING";
    await purchaseOrder.save();

    const updatedPO = await PurchaseOrder.findById(purchaseOrderId).populate(
      "payments.recordedBy",
      "name email",
    );
    res.json({
      success: true,
      message: `Payment of ₹${amount} recorded successfully`,
      payment: updatedPO.payments[0],
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

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id/purchase-orders/:poId/payment-status
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/purchase-orders/:poId/payment-status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, message: "Payment status is required" });
    const validStatuses = ["PENDING", "PARTIAL", "COMPLETED"];
    if (!validStatuses.includes(status))
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment status" });

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.poId,
      vendor: req.params.id,
    });
    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/payments
// ─────────────────────────────────────────────────────────────────────────────
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
    if (startDate) {
      const s = new Date(startDate);
      allPayments = allPayments.filter((p) => new Date(p.date) >= s);
    }
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      allPayments = allPayments.filter((p) => new Date(p.date) <= e);
    }
    allPayments.sort((a, b) => new Date(b.date) - new Date(a.date));
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

// ─────────────────────────────────────────────────────────────────────────────
// POST / — Create new vendor
// ─────────────────────────────────────────────────────────────────────────────
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
    if (!companyName)
      return res
        .status(400)
        .json({ success: false, message: "Company name is required" });
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });

    const existingVendor = await Vendor.findOne({
      $or: [
        { companyName: { $regex: new RegExp(`^${companyName}$`, "i") } },
        { email: { $regex: new RegExp(`^${email}$`, "i") } },
      ],
    });
    if (existingVendor)
      return res.status(400).json({
        success: false,
        message: "Vendor with this name or email already exists",
      });

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
    res
      .status(500)
      .json({ success: false, message: "Server error while creating vendor" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — Update vendor
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor)
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found" });
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
    res
      .status(500)
      .json({ success: false, message: "Server error while updating vendor" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/merge — Merge a ghost vendor's transactions into keeper
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/merge", async (req, res) => {
  try {
    const keeperId = req.params.id;
    const { mergeFromId } = req.body || {};

    if (!mergeFromId)
      return res
        .status(400)
        .json({ success: false, message: "mergeFromId required" });
    if (String(keeperId) === String(mergeFromId))
      return res
        .status(400)
        .json({ success: false, message: "Cannot merge into itself" });

    // Scope every ledger lookup to the active company. Without this, a
    // name-regex match can resolve a same-named ledger belonging to a
    // DIFFERENT company and quietly move its vouchers.
    let cId = null;
    if (req.query.companyId || req.body.companyId) {
      try {
        cId = new mongoose.Types.ObjectId(
          req.query.companyId || req.body.companyId,
        );
      } catch {
        cId = null;
      }
    }
    const scoped = (q) => (cId ? { ...q, companyId: cId } : q);

    // Escape a name for safe use inside a RegExp. Returns null when the name
    // is missing — a malformed vendor used to crash the whole route here with
    // "Cannot read properties of undefined (reading 'replace')".
    const nameRx = (s) => {
      const t = String(s || "").trim();
      if (!t) return null;
      return new RegExp(
        "^" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
        "i",
      );
    };

    const keeper = await Vendor.findById(keeperId).catch(() => null);
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

    let ghost = await Vendor.findById(mergeFromId).catch(() => null);
    let ghostLedger = null;

    if (ghost) {
      // ── Path A: the ghost is a CMS Vendor ──────────────────────────────
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

      ghostLedger = await Acc_Ledger.findOne(
        scoped({ linkedVendorId: ghost._id }),
      ).catch(() => null);

      if (!ghostLedger) {
        const rx = nameRx(ghost.companyName);
        if (rx) {
          ghostLedger = await Acc_Ledger.findOne(
            scoped({ name: rx, isActive: { $ne: false } }),
          ).catch(() => null);
        }
      }

      ghost.status = "Inactive";
      ghost.notes = `[MERGED] Transactions moved to ${keeper.companyName || "keeper"} on ${new Date().toISOString()}`;
      await ghost.save();
    } else {
      // ── Path B: the ghost is a bare Acc_Ledger (Tally import) ──────────
      ghostLedger = await Acc_Ledger.findById(mergeFromId).catch(() => null);
      if (!ghostLedger)
        return res
          .status(404)
          .json({ success: false, message: "Ghost vendor/ledger not found" });
    }

    let keeperLedger = await Acc_Ledger.findOne(
      scoped({ linkedVendorId: keeper._id, isActive: { $ne: false } }),
    ).catch(() => null);

    if (!keeperLedger) {
      const rx = nameRx(keeper.companyName);
      if (rx) {
        keeperLedger = await Acc_Ledger.findOne(
          scoped({ name: rx, isActive: { $ne: false } }),
        ).catch(() => null);
      }
    }

    const ghostLabel =
      ghostLedger?.name || ghost?.companyName || String(mergeFromId);
    const keeperLabel = keeper.companyName || String(keeperId);

    // ── Case 1: two distinct ledgers — migrate vouchers and balances ──────
    if (
      ghostLedger &&
      keeperLedger &&
      String(ghostLedger._id) !== String(keeperLedger._id)
    ) {
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

      // ── Transfer balances — SIGNED arithmetic ─────────────────────────
      // Acc_Ledger stores balances SIGNED (positive = Dr, negative = Cr).
      // signedBal() also tolerates the older magnitude+type convention.
      const signedBal = (val, type) => {
        const v = Number(val) || 0;
        if (v < 0) return v;
        return (type === "Cr" ? -1 : 1) * v;
      };

      const newOpenSigned =
        signedBal(
          keeperLedger.openingBalance,
          keeperLedger.openingBalanceType,
        ) +
        signedBal(ghostLedger.openingBalance, ghostLedger.openingBalanceType);
      const newCurrSigned =
        signedBal(
          keeperLedger.currentBalance,
          keeperLedger.currentBalanceType,
        ) +
        signedBal(ghostLedger.currentBalance, ghostLedger.currentBalanceType);

      await Acc_Ledger.updateOne(
        { _id: keeperLedger._id },
        {
          $set: {
            openingBalance: newOpenSigned,
            openingBalanceType: newOpenSigned < 0 ? "Cr" : "Dr",
            currentBalance: newCurrSigned,
            currentBalanceType: newCurrSigned < 0 ? "Cr" : "Dr",
            ...(keeperLedger.balanceFromTrialBalance ||
            ghostLedger.balanceFromTrialBalance
              ? { balanceFromTrialBalance: true }
              : {}),
          },
        },
      );

      await Acc_Ledger.updateOne(
        { _id: ghostLedger._id },
        {
          $set: {
            isActive: false,
            openingBalance: 0,
            currentBalance: 0,
            balanceFromTrialBalance: false,
            linkedVendorId: null,
            name: `[MERGED] ${ghostLedger.name}`,
          },
        },
      );

      return res.json({
        success: true,
        message: `Merged "${ghostLabel}" → "${keeperLabel}". ${counts.purchaseOrders} POs, ${counts.vouchers} vouchers, ${counts.ledgerEntries} ledger entries transferred.`,
        counts,
      });
    }

    // ── Case 2: only the ghost has a ledger — relink it to the keeper ─────
    if (ghostLedger && !keeperLedger) {
      await Acc_Ledger.updateOne(
        { _id: ghostLedger._id },
        {
          $set: {
            linkedVendorId: keeper._id,
            name: keeper.companyName || ghostLedger.name,
            ...(keeper.gstNumber && !ghostLedger.gstin
              ? { gstin: keeper.gstNumber }
              : {}),
          },
        },
      );
      counts.vouchers = await Acc_Voucher.countDocuments({
        partyLedgerId: ghostLedger._id,
        status: "posted",
      });

      return res.json({
        success: true,
        message: `Linked ledger "${ghostLabel}" to "${keeperLabel}". ${counts.purchaseOrders} POs moved, ${counts.vouchers} vouchers now belong to the keeper.`,
        counts,
      });
    }

    // ── Case 3: both point at the SAME ledger ─────────────────────────────
    // Nothing to migrate. The ghost vendor record was still deactivated and
    // its POs moved (Path A above). Make sure the ledger carries the link so
    // this duplicate never resurfaces in importedVendorRows().
    if (
      ghostLedger &&
      keeperLedger &&
      String(ghostLedger._id) === String(keeperLedger._id)
    ) {
      if (String(keeperLedger.linkedVendorId || "") !== String(keeper._id)) {
        await Acc_Ledger.updateOne(
          { _id: keeperLedger._id },
          { $set: { linkedVendorId: keeper._id } },
        );
      }
      return res.json({
        success: true,
        message: `"${ghostLabel}" and "${keeperLabel}" already share one ledger. ${counts.purchaseOrders} POs moved; ledger link repaired. No vouchers needed migrating.`,
        counts,
      });
    }

    // ── Case 4: no ledger on either side ──────────────────────────────────
    // This is the "nothing to merge" case that used to fall through both
    // branches and return a bogus `Merged "undefined" → ...` success. There
    // is no accounting ledger to consolidate. If the ghost was a CMS vendor
    // its POs have already moved and it's been deactivated — that IS the
    // merge. Say so plainly instead of pretending vouchers moved.
    if (!ghostLedger) {
      if (ghost) {
        return res.json({
          success: true,
          message: `Merged "${ghostLabel}" → "${keeperLabel}". Neither vendor has an accounting ledger, so nothing was posted to the books. ${counts.purchaseOrders} PO${counts.purchaseOrders === 1 ? "" : "s"} and ${counts.payments} payment${counts.payments === 1 ? "" : "s"} moved; the duplicate is now Inactive.`,
          counts,
        });
      }
      return res.status(400).json({
        success: false,
        message: `Nothing to merge: "${ghostLabel}" has no accounting ledger and is not a vendor record.`,
      });
    }

    // Unreachable in practice — keeps the contract explicit.
    return res.status(400).json({
      success: false,
      message: `Nothing to merge between "${ghostLabel}" and "${keeperLabel}".`,
    });
  } catch (error) {
    console.error("Error merging vendors:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor)
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found" });
    const purchaseOrders = await PurchaseOrder.find({ vendor: vendor._id });
    if (purchaseOrders.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete vendor with existing purchase orders. Mark as inactive instead.",
      });
    }
    await vendor.deleteOne();
    res.json({ success: true, message: "Vendor deleted successfully" });
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while deleting vendor" });
  }
});

module.exports = router;
