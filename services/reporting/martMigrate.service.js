// services/reporting/martMigrate.service.js
//
// The migration runner for the reporting mart.
//
// ── TWO KINDS OF MIGRATION, FLYWAY'S NAMING ─────────────────────────────────
//
//   V<nnn>__name.sql   VERSIONED. Applied once, in version order, ever. Its
//                      checksum is recorded; if the file later changes, that is
//                      an error, not a re-run — an applied migration describes
//                      what the database actually did, and editing it makes
//                      that record a lie.
//
//   R__name.sql        REPEATABLE. Applied whenever its checksum differs from
//                      the last time it was applied, after all versioned ones.
//                      For objects that can simply be replaced — views, grants,
//                      functions — where "the file is the definition" is true.
//
// The convention is Flyway's because it is the one people already know, and
// because the failure mode it prevents (an edited applied migration) is the
// failure mode this project will otherwise hit the first time someone tweaks a
// column.
//
// ── RUNS AS THE OWNER ───────────────────────────────────────────────────────
// Migrations are DDL, so they connect as `admin`. The sync role deliberately
// cannot run them: a compromised sync should be able to refill the mart, never
// reshape it.
//
// ── EACH MIGRATION IS ONE TRANSACTION ───────────────────────────────────────
// PostgreSQL has transactional DDL, so a migration that fails half way leaves
// nothing behind. The bookkeeping row is written inside the same transaction as
// the migration it describes, so the log cannot claim a migration that did not
// apply.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const pg = require("./pgClient");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations", "reporting");

/** The bookkeeping table. Created outside the schema the migrations create. */
const SCHEMA_MIGRATION_DDL = `
  CREATE SCHEMA IF NOT EXISTS reporting;
  CREATE TABLE IF NOT EXISTS reporting.schema_migration (
    id           bigserial   PRIMARY KEY,
    filename     text        NOT NULL,
    kind         text        NOT NULL CHECK (kind IN ('versioned','repeatable')),
    version      text,
    checksum     text        NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    duration_ms  integer,
    CONSTRAINT schema_migration_filename_key UNIQUE (filename)
  );
`;

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Every migration file, in the order it must be applied.
 *
 * Versioned first, ordered by their numeric version — `V10` after `V9`, which a
 * plain string sort gets wrong. Repeatable after, alphabetically, because they
 * are views over what the versioned ones built.
 */
function loadMigrations(dir = MIGRATIONS_DIR) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name);

  const versioned = [];
  const repeatable = [];

  for (const filename of entries) {
    const sql = fs.readFileSync(path.join(dir, filename), "utf8");
    const v = filename.match(/^V(\d+)__(.+)\.sql$/);
    if (v) {
      versioned.push({
        filename,
        kind: "versioned",
        version: v[1],
        order: Number(v[1]),
        sql,
        checksum: sha256(sql),
      });
      continue;
    }
    const r = filename.match(/^R__(.+)\.sql$/);
    if (r) {
      repeatable.push({
        filename,
        kind: "repeatable",
        version: null,
        order: 0,
        sql,
        checksum: sha256(sql),
      });
      continue;
    }
    throw new Error(
      `migrations/reporting/${filename} is named neither V<n>__name.sql nor R__name.sql. ` +
        "An unrecognised file would be silently skipped, so it is refused instead.",
    );
  }

  versioned.sort((a, b) => a.order - b.order);
  repeatable.sort((a, b) => a.filename.localeCompare(b.filename));
  return [...versioned, ...repeatable];
}

/** What has been applied, keyed by filename. */
async function appliedMigrations(client) {
  const { rows } = await client.query(
    "SELECT filename, kind, version, checksum, applied_at FROM reporting.schema_migration",
  );
  return new Map(rows.map((r) => [r.filename, r]));
}

/**
 * Decide what each migration needs, without doing it.
 *
 * Exported so the CLI can show a plan before `--apply`, and so the decision is
 * testable without a database.
 */
function planMigrations(migrations, applied) {
  return migrations.map((m) => {
    const prior = applied.get(m.filename);
    if (!prior) return { ...m, action: "apply", reason: "not yet applied" };

    if (prior.checksum === m.checksum) {
      return { ...m, action: "skip", reason: "already applied, unchanged" };
    }

    if (m.kind === "repeatable") {
      return { ...m, action: "apply", reason: "changed since it was last applied" };
    }

    /* A versioned migration that has been edited since it ran. The database
       cannot be brought into line by re-running it — that is what a NEW
       versioned migration is for — and pretending otherwise would apply an
       ALTER to a schema that already has it. */
    return {
      ...m,
      action: "error",
      reason:
        `applied on ${prior.applied_at instanceof Date ? prior.applied_at.toISOString() : prior.applied_at} ` +
        "and has been edited since. Add a new V<n>__ migration instead of changing an applied one.",
    };
  });
}

/**
 * Apply everything outstanding.
 *
 * @param {object} o
 * @param {boolean} o.dryRun  plan only; nothing is executed
 * @param {function} o.log
 * @returns {Promise<{applied: string[], skipped: string[], plan: object[]}>}
 */
async function migrate({ dryRun = false, log = console.log, dir = MIGRATIONS_DIR } = {}) {
  const migrations = loadMigrations(dir);

  const admin = pg.pool("admin");
  const client = await admin.connect();

  try {
    await client.query(SCHEMA_MIGRATION_DDL);
    const applied = await appliedMigrations(client);
    const plan = planMigrations(migrations, applied);

    const broken = plan.filter((p) => p.action === "error");
    if (broken.length) {
      const detail = broken.map((b) => `  ${b.filename}: ${b.reason}`).join("\n");
      const err = new Error(`Refusing to migrate:\n${detail}`);
      err.code = "REPORTING_MIGRATION_CHECKSUM_MISMATCH";
      throw err;
    }

    const appliedNow = [];
    const skipped = [];

    for (const m of plan) {
      if (m.action === "skip") {
        skipped.push(m.filename);
        log(`  skip   ${m.filename}  (${m.reason})`);
        continue;
      }
      if (dryRun) {
        log(`  WOULD  ${m.filename}  (${m.reason})`);
        continue;
      }

      const started = Date.now();
      // One transaction per migration: PostgreSQL's DDL is transactional, so a
      // failure leaves no half-built schema and no bookkeeping row claiming it.
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO reporting.schema_migration (filename, kind, version, checksum, duration_ms)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (filename) DO UPDATE
             SET checksum = EXCLUDED.checksum,
                 applied_at = now(),
                 duration_ms = EXCLUDED.duration_ms`,
          [m.filename, m.kind, m.version, m.checksum, Date.now() - started],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        err.message = `${m.filename}: ${err.message}`;
        throw err;
      }

      appliedNow.push(m.filename);
      log(`  applied ${m.filename}  (${m.reason}, ${Date.now() - started}ms)`);
    }

    return { applied: appliedNow, skipped, plan };
  } finally {
    client.release();
  }
}

module.exports = {
  MIGRATIONS_DIR,
  loadMigrations,
  planMigrations,
  migrate,
  sha256,
};
