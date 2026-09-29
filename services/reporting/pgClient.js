// services/reporting/pgClient.js
//
// The PostgreSQL connections the reporting mart uses, and which one is which.
//
// ── THREE URLS, THREE PRIVILEGE LEVELS ──────────────────────────────────────
// They are separate environment variables rather than one connection with a
// role switch, because the point of the split is that the sync process never
// holds credentials capable of DDL, and the Metabase credential never leaves
// Metabase and this verification script.
//
//   REPORTING_ADMIN_URL      owner. Migrations and role creation ONLY.
//   REPORTING_SYNC_URL       `reporting_sync`. DML on schema reporting only.
//   REPORTING_READONLY_URL   `metabase_reader`. SELECT only. Used here solely
//                            by scripts/reporting/verify-roles.js, to prove it
//                            cannot do anything else.
//
// A missing variable is a refusal, never a fallback to a more privileged one.
// "Fall back to admin if the sync URL is unset" is how a sync ends up running
// as the owner in the one environment nobody checked.
//
// ── NOTHING HERE LOGS A URL ─────────────────────────────────────────────────
// A Postgres connection string carries its password. `describeTarget` is the
// only thing that ever renders one, and it renders host and database only.

"use strict";

const { Pool } = require("pg");

/** host/database only — never the credentials. Safe to print and to log. */
function describeTarget(url) {
  try {
    const withoutCreds = String(url).replace(/\/\/[^@]*@/, "//");
    const u = new URL(withoutCreds);
    const db = (u.pathname || "").replace(/^\//, "") || "(default)";
    return `${u.host}/${db}`;
  } catch {
    return "(unparseable connection target)";
  }
}

/** The role a URL names, for reporting. Never the password. */
function describeRole(url) {
  try {
    const u = new URL(String(url));
    return decodeURIComponent(u.username || "") || "(no user in url)";
  } catch {
    return "(unparseable)";
  }
}

const VARIABLES = {
  admin: "REPORTING_ADMIN_URL",
  sync: "REPORTING_SYNC_URL",
  readonly: "REPORTING_READONLY_URL",
};

class MissingReportingUrl extends Error {
  constructor(kind) {
    super(
      `${VARIABLES[kind]} is not set. The reporting mart needs it for the "${kind}" role; ` +
        "it is never substituted with a more privileged connection.",
    );
    this.code = "REPORTING_URL_MISSING";
    this.variable = VARIABLES[kind];
  }
}

const pools = new Map();

/**
 * A pooled connection for one privilege level.
 *
 * @param {"admin"|"sync"|"readonly"} kind
 */
function pool(kind) {
  if (!VARIABLES[kind]) throw new Error(`Unknown reporting connection "${kind}".`);
  if (pools.has(kind)) return pools.get(kind);

  const url = process.env[VARIABLES[kind]];
  if (!url) throw new MissingReportingUrl(kind);

  const p = new Pool({
    connectionString: url,
    // A migration or a full sync is one process doing one thing; a large pool
    // would only hold idle connections against a database the app server also
    // uses. The sync's own batching is what makes it fast, not concurrency.
    max: kind === "sync" ? 4 : 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // The statement timeout is per-connection and generous: a full-refresh
    // DELETE + COPY of a large company is legitimately slow, and a timeout
    // mid-transaction would roll back work that was going to succeed.
    statement_timeout: kind === "sync" ? 600_000 : 120_000,
  });

  /* A pool emits 'error' for a connection that dies while IDLE. Unhandled, it
     takes the process down long after the query that would have reported it. */
  p.on("error", (err) => {
    console.error(`[reporting/pg:${kind}] idle client error:`, err.message);
  });

  pools.set(kind, p);
  return p;
}

/** Is a connection configured for this level? */
function isConfigured(kind) {
  return Boolean(process.env[VARIABLES[kind]]);
}

/** Where a given level points, safely renderable. */
function target(kind) {
  const url = process.env[VARIABLES[kind]];
  return url ? describeTarget(url) : "(not configured)";
}

/** The role name a given level connects as. */
function role(kind) {
  const url = process.env[VARIABLES[kind]];
  return url ? describeRole(url) : "(not configured)";
}

/** One query on a pooled connection. */
async function query(kind, text, params) {
  return pool(kind).query(text, params);
}

/**
 * Run `fn` inside one transaction on one client.
 *
 * Commits if `fn` returns, rolls back if it throws — and rethrows, so a caller
 * cannot mistake a rolled-back attempt for a completed one. This is what makes
 * "a failed sync leaves no partial results" true rather than intended.
 */
async function withTransaction(kind, fn) {
  const client = await pool(kind).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The original error is the one worth raising; this one only matters if
      // it means the connection is gone, and the pool handles that.
      console.error("[reporting/pg] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close every pool. Call at the end of a CLI; the server never needs it. */
async function closeAll() {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((p) => p.end().catch(() => {})));
}

module.exports = {
  pool,
  query,
  withTransaction,
  isConfigured,
  target,
  role,
  closeAll,
  describeTarget,
  MissingReportingUrl,
  VARIABLES,
};
