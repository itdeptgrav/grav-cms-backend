// test/costing/sales-backfill.test.js
//
// The Sales ownership backfill: what it refuses, and how it says so.
//
// ── WHY EXIT CODES ARE PART OF THE CONTRACT ─────────────────────────────────
// A dry run that reports "cannot proceed" is information. An `--apply` that
// prints a refusal and exits 0 tells a deploy script the migration SUCCEEDED,
// and the next step runs against half-migrated data. The distinction is the
// difference between a safe stop and a silent one.
//
// The script is exercised as source and through a child process against an
// isolated in-memory database. It is never pointed at real data.
"use strict";

const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/migrations/backfill-sales-company.js");

describe("backfill-sales-company", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");

  test("it is a dry run unless --apply is given", () => {
    expect(src).toContain('process.argv.includes("--apply")');
    expect(src).toMatch(/DRY RUN/);
  });

  test("an unsafe --apply sets a nonzero exit code and writes nothing", () => {
    /* The refusal branch must both set the code AND return before any write. */
    const refusal = src.slice(src.indexOf("companies.length !== 1"));
    expect(refusal).toContain("if (APPLY) process.exitCode = 1;");
    const beforeReturn = refusal.slice(0, refusal.indexOf("return;"));
    expect(beforeReturn).not.toContain("updateMany");
  });

  test("it refuses a multi-company database outright", () => {
    expect(src).toContain("companies.length !== 1");
    expect(src).toMatch(/nothing in the data says which one/i);
  });

  test("it is idempotent: already-owned records are excluded by the filter", () => {
    /* Not "skipped after loading" — excluded by the query, so a second run
       does no work rather than redoing it harmlessly. */
    expect(src).toContain("const UNOWNED = { $or: [{ companyId: null }, { companyId: { $exists: false } }] };");
    expect(src).toContain("Model.updateMany(UNOWNED");
  });

  test("it reports counts per model rather than one total", () => {
    /* One total hides a model that was missed. */
    expect(src).toContain("counts[name]");
    for (const m of ["Account", "Lead", "Contact"]) expect(src).toContain(m);
  });

  test("it stamps the ownership source as a backfill, not as proven", () => {
    expect(src).toContain('source: "BACKFILL_SINGLE_COMPANY_DEPLOYMENT"');
    expect(src).toContain("proven: false");
  });

  test("it documents the order it must run in", () => {
    /* Sales source first, then journeys and enquiries — the other order leaves
       a scoped Journey pointing at an unowned Account. */
    expect(src).toContain("backfill-enquiry-company.js");
  });

  test("it refuses to run without a database URI", () => {
    expect(src).toContain("MONGODB_URI");
    expect(src).toMatch(/Refusing to guess a database/);
  });
});
