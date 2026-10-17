// routes/CMS_Routes/FollowUps/followUpsRoute.js
//
// FOLLOW-UPS BETWEEN THE PRODUCTION MANAGER, MERCHANDISING AND DESIGN (R&D).
// Mounted at /api/cms/follow-ups. Every request may carry `?as=<department>`,
// the portal the page is in (see followUps.service resolveMe).
//
//   GET  /meta                    departments, automatic kinds, views
//   GET  /counts                  the bell and the tab badges
//   GET  /?view=&toDept=&subjectType=&subjectId=&q=
//   GET  /people?dept=            who can be named in a department
//   GET  /subjects?q=             styles and orders to attach one to
//   GET  /settings                each department's default person
//   PUT  /settings/:dept          { person | null }
//   GET  /:id                     one follow-up with its thread
//   POST /                        raise one { title, detail, toDept, assignee, dueAt, priority, subject }
//   POST /:id/:action             comment | answer | close | reopen | reassign | due
//
// The doors need a signed-in CMS session from one of the four departments, the
// executive office, or an admin.
"use strict";

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const svc = require("../../../services/followUps/followUps.service");
const rules = require("../../../services/followUps/followUpRules");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const EXTRA_SLUGS = ["ceo", "board"];

router.use(async (req, res, next) => {
  try {
    const me = await svc.resolveMe(req);
    if (!me.isAdmin && !me.dept && !EXTRA_SLUGS.includes(me.slug)) {
      return res.status(403).json({ success: false, message: "Follow-ups are for the production manager, Merchandising, Design (R&D) and Sales." });
    }
    req.followUpMe = me;
    return next();
  } catch (err) {
    return next(err);
  }
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof svc.FollowUpError) {
      return res.status(err.status).json({ success: false, message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
    // The Atlas cluster's 500-collection cap: the `followups` collection
    // cannot be created until there is room. Said plainly, as the order
    // simulation history does (507 COLLECTION_LIMIT).
    if (err?.code === 8000 || /collections of \d+/.test(String(err?.message || ""))) {
      return res.status(507).json({ success: false, code: "COLLECTION_LIMIT", message: "The database has no room for follow-ups yet (the cluster is at its 500-collection limit), so nothing was saved." });
    }
    console.error("[follow-ups]", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

router.get("/meta", (req, res) => res.json({
  success: true,
  me: { name: req.followUpMe.name, email: req.followUpMe.email, dept: req.followUpMe.dept, isAdmin: req.followUpMe.isAdmin },
  departments: rules.DEPARTMENTS.map(({ key, label, portal }) => ({ key, label, portal })),
  kinds: Object.entries(rules.AUTO_KINDS).map(([key, v]) => ({ key, label: v.label, toDept: v.toDept, days: v.days })),
  views: rules.VIEWS,
}));

router.get("/counts", wrap(async (req, res) => {
  res.json({ success: true, counts: await svc.counts(req.followUpMe) });
}));

router.get("/people", wrap(async (req, res) => {
  const dept = String(req.query.dept || "");
  if (!rules.deptByKey(dept)) return res.status(400).json({ success: false, message: "Unknown department." });
  res.json({ success: true, people: await svc.departmentPeople(dept) });
}));

router.get("/subjects", wrap(async (req, res) => {
  res.json({ success: true, subjects: await svc.searchSubjects(req.query.q) });
}));

router.get("/settings", wrap(async (req, res) => {
  res.json({ success: true, settings: await svc.getSettings() });
}));

router.put("/settings/:dept", wrap(async (req, res) => {
  res.json({ success: true, settings: await svc.setDefaultPerson(req.followUpMe, req.params.dept, req.body?.person || null) });
}));

router.get("/", wrap(async (req, res) => {
  const { view, toDept, subjectType, subjectId, q } = req.query;
  res.json({ success: true, followUps: await svc.list(req.followUpMe, { view, toDept, subjectType, subjectId, q }) });
}));

router.get("/:id", wrap(async (req, res) => {
  res.json({ success: true, followUp: await svc.get(req.followUpMe, req.params.id) });
}));

router.post("/", wrap(async (req, res) => {
  const fu = await svc.create(req.followUpMe, req.body || {});
  res.status(201).json({ success: true, followUp: await svc.get(req.followUpMe, String(fu._id)) });
}));

router.post("/:id/:action", wrap(async (req, res) => {
  res.json({ success: true, followUp: await svc.act(req.followUpMe, req.params.id, req.params.action, req.body || {}) });
}));

module.exports = router;
