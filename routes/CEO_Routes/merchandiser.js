/**
 * NEW FILE: routes/CEO_Routes/merchandiser.js
 * Register in server.js: app.use("/api/ceo/merchandiser", require("./routes/CEO_Routes/merchandiser"));
 */
"use strict";
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

function ceoAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res.status(403).json({ success: false, message: "CEO access required" });
    req.ceoUser = d; next();
  } catch { return res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

// ── BUYERS (Customers) ────────────────────────────────────────────────────────

router.get("/buyers/stats", ceoAuth, async (req, res) => {
  try {
    const Customer = require("../../models/Customer_Models/Customer");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

    const total = await Customer.countDocuments({});
    const requests = await CustomerRequest.find({}).select("status finalOrderPrice").lean();
    const totalOrders = requests.length;
    const totalRevenue = requests.reduce((s, r) => s + (r.finalOrderPrice || 0), 0);
    const activeOrders = requests.filter(r => ["in_progress", "pending", "quotation_sent"].includes(r.status)).length;
    const completedOrders = requests.filter(r => r.status === "completed").length;

    res.json({ success: true, stats: { total, totalOrders, totalRevenue, activeOrders, completedOrders } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/buyers/:id", ceoAuth, async (req, res) => {
  try {
    const Customer = require("../../models/Customer_Models/Customer");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

    const buyer = await Customer.findById(req.params.id).select("-password -otp -__v").lean();
    if (!buyer) return res.status(404).json({ success: false, message: "Not found" });

    const orders = await CustomerRequest.find({ customerId: buyer._id })
      .select("requestId status finalOrderPrice customerInfo items createdAt paymentSchedule")
      .sort({ createdAt: -1 }).limit(20).lean();

    const totalSpent = orders.reduce((s, o) => s + (o.finalOrderPrice || 0), 0);
    const activeOrders = orders.filter(o => ["in_progress", "pending", "quotation_sent"].includes(o.status)).length;
    const completedOrders = orders.filter(o => o.status === "completed").length;

    res.json({ success: true, buyer, orders, stats: { totalOrders: orders.length, totalSpent, activeOrders, completedOrders } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/buyers", ceoAuth, async (req, res) => {
  try {
    const Customer = require("../../models/Customer_Models/Customer");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const { search, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (search) filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];

    const total = await Customer.countDocuments(filter);
    const buyers = await Customer.find(filter)
      .select("name email phone profile.address profile.avatar lastLogin createdAt")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(Number(limit))
      .lean();

    // Attach order counts per buyer
    const ids = buyers.map(b => b._id);
    const orderCounts = await CustomerRequest.aggregate([
      { $match: { customerId: { $in: ids } } },
      { $group: { _id: "$customerId", count: { $sum: 1 }, revenue: { $sum: "$finalOrderPrice" } } }
    ]);
    const ocMap = {};
    orderCounts.forEach(o => { ocMap[o._id.toString()] = { count: o.count, revenue: o.revenue || 0 }; });
    const enriched = buyers.map(b => ({
      ...b,
      orderCount: ocMap[b._id.toString()]?.count || 0,
      totalRevenue: ocMap[b._id.toString()]?.revenue || 0,
    }));

    res.json({ success: true, buyers: enriched, pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PROFORMA INVOICES (CustomerRequests) ─────────────────────────────────────

router.get("/pi/stats", ceoAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const all = await CustomerRequest.find({}).select("status finalOrderPrice").lean();
    const byStatus = {};
    all.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    const totalRevenue = all.reduce((s, r) => s + (r.finalOrderPrice || 0), 0);
    res.json({
      success: true, stats: {
        total: all.length, byStatus, totalRevenue,
        pending: (byStatus["pending"] || 0) + (byStatus["quotation_draft"] || 0),
        active: (byStatus["in_progress"] || 0) + (byStatus["quotation_sent"] || 0),
        completed: byStatus["completed"] || 0,
        cancelled: byStatus["cancelled"] || 0,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/pi/:id", ceoAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const pi = await CustomerRequest.findById(req.params.id)
      .populate("customerId", "name email phone")
      .select("-__v").lean();
    if (!pi) return res.status(404).json({ success: false, message: "Not found" });

    // If measurement_conversion, fetch employee details
    let employees = [];
    let employeeCount = 0;
    if (pi.measurementId) {
      try {
        const Measurement = require("../../models/Customer_Models/Measurement");
        const meas = await Measurement.findById(pi.measurementId)
          .select("totalRegisteredEmployees employeeMeasurements").lean();
        if (meas) {
          employeeCount = meas.totalRegisteredEmployees || 0;
          // Basic employee list: name, UIN, gender, dept, designation
          employees = (meas.employeeMeasurements || []).map(e => ({
            name: e.employeeName,
            uin: e.employeeUIN,
            gender: e.gender,
            isCompleted: e.isCompleted,
          }));
        }
      } catch (e) { /* skip */ }
    }

    res.json({ success: true, pi: { ...pi, employeeCount, employees } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/pi", ceoAuth, async (req, res) => {
  try {
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const { search, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { requestId: { $regex: search, $options: "i" } },
      { "customerInfo.name": { $regex: search, $options: "i" } },
    ];
    if (status && status !== "all") filter.status = status;

    const total = await CustomerRequest.countDocuments(filter);
    const pis = await CustomerRequest.find(filter)
      .select("requestId customerId customerInfo status finalOrderPrice items paymentSchedule requestType measurementId measurementName createdAt updatedAt")
      .populate("customerId", "name email phone")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(Number(limit))
      .lean();

    // For measurement_conversion PIs, fetch employee counts from Measurement
    const measurementIds = pis.filter(p => p.measurementId).map(p => p.measurementId);
    let empCountMap = {};
    if (measurementIds.length > 0) {
      try {
        const Measurement = require("../../models/Customer_Models/Measurement");
        const measurements = await Measurement.find({ _id: { $in: measurementIds } })
          .select("_id totalRegisteredEmployees").lean();
        measurements.forEach(m => { empCountMap[m._id.toString()] = m.totalRegisteredEmployees || 0; });
      } catch (e) { /* Measurement model might not exist, skip */ }
    }

    const enriched = pis.map(p => ({
      ...p,
      employeeCount: p.measurementId ? (empCountMap[p.measurementId.toString()] || 0) : 0,
    }));

    res.json({ success: true, pis: enriched, pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;