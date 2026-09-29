// services/reporting/metabaseEngine.js
//
// THE ONLY THING IN GRAV THAT TALKS TO METABASE.
//
// It takes a specification this server has already validated and returns rows
// or a workbook stream. Nothing above it knows Metabase exists; nothing below
// it ever sees a request from a browser.
//
//   validated spec ──▶ MBQL ──▶ Metabase dataset API ──▶ rows
//                                        │
//                             read-only Postgres role
//
// ── TWO FILTERS ARE NOT NEGOTIABLE ──────────────────────────────────────────
// Every query this compiles carries `organization_id = <session's org>` and
// `company_id = <the company the scope guard approved>`, ANDed at the top of
// the filter clause. They come from arguments the route derives from the
// session — never from the specification, which has no field id that names
// either column (see fieldCatalogue.js) and therefore no way to express one.
//
// The compiler builds them FIRST and appends the user's filters after, so there
// is no ordering in which a user filter could replace one. `compileQuery` is
// exported and `test/accountant/reporting-mbql.test.js` inspects its output
// directly: the two filters are asserted present on every shape of query the
// designer can produce.
//
// ── NATIVE SQL IS NEVER SENT ────────────────────────────────────────────────
// `{"type": "query"}`, always. There is no code path in this file that emits
// `{"type": "native"}` or a `native` key, and the API key it authenticates with
// belongs to a Metabase group whose `create-queries` permission is
// `query-builder` — so even a compiler bug could not run SQL. Two independent
// layers, because the one that fails is always the one you only had one of.
//
// ── THE BROWSER NEVER SEES ANY OF THIS ──────────────────────────────────────
// No response from this module carries a Metabase URL, API key, database id,
// table id, field id, question id or raw Metabase error. `translateError` is
// the single exit for failures and it maps everything onto the four GRAV codes.

"use strict";

const catalogue = require("./fieldCatalogue");

/** GRAV's reporting error codes. The browser knows these four and no others. */
const CODES = Object.freeze({
  UNAVAILABLE: "REPORTING_UNAVAILABLE",
  UNAUTHORISED: "REPORTING_UNAUTHORISED",
  FORBIDDEN: "REPORTING_FORBIDDEN",
  INVALID_SPEC: "REPORTING_INVALID_SPEC",
});

