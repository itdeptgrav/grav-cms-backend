// routes/CMS_Routes/Sales/callSchedule.js
//
// POST /:id/complete's Lead-facing behaviour was revised for Lead Chunk 1
// compatibility (review): a completed call against a Lead now always logs
// through the shared CRMActivity model (leadId-owned) instead of appending
// to the embedded `lead.activities[]` — existing embedded entries from
// before this chunk remain fully readable, nothing migrates or deletes them.
// ── COMPLETING A CALL NO LONGER MOVES A LEAD ────────────────────────────────
//
// `newLeadStage` used to be routed through services/leadQualification.js and
// could take a Lead to `qualified`, `disqualified` or another lifecycle state
// as a side effect of ticking off a phone call.
//
// The Lead lifecycle is Interest Confirmed → Requirement Captured → Ready
// for Enquiry, and every one of those steps is decided by requirement
// evidence. A call is not requirement evidence; it is a record that a
// conversation happened. Two ways to write one field is how the two disagree,
// and a stage that moved because somebody closed a call reminder is a stage
// nobody can explain afterwards.
//
// So the field is accepted and refused rather than rejected: an older client
// that still sends it gets its call completed, its Activity written and its
// follow-up saved, plus `leadUpdate.applied === false` and a message naming
// where stages actually move. Nothing is written to the Lead's
// `qualificationState` or legacy `stage`, and the refused value is never
// recorded on the CallSchedule as though it had taken effect.
//
// PATCH /leads/:id/qualification-state is the ordinary writer. The legacy
// PATCH /leads/:id/stage wrapper still exists and still routes through the
// same shared service.
const express = require("express");
const { scopedFilter: scoped } = require("../../../services/companyContext/salesScope.service");
const router = express.Router();
const CallSchedule = require("../../../models/CMS_Models/Sales/CallSchedule");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
/* `applyLegacyStageChange` and LEGACY_LEAD_STAGE_TO_QUALIFICATION are no longer
   imported: this route does not move Leads. Removed rather than left in place,
   because an import that looks like a live capability is how the capability
   gets used again. */

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });

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
        const lead = await Lead.findOne(await scoped(req, { _id: data.entityId }))
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
        const contact = await Contact.findOne(await scoped(req, { _id: data.entityId }))
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
// Mark a call as completed, record outcome, and optionally move the Lead's
// qualification state. See the file header for the Lead Chunk 1 compatibility
// notes — this no longer writes to the embedded lead.activities[], and no
// longer assigns proposal/negotiation/won or fakes a conversion.
router.post("/:id/complete", salesAuth, async (req, res) => {
  try {
    const {
      outcome,
      feedbackNotes,
      callDurationActual,
      newLeadStage,
      nextFollowUpAt,
      reason,
    } = req.body;

    const schedule = await CallSchedule.findById(req.params.id);
    if (!schedule)
      return res.status(404).json({ success: false, message: "Schedule not found" });

    schedule.status             = "completed";
    schedule.outcome            = outcome;
    schedule.feedbackNotes      = feedbackNotes;
    schedule.callDurationActual = callDurationActual;
    schedule.nextFollowUpAt     = nextFollowUpAt;
    // `newLeadStage` is never persisted on the schedule. It used to be
    // written here once the Lead transition succeeded; no transition happens
    // any more, so recording it would say a stage moved when none did.
    await schedule.save();

    let leadUpdate = null;

    if (schedule.entityType === "lead" && schedule.entityId) {
      const lead = await Lead.findOne(await scoped(req, { _id: schedule.entityId }));
      if (lead) {
        // Captured before ANY field below is touched — lastContactedAt,
        // nextFollowUpAt and the qualification transition are all mutated
        // on this same in-memory document, so a `before` taken after any of
        // them would already reflect the change it's supposed to be "before".
        const before = lead.toObject();

        // Every completed call becomes a shared CRMActivity, owned by the
        // Lead — never a new lead.activities[] entry. Existing embedded
        // entries from before this chunk are untouched and remain readable.
        const callActivity = await Activity.create({
          leadId: lead._id,
          activityType: "call",
          subject: `Call completed — ${outcome || "completed"}`,
          description: feedbackNotes || "",
          status: "completed",
          completedAt: new Date(),
          outcome,
          ownerId: req.user?.id,
          ownerName: req.user?.name || "Sales",
          createdBy: actor(req),
          updatedBy: actor(req),
        });
        await recordChange(req, {
          departmentSlug: "sales",
          entity: "crm-activity",
          entityId: callActivity._id,
          entityLabel: callActivity.subject,
          action: "create",
          summary: `Call logged for Lead ${lead.leadId}`,
          after: callActivity.toObject(),
        });

        lead.lastContactedAt = new Date();
        if (nextFollowUpAt) lead.nextFollowUpAt = new Date(nextFollowUpAt);

        /* Accepted, then refused — see the file header. An old client keeps
           working; the Lead does not move. `stage` and `qualificationState`
           are echoed back UNCHANGED so a caller can see for itself that
           nothing shifted. */
        if (newLeadStage) {
          leadUpdate = {
            applied: false,
            stage: lead.stage,
            qualificationState: lead.qualificationState,
            message: "Completing a call no longer changes a Lead's stage. Lead stages move through the requirement workflow — Interest Confirmed → Requirement Captured → Enquiry Ready — on the Lead itself.",
          };
        }

        // Exactly one save, for the two things a completed call really does
        // know: that contact happened just now, and when the next one is due.
        await lead.save();

        // One Lead audit call, always — lastContactedAt changed unconditionally
        // in this branch, so there is always something to record.
        await recordChange(req, {
          departmentSlug: "sales",
          entity: "lead",
          entityId: lead._id,
          entityLabel: `${lead.firstName} ${lead.lastName || ""}`.trim(),
          action: "update",
          summary: "Updated via call completion",
          before,
          after: lead.toObject(),
        });
      }
    }

    // ── Update contact lastContactedAt ─────────────────────────────────────
    if (schedule.entityType === "contact" && schedule.entityId) {
      await Contact.findOneAndUpdate(await scoped(req, { _id: schedule.entityId }), {
        lastContactedAt: new Date(),
        ...(nextFollowUpAt ? { nextFollowUpAt: new Date(nextFollowUpAt) } : {}),
      });
    }

    res.json({ success: true, schedule, leadUpdate });
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