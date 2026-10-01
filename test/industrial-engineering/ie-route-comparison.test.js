// test/industrial-engineering/ie-route-comparison.test.js
//
// IE — DO THE TWO STORED ROUTES AGREE, AND WHEN SEVERAL ANSWERS ARE TRUE AT
// ONCE, WHICH ONE IS PUBLISHED?
//
// The comparison is pure, so the claims worth holding are arithmetic rather
// than fixtures: every one of the eight states is reachable, and the ORDER the
// rules fire in is asserted directly — because a pair of routes that differ in
// three ways must report the same state however the code was last edited.
"use strict";

const {
  STATE, STATES, PRECEDENCE, compareRoutes, rowKey, timeKey, normaliseCodes,
} = require("../../services/industrialEngineering/routeComparison");

const row = (code, samMinutes = 1, extra = {}) => ({
  operationCode: code, name: code, samMinutes, ...extra,
});

describe("the eight states, each reachable", () => {
  test("MATCHED — same operations, same order, same times", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1", 1.5), row("HEM-1", 0.75)],
      productRows: [row("SEW-1", 1.5), row("HEM-1", 0.75)],
    });
    expect(out.state).toBe(STATE.MATCHED);
    expect(out.reason).toBe("SOURCES_AGREE");
  });

  test("DIFFERENT_TIME — same operations, same order, one retimed", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1", 1.5), row("HEM-1", 0.75)],
      productRows: [row("SEW-1", 1.5), row("HEM-1", 1.25)],
    });
    expect(out.state).toBe(STATE.DIFFERENT_TIME);
  });

  test("DIFFERENT_SEQUENCE — same operations and times, reordered", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1", 1), row("HEM-1", 1)],
      productRows: [row("HEM-1", 1), row("SEW-1", 1)],
    });
    expect(out.state).toBe(STATE.DIFFERENT_SEQUENCE);
  });

  test("DIFFERENT_OPERATIONS — the lists are not the same work", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1"), row("HEM-1")],
      productRows: [row("SEW-1"), row("OVL-1")],
    });
    expect(out.state).toBe(STATE.DIFFERENT_OPERATIONS);
  });

  test("DIFFERENT_OPERATIONS — a repeated operation is not the same as one", () => {
    /* A multiset, not a set: two passes of the same operation is two rows of
       work, and reporting it as "the same operations" would hide half a route. */
    const out = compareRoutes({
      technicalRows: [row("SEW-1"), row("SEW-1")],
      productRows: [row("SEW-1")],
    });
    expect(out.state).toBe(STATE.DIFFERENT_OPERATIONS);
  });

  test("ONLY_TECHNICAL_ROUTE — the product holds none", () => {
    const out = compareRoutes({ technicalRows: [row("SEW-1")], productRows: [] });
    expect(out.state).toBe(STATE.ONLY_TECHNICAL_ROUTE);
  });

  test("ONLY_PRODUCT_ROUTE — the technical record holds none", () => {
    const out = compareRoutes({ technicalRows: [], productRows: [row("SEW-1")] });
    expect(out.state).toBe(STATE.ONLY_PRODUCT_ROUTE);
  });

  test("NO_ROUTE — neither source holds one", () => {
    const out = compareRoutes({ technicalRows: [], productRows: [] });
    expect(out.state).toBe(STATE.NO_ROUTE);
    /* And it is NOT reported as agreement. Two empty routes are not a match. */
    expect(out.state).not.toBe(STATE.MATCHED);
  });

  test("AMBIGUOUS — the product source could not be identified", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1")], productRows: [], productSourceIdentifiable: false,
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.reason).toBe("PRODUCT_SOURCE_NOT_IDENTIFIABLE");
  });

  test("AMBIGUOUS — a row on either side carries no code to match on", () => {
    const out = compareRoutes({
      technicalRows: [row("SEW-1")],
      productRows: [row("", 1)],
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.reason).toBe("ROWS_CANNOT_BE_MATCHED");
    expect(out.details.uncodedProductRows).toBe(1);
  });

  test("every declared state is covered by the cases above", () => {
    const reached = new Set([
      compareRoutes({ technicalRows: [row("A")], productRows: [row("A")] }).state,
      compareRoutes({ technicalRows: [row("A", 1)], productRows: [row("A", 2)] }).state,
      compareRoutes({ technicalRows: [row("A"), row("B")], productRows: [row("B"), row("A")] }).state,
      compareRoutes({ technicalRows: [row("A")], productRows: [row("B")] }).state,
      compareRoutes({ technicalRows: [row("A")], productRows: [] }).state,
      compareRoutes({ technicalRows: [], productRows: [row("A")] }).state,
      compareRoutes({ technicalRows: [], productRows: [] }).state,
      compareRoutes({ technicalRows: [], productRows: [], productSourceIdentifiable: false }).state,
    ]);
    expect([...reached].sort()).toEqual([...STATES].sort());
  });
});

