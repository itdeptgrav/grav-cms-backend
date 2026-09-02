// routes/DevOps/developer.js
//
// The developer side's API. Mounted at /api/dev.
//
// WHO GETS IN
// -----------
// Platform admins, and anyone holding a role in the `developer` department —
// which is granted from CEO → Access Control exactly like any other
// department, because `developer` is a row in ensureAccessDepartments'
// DEPARTMENTS. No new permission machinery: the ask was "let me grant myself
// developer access from the CEO side", and the existing grant screen is that.
//
// Viewing needs any role; CHANGING things (settings, alert decisions, running
// a scan) needs editor or better. A developer-side viewer is exactly the CEO
// checking in — able to see everything, able to break nothing.
//
// WHAT LIVES HERE
//   /overview          the one screen: alerts, job health, activity by dept
//   /history...        the cross-department change log — same shapes as the
//                      per-department history routers, department OPTIONAL,
//                      which is the merged view those routers' comments
//                      promised
//   /record/...        one record's full timeline, grouped per field — the
//                      "what actually happened to this employee" question
//                      that used to mean an evening in MongoDB
//   /alerts...         the anomaly feed and its decisions
//   /settings          the live tunables
//   /jobs              heartbeat health
//   /scan              run the anomaly scan now

"use strict";

const express = require("express");
const router = express.Router();

const ChangeLog = require("../../models/Access/ChangeLog");
const DevAlert = require("../../models/DevOps/DevAlert");
const JobHeartbeat = require("../../models/DevOps/JobHeartbeat");
const { listChanges, recordChange, fieldDiff } = require("../../services/changeLog");
const { SECTIONS, fieldLabel } = require("../../services/auditSections");
const { listSettings, setSetting } = require("../../services/devConfig");
const { scanChangeLogs } = require("../../services/anomalyScan");
const { getRole, roleAtLeast } = require("../../services/departmentRoles");
const FormFieldDef = require("../../models/DevOps/FormFieldDef");
const formConfig = require("../../services/formConfig");
const builtInFields = require("../../services/builtInEmployeeFields");
const FormFieldOverride = require("../../models/DevOps/FormFieldOverride");
const jobRegistry = require("../../services/jobRegistry");
const maintenance = require("../../services/maintenanceChecks");
const { authenticateCmsSession } = require("../../services/cmsSession");

router.use(authenticateCmsSession);

/** The caller's standing here. Admins are owners, as everywhere else. */
async function devRole(req) {
  if (req.user?.isAdmin) return "owner";
  return getRole("developer", req.user.email);
}

router.use(async (req, res, next) => {
  try {
    const role = await devRole(req);
    if (!role) {
      return res.status(403).json({
        success: false,
        code: "NOT_DEVELOPER",
        message:
          "You need a role in the Developer module. In CEO → Access Control, " +
          "grant the Developer department chip, then set a role in the " +
          "DEVELOPER dropdown that appears on your row — the chip opens the " +
          "door, the role is what this side checks.",
      });
    }
    req.devRole = role;
    next();
  } catch (err) {
    console.error("[dev] gate:", err.message);
    res.status(500).json({ success: false, message: "Could not check access." });
  }
});

/**
 * Granular permission floors, on top of "any developer role may look".
 *
 *   viewer    every GET — audit, health, analytics, timelines
 *   editor    day-to-day decisions: settings, alert decisions, form fields,
 *             running a scan or a report-style check, test notifications
 *   approver  operations that change how OTHER people's departments behave:
 *             freezing writes, extra CORS origins, disabling a scheduled job,
 *             action-style maintenance
 *
 * Roles come from the existing DepartmentRole system rather than a new
 * permission store — one vocabulary, one grant screen, one audit trail.
 */
function requireRole(min) {
  return function roleFloor(req, res, next) {
    if (!roleAtLeast(req.devRole, min)) {
      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_ROLE",
        message: `This needs the ${min} role in the developer department; yours is ${req.devRole}.`,
      });
    }
    next();
  };
}
const requireEditor = requireRole("editor");
const requireApprover = requireRole("approver");

/** A typed reason, folded into the audit summary of high-impact actions. */
function reasonOf(req) {
  // Body OR query: DELETEs carry no body through the frontend client.
  const r = String(req.body?.reason || req.query?.reason || "").trim().slice(0, 500);
  return r ? ` Reason: ${r}` : "";
}


/* ------------------------------------------------------------------ */
/* Making old rows readable                                            */
/* ------------------------------------------------------------------ */

/** Bookkeeping churn that is never the story of a change. */
const NOISE_PATHS = new Set(["updatedAt", "createdAt", "__v", "modifiedAt", "lastModified"]);

