// routes/HrRoutes/ChangeHistory.js
//
// Reading the change log from inside HR.
//
// There is already an admin endpoint over the same collection
// (`GET /api/admin/change-log`), and it stays. It is not enough for this,
// for two reasons:
//
//   * IT IS PLATFORM-ADMIN ONLY. An HR manager looking at the employee they
//     just edited is not a platform admin and never will be. The history has to
//     be readable by the department whose work it records, or the only people
//     who can answer "who changed this" are the two people who do not work in
//     the department.
//   * IT ANSWERS ONE QUESTION. It takes an entity and an id, or a department.
//     Every HR page needs "what happened HERE", filtered by who, when and what
//     kind of change — which is a query, not a lookup.
//
// SCOPED TO HR, ALWAYS. Every handler pins `departmentSlug: "hr"` server-side
// rather than taking it from the caller. A department parameter would make this
// a way for an HR account to read payroll changes in another department by
// changing a query string, which is the sort of hole that only shows up in an
// audit of the audit log.

"use strict";

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const ChangeLog = require("../../models/Access/ChangeLog");
const ChangeRequest = require("../../models/Access/ChangeRequest");
const { listChanges } = require("../../services/changeLog");
const { sectionsFor, sectionLabel } = require("../../services/auditSections");

const DEPARTMENT = "hr";

router.use(EmployeeAuthMiddleware);

/**
 * Only sections belonging to this department are accepted.
 *
 * Silently dropping an unknown section rather than passing it through matters:
 * a mistyped section that reached the query would return an empty list, and an
 * empty history reads as "nobody has changed anything here" — a wrong answer
 * that looks exactly like a right one.
 */
const HR_SECTION_KEYS = new Set(sectionsFor(DEPARTMENT).map((s) => s.key));

function cleanSections(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter((s) => HR_SECTION_KEYS.has(s));
}

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/sections                                 */
/* ------------------------------------------------------------------ */

/**
 * The section picker, with a count per section over the requested window.
 *
 * Counts come from one grouped aggregate rather than a query per section: HR
 * has twenty-eight sections and twenty-eight round trips to render a sidebar is
 * how a history page becomes the slowest screen in the product.
 */
