// routes/Accountant_Routes/Acc_customerReports.js
//
// READ-ONLY customer reports and their Excel / PDF exports.
//
// ── WHY A SEPARATE ROUTER ───────────────────────────────────────────────────
// `Acc_customers.js` is 2,500 lines and already holds the CRM list, the merge
// tool, the payment-verification queue and the Customer Master export. Adding
// four more endpoints and two file writers to it would have made the one file
// nobody can safely change. The calculation lives in
// `services/customerOutstanding.service.js`, the layout in
// `services/accountingExport.service.js`, and this file does nothing but
// validate a request, refuse it if it cannot be trusted, and stream the answer.
//
// ── MOUNTING ────────────────────────────────────────────────────────────────
// Mounted at /api/accountant/customers/reports and registered BEFORE the
// customers router in server.js, because that router's `GET /:customerId`
// would otherwise swallow "/reports" as a customer id.
//
// ── LANE BOUNDARY ───────────────────────────────────────────────────────────
// Authentication and company membership are Lane A's. This file CONSUMES
// `orgAuth` and `requireCompanyAccess` and does not modify them. The two
// things they deliberately do not do — one canonical parameter object resolved
// before any company check, and failing closed when no company is named — live
// in services/accountingReportGuard.js and are shared with the supplier
// reports router.
//
// ── VERBS ───────────────────────────────────────────────────────────────────
// `GET|POST /outstanding`, `GET|POST /ageing`, `GET|POST /statement-pack` and `GET /ledger/:ledgerId`. The
// POSTs exist only because a filtered export names every visible ledger and
// that list outgrows a query string; each runs the same handler as its GET.
//
// ── NOTHING HERE WRITES ─────────────────────────────────────────────────────
// Every model call is a read, on every verb — the POST included. Producing a
// report never touches a ledger, a voucher, a customer or a balance.

"use strict";

const express = require("express");
const router = express.Router();

const {
  orgAuth,
  requireCompanyAccess,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");

const reports = require("../../services/customerOutstanding.service");
const ageing = require("../../services/customerAgeing.service");
const xport = require("../../services/accountingExport.service");
const statementPack = require("../../services/partyStatementPack.service");
const partyKinds = require("../../services/partyOutstanding.service").PARTY_KINDS;

/** This router's party kind — the statement pack is party-neutral. */
const PARTY_KIND = partyKinds.customer;

/* ── Request shaping, company scoping and the shared error shapes ──────────
 * All of it in services/accountingReportGuard.js, which the supplier reports
 * router runs identically. The hazard it closes — a request authorised for one
 * company and reported on another — is not obvious, and the wrong thing to
 * have two copies of. See that file for the whole note. */
const {
  reportGuard,
  reportParams,
  badRequest,
  parseFormat,
  exportError,
} = require("../../services/accountingReportGuard");

const guard = reportGuard(orgAuth, requireCompanyAccess);

/* ────────────────────────────────────────────────────────────────────────── */
/* GET /outstanding  ·  POST /outstanding                                     */
/*                                                                            */
/* One handler, two transports — POST only because a filtered export names    */
/* every visible ledger and that list outgrows a query string. Parameters are */
/* read from `req.reportParams`, never from req.query/req.body directly, so   */
/* the company that was authorised is the company that is reported on.        */
/*                                                                            */
/* Customer Outstanding Summary — all, filtered, or an explicit selection.    */
/*   companyId       required                                                 */
/*   format          xlsx | pdf | json                                        */
/*   scope           all | filtered | selected                                */
/*   asOf            include nothing posted after this date                   */
/*   search          name / alias / GSTIN                                     */
/*   minOutstanding  materiality threshold on the balance magnitude           */
/*   balanceSide     debit | credit | both                                    */
/*   ledgerIds       repeated or comma-joined; re-resolved, never trusted     */
/* ────────────────────────────────────────────────────────────────────────── */
async function outstandingHandler(req, res) {
  const params = reportParams(req);
  const format = parseFormat(params.format || "json");
  if (!format) return badRequest(res, ['format must be "xlsx", "pdf" or "json".']);

  const { errors, filters } = reports.parseReportQuery(params);
  if (errors.length) return badRequest(res, errors);

  try {
    const report = await reports.customerOutstandingReport(filters);
    if (!report) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }

    if (format === "json") {
      return res.json({ success: true, report });
    }

    if (format === "xlsx") {
      const wb = xport.buildOutstandingWorkbook(report);
      xport.setDownloadHeaders(res, {
        contentType: xport.XLSX_CONTENT_TYPE,
        filename: xport.outstandingFilename(report, "xlsx"),
      });
      await wb.xlsx.write(res);
      return res.end();
    }

    xport.setDownloadHeaders(res, {
      contentType: xport.PDF_CONTENT_TYPE,
      filename: xport.outstandingFilename(report, "pdf"),
    });
    xport.writeOutstandingPdf(report, res);
    return undefined;
  } catch (e) {
    return exportError(res, e, "customers/reports/outstanding");
  }
}