/**
 * Fill in what an entry SHOULD say from what it actually stored.
 *
 * The change log has grown up in stages: the oldest rows carry only raw
 * `before`/`after` patches, no `summary` and no `fields[]` — which the UI
 * rendered as "(no summary)", reading like nothing is known when everything
 * is. Rather than migrating stored data (rewriting an audit log to make it
 * prettier is how audit logs stop being trusted), the gaps are filled at READ
 * time: fields diffed out of before/after, a summary written from the fields.
 * `derived: true` marks a row whose detail was reconstructed, so the UI can
 * be honest about which is which.
 */
function presentEntry(e) {
  let fields = Array.isArray(e.fields) && e.fields.length ? e.fields : null;
  let derived = false;

  if (!fields && (e.before || e.after)) {
    derived = true;
    fields = fieldDiff(e.before || {}, e.after || {})
      .filter((f) => !NOISE_PATHS.has(String(f.path).split(".").pop()))
      .slice(0, 30)
      .map((f) => ({ ...f, label: fieldLabel(e.section || "", f.path) }));
  }

  let summary = e.summary;
  if (!summary) {
    const names = (fields || []).map((f) => f.label || f.path);
    if (names.length) {
      summary =
        `Changed ${names.slice(0, 4).join(", ")}` +
        (names.length > 4 ? ` and ${names.length - 4} more` : "") +
        ".";
    } else if (e.action === "create") summary = `Added ${e.entity}${e.entityLabel ? ` “${e.entityLabel}”` : ""}.`;
    else if (e.action === "delete") summary = `Removed ${e.entity}${e.entityLabel ? ` “${e.entityLabel}”` : ""}.`;
    else if (e.requestMethod && e.requestPath) summary = `${e.requestMethod} ${e.requestPath}`;
    else summary = `${e.action} on ${e.entity}${e.entityLabel ? ` “${e.entityLabel}”` : ""}`;
  }

  return { ...e, fields: fields || [], summary, derived };
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

router.get("/overview", async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 864e5);
    const weekAgo = new Date(Date.now() - 7 * 864e5);

    const [alertsBySeverity, changesByDept, topActors, jobs, recentAlerts, totals] =
      await Promise.all([
        DevAlert.aggregate([
          { $match: { status: { $ne: "resolved" } } },
          { $group: { _id: "$severity", count: { $sum: 1 } } },
        ]),
        ChangeLog.aggregate([
          { $match: { createdAt: { $gte: dayAgo } } },
          { $group: { _id: "$departmentSlug", count: { $sum: 1 }, last: { $max: "$createdAt" } } },
          { $sort: { count: -1 } },
        ]),
        ChangeLog.aggregate([
          { $match: { createdAt: { $gte: dayAgo }, actorEmail: { $nin: ["", null] } } },
          { $group: { _id: "$actorEmail", name: { $last: "$actorName" }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 },
        ]),
        JobHeartbeat.find({}).lean(),
        DevAlert.find({ status: { $ne: "resolved" } })
          .sort({ severity: -1, lastSeenAt: -1 })
          .limit(8)
          .lean(),
        Promise.all([
          ChangeLog.countDocuments({ createdAt: { $gte: dayAgo } }),
          ChangeLog.countDocuments({ createdAt: { $gte: weekAgo } }),
          ChangeLog.estimatedDocumentCount(),
        ]),
      ]);

    const sev = Object.fromEntries(alertsBySeverity.map((a) => [a._id, a.count]));
    const now = Date.now();

    res.json({
      success: true,
      role: req.devRole,
      env: process.env.NODE_ENV || "development",
      alerts: {
        critical: sev.critical || 0,
        warn: sev.warn || 0,
        info: sev.info || 0,
        recent: recentAlerts,
      },
      changes: {
        last24h: totals[0],
        last7d: totals[1],
        allTime: totals[2],
        byDepartment: changesByDept.map((d) => ({
          slug: d._id || "(none)",
          count: d.count,
          lastChangeAt: d.last,
        })),
        topActors: topActors.map((a) => ({ email: a._id, name: a.name || a._id, count: a.count })),
      },
      jobs: jobs.map((j) => {
        const ref = j.lastBeatAt || j.createdAt;
        const silence = ref ? now - new Date(ref).getTime() : null;
        return {
          name: j.name,
          description: j.description,
          expectEverySeconds: j.expectEverySeconds,
          lastBeatAt: j.lastBeatAt,
          lastOkAt: j.lastOkAt,
          lastError: j.lastError,
          beatCount: j.beatCount,
          overdue: silence !== null && silence > j.expectEverySeconds * 1000 * (j.graceFactor || 1.5),
        };
      }),
    });
  } catch (err) {
    console.error("[dev] overview:", err.message);
    res.status(500).json({ success: false, message: "Could not build the overview." });
  }
});

