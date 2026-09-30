// routes/Customer_Routes/BuyerReports.js
// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER-FACING: the buyer's reports on one of their orders. The reports
// are built in services/buyerReports.js, from what the factory records.
//
//   GET /api/customer/requests/:id/reports                   which reports exist
//   GET /api/customer/requests/:id/reports/cutting/:day      Cutting Report
//   GET /api/customer/requests/:id/reports/production/:day   Daily Production Report
//   GET /api/customer/requests/:id/reports/inspection        Final Inspection Report
//   GET /api/customer/requests/:id/reports/closing           Order Closing Report
//
// :day is an India day, YYYY-MM-DD. Read-only. An order that isn't the
// signed-in buyer's is a 404, as on the tracking route.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const reports = require("../../services/buyerReports");

// ─── Customer auth (as on the tracking route) ───────────────────────────────
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Access denied. Please sign in." });
    }
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key_2024",
    );
    req.customerId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid token. Please sign in again.",
    });
  }
};

// The signed-in buyer's order, or an error already sent.
async function ownOrder(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, message: "Invalid request ID" });
    return null;
  }
  const order = await reports.orderFor(id, req.customerId);
  if (!order) {
    res.status(404).json({ success: false, message: "Order not found" });
    return null;
  }
  return order;
}

const failed = (res, what, err) => {
  console.error(`[buyer reports] ${what}:`, err);
  res.status(500).json({ success: false, message: `Could not load the ${what}.` });
};

router.get("/:id/reports", verifyCustomerToken, async (req, res) => {
  try {
    const order = await ownOrder(req, res);
    if (!order) return;
    res.json({ success: true, ...(await reports.overview(order)) });
  } catch (err) {
    failed(res, "reports", err);
  }
});

// A day's report: a real India day that has already begun.
async function daily(req, res, kind, what) {
  try {
    const { day } = req.params;
    if (!reports.isDay(day)) {
      return res.status(400).json({ success: false, message: "The day must be YYYY-MM-DD." });
    }
    if (day > reports.today()) {
      return res.status(400).json({ success: false, message: "That day hasn't happened yet." });
    }
    const order = await ownOrder(req, res);
    if (!order) return;
    res.json({ success: true, report: await reports.dailyReportFor(order, kind, day) });
  } catch (err) {
    failed(res, what, err);
  }
}

router.get("/:id/reports/cutting/:day", verifyCustomerToken, (req, res) =>
  daily(req, res, "cutting", "cutting report"),
);

router.get("/:id/reports/production/:day", verifyCustomerToken, (req, res) =>
  daily(req, res, "production", "production report"),
);

router.get("/:id/reports/inspection", verifyCustomerToken, async (req, res) => {
  try {
    const order = await ownOrder(req, res);
    if (!order) return;
    res.json({ success: true, report: await reports.inspectionReportFor(order) });
  } catch (err) {
    failed(res, "inspection report", err);
  }
});

router.get("/:id/reports/closing", verifyCustomerToken, async (req, res) => {
  try {
    const order = await ownOrder(req, res);
    if (!order) return;
    res.json({ success: true, report: await reports.closingReportFor(order) });
  } catch (err) {
    failed(res, "closing report", err);
  }
});

module.exports = router;
