/**
 * routes/task_routes/taskTabSeen.routes.js
 *
 * **What is new on each tab of a task, and when this person last looked.**
 * OWNER DECISION, 17 Aug 2026.
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/taskTabSeen.routes"));
 *
 * ENDPOINTS
 *   GET  /cowork/task/:taskId/tab-activity   → { activity, seen }
 *   POST /cowork/task/:taskId/tab-seen       body { tabId } → marks it read now
 *
 * **Server-side, not per browser.** Reading a tab on a laptop has to clear its
 * badge on a phone; a mark kept in one browser would leave the same message
 * unread on every other device somebody signs in on.
 *
 * **Generic by construction.** `activity` is a map keyed by tab id, so a tab
 * added later gets a badge by adding one entry to `ACTIVITY_READERS` below —
 * nothing in the frontend, the store, or the marking endpoint knows the names.
 */

const express = require("express");
const router = express.Router();
const { db, admin } = require("../../config/firebaseAdmin");

/* The signed-in person. `verifyCoworkToken` sets `req.coworkUser` and nothing
   else — reading `req.employee` gave undefined on every request, so marking a
   tab read answered 401 every time and no badge ever cleared. */
const viewerOf = (req) => String(req.coworkUser?.employeeId || "");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { readMs } = require("../../services/officeDeadline.service");

const SEEN = "cowork_task_tab_seen";

/** One document per person per task per tab. Deterministic, so marking twice
 *  overwrites rather than accumulating rows nobody reads. */
const seenId = (employeeId, taskId, tabId) =>
  `${employeeId}__${taskId}__${tabId}`;

/** Tab ids a client may mark. Anything else is refused rather than stored — an
 *  unbounded key would let a typo create documents for ever. */
const KNOWN_TABS = [
  "overview",
  "deadline",
  "reports",
  "submission",
  "review",
  "chat",
  "meetings",
  "files",
  "goal",
];

/**
 * The latest thing that happened on each tab, and how many of them are recent
 * enough to count.
 *
 * Each reader answers `{ lastAt, count }` for one tab from data the task
 * already carries. `lastAt` null means nothing has ever happened there, which
 * is different from something having happened before you last looked.
 */
async function readActivity(taskId, task) {
  const out = {};

  /* ── chat ─────────────────────────────────────────────────────────────── */
  try {
    const snap = await db
      .collection("cowork_tasks")
      .doc(taskId)
      .collection("chat")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const stamps = [];
    snap.forEach((d) => {
      const m = d.data();
      const at = readMs(m.createdAt);
      if (Number.isFinite(at)) stamps.push({ at, by: m.senderId || null });
    });
    out.chat = {
      lastAt: stamps.length ? new Date(stamps[0].at).toISOString() : null,
      items: stamps.map((s) => ({ at: new Date(s.at).toISOString(), by: s.by })),
    };
  } catch (e) {
    /* An unreadable subcollection costs this tab's badge, never the response. */
    console.warn("[tab-activity] chat read failed:", e.message);
    out.chat = { lastAt: null, items: [] };
  }

  /* ── submission — each attempt is its own event ───────────────────────── */
  const submissions = [];
  const subAt = readMs(task.completionSubmission?.submittedAt);
  if (Number.isFinite(subAt)) {
    submissions.push({
      at: new Date(subAt).toISOString(),
      by: task.completionSubmission?.submittedBy || null,
    });
  }
  out.submission = {
    lastAt: submissions.length ? submissions[submissions.length - 1].at : null,
    items: submissions,
  };

  /* ── review — a decision, whichever way it went ───────────────────────── */
  const reviews = [];
  for (const r of [task.tlReview, task.ceoReview]) {
    const at = readMs(r?.reviewedAt);
    if (Number.isFinite(at)) {
      reviews.push({ at: new Date(at).toISOString(), by: r.reviewedBy || null });
    }
  }
  for (const h of task.reworkHistory || []) {
    const at = readMs(h.at ?? h.reviewedAt);
    if (Number.isFinite(at)) {
      reviews.push({ at: new Date(at).toISOString(), by: h.reviewedBy || null });
    }
  }
  reviews.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  out.review = {
    lastAt: reviews.length ? reviews[reviews.length - 1].at : null,
    items: reviews,
  };

  /* ── meetings — a session held on this task ───────────────────────────── */
  try {
    const snap = await db
      .collection("cowork_tasks")
      .doc(taskId)
      .collection("meeting_sessions")
      .get();
    const items = [];
    snap.forEach((d) => {
      const s = d.data();
      const at = readMs(s.endedAt ?? s.startedAt);
      if (Number.isFinite(at)) {
        items.push({ at: new Date(at).toISOString(), by: null });
      }
    });
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    out.meetings = {
      lastAt: items.length ? items[items.length - 1].at : null,
      items,
    };
  } catch (e) {
    console.warn("[tab-activity] meetings read failed:", e.message);
    out.meetings = { lastAt: null, items: [] };
  }

  /* ── reports — a daily report written against this task ───────────────── */
  const reports = (task.dailyReports || [])
    .map((r) => readMs(r.at ?? r.createdAt))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => ({ at: new Date(n).toISOString(), by: null }));
  out.reports = {
    lastAt: reports.length ? reports[reports.length - 1].at : null,
    items: reports,
  };

  return out;
}

router.get(
  "/task/:taskId/tab-activity",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const employeeId = viewerOf(req);
      const doc = await db.collection("cowork_tasks").doc(taskId).get();
      if (!doc.exists) return res.status(404).json({ error: "Task not found." });

      const activity = await readActivity(taskId, doc.data());

      /* This viewer's marks, and nobody else's. */
      const seen = {};
      if (employeeId) {
        const snap = await db
          .collection(SEEN)
          .where("employeeId", "==", employeeId)
          .where("taskId", "==", taskId)
          .get();
        snap.forEach((d) => {
          const s = d.data();
          if (s.tabId) seen[s.tabId] = s.seenAt || null;
        });
      }

      return res.json({ taskId, activity, seen });
    } catch (e) {
      console.error("[tab-activity]", e.message);
      return res.status(500).json({ error: "Could not read task activity." });
    }
  },
);

router.post(
  "/task/:taskId/tab-seen",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const tabId = String((req.body || {}).tabId || "");
      const employeeId = viewerOf(req);
      if (!employeeId) return res.status(401).json({ error: "Not authenticated." });
      if (!KNOWN_TABS.includes(tabId)) {
        return res
          .status(400)
          .json({ error: `tabId must be one of: ${KNOWN_TABS.join(", ")}.` });
      }

      const seenAt = new Date().toISOString();
      await db
        .collection(SEEN)
        .doc(seenId(employeeId, taskId, tabId))
        .set(
          {
            employeeId,
            taskId,
            tabId,
            seenAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      return res.json({ success: true, taskId, tabId, seenAt });
    } catch (e) {
      console.error("[tab-seen]", e.message);
      return res.status(500).json({ error: "Could not mark the tab as read." });
    }
  },
);

module.exports = router;
module.exports.KNOWN_TABS = KNOWN_TABS;
module.exports.seenId = seenId;
