/**
 * GRAV-CMS-BACKEND/services/accountingReportGuard.js
 *
 * The request-shaping and company-scoping guard every Lane B report route runs.
 *
 * ── WHY THIS IS SHARED ──────────────────────────────────────────────────────
 * Customer reports and supplier reports have the same request shape and the
 * same authorisation hazard. The hazard is not obvious and the fix is not
 * obvious either, which makes it exactly the wrong thing to have two copies
 * of: the second copy is the one that does not get the fix.
 *
 * ── LANE BOUNDARY ───────────────────────────────────────────────────────────
 * Authentication and company MEMBERSHIP are Lane A's (`orgAuth`,
 * `requireCompanyAccess`), consumed unmodified. This module adds the two
 * things they deliberately do not do, both of which are Lane B's problem:
 *
 *   `canonicalReportParams` — one parameter object, resolved BEFORE any
 *   company check, so the id that is authorised and the id that is reported on
 *   cannot be different ones.
 *
 *   `requireCompanyId` — `requireCompanyAccess` calls `next()` when NO
 *   companyId is present (it is a membership check, not a scope check), so a
 *   report with no company scope must be failed closed here instead.
 */

"use strict";

const mongoose = require("mongoose");

/** An ObjectId, or null. Never throws — callers fail closed on null. */
function oid(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  if (!mongoose.isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/**
 * ONE REQUEST SHAPE, TWO TRANSPORTS — AND ONE COMPANY.
 *
 * "Current filtered result" sends the id of every row on screen, and a company
 * with a few thousand parties produces a query string longer than proxies and
 * access logs reliably carry — truncated silently, at which point the export
 * is of a DIFFERENT population than the one asked for, with nothing to show
 * for it. So the same parameters are accepted in a JSON body, and the caller
 * picks by length.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
 * Merging the two sources with "body wins" was a cross-company read. Lane A's
 * `requireCompanyAccess` resolves the company it authorises as
 * `req.params.companyId || req.query.companyId || req.body.companyId` —
 * query BEFORE body. A merge that let the body win therefore authorised
 * `?companyId=A` and then reported on `{"companyId":"B"}`: the membership
 * check passed on a company the caller owned while the service read one they
 * did not.
 *
 * The fix is not to match Lane A's preference order — a private ordering in a
 * file this lane must not edit is not something to depend on. It is to make
 * the ORDER IRRELEVANT: if the request carries `companyId` in more than one
 * place with more than one value, it is refused outright. What survives has
 * exactly ONE distinct company id across params, query and body, so every
 * reader — the router, Lane A's check, and any future one with any preference
 * order — necessarily resolves the same company.
 *
 * Runs BEFORE `requireCompanyId` and `requireCompanyAccess`, and its result is
 * the ONLY parameter object the handlers read.
 */
function canonicalReportParams(req, res, next) {
  const asObject = (v) =>
    v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const params = asObject(req.params);
  const query = asObject(req.query);
  const body = asObject(req.body);

  /* All three places Lane A's check looks, in its own order. `path` is
   * included even though these routes have no `:companyId` segment today, so
   * that adding one cannot reopen the hole this closes.
   *
   * An empty string is "not given", not a company — `requireCompanyAccess`
   * reads it as falsy too, so counting it as a value would invent a conflict
   * that no reader actually has. */
  const candidates = [
    ["path", params.companyId],
    ["query", query.companyId],
    ["body", body.companyId],
  ]
    .map(([where, v]) => [where, v == null ? "" : String(v).trim()])
    .filter(([, v]) => v !== "");

  const distinct = [...new Set(candidates.map(([, v]) => v))];
  if (distinct.length > 1) {
    const where = candidates.map(([w]) => w).join(" and ");
    return res.status(400).json({
      success: false,
      message: `companyId was given in the ${where} with different values. Send it once — this request cannot be authorised for one company and run against another.`,
      code: "COMPANY_SCOPE_CONFLICT",
    });
  }

  /* The merge order below no longer decides anything about authorisation:
   * after the check above there is at most one distinct companyId, so it is
   * the same value whichever source supplies it. Body-over-query still
   * applies to the REPORTING parameters — format, scope, ledgerIds and the
   * rest — none of which cross a company boundary, because ledger ids are
   * re-resolved inside the authorised company by the service. */
  req.reportParams = {
    ...query,
    ...body,
    ...(distinct.length === 1 ? { companyId: distinct[0] } : {}),
  };
  return next();
}

/**
 * A report request MUST name a company, and it must be a real ObjectId.
 *
 * Reads the canonical object, not the raw request, so it validates exactly the
 * id the handler will use.
 */
function requireCompanyId(req, res, next) {
  const raw = req.reportParams && req.reportParams.companyId;
  if (!raw || !oid(raw)) {
    return res.status(400).json({
      success: false,
      message: "A valid companyId is required for this report.",
      code: "COMPANY_SCOPE_REQUIRED",
    });
  }
  return next();
}

/** The canonical parameters, established by `canonicalReportParams`. */
function reportParams(req) {
  return req.reportParams || {};
}

/**
 * The guard chain, in order, given Lane A's two middlewares.
 *
 * Taken as arguments rather than required here so this module has no opinion
 * about — and no import of — Lane A's file.
 */
function reportGuard(orgAuth, requireCompanyAccess) {
  return [orgAuth, canonicalReportParams, requireCompanyId, requireCompanyAccess];
}

/** Turn a validation failure into one 400, listing every problem at once. */
function badRequest(res, errors) {
  return res.status(400).json({
    success: false,
    message: errors.join(" "),
    errors,
    code: "INVALID_REPORT_REQUEST",
  });
}

/**
 * `format` decides the writer. Anything else is a 400, never a default.
 *
 * `allow` narrows it per endpoint: only the statement pack can produce a ZIP,
 * and an endpoint that cannot must refuse `format=zip` rather than quietly
 * hand back a spreadsheet under a `.zip` name.
 */
function parseFormat(raw, allow = ["xlsx", "pdf", "json"]) {
  const f = String(raw || "").toLowerCase();
  const canonical = f === "excel" ? "xlsx" : f;
  return allow.includes(canonical) ? canonical : null;
}

/** One place to turn a writer failure into a response. */
function exportError(res, e, label) {
  if (e && e.code === "MODULE_NOT_FOUND") {
    return res.status(500).json({
      success: false,
      message: "Export libraries are not installed. Run: npm install exceljs pdfkit",
    });
  }
  console.error(`[${label}]`, e);
  if (res.headersSent) return res.end();
  return res.status(500).json({ success: false, message: e.message });
}

module.exports = {
  oid,
  canonicalReportParams,
  requireCompanyId,
  reportParams,
  reportGuard,
  badRequest,
  parseFormat,
  exportError,
};
