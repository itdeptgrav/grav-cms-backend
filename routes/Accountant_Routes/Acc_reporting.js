// routes/Accountant_Routes/Acc_reporting.js
//
// CUSTOM REPORTS — the seven endpoints the GRAV PivotTable designer talks to.
//
// There are no report types and no templates. The user opens a blank layout and
// builds it out of a flat field catalogue; this router validates that layout,
// compiles it, and returns a matrix that is ready to render.
//
// Mounted at `/api/accountant/reporting`. The contract is
// `grav-cms/docs/accounting-reporting-api-contract.md` and the client that
// calls it is `grav-cms/lib/reporting/reportingClient.js`; both are Lane A's,
// and this file implements them rather than negotiating with them.
//
// ── THE BOUNDARY THIS FILE EXISTS TO HOLD ───────────────────────────────────
// The browser sends safe identifiers and receives labelled columns. It never
// receives — and there is no code path here that could emit — a Metabase URL,
// API key, database/table/field/question/collection id, MBQL, SQL, a Postgres
// credential or a raw column name. Failures come out as one of four GRAV codes;
// the underlying error goes to the server log and nowhere else.
//
// ── ORDER OF THE GATES, WHICH IS THE SECURITY MODEL ─────────────────────────
//   1. `accOrgAuth.orgAuth`        — a database-confirmed Accounting session.
//      Legacy CMS tokens are refused here, by Lane A's middleware, unchanged.
//   2. `canonicalReportParams`     — ONE companyId across path, query and body.
//      A request naming two is refused rather than resolved by precedence:
//      precedence is exactly how a guard gets bypassed.
//   3. `reportingCompanyScope`     — EVERY company the layout names must be in
//      the session organisation's `tallyCompanyIds`, or the whole request is
//      403. Never a partial run over the subset that passed.
//   4. permission                  — canView / canEdit / creator-or-owner.
//   5. `validateLayout`            — against the server's own catalogue.
//
// Only after all five does anything reach the engine, and the engine is handed
// `req.organization._id` and `req.companyId` — never a value from the body.
//
// ── WHY `canonicalReportParams` AND NOT JUST THE SCOPE GUARD ────────────────
// `requireCompanyScope` reads `params/query/body` itself and refuses a
// conflict, so it is already safe. The canonicaliser runs first anyway because
// it is what the rest of Lane B's report routes use, and having one request
// shape across `/reports` and `/reporting` means a fix to one is a fix to both.

"use strict";

const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const accOrgAuth = require("../../Middlewear/AccountantOrgAuthMiddleware");
const {
  canonicalReportParams,
  reportParams,
} = require("../../services/accountingReportGuard");

const catalogue = require("../../services/reporting/fieldCatalogue");
const {
  LayoutError,
  validateLayout,
  toStoredLayout,
  layoutSummary,
  safeText,
  LIMITS,
} = require("../../services/reporting/reportLayout.validate");
const { CODES, ReportingError } = require("../../services/reporting/metabaseEngine");
const { chartSupport, defaultVisualization } = require("../../services/reporting/chartCapability");
const { VizError, validateVisualization } = require("../../services/reporting/vizSettings.validate");
const freshness = require("../../services/reporting/martFreshness.service");
const { writeWorkbook } = require("../../services/reporting/workbook");
const budget = require("../../services/reporting/previewBudget");
const { createDeadline } = require("../../services/reporting/deadline");
const { Acc_CustomReport } = require("../../models/Accountant_model/Acc_CustomReport");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

/* ── The engine, injectable ─────────────────────────────────────────────────
 * Resolved through a setter rather than required at module load so route tests
 * can drive a fake adapter — every test that is about authentication, scoping
 * or validation should not also need a Metabase. The default is the real one,
 * built lazily so an unconfigured environment fails at the request rather than
 * at boot. */
let engineInstance = null;
let engineFactory = null;

function engine() {
  if (engineInstance) return engineInstance;
  const factory = engineFactory || require("../../services/reporting/metabaseEngine").createMetabaseEngine;
  engineInstance = factory({
    siteUrl: process.env.METABASE_SITE_URL,
    apiKey: process.env.METABASE_REPORTING_API_KEY,
    databaseName: process.env.METABASE_REPORTING_DATABASE || "GRAV Accounting",
  });
  return engineInstance;
}

/** Test seam. Never called in production. */
function setEngine(instance) {
  engineInstance = instance;
}

/* ── The chart bridge, injectable for the same reason ───────────────────────
 * Every test about authentication, scoping or validation should be able to run
 * without a Metabase; only the integration suite uses the real one. */
let chartsInstance = null;

function charts() {
  if (chartsInstance) return chartsInstance;
  const { createChartBridge } = require("../../services/reporting/metabaseCharts.service");
  chartsInstance = createChartBridge({
    siteUrl: process.env.METABASE_SITE_URL,
    apiKey: process.env.METABASE_REPORTING_API_KEY,
    adminApiKey: process.env.METABASE_EMBED_ADMIN_API_KEY,
    embeddingSecret: process.env.METABASE_EMBEDDING_SECRET,
    parentCollectionId: process.env.METABASE_REPORTING_COLLECTION_ID
      ? Number(process.env.METABASE_REPORTING_COLLECTION_ID)
      : null,
  });
  return chartsInstance;
}