router.get("/outstanding", ...guard, outstandingHandler);
// Same handler, same guards, same read. See `reportParams`.
router.post("/outstanding", ...guard, outstandingHandler);

/* ────────────────────────────────────────────────────────────────────────── */
/* GET /ageing  ·  POST /ageing                                               */
/*                                                                            */
/* Customer INVOICE-WISE ageing — open bills grouped by billName across       */
/* posted, non-optional vouchers, bucketed by DUE date.                       */
/*                                                                            */
/* Takes the same scope/asOf/search/ledgerIds parameters as the outstanding   */
/* summary, and shares its guard, its id re-resolution and its as-of default, */
/* so the two reports cannot disagree about which customers exist or what     */
/* date they describe. `balanceSide` is accepted and IGNORED — a bill has no  */
/* Dr/Cr side to filter on — and the applied-filters line says so rather than */
/* printing a filter that did not run.                                        */
/* ────────────────────────────────────────────────────────────────────────── */
async function ageingHandler(req, res) {
  const params = reportParams(req);
  const format = parseFormat(params.format || "json");
  if (!format) return badRequest(res, ['format must be "xlsx", "pdf" or "json".']);

  const { errors, filters } = reports.parseReportQuery(params);
  if (errors.length) return badRequest(res, errors);

  try {
    const report = await ageing.customerAgeingReport(filters);
    if (!report) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }

    if (format === "json") return res.json({ success: true, report });

    if (format === "xlsx") {
      const wb = xport.buildAgeingWorkbook(report);
      xport.setDownloadHeaders(res, {
        contentType: xport.XLSX_CONTENT_TYPE,
        filename: xport.outstandingFilename(report, "xlsx"),
      });
      await wb.xlsx.write(res);
      return res.end();
    }

    xport.setDownloadHeaders(res, {
      contentType: xport.PDF_CONTENT_TYPE,
      filename: xport.outstandingFilename(report, "pdf"),
    });
    xport.writeAgeingPdf(report, res);
    return undefined;
  } catch (e) {
    return exportError(res, e, "customers/reports/ageing");
  }
}

router.get("/ageing", ...guard, ageingHandler);
router.post("/ageing", ...guard, ageingHandler);