/* ------------------------------------------------------------------ */
/* Cross-department history                                            */
/* ------------------------------------------------------------------ */

/* Same response shapes as routes/Access/changeHistoryRouter.js, with
   `department` a QUERY PARAMETER instead of a factory pin. That router's
   header names this exact endpoint as the merged view the shared spine was
   built for. The per-department routers stay: a department sees itself, this
   side sees everything. */

router.get("/history/departments", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
    const since = new Date(Date.now() - days * 864e5);
    const counts = await ChangeLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$departmentSlug", count: { $sum: 1 }, last: { $max: "$createdAt" } } },
      { $sort: { count: -1 } },
    ]);
    res.json({
      success: true,
      days,
      data: counts.map((c) => ({ slug: c._id || "(none)", count: c.count, lastChangeAt: c.last })),
      total: counts.reduce((n, c) => n + c.count, 0),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not count departments." });
  }
});

router.get("/history", async (req, res) => {
  try {
    const { department, section, entity, entityId, action, actor, origin, from, to, q, page, limit } = req.query;
    const result = await listChanges({
      departmentSlug: department || undefined,
      section: section === "unfiled" ? "" : section || undefined,
      entity,
      entityId,
      action: action ? String(action).split(",").filter(Boolean) : undefined,
      actorEmail: actor,
      origin,
      from,
      to,
      q,
      page,
      limit,
    });
    res.json({
      success: true,
      data: result.items.map(presentEntry),
      page: result.page,
      limit: result.limit,
      total: result.total,
      hasMore: result.page * result.limit < result.total,
    });
  } catch (err) {
    console.error("[dev] history:", err.message);
    res.status(500).json({ success: false, message: "Could not load the history." });
  }
});

