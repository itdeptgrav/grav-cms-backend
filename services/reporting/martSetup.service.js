// services/reporting/martSetup.service.js
//
// BUILDING AN EMPTY MART, IN THE ONE ORDER THAT WORKS.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The documented order was migrate → roles, and on a database that already had
// its roles that is fine — which is every database anybody had, so nobody hit
// the problem. On a FRESH one the two commands deadlock:
//
//   `migrate` runs every versioned migration before any repeatable one, and
//   V003__voucher_register_view.sql ends with a GRANT to `metabase_reader`.
//   That role is created by `roles`. So migrate stops at V003.
//
//   `roles` grants SELECT on the curated views, and those are created by
//   R__curated_views.sql — a REPEATABLE migration, which migrate runs last.
//   So roles cannot go first either.
//
// Neither command could go first, and a working reporting stack became an
// unrecoverable one the moment its Docker volume was lost. (The grant list in
// R__roles.sql now skips a relation that does not exist yet, which breaks the
// deadlock; this module is what makes the resulting order a single command
// nobody has to remember.)
//
// The order below is the whole point of the file:
//
//   1. roles    — create reporting_sync and metabase_reader. On a bare mart
//                 most relations do not exist yet and their grants are skipped.
//   2. migrate  — V001…Vn and then the repeatable views. V003's grant now
//                 finds the role it needs.
//   3. roles    — again, because step 2 created relations that step 1 could
//                 not grant on. This is why the roles file is REPEATABLE.
//   4. sync     — fill it from MongoDB, reconciled per company.
//   5. verify   — prove the Metabase connection can read and do nothing else.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// It never drops a database, a schema, a row or a Docker volume. Rebuilding an
// EMPTY mart and emptying a full one are different jobs, and conflating them
// is how a recovery command deletes the thing it was run to save. Emptying is
// still `make reset` in deploy/metabase-pilot, which says so in capitals.
//
// Every step is idempotent, so re-running after a failure is the normal way to
// use it: roles is repeatable, migrate skips what it has applied, sync
// rebuilds inside a transaction per company, and verify only reads.
"use strict";

/**
 * The steps, in order. `script` is the file under scripts/reporting/.
 *
 * `key` is stable and is what a test asserts on; `title` is for a human
 * reading the output. Two steps share a script and differ only in why they
 * are being run, which is exactly the thing the old documentation lost.
 */
const STEPS = Object.freeze([
  Object.freeze({
    key: "roles",
    script: "roles.js",
    argv: Object.freeze(["--apply"]),
    title: "Roles",
    why: "create reporting_sync and metabase_reader before anything grants to them",
  }),
  Object.freeze({
    key: "migrate",
    script: "migrate.js",
    argv: Object.freeze(["--apply"]),
    title: "Migrations",
    why: "tables, then the curated views",
  }),
  Object.freeze({
    key: "roles-again",
    script: "roles.js",
    argv: Object.freeze(["--apply"]),
    title: "Roles again",
    why: "grant SELECT on the relations the migrations just created",
  }),
  Object.freeze({
    key: "sync",
    script: "sync.js",
    argv: Object.freeze(["--full"]),
    title: "Full sync",
    why: "fill the mart from MongoDB, reconciled per company",
  }),
  Object.freeze({
    key: "verify",
    script: "verify-roles.js",
    argv: Object.freeze([]),
    title: "Verify read-only",
    why: "prove the Metabase connection cannot write",
  }),
]);

/** Thrown when a step fails, carrying which one and its exit code. */
class MartSetupError extends Error {
  constructor(step, code) {
    super(`${step.title} (${step.script}) failed with exit code ${code}.`);
    this.name = "MartSetupError";
    this.code = "REPORTING_SETUP_STEP_FAILED";
    this.step = step.key;
    this.exitCode = code;
  }
}

/**
 * Run the steps in order, stopping at the first failure.
 *
 * @param {object} o
 * @param {(step: object) => Promise<{code: number}>} o.run  executes one step.
 *        Injected so the ORDER can be tested without a database — and so this
 *        file never has to know how a step is spawned.
 * @param {function} [o.log]
 * @param {boolean} [o.dryRun]  print the plan, run nothing.
 * @returns {Promise<Array<{key, status}>>}
 * @throws {MartSetupError} on the first step that does not exit 0.
 */
async function runSetup({ run, log = console.log, dryRun = false } = {}) {
  if (typeof run !== "function" && !dryRun) {
    throw new TypeError("runSetup needs a `run` function.");
  }

  const results = [];
  for (const [index, step] of STEPS.entries()) {
    log(`\n[${index + 1}/${STEPS.length}] ${step.title} — ${step.why}`);

    if (dryRun) {
      results.push({ key: step.key, status: "planned" });
      continue;
    }

    const outcome = await run(step);
    const code = outcome && typeof outcome.code === "number" ? outcome.code : 0;
    if (code !== 0) {
      /* Stop here. A later step cannot be meaningful — a sync into a mart
         whose migrations failed would reconcile against a shape that is not
         the one the service expects — and carrying on would bury the line
         that actually explains the failure. */
      results.push({ key: step.key, status: "failed" });
      throw new MartSetupError(step, code);
    }
    results.push({ key: step.key, status: "ok" });
  }
  return results;
}

module.exports = { STEPS, MartSetupError, runSetup };