router.get("/sections", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const counts = await ChangeLog.aggregate([
      { $match: { departmentSlug: DEPARTMENT, createdAt: { $gte: since } } },
      { $group: { _id: "$section", count: { $sum: 1 }, last: { $max: "$createdAt" } } },
    ]);
    const byKey = new Map(counts.map((c) => [c._id || "", c]));

    const sections = sectionsFor(DEPARTMENT).map((s) => ({
      ...s,
      count: byKey.get(s.key)?.count || 0,
      lastChangeAt: byKey.get(s.key)?.last || null,
    }));

    // Entries written before a route named its section, plus anything logged by
    // a route that has not been given one yet. Shown rather than hidden: a
    // history that quietly omits rows is worse than one with an "Other" bucket.
    const unfiled = byKey.get("") || null;

    res.json({
      success: true,
      days,
      data: sections,
      unfiled: unfiled ? { count: unfiled.count, lastChangeAt: unfiled.last } : null,
      total: counts.reduce((n, c) => n + c.count, 0),
    });
  } catch (err) {
    console.error("[hr/change-history] sections failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the history sections." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history                                          */
/* ------------------------------------------------------------------ */

/**
 * The list every history view is built on.
 *
 * Query: section | sections, entity, entityId, action, actor, origin,
 *        from, to, q, page, limit
 */
router.get("/", async (req, res) => {
  try {
    const {
      section, sections, entity, entityId, action, actor, origin,
      from, to, q, page, limit,
    } = req.query;

    const picked = cleanSections(section || sections);

    const result = await listChanges({
      departmentSlug: DEPARTMENT,
      // A single valid section, or the set of them. `section=unfiled` is the
      // explicit way to ask for the rows the section picker counts as unfiled.
      section: section === "unfiled" ? "" : picked.length === 1 ? picked[0] : undefined,
      sections: picked.length > 1 ? picked : undefined,
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
      data: result.items,
      page: result.page,
      limit: result.limit,
      total: result.total,
      hasMore: result.page * result.limit < result.total,
    });
  } catch (err) {
    console.error("[hr/change-history] list failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the change history." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/actors                                   */
/* ------------------------------------------------------------------ */

/** Everyone who has changed something, for the "changed by" filter. */
router.get("/actors", async (req, res) => {
  try {
    const picked = cleanSections(req.query.section || req.query.sections);
    const match = { departmentSlug: DEPARTMENT, actorEmail: { $nin: ["", null] } };
    if (picked.length) match.section = picked.length === 1 ? picked[0] : { $in: picked };

    const actors = await ChangeLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$actorEmail",
          // The most recent spelling of the name wins. A person whose name was
          // corrected should appear once, under the correction.
          name: { $last: "$actorName" },
          count: { $sum: 1 },
          last: { $max: "$createdAt" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);

    res.json({
      success: true,
      data: actors.map((a) => ({
        email: a._id,
        name: a.name || a._id,
        count: a.count,
        lastChangeAt: a.last,
      })),
    });
  } catch (err) {
    console.error("[hr/change-history] actors failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the editor list." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/stamps                                   */
/* ------------------------------------------------------------------ */

/**
 * "Added by X · last edited by Y" for a set of records, in one query.
 *
 * WHY THIS IS A BATCH ENDPOINT
 * ----------------------------
 * The line it feeds belongs under every row of a list — an employee list, the
 * document library, a department list. Fetched per row that is one request per
 * record, which on a 400-employee page is 400 requests to render one line of
 * small text each. So the caller sends the ids it is already showing and gets
 * one object back.
 *
 * Two facts per record, and they are different questions:
 *   created      — who put this here. Never changes, so it is the "added by"
 *                  line on a record that has never been edited.
 *   lastChanged  — the most recent change of any kind, which is what somebody
 *                  looking at a stale-looking record actually wants.
 *
 * Query: entity=employee&ids=a,b,c   (max 500 ids)
 */
router.get("/stamps", async (req, res) => {
  try {
    const entity = String(req.query.entity || "").trim();
    if (!entity) {
      return res.status(400).json({ success: false, message: "entity is required" });
    }

    const ids = String(req.query.ids || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 500);
    if (!ids.length) return res.json({ success: true, data: {} });

    // One pass, sorted oldest-first, folded in JS. The alternative — a $group
    // with $first and $last — needs two sorts on the server for the same two
    // values, and this collection is already indexed on (entity, entityId,
    // createdAt) which makes the sort free.
    const rows = await ChangeLog.find({
      departmentSlug: DEPARTMENT,
      entity,
      entityId: { $in: ids },
    })
      .select("entityId action actorName actorEmail approvedByName createdAt summary")
      .sort({ createdAt: 1 })
      .lean();

    const out = {};
    for (const r of rows) {
      const slot = (out[r.entityId] ||= { created: null, lastChanged: null, changes: 0 });
      slot.changes += 1;

      // The FIRST create wins, not the first row of any kind: a record whose
      // earliest surviving entry is an edit was created before the log existed,
      // and calling that edit its creation would put the wrong name on it.
      if (!slot.created && r.action === "create") {
        slot.created = { name: r.actorName || r.actorEmail || "", at: r.createdAt };
      }
      slot.lastChanged = {
        name: r.actorName || r.actorEmail || "",
        approvedBy: r.approvedByName || "",
        action: r.action,
        at: r.createdAt,
        summary: r.summary,
      };
    }

    res.json({ success: true, data: out });
  } catch (err) {
    console.error("[hr/change-history] stamps failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the record stamps." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/record/:entity/:entityId                 */
/* ------------------------------------------------------------------ */

/**
 * One record's whole story, plus anything still waiting on an approver.
 *
 * The pending half is the point. A record's history that shows only what has
 * been applied will tell somebody a field says 25,000 with no hint that a
 * change to 30,000 is sitting in a queue — and they will make their decision on
 * the number they can see.
 */
router.get("/record/:entity/:entityId", async (req, res) => {
  try {
    const { entity, entityId } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

    const [entries, pending] = await Promise.all([
      ChangeLog.find({ departmentSlug: DEPARTMENT, entity, entityId: String(entityId) })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      ChangeRequest.find({
        departmentSlug: DEPARTMENT,
        entity,
        entityId: String(entityId),
        status: "pending",
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    res.json({
      success: true,
      data: entries,
      pending: pending.map((p) => ({
        id: String(p._id),
        section: p.section,
        sectionLabel: p.sectionLabel || sectionLabel(p.section),
        action: p.action,
        summary: p.summary,
        changes: p.changes || [],
        requestedBy: p.requestedBy,
        createdAt: p.createdAt,
      })),
      total: entries.length,
    });
  } catch (err) {
    console.error("[hr/change-history] record failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load this record's history." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/summary                                  */
/* ------------------------------------------------------------------ */

/** Counts for the history page header: by action, by origin, by day. */
router.get("/summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const picked = cleanSections(req.query.section || req.query.sections);

    const match = { departmentSlug: DEPARTMENT, createdAt: { $gte: since } };
    if (picked.length) match.section = picked.length === 1 ? picked[0] : { $in: picked };

    const [byAction, byOrigin, byDay, pendingCount] = await Promise.all([
      ChangeLog.aggregate([{ $match: match }, { $group: { _id: "$action", count: { $sum: 1 } } }]),
      ChangeLog.aggregate([{ $match: match }, { $group: { _id: "$origin", count: { $sum: 1 } } }]),
      ChangeLog.aggregate([
        { $match: match },
        {
          $group: {
            // Bucketed in IST, matching every other date in the product. A UTC
            // bucket puts an 07:00 IST edit on the previous day, and a history
            // that disagrees with the attendance screen about what "yesterday"
            // means is a history nobody trusts.
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ChangeRequest.countDocuments({ departmentSlug: DEPARTMENT, status: "pending" }),
    ]);

    const asMap = (rows) =>
      rows.reduce((acc, r) => ({ ...acc, [r._id || "unknown"]: r.count }), {});

    res.json({
      success: true,
      days,
      byAction: asMap(byAction),
      byOrigin: asMap(byOrigin),
      byDay: byDay.map((d) => ({ date: d._id, count: d.count })),
      pendingApprovals: pendingCount,
      total: byAction.reduce((n, r) => n + r.count, 0),
    });
  } catch (err) {
    console.error("[hr/change-history] summary failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the history summary." });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/hr/change-history/export                                   */
/* ------------------------------------------------------------------ */

/**
 * The same list as CSV, for the times the answer has to leave the building.
 *
 * Capped at 5000 rows and says so in the response when it truncates, rather
 * than silently handing over a file that looks complete. An audit extract that
 * quietly stops at a round number is a liability.
 */
router.get("/export", async (req, res) => {
  try {
    const picked = cleanSections(req.query.section || req.query.sections);
    const MAX = 5000;

    const { items, total } = await listChanges({
      departmentSlug: DEPARTMENT,
      section: picked.length === 1 ? picked[0] : undefined,
      sections: picked.length > 1 ? picked : undefined,
      action: req.query.action ? String(req.query.action).split(",").filter(Boolean) : undefined,
      actorEmail: req.query.actor,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
      page: 1,
      limit: 200,
    });

    // listChanges caps a page at 200; the export wants the window, so it pages
    // through rather than asking for a limit the service is right to refuse.
    const rows = [...items];
    let page = 2;
    while (rows.length < Math.min(total, MAX)) {
      const next = await listChanges({
        departmentSlug: DEPARTMENT,
        section: picked.length === 1 ? picked[0] : undefined,
        sections: picked.length > 1 ? picked : undefined,
        action: req.query.action ? String(req.query.action).split(",").filter(Boolean) : undefined,
        actorEmail: req.query.actor,
        from: req.query.from,
        to: req.query.to,
        q: req.query.q,
        page,
        limit: 200,
      });
      if (!next.items.length) break;
      rows.push(...next.items);
      page += 1;
    }

    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      "When", "Section", "Record", "Action", "Summary", "Changed fields",
      "Changed by", "Email", "Approved by", "How", "Path",
    ];
    const lines = [header.join(",")];

    for (const e of rows.slice(0, MAX)) {
      lines.push([
        new Date(e.createdAt).toISOString(),
        e.sectionLabel || sectionLabel(e.section),
        e.entityLabel || e.entityId || "",
        e.action,
        e.summary,
        (e.fields || [])
          .map((f) => `${f.label || f.path}: ${f.from ?? "empty"} -> ${f.to ?? "empty"}`)
          .join(" | "),
        e.actorName,
        e.actorEmail,
        e.approvedByName || "",
        e.origin,
        e.requestPath || "",
      ].map(esc).join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hr-change-history-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    if (total > MAX) res.setHeader("X-Truncated-At", String(MAX));
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("[hr/change-history] export failed:", err.message);
    res.status(500).json({ success: false, message: "Could not export the change history." });
  }
});

module.exports = router;
