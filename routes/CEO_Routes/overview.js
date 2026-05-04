/**
 * routes/CEO_Routes/overview.js
 * Single aggregation endpoint for the CEO dashboard overview
 * Register: app.use("/api/ceo/overview", require("./routes/CEO_Routes/overview"));
 */
"use strict";
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

function ceoAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token)
      return res.status(401).json({ success: false, message: "Auth required" });
    const d = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res
        .status(403)
        .json({ success: false, message: "CEO access required" });
    req.ceoUser = d;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}

const ds = (q, m) => {
  const qn = Number(q) || 0,
    mn = Number(m) || 0;
  if (qn <= 0) return "Out of Stock";
  if (qn <= mn) return "Low Stock";
  return "In Stock";
};
const istToday = () => {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

router.get("/", ceoAuth, async (req, res) => {
  const todayStr = istToday();
  const results = await Promise.allSettled([
    // ── 1. HR ──────────────────────────────────────────────────────────────
    (async () => {
      const Emp = require("../../models/Employee");
      const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
      const {
        LeaveApplication,
      } = require("../../models/HR_Models/LeaveManagement");

      const [total, active] = await Promise.all([
        Emp.countDocuments({}),
        Emp.countDocuments({ isActive: true }),
      ]);

      // Department breakdown
      const deptAgg = await Emp.aggregate([
        { $match: { department: { $exists: true, $ne: "" } } },
        { $group: { _id: "$department", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]);

      // Today's attendance from DailyAttendance — uses dateStr field
      let todayAttendance = {
        present: 0,
        absent: 0,
        onLeave: 0,
        late: 0,
        halfDay: 0,
      };
      try {
        const dayDoc = await DailyAttendance.findOne({ dateStr: todayStr })
          .select("summary")
          .lean();
        if (dayDoc?.summary) {
          const s = dayDoc.summary;
          // presentCount already computed by the model
          todayAttendance.present =
            s.presentCount ||
            (s.P || 0) + (s["P*"] || 0) + (s["P~"] || 0) + (s.MP || 0);
          todayAttendance.absent = s.AB || 0;
          todayAttendance.late = s["P*"] || 0;
          todayAttendance.halfDay = s.HD || 0;
        }
      } catch (e) {
        /* DailyAttendance might not have today's doc yet */
      }

      // Today's approved leaves from LeaveApplication
      try {
        todayAttendance.onLeave = await LeaveApplication.countDocuments({
          status: "hr_approved",
          fromDate: { $lte: todayStr },
          toDate: { $gte: todayStr },
        });
      } catch (e) {
        todayAttendance.onLeave = 0;
      }

      return {
        total,
        active,
        inactive: total - active,
        todayAttendance,
        topDepts: deptAgg.map((d) => ({
          dept: d._id || "Other",
          count: d.count,
        })),
      };
    })(),

    // ── 2. Raw Materials ───────────────────────────────────────────────────
    (async () => {
      const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
      const items = await RawItem.find({})
        .select("name sku unit quantity minStock maxStock variants updatedAt")
        .lean();
      let inStock = 0,
        lowStock = 0,
        outOfStock = 0;
      const alertItems = [];
      for (const it of items) {
        let s = ds(it.quantity, it.minStock);
        if (it.variants?.length > 0) {
          const vs = it.variants.map((v) =>
            ds(v.quantity, v.minStock ?? it.minStock),
          );
          if (vs.some((x) => x === "Out of Stock")) s = "Out of Stock";
          else if (vs.some((x) => x === "Low Stock")) s = "Low Stock";
          else s = "In Stock";
        }
        if (s === "In Stock") inStock++;
        else {
          if (s === "Low Stock") lowStock++;
          else outOfStock++;
          alertItems.push({
            name: it.name,
            sku: it.sku,
            unit: it.unit,
            qty: it.quantity,
            status: s,
          });
        }
      }
      return { total: items.length, inStock, lowStock, outOfStock, alertItems };
    })(),

    // ── 3. Stock Items ─────────────────────────────────────────────────────
    (async () => {
      const SI = require("../../models/CMS_Models/Inventory/Products/StockItem");
      const items = await SI.find({})
        .select("status inventoryValue potentialRevenue profitMargin")
        .lean();
      return {
        total: items.length,
        active: items.filter(
          (i) => i.status === "active" || i.status === "In Stock",
        ).length,
        lowStock: items.filter((i) => i.status === "Low Stock").length,
        outOfStock: items.filter((i) => i.status === "Out of Stock").length,
        inventoryValue: items.reduce((s, i) => s + (i.inventoryValue || 0), 0),
        potentialRevenue: items.reduce(
          (s, i) => s + (i.potentialRevenue || 0),
          0,
        ),
        avgMargin:
          items.length > 0
            ? Math.round(
                (items.reduce((s, i) => s + (i.profitMargin || 0), 0) /
                  items.length) *
                  10,
              ) / 10
            : 0,
      };
    })(),

    // ── 4. Purchase Orders ─────────────────────────────────────────────────
    (async () => {
      const PO = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
      const all = await PO.find({})
        .select(
          "poNumber status totalAmount vendorName orderDate expectedDeliveryDate",
        )
        .sort({ createdAt: -1 })
        .lean();
      const now = new Date();
      const overdue = all.filter(
        (p) =>
          p.expectedDeliveryDate &&
          new Date(p.expectedDeliveryDate) < now &&
          ["ISSUED", "PARTIALLY_RECEIVED"].includes(p.status),
      );
      return {
        total: all.length,
        draft: all.filter((p) => p.status === "DRAFT").length,
        issued: all.filter((p) => p.status === "ISSUED").length,
        partiallyReceived: all.filter((p) => p.status === "PARTIALLY_RECEIVED")
          .length,
        completed: all.filter((p) => p.status === "COMPLETED").length,
        cancelled: all.filter((p) => p.status === "CANCELLED").length,
        totalValue: all.reduce((s, p) => s + (p.totalAmount || 0), 0),
        pendingValue: all
          .filter((p) => ["ISSUED", "PARTIALLY_RECEIVED"].includes(p.status))
          .reduce((s, p) => s + (p.totalAmount || 0), 0),
        overdueCount: overdue.length,
        recent: all.slice(0, 6).map((p) => ({
          poNumber: p.poNumber,
          vendorName: p.vendorName,
          status: p.status,
          totalAmount: p.totalAmount,
        })),
      };
    })(),

    // ── 5. QC Today ────────────────────────────────────────────────────────
    (async () => {
      const QCI = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord"); // model registered as QCInspection
      const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
      const all = await QCI.find({ date: todayStr })
        .select("status defects inspectedByQCName inspectedAt workOrderId")
        .sort({ inspectedAt: -1 })
        .lean();
      const passed = all.filter((i) => i.status === "passed");
      const defective = all.filter((i) => i.status === "defective");
      const totalDefectOps = defective.reduce(
        (s, i) => s + (i.defects?.length || 0),
        0,
      );
      // Top defect operations
      const opCounts = {};
      defective.forEach((i) =>
        (i.defects || []).forEach((d) => {
          opCounts[d.operationName || d.operationCode] =
            (opCounts[d.operationName || d.operationCode] || 0) + 1;
        }),
      );
      const topDefects = Object.entries(opCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([op, count]) => ({ op, count }));
      return {
        total: all.length,
        passed: passed.length,
        defective: defective.length,
        passRate:
          all.length > 0 ? Math.round((passed.length / all.length) * 100) : 0,
        totalDefectOps,
        topDefects,
        date: todayStr,
      };
    })(),

    // ── 6. Merchandiser / PI ───────────────────────────────────────────────
    (async () => {
      const CR = require("../../models/Customer_Models/CustomerRequest");
      const all = await CR.find({})
        .select(
          "requestId status finalOrderPrice customerInfo createdAt requestType paymentSchedule",
        )
        .sort({ createdAt: -1 })
        .lean();
      const byStatus = {};
      all.forEach((r) => {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      });
      const totalRevenue = all.reduce(
        (s, r) => s + (r.finalOrderPrice || 0),
        0,
      );
      const totalPaid = all.reduce(
        (s, r) =>
          s +
          (r.paymentSchedule || []).reduce(
            (ss, p) => ss + (p.paidAmount || 0),
            0,
          ),
        0,
      );
      const active = all.filter((r) =>
        [
          "in_progress",
          "quotation_sent",
          "quotation_sales_approved",
          "quotation_customer_approved",
        ].includes(r.status),
      );
      return {
        total: all.length,
        active: active.length,
        completed: byStatus["completed"] || 0,
        cancelled: byStatus["cancelled"] || 0,
        salesApproved:
          (byStatus["quotation_sales_approved"] || 0) +
          (byStatus["quotation_customer_approved"] || 0),
        totalRevenue,
        totalPaid,
        pendingPayment: totalRevenue - totalPaid,
        recent: active.slice(0, 5).map((r) => ({
          requestId: r.requestId,
          customer: r.customerInfo?.name,
          status: r.status,
          value: r.finalOrderPrice || 0,
        })),
      };
    })(),

    // ── 7. Buyers ──────────────────────────────────────────────────────────
    (async () => {
      const Customer = require("../../models/Customer_Models/Customer");
      const total = await Customer.countDocuments({});
      const recent = await Customer.find({})
        .select("name email createdAt")
        .sort({ createdAt: -1 })
        .limit(4)
        .lean();
      return {
        total,
        recent: recent.map((c) => ({ name: c.name, email: c.email })),
      };
    })(),

    // ── 8. Vendors ─────────────────────────────────────────────────────────
    (async () => {
      const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
      const all = await Vendor.find({})
        .select("status companyName rating vendorType")
        .lean();
      const avgRating =
        all.length > 0
          ? Math.round(
              (all.reduce((s, v) => s + (v.rating || 0), 0) / all.length) * 10,
            ) / 10
          : 0;
      return {
        total: all.length,
        active: all.filter((v) => v.status === "Active").length,
        inactive: all.filter((v) => v.status === "Inactive").length,
        blacklisted: all.filter((v) => v.status === "Blacklisted").length,
        avgRating,
        blacklistedList: all
          .filter((v) => v.status === "Blacklisted")
          .slice(0, 3)
          .map((v) => v.companyName),
      };
    })(),

    // ── 9. Machines ────────────────────────────────────────────────────────
    (async () => {
      const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
      const all = await Machine.find({})
        .select("name status type nextMaintenance lastMaintenance location")
        .lean();
      const now = new Date();
      const overdue = all.filter(
        (m) =>
          m.nextMaintenance &&
          new Date(m.nextMaintenance) < now &&
          m.status !== "Under Maintenance",
      );
      const dueSoon = all.filter((m) => {
        if (!m.nextMaintenance) return false;
        const d = Math.ceil((new Date(m.nextMaintenance) - now) / 86400000);
        return d >= 0 && d <= 7;
      });
      return {
        total: all.length,
        operational: all.filter((m) => m.status === "Operational").length,
        idle: all.filter((m) => m.status === "Idle").length,
        maintenance: all.filter((m) => m.status === "Under Maintenance").length,
        repairNeeded: all.filter((m) => m.status === "Repair Needed").length,
        maintenanceOverdue: overdue
          .slice(0, 5)
          .map((m) => ({ name: m.name, type: m.type, location: m.location })),
        maintenanceDueSoon: dueSoon.slice(0, 3).map((m) => ({
          name: m.name,
          days: Math.ceil((new Date(m.nextMaintenance) - now) / 86400000),
        })),
      };
    })(),
  ]);

  const [hr, rawMat, stockItems, pos, qc, piData, buyers, vendors, machines] =
    results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: r.reason?.message },
    );
  res.json({
    success: true,
    data: {
      hr,
      rawMaterials: rawMat,
      stockItems,
      purchaseOrders: pos,
      qc,
      proformaInvoices: piData,
      buyers,
      vendors,
      machines,
      generatedAt: new Date(),
      today: todayStr,
    },
  });
});

module.exports = router;
