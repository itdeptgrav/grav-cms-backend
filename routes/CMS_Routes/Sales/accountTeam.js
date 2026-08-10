// routes/CMS_Routes/Sales/accountTeam.js  →  /api/cms/crm/account-team
//
// Internal employees assigned to an account (sales owner, account manager,
// merchandiser, uniform program coordinator, service owner, finance owner,
// executive sponsor). At most one primary per role on an account.
const express = require("express");
const router = express.Router();
const Team = require("../../../models/CMS_Models/Sales/AccountTeam");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { makeSolePrimary } = require("../../../services/crmPrimary");
const SalesDepartment = require("../../../models/SalesDepartment");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// GET /api/cms/crm/account-team/users — internal users the team picker chooses
// from (Sales department employees). Read-only.
router.get("/users", salesAuth, async (req, res) => {
  try {
    const users = await SalesDepartment.find({}).select("name email role").sort({ name: 1 }).lean();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
const dupMessage = (err) => (err?.code === 11000 ? "That user already holds that role on this account." : err.message);

// GET /api/cms/crm/account-team?accountId=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ success: false, message: "accountId is required." });
    const team = await Team.find({ accountId, isActive: true })
      .populate("userId", "name email role")
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean();
    res.json({ success: true, team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/account-team
router.post("/", salesAuth, async (req, res) => {
  try {
    const { accountId, userId, teamRole } = req.body || {};
    if (!accountId || !userId || !teamRole) {
      return res.status(400).json({ success: false, message: "accountId, userId and teamRole are required." });
    }
    const member = await Team.create({ ...req.body, createdBy: actor(req) });
    // One primary per (account, role).
    if (member.isPrimary) {
      await makeSolePrimary(Team, { accountId, teamRole, isActive: true }, member._id);
    }
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-team",
      entityId: member._id,
      entityLabel: `${member.userName || "member"} — ${member.teamRole}`,
      action: "create",
      summary: `Assigned ${member.teamRole}`,
      after: member.toObject(),
    });
    res.status(201).json({ success: true, member });
  } catch (err) {
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// PATCH /api/cms/crm/account-team/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Team.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Team member not found" });
    const member = await Team.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (req.body.isPrimary === true) {
      await makeSolePrimary(Team, { accountId: member.accountId, teamRole: member.teamRole, isActive: true }, member._id);
    }
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-team",
      entityId: member._id,
      entityLabel: `${member.userName || "member"} — ${member.teamRole}`,
      action: "update",
      before,
      after: member.toObject(),
    });
    res.json({ success: true, member });
  } catch (err) {
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// DELETE /api/cms/crm/account-team/:id — end the assignment
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const member = await Team.findByIdAndUpdate(
      req.params.id,
      { isActive: false, endDate: new Date() },
      { new: true },
    );
    if (!member) return res.status(404).json({ success: false, message: "Team member not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account-team",
      entityId: member._id,
      entityLabel: `${member.userName || "member"} — ${member.teamRole}`,
      action: "update",
      summary: `Removed ${member.teamRole}`,
    });
    res.json({ success: true, message: "Team assignment ended" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