router.get("/history/actors", async (req, res) => {
  try {
    const match = { actorEmail: { $nin: ["", null] } };
    if (req.query.department) match.departmentSlug = String(req.query.department).toLowerCase();
    const actors = await ChangeLog.aggregate([
      { $match: match },
      { $group: { _id: "$actorEmail", name: { $last: "$actorName" }, count: { $sum: 1 }, last: { $max: "$createdAt" } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);
    res.json({
      success: true,
      data: actors.map((a) => ({ email: a._id, name: a.name || a._id, count: a.count, lastChangeAt: a.last })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not list actors." });
  }
});

/* ------------------------------------------------------------------ */
/* One record's timeline                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything that ever happened to one record, plus a per-field view.
 *
 * The per-field grouping is the point: "dateOfJoining: A → B → A, three
 * people, six weeks" is the answer that used to take an evening of working
 * backwards through Mongo. Flip-flops are marked here with the same rule the
 * scanner uses, so the timeline and the alert agree.
 */
router.get("/record/:entity/:entityId", async (req, res) => {
  try {
    const entity = String(req.params.entity);
    const entityId = String(req.params.entityId);

    const entries = await ChangeLog.find({ entity, entityId })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const enriched = entries.map(presentEntry);

    const fields = new Map();
    // Oldest→newest so the hop order reads forward. Built from the ENRICHED
    // rows: an old entry that only stored before/after now contributes its
    // reconstructed field hops instead of vanishing from the per-field view.
    for (const e of [...enriched].reverse()) {
      for (const f of e.fields || []) {
        if (!f?.path) continue;
        if (!fields.has(f.path)) fields.set(f.path, []);
        fields.get(f.path).push({
          at: e.createdAt,
          from: f.from,
          to: f.to,
          by: e.actorName || e.actorEmail || "unknown",
          origin: e.origin,
          approvedBy: e.approvedByName || "",
        });
      }
    }

    const sameish = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const fieldHistories = [...fields.entries()]
      .map(([path, hops]) => {
        const seen = [];
        let revisited = false;
        for (const h of hops) {
          if (seen.some((v) => sameish(v, h.to))) { revisited = true; break; }
          seen.push(h.to);
        }
        return {
          path,
          label: fieldLabel(entries[0]?.section || "", path),
          changes: hops.length,
          revisited,
          hops,
        };
      })
      .sort((a, b) => b.changes - a.changes);

    res.json({
      success: true,
      entity,
      entityId,
      entityLabel: entries[0]?.entityLabel || "",
      departmentSlug: entries[0]?.departmentSlug || "",
      total: entries.length,
      timeline: enriched,
      fields: fieldHistories,
    });
  } catch (err) {
    console.error("[dev] record:", err.message);
    res.status(500).json({ success: false, message: "Could not load the record's timeline." });
  }
});

/**
 * Everything that happened around one moment — the "find the reason" query.
 *
 * The pattern behind almost every "how did this happen": a change over HERE
 * caused the system to do something over THERE, and the two live in different
 * departments' histories. Given a timestamp (and optionally an actor), this
 * returns every recorded change within the window across ALL departments,
 * grouped, so "changed the date of joining at 11:02" sits next to "PL balance
 * granted at 11:02" on one screen instead of in two tabs.
 */
router.get("/around", async (req, res) => {
  try {
    const at = new Date(req.query.at);
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ success: false, message: "Pass at=<ISO timestamp>." });
    }
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 15, 1), 240);
    const filter = {
      createdAt: {
        $gte: new Date(at.getTime() - minutes * 60000),
        $lte: new Date(at.getTime() + minutes * 60000),
      },
    };
    if (req.query.actor) filter.actorEmail = String(req.query.actor).toLowerCase();

    const rows = await ChangeLog.find(filter).sort({ createdAt: 1 }).limit(300).lean();
    res.json({
      success: true,
      at,
      minutes,
      total: rows.length,
      data: rows.map(presentEntry),
    });
  } catch (err) {
    console.error("[dev] around:", err.message);
    res.status(500).json({ success: false, message: "Could not load the window." });
  }
});

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

router.get("/alerts", async (req, res) => {
  try {
    const { status = "open", kind, severity, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status === "open") filter.status = { $ne: "resolved" };
    else if (status && status !== "all") filter.status = status;
    if (kind) filter.kind = kind;
    if (severity) filter.severity = severity;

    const lim = Math.min(Number(limit) || 50, 200);
    const pg = Math.max(Number(page) || 1, 1);
    const [rows, total, kinds] = await Promise.all([
      DevAlert.find(filter).sort({ lastSeenAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      DevAlert.countDocuments(filter),
      DevAlert.aggregate([{ $group: { _id: "$kind", count: { $sum: 1 } } }]),
    ]);
    res.json({
      success: true,
      data: rows,
      total,
      page: pg,
      limit: lim,
      kinds: kinds.map((k) => ({ kind: k._id, count: k.count })),
      canDecide: roleAtLeast(req.devRole, "editor"),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not load alerts." });
  }
});

router.post("/alerts/:id/ack", requireEditor, async (req, res) => {
  try {
    const alert = await DevAlert.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "acked",
          ackedByEmail: req.user.email,
          ackedByName: req.user.name || "",
          ackedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!alert) return res.status(404).json({ success: false, message: "No such alert." });
    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not acknowledge it." });
  }
});

router.post("/alerts/:id/resolve", requireEditor, async (req, res) => {
  try {
    const alert = await DevAlert.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "resolved",
          resolvedAt: new Date(),
          resolutionNote: String(req.body?.note || "").slice(0, 1000),
        },
      },
      { new: true },
    );
    if (!alert) return res.status(404).json({ success: false, message: "No such alert." });
    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not resolve it." });
  }
});

/**
 * Ask the model to read one alert against its surrounding history.
 *
 * Optional in the truest sense: no GEMINI_API_KEY → a clear 503, and nothing
 * else on this side depends on it. The context handed over is the alert plus
 * the change-log rows around it — data the caller can already see — never
 * anything the alert itself does not reference.
 */
router.post("/alerts/:id/explain", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ success: false, message: "AI is not configured (GEMINI_API_KEY)." });
    }
    const alert = await DevAlert.findById(req.params.id).lean();
    if (!alert) return res.status(404).json({ success: false, message: "No such alert." });

    let context = [];
    if (alert.entity && alert.entityId) {
      context = await ChangeLog.find({ entity: alert.entity, entityId: alert.entityId })
        .sort({ createdAt: -1 })
        .limit(30)
        .select("createdAt action summary actorName fields origin")
        .lean();
    } else if (alert.actorEmail) {
      context = await ChangeLog.find({ actorEmail: alert.actorEmail })
        .sort({ createdAt: -1 })
        .limit(30)
        .select("createdAt action summary entity entityLabel departmentSlug")
        .lean();
    }

    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt =
      `You are helping a developer triage an internal ERP alert. Be concrete and brief.\n\n` +
      `ALERT (${alert.kind}, ${alert.severity}, seen ${alert.count}x):\n${alert.title}\n${alert.detail}\n\n` +
      `EVIDENCE:\n${JSON.stringify(alert.evidence || [], null, 1).slice(0, 4000)}\n\n` +
      `RELATED CHANGE LOG:\n${JSON.stringify(context, null, 1).slice(0, 8000)}\n\n` +
      `In under 150 words: what most likely happened, whether it looks like user error / process gaming / a system fault, and the one next step to confirm.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });
    res.json({ success: true, explanation: result.text || "The model returned nothing." });
  } catch (err) {
    console.error("[dev] explain:", err.message);
    res.status(500).json({ success: false, message: `AI explain failed: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/**
 * Is the system operating normally? Every number here is measured on this
 * request or read from the stores that already watch — nothing is a guess and
 * nothing is hardcoded "Healthy".
 */
