// routes/Accountant_Routes/Acc_auditNotes.js
//
// Audit notes — viewer/auditor flags issues, team fixes, viewer verifies.
//
// Endpoints:
//
//   GET    /                    — list notes (filter by status, target, etc.)
//   GET    /for/:targetType/:targetId — notes on a specific entity
//   GET    /:id                 — single note with full thread
//   POST   /                    — create a note (any role, but primarily viewer)
//   POST   /:id/comment         — add a comment to the thread (any role)
//   POST   /:id/acknowledge     — editor/admin marks "working on it"
//   POST   /:id/resolve         — editor/admin marks "fixed"
//   POST   /:id/verify          — viewer confirms the fix
//   POST   /:id/reject          — viewer says "not fixed" (with reason)
//   GET    /stats               — counts by status (for badges)
//
// Auth: accountantAuth (all roles can read; write permissions vary by action).
// Org-scoped: every query filters by req.user.organizationId.

const express = require("express");
const router = express.Router();
const AuditNote = require("../../models/Accountant_model/Acc_AuditNote");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

router.use(accountantAuth);

// ── Helpers ──────────────────────────────────────────────────────────────────

function orgId(req) {
  return req.user?.organizationId;
}

function userSnap(req) {
  return {
    userId: req.user?.id,
    userName: req.user?.name || "",
    userRole: req.user?.role || "",
  };
}

// Fire-and-forget push notification (reuses the approval notification service)
async function notifyAuditNote(note, action, actor) {
  try {
    const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
    let messaging = null;
    try {
      const fb = require("../../config/firebaseAdmin");
      messaging = fb.messaging || null;
    } catch (fbErr) {
      console.warn(
        "[audit-notes] Firebase Admin unavailable — push disabled:",
        fbErr.message,
      );
      return;
    }
    if (!messaging) {
      console.warn("[audit-notes] Firebase messaging is null — push disabled");
      return;
    }

    // Decide who to notify based on the action
    // Notify EVERY active user in the org EXCEPT the person who just acted.
    // Viewers need to know when their note is acknowledged/resolved.
    // Editors need to know when a note is created/rejected.
    // Everyone benefits from seeing comments in real time.
    const allUsers = await Acc_User.find({
      organizationId: note.organizationId,
      isActive: true,
    })
      .select("name email fcmTokens")
      .lean();
    const recipients = allUsers.filter(
      (u) => String(u._id) !== String(actor.userId),
    );
    console.log(
      `[audit-notes] ${action} by ${actor.userName} — ${allUsers.length} total users, ${recipients.length} recipients`,
    );
    recipients.forEach((u) => {
      const tkCount = Array.isArray(u.fcmTokens)
        ? u.fcmTokens.filter(Boolean).length
        : 0;
      console.log(
        `[audit-notes]   → ${u.name} (${u.email}): ${tkCount} token(s)`,
      );
    });

    const ACTION_LABELS = {
      created: "New audit note",
      commented: "New comment on audit note",
      acknowledged: "Audit note acknowledged",
      resolved: "Audit note marked resolved",
      verified: "Audit note verified ✓",
      rejected: "Audit note rejected — needs more work",
    };

    const title = ACTION_LABELS[action] || "Audit note updated";
    const body = `${actor.userName}: ${note.title}`;
    const APP_URL = (
      process.env.ACCOUNTANT_APP_URL ||
      process.env.FRONTEND_URL ||
      "https://cms.grav.in"
    ).replace(/\/+$/, "");
    const url = `${APP_URL}/accountant/audit-notes`;

    for (const user of recipients) {
      const tokens = Array.isArray(user.fcmTokens)
        ? user.fcmTokens.filter(Boolean)
        : [];
      if (!tokens.length) continue;
      for (const token of tokens) {
        try {
          await messaging.send({
            token,
            data: {
              title: String(title),
              body: String(body),
              type: "audit_note",
              url: String(url),
              timestamp: String(Date.now()),
            },
            webpush: {
              headers: { Urgency: "high", TTL: "0" },
              fcmOptions: { link: url },
            },
          });
          console.log(`[audit-notes]   ✓ push sent to ${user.name}`);
        } catch (pushErr) {
          console.warn(
            `[audit-notes]   ✗ push failed for ${user.name}:`,
            pushErr.message,
          );
        }
      }
    }
  } catch (e) {
    console.warn("[audit-notes] notification error:", e.message);
  }
}

