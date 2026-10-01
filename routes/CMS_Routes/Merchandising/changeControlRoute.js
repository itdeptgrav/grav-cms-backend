// routes/CMS_Routes/Merchandising/changeControlRoute.js
//
// M7 — CHANGE CONTROL, BULK, REPORTS, EXPORTS, ARCHIVE AND OPS.
//
// The fifth and last router on the Merchandising mount. Everything here is
// either about a change Sales authorised, or about operating the app at
// company scale — and none of it is a daily destination: the navigation stays
// at three entries and these are reached from the file, from settings, or from
// a management page.
//
// ── THE ROUTES THAT DO NOT EXIST ────────────────────────────────────────────
// There is no route that CREATES a change — that is Sales', on Sales' router.
// There is no route that writes another application's acknowledgement — those
// arrive as events from the applications that own them. And there is no route
// that deletes anything: archiving sets a flag, and audit and version history
// are append-only everywhere.
//
// ── CAPABILITIES ARE THE EXISTING FOURTEEN ──────────────────────────────────
// M7 adds no capability constant. A bulk command asks for exactly what its
// single-record equivalent asks for — doing forty at once is the same
// authority applied more times, and a separate "bulk" capability would have
// been a way around the real ones.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle, fail } = require("../../../services/storePurchase/errors");
const {
  CAPABILITY, merchandisingCapability, requireMerchandisingCapability,
} = require("../../../services/merchandising/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const change = require("../../../services/merchandising/changeControl.service");
const bulk = require("../../../services/merchandising/bulk.service");
const reports = require("../../../services/merchandising/reports.service");
const exporter = require("../../../services/merchandising/export.service");
const archive = require("../../../services/merchandising/archive.service");
const ops = require("../../../services/merchandising/ops.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "Merchandising" });
const canRead = merchandisingCapability(CAPABILITY.FILE_READ);
const canCoordinate = merchandisingCapability(CAPABILITY.CHANGE_COORDINATE);
const canConfigure = merchandisingCapability(CAPABILITY.CONFIGURATION_MANAGE);
const canExport = merchandisingCapability(CAPABILITY.EXPORT);
const canSubmit = merchandisingCapability(CAPABILITY.HANDOVER_SUBMIT);

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

const idempotencyKey = (req) => String(
  req.get("Idempotency-Key") || req.body?.idempotencyKey || "",
).trim();

/* ═══ CHANGE CONTROL ═══════════════════════════════════════════════════════ */

router.get("/files/:id/changes", requireCompany, canRead, handle(async (req, res) => {
  const out = await change.listChanges(req.merchandising, {
    fileId: req.params.id, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/files/:id/changes/:changeRef", requireCompany, canRead, handle(async (req, res) => {
  const out = await change.getChange(req.merchandising, {
    fileId: req.params.id, changeRef: req.params.changeRef,
  });
  return res.json({ success: true, ...out });
}));

/** Merchandising's answer to Sales. No refusal exists — see the service. */
router.post("/files/:id/changes/:changeRef/acknowledge", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.acknowledgeChange(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/changes/:changeRef/clarify", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.clarifyChange(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      body: req.body || {}, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/** Assess: record what the change costs. Revises nothing — see the service. */
router.post("/files/:id/changes/:changeRef/impact", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.assessImpact(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      body: req.body || {}, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

/**
 * Record a revision this change produced.
 *
 * Takes a NUMBER. The revision itself was created through its own tab, by the
 * service that owns it, with that service's own guards — this only records
 * which one, so "what did this change actually produce" is answerable.
 */
router.post("/files/:id/changes/:changeRef/impact/produced", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.recordProducedRevision(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/changes/:changeRef/impact/coordinate", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.coordinateImpact(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      body: req.body || {}, actor: actor(req), idempotencyKey: idempotencyKey(req),
    });
    return res.json({ success: true, ...out });
  }));

router.post("/files/:id/changes/:changeRef/impact/close", requireCompany, canCoordinate,
  handle(async (req, res) => {
    const out = await change.closeImpact(req.merchandising, {
      fileId: req.params.id, changeRef: req.params.changeRef,
      body: req.body || {}, actor: actor(req),
    });
    return res.json({ success: true, ...out });
  }));

/** The cross-file change portfolio. */
router.get("/changes", requireCompany, canRead, handle(async (req, res) => {
  const out = await change.listPortfolio(req.merchandising, {
    state: req.query.state, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ═══ BULK ═════════════════════════════════════════════════════════════════
   Each command's capability is read from the service's own map, so the route
   cannot drift from what the command actually needs — and a new command
   cannot arrive without one. */

const bulkCapability = (req, res, next) => {
  const capability = bulk.capabilityFor(req.params.command);
  if (!capability) {
    return handle(async () => {
      throw fail("BULK_COMMAND_UNKNOWN", `"${req.params.command}" is not a bulk command.`,
        { allowed: bulk.BULK_COMMANDS });
    })(req, res, next);
  }
  return merchandisingCapability(capability)(req, res, next);
};

router.post("/bulk/:command/preview", requireCompany, bulkCapability, handle(async (req, res) => {
  const out = await bulk.preview(req.merchandising, {
    command: req.params.command, rows: req.body?.rows, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/bulk/:command/apply", requireCompany, bulkCapability, handle(async (req, res) => {
  const out = await bulk.apply(req.merchandising, {
    command: req.params.command, previewId: req.body?.previewId, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/** The per-row outcomes, as a file. Behind EXPORT, like every other download. */
router.get("/bulk/results/:previewId.csv", requireCompany, canExport, handle(async (req, res) => {
  const out = await bulk.resultCsv(req.merchandising, { previewId: req.params.previewId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
  return res.send(out.csv);
}));

/* ═══ REPORTS ══════════════════════════════════════════════════════════════ */

router.get("/reports", requireCompany, canRead, handle(async (req, res) => (
  res.json({ success: true, reports: reports.REPORT_KEYS })
)));

router.get("/reports/:report", requireCompany, canRead, handle(async (req, res) => {
  const out = await reports.run(req.merchandising, {
    report: req.params.report,
    options: {
      hours: req.query.hours,
      includeArchived: req.query.includeArchived === "true",
    },
  });
  return res.json({ success: true, ...out });
}));

/* ═══ EXPORTS ══════════════════════════════════════════════════════════════ */

router.get("/exports", requireCompany, canExport, handle(async (req, res) => (
  res.json({ success: true, datasets: exporter.EXPORT_KEYS })
)));

router.get("/exports/:dataset.csv", requireCompany, canExport, handle(async (req, res) => {
  const out = await exporter.generate(req.merchandising, {
    dataset: req.params.dataset,
    /* The caller's CURRENT filtered view — an export is a format, not a
       wider read. */
    filters: {
      lifecycleStatus: req.query.lifecycleStatus,
      status: req.query.status,
      owner: req.query.owner,
      family: req.query.family,
      state: req.query.state,
      department: req.query.department,
      buyerRef: req.query.buyerRef,
      recordType: req.query.recordType,
      from: req.query.from,
      to: req.query.to,
      includeArchived: req.query.includeArchived === "true",
    },
    actor: actor(req),
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
  return res.send(out.csv);
}));

/* ═══ ARCHIVE ══════════════════════════════════════════════════════════════ */

router.get("/archive/eligible", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await archive.eligible(req.merchandising, {
    olderThanDays: req.query.olderThanDays, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.post("/archive/:fileId/restore", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await archive.restoreFile(req.merchandising, {
    fileId: req.params.fileId, reason: req.body?.reason, actor: actor(req),
  });
  return res.json({ success: true, ...out });
}));

/* ═══ OPS ══════════════════════════════════════════════════════════════════
   Manager-only, and every figure is a query run when somebody asks. Nothing
   here polls, schedules or claims to monitor. */

router.get("/ops/outbox", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await ops.outboxHealth(req.merchandising);
  return res.json({ success: true, ...out });
}));

router.get("/ops/stuck", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await ops.stuck(req.merchandising, {
    minutes: req.query.minutes, attempts: req.query.attempts, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

router.get("/ops/intake", requireCompany, canConfigure, handle(async (req, res) => {
  const out = await ops.intakeHealth(req.merchandising, { hours: req.query.hours });
  return res.json({ success: true, ...out });
}));

/** Drain by hand. Every carrier is idempotent, so this is safe to repeat. */
router.post("/ops/retry", requireCompany, canSubmit, handle(async (req, res) => {
  const out = await ops.retryAll(req.merchandising, { limit: req.body?.limit });
  return res.json({ success: true, ...out });
}));

module.exports = router;
