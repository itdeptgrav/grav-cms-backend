// test/hr-ai/storeCommandIntent.test.js
//
// THE GRAMMAR, ON ITS OWN.
//
// ── WHAT IS BEING PINNED ──────────────────────────────────────────────────
// Ten `if` statements would answer the ten required questions and nothing
// else. So what these assertions check is mostly the ELEVENTH question: a
// phrasing nobody listed, compiled correctly by the same rules. Each case
// below names the rule it covers rather than a sentence it accepts.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const {
  INTENT, LIMIT_CAP, STATUS_WORDS, compileIntent, dateRangeFrom, limitFrom, isPlural,
} = require("../../services/ai/storeCommandIntent");

const kind = (q) => compileIntent(q).intent;

describe("which kind of question it is", () => {
  test.each([
    ["a bare name is discovery", "macbook", INTENT.DISCOVERY],
    ["so is a bare name nobody listed", "duck canvas 12oz", INTENT.DISCOVERY],
    ["a figure about a thing is a record question", "stock of macbook", INTENT.RECORD],
    ["a document reference outranks everything", "GRN/2026-27/0004", INTENT.RECORD],
    ["a different series, never listed", "PO/2026-27/0101", INTENT.RECORD],
    ["where something is, is a location question", "where is sodium kept", INTENT.LOCATION],
    ["so is which shelf holds it", "which shelf has soda ash", INTENT.LOCATION],
    ["counting is counting", "how many purchase orders", INTENT.COUNT],
    ["a total is an aggregate", "total value of stock", INTENT.AGGREGATE],
    ["a shortfall is its own kind", "shortfall for 16mm flex pipe", INTENT.SHORTFALL],
    ["a plural with a limit is a list", "latest five material requests", INTENT.LIST],
    ["so is an explicit list", "list all suppliers", INTENT.LIST],
  ])("%s", (_name, question, expected) => {
    expect(kind(question)).toBe(expected);
  });

  test("a plural subject is a list even with no list word", () => {
    expect(kind("purchase orders of Gaurav Enterprises")).toBe(INTENT.LIST);
  });

  test("a singular subject with the same shape is not", () => {
    expect(kind("purchase order of Gaurav Enterprises")).toBe(INTENT.RECORD);
  });

  test("nothing but stop words compiles to nothing usable", () => {
    const out = compileIntent("the of and it");
    expect(out.terms).toEqual([]);
    expect(out.reference).toBeNull();
  });

  test("an empty question is refused outright", () => {
    expect(compileIntent("").ok).toBe(false);
    expect(compileIntent("   ").ok).toBe(false);
  });
});

describe("a reference is recognised by its shape, not by a list of series", () => {
  test.each([
    "GRN/2026-27/0004", "PO/2026-27/0101", "MRF-2605-0006",
    "REQ-2610-0001", "CSM-2026-0004", "WH-MAIN",
  ])("%s is read as a reference", (reference) => {
    expect(compileIntent(`${reference}`).reference).toBe(reference);
  });

  test("a sentence carrying one keeps it", () => {
    expect(compileIntent("show me GRN/2026-27/0004 please").reference).toBe("GRN/2026-27/0004");
  });

  test("an ordinary word is not a reference", () => {
    for (const word of ["macbook", "sodium", "pending orders"]) {
      expect(compileIntent(word).reference).toBeNull();
    }
  });
});

describe("a date window, and what it is a window ON", () => {
  test("a month and a year become that month", () => {
    expect(dateRangeFrom("in June 2026")).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
  });

  test("a leap February is 29 days", () => {
    expect(dateRangeFrom("February 2028")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
  });

  test("a year on its own is that year", () => {
    expect(dateRangeFrom("in 2026")).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
  });

  test("a window with no business date named is carried as UNRESOLVED", () => {
    /* A goods receipt has a receipt date, an expected date, an invoice date
       and an inspection date. "In June" means a different answer against
       each, so the compiler refuses to choose and says so. */
    const out = compileIntent("material requests in June 2026");
    expect(out.dateRange).toMatchObject({ from: "2026-06-01" });
    expect(out.unresolved.map((u) => u.part)).toContain("dateRange");
  });

  test("no date words, no window", () => {
    expect(compileIntent("stock of macbook").dateRange).toBeNull();
  });
});

describe("how many, and in which order", () => {
  test("a written number is a limit", () => {
    expect(limitFrom("latest five material requests")).toBe(5);
  });

  test("so is a digit", () => {
    expect(limitFrom("last 3 purchase orders")).toBe(3);
  });

  test("a limit is capped, so one question cannot ask for the collection", () => {
    expect(limitFrom("latest 5000 material requests")).toBeLessThanOrEqual(LIMIT_CAP);
  });

  test("latest means newest first, oldest means the other way", () => {
    expect(compileIntent("latest five material requests").order).toBe("newest");
    expect(compileIntent("oldest five material requests").order).toBe("oldest");
  });

  test("no ordering word, no order", () => {
    expect(compileIntent("material requests").order).toBeNull();
  });
});

describe("a status word is a whole word", () => {
  test("every declared status is recognised on its own", () => {
    for (const word of STATUS_WORDS) {
      expect(compileIntent(`${word} material requests`).status).toContain(word);
    }
  });

  test("a word that merely contains one is not it", () => {
    /* `\b` treats a hyphen as a boundary, so this matched "approved" and the
       question was answered with the approved records — a filter the person
       never asked for. */
    expect(compileIntent("half-approved material requests").status).toEqual([]);
    expect(compileIntent("non-pending requests").status).toEqual([]);
  });
});

describe("plurality is read from the words, not from a list of nouns", () => {
  test.each([
    ["purchase orders", true],
    ["purchase order", false],
    ["all the suppliers", true],
    ["supplier", false],
  ])("%s → plural %s", (phrase, plural) => {
    expect(isPlural(phrase)).toBe(plural);
  });
});
