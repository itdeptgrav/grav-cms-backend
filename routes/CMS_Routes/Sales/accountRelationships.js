// routes/CMS_Routes/Sales/accountRelationships.js  →  /api/cms/crm/account-relationships
//
// Typed edges between two accounts (buying-house ↔ brand ↔ billing party ↔
// agent …). Listing by account returns each edge from THAT account's
// perspective, with the correct forward-or-inverse label. Self-links and exact
// active duplicates are rejected (schema + DB partial-unique index).
const express = require("express");
const router = express.Router();
const Relationship = require("../../../models/CMS_Models/Sales/AccountRelationship");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { relationshipLabelFrom } = require("../../../constants/crm");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const dupMessage = (err) => (err?.code === 11000 ? "That relationship already exists between these accounts." : err.message);

// GET /api/cms/crm/account-relationships?accountId=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, includeEnded } = req.query;
    if (!accountId) return res.status(400).json({ success: false, message: "accountId is required." });
    const filter = { $or: [{ fromAccountId: accountId }, { toAccountId: accountId }] };
    if (includeEnded !== "true") filter.isActive = true;
    const rows = await Relationship.find(filter)
      .populate("fromAccountId", "accountId companyName")
      .populate("toAccountId", "accountId companyName")
      .sort({ createdAt: -1 })
      .lean();
    const relationships = rows.map((r) => {
      const persp = relationshipLabelFrom(r, accountId);
      return {
        _id: r._id,
        relationshipId: r.relationshipId,
        relationshipType: r.relationshipType,
        label: persp.label,
        direction: persp.direction,
        otherAccount: persp.otherAccountId,
        isPrimary: r.isPrimary,
        startDate: r.startDate,
        endDate: r.endDate,
        notes: r.notes,
      };
    });
    res.json({ success: true, relationships });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/account-relationships
router.post("/", salesAuth, async (req, res) => {
  try {
    const { fromAccountId, toAccountId, relationshipType } = req.body || {};
    if (!fromAccountId || !toAccountId || !relationshipType) {
      return res.status(400).json({ success: false, message: "fromAccountId, toAccountId and relationshipType are required." });
    }
    const rel = await Relationship.create({ ...req.body, createdBy: actor(req), updatedBy: actor(req) });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-relationship",
      entityId: rel._id,
      entityLabel: rel.relationshipType,
      action: "create",
      summary: `Linked accounts (${rel.relationshipType})`,
      after: rel.toObject(),
    });
    res.status(201).json({ success: true, relationship: rel });
  } catch (err) {
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// PATCH /api/cms/crm/account-relationships/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Relationship.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Relationship not found" });
    const rel = await Relationship.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: actor(req) },
      { new: true, runValidators: true },
    );
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-relationship",
      entityId: rel._id,
      entityLabel: rel.relationshipType,
      action: "update",
      before,
      after: rel.toObject(),
    });
    res.json({ success: true, relationship: rel });
  } catch (err) {
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// DELETE /api/cms/crm/account-relationships/:id — end it (kept in history)
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const rel = await Relationship.findByIdAndUpdate(
      req.params.id,
      { isActive: false, endDate: req.body?.endDate || new Date(), updatedBy: actor(req) },
      { new: true },
    );
    if (!rel) return res.status(404).json({ success: false, message: "Relationship not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-relationship",
      entityId: rel._id,
      entityLabel: rel.relationshipType,
      action: "update",
      summary: `Ended relationship (${rel.relationshipType})`,
    });
    res.json({ success: true, message: "Relationship ended" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
