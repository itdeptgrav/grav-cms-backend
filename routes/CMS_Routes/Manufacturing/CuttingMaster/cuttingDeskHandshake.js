/**
 * CUTTING DESK HANDSHAKE - the shared key instead of a login.
 *
 * No person logs in on a cutting desk. The desk is set up once with the
 * server address and CUTTING_DESK_KEY (backend .env); this route turns the
 * key into a long-lived cutting-master token that every cutting-master route
 * accepts as a Bearer header (EmployeeAuthMiddleware verifies it like a login
 * token). Mounted at /api/cutting-desk, ABOVE the /api/cms auth gate.
 */
const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const router = express.Router();

router.post("/handshake", express.json(), (req, res) => {
  const expected = process.env.CUTTING_DESK_KEY || "";
  const given = String(req.body?.key || "");
  if (!expected) return res.status(503).json({ success: false, message: "CUTTING_DESK_KEY is not set on the server" });
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).json({ success: false, message: "Wrong secret key" });
  }
  const device = String(req.body?.deviceId || "").replace(/[^\w-]/g, "").slice(0, 24);
  const token = jwt.sign(
    { id: "cutting-desk", role: "employee", employeeId: "cutting-desk", name: `Cutting desk ${device}`.trim(), deptSlug: "cutting-master", desk: true },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "365d" },
  );
  res.json({ success: true, token });
});

module.exports = router;
