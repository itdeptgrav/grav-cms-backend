// test/merchandising/legacy-tooling.test.js
//
// TWO TOOLS, AND EACH ONE IS HONEST ABOUT WHAT IT DOES.
//
// There used to be one, and it lied in both directions at once: it called
// itself a migration with an `--apply` mode and a rollback identity, and its
// source contained no database write of any kind. Nobody reading the command
// line could tell that `--apply` was inert, and "rollback identity" implied a
// rollback that could not exist.
//
// So it was split along the line that actually matters — whether the tool can
// change anything:
//
//   the legacy eligibility report   reads. No --apply, no authorization flag,
//                                   no batch identity, no rollback.
//   the line-reference backfill     writes one bounded Sales-owned field.
//                                   --apply, --authorized-by, batch identity,
//                                   and a real rollback.
//
// What is pinned is the source of both, because the dangerous version of
// either differs from the safe one by a few lines: a write slipped into a
// walk, a default flipped, an invented date.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "..", "scripts", name), "utf8");
const bare = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const REPORT = "merchandising-legacy-eligibility-report.js";
const BACKFILL = "backfill-customer-request-line-refs.js";

const reportSrc = read(REPORT);
const report = bare(reportSrc);
const backfillSrc = read(BACKFILL);
const backfill = bare(backfillSrc);

/* ══ THE REPORT READS, AND SAYS ONLY THAT ═════════════════════════════════ */

