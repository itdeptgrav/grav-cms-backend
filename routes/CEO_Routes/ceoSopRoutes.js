// routes/CEO_routes/ceoSopRoutes.js
// CEO sees only HR-department SOPs and can approve/reject them

const express   = require("express");
const router    = express.Router();
const jwt       = require("jsonwebtoken");
const Sop       = require("../../models/sopmodel/sop_model");
const SopFolder = require("../../models/sopmodel/sop_folder_model");

// ── Auth ──────────────────────────────────────────────────────────────────────
function ceoAuth(req, res, next) {
    try {
        const token = req.cookies.auth_token;
        if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
        if (!["ceo", "admin", "hr_manager"].includes(decoded.role)) {
            return res.status(403).json({ success: false, message: "CEO access required" });
        }
        req.ceoUser = decoded;
        next();
    } catch {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
}

const HR_DEPT = "hr";

// ─────────────────────────────────────────────────────────────────────────────
// FOLDER ROUTES (read-only for CEO)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ceo/sop/folders — view HR folders
router.get("/folders", ceoAuth, async (req, res) => {
    try {
        const folders = await SopFolder.find({ department: HR_DEPT }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, folders });
    } catch (e) {
        console.error("[ceo/sop/folders/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ceo/sop — view all HR SOPs
router.get("/", ceoAuth, async (req, res) => {
    try {
        const { status } = req.query; // optional filter: pending | approved | rejected
        const filter = { department: HR_DEPT };
        if (status) filter.status = status;

        const sops = await Sop.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ success: true, sops });
    } catch (e) {
        console.error("[ceo/sop/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ceo/sop/stats — quick counts for dashboard
router.get("/stats", ceoAuth, async (req, res) => {
    try {
        const [total, pending, approved, rejected] = await Promise.all([
            Sop.countDocuments({ department: HR_DEPT }),
            Sop.countDocuments({ department: HR_DEPT, status: "pending" }),
            Sop.countDocuments({ department: HR_DEPT, status: "approved" }),
            Sop.countDocuments({ department: HR_DEPT, status: "rejected" }),
        ]);
        res.json({ success: true, stats: { total, pending, approved, rejected } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /api/ceo/sop/:id/approve
router.patch("/:id/approve", ceoAuth, async (req, res) => {
    try {
        const sop = await Sop.findById(req.params.id);
        if (!sop || sop.department !== HR_DEPT)
            return res.status(404).json({ error: "SOP not found." });
        if (sop.status === "approved")
            return res.status(400).json({ error: "SOP is already approved." });

        sop.status         = "approved";
        sop.approvedBy     = req.ceoUser.employeeId || req.ceoUser.id || "";
        sop.approvedByName = req.ceoUser.name || "CEO";
        sop.approvedAt     = new Date();
        await sop.save();

        res.json({ success: true, sop });
    } catch (e) {
        console.error("[ceo/sop/approve]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /api/ceo/sop/:id/reject
router.patch("/:id/reject", ceoAuth, async (req, res) => {
    try {
        const sop = await Sop.findById(req.params.id);
        if (!sop || sop.department !== HR_DEPT)
            return res.status(404).json({ error: "SOP not found." });

        sop.status     = "rejected";
        sop.approvedBy = null;
        sop.approvedByName = null;
        sop.approvedAt = null;
        await sop.save();

        res.json({ success: true, sop });
    } catch (e) {
        console.error("[ceo/sop/reject]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;


// Excellent, now let's introduce that sop bleach in the   