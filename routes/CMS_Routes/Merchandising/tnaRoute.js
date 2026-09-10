// routes/CMS_Routes/Merchandising/tnaRoute.js
//
// TIME & ACTION — THE DOOR ONTO THE DATE CONTROL.
//
// Its own router rather than more handlers on `executionRoute.js`, for the
// same reason the Execution file got its own: that file is already the widest
// surface in Merchandising, and a plan, a template, a calendar, a baseline and
// a cross-file register are not the execution file's own record. Sibling file,
// same mount prefix, same middleware — nothing about the contract changes.
//
// ── TWO AUTHORITIES, AND THE LINE BETWEEN THEM ──────────────────────────────
// `tna.execute` is the day's work: move a forecast, block something, record
// that it happened. `tna.manage` is the commitment: approve the baseline,
// revise it, publish templates and calendars. The distinction is the one the
// whole module rests on — a merchandiser saying "this is now expected on the
// 14th" is a fact, and saying "the 14th is what we now promise" is a decision.
// Anybody who could do both without noticing would erase the difference, and
// the difference is what makes a slip visible.
//
// Reading is `file.read`, because a plan that only its own department can see
// cannot coordinate anything.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
// No endpoint completes a `SOURCE_EVENT` milestone. Those close because a
// record was approved, through `tnaIntake.service`, and giving them a route
// would hand somebody a way to sign for an approval they did not make. The
// service refuses it; there is simply no door for it either.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle } = require("../../../services/storePurchase/errors");
const {
  CAPABILITY, merchandisingCapability,
} = require("../../../services/merchandising/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const config = require("../../../services/merchandising/tnaConfig.service");
const plans = require("../../../services/merchandising/tnaPlan.service");
const portfolio = require("../../../services/merchandising/tnaPortfolio.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canExecute = merchandisingCapability(CAPABILITY.TNA_EXECUTE);
const canManage = merchandisingCapability(CAPABILITY.TNA_MANAGE);
const canConfigure = merchandisingCapability(CAPABILITY.CONFIGURATION_MANAGE);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/* The acting company, plus the acting person's address — which the register
   needs for `assignedTo=me` and nothing else reads. Built here rather than
   widened into the shared company middleware, because one filter's
   convenience is not a reason to put an identity on every request. */
const ctx = (req) => ({ ...req.merchandising, actorEmail: req.user?.email || "" });

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ THE CROSS-FILE REGISTER ══════════════════════════════════════════════
   Before the per-file routes, because `/portfolio` must not be read as a
   file id by the `/:fileId` patterns below. */

router.get("/tna/portfolio", requireCompany, canRead, handle(async (req, res) => {
  const out = await portfolio.portfolio(ctx(req), {
    view: req.query.view, q: req.query.q, owner: req.query.owner,
    assignedTo: req.query.assignedTo, buyer: req.query.buyer, factory: req.query.factory,
    from: req.query.from, to: req.query.to,
    cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out, views: Object.keys(portfolio.PORTFOLIO_VIEWS) });
}));

router.get("/tna/portfolio/counts", requireCompany, canRead, handle(async (req, res) => {
  const out = await portfolio.portfolioCounts(ctx(req));
  return res.json({ success: true, ...out });
}));

/* ── BULK ──────────────────────────────────────────────────────────────────
   Preview reads and writes nothing; apply is `tna.execute`, the same
   authority a single forecast change needs. Doing forty at once is not a
   larger authority, and pretending it were would push people to do them one
   at a time to stay inside their own permissions. */

router.post("/tna/bulk/reschedule/preview", requireCompany, canExecute, handle(async (req, res) => {
  const out = await portfolio.bulkPreview(ctx(req), {
    rows: req.body?.rows, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/tna/bulk/reschedule/apply", requireCompany, canExecute, handle(async (req, res) => {
  const out = await portfolio.bulkApply(ctx(req), {
    previewId: req.body?.previewId, rows: req.body?.rows, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/* ═══ CONFIGURATION ════════════════════════════════════════════════════════
   Templates and calendars are company setup, not a file's record, so they sit
   behind `configuration.manage` — the same authority every other piece of
   Merchandising setup uses. Reading them is open to any Merchandising seat,
   because a merchandiser has to be able to see which template their plan came
   from in order to question a date. */

router.get("/tna/templates", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.listTemplates(ctx(req));
  return res.json({ success: true, ...out });
}));

router.post("/tna/templates", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await config.createTemplate(ctx(req), { body: req.body || {}, actor: actor(req) });
  return res.status(201).json({ success: true, ...out });
}));

/* A template's published and draft versions. The template row itself carries
   nothing but a name and its applicability, so the versions ARE the detail. */
router.get("/tna/templates/:templateId/versions", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.listVersions(ctx(req), { templateId: req.params.templateId });
  return res.json({ success: true, ...out });
}));

router.post("/tna/templates/:templateId/versions", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await config.createVersion(ctx(req), {
    templateId: req.params.templateId, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.get("/tna/templates/:templateId/versions/:versionNo", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.getVersion(ctx(req), {
    templateId: req.params.templateId, versionNo: req.params.versionNo,
  });
  return res.json({ success: true, ...out });
}));

router.patch("/tna/templates/:templateId/versions/:versionNo", requireCompany, canConfigure,
  handle(async (req, res) => {
    const out = await config.updateVersion(ctx(req), {
      templateId: req.params.templateId, versionNo: req.params.versionNo,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Publishing is where the graph is validated, the previous version's window is
   closed and the shape becomes frozen — so it is one command, not a validate
   step somebody could skip. */
router.post("/tna/templates/:templateId/versions/:versionNo/publish", requireCompany, canConfigure,
  handle(async (req, res) => {
    const out = await config.publishVersion(ctx(req), {
      templateId: req.params.templateId, versionNo: req.params.versionNo, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Retiring closes a version to NEW plans. It does not touch the plans already
   instantiated from it — those keep the version they were scheduled against,
   because a baseline that silently re-derived itself from a newer template
   would not be a baseline. */
router.post("/tna/templates/:templateId/versions/:versionNo/retire", requireCompany, canConfigure,
  handle(async (req, res) => {
    const out = await config.retireVersion(ctx(req), {
      templateId: req.params.templateId, versionNo: req.params.versionNo, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Which template a file WOULD get, and why — so a merchandiser can see the
   resolution before creating a plan rather than after. */
router.get("/tna/templates/resolve", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.resolveTemplateVersion(ctx(req), {
    facts: {
      buyerRef: req.query.buyerRef,
      productCategory: req.query.productCategory,
      channel: req.query.channel,
    },
    onDate: req.query.onDate,
  });
  return res.json({ success: true, ...out });
}));

router.get("/tna/calendars", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.listCalendars(ctx(req));
  return res.json({ success: true, ...out });
}));

router.post("/tna/calendars", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await config.createCalendar(ctx(req), { body: req.body || {}, actor: actor(req) });
  return res.status(201).json({ success: true, ...out });
}));

router.get("/tna/calendars/:calendarId/versions", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.listCalendarVersions(ctx(req), { calendarId: req.params.calendarId });
  return res.json({ success: true, ...out });
}));

router.post("/tna/calendars/:calendarId/versions", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await config.createCalendarVersion(ctx(req), {
    calendarId: req.params.calendarId, body: req.body || {}, actor: actor(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.patch("/tna/calendars/:calendarId/versions/:versionNo", requireCompany, canConfigure,
  handle(async (req, res) => {
    const out = await config.updateCalendarVersion(ctx(req), {
      calendarId: req.params.calendarId, versionNo: req.params.versionNo, body: req.body || {},
    });
    return res.json({ success: true, ...out });
  }));

router.post("/tna/calendars/:calendarId/versions/:versionNo/publish", requireCompany, canConfigure,
  handle(async (req, res) => {
    const out = await config.publishCalendarVersion(ctx(req), {
      calendarId: req.params.calendarId, versionNo: req.params.versionNo, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Working-day arithmetic, exposed so a screen showing "12 working days" and
   the engine that scheduled it are answering from the same calendar rather
   than from a client-side approximation of it. */
router.get("/tna/calendars/:calendarId/working-days", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.workingDays(ctx(req), {
    calendarId: req.params.calendarId, versionNo: req.query.versionNo,
    from: req.query.from, to: req.query.to,
  });
  return res.json({ success: true, ...out });
}));

router.get("/tna/reason-codes", requireCompany, canRead, handle(async (req, res) => {
  const out = await config.listReasonCodes(ctx(req), { kind: req.query.kind });
  return res.json({ success: true, ...out });
}));

router.post("/tna/reason-codes", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await config.upsertReasonCode(ctx(req), { body: req.body || {} });
  return res.json({ success: true, ...out });
}));

/* ═══ ONE FILE'S PLAN ══════════════════════════════════════════════════════ */

router.get("/files/:fileId/tna", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.getPlan(ctx(req), { fileId: req.params.fileId });
  return res.json({ success: true, ...out });
}));

/* Creating the plan is `tna.manage`: choosing the template and the start date
   is choosing the shape of the whole commitment, not executing against one. */
router.post("/files/:fileId/tna", requireCompany, canManage, handle(async (req, res) => {
  const out = await plans.createPlan(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

router.get("/files/:fileId/tna/milestones", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.listMilestones(ctx(req), {
    fileId: req.params.fileId, status: req.query.status, owner: req.query.owner,
  });
  return res.json({ success: true, ...out });
}));

/* The critical path — "what is actually holding this up", which is the
   question the register exists to answer and the reason there is no Gantt. */
router.get("/files/:fileId/tna/dependencies", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.getDependencies(ctx(req), {
    fileId: req.params.fileId, milestoneRef: req.query.milestoneRef,
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:fileId/tna/history", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.planHistory(ctx(req), {
    fileId: req.params.fileId, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ── BASELINES ─────────────────────────────────────────────────────────── */

router.get("/files/:fileId/tna/baselines", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.listBaselines(ctx(req), { fileId: req.params.fileId });
  return res.json({ success: true, ...out });
}));

router.get("/files/:fileId/tna/baselines/:baselineNo", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.getBaseline(ctx(req), {
    fileId: req.params.fileId, baselineNo: req.params.baselineNo,
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:fileId/tna/baseline/approve", requireCompany, canManage, handle(async (req, res) => {
  const out = await plans.approveBaseline(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:fileId/tna/baseline/revise", requireCompany, canManage, handle(async (req, res) => {
  const out = await plans.reviseBaseline(ctx(req), {
    fileId: req.params.fileId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

/* ── THE DAY'S WORK ────────────────────────────────────────────────────── */

router.patch("/files/:fileId/tna/milestones/:milestoneRef/forecast", requireCompany, canExecute,
  handle(async (req, res) => {
    const out = await plans.updateForecast(ctx(req), {
      fileId: req.params.fileId, milestoneRef: req.params.milestoneRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:fileId/tna/milestones/:milestoneRef/block", requireCompany, canExecute,
  handle(async (req, res) => {
    const out = await plans.blockMilestone(ctx(req), {
      fileId: req.params.fileId, milestoneRef: req.params.milestoneRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:fileId/tna/milestones/:milestoneRef/unblock", requireCompany, canExecute,
  handle(async (req, res) => {
    const out = await plans.unblockMilestone(ctx(req), {
      fileId: req.params.fileId, milestoneRef: req.params.milestoneRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:fileId/tna/milestones/:milestoneRef/complete", requireCompany, canExecute,
  handle(async (req, res) => {
    const out = await plans.completeMilestone(ctx(req), {
      fileId: req.params.fileId, milestoneRef: req.params.milestoneRef,
      body: req.body || {}, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Reopening is `tna.manage`. Undoing a recorded completion is a correction to
   the record of what happened, and that is a heavier thing than recording it. */
router.post("/files/:fileId/tna/milestones/:milestoneRef/reopen", requireCompany, canManage,
  handle(async (req, res) => {
    const out = await plans.reopenMilestone(ctx(req), {
      fileId: req.params.fileId, milestoneRef: req.params.milestoneRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* ── RESCHEDULE ────────────────────────────────────────────────────────────
   Preview is `tna.execute` — seeing the consequence of a move is part of
   deciding whether to ask for it. Approving is `tna.manage`, because a
   reschedule that breaks a commitment revises the baseline. */

router.get("/files/:fileId/tna/reschedules", requireCompany, canRead, handle(async (req, res) => {
  const out = await plans.listReschedules(ctx(req), {
    fileId: req.params.fileId, state: req.query.state,
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:fileId/tna/reschedule/preview", requireCompany, canExecute, handle(async (req, res) => {
  const out = await plans.previewReschedule(ctx(req), {
    fileId: req.params.fileId, body: req.body || {}, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/files/:fileId/tna/reschedule/:rescheduleRef/approve", requireCompany, canManage,
  handle(async (req, res) => {
    const out = await plans.approveReschedule(ctx(req), {
      fileId: req.params.fileId, rescheduleRef: req.params.rescheduleRef,
      body: req.body || {}, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:fileId/tna/reschedule/:rescheduleRef/reject", requireCompany, canManage,
  handle(async (req, res) => {
    const out = await plans.rejectReschedule(ctx(req), {
      fileId: req.params.fileId, rescheduleRef: req.params.rescheduleRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/* Withdrawal is the requester's own, so it needs no approval authority — the
   service checks it is the same person and refuses anybody else. */
router.post("/files/:fileId/tna/reschedule/:rescheduleRef/withdraw", requireCompany, canExecute,
  handle(async (req, res) => {
    const out = await plans.withdrawReschedule(ctx(req), {
      fileId: req.params.fileId, rescheduleRef: req.params.rescheduleRef, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

module.exports = router;