router.get("/health", async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const dayAgo = new Date(Date.now() - 864e5);

    // A real round trip, timed — readyState alone says "connected once".
    let dbPingMs = null;
    let dbOk = false;
    try {
      const t = Date.now();
      await mongoose.connection.db.admin().ping();
      dbPingMs = Date.now() - t;
      dbOk = true;
    } catch {
      /* dbOk stays false */
    }

    const [openCritical, errors24h, jobs, devices] = await Promise.all([
      DevAlert.countDocuments({ status: { $ne: "resolved" }, severity: "critical" }),
      DevAlert.countDocuments({ kind: "server-error", lastSeenAt: { $gte: dayAgo } }),
      JobHeartbeat.find({}).lean(),
      require("../../models/Employee").countDocuments({ fcmToken: { $nin: [null, ""] } }),
    ]);

    const now = Date.now();
    const jobRows = jobs.map((j) => {
      const ref = j.lastBeatAt || j.createdAt;
      return {
        name: j.name,
        enabled: j.enabled !== false,
        overdue:
          j.enabled !== false &&
          ref &&
          now - new Date(ref).getTime() > j.expectEverySeconds * 1000 * (j.graceFactor || 1.5),
        failCount: j.failCount || 0,
        lastError: j.lastError || "",
      };
    });

    let pushConfigured = false;
    try {
      pushConfigured = Boolean(require("../../config/firebaseAdmin").messaging);
    } catch {
      /* stays false */
    }

    res.json({
      success: true,
      env: process.env.NODE_ENV || "development",
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      database: { ok: dbOk, pingMs: dbPingMs, state: mongoose.connection.readyState },
      alerts: { openCritical, serverErrors24h: errors24h },
      jobs: jobRows,
      notifications: { pushConfigured, registeredDevices: devices },
    });
  } catch (err) {
    console.error("[dev] health:", err.message);
    res.status(500).json({ success: false, message: "Could not read health." });
  }
});

/* ------------------------------------------------------------------ */
/* Find a record by NAME — nobody should have to remember an id        */
/* ------------------------------------------------------------------ */

