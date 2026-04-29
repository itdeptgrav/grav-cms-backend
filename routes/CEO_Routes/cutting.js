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
    req.ceoUser = d;
    next();
  } catch { return res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

// GET /api/ceo/cutting/history?from=YYYY-MM-DD&to=YYYY-MM-DD&q=
router.get("/history", ceoAuth, async (req, res) => {
  try {
    const Measurement = require("../../models/Customer_Models/Measurement");
    const { from, to, q } = req.query;

    const fromDate = from ? new Date(from + "T00:00:00.000Z") : null;
    const toDate = to ? new Date(to + "T23:59:59.999Z") : null;

    // Load all measurements, populate productId to get images directly
    const measurements = await Measurement.find({})
      .populate("employeeMeasurements.products.productId", "name images genderCategory category")
      .lean();

    // Build image cache: productName (lowercase) → image URL
    // We do this from the populated data — guaranteed correct match
    const imageCache = new Map();
    const genderCache = new Map();
    for (const meas of measurements) {
      for (const emp of meas.employeeMeasurements || []) {
        for (const prod of emp.products || []) {
          const si = prod.productId; // populated StockItem
          if (si && typeof si === "object") {
            const img = si.images?.[0] || null;
            const key = (prod.productName || "").toLowerCase().trim();
            if (img && !imageCache.has(key)) {
              imageCache.set(key, img);
              genderCache.set(key, si.genderCategory || null);
            }
          }
        }
      }
    }

    // Now build the cutting history groups (same logic as cutting-master)
    const groups = new Map();
    let totalEmployees = 0, totalPieces = 0;
    const productNamesAll = new Set();

    for (const meas of measurements) {
      const orgName = meas.organizationName || "Unknown";

      for (const emp of meas.employeeMeasurements || []) {
        if (q) {
          const qq = q.toLowerCase();
          if (!(emp.employeeName || "").toLowerCase().includes(qq) && !String(emp.employeeUIN || "").includes(qq)) continue;
        }

        // Filter products by qrGenerated + date range
        const products = (emp.products || []).filter(p => {
          if (!p.qrGenerated && !p.qrGeneratedAt) return false;
          const d = p.qrGeneratedAt ? new Date(p.qrGeneratedAt) : null;
          if (fromDate && d && d < fromDate) return false;
          if (toDate && d && d > toDate) return false;
          return true;
        });

        if (!products.length) continue;

        if (!groups.has(orgName)) groups.set(orgName, { organizationName: orgName, employees: [] });

        const empEntry = {
          employeeName: emp.employeeName || "—",
          employeeUIN: emp.employeeUIN || "—",
          gender: emp.gender || "—",
          department: emp.department || emp._department || "",
          designation: emp.designation || emp._designation || "",
          products: products.map(p => {
            const si = p.productId && typeof p.productId === "object" ? p.productId : null;
            const key = (p.productName || "").toLowerCase().trim();
            // Get image: first from populated productId, then from cache
            const img = si?.images?.[0] || imageCache.get(key) || null;
            const gender = si?.genderCategory || genderCache.get(key) || null;
            productNamesAll.add(p.productName || "");
            totalPieces += p.quantity || 0;
            return {
              productName: p.productName || "—",
              quantity: p.quantity || 0,
              qrGeneratedAt: p.qrGeneratedAt || null,
              productImage: img,
              genderCategory: gender,
            };
          }),
        };

        groups.get(orgName).employees.push(empEntry);
        totalEmployees++;
      }
    }

    const groupsArr = Array.from(groups.values())
      .sort((a, b) => b.employees.length - a.employees.length);

    res.json({
      success: true,
      stats: {
        totalEmployees,
        totalPieces,
        totalProducts: productNamesAll.size,
        totalOrganizations: groupsArr.length,
      },
      groups: groupsArr,
    });
  } catch (err) {
    console.error("[CEO Cutting] /history:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

module.exports = router;