/* ══ PRECEDENCE ═══════════════════════════════════════════════════════════ */

describe("when several differences are true at once", () => {
  test("the published rule order is the one the function applies", () => {
    expect(PRECEDENCE.map((r) => r.reason)).toEqual([
      "PRODUCT_SOURCE_NOT_IDENTIFIABLE",
      "NEITHER_SOURCE_HOLDS_A_ROUTE",
      "PRODUCT_SOURCE_HOLDS_NO_ROUTE",
      "TECHNICAL_SOURCE_HOLDS_NO_ROUTE",
      "ROWS_CANNOT_BE_MATCHED",
      "OPERATION_CODE_NOT_UNIQUE",
      "OPERATIONS_DIFFER",
      "SEQUENCE_DIFFERS",
      "STANDARD_TIME_DIFFERS",
      "SOURCES_AGREE",
    ]);
    expect(PRECEDENCE.map((r) => r.state)).toEqual([
      STATE.AMBIGUOUS,
      STATE.NO_ROUTE,
      STATE.ONLY_TECHNICAL_ROUTE,
      STATE.ONLY_PRODUCT_ROUTE,
      STATE.AMBIGUOUS,
      STATE.AMBIGUOUS,
      STATE.DIFFERENT_OPERATIONS,
      STATE.DIFFERENT_SEQUENCE,
      STATE.DIFFERENT_TIME,
      STATE.MATCHED,
    ]);
  });

  test("an unidentifiable product source outranks NO_ROUTE", () => {
    /* Both routes are empty, so "no route" is literally true — and it would be
       a lie: nothing has been shown about a product nobody could resolve. */
    const out = compareRoutes({
      technicalRows: [], productRows: [], productSourceIdentifiable: false,
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.ruleIndex).toBe(0);
  });

  test("an unidentifiable product source outranks ONLY_TECHNICAL_ROUTE", () => {
    const out = compareRoutes({
      technicalRows: [row("A")], productRows: [], productSourceIdentifiable: false,
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
  });

  test("presence outranks content — an empty side is never a content difference", () => {
    const out = compareRoutes({ technicalRows: [row("A", 1)], productRows: [] });
    expect(out.state).toBe(STATE.ONLY_TECHNICAL_ROUTE);
    expect(out.ruleIndex).toBe(2);
  });

  test("uncodeable rows outrank every content difference", () => {
    const out = compareRoutes({
      technicalRows: [row("A", 1), row("B", 2)],
      productRows: [row("", 9), row("C", 3)],
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.ruleIndex).toBe(4);
  });

  test("different operations outrank a different order and a different time", () => {
    const out = compareRoutes({
      technicalRows: [row("A", 1), row("B", 2)],
      productRows: [row("C", 9), row("A", 5)],
    });
    expect(out.state).toBe(STATE.DIFFERENT_OPERATIONS);
    expect(out.ruleIndex).toBe(6);
  });

  test("a different order outranks a different time", () => {
    /* Same two operations, reordered AND retimed. The order is the coarser
       fact and the one somebody must resolve first. */
    const out = compareRoutes({
      technicalRows: [row("A", 1), row("B", 2)],
      productRows: [row("B", 7), row("A", 8)],
    });
    expect(out.state).toBe(STATE.DIFFERENT_SEQUENCE);
    expect(out.ruleIndex).toBe(7);
  });

  test("the same pair of routes reports the same state whichever side is passed first", () => {
    const a = [row("A", 1), row("B", 2)];
    const b = [row("B", 7), row("A", 8)];
    expect(compareRoutes({ technicalRows: a, productRows: b }).state)
      .toBe(compareRoutes({ technicalRows: b, productRows: a }).state);
  });
});

/* ══ MISSING IS NOT ZERO ══════════════════════════════════════════════════ */

describe("a time nobody recorded", () => {
  test("is not equal to a time recorded as zero", () => {
    const out = compareRoutes({
      technicalRows: [row("A", null)],
      productRows: [row("A", 0)],
    });
    expect(out.state).toBe(STATE.DIFFERENT_TIME);
  });

  test("is equal to another time nobody recorded", () => {
    const out = compareRoutes({
      technicalRows: [row("A", null)],
      productRows: [row("A", null)],
    });
    expect(out.state).toBe(STATE.MATCHED);
  });

  test("timeKey renders a missing time as a value no number can equal", () => {
    expect(timeKey({ samMinutes: null })).toBe(timeKey({}));
    expect(timeKey({ samMinutes: null })).not.toBe(timeKey({ samMinutes: 0 }));
  });
});

/* ══ A CODE THE MASTER DOES NOT HOLD UNIQUELY ═════════════════════════════ */

describe("a duplicated operation-master code", () => {
  const both = [row("TS008", 1)];

  test("two identical routes on a duplicated code are AMBIGUOUS, not MATCHED", () => {
    /* The whole point of the rule. Same code, same order, same time — and the
       code names two registered operations, so "the same operation" is a claim
       nothing supports. */
    const clean = compareRoutes({ technicalRows: both, productRows: both });
    expect(clean.state).toBe(STATE.MATCHED);

    const out = compareRoutes({
      technicalRows: both, productRows: both, duplicatedMasterCodes: ["TS008"],
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
    expect(out.details.duplicatedCodes).toEqual(["TS008"]);
  });

  test("an unrelated duplicate elsewhere in the register changes nothing", () => {
    /* A duplicate this style does not name is somebody else's problem. If it
       reached here, one mistyped code would make every style in the company
       ambiguous at once. */
    const out = compareRoutes({
      technicalRows: both, productRows: both,
      duplicatedMasterCodes: ["HEM-1", "OVL-9", "SEW-3"],
    });
    expect(out.state).toBe(STATE.MATCHED);
    expect(out.reason).toBe("SOURCES_AGREE");
  });

  test("the code is normalised on both sides, so case and padding cannot evade it", () => {
    for (const stored of ["ts008", " TS008 ", "Ts008"]) {
      const out = compareRoutes({
        technicalRows: [row("TS008", 1)],
        productRows: [row(" ts008 ", 1)],
        duplicatedMasterCodes: [stored],
      });
      expect(out.state).toBe(STATE.AMBIGUOUS);
      expect(out.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
      expect(out.details.duplicatedCodes).toEqual(["TS008"]);
    }
  });

  test("a duplicate named by only ONE of the two routes still counts", () => {
    /* "a code used in either route" — a row the product side alone carries is
       still a row somebody must identify before the pair can be trusted. */
    const out = compareRoutes({
      technicalRows: [row("A", 1)],
      productRows: [row("TS008", 1)],
      duplicatedMasterCodes: ["TS008"],
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
  });

  test("unique codes keep every existing comparison result", () => {
    const cases = [
      [[row("A", 1)], [row("A", 1)], STATE.MATCHED],
      [[row("A", 1)], [row("A", 2)], STATE.DIFFERENT_TIME],
      [[row("A", 1), row("B", 1)], [row("B", 1), row("A", 1)], STATE.DIFFERENT_SEQUENCE],
      [[row("A", 1)], [row("B", 1)], STATE.DIFFERENT_OPERATIONS],
    ];
    for (const [technicalRows, productRows, expected] of cases) {
      /* Both with no duplicate list at all, and with one that names codes
         these routes never use. */
      expect(compareRoutes({ technicalRows, productRows }).state).toBe(expected);
      expect(compareRoutes({ technicalRows, productRows, duplicatedMasterCodes: ["ZZ-9"] }).state)
        .toBe(expected);
    }
  });

  test("it decides before operations, sequence and time — and after presence", () => {
    /* Routes that differ in EVERY way, on a duplicated code. The duplicate
       wins, because a content difference read through an ambiguous key is not
       a fact about the work. */
    const out = compareRoutes({
      technicalRows: [row("TS008", 1), row("B", 2)],
      productRows: [row("C", 9), row("TS008", 8)],
      duplicatedMasterCodes: ["TS008"],
    });
    expect(out.state).toBe(STATE.AMBIGUOUS);
    expect(out.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
    expect(out.ruleIndex).toBe(5);

    /* Presence still outranks it: one empty side is ONLY_*, never ambiguous,
       because there is no second route to be confused with. */
    expect(compareRoutes({
      technicalRows: both, productRows: [], duplicatedMasterCodes: ["TS008"],
    }).state).toBe(STATE.ONLY_TECHNICAL_ROUTE);
    expect(compareRoutes({
      technicalRows: [], productRows: both, duplicatedMasterCodes: ["TS008"],
    }).state).toBe(STATE.ONLY_PRODUCT_ROUTE);
    expect(compareRoutes({
      technicalRows: [], productRows: [], duplicatedMasterCodes: ["TS008"],
    }).state).toBe(STATE.NO_ROUTE);

    /* And an uncodeable row is the more basic failure, so it wins. */
    const uncoded = compareRoutes({
      technicalRows: [row("TS008", 1)],
      productRows: [row("", 1)],
      duplicatedMasterCodes: ["TS008"],
    });
    expect(uncoded.reason).toBe("ROWS_CANNOT_BE_MATCHED");
    expect(uncoded.ruleIndex).toBe(4);
  });

  test("several duplicated codes are listed once each, in a stable order", () => {
    const out = compareRoutes({
      technicalRows: [row("ZZ", 1), row("AA", 1), row("ZZ", 1)],
      productRows: [row("ZZ", 1), row("AA", 1), row("ZZ", 1)],
      duplicatedMasterCodes: ["AA", "ZZ"],
    });
    expect(out.details.duplicatedCodes).toEqual(["AA", "ZZ"]);
  });

  test("an empty or absent duplicate list is not a wildcard", () => {
    for (const codes of [null, undefined, [], new Set()]) {
      expect(compareRoutes({ technicalRows: both, productRows: both, duplicatedMasterCodes: codes }).state)
        .toBe(STATE.MATCHED);
    }
  });

  test("a Set and an array are accepted alike, and normalised the same way", () => {
    expect(normaliseCodes([" ts008 ", "TS008", "", null])).toEqual(new Set(["TS008"]));
    expect(compareRoutes({
      technicalRows: both, productRows: both, duplicatedMasterCodes: new Set(["ts008"]),
    }).state).toBe(STATE.AMBIGUOUS);
  });
});

describe("rows are matched on the code and never on the name", () => {
  test("the key is the upper-cased code", () => {
    expect(rowKey({ operationCode: " sew-1 " })).toBe("SEW-1");
    expect(rowKey({ operationCode: "", name: "Side seam" })).toBeNull();
  });

  test("two rows sharing a name but not a code are different operations", () => {
    const out = compareRoutes({
      technicalRows: [{ operationCode: "SEW-1", name: "Side seam", samMinutes: 1 }],
      productRows: [{ operationCode: "SEW-2", name: "Side seam", samMinutes: 1 }],
    });
    expect(out.state).toBe(STATE.DIFFERENT_OPERATIONS);
  });
});
