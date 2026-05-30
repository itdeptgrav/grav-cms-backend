// routes/CMS_Routes/Sales/callSchedule.js
const express = require("express");
const router = express.Router();
const CallSchedule = require("../../../models/CMS_Models/Sales/CallSchedule");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Build IST date range for a calendar query (from query params)
// `date`  → single day  (YYYY-MM-DD)
// `start` + `end` → arbitrary range
function buildDateRange(query) {
  if (query.start && query.end) {
    return { $gte: new Date(query.start), $lte: new Date(query.end) };
  }
  if (query.date) {
    // Full IST day: midnight → 23:59:59 IST = UTC-5:30 offset
    const d = new Date(query.date);
    const start = new Date(d);
    start.setUTCHours(0 - 5, 60 - 30, 0, 0); // 18:30 UTC prev day = IST midnight
    const end = new Date(d);
    end.setUTCHours(18, 29, 59, 999);          // 23:59:59 IST
    return { $gte: start, $lte: end };
  }
  return null;
}

// ─── GET /api/cms/crm/call-schedules ──────────────────────────────────────────
// Supports: date, start, end, status, assignedTo, entityType, month (YYYY-MM)
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      date,
      start,
      end,
      month,
      status,
      entityType,
      assignedTo,
      page = 1,
      limit = 100,
    } = req.query;

    const filter = { isActive: true };

    // Date filtering
    if (month) {
      // month = "2025-06" → first/last day
      const [yr, mo] = month.split("-").map(Number);
      const from = new Date(yr, mo - 1, 1);
      const to = new Date(yr, mo, 0, 23, 59, 59, 999);
      filter.scheduledAt = { $gte: from, $lte: to };
    } else {
      const range = buildDateRange({ date, start, end });
      if (range) filter.scheduledAt = range;
    }

    if (status && status !== "all") filter.status = status;
    if (entityType && entityType !== "all") filter.entityType = entityType;
    if (assignedTo) filter.assignedTo = assignedTo;

    const total = await CallSchedule.countDocuments(filter);
    const schedules = await CallSchedule.find(filter)
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // Stats
    const stats = {
      total: await CallSchedule.countDocuments({ isActive: true }),
      scheduled: await CallSchedule.countDocuments({ isActive: true, status: "scheduled" }),
      completed: await CallSchedule.countDocuments({ isActive: true, status: "completed" }),
      missed:    await CallSchedule.countDocuments({ isActive: true, status: "missed" }),
      today: await CallSchedule.countDocuments({
        isActive: true,
        scheduledAt: buildDateRange({ date: new Date().toISOString().split("T")[0] }) || {},
      }),
    };

    res.json({ success: true, schedules, stats, total });
  } catch (err) {
    console.error("[call-schedules] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/crm/call-schedules ─────────────────────────────────────────
// Creates a call schedule. Accepts entityType + entityId; auto-fetches display fields.
router.post("/", salesAuth, async (req, res) => {
  try {
    const data = { ...req.body };

    // Auto-fill assignedTo
    if (req.user) {
      data.assignedTo = data.assignedTo || req.user.id;
      data.assignedToName = data.assignedToName || req.user.name;
    }

    // Auto-populate denormalized entity fields if not provided
    if (!data.entityName && data.entityId && data.entityType) {
      if (data.entityType === "lead") {
        const lead = await Lead.findById(data.entityId)
          .select("firstName lastName company phone email stage")
          .lean();
        if (lead) {
          data.entityName    = `${lead.firstName} ${lead.lastName || ""}`.trim();
          data.entityCompany = lead.company;
          data.entityPhone   = lead.phone;
          data.entityEmail   = lead.email;
          data.entityStage   = lead.stage;
          data.entityModel   = "Lead";
        }
      } else if (data.entityType === "contact") {
        const contact = await Contact.findById(data.entityId)
          .select("firstName lastName company phone email")
          .lean();
        if (contact) {
          data.entityName    = `${contact.firstName} ${contact.lastName || ""}`.trim();
          data.entityCompany = contact.company;
          data.entityPhone   = contact.phone;
          data.entityEmail   = contact.email;
          data.entityModel   = "CRMContact";
        }
      }
    }

    const schedule = await CallSchedule.create(data);
    res.status(201).json({ success: true, schedule });
  } catch (err) {
    console.error("[call-schedules] POST /", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── GET /api/cms/crm/call-schedules/:id ──────────────────────────────────────
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const schedule = await CallSchedule.findById(req.params.id).lean();
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/crm/call-schedules/:id ────────────────────────────────────
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const schedule = await CallSchedule.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/crm/call-schedules/:id/complete ────────────────────────────
// Mark a call as completed, record outcome, and optionally update lead stage.
router.post("/:id/complete", salesAuth, async (req, res) => {
  try {
    const {
      outcome,
      feedbackNotes,
      callDurationActual,
      newLeadStage,
      nextFollowUpAt,
    } = req.body;

    const schedule = await CallSchedule.findById(req.params.id);
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });

    schedule.status             = "completed";
    schedule.outcome            = outcome;
    schedule.feedbackNotes      = feedbackNotes;
    schedule.callDurationActual = callDurationActual;
    schedule.nextFollowUpAt     = nextFollowUpAt;

    if (newLeadStage) schedule.newLeadStage = newLeadStage;

    await schedule.save();

    // ── Update lead stage if requested ────────────────────────────────────
    if (newLeadStage && schedule.entityType === "lead" && schedule.entityId) {
      const lead = await Lead.findById(schedule.entityId);
      if (lead) {
        const prevStage = lead.stage;
        lead.stage = newLeadStage;
        if (newLeadStage === "won") {
          lead.probability = 100;
          lead.convertedToCustomer = true;
          lead.convertedAt = new Date();
        }
        lead.lastContactedAt = new Date();
        if (nextFollowUpAt) lead.nextFollowUpAt = new Date(nextFollowUpAt);

        lead.activities.push({
          type:            "call",
          title:           `Call completed — ${outcome || "completed"}`,
          description:     feedbackNotes || "",
          performedByName: req.user?.name || "Sales",
          performedBy:     req.user?.id,
          completedAt:     new Date(),
          outcome:         outcome,
        });

        if (newLeadStage !== prevStage) {
          lead.activities.push({
            type:            "status_change",
            title:           `Stage: ${prevStage} → ${newLeadStage}`,
            performedByName: req.user?.name || "Sales",
            performedBy:     req.user?.id,
            completedAt:     new Date(),
          });
        }

        await lead.save();
      }
    }

    // ── Update contact lastContactedAt ─────────────────────────────────────
    if (schedule.entityType === "contact" && schedule.entityId) {
      await Contact.findByIdAndUpdate(schedule.entityId, {
        lastContactedAt: new Date(),
        ...(nextFollowUpAt ? { nextFollowUpAt: new Date(nextFollowUpAt) } : {}),
      });
    }

    res.json({ success: true, schedule });
  } catch (err) {
    console.error("[call-schedules] POST /:id/complete", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/crm/call-schedules/:id/missed ──────────────────────────────
router.post("/:id/missed", salesAuth, async (req, res) => {
  try {
    const { feedbackNotes, nextFollowUpAt } = req.body;
    const schedule = await CallSchedule.findByIdAndUpdate(
      req.params.id,
      {
        status: "missed",
        feedbackNotes,
        ...(nextFollowUpAt ? { nextFollowUpAt: new Date(nextFollowUpAt) } : {}),
      },
      { new: true }
    );
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── POST /api/cms/crm/call-schedules/:id/reschedule ──────────────────────────
router.post("/:id/reschedule", salesAuth, async (req, res) => {
  try {
    const { newDateTime, reason } = req.body;
    if (!newDateTime)
      return res.status(400).json({ success: false, message: "newDateTime required" });

    const schedule = await CallSchedule.findById(req.params.id);
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });

    schedule.status             = "rescheduled";
    schedule.rescheduledTo      = new Date(newDateTime);
    schedule.rescheduledReason  = reason;
    schedule.rescheduledCount   = (schedule.rescheduledCount || 0) + 1;
    await schedule.save();

    // Create a new schedule for the new time
    const newSchedule = await CallSchedule.create({
      entityType:    schedule.entityType,
      entityId:      schedule.entityId,
      entityModel:   schedule.entityModel,
      entityName:    schedule.entityName,
      entityCompany: schedule.entityCompany,
      entityPhone:   schedule.entityPhone,
      entityEmail:   schedule.entityEmail,
      entityStage:   schedule.entityStage,
      scheduledAt:   new Date(newDateTime),
      durationMinutes: schedule.durationMinutes,
      callType:      schedule.callType,
      purpose:       `[Rescheduled] ${schedule.purpose || ""}`.trim(),
      priority:      schedule.priority,
      assignedTo:    schedule.assignedTo,
      assignedToName: schedule.assignedToName,
    });

    res.json({ success: true, schedule, newSchedule });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/cms/crm/call-schedules/:id ───────────────────────────────────
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    await CallSchedule.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true, message: "Schedule cancelled" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;