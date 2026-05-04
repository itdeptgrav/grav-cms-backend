/**
 * routes/CEO_Routes/cutting.js
 * Register: app.use("/api/ceo/cutting", require("./routes/CEO_Routes/cutting"));
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

const proxy = (path) => async (req, res) => {
  try {
    const http = require("http");
    const qs = new URLSearchParams(req.query).toString();
    const port = process.env.PORT || 5000;
    const data = await new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `${path}?${qs}`,
          method: "GET",
          headers: {
            Cookie: req.headers.cookie || "",
            "Content-Type": "application/json",
          },
        },
        (response) => {
          let b = "";
          response.on("data", (c) => (b += c));
          response.on("end", () => {
            try {
              resolve(JSON.parse(b));
            } catch {
              reject(new Error("JSON parse failed"));
            }
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Measurement (person-wise) cutting history
router.get(
  "/history",
  ceoAuth,
  proxy("/api/cms/manufacturing/cutting-master/cutting-history"),
);
// Bulk cutting history
router.get(
  "/history-bulk",
  ceoAuth,
  proxy("/api/cms/manufacturing/cutting-master/cutting-history-bulk"),
);

module.exports = router;