/* ────────────────────────────────────────────────────────────────────────── */
/* GET /statement-pack  ·  POST /statement-pack                               */
/*                                                                            */
/* Many parties' statements in ONE download — the bulk form of the individual */
/* Statement export, assembled by services/partyStatementPack.service.js from */
/* the same per-party calculation. No second balance engine.                  */
/*                                                                            */
/*   scope       all | filtered | selected, with the same exact-id rules as   */
/*               every other export: an empty filtered set stays empty        */
/*   from + to   a period pack; the opening at `from` includes earlier        */
/*               movement, exactly as the single statement does               */
/*   asOf        an all-time pack up to a date                                */
/*   format      xlsx  one workbook, Summary + Transactions                   */
/*               pdf   one document, each party on a new page                 */
/*               zip   one PDF per party plus manifest.csv                    */
/*                                                                            */
/* A pack near the 2,000-party cap is ~3 queries per party and can take       */
/* minutes; the service generates sequentially on purpose rather than opening */
/* a connection storm. See its header.                                        */
/* ────────────────────────────────────────────────────────────────────────── */
async function statementPackHandler(req, res) {
  const params = reportParams(req);
  const format = parseFormat(params.format || "json", ["xlsx", "pdf", "zip", "json"]);
  if (!format) {
    return badRequest(res, ['format must be "xlsx", "pdf", "zip" or "json".']);
  }

  const { errors, filters } = reports.parseReportQuery(params);
  if (errors.length) return badRequest(res, errors);

  try {
    const pack = await statementPack.partyStatementPack(PARTY_KIND, filters);
    if (!pack) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }

    if (format === "json") return res.json({ success: true, pack });

    if (format === "xlsx") {
      const wb = xport.buildStatementPackWorkbook(pack);
      xport.setDownloadHeaders(res, {
        contentType: xport.XLSX_CONTENT_TYPE,
        filename: xport.packFilename(pack, "xlsx"),
      });
      await wb.xlsx.write(res);
      return res.end();
    }

    if (format === "zip") {
      xport.setDownloadHeaders(res, {
        contentType: xport.ZIP_CONTENT_TYPE,
        filename: xport.packFilename(pack, "zip"),
      });
      xport.writeStatementPackZip(pack, res);
      return undefined;
    }

    xport.setDownloadHeaders(res, {
      contentType: xport.PDF_CONTENT_TYPE,
      filename: xport.packFilename(pack, "pdf"),
    });
    xport.writeStatementPackPdf(pack, res);
    return undefined;
  } catch (e) {
    /* A scope too large to generate is the caller's to narrow, not a fault —
     * and it is raised before any byte is written, so a 400 is still open. */
    if (e && e.code === "EXPORT_TOO_LARGE" && !res.headersSent) {
      return res.status(400).json({ success: false, message: e.message, code: e.code });
    }
    return exportError(res, e, "customers/reports/statement-pack");
  }
}

router.get("/statement-pack", ...guard, statementPackHandler);
router.post("/statement-pack", ...guard, statementPackHandler);


/* ────────────────────────────────────────────────────────────────────────── */
/* GET /ledger/:ledgerId                                                      */
/*                                                                            */
/* One customer's ledger / statement of account.                              */
/*   from + to   a period statement; the opening balance at `from` INCLUDES   */
/*               every posted movement before it (see the service)            */
/*   asOf        everything up to a date, opening = ledger master opening     */
/* ────────────────────────────────────────────────────────────────────────── */
router.get("/ledger/:ledgerId", ...guard, async (req, res) => {
  const params = reportParams(req);
  const format = parseFormat(params.format || "json");
  if (!format) return badRequest(res, ['format must be "xlsx", "pdf" or "json".']);

  // A statement names ONE ledger in the path, so it has no id list and no
  // scope. Say so, or `parseReportQuery`'s filtered-scope rule would reject a
  // statement that happened to arrive with `scope=filtered` on the query.
  const { errors, filters } = reports.parseReportQuery({
    ...params,
    scope: "all",
    ledgerIds: undefined,
  });
  if (errors.length) return badRequest(res, errors);

  if (!reports.oid(req.params.ledgerId)) {
    return badRequest(res, ["ledgerId is not a valid id."]);
  }

  try {
    const stmt = await reports.customerLedgerStatement({
      ...filters,
      ledgerId: req.params.ledgerId,
    });
    // Not found OR not a customer ledger of THIS company — the same answer
    // either way, so the endpoint cannot be used to probe another company's
    // chart of accounts.
    if (!stmt) {
      return res.status(404).json({
        success: false,
        message: "No customer ledger with that id in this company.",
      });
    }

    if (format === "json") {
      return res.json({ success: true, statement: stmt });
    }

    if (format === "xlsx") {
      const wb = xport.buildStatementWorkbook(stmt);
      xport.setDownloadHeaders(res, {
        contentType: xport.XLSX_CONTENT_TYPE,
        filename: xport.statementFilename(stmt, "xlsx"),
      });
      await wb.xlsx.write(res);
      return res.end();
    }

    xport.setDownloadHeaders(res, {
      contentType: xport.PDF_CONTENT_TYPE,
      filename: xport.statementFilename(stmt, "pdf"),
    });
    xport.writeStatementPdf(stmt, res);
    return undefined;
  } catch (e) {
    return exportError(res, e, "customers/reports/ledger");
  }
});

module.exports = router;
