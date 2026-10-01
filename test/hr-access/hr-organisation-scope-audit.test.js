"use strict";
/**
 * HRMS CHUNK 2A — the audit runner is read-only, and says nothing it should not.
 *
 * Two properties matter here and neither is provable by running the thing
 * against a database:
 *
 *   1. IT CANNOT WRITE. Asserted against the source, because "we did not
 *      observe a write" is not the same claim as "there is no write path". A
 *      future edit that adds a `save`, an `updateOne` or a `bulkWrite` fails
 *      this test rather than the database.
 *   2. IT CANNOT LEAK. The report is checked against the prohibited-field list
 *      before it is printed, and the run aborts rather than print. The
 *      redaction test drives that check with a report that does leak.
 */

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const AUDIT_PATH = path.join(__dirname, "../../scripts/audits/hrOrganisationScope.js");
const source = fs.readFileSync(AUDIT_PATH, "utf8");

/**
 * The source with its comments removed.
 *
 * The write-path assertions run against THIS, not the raw file, because the
 * script documents what it refuses to do — "there is no `--apply`", "nothing
 * here saves" — and a scan of the raw text would flag the file's own promise as
 * a violation of itself. What is asserted is that no such CODE exists.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

const audit = require("../../scripts/audits/hrOrganisationScope");
const { containsPrivateData } = require("../../services/access/hrScopeClassifier");

describe("the audit has no write path", () => {
  /* Mongoose's mutating verbs. Matched as CALLS — `.save(` rather than the bare
     word — so the file's own prose about not writing does not trip it. */
  const WRITE_CALLS = [
    "\\.save\\(", "\\.insertOne\\(", "\\.insertMany\\(", "\\.create\\(",
    "\\.updateOne\\(", "\\.updateMany\\(", "\\.replaceOne\\(",
    "\\.findOneAndUpdate\\(", "\\.findByIdAndUpdate\\(",
    "\\.findOneAndReplace\\(", "\\.findOneAndDelete\\(",
    "\\.findByIdAndDelete\\(", "\\.deleteOne\\(", "\\.deleteMany\\(",
    "\\.remove\\(", "\\.bulkWrite\\(", "\\.createIndex\\(", "\\.dropIndex\\(",
    "\\.collection\\.", "\\$set\\b", "\\$unset\\b", "\\$inc\\b", "\\$pull\\b",
    /* The two aggregation stages that write. `$push` is deliberately NOT here:
       it is an accumulator in a read pipeline as often as an update operator,
       and this script uses it that way to gather ids for a duplicate group. */
    "\\$merge\\b", "\\$out\\b",
  ];

  test.each(WRITE_CALLS)("contains no %s", (pattern) => {
    expect(code).not.toMatch(new RegExp(pattern));
  });

  test("has no --apply, repair or fix mode", () => {
    for (const flag of ["--apply", "--fix", "--repair", "--backfill", "--write", "--migrate"]) {
      expect(code).not.toContain(flag);
    }
  });

  test("the only command-line flag it reads is --json", () => {
    const flags = [...code.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(flags)]).toEqual(["--json"]);
  });

  test("only read verbs appear", () => {
    /* A positive statement to go with the negative ones: the script does query
       the database, and these are the only ways it does so. */
    expect(code).toMatch(/\.find\(/);
    expect(code).toMatch(/countDocuments\(/);
    expect(code).toMatch(/\.aggregate\(/);
  });

  test("it does not create or drop indexes — that is Chunk 2B", () => {
    expect(code).not.toMatch(/createIndex|ensureIndex|syncIndexes|dropIndex/);
  });
});

describe("environment identity is printed without credentials", () => {
  const withEnv = (uri, nodeEnv, fn) => {
    const before = { uri: process.env.MONGODB_URI, env: process.env.NODE_ENV };
    if (uri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = uri;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    try {
      return fn();
    } finally {
      if (before.uri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = before.uri;
      if (before.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before.env;
    }
  };

  test("the username, password and connection string never appear", () => {
    const described = withEnv(
      "mongodb+srv://hruser:sup3rs3cret@cluster0.abcd.mongodb.net/grav_clothing?retryWrites=true",
      "development",
      () => audit.describeDatabaseSafely(),
    );

    const text = JSON.stringify(described);
    expect(text).not.toMatch(/sup3rs3cret|hruser|mongodb\+srv|retryWrites/);
    /* …and it still identifies the database, which is the whole point. */
    expect(described.databaseHost).toBe("cluster0.abcd.mongodb.net");
    expect(String(described.databaseName)).toMatch(/grav_clothing|test/);
  });

  test("an unparseable or absent URI degrades to 'unknown', not to a crash", () => {
    expect(() => withEnv("not-a-uri", "development", () => audit.describeDatabaseSafely())).not.toThrow();
    expect(() => withEnv(undefined, "development", () => audit.describeDatabaseSafely())).not.toThrow();
  });

  test("the report shape carries no private field", () => {
    const described = withEnv(
      "mongodb://localhost:27017/grav_clothing", "development",
      () => audit.describeDatabaseSafely(),
    );
    expect(containsPrivateData(described)).toEqual([]);
  });
});

describe("production is refused unless explicitly authorised", () => {
  const run = (nodeEnv, flag) => {
    const before = { env: process.env.NODE_ENV, flag: process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY };
    const exit = jest.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NODE_ENV = nodeEnv;
    if (flag === undefined) delete process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY;
    else process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY = flag;
    try {
      audit.assertSafeToRun();
      return { exited: false, code: null };
    } catch {
      return { exited: true, code: exit.mock.calls[0]?.[0] ?? null };
    } finally {
      exit.mockRestore(); err.mockRestore(); warn.mockRestore();
      if (before.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before.env;
      if (before.flag === undefined) delete process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY;
      else process.env.HR_AUDIT_ALLOW_PRODUCTION_READONLY = before.flag;
    }
  };

  test("NODE_ENV=production exits without running", () => {
    expect(run("production", undefined)).toEqual({ exited: true, code: 2 });
  });

  test("the explicit read-only acknowledgement lets it proceed", () => {
    expect(run("production", "1").exited).toBe(false);
  });

  test("development runs without ceremony", () => {
    expect(run("development", undefined).exited).toBe(false);
  });
});

describe("the report is checked before it is printed", () => {
  test("a report carrying a prohibited field is detected", () => {
    /* Drives the exact guard `main()` applies to its own output. */
    const leaky = {
      scope: [{ model: "Employee", samples: { MISSING: [{ email: "asha@grav.in" }] } }],
    };
    expect(containsPrivateData(leaky)).toEqual(["scope[0].samples.MISSING[0].email"]);
  });

  test("the audit aborts rather than print one", () => {
    /* The guard's presence and its consequence, asserted on the source: an
       audit that logged the leak and carried on would still have leaked. */
    expect(source).toMatch(/containsPrivateData\(report\)/);
    expect(source).toMatch(/ABORT/);
    expect(source).toMatch(/process\.exit\(4\)/);
  });

  test("the sample limit keeps samples small", () => {
    expect(audit.SAMPLE_LIMIT).toBeLessThanOrEqual(10);
    expect(source).toMatch(/SAMPLE_LIMIT/);
  });

  test("employee queries select identity and placement only", () => {
    /* The strongest form of the redaction rule: what is never fetched cannot
       be printed by accident. */
    const select = source.match(/\.select\("_id workLocation[^"]*"\)/);
    expect(select).toBeTruthy();
    for (const forbidden of ["salary", "bankDetails", "documents", "email", "firstName", "phone"]) {
      expect(select[0]).not.toContain(forbidden);
    }
  });
});
