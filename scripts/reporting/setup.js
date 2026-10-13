#!/usr/bin/env node
// scripts/reporting/setup.js — build an EMPTY reporting mart, end to end.
//
//   npm run reporting:setup            # the plan, runs nothing
//   npm run reporting:setup -- --apply
//
// Roles → migrations → roles again → full sync → read-only proof, which is the
// only order that works on a fresh database. `services/reporting/martSetup.service.js`
// holds the order and the reasons; this file only spawns the steps.
//
// It stops at the first failure and exits non-zero. Every step is idempotent,
// so re-running after fixing the cause is the normal way to use it.
//
// It NEVER drops a database, schema, row or Docker volume. Emptying a mart is
// `make reset` in deploy/metabase-pilot, deliberately somewhere else.
//
// No secret is printed: each step is spawned with this process's environment
// and prints its own output, and those scripts already refuse to echo a
// connection string or a password.
"use strict";

const path = require("path");
const { spawn } = require("child_process");

const { STEPS, runSetup } = require("../../services/reporting/martSetup.service");

const APPLY = process.argv.includes("--apply");
const HERE = __dirname;

/**
 * Spawn one step as its own node process.
 *
 * A child process rather than a require() so a step that calls process.exit —
 * which every one of these CLIs does — cannot take the orchestrator with it,
 * and so each keeps its own connection pools and tears them down on its own.
 */
function spawnStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-r", "dotenv/config", path.join(HERE, step.script), ...step.argv],
      {
        // Inherited, so the child's own output is the output — including the
        // care it already takes not to print a connection string.
        stdio: "inherit",
        env: process.env,
      },
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A signal is a failure even though `code` is null.
      resolve({ code: signal ? 1 : code ?? 0 });
    });
  });
}

async function main() {
  console.log("Reporting mart — setup");
  console.log(`  mode: ${APPLY ? "APPLY" : "DRY RUN (plan only)"}`);
  console.log("  This builds an empty mart. It deletes nothing.");

  if (!APPLY) {
    console.log("\nIt would run, in this order:");
    STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s.script} ${s.argv.join(" ")}`.padEnd(42) + `— ${s.why}`));
    console.log("\nRe-run with --apply.");
    return 0;
  }

  await runSetup({ run: spawnStep });
  console.log("\nAll five steps finished. The mart is built, filled and proved read-only.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Message only — never the error object, which can carry a connection string.
    console.error(`\nFailed at step "${err.step || "?"}": ${err.message || String(err)}`);
    console.error("Nothing was deleted. Fix the cause and run it again — every step is idempotent.");
    process.exit(1);
  });
