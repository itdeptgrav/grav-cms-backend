// services/reporting/readOnlyProbes.js
//
// WHAT THE METABASE CONNECTION MUST NOT BE ABLE TO DO — as data, in one place.
//
// The list is shared by `scripts/reporting/verify-roles.js` (run by hand
// against the live mart) and `test/reporting/readonly-role.test.js` (run by
// CI). Two copies would drift, and the copy that drifts is the one that stops
// covering the thing that later goes wrong.
//
// Every probe is executed inside a transaction that is ROLLED BACK whatever
// happens, so running them proves the boundary without leaving anything behind
// — which is why it is safe to point them at the live mart.

"use strict";

/** SQLSTATEs. A refusal for the right reason is the only pass. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_FUNCTION = "42883";
const FEATURE_NOT_SUPPORTED = "0A000";

/* For the cross-database probes these all mean "there is no path", which is a
   stronger answer than a privilege refusal, not a weaker one: PostgreSQL has
   no cross-database references at all (0A000) and dblink is not installed
   (42883). */
const NO_PATH_CODES = new Set([UNDEFINED_TABLE, UNDEFINED_FUNCTION, FEATURE_NOT_SUPPORTED]);

/** Reads that must be ALLOWED — the control. Without them the rest is vacuous. */
const MUST_ALLOW = [
  ["SELECT on fact_voucher_line", "SELECT count(*) FROM reporting.fact_voucher_line"],
  ["SELECT on v_general_ledger", "SELECT count(*) FROM reporting.v_general_ledger"],
  ["SELECT on v_trial_balance", "SELECT count(*) FROM reporting.v_trial_balance"],
];

/** Everything that must be REFUSED. `noPath` accepts "cannot even see it". */
const MUST_REFUSE = [
  // ── writes ──
  {
    label: "INSERT into fact_voucher_line",
    sql: `INSERT INTO reporting.fact_voucher_line
            (organization_id, company_id, source_id, voucher_id, line_no, voucher_date,
             voucher_type, voucher_status, period_month, ledger_name, dr_cr,
             amount, debit, credit, signed_amount, synced_at)
          VALUES ('x','x','readonly-probe','x',1,'2026-01-01','journal','posted','2026-01-01',
                  'x','Dr',1,1,0,1, now())`,
  },
  { label: "UPDATE fact_voucher_line", sql: "UPDATE reporting.fact_voucher_line SET amount = 0" },
  { label: "DELETE from fact_voucher_line", sql: "DELETE FROM reporting.fact_voucher_line" },
  { label: "UPDATE dim_company", sql: "UPDATE reporting.dim_company SET company_name = 'x'" },
  { label: "DELETE from dim_ledger", sql: "DELETE FROM reporting.dim_ledger" },
  {
    label: "INSERT into mart_sync_run",
    sql: "INSERT INTO reporting.mart_sync_run (run_key, run_mode, started_at, status) " +
         "VALUES (gen_random_uuid(),'x',now(),'running')",
  },
  { label: "TRUNCATE fact_voucher_line", sql: "TRUNCATE reporting.fact_voucher_line" },

  // ── DDL ──
  { label: "CREATE TABLE in reporting", sql: "CREATE TABLE reporting.readonly_probe (x int)" },
  { label: "CREATE TABLE in public", sql: "CREATE TABLE public.readonly_probe (x int)" },
  { label: "CREATE SCHEMA", sql: "CREATE SCHEMA readonly_probe" },
  { label: "DROP a mart table", sql: "DROP TABLE reporting.fact_voucher_line" },
  { label: "ALTER a mart table", sql: "ALTER TABLE reporting.dim_company ADD COLUMN probe int" },
  { label: "CREATE a view", sql: "CREATE VIEW reporting.readonly_probe_view AS SELECT 1" },

  // ── escalation ──
  { label: "become the sync role", sql: "SET ROLE reporting_sync" },
  { label: "create a role", sql: "CREATE ROLE readonly_probe LOGIN" },
  { label: "read the schema-migration log", sql: "SELECT * FROM reporting.schema_migration" },

  // ── Metabase's own application database ──
  // It is on a SEPARATE SERVER, so there is no path at all. Asserted rather
  // than assumed, because the topology is a decision a deployment could change.
  {
    label: "reach a metabase_app table",
    sql: "SELECT * FROM metabase_app.public.core_user LIMIT 1",
    noPath: true,
  },
  {
    label: "cross-database query to metabase_app",
    sql: "SELECT * FROM dblink('dbname=metabase_app','SELECT 1') AS t(x int)",
    noPath: true,
  },

  // ── sequences: nextval is a write ──
  {
    label: "nextval on the line-id sequence",
    sql: "SELECT nextval('reporting.fact_voucher_line_line_id_seq')",
    noPath: true,
  },
];

/** Run one must-refuse probe. Always rolls back. */
async function probeRefusal(client, { label, sql, noPath = false }) {
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("ROLLBACK");
    return { label, ok: false, outcome: "SUCCEEDED — this is a hole" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === INSUFFICIENT_PRIVILEGE) {
      return { label, ok: true, outcome: "refused (insufficient privilege)" };
    }
    if (noPath && NO_PATH_CODES.has(err.code)) {
      return { label, ok: true, outcome: `no path (${err.code})` };
    }
    return {
      label,
      ok: false,
      outcome: `failed for the WRONG reason: ${err.code || "?"} ${err.message.split("\n")[0]}`,
    };
  }
}

/** Run one must-allow probe. */
async function probeAllowed(client, [label, sql]) {
  try {
    const res = await client.query(sql);
    return { label, ok: true, outcome: `allowed (${res.rowCount ?? res.rows.length} row(s))` };
  } catch (err) {
    return { label, ok: false, outcome: `REFUSED but should be allowed: ${err.message.split("\n")[0]}` };
  }
}

/**
 * Attempt to grant itself write, then assert the privilege did NOT move.
 *
 * PostgreSQL answers a GRANT from a role with no grant option with a WARNING,
 * not an ERROR: the statement completes and nothing is granted. So watching for
 * an exception would report a hole that does not exist — and would say nothing
 * at all if the privilege ever DID move while the statement still completed.
 * The effect is the thing to measure.
 */
async function probeSelfGrant(client) {
  const label = "grant itself write (privilege must not move)";
  try {
    await client.query("BEGIN");
    await client.query("GRANT INSERT ON reporting.fact_voucher_line TO metabase_reader");
    const { rows } = await client.query(
      "SELECT has_table_privilege('metabase_reader','reporting.fact_voucher_line','INSERT') AS granted",
    );
    await client.query("ROLLBACK");
    return rows[0].granted
      ? { label, ok: false, outcome: "INSERT WAS GRANTED — this is a hole" }
      : { label, ok: true, outcome: "no privilege moved (PostgreSQL warns and grants nothing)" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === INSUFFICIENT_PRIVILEGE) {
      return { label, ok: true, outcome: "refused (insufficient privilege)" };
    }
    return { label, ok: false, outcome: `failed for the WRONG reason: ${err.code}` };
  }
}

/** Every probe, in order. Returns `{label, ok, outcome}[]`. */
async function runAll(client) {
  const results = [];
  for (const p of MUST_ALLOW) results.push(await probeAllowed(client, p));
  results.push(await probeSelfGrant(client));
  for (const p of MUST_REFUSE) results.push(await probeRefusal(client, p));
  return results;
}

module.exports = {
  MUST_ALLOW,
  MUST_REFUSE,
  NO_PATH_CODES,
  INSUFFICIENT_PRIVILEGE,
  probeRefusal,
  probeAllowed,
  probeSelfGrant,
  runAll,
};
