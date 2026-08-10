// routes/CMS_Routes/Sales/departments.js  →  /api/cms/crm/departments
//
// Business units within an account/site (Procurement, HR/Admin, Housekeeping…).
// Later modules attach uniform entitlements, budgets, and deliveries to these.
const express = require("express");
const router = express.Router();
const Department = require("../../../models/CMS_Models/Sales/Department");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// GET /api/cms/crm/departments?accountId=&siteId=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, siteId, search, includeArchived } = req.query;
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (siteId) filter.siteId = siteId;
    if (includeArchived !== "true") filter.isActive = true;
    if (search) filter.$or = [{ name: new RegExp(search, "i") }, { code: new RegExp(search, "i") }];
    const departments = await Department.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, departments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/departments
router.post("/", salesAuth, async (req, res) => {
  try {
    if (!req.body.accountId) return res.status(400).json({ success: false, message: "accountId is required." });
    const dept = await Department.create({ ...req.body, createdBy: actor(req), updatedBy: actor(req) });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-department",
      entityId: dept._id,
      entityLabel: dept.name,
      action: "create",
      summary: `Added department "${dept.name}"`,
      after: dept.toObject(),
    });
    res.status(201).json({ success: true, department: dept });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/departments/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Department.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Department not found" });
    const dept = await Department.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: actor(req) },
      { new: true, runValidators: true },
    );
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-department",
      entityId: dept._id,
      entityLabel: dept.name,
      action: "update",
      before,
      after: dept.toObject(),
    });
    res.json({ success: true, department: dept });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/departments/:id — soft archive
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const dept = await Department.findByIdAndUpdate(
      req.params.id,
      { isActive: false, status: "archived", archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },
    );
    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-department",
      entityId: dept._id,
      entityLabel: dept.name,
      action: "archive",
      summary: `Archived department "${dept.name}"`,
    });
    res.json({ success: true, message: "Department archived" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