// ── GET / — list notes ───────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    if (!orgId(req)) return res.status(401).json({ error: "No org context" });

    const {
      status,
      targetType,
      targetId,
      companyId,
      page = 1,
      limit = 50,
    } = req.query;
    const filter = { organizationId: orgId(req) };
    if (status) filter.status = status;
    if (companyId) filter.companyId = companyId;
    if (targetType) filter["target.type"] = targetType;
    if (targetId) filter["target.id"] = targetId;

    const skip = (Number(page) - 1) * Number(limit);
    const [notes, total] = await Promise.all([
      AuditNote.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      AuditNote.countDocuments(filter),
    ]);

    res.json({ notes, total, page: Number(page), limit: Number(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /stats — counts by status ────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    if (!orgId(req)) return res.status(401).json({ error: "No org context" });
    const { companyId } = req.query;
    const match = { organizationId: orgId(req) };
    if (companyId)
      match.companyId = new (require("mongoose").Types.ObjectId)(companyId);

    const agg = await AuditNote.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const stats = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      verified: 0,
      rejected: 0,
      total: 0,
    };
    for (const r of agg) {
      stats[r._id] = r.count;
      stats.total += r.count;
    }
    res.json({ stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /for/:targetType/:targetId — notes on a specific entity ──────────────
router.get("/for/:targetType/:targetId", async (req, res) => {
  try {
    if (!orgId(req)) return res.status(401).json({ error: "No org context" });
    const notes = await AuditNote.find({
      organizationId: orgId(req),
      "target.type": req.params.targetType,
      "target.id": req.params.targetId,
    })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single note ───────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    }).lean();
    if (!note) return res.status(404).json({ error: "Note not found" });
    res.json({ note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create a note ───────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    if (!orgId(req)) return res.status(401).json({ error: "No org context" });
    const { title, body, priority, companyId, target } = req.body || {};
    if (!title || !title.trim())
      return res.status(400).json({ error: "Title is required" });

    const snap = userSnap(req);
    const note = await AuditNote.create({
      organizationId: orgId(req),
      companyId: companyId || undefined,
      target: target || { type: "general" },
      title: title.trim(),
      priority: priority || "medium",
      status: "open",
      createdByUserId: snap.userId,
      createdByName: snap.userName,
      createdByRole: snap.userRole,
      lastActedByName: snap.userName,
      lastActedAt: new Date(),
      thread: [
        {
          action: "created",
          body: body || "",
          ...snap,
        },
      ],
    });

    notifyAuditNote(note, "created", snap);
    res.status(201).json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /:id/comment — add a comment ────────────────────────────────────────
router.post("/:id/comment", async (req, res) => {
  try {
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    const { body } = req.body || {};
    if (!body || !body.trim())
      return res.status(400).json({ error: "Comment body required" });

    const snap = userSnap(req);
    note.thread.push({ action: "commented", body: body.trim(), ...snap });
    note.lastActedByName = snap.userName;
    note.lastActedAt = new Date();
    await note.save();

    notifyAuditNote(note, "commented", snap);
    res.json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /:id/acknowledge — editor/admin marks "working on it" ───────────────
router.post("/:id/acknowledge", async (req, res) => {
  try {
    if (!req.user?.permissions?.canEdit) {
      return res
        .status(403)
        .json({ error: "Only editors and above can acknowledge notes." });
    }
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!["open", "rejected"].includes(note.status)) {
      return res.status(400).json({
        error: `Cannot acknowledge a note in '${note.status}' status.`,
      });
    }

    const snap = userSnap(req);
    note.status = "in_progress";
    note.thread.push({
      action: "acknowledged",
      body: req.body?.body || "",
      ...snap,
    });
    note.lastActedByName = snap.userName;
    note.lastActedAt = new Date();
    await note.save();

    notifyAuditNote(note, "acknowledged", snap);
    res.json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /:id/resolve — editor/admin marks "fixed" ──────────────────────────
router.post("/:id/resolve", async (req, res) => {
  try {
    if (!req.user?.permissions?.canEdit) {
      return res
        .status(403)
        .json({ error: "Only editors and above can resolve notes." });
    }
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!["open", "in_progress", "rejected"].includes(note.status)) {
      return res
        .status(400)
        .json({ error: `Cannot resolve a note in '${note.status}' status.` });
    }

    const snap = userSnap(req);
    note.status = "resolved";
    note.resolvedByName = snap.userName;
    note.resolvedAt = new Date();
    note.thread.push({
      action: "resolved",
      body: req.body?.body || "",
      ...snap,
    });
    note.lastActedByName = snap.userName;
    note.lastActedAt = new Date();
    await note.save();

    notifyAuditNote(note, "resolved", snap);
    res.json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /:id/verify — viewer confirms fix ───────────────────────────────────
router.post("/:id/verify", async (req, res) => {
  try {
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (note.status !== "resolved") {
      return res
        .status(400)
        .json({ error: "Can only verify a resolved note." });
    }

    const snap = userSnap(req);
    note.status = "verified";
    note.verifiedByName = snap.userName;
    note.verifiedAt = new Date();
    note.thread.push({
      action: "verified",
      body: req.body?.body || "",
      ...snap,
    });
    note.lastActedByName = snap.userName;
    note.lastActedAt = new Date();
    await note.save();

    notifyAuditNote(note, "verified", snap);
    res.json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /:id/reject — viewer says "not fixed" ──────────────────────────────
router.post("/:id/reject", async (req, res) => {
  try {
    const note = await AuditNote.findOne({
      _id: req.params.id,
      organizationId: orgId(req),
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (note.status !== "resolved") {
      return res
        .status(400)
        .json({ error: "Can only reject a resolved note." });
    }
    const { body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: "A rejection reason is required." });
    }

    const snap = userSnap(req);
    note.status = "in_progress"; // loops back for another fix
    note.thread.push({ action: "rejected", body: body.trim(), ...snap });
    note.thread.push({
      action: "reopened",
      body: "Auto-reopened after rejection",
      ...snap,
    });
    note.lastActedByName = snap.userName;
    note.lastActedAt = new Date();
    await note.save();

    notifyAuditNote(note, "rejected", snap);
    res.json({ note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