/** Test seam. Never called in production. */
function setCharts(instance) {
  chartsInstance = instance;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Refusals                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The single exit for every failure.
 *
 * One shape, four codes, and the cause logged rather than sent. A Metabase
 * error can quote the SQL it generated and the columns it could not find;
 * a Mongo error can quote a collection and an index. Neither goes to a browser.
 */
function refuse(res, code, status, extra = {}) {
  return res.status(status).json({ ok: false, code, ...extra });
}

function onError(res, err, where) {
  if (err instanceof VizError) {
    // The settings are the caller's own; the problems name what they sent.
    return refuse(res, CODES.INVALID_SPEC, 422, { problems: err.problems.slice(0, 20) });
  }
  if (err instanceof LayoutError) {
    // The problems are the validator's own sentences, which name field LABELS
    // and never a column, table or database.
    return refuse(res, CODES.INVALID_SPEC, 422, { problems: err.problems.slice(0, 20) });
  }
  if (err instanceof ReportingError) {
    if (err.cause) console.error(`[reporting/${where}] ${err.message}:`, err.cause.message);
    else console.error(`[reporting/${where}]`, err.message);
    return refuse(res, err.code, err.status || 502, { message: err.message });
  }
  console.error(`[reporting/${where}]`, err && err.message ? err.message : err);
  return refuse(res, CODES.UNAVAILABLE, 503);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Gates                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Lane A's session gate, re-shaped into this router's refusal contract.
 *
 * `orgAuth` answers with its own JSON body and its own codes
 * (`ACCOUNTING_SESSION_UPGRADE_REQUIRED`, `NO_TOKEN`, …). The designer knows
 * four codes and treats anything else as "the service is being connected" —
 * which would be wrong and unactionable for an expired session. So the response
 * is captured and re-emitted as `REPORTING_UNAUTHORISED`. The AUTHENTICATION is
 * entirely Lane A's and is not reimplemented here; only the wording changes.
 */
function reportingAuth(req, res, next) {
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let refused = false;

  res.status = (code) => {
    if (code === 401 || code === 403) refused = code;
    return originalStatus(code);
  };
  res.json = (body) => {
    res.status = originalStatus;
    res.json = originalJson;
    if (refused) {
      return originalJson({
        ok: false,
        code: refused === 401 ? CODES.UNAUTHORISED : CODES.FORBIDDEN,
      });
    }
    return originalJson(body);
  };

  return accOrgAuth.orgAuth(req, res, (err) => {
    res.status = originalStatus;
    res.json = originalJson;
    if (err) return next(err);
    return next();
  });
}

/**
 * THE COMPANY SCOPE, FOR A LAYOUT THAT MAY NAME SEVERAL.
 *
 * The new layout carries `companyIds: [...]` so one report can compare two
 * companies side by side. Every one of them is checked INDEPENDENTLY against
 * the organisation's `tallyCompanyIds`.
 *
 * ── ALL OR NOTHING ──────────────────────────────────────────────────────────
 * If any named company is inaccessible the whole request is refused. It is NOT
 * run against the subset that passed: a report that quietly drops a company
 * returns figures that look complete and are not, and the user has no way to
 * tell — which is worse than an error they can act on. Nor does it matter that
 * the FIRST company passed; the array is checked entry by entry, because
 * "the first one was fine" is exactly the shortcut this guard exists to refuse.
 *
 * `/catalog` and the saved-report routes name a single company in the query,
 * which is the same check over a one-element list.
 */
function reportingCompanyScope({ required = true } = {}) {
  return (req, res, next) => {
    const params = reportParams(req);

    const named = [];
    if (Array.isArray(params.companyIds)) named.push(...params.companyIds);
    if (params.companyId !== undefined && params.companyId !== null) named.push(params.companyId);

    const ids = [...new Set(named.map((c) => String(c).trim()).filter(Boolean))];

    if (ids.length === 0) {
      if (!required) {
        req.companyIds = [];
        return next();
      }
      return refuse(res, CODES.INVALID_SPEC, 400);
    }
    if (ids.length > LIMITS.MAX_COMPANIES) {
      return refuse(res, CODES.INVALID_SPEC, 422, {
        problems: [`A report may cover at most ${LIMITS.MAX_COMPANIES} companies.`],
      });
    }
    if (!req.organization) return refuse(res, CODES.FORBIDDEN, 403);

    const owned = (req.organization.tallyCompanyIds || []).map(String);
    for (const id of ids) {
      if (!/^[0-9a-fA-F]{24}$/.test(id)) return refuse(res, CODES.INVALID_SPEC, 400);
      if (!owned.includes(id)) return refuse(res, CODES.FORBIDDEN, 403);
    }

    req.companyIds = ids;
    // Kept for the audit line and for single-company routes.
    req.companyId = ids[0];
    return next();
  };
}

/** A named permission from the session's stored role. */
function requirePermission(name) {
  return (req, res, next) => {
    if (req.user?.isDev) return next();
    if (req.user?.permissions?.[name] === true) return next();
    return refuse(res, CODES.FORBIDDEN, 403);
  };
}

/* `requireCompanyId` from the shared guard is deliberately NOT in this chain.
   It answers with `COMPANY_SCOPE_REQUIRED`, which is one of Lane B's report
   codes and not one of the four the designer knows — an unrecognised code is
   shown as "the reporting service is being connected", which is both wrong and
   unactionable for a request that simply forgot a parameter.
   `reportingCompanyScope` already demands a company and answers in this
   router's vocabulary. */
const guard = [reportingAuth, canonicalReportParams, reportingCompanyScope()];

/* ─────────────────────────────────────────────────────────────────────────── */
/* GET /catalog                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */
//
// Everything the designer may offer. Company-scoped even though the catalogue
// is currently identical for every company: the request names a company, so it
// is checked, and the day a field becomes company-dependent the gate is already
// in the right place.
router.get("/catalog", ...guard, requirePermission("canView"), (req, res) => {
  try {
    // ONE FLAT LIST. No subjects, no report types, no templates — the user
    // opens a blank layout and builds from these.
    return res.json(catalogue.publicCatalogue());
  } catch (err) {
    return onError(res, err, "catalog");
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* POST /preview                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */
router.post("/preview", ...guard, requirePermission("canView"), async (req, res) => {
  /* ── THE ORDER MATTERS, AND IT IS THIS ──────────────────────────────────
   * authentication → organisation from the session → every company checked
   * all-or-nothing → canView → layout validation → COMPLEXITY → the engine.
   * The first four are the `guard` chain and `requirePermission` above, which
   * is why an unowned company is refused 403 having revealed nothing about
   * whether its report would have been too expensive. */
  const startedAt = Date.now();
  const telemetry = { outcome: "ok", refusedBy: null, bytes: 0, rows: null, cost: null };
  let layout = null;

  try {
    layout = validateLayout(reportParams(req), {
      approvedCompanyIds: req.companyIds,
      mode: "preview",
    });

    /* ── THE COMPLEXITY GATE, BEFORE A SINGLE QUERY ────────────────────────
     * Judged on the COMPLETE compiled plan — a summary is a dozen queries
     * wearing one request — and computed without touching the engine, so a
     * refusal costs nothing. See services/reporting/previewBudget.js. */
    const cost = budget.estimate(layout, { organizationId: String(req.organization._id) });
    telemetry.cost = cost;
    if (!cost.allowed) {
      telemetry.outcome = "refused";
      telemetry.refusedBy = "complexity";
      return refuse(res, CODES.INVALID_SPEC, 422, budget.refusalDetails(cost));
    }

    /* Genuine freshness or nothing. Read from the latest SUCCEEDED sync run —
       never the clock, and never an attempt that failed. With several companies
       the OLDEST of their last-successful times is the honest answer: the
       report is only as fresh as its stalest company. */
    const dataAsOf = await freshnessFor(req.companyIds);

    /* ── ONE CLOCK FOR THE WHOLE REQUEST ───────────────────────────────────
     * Every query in the plan shares it, and the browser hanging up stops the
     * rest of the plan rather than leaving it running for nobody. */
    const gone = new AbortController();
    let settled = false;
    res.on("close", () => { if (!settled) gone.abort(); });
    const deadline = createDeadline({
      ms: engine().previewDeadlineMs || 20_000,
      signal: gone.signal,
    });

    const matrix = await engine().runPreview({
      layout,
      organizationId: String(req.organization._id),
      companyIds: req.companyIds,
      dataAsOf,
      deadline,
    });
    settled = true;

    /* ── THE SIZE CEILING ──────────────────────────────────────────────────
     * Measured on the finished body, because the honest size of a matrix is
     * not knowable from the layout — cardinality decides it. Over the ceiling
     * the WHOLE result is refused: a preview cut to fit would be a report
     * missing rows with nothing saying which, which is the exact failure B4
     * exists to prevent. */
    const json = JSON.stringify(matrix);
    telemetry.bytes = Buffer.byteLength(json);
    telemetry.rows = matrix.previewRowCount ?? null;
    if (!budget.withinByteCeiling(telemetry.bytes)) {
      telemetry.outcome = "refused";
      telemetry.refusedBy = "size";
      return refuse(res, CODES.INVALID_SPEC, 422, {
        ...budget.refusalDetails(cost),
        message: budget.TOO_LARGE,
      });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(json);
  } catch (err) {
    /* A superseded preview is a person typing, not a crash. Nobody is at the
       other end, so there is nothing to answer and nothing to shout about. */
    if (err && err.clientGone) {
      telemetry.outcome = "cancelled";
      telemetry.refusedBy = "client";
      return res.end();
    }
    if (err && err.timedOut) {
      telemetry.outcome = "refused";
      telemetry.refusedBy = "deadline";
      return refuse(res, err.code, 504, { message: err.message });
    }
    telemetry.outcome = err instanceof LayoutError ? "invalid" : "error";
    return onError(res, err, "preview");
  } finally {
    auditPreview(layout, telemetry, Date.now() - startedAt);
  }
});

/**
 * One line per preview, whatever happened to it.
 *
 * COUNTS AND OUTCOMES ONLY. No report name, no filter value, no ledger or
 * party name, no figure, no row, no query, no identifier of anything inside
 * the engine. A log that carries a company's numbers is a second copy of the
 * accounts in a place nobody is guarding.
 *
 * One line per REQUEST, not per query: a twelve-query plan that wrote twelve
 * lines would bury the one fact worth having.
 */
function auditPreview(layout, telemetry, ms) {
  const cost = telemetry.cost;
  console.log(
    "[reporting/preview]",
    JSON.stringify({
      outcome: telemetry.outcome,
      refusedBy: telemetry.refusedBy,
      mode: layout?.mode ?? null,
      queryCount: cost?.queryCount ?? null,
      rowFields: cost?.rowFields ?? null,
      columnFields: cost?.columnFields ?? null,
      values: cost?.valueColumns ?? null,
      comparisons: cost?.comparisons ?? null,
      layoutUnits: cost?.layoutUnits ?? null,
      previewRowCount: telemetry.rows,
      bytes: telemetry.bytes,
      ms,
    }),
  );
}

/**
 * "Data as of", across every company in the report.
 *
 * The oldest successful sync among them. A report covering two companies, one
 * synced an hour ago and one last week, is a week old — saying otherwise would
 * put a confident timestamp on figures that are not that fresh.
 */
async function freshnessFor(companyIds) {
  const stamps = await Promise.all((companyIds || []).map((id) => freshness.dataAsOf(id)));
  const known = stamps.filter(Boolean);
  if (!known.length || known.length !== stamps.length) return null;
  return known.sort()[0];
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* POST /export/xlsx                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */
//
// The workbook is Metabase's. This streams it through and adds a safe filename.
// There is no spreadsheet writer on this side and there must never be one — the
// contract says so on the frontend for the same reason it holds here: two
// writers means two definitions of what the report looks like.
router.post("/export/xlsx", ...guard, requirePermission("canView"), async (req, res) => {
  const params = reportParams(req);
  const startedAt = Date.now();
  let spec = null;

  try {
    /* REVALIDATED IN FULL, companies included. The preview that came before
       proves nothing: it may have run under a different catalogue, a different
       role, or not at all. */
    spec = validateLayout(params, { approvedCompanyIds: req.companyIds, mode: "export" });

    const { rows, pivoted } = await engine().runExport({
      layout: spec,
      organizationId: String(req.organization._id),
      companyIds: req.companyIds,
    });

    const filename = exportFilename(params.name, spec);

    /* ── THE WORKBOOK IS NOT THE MATRIX, AND SAYS SO ────────────────────────
     * The file is the flat aggregation behind the report: one row per
     * row/column combination. `pivot_results=true` answers HTTP 500 on this
     * instance, in every form tried, and B5 did NOT start pivoting here
     * instead (docs/decisions/metabase-pivot-export-capability.md).
     *
     * The figures are identical to the preview, to the paisa — they are the
     * same query's rows. The SHAPE is a list. Claiming parity would be the
     * kind of small lie that is discovered in a meeting, so the response says
     * plainly what is in the file rather than letting the caller assume. */
    if (!pivoted && spec.mode === "summary") {
      res.setHeader("X-Reporting-Layout", "flat-aggregation");
      res.setHeader(
        "X-Reporting-Layout-Note",
        "Same figures as the preview, as a flat list rather than the pivoted matrix.",
      );
    }
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    // A company's figures must never sit in a shared cache.
    res.setHeader("Cache-Control", "no-store, private");

    auditExport(req, spec, { ok: true, ms: Date.now() - startedAt });

    if (!Array.isArray(rows)) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine returned no rows.");
    }

    /* ── GRAV WRITES THE FILE, METABASE WROTE THE FIGURES ───────────────────
     * B5. The engine's rows go out row for row, in its order, through
     * ExcelJS's STREAMING writer straight into the response: no workbook is
     * held in memory here — not the engine's and not ours. What this side
     * decides is the heading, the cell type and the number format; see
     * `services/reporting/workbook.js`, which is not allowed to do arithmetic.
     */
    await writeWorkbook({ layout: spec, rows, stream: res, sheetName: spec.name });
    return undefined;
  } catch (err) {
    auditExport(req, spec, {
      ok: false,
      ms: Date.now() - startedAt,
      reason: err?.code || err?.message,
    });
    if (res.headersSent) return res.end();
    return onError(res, err, "export");
  }
});

/** A filename that is safe on every platform and says what the file is. */
function exportFilename(name, layout) {
  const base = safeText(name, 80) || layoutSummary(layout);
  const slug =
    String(base)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report";
  const day = new Date().toISOString().slice(0, 10);
  return `${slug}-${day}.xlsx`;
}

/**
 * One line per export, successful or not.
 *
 * An export is the moment a company's figures leave the system, so who asked
 * for what, and whether they got it, is worth a record. It carries ids and
 * counts — never values, never a credential, never the generated query.
 */
function auditExport(req, spec, { ok, ms, reason }) {
  console.log(
    "[reporting/export]",
    JSON.stringify({
      ok,
      ms,
      user: String(req.user?.id || ""),
      organization: String(req.organization?._id || ""),
      company: (req.companyIds || []).join(","),
      mode: spec?.mode || null,
      companies: (req.companyIds || []).length,
      rows: spec?.rows?.length ?? null,
      columns: spec?.columns?.length ?? null,
      values: spec?.values?.length ?? null,
      filters: spec?.filters?.length ?? null,
      comparisons: spec?.comparisons?.length ?? null,
      ...(reason ? { reason: String(reason).slice(0, 120) } : {}),
    }),
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Saved reports                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The saved-report list row.
 *
 * ── THE CONTRACT DOCUMENT'S TABLE IS STALE HERE ─────────────────────────────
 * `docs/accounting-reporting-api-contract.md` still shows the v1 row
 * (`subject`, `subjectLabel`, `companyId`, `companyName`) while the client's
 * own header — `lib/reporting/reportingClient.js`, which is the code the
 * browser runs — already expects `companyIds` and `companyNames`. Where the
 * two disagree, the code wins, and the document is corrected rather than the
 * shape bent to match it. `layoutSummary` is added because a list of reports
 * called "Untitled report" is not a list anybody can use.
 */
function listRow(doc, companyNames) {
  return {
    id: String(doc._id),
    name: doc.name,
    companyIds: (doc.companyIds || []).map(String),
    companyNames: (doc.companyIds || []).map((c) => companyNames.get(String(c)) || ""),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    layoutSummary: doc.layoutSummary || "",
    ...(doc.schemaVersion !== 2 ? { needsRecreation: true } : {}),
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* POST /chart-session                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */
//
// A two-minute ticket to look at ONE chart of THIS report.
//
// The same gates as a preview, in the same order, and then three more: can this
// report be drawn at all, is the chart the caller asked for one this result
// supports, and does a hidden question for it exist yet. What comes back is the
// least a browser needs to render it — an address, a token, and what the chart
// is. No key, no identifier of anything inside the engine, no query.
//
// ── THE LAYOUT IS VALIDATED AGAIN, EVEN WHEN IT WAS SAVED ───────────────────
// A saved report is read from Mongo and re-validated exactly as a fresh layout
// is, and its companies are re-checked against the organisation as it stands
// today. A report saved last year by someone who has since lost a company must
// not draw that company's figures because it was allowed to once.
router.post(
  "/chart-session",
  reportingAuth,
  canonicalReportParams,
  reportingCompanyScope({ required: false }),
  requirePermission("canView"),
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const params = reportParams(req);
      const { layout, companyIds, reportId, name, savedVisualization } = await layoutForChart(req, params);

      /* Can it be drawn? A refusal here is not a failure — the spreadsheet is
         still right, and the sentence says what would make it drawable. */
      const support = chartSupport(layout);
      if (!support.supported) {
        return res.json({
          ok: true,
          chartSupported: false,
          reason: support.reason,
          visualization: { type: null, supportedTypes: [] },
        });
      }

      /* What the caller asked for, or what this report was last saved with,
         or the best the shape supports — in that order. */
      const visualization = validateVisualization(
        params.visualization ?? savedVisualization ?? null,
        { shape: support.shape, types: support.types, layout },
      );

      const resolved = await engine().resolveView(layout);
      const bridge = charts();

      const card = reportId
        ? await bridge.syncSavedReport({
            organizationId: req.organization._id,
            userId: req.user?.id || null,
            reportId,
            companyIds,
            layout,
            resolved,
            visualization,
            name,
          })
        : await bridge.ensureCard({
            organizationId: req.organization._id,
            userId: req.user?.id || null,
            companyIds,
            layout,
            resolved,
            visualization,
            kind: "draft",
          });

      const embedToken = bridge.signEmbedToken(card.cardId);

      console.log(JSON.stringify({
        at: "reporting/chart-session", ok: true,
        organization: String(req.organization._id),
        user: String(req.user?.id || ""),
        companies: companyIds.length,
        mode: layout.mode,
        display: visualization.type,
        reused: card.created === false,
        saved: Boolean(reportId),
      }));

      return res.json({
        ok: true,
        metabaseInstanceUrl: publicEngineUrl(),
        embedToken,
        expiresIn: bridge.TOKEN_TTL_SECONDS,
        visualization: {
          type: visualization.type,
          supportedTypes: support.types,
          settings: visualization.requested,
        },
        chartSupported: true,
      });
    } catch (err) {
      return onError(res, err, "chart-session");
    }
  },
);

/**
 * The layout, with the keys that are ABOUT the request rather than in it.
 *
 * `visualization` and `reportId` are how a caller asks for a chart; neither is
 * part of a report layout, and the validator refuses an unrecognised key on
 * purpose — so they are removed here rather than quietly permitted there. The
 * validator's strictness is the reason a crafted payload cannot smuggle a
 * property into a stored layout, and it is not worth loosening for two keys.
 */
function layoutParams(params) {
  const { visualization, reportId, ...layout } = params || {};
  return layout;
}

/**
 * The layout a chart session is about: the body's, or a saved report's.
 *
 * A saved report brings its own companies, which are then checked the way the
 * scope guard checks a body's — `findOwnedReportById` refuses a report whose
 * companies the organisation no longer holds, so there is no path where a
 * chart is drawn over a company this session could not ask for directly.
 */
async function layoutForChart(req, params) {
  if (params.reportId) {
    const doc = await findOwnedReportById(req, params.reportId);
    if (!doc) throw new ReportingError(CODES.FORBIDDEN, "No such report.", { status: 404 });
    if (doc.schemaVersion !== 2 || !doc.layout) {
      throw new ReportingError(
        CODES.INVALID_SPEC,
        "This report was built before the designer changed and cannot be drawn. Build it again.",
        { status: 422 },
      );
    }
    const companyIds = (doc.companyIds || []).map(String);
    const layout = validateLayout(
      { ...doc.layout, name: doc.name, companyIds },
      { approvedCompanyIds: companyIds, mode: "preview" },
    );
    return {
      layout, companyIds, reportId: doc._id, name: doc.name,
      savedVisualization: doc.visualization || null,
    };
  }

  if (!req.companyIds || req.companyIds.length === 0) {
    throw new ReportingError(CODES.INVALID_SPEC, "A chart needs a company.", { status: 400 });
  }
  const layout = validateLayout(layoutParams(params), {
    approvedCompanyIds: req.companyIds,
    mode: "preview",
  });
  return {
    layout, companyIds: req.companyIds, reportId: null, name: layout.name,
    savedVisualization: null,
  };
}

/**
 * Where the browser should load the chart from.
 *
 * `METABASE_PUBLIC_URL` when the engine sits behind a proxy the browser can
 * reach; otherwise the site url this server uses. It is an ADDRESS and nothing
 * more — the browser can already do nothing there without a token, and both
 * `/api/card` and `/api/dataset` answer 401 to anyone who tries.
 */
function publicEngineUrl() {
  const url = process.env.METABASE_PUBLIC_URL || process.env.METABASE_SITE_URL || "";
  return String(url).replace(/\/+$/, "");
}

/** `findOwnedReport`, for an id that arrives in a body rather than a path. */
async function findOwnedReportById(req, id) {
  return findOwnedReport(Object.assign(Object.create(req), { params: { id: String(id) } }));
}

/**
 * GET /custom-reports
 *
 * Scoped to the organisation ALWAYS, and intersected with the companies it
 * currently owns — so a report whose company has moved to another organisation
 * stops being listed the moment ownership changes, with no cached copy here to
 * disagree with `tallyCompanyIds`.
 */
router.get(
  "/custom-reports",
  reportingAuth,
  canonicalReportParams,
  requirePermission("canView"),
  async (req, res) => {
    try {
      const organizationId = req.organization?._id;
      if (!organizationId) return refuse(res, CODES.FORBIDDEN, 403);
      const owned = (req.organization.tallyCompanyIds || []).map(String);

      const docs = await Acc_CustomReport.find({ organizationId })
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean();

      /* A report is listed only when EVERY company it covers is still the
         organisation's. A partially-visible report would open onto figures the
         caller is not entitled to for at least one of its companies. */
      const visible = docs.filter((d) =>
        (d.companyIds || []).length > 0 &&
        (d.companyIds || []).every((c) => owned.includes(String(c))),
      );

      const companies = await Acc_Company.find({ _id: { $in: owned } })
        .select("_id companyName")
        .lean();
      const names = new Map(companies.map((c) => [String(c._id), c.companyName]));

      return res.json({ reports: visible.map((d) => listRow(d, names)) });
    } catch (err) {
      return onError(res, err, "list");
    }
  },
);

/** POST /custom-reports — create. */
router.post("/custom-reports", ...guard, requirePermission("canEdit"), async (req, res) => {
  try {
    const params = reportParams(req);
    const layout = validateLayout(layoutParams(params), {
      approvedCompanyIds: req.companyIds,
      mode: "save",
    });

    const visualization = visualizationForSave(layout, params.visualization);

    const doc = await Acc_CustomReport.create({
      organizationId: req.organization._id,
      companyIds: req.companyIds.map((c) => new mongoose.Types.ObjectId(c)),
      createdBy: req.user.id,
      createdByName: req.user.name || "",
      name: layout.name,
      schemaVersion: 2,
      layoutSummary: layoutSummary(layout),
      // The REBUILT layout, never the caller's object.
      layout: toStoredLayout(layout),
      // Likewise the chart settings: rebuilt by the allowlist, or nothing.
      visualization,
    });

    return res.status(201).json({ report: await presentReport(doc, req) });
  } catch (err) {
    if (err?.code === 11000) {
      return refuse(res, CODES.INVALID_SPEC, 422, {
        problems: ["A report with that name already exists."],
      });
    }
    return onError(res, err, "create");
  }
});

/** GET /custom-reports/:id — open, re-validated against the CURRENT catalogue. */
router.get(
  "/custom-reports/:id",
  reportingAuth,
  canonicalReportParams,
  /* The report is found by id WITHIN the organisation and every company it
     covers is re-checked against `tallyCompanyIds` in `findOwnedReport`, so
     this route needs no company of its own — `required: false`. It is in the
     chain anyway so that a companyId the caller DOES name is checked rather
     than ignored, and so the scoping is visible where the route is declared
     instead of two function calls away. */
  reportingCompanyScope({ required: false }),
  requirePermission("canView"),
  async (req, res) => {
    try {
      const doc = await findOwnedReport(req);
      if (!doc) return refuse(res, CODES.FORBIDDEN, 404, { code: CODES.FORBIDDEN });
      return res.json({ report: await presentReport(doc, req) });
    } catch (err) {
      return onError(res, err, "open");
    }
  },
);

/** PUT /custom-reports/:id — update. */
router.put("/custom-reports/:id", ...guard, requirePermission("canEdit"), async (req, res) => {
  try {
    const doc = await findOwnedReport(req);
    if (!doc) return refuse(res, CODES.FORBIDDEN, 404, { code: CODES.FORBIDDEN });

    const layout = validateLayout(layoutParams(reportParams(req)), {
      approvedCompanyIds: req.companyIds,
      mode: "save",
    });

    doc.name = layout.name;
    doc.schemaVersion = 2;
    doc.companyIds = req.companyIds.map((c) => new mongoose.Types.ObjectId(c));
    doc.layout = toStoredLayout(layout);
    doc.layoutSummary = layoutSummary(layout);
    doc.visualization = visualizationForSave(layout, reportParams(req).visualization, doc.visualization);
    /* An update is a rebuild, so a v1 report that has been rewritten is now a
       v2 report and its legacy copy has served its purpose. */
    doc.legacySpecification = null;
    await doc.save();

    /* A chart of this report that somebody has already opened must not go on
       showing the layout it had before this save. Best effort on purpose: the
       report is saved either way, and a chart that could not be refreshed is
       rebuilt on the next chart session rather than failing the save. */
    await refreshSavedChart(req, doc).catch((err) =>
      console.error("[reporting/chart-sync]", err && err.message ? err.message : err));

    return res.json({ report: await presentReport(doc, req) });
  } catch (err) {
    if (err?.code === 11000) {
      return refuse(res, CODES.INVALID_SPEC, 422, {
        problems: ["A report with that name already exists."],
      });
    }
    return onError(res, err, "update");
  }
});

/**
 * DELETE /custom-reports/:id — the creator, or an owner of the organisation.
 *
 * Enforced on the SERVER against the stored `createdBy` and the session's
 * stored role. An editor may create and edit their own and may not delete
 * somebody else's.
 */
router.delete(
  "/custom-reports/:id",
  reportingAuth,
  canonicalReportParams,
  /* The report is found by id WITHIN the organisation and every company it
     covers is re-checked against `tallyCompanyIds` in `findOwnedReport`, so
     this route needs no company of its own — `required: false`. It is in the
     chain anyway so that a companyId the caller DOES name is checked rather
     than ignored, and so the scoping is visible where the route is declared
     instead of two function calls away. */
  reportingCompanyScope({ required: false }),
  requirePermission("canView"),
  async (req, res) => {
    try {
      const doc = await findOwnedReport(req);
      if (!doc) return refuse(res, CODES.FORBIDDEN, 404, { code: CODES.FORBIDDEN });

      const isCreator = String(doc.createdBy) === String(req.user.id);
      const isOwner = req.user.role === "owner" || req.user.permissions?.canManageSettings === true;
      if (!isCreator && !isOwner && !req.user.isDev) return refuse(res, CODES.FORBIDDEN, 403);

      /* The question goes before the report. `forgetSavedReport` drops the
         pointer first and archives second, so a Metabase that is down leaves a
         question nobody points at — rubbish, which the cleanup job collects —
         rather than a report pointing at a question that is not there. */
      await forgetChartFor(req, doc).catch((err) =>
        console.error("[reporting/chart-forget]", err && err.message ? err.message : err));

      await Acc_CustomReport.deleteOne({ _id: doc._id, organizationId: req.organization._id });
      return res.json({ ok: true });
    } catch (err) {
      return onError(res, err, "delete");
    }
  },
);


/**
 * The visualization to store with a saved report.
 *
 * Validated against THIS layout's own result shape, so a chart type that made
 * sense for the report before an edit is not carried over into one it no
 * longer suits. A report that cannot be drawn at all stores nothing, and an
 * unusable stored setting is dropped rather than refused — the user asked to
 * save a report, not a chart, and losing the report over a chart setting would
 * be the wrong trade.
 */
function visualizationForSave(layout, requested, previous = null) {
  const support = chartSupport(layout);
  if (!support.supported) return null;
  const wanted = requested ?? previous ?? null;
  if (!wanted) return null;
  try {
    return validateVisualization(wanted, {
      shape: support.shape, types: support.types, layout,
    }).requested;
  } catch {
    return null;
  }
}

/**
 * Bring a saved report's hidden question back in step with the report.
 *
 * Only when one EXISTS. A question is created the first time somebody asks to
 * see the chart, not the first time somebody saves a report: creating one per
 * saved report would make an administrator-credentialled call on behalf of
 * every user who never opens a chart, and leave a question in the engine for
 * every report that is only ever read as a spreadsheet. Updating what exists
 * is what keeps the promise that matters — no chart ever shows a layout the
 * report no longer has.
 */
async function refreshSavedChart(req, doc) {
  const registry = require("../../services/reporting/chartRegistry");
  const existing = await registry.findByReport({
    organizationId: req.organization._id, reportId: doc._id,
  });
  if (!existing) return { skipped: true };

  const companyIds = (doc.companyIds || []).map(String);
  const layout = validateLayout(
    { ...doc.layout, name: doc.name, companyIds },
    { approvedCompanyIds: companyIds, mode: "preview" },
  );
  const support = chartSupport(layout);
  if (!support.supported) return { skipped: true };

  const visualization = validateVisualization(doc.visualization || { type: support.types[0] }, {
    shape: support.shape, types: support.types, layout,
  });
  const resolved = await engine().resolveView(layout);
  return charts().syncSavedReport({
    organizationId: req.organization._id,
    userId: req.user?.id || null,
    reportId: doc._id,
    companyIds,
    layout,
    resolved,
    visualization,
    name: doc.name,
  });
}

/** Archive the hidden question of a report that is about to be deleted. */
async function forgetChartFor(req, doc) {
  return charts().forgetSavedReport({
    organizationId: req.organization._id,
    reportId: doc._id,
  });
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * One report, if this session may see it.
 *
 * Organisation AND current company ownership, over EVERY company the report
 * covers. A report id is an ObjectId and is not guessable, but "not guessable"
 * is not an access control — the filter is.
 */
async function findOwnedReport(req) {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(String(id))) return null;
  const organizationId = req.organization?._id;
  if (!organizationId) return null;

  const owned = (req.organization.tallyCompanyIds || []).map(String);
  const doc = await Acc_CustomReport.findOne({ _id: id, organizationId });
  if (!doc) return null;

  const covers = (doc.companyIds || []).map(String);
  if (covers.length === 0) return null;
  if (!covers.every((c) => owned.includes(c))) return null;
  return doc;
}

/**
 * The report as the contract describes it, re-validated on the way out.
 *
 * ── A STORED LAYOUT IS AS UNTRUSTED AS A FRESH ONE ──────────────────────────
 * Re-validated against the CURRENT catalogue every time it is opened, so a
 * report referring to a field that has since been withdrawn is reported as
 * stale here rather than failing later at preview with no explanation.
 *
 * ── A v1 REPORT IS NOT REINTERPRETED ────────────────────────────────────────
 * The old contract had a `subject` and a flat column list and no Values shelf.
 * There is no mapping from it to a PivotTable that is unambiguously right, so
 * it is returned marked `needsRecreation` with its original kept verbatim.
 * Guessing would produce a report that looks like the user's and totals
 * something else.
 */
async function presentReport(doc, req) {
  const companies = await Acc_Company.find({ _id: { $in: doc.companyIds || [] } })
    .select("_id companyName")
    .lean();
  const names = new Map(companies.map((c) => [String(c._id), c.companyName]));

  const base = {
    id: String(doc._id),
    name: doc.name,
    companyIds: (doc.companyIds || []).map(String),
    companyNames: (doc.companyIds || []).map((c) => names.get(String(c)) || ""),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    layoutSummary: doc.layoutSummary || "",
    createdBy: String(doc.createdBy),
    canDelete:
      String(doc.createdBy) === String(req.user?.id) ||
      req.user?.role === "owner" ||
      req.user?.permissions?.canManageSettings === true,
  };

  if (doc.schemaVersion !== 2) {
    return {
      ...base,
      schemaVersion: doc.schemaVersion || 1,
      needsRecreation: true,
      staleProblems: [
        "This report was built before the report designer changed and cannot be " +
          "opened automatically. Build it again — its old settings are kept below.",
      ],
      layout: null,
      legacySpecification: doc.legacySpecification || doc.specification || null,
    };
  }

  let staleProblems = null;
  try {
    validateLayout(
      { ...doc.layout, name: doc.name, companyIds: (doc.companyIds || []).map(String) },
      { approvedCompanyIds: (doc.companyIds || []).map(String), mode: "preview" },
    );
  } catch (err) {
    staleProblems = err instanceof LayoutError
      ? err.problems.slice(0, 20)
      : ["This report can no longer be run."];
  }

  return {
    ...base,
    schemaVersion: 2,
    layout: doc.layout,
    // The user's own chart choices. The question they are drawn with is not
    // here and never will be — it lives in reporting.report_chart, in another
    // database, with no model that could serialise it by accident.
    visualization: doc.visualization || null,
    staleProblems,
  };
}

module.exports = router;
module.exports.setEngine = setEngine;
module.exports.setCharts = setCharts;
module.exports.LIMITS = LIMITS;