class ReportingError extends Error {
  constructor(code, message, { status = 502, cause = null, timedOut = false, clientGone = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    // Kept for the server log only. Never serialised to a response.
    this.cause = cause;
    /** The request's own deadline ran out — not the engine's per-call one. */
    this.timedOut = timedOut;
    /** The browser hung up. Not a failure, and not an internal crash. */
    this.clientGone = clientGone;
  }
}

/** What a caller is told when the whole preview ran out of time. */
const DEADLINE_MESSAGE =
  "This report took too long to preview. Add a filter or remove part of the " +
  "breakdown and try again.";

const deadlineExpired = () => new ReportingError(CODES.UNAVAILABLE, DEADLINE_MESSAGE, {
  status: 504, timedOut: true,
});
/* Nobody is listening, so the message is for the log and never reaches a
   browser. It is NOT an error condition: a superseded preview is the normal
   behaviour of a person typing. */
const clientGone = () => new ReportingError(CODES.UNAVAILABLE, "The preview was cancelled.", {
  status: 499, clientGone: true,
});

/** How long a query may take, and how much it may return. */
const DEFAULTS = Object.freeze({
  metadataTtlMs: 5 * 60 * 1000,
  previewTimeoutMs: 30_000,
  /* One deadline for the WHOLE preview, comfortably under the per-call 30 s
     and far above every legal layout measured on the pilot (the heaviest was
     2.8 s, and six concurrent previews finished inside 1.3 s). */
  previewDeadlineMs: 20_000,
  exportTimeoutMs: 120_000,
  maxExportRows: 100_000,
});

/* The MBQL itself lives in mbqlCompiler.js — pure, so a test can read exactly
   what would be sent — and the matrix shaping in matrix.js. This file is the
   transport: authenticate, resolve ids, execute, translate failures. */
const { compilePlan, CompileError } = require("./mbqlCompiler");
const matrix = require("./matrix");

/* ─────────────────────────────────────────────────────────────────────────── */
/* The engine                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} config
 * @param {string} config.siteUrl        e.g. http://localhost:3100
 * @param {string} config.apiKey         SERVER-ONLY. Never leaves this process.
 * @param {string} config.databaseName   the Metabase database to resolve
 */
function createMetabaseEngine(config = {}) {
  const siteUrl = String(config.siteUrl || "").replace(/\/+$/, "");
  const apiKey = config.apiKey || "";
  const databaseName = config.databaseName || "GRAV Accounting";
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const opts = { ...DEFAULTS, ...config };

  /** `{ databaseId, views: { viewName: {tableId, fieldIds} }, at }` */
  let metadataCache = null;

  const configured = () => Boolean(siteUrl && apiKey);

  async function call(path, { method = "GET", body, form, timeoutMs, raw = false, deadline = null } = {}) {
    if (!configured()) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine is not configured.", {
        status: 503,
      });
    }

    /* Nothing is started past the deadline, or for a browser that has gone.
       Checking here as well as in the plan covers a single call made directly. */
    if (deadline) {
      if (deadline.aborted()) throw clientGone();
      if (deadline.expired()) throw deadlineExpired();
    }

    const controller = new AbortController();
    /* Whatever is LEFT of the request's deadline, never a fresh allowance.
       Without the min() a twelve-query plan could run for twelve times the
       timeout while every call was individually "in time". */
    const allowance = deadline
      ? Math.min(timeoutMs || opts.previewTimeoutMs, deadline.remaining())
      : (timeoutMs || opts.previewTimeoutMs);
    const timer = setTimeout(() => controller.abort(), allowance);
    const stopOnDisconnect = () => controller.abort();
    if (deadline && deadline.signal) {
      deadline.signal.addEventListener("abort", stopOnDisconnect, { once: true });
    }
    const release = () => {
      clearTimeout(timer);
      if (deadline && deadline.signal) deadline.signal.removeEventListener("abort", stopOnDisconnect);
    };

    let res;
    try {
      res = await fetchImpl(`${siteUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          "x-api-key": apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(form ? { body: form } : {}),
      });
    } catch (err) {
      release();
      if (err.name === "AbortError") {
        /* Three ways a call can be aborted, and they are three different
           events: the person left, the request ran out of time, or this one
           query hit the engine's own ceiling. */
        if (deadline && deadline.aborted()) throw clientGone();
        if (deadline && deadline.expired()) throw deadlineExpired();
        throw new ReportingError(CODES.UNAVAILABLE, "The reporting query timed out.", {
          status: 504,
          cause: err,
        });
      }
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine is unreachable.", {
        status: 503,
        cause: err,
      });
    }
    release();

    if (raw) {
      if (!res.ok) throw await translateHttp(res);
      return res;
    }

    if (!res.ok) throw await translateHttp(res);

    try {
      return await res.json();
    } catch (err) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine returned an unreadable response.", {
        status: 502,
        cause: err,
      });
    }
  }

  /**
   * Turn a Metabase HTTP failure into a GRAV code.
   *
   * The body is read for the LOG and is never attached to the thrown error's
   * message: a Metabase error can quote the SQL it generated, the column that
   * was missing and the database it ran against, and none of that is the
   * browser's business.
   */
  async function translateHttp(res) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* nothing to add */
    }
    const cause = new Error(`metabase ${res.status}: ${detail}`);

    if (res.status === 401 || res.status === 403) {
      // OUR credential is wrong, not the user's. Saying "sign in again" would
      // send a correctly-signed-in accountant round a loop they cannot fix.
      return new ReportingError(CODES.UNAVAILABLE, "The reporting engine refused this server's credentials.", {
        status: 503, cause,
      });
    }
    if (res.status === 404) {
      return new ReportingError(CODES.UNAVAILABLE, "The reporting engine has no such dataset.", {
        status: 503, cause,
      });
    }
    if (res.status === 400 || res.status === 422) {
      /* Metabase rejected the query we built. The specification passed our own
         validation, so this is a bug here, not a bad request from the browser —
         it is reported as unavailable rather than blamed on the caller. */
      return new ReportingError(CODES.UNAVAILABLE, "The reporting engine rejected the generated query.", {
        status: 502, cause,
      });
    }
    return new ReportingError(CODES.UNAVAILABLE, "The reporting engine failed.", {
      status: 502, cause,
    });
  }

  /**
   * Resolve the database, curated views and their field ids, with a TTL cache.
   *
   * Metabase's ids are its own and change when a database is re-added, so they
   * are resolved BY NAME every time the cache expires rather than configured.
   * A stale id is the failure mode that produces a confident answer from the
   * wrong table.
   */
  async function metadata({ force = false } = {}) {
    const fresh = metadataCache && Date.now() - metadataCache.at < opts.metadataTtlMs;
    if (fresh && !force) return metadataCache;

    const databases = await call("/api/database");
    const list = Array.isArray(databases) ? databases : databases?.data || [];
    const db = list.find((d) => d.name === databaseName);
    if (!db) {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting database is not connected.", {
        status: 503,
      });
    }

    const meta = await call(`/api/database/${db.id}/metadata`);
    const views = {};
    for (const table of meta.tables || []) {
      if (table.schema !== "reporting" || table.active === false) continue;
      const fieldIds = {};
      for (const f of table.fields || []) fieldIds[f.name] = f.id;
      views[table.name] = { tableId: table.id, fieldIds };
    }

    metadataCache = { databaseId: db.id, views, at: Date.now() };
    return metadataCache;
  }

  /**
   * The resolved ids for one subject's view.
   *
   * On a miss the cache is refreshed ONCE and the lookup retried, because the
   * ordinary reason is simply that this process's five-minute cache predates a
   * migration.
   *
   * ── WHY IT DOES NOT TRIGGER A METABASE RESCAN ─────────────────────────────
   * The other reason a view can be missing is that METABASE has not scanned the
   * schema since the migration ran. Asking it to would be convenient, and this
   * code did — until the request came back 403. `POST /api/database/:id/sync_schema`
   * needs an administrator, and this engine's key deliberately is not one: an
   * admin key can run native SQL, and "no SQL for the reporting path" is a
   * property of the credential, not of the code that happens to use it.
   *
   * So it stays unable to rescan, and the refusal says what to run instead. A
   * convenience worth an admin credential is not a convenience worth having.
   */
  async function resolveSubject(subjectDef, { force = false } = {}) {
    let meta = await metadata({ force });
    let view = meta.views[subjectDef.view];

    if (!view && !force) {
      meta = await metadata({ force: true });
      view = meta.views[subjectDef.view];
    }

    if (!view) {
      throw new ReportingError(
        CODES.UNAVAILABLE,
        "The reporting engine has not discovered this report type yet. " +
          "Run deploy/metabase-pilot/bootstrap.sh to rescan the schema.",
        { status: 503 },
      );
    }
    return { databaseId: meta.databaseId, tableId: view.tableId, fieldIds: view.fieldIds };
  }

  /** One query, returning its flat rows. */
  async function runQuery(payload, { timeoutMs, constraints, deadline = null } = {}) {
    const result = await call("/api/dataset", {
      method: "POST",
      body: constraints ? { ...payload, constraints } : payload,
      timeoutMs: timeoutMs || opts.previewTimeoutMs,
      deadline,
    });
    if (result.status && result.status !== "completed") {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting query did not complete.", {
        status: 502,
        cause: new Error(String(result.error || result.status).slice(0, 500)),
      });
    }
    return result?.data?.rows || [];
  }

  /**
   * Run every query a plan needs.
   *
   * Sequential rather than parallel: a pivot's six queries hit the same tables
   * on the same connection pool, and firing them together only makes them queue
   * somewhere less visible. Each is small.
   */
  async function runPlan(plan, { timeoutMs, deadline = null } = {}) {
    /* Checked BEFORE each query rather than after: once the request is out of
       time, or the browser has gone, the remaining queries are pure waste —
       they would still occupy a connection and the engine's workers. */
    const ready = () => {
      if (!deadline) return;
      if (deadline.aborted()) throw clientGone();
      if (deadline.expired()) throw deadlineExpired();
    };
    const one = (payload) => { ready(); return runQuery(payload, { timeoutMs, deadline }); };

    if (plan.mode === "detail") {
      const rows = await one(plan.main);
      const countRows = await one(plan.count);
      return { rows, totalRowCount: Number(countRows?.[0]?.[0] ?? rows.length) };
    }

    const out = { main: await one(plan.main) };
    out.rowTotals = plan.rowTotals ? await one(plan.rowTotals) : null;
    out.colTotals = plan.colTotals ? await one(plan.colTotals) : null;
    out.grand = plan.grand ? await one(plan.grand) : null;
    out.subtotals = [];
    for (const s of plan.subtotals) {
      out.subtotals.push({
        depth: s.depth,
        prefix: s.prefix,
        cells: await one(s.cells),
        total: s.total ? await one(s.total) : null,
      });
    }
    return out;
  }

  /** The matrix for a validated layout. */
  async function runPreview({ layout, organizationId, companyIds, dataAsOf = null, deadline = null }) {
    const resolved = await resolveView(layout);
    const plan = compilePlan({ layout, resolved, organizationId, companyIds, limit: layout.limit });

    if (plan.mode === "detail") {
      const { rows, totalRowCount } = await runPlan(plan, { deadline });
      return matrix.shapeDetail({ layout, rows, totalRowCount, dataAsOf });
    }

    const results = await runPlan(plan, { deadline });
    const comparisonResults = [];
    for (const c of plan.comparison || []) {
      comparisonResults.push(await runPlan({ ...c, mode: "summary" }, { deadline }));
    }

    return matrix.shapeSummary({
      layout, results, comparisonResults, dataAsOf, limit: layout.limit,
    });
  }

  /** The Metabase ids for the catalogue's source view. */
  async function resolveView(layout) {
    const viewName = require("./fieldCatalogue").SOURCE_VIEW;
    return resolveSubject({ view: viewName });
  }

  /**
   * The workbook.
   *
   * ── WHAT THIS CAN AND CANNOT PRODUCE ─────────────────────────────────────
   * Metabase's XLSX endpoint exports the FLAT AGGREGATION behind the report,
   * not the pivoted matrix. `pivot_results=true` answers HTTP 500
   * (`java.lang.NullPointerException`) in every form — verified against this
   * instance and recorded in
   * docs/decisions/metabase-pivot-export-capability.md.
   *
   * So the workbook holds the same figures as the preview, to the paisa, in a
   * flat list: one row per row/column combination with the calculations
   * alongside. The route says so in its response headers and the caller must
   * not describe it as the matrix. No spreadsheet generator has been added to
   * paper over this — that is a deliberate decision to take, not a gap to fill
   * quietly.
   */
  async function runExport({ layout, organizationId, companyIds }) {
    const resolved = await resolveView(layout);
    const plan = compilePlan({ layout, resolved, organizationId, companyIds, limit: layout.limit });

    /* The export limit, checked BEFORE the workbook is built. A refusal the
       user can act on beats a download nobody asked for. */
    if (plan.mode === "detail") {
      const countRows = await runQuery(plan.count);
      const total = Number(countRows?.[0]?.[0] ?? 0);
      if (total > opts.maxExportRows) {
        throw new ReportingError(
          CODES.INVALID_SPEC,
          `This report has ${total.toLocaleString("en-IN")} rows. An export covers at most ` +
            `${opts.maxExportRows.toLocaleString("en-IN")} — add a filter and try again.`,
          { status: 400 },
        );
      }
    }

    const payload = plan.mode === "detail"
      ? { ...plan.main, query: { ...plan.main.query, limit: undefined } }
      : plan.main;

    /* ── RAW ROWS, NOT THE ENGINE'S WORKBOOK ────────────────────────────────
     * B5: GRAV writes the workbook (headings, cell types, formats) from the
     * rows of THIS plan — the same compiled query the preview runs, with the
     * same filters, the same grouping and the same B3 order. Metabase still
     * computes every figure; only the presentation moved.
     *
     * `/api/dataset` applies a default ceiling of 2,000 bare rows unless it is
     * told otherwise (measured: an unconstrained detail query on the pilot
     * returned exactly 2,000 of 5,604 rows), which is why the constraint is
     * explicit. It is set one above the export ceiling so an oversized report
     * is DETECTED rather than silently trimmed. */
    const rows = await runQuery(payload, {
      timeoutMs: opts.exportTimeoutMs,
      constraints: {
        "max-results": opts.maxExportRows + 1,
        "max-results-bare-rows": opts.maxExportRows + 1,
      },
    });

    if (rows.length > opts.maxExportRows) {
      throw new ReportingError(
        CODES.INVALID_SPEC,
        `This report has more than ${opts.maxExportRows.toLocaleString("en-IN")} rows. ` +
          "An export covers at most that many — add a filter and try again.",
        { status: 400 },
      );
    }

    return { rows, pivoted: false, plan };
  }

  return {
    CODES,
    isConfigured: configured,
    /** The whole-request deadline a caller should give a preview. */
    previewDeadlineMs: opts.previewDeadlineMs,
    metadata,
    resolveSubject,
    resolveView,
    runPreview,
    runExport,
    runQuery,
    runPlan,
    refreshMetadata: () => metadata({ force: true }),
    /** Test seam: the plan the engine WOULD run, without running it. */
    planFor: async ({ layout, organizationId, companyIds }) => {
      const resolved = await resolveView(layout);
      return compilePlan({ layout, resolved, organizationId, companyIds, limit: layout.limit });
    },
  };
}

module.exports = {
  CODES,
  DEFAULTS,
  DEADLINE_MESSAGE,
  ReportingError,
  CompileError,
  createMetabaseEngine,
};
