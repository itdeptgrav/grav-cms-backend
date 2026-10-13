// test/reporting/mart-setup.test.js
//
// THE ORDER, AND THE COMMANDS THE DOCUMENTATION PROMISES.
//
// Two separate failures put this suite here, and neither was a bug in any
// query:
//
//   1. README, Makefile, compose.yaml and four source files told people to run
//      `npm run reporting:migrate`, `reporting:roles`, `reporting:sync` and
//      `reporting:verify-roles`. None of those commands existed. Every one of
//      those documents was correct when it was written and silently went stale.
//
//   2. The documented order — migrate, then roles — deadlocks on a FRESH
//      database: V003 grants to a role that `roles` creates, and `roles`
//      granted on views that only the repeatable migration creates. A stack
//      that was working could not be rebuilt once its volume was lost.
//
// Nothing here touches a database. The orchestrator takes its runner as an
// argument precisely so the ORDER can be proved against a mock, and so a test
// of the order can never damage the working local mart.
"use strict";

const fs = require("fs");
const path = require("path");

const { STEPS, MartSetupError, runSetup } = require("../../services/reporting/martSetup.service");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts", "reporting");

/** A runner that records what it was asked to do and always succeeds. */
function recorder(outcomes = {}) {
  const seen = [];
  return {
    seen,
    run: async (step) => {
      seen.push(step.key);
      return { code: Object.hasOwn(outcomes, step.key) ? outcomes[step.key] : 0 };
    },
  };
}

const silent = () => {};

describe("the order an empty mart has to be built in", () => {
  test("IS ROLES, MIGRATE, ROLES AGAIN, SYNC, VERIFY", async () => {
    const r = recorder();
    const results = await runSetup({ run: r.run, log: silent });

    expect(r.seen).toEqual(["roles", "migrate", "roles-again", "sync", "verify"]);
    expect(results.map((x) => x.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  test("runs the roles step TWICE, with the migrations between them", async () => {
    /* The reason the second one exists: step 1 cannot grant SELECT on a view
       that step 2 has not created yet. Dropping it leaves metabase_reader
       unable to read the curated views, which is the failure this whole
       slice began with. */
    const rolesSteps = STEPS.filter((s) => s.script === "roles.js");
    expect(rolesSteps).toHaveLength(2);

    const keys = STEPS.map((s) => s.key);
    expect(keys.indexOf("roles")).toBeLessThan(keys.indexOf("migrate"));
    expect(keys.indexOf("migrate")).toBeLessThan(keys.indexOf("roles-again"));
  });

  test("syncs only after the schema exists, and verifies last", async () => {
    const keys = STEPS.map((s) => s.key);
    expect(keys.indexOf("roles-again")).toBeLessThan(keys.indexOf("sync"));
    expect(keys.indexOf("sync")).toBeLessThan(keys.indexOf("verify"));
    expect(keys.at(-1)).toBe("verify");
  });
});

describe("stopping", () => {
  test("STOPS AT THE FIRST FAILURE AND RUNS NOTHING AFTER IT", async () => {
    const r = recorder({ migrate: 1 });
    await expect(runSetup({ run: r.run, log: silent })).rejects.toThrow(MartSetupError);

    // roles ran, migrate ran and failed, and nothing past it was attempted.
    expect(r.seen).toEqual(["roles", "migrate"]);
  });

  test("the error names the step and carries its exit code", async () => {
    const r = recorder({ sync: 3 });
    const err = await runSetup({ run: r.run, log: silent }).catch((e) => e);

    expect(err).toBeInstanceOf(MartSetupError);
    expect(err.step).toBe("sync");
    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("REPORTING_SETUP_STEP_FAILED");
    expect(err.message).toMatch(/sync\.js/);
  });

  test("a failure in the LAST step still fails the run", async () => {
    const r = recorder({ verify: 1 });
    await expect(runSetup({ run: r.run, log: silent })).rejects.toThrow(MartSetupError);
    expect(r.seen).toEqual(["roles", "migrate", "roles-again", "sync", "verify"]);
  });

  test("a dry run executes nothing at all", async () => {
    const r = recorder();
    const results = await runSetup({ run: r.run, log: silent, dryRun: true });
    expect(r.seen).toEqual([]);
    expect(results.map((x) => x.status)).toEqual(Array(STEPS.length).fill("planned"));
  });
});

describe("what the steps are allowed to be", () => {
  test("every step points at a script that exists", () => {
    for (const step of STEPS) {
      expect(fs.existsSync(path.join(SCRIPTS, step.script))).toBe(true);
    }
  });

  test("NO STEP CAN DESTROY ANYTHING", () => {
    /* A recovery command that can empty the thing it was run to rebuild is a
       foot-gun with a helpful name. Emptying stays `make reset`. */
    const forbidden = /(^|\W)(--reset|--drop|--destroy|-v|--volumes|down)(\W|$)/i;
    for (const step of STEPS) {
      for (const arg of step.argv) {
        expect(arg).not.toMatch(forbidden);
      }
      expect(step.script).not.toMatch(/reset|drop|destroy/i);
    }
    /* Comments stripped: setup.js says in words that it touches no Docker
       volume and deletes nothing, and that sentence is worth keeping. What
       must not contain those verbs is the code. */
    const setupSource = fs.readFileSync(path.join(SCRIPTS, "setup.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    expect(setupSource).not.toMatch(/docker|compose|DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE/i);
  });

  test("the orchestrator refuses to run without a runner", async () => {
    await expect(runSetup({ log: silent })).rejects.toThrow(TypeError);
  });
});

describe("the commands the documentation tells people to run", () => {
  /** Every `npm run reporting:…` anywhere in the repo's own docs and sources. */
  function documentedCommands() {
    const files = [
      "deploy/metabase-pilot/README.md",
      "deploy/metabase-pilot/Makefile",
      "deploy/metabase-pilot/compose.yaml",
      "deploy/metabase-pilot/bootstrap.sh",
      "deploy/metabase-pilot/verify.sh",
      "scripts/reporting/migrate.js",
      "scripts/reporting/roles.js",
      "scripts/reporting/sync.js",
      "scripts/reporting/setup.js",
      "scripts/reporting/verify-roles.js",
      "scripts/reporting/chart-cleanup.js",
      "migrations/reporting/roles/R__roles.sql",
    ];
    const found = new Set();
    for (const rel of files) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(/npm run (reporting:[a-z-]+)/g)) found.add(m[1]);
    }
    return [...found].sort();
  }

  test("ALL OF THEM EXIST IN package.json", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
    const documented = documentedCommands();

    // The documentation has to mention at least the five the pilot depends on.
    expect(documented.length).toBeGreaterThanOrEqual(5);

    const missing = documented.filter((c) => !Object.hasOwn(scripts, c));
    expect(missing).toEqual([]);
  });

  test("and each one points at a script file that exists", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith("reporting:")) continue;
      const m = command.match(/scripts\/reporting\/([\w.-]+\.js)/);
      expect(m).not.toBeNull();
      expect(fs.existsSync(path.join(SCRIPTS, m[1]))).toBe(true);
    }
  });
});
