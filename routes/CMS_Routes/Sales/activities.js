// routes/CMS_Routes/Sales/activities.js  →  /api/cms/crm/activities
//
// The ACCOUNT-scoped interaction timeline: notes, calls, email logs, meetings,
// site visits, tasks, follow-ups. Newest-first, filterable by type/status/
// contact/date. Tasks (forward-looking) require a due date + owner; logged
// interactions default to completed. "Overdue" is computed here (status=planned
// + dueDate in the past), never stored.
//
// FIELD WHITELIST (Lead Chunk 1 review — Activity ownership hardening).
// POST/PATCH now pick from an explicit field list rather than spreading
// req.body directly. Two things that spread previously allowed, silently:
//   • A client could inject `leadId` into what is meant to be an
//     Account-owned Activity — this router creates/edits Account activities
//     only, so `leadId` is not in either whitelist, ever. (The pre-Account
//     Lead timeline lives at POST/GET /api/cms/crm/leads/:id/activities.)
//   • A client could overwrite `activityId`, `isActive`, `archivedAt`,
//     `archivedBy`, or (on update) `accountId` itself. All are server-
//     controlled/immutable-after-create now.
const express = require("express");
const router = express.Router();
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { ACTIVITY_TASK_TYPES } = require("../../../constants/crm");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

// `accountId` is create-only — an Activity's owning Account cannot be
// reassigned via a generic update, and `leadId` is never in either list, so
// this Account-scoped router can never create or edit a Lead-owned Activity.
const ACCOUNT_ACTIVITY_CREATE_FIELDS = [
  "accountId", "journeyRef", "stage", "contactId", "activityType", "subject", "description",
  "activityDate", "dueDate", "status", "priority", "outcome",
  "nextActionDate", "visibility", "links", "ownerId", "ownerName",
];
const ACCOUNT_ACTIVITY_UPDATE_FIELDS = [
  "contactId", "activityType", "subject", "description",
  "activityDate", "dueDate", "status", "priority", "outcome",
  "nextActionDate", "visibility", "links", "ownerId", "ownerName",
];

function pickFields(body = {}, allowed) {
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

// GET /api/cms/crm/activities?accountId=&type=&status=&contactId=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, journeyRef, type, status, contactId, from, to, page = 1, limit = 50 } = req.query;
    const filter = { isActive: true };
    if (accountId) filter.accountId = accountId;
    if (journeyRef) filter.journeyRef = journeyRef;
    if (type && type !== "all") filter.activityType = type;
    if (status && status !== "all") filter.status = status;
    if (contactId) filter.contactId = contactId;
    if (from || to) {
      filter.activityDate = {};
      if (from) filter.activityDate.$gte = new Date(from);
      if (to) filter.activityDate.$lte = new Date(to);
    }
    const total = await Activity.countDocuments(filter);
    const rows = await Activity.find(filter)
      .sort({ activityDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("contactId", "firstName lastName")
      .lean();
    const now = Date.now();
    const activities = rows.map((a) => ({
      ...a,
      isOverdue: a.status === "planned" && a.dueDate && new Date(a.dueDate).getTime() < now,
    }));
    res.json({
      success: true,
      activities,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/activities/tasks/upcoming?ownerId=&accountId=
router.get("/tasks/upcoming", salesAuth, async (req, res) => {
  try {
    const { ownerId, accountId, days = 14 } = req.query;
    const now = new Date();
    const until = new Date(now.getTime() + Number(days) * 24 * 60 * 60 * 1000);
    const filter = { isActive: true, status: "planned", dueDate: { $gte: now, $lte: until } };
    if (ownerId) filter.ownerId = ownerId;
    if (accountId) filter.accountId = accountId;
    const tasks = await Activity.find(filter).sort({ dueDate: 1 }).populate("accountId", "companyName accountId").lean();
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/activities/tasks/overdue?ownerId=&accountId=
router.get("/tasks/overdue", salesAuth, async (req, res) => {
  try {
    const { ownerId, accountId } = req.query;
    const filter = { isActive: true, status: "planned", dueDate: { $lt: new Date() } };
    if (ownerId) filter.ownerId = ownerId;
    if (accountId) filter.accountId = accountId;
    const tasks = await Activity.find(filter).sort({ dueDate: 1 }).populate("accountId", "companyName accountId").lean();
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/activities
router.post("/", salesAuth, async (req, res) => {
  try {
    const { accountId, activityType, subject } = req.body || {};
    if (!accountId || !activityType || !subject) {
      return res.status(400).json({ success: false, message: "accountId, activityType and subject are required." });
    }
    const isTask = ACTIVITY_TASK_TYPES.has(activityType);
    const data = {
      ...pickFields(req.body, ACCOUNT_ACTIVITY_CREATE_FIELDS),
      createdBy: actor(req),
      updatedBy: actor(req),
      ownerId: req.body.ownerId || req.user?.id,
      ownerName: req.body.ownerName || req.user?.name,
    };
    // Forward-looking tasks require a due date + owner; logged interactions are
    // completed by default.
    if (isTask) {
      if (!data.dueDate) return res.status(400).json({ success: false, message: "A task or follow-up needs a due date." });
      if (!data.ownerId) return res.status(400).json({ success: false, message: "A task or follow-up needs an owner." });
      data.status = data.status || "planned";
    } else {
      data.status = data.status || "completed";
      if (data.status === "completed" && !data.completedAt) {
        data.completedAt = new Date();
        data.completedBy = actor(req);
      }
    }

    const activity = await Activity.create(data);
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "create",
      summary: `${activity.activityType}: ${activity.subject}`,
      after: activity.toObject(),
    });
    res.status(201).json({ success: true, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/activities/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Activity.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Activity not found" });
    const activity = await Activity.findByIdAndUpdate(
      req.params.id,
      { ...pickFields(req.body, ACCOUNT_ACTIVITY_UPDATE_FIELDS), updatedBy: actor(req) },
      { new: true, runValidators: true },
    );
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "update",
      before,
      after: activity.toObject(),
    });
    res.json({ success: true, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/activities/:id/complete — records completion metadata.
router.post("/:id/complete", salesAuth, async (req, res) => {
  try {
    const activity = await Activity.findByIdAndUpdate(
      req.params.id,
      {
        status: "completed",
        completedAt: new Date(),
        completedBy: actor(req),
        outcome: req.body?.outcome,
        nextActionDate: req.body?.nextActionDate,
        updatedBy: actor(req),
      },
      { new: true },
    );
    if (!activity) return res.status(404).json({ success: false, message: "Activity not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "update",
      summary: `Completed: ${activity.subject}`,
    });
    res.json({ success: true, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/activities/:id/cancel
router.post("/:id/cancel", salesAuth, async (req, res) => {
  try {
    const activity = await Activity.findByIdAndUpdate(
      req.params.id,
      { status: "cancelled", updatedBy: actor(req) },
      { new: true },
    );
    if (!activity) return res.status(404).json({ success: false, message: "Activity not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "update",
      summary: `Cancelled: ${activity.subject}`,
    });
    res.json({ success: true, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