describe("the legacy eligibility report is read-only", () => {
  test("it parses", () => {
    expect(() => new vm.Script(reportSrc)).not.toThrow();
  });

  test("the old dual-mode migration script is gone, not merely renamed around", () => {
    expect(fs.existsSync(path.join(__dirname, "..", "..", "scripts", "merchandising-m1-migration.js")))
      .toBe(false);
  });

  test("it offers no apply mode, no authorization flag and no rollback", () => {
    for (const banned of [/--apply/, /--authorized-by/, /authorizedBy/, /rollback/i, /batchId/]) {
      expect(report).not.toMatch(banned);
    }
  });

  test("no write of any kind reaches the database", () => {
    for (const banned of [
      /\.create\(/, /\.insertMany\(/, /\.insertOne\(/, /\.save\(/,
      /\.updateOne\(/, /\.updateMany\(/, /\.findOneAndUpdate\(/,
      /\.deleteOne\(/, /\.deleteMany\(/, /\.bulkWrite\(/,
    ]) {
      expect(report).not.toMatch(banned);
    }
  });

  test("an unknown argument points at the tool that DOES write", () => {
    expect(reportSrc).toMatch(/This is a read-only report/);
    expect(reportSrc).toMatch(new RegExp(BACKFILL.replace(/[.]/g, "\\.")));
  });

  test("eligibility reuses the producer's own refusals, so it cannot drift", () => {
    expect(report).toMatch(/producer\.lineBlockers/);
    expect(report).toMatch(/producer\.CONFIRMED_STATUSES/);
    expect(report).toMatch(/ownershipProofFor/);
  });

  test("every frozen B1 condition has its own exclusion bucket", () => {
    for (const code of [
      "NOT_CONFIRMED", "NOT_A_CUSTOMER_ORDER", "NO_LINE_REFERENCE", "NO_SELECTED_STYLE",
      "STYLE_INACTIVE", "HOUSE_SAMPLE", "NO_QUANTITY", "VARIANT_UNRESOLVED",
      "NO_PO_OR_CONTRACT_PROOF", "COMPANY_CHAIN_UNPROVABLE",
      "NO_COMMITTED_DELIVERY_DATE", "ALREADY_HANDED_OVER",
    ]) {
      expect(reportSrc).toMatch(new RegExp(`"${code}"`));
    }
    /* And the one that is gone, because a line is no longer ambiguous. */
    expect(reportSrc).not.toMatch(/AMBIGUOUS_LINE/);
  });

  test("it reports what Sales can act on rather than a permanent zero", () => {
    /* "0 migratable" would be true for ever and tell nobody anything. What a
       salesperson can use is the line whose only missing fact is the delivery
       commitment they are about to author. */
    expect(report).toMatch(/issuableBySalesToday/);
    expect(reportSrc).toMatch(/Ready for Sales to issue today/);
  });

  test("nothing is invented: no assignment, no T&A, no lifecycle, no dates", () => {
    for (const banned of [
      /responsibleMerchandiser/, /assignmentHistory/, /\btna\b|timeAndAction/i,
      /lifecycleStatus\s*:/, /sourceVersionHistory\s*:\s*\[/, /committedDeliveryDate\s*:/,
    ]) {
      expect(report).not.toMatch(banned);
    }
  });
});

/* ══ THE BACKFILL WRITES, AND EARNS IT ════════════════════════════════════ */

describe("the line-reference backfill is the one tool that writes", () => {
  test("it parses", () => {
    expect(() => new vm.Script(backfillSrc)).not.toThrow();
  });

  test("dry run is the default", () => {
    expect(backfill).toMatch(/apply:\s*false/);
  });

  test("--apply without --authorized-by is refused", () => {
    expect(backfill).toMatch(/args\.apply && !args\.authorizedBy/);
    expect(backfill).toMatch(/process\.exit\(2\)/);
  });

  test("nothing is written unless --apply was given", () => {
    /* The dry run walks exactly the same records and stops short of the save,
       so what it reports is what an apply would do. */
    expect(backfill).toMatch(/if \(!args\.apply\) continue;/);
    expect(backfill).toMatch(/if \(args\.apply && clearable\.size\)/);
  });

  test("it writes ONE field and nothing else", () => {
    /* The only assignment onto an order line, and the only two documents it
       touches, are the line reference and the batch stamp that makes the run
       reversible. */
    const assignments = [...backfillSrc.matchAll(/item\.set\("([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(assignments)).toEqual(new Set(["lineRef"]));
    expect(backfill).not.toMatch(/status\s*=/);
    expect(backfill).not.toMatch(/items\.splice|items\.sort|items\.reverse/);
  });

  test("it creates no handover and no execution file", () => {
    for (const banned of [
      /ExecutionFile\.create/, /ExecutionUnit/, /HandoverReceipt/,
      /SalesHandoverVersion\.create/, /producer\.issue/,
    ]) {
      expect(backfill).not.toMatch(banned);
    }
  });

  test("it is idempotent — a line that has a reference is left alone", () => {
    expect(backfill).toMatch(/const missing = items\.filter\(\(i\) => !str\(i\.lineRef\)\)/);
    expect(backfill).toMatch(/linesAlreadyValid/);
  });

  test("duplicate or malformed references are refused, never repaired", () => {
    expect(backfill).toMatch(/function corruption/);
    expect(backfillSrc).toMatch(/this system did not issue/);
    expect(backfillSrc).toMatch(/same line reference on more than one line/);
    expect(backfill).toMatch(/requestsRefused/);
  });

  test("every run carries a batch identity, and it is the rollback identity", () => {
    expect(backfill).toMatch(/lineRefBackfill/);
    expect(backfill).toMatch(/--rollback/);
    expect(backfill).toMatch(/rollbackWith/);
  });

  test("a rollback will not withdraw an identity something already points at", () => {
    expect(backfill).toMatch(/SalesHandoverVersion\.find\(/);
    expect(backfill).toMatch(/linesRetained/);
    expect(backfillSrc).toMatch(/a handover version already names this line/);
  });

  test("the schema carries the batch stamp the rollback reads", () => {
    const model = fs.readFileSync(
      path.join(__dirname, "..", "..", "models", "Customer_Models", "CustomerRequest.js"), "utf8",
    );
    expect(model).toMatch(/lineRefBackfill/);
    expect(model).toMatch(/batchId/);
    expect(model).toMatch(/authorizedBy/);
  });
});