router.get("/find-record", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const Employee = require("../../models/Employee");
    const people = await Employee.find({
      $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { biometricId: rx }],
    })
      .select("firstName lastName email biometricId department")
      .limit(12)
      .lean();

    res.json({
      success: true,
      data: people.map((p) => ({
        entity: "employee",
        entityId: String(p._id),
        label: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email,
        sub: [p.biometricId, p.email, p.department].filter(Boolean).join(" · "),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not search." });
  }
});

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

router.get("/analytics", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 864e5);
    const match = { createdAt: { $gte: since } };

    const [byDepartment, byActor, byAction, byDay, topFields, alertsByKind, jobs] =
      await Promise.all([
        ChangeLog.aggregate([{ $match: match }, { $group: { _id: "$departmentSlug", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
        ChangeLog.aggregate([
          { $match: { ...match, actorEmail: { $nin: ["", null] } } },
          { $group: { _id: "$actorEmail", name: { $last: "$actorName" }, count: { $sum: 1 } } },
          { $sort: { count: -1 } }, { $limit: 10 },
        ]),
        ChangeLog.aggregate([{ $match: match }, { $group: { _id: "$action", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
        ChangeLog.aggregate([
          { $match: match },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+05:30" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
        ChangeLog.aggregate([
          { $match: match },
          { $unwind: "$fields" },
          { $group: { _id: "$fields.path", count: { $sum: 1 } } },
          { $sort: { count: -1 } }, { $limit: 15 },
        ]),
        DevAlert.aggregate([
          { $match: { lastSeenAt: { $gte: since } } },
          { $group: { _id: "$kind", count: { $sum: 1 }, open: { $sum: { $cond: [{ $ne: ["$status", "resolved"] }, 1, 0] } } } },
          { $sort: { count: -1 } },
        ]),
        JobHeartbeat.find({}).select("name beatCount failCount lastDurationMs").lean(),
      ]);

    res.json({
      success: true,
      days,
      byDepartment: byDepartment.map((d) => ({ key: d._id || "(none)", count: d.count })),
      byActor: byActor.map((a) => ({ key: a.name || a._id, email: a._id, count: a.count })),
      byAction: byAction.map((a) => ({ key: a._id, count: a.count })),
      byDay: byDay.map((d) => ({ day: d._id, count: d.count })),
      topFields: topFields.map((f) => ({ key: fieldLabel("", f._id), path: f._id, count: f.count })),
      alertsByKind: alertsByKind.map((k) => ({ key: k._id, count: k.count, open: k.open })),
      jobs,
    });
  } catch (err) {
    console.error("[dev] analytics:", err.message);
    res.status(500).json({ success: false, message: "Could not build analytics." });
  }
});

/* ------------------------------------------------------------------ */
/* Forms — administrator-defined fields on real records                */
/* ------------------------------------------------------------------ */

router.get("/forms", async (req, res) => {
  try {
    const counts = await FormFieldDef.aggregate([
      { $group: { _id: "$formKey", total: { $sum: 1 }, enabled: { $sum: { $cond: ["$enabled", 1, 0] } } } },
    ]);
    const byKey = new Map(counts.map((c) => [c._id, c]));
    res.json({
      success: true,
      canEdit: roleAtLeast(req.devRole, "editor"),
      data: formConfig.FORMS.map((f) => ({
        ...f,
        fields: byKey.get(f.formKey)?.total || 0,
        enabled: byKey.get(f.formKey)?.enabled || 0,
        /* The fields the app itself defines. Counted here so a section that
           has no ADDED fields still reads as what it is — a form with 27
           fields — instead of "0/0", which read as broken. */
        builtIn: builtInFields.countBuiltIn(f.formKey),
      })),
      fieldTypes: FormFieldDef.FIELD_TYPES,
      patterns: Object.keys(FormFieldDef.PATTERNS),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not list forms." });
  }
});

router.get("/forms/:formKey/fields", async (req, res) => {
  try {
    const formKey = String(req.params.formKey).toLowerCase();
    res.json({
      success: true,
      canEdit: roleAtLeast(req.devRole, "editor"),
      /* Two lists, deliberately separate rather than merged: `builtIn` is what
         the app defines and this screen can only describe, `data` is what an
         administrator has added and may change. Merging them would invite an
         edit control on a row no edit can reach. */
      builtIn: await builtInFields.listBuiltInWithState(formKey),
      data: await formConfig.listDefs(formKey),
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * Hide or show one of the APP's fields on the employee page.
 *
 * PUT /forms/:formKey/built-in/:key   { hidden: boolean, reason?: string }
 *
 * Hiding stops the form asking for the field. It touches no employee record —
 * every value already stored under that key is kept, so showing it again
 * brings the data back rather than a column of blanks.
 *
 * A `locked` field is refused HERE and not merely hidden in the UI: the form
 * refuses to save without an email, a shift or a confirmation date, so hiding
 * one would produce a form nobody can submit and no visible field to fix.
 */
router.put("/forms/:formKey/built-in/:key", requireEditor, async (req, res) => {
  try {
    const formKey = String(req.params.formKey).toLowerCase();
    const key = String(req.params.key);
    const def = builtInFields.findBuiltIn(formKey, key);
    if (!def) {
      return res.status(404).json({ success: false, message: "No such field on that form." });
    }

    const hidden = req.body?.hidden !== false;
    const refuse = def.locked || def.internal;
    if (hidden && refuse) {
      return res.status(409).json({
        success: false,
        code: "FIELD_LOCKED",
        message: `"${def.label}" cannot be hidden. ${refuse}`,
      });
    }

    if (hidden) {
      await FormFieldOverride.findOneAndUpdate(
        { formKey, key },
        {
          $set: {
            hidden: true,
            reason: String(req.body?.reason || "").trim(),
            hiddenByEmail: req.user?.email || "",
            hiddenByName: req.user?.name || "",
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else {
      // Showing again is a delete, not a second flag — absent means shown.
      await FormFieldOverride.deleteOne({ formKey, key });
    }
    builtInFields.invalidateOverrides();

    recordChange(req, {
      departmentSlug: "developer",
      section: "developer:forms",
      entity: "form-field",
      entityId: `${formKey}#${key}`,
      entityLabel: `${def.label} (${formKey})`,
      action: "update",
      summary: hidden
        ? `Hidden from the employee page${req.body?.reason ? ` — ${String(req.body.reason).trim()}` : ""}`
        : "Shown on the employee page again",
    }).catch(() => {});

    res.json({
      success: true,
      message: hidden
        ? `"${def.label}" is hidden. Values already saved are kept.`
        : `"${def.label}" is shown again.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not change that field." });
  }
});

function auditFormChange(req, def, action, summary) {
  return recordChange(req, {
    departmentSlug: "developer",
    section: "developer:forms",
    entity: "form-field",
    entityId: `${def.formKey}#${def.key}`,
    entityLabel: `${def.label} (${def.formKey})`,
    action,
    summary,
  }).catch(() => {});
}

router.post("/forms/:formKey/fields", requireEditor, async (req, res) => {
  try {
    const formKey = String(req.params.formKey).toLowerCase();
    if (!formConfig.FORM_KEYS.has(formKey)) {
      return res.status(400).json({ success: false, message: `Unknown form "${formKey}".` });
    }
    const b = req.body || {};
    const key = String(b.key || "").trim().replace(/[^a-zA-Z0-9_]/g, "");
    if (!key) return res.status(400).json({ success: false, message: "A key is required (letters, numbers, _)." });
    if (!String(b.label || "").trim()) return res.status(400).json({ success: false, message: "A label is required." });

    const def = await FormFieldDef.create({
      formKey,
      key,
      label: String(b.label).trim(),
      description: String(b.description || "").trim(),
      type: b.type,
      required: Boolean(b.required),
      enabled: b.enabled !== false,
      order: Number(b.order) || 0,
      options: Array.isArray(b.options) ? b.options.map(String).filter(Boolean).slice(0, 50) : [],
      min: b.min === "" || b.min === undefined ? undefined : Number(b.min),
      max: b.max === "" || b.max === undefined ? undefined : Number(b.max),
      pattern: b.pattern,
      defaultValue: String(b.defaultValue || ""),
      createdByEmail: req.user.email,
    });
    formConfig.invalidate();
    await auditFormChange(req, def, "create", `Added field "${def.label}" (${def.type}) to ${formKey}.`);
    res.json({ success: true, data: def });
  } catch (err) {
    const msg = err.code === 11000 ? "A field with that key already exists on this form." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.put("/forms/:formKey/fields/:id", requireEditor, async (req, res) => {
  try {
    const def = await FormFieldDef.findById(req.params.id);
    if (!def) return res.status(404).json({ success: false, message: "No such field." });
    const b = req.body || {};

    /* `key` is deliberately not writable: values on records are stored under
       it, and a rename would orphan every one of them. Delete + recreate is
       the honest version of that operation. */
    const before = { label: def.label, type: def.type, required: def.required, enabled: def.enabled };
    for (const f of ["label", "description", "type", "pattern", "defaultValue"]) {
      if (b[f] !== undefined) def[f] = b[f];
    }
    for (const f of ["required", "enabled"]) if (b[f] !== undefined) def[f] = Boolean(b[f]);
    if (b.order !== undefined) def.order = Number(b.order) || 0;
    if (b.options !== undefined) {
      def.options = Array.isArray(b.options) ? b.options.map(String).filter(Boolean).slice(0, 50) : [];
    }
    for (const f of ["min", "max"]) {
      if (b[f] !== undefined) def[f] = b[f] === "" || b[f] === null ? undefined : Number(b[f]);
    }
    def.updatedByEmail = req.user.email;
    await def.save();
    formConfig.invalidate();
    await auditFormChange(req, def, "update",
      `Field "${def.label}" on ${def.formKey}: ` +
      `${JSON.stringify(before)} → ${JSON.stringify({ label: def.label, type: def.type, required: def.required, enabled: def.enabled })}.`);
    res.json({ success: true, data: def });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete("/forms/:formKey/fields/:id", requireEditor, async (req, res) => {
  try {
    const def = await FormFieldDef.findByIdAndDelete(req.params.id);
    if (!def) return res.status(404).json({ success: false, message: "No such field." });
    formConfig.invalidate();
    await auditFormChange(req, def, "delete",
      `Removed field "${def.label}" from ${def.formKey}. Stored values on records are untouched.${reasonOf(req)}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Job control                                                         */
/* ------------------------------------------------------------------ */

router.patch("/jobs/:name", requireApprover, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const row = await jobRegistry.setEnabled(req.params.name, enabled);
    await recordChange(req, {
      departmentSlug: "developer",
      section: "developer:jobs",
      entity: "scheduled-job",
      entityId: row.name,
      entityLabel: row.name,
      action: "update",
      summary: `${enabled ? "Enabled" : "DISABLED"} the scheduled job "${row.name}".${reasonOf(req)}`,
    }).catch(() => {});
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/jobs/runners", async (req, res) => {
  res.json({ success: true, data: jobRegistry.listRunners() });
});

router.post("/jobs/:name/run", requireEditor, async (req, res) => {
  try {
    const out = await jobRegistry.runNow(req.params.name);
    await recordChange(req, {
      departmentSlug: "developer",
      section: "developer:jobs",
      entity: "scheduled-job",
      entityId: req.params.name,
      entityLabel: req.params.name,
      action: "other",
      summary: `Ran "${req.params.name}" manually (${out.durationMs}ms).${reasonOf(req)}`,
    }).catch(() => {});
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

router.get("/maintenance", async (req, res) => {
  res.json({
    success: true,
    env: process.env.NODE_ENV || "development",
    canRun: roleAtLeast(req.devRole, "editor"),
    canAct: roleAtLeast(req.devRole, "approver"),
    data: maintenance.listChecks(),
  });
});

router.post("/maintenance/:name", requireEditor, async (req, res) => {
  try {
    const listed = maintenance.listChecks().find((c) => c.name === req.params.name);
    if (!listed) return res.status(404).json({ success: false, message: "No such check." });
    // Reports read; ACTIONS change things and need the approver floor.
    if (listed.kind === "action" && !roleAtLeast(req.devRole, "approver")) {
      return res.status(403).json({ success: false, code: "INSUFFICIENT_ROLE", message: "Actions need the approver role." });
    }
    const out = await maintenance.runCheck(req.params.name);
    if (listed.kind === "action") {
      await recordChange(req, {
        departmentSlug: "developer",
        section: "developer:maintenance",
        entity: "maintenance",
        entityId: listed.name,
        entityLabel: listed.label,
        action: "other",
        summary: `${out.summary}${reasonOf(req)}`,
      }).catch(() => {});
    }
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Test notification                                                   */
/* ------------------------------------------------------------------ */

/** Push to the CALLER's own registered browser — proof the pipe works. */
router.post("/notifications/test", requireEditor, async (req, res) => {
  try {
    const Employee = require("../../models/Employee");
    const me = await Employee.findOne({ email: req.user.email })
      .select("email fcmToken")
      .lean();
    if (!me?.fcmToken) {
      return res.status(400).json({
        success: false,
        message: "No browser is registered for your account — allow notifications from any dashboard first.",
      });
    }
    const { sendPush } = require("../../services/departmentApprovalNotifications.service");
    const ok = await sendPush(me, {
      title: "Test notification",
      body: `Sent from the developer side by you, ${new Date().toLocaleTimeString()}.`,
      url: `${(process.env.FRONTEND_URL || "https://cms.grav.in").replace(/\/+$/, "")}/developer`,
      type: "developer_alert",
    });
    res.json({ success: true, delivered: ok, message: ok ? "Sent — check your notification tray." : "FCM refused the send; the token may be stale. Re-allow notifications and try again." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Settings, jobs, scan                                                */
/* ------------------------------------------------------------------ */

router.get("/settings", async (req, res) => {
  try {
    const department = req.query.department
      ? String(req.query.department).toLowerCase().trim()
      : undefined;
    res.json({
      success: true,
      department,
      data: await listSettings({ department }),
      canEdit: roleAtLeast(req.devRole, "editor"),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not load settings." });
  }
});

router.put("/settings/:key", requireEditor, async (req, res) => {
  try {
    /* Sensitive keys (ops.*, origins) declare minRole in the catalogue;
       enforcing it here means one list drives both the API and the UI. */
    const { DEFINITIONS } = require("../../services/devConfig");
    const def = DEFINITIONS.find((d) => d.key === req.params.key);
    if (def?.minRole && !roleAtLeast(req.devRole, def.minRole)) {
      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_ROLE",
        message: `"${req.params.key}" needs the ${def.minRole} role.`,
      });
    }

    const department = req.body?.department
      ? String(req.body.department).toLowerCase().trim()
      : undefined;
    const result = await setSetting(req.params.key, req.body?.value, req.user, {
      department,
      inherit: Boolean(req.body?.inherit),
    });

    const label = department ? `${req.params.key} (${department})` : req.params.key;
    // A live tunable changing IS a change — into the same log as everything.
    await recordChange(req, {
      departmentSlug: "developer",
      section: "developer:settings",
      entity: "system-setting",
      entityId: department ? `${req.params.key}@${department}` : req.params.key,
      entityLabel: label,
      action: "update",
      summary: (result.inherited
        ? `${label}: override removed — back to the global value`
        : `${label}: ${JSON.stringify(result.previous)} → ${JSON.stringify(result.value)}`) + reasonOf(req),
      before: { value: result.previous },
      after: { value: result.inherited ? "(inherits global)" : result.value },
    }).catch(() => {});

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/jobs", async (req, res) => {
  try {
    const jobs = await JobHeartbeat.find({}).sort({ name: 1 }).lean();
    const now = Date.now();
    res.json({
      success: true,
      data: jobs.map((j) => {
        const ref = j.lastBeatAt || j.createdAt;
        return {
          ...j,
          overdue: ref ? now - new Date(ref).getTime() > j.expectEverySeconds * 1000 * (j.graceFactor || 1.5) : true,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not load jobs." });
  }
});

router.post("/scan", requireEditor, async (req, res) => {
  try {
    const summary = await scanChangeLogs();
    res.json({ success: true, summary });
  } catch (err) {
    console.error("[dev] scan:", err.message);
    res.status(500).json({ success: false, message: `Scan failed: ${err.message}` });
  }
});

module.exports = router;
// For verifyDeveloperSide — the enrichment contract is behaviour worth pinning.
module.exports.presentEntry = presentEntry;
