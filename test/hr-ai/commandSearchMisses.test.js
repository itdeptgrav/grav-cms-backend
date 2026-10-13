// test/hr-ai/commandSearchMisses.test.js
//
// THE SEARCHES CMD/CTRL K COULD NOT ANSWER: KEPT, ANONYMOUS, SHORT-LIVED.
//
// The owner's decisions, 8 Oct 2026 — save what was typed when it found
// nothing, never who typed it, delete after 90 days — each pinned here, along
// with the rule that only a search the SERVER agrees found nothing is kept.
"use strict";

const service = require("../../services/ai/storeCommandSearch.service");
const CommandSearchMiss = require("../../models/CMS_Models/AI/CommandSearchMiss");
const { clean, recordIfMiss, topMisses } = require("../../services/ai/commandSearchMisses");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

let reader;
beforeEach(async () => {
  const store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const record = (query) => recordIfMiss({
  app: "store", query, search: ({ query: q }) => service.search({ user: reader, query: q }),
});

describe("anonymous by construction", () => {
  test("the collection has no field that could hold a person", () => {
    const paths = Object.keys(CommandSearchMiss.schema.paths).sort();
    expect(paths).toEqual(["_id", "app", "count", "firstSeenAt", "lastSeenAt", "query", "state"]);
  });

  test("a phone number or an email typed into the box is blanked before it is kept", () => {
    expect(clean("call Ravi on 98765 43210")).toBe("call ravi on [number]");
    expect(clean("+91-9876543210 supplier")).toBe("[number] supplier");
    expect(clean("ravi.k@grav.in orders")).toBe("[email] orders");
    /* A document number is not personal, and an unknown one is a useful miss. */
    expect(clean("PO/2026-27/9999")).toBe("po/2026-27/9999");
  });
});

describe("kept for 90 days after it was last typed", () => {
  test("a TTL index deletes a row 90 days after lastSeenAt", () => {
    const ttl = CommandSearchMiss.schema.indexes().find(([fields]) => fields.lastSeenAt === 1);
    expect(ttl[1].expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});

describe("only a real miss is kept", () => {
  test("a search Store answers is not kept", async () => {
    expect((await record("macbook")).recorded).toBe(false);
    expect((await record("pending material requests")).recorded).toBe(false);
    expect(await CommandSearchMiss.countDocuments()).toBe(0);
  });

  test("words it could not place are kept, once per wording, and counted", async () => {
    expect((await record("stuff lying around")).recorded).toBe(true);
    expect((await record("Stuff   lying around")).recorded).toBe(true);
    const [row] = await topMisses({ app: "store" });
    expect(row.query).toBe("stuff lying around");
    expect(row.count).toBe(2);
    expect(["no_match", "unsupported"]).toContain(row.state);
  });

  test("the browser cannot write into the list by claiming a miss", async () => {
    /* The server runs the search itself; an answered query is refused
       whatever the browser said about it. */
    const out = await recordIfMiss({
      app: "store", query: "GRN/2026-27/0004", search: ({ query }) => service.search({ user: reader, query }),
    });
    expect(out.recorded).toBe(false);
  });

  test("two letters are not a search", async () => {
    expect((await record("zz")).recorded).toBe(false);
  });
});

describe("the books' misses go through the same list", () => {
  const fs = require("fs");
  const path = require("path");
  const accounting = require("../../services/ai/accountingCommandSearch.service");
  const { seedBooks } = require("../support/accountingCommandFixtures");

  test("a search the books cannot answer is kept as 'accounting'; one they answer is not", async () => {
    const books = await seedBooks();
    const search = ({ query }) => accounting.search({ companyId: String(books.A), query });
    expect((await recordIfMiss({ app: "accounting", query: "INV/0012", search })).recorded).toBe(false);
    expect((await recordIfMiss({ app: "accounting", query: "net worth this year", search })).recorded).toBe(true);
    const [row] = await topMisses({ app: "accounting" });
    expect(row.query).toBe("net worth this year");
    /* Store's list and the books' list are the same collection, apart by app. */
    expect(await topMisses({ app: "store" })).toEqual([]);
  });

  test("its door is the books' session, read rights, and the company check", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "ai", "commandSearchMisses.js"), "utf8");
    expect(src).toMatch(/"\/accounting\/command-search\/miss",\s*\(req, res, next\) => accOrgAuth\.orgAuth\(req, res, next\),\s*requireCapability\("canView"\),\s*\(req, res, next\) => accOrgAuth\.requireCompanyScope\(req, res, next\)/);
  });
});

describe("the weekly report re-asks the books' misses", () => {
  test("a miss a word has since fixed shows as answered; a real miss does not", async () => {
    const { seedBooks } = require("../support/accountingCommandFixtures");
    const books = await seedBooks();
    const mongoose = require("mongoose");
    const savedArgv = process.argv;
    process.argv = [...savedArgv, "--company", String(books.A)];
    const realOnce = mongoose.connection.once;
    let skipped = 0;
    try {
      const { accountingRunner } = require("../../scripts/reports/store-command-misses");
      const runner = await accountingRunner();
      expect((await runner.rerun("INV/0012")).state).toBe("answered");
      expect((await runner.rerun("stuff lying around")).state).not.toBe("answered");
      /* And it touched nothing: the once-listener patch was put back. */
      expect(mongoose.connection.once).toBe(realOnce);
      skipped += 1;
    } finally {
      process.argv = savedArgv;
    }
    expect(skipped).toBe(1);
  });
});

describe("HR's misses go through the same list", () => {
  const fs = require("fs");
  const path = require("path");
  const hr = require("../../services/ai/hrCommandSearch.service");
  const { seedHr, NOW } = require("../support/hrCommandFixtures");
  const { ROLE_TEMPLATES, DEPARTMENT_ROLE_TEMPLATE } = require("../../services/access/hrCapabilities");

  test("a search HR cannot answer is kept as 'hr'; one it answers is not", async () => {
    await seedHr();
    const capabilities = new Set(ROLE_TEMPLATES[DEPARTMENT_ROLE_TEMPLATE.viewer]);
    const search = ({ query }) => hr.search({ capabilities, query, now: NOW });
    expect((await recordIfMiss({ app: "hr", query: "GR0067", search })).recorded).toBe(false);
    expect((await recordIfMiss({ app: "hr", query: "appraisal cycle", search })).recorded).toBe(true);
    const [row] = await topMisses({ app: "hr" });
    expect(row.query).toBe("appraisal cycle");
  });

  test("its door is HR's own check, not under /api/hr where a POST is queued as a write", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "ai", "commandSearchMisses.js"), "utf8");
    expect(src).toMatch(/"\/hr\/command-search\/miss",\s*\(req, res, next\) => \{ seedIdentity\(req\); next\(\); \},\s*requireHrCapability\(HR\.HR_ACCESS\)/);
  });
});

describe("the weekly report re-asks HR's misses", () => {
  test("an HR miss a word has since fixed shows as answered; a real miss does not", async () => {
    const { seedHr } = require("../support/hrCommandFixtures");
    await seedHr();
    const { hrRunner } = require("../../scripts/reports/store-command-misses");
    const runner = await hrRunner();
    expect((await runner.rerun("GR0067")).state).toBe("answered");
    expect((await runner.rerun("appraisal cycle")).state).not.toBe("answered");
  });
});
