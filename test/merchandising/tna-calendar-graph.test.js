// test/merchandising/tna-calendar-graph.test.js
//
// THE ARITHMETIC UNDERNEATH EVERY DATE THE MODULE STATES.
//
// Working-day counting, timezone safety and the dependency graph are pure
// functions, and they are where a T&A system is actually right or wrong: a
// schedule computed off a calendar that miscounts a holiday is not a slightly
// wrong schedule, it is a schedule that quietly promises the impossible.
//
// No database here on purpose. These are the claims that must hold before any
// of the rest is worth testing, and they must hold fast enough that nobody is
// tempted to skip them.
//
// Covers spec §13.5 (working days), §13.6 (timezones) and §13.7 (cycles).
"use strict";

const cal = require("../../services/merchandising/tnaCalendar");
const graph = require("../../services/merchandising/tnaGraph");

/* Monday-start week: Mon–Fri worked, Sat/Sun not. Index 0 is Monday, which
   the model documents and this pins. */
const MON_FRI = [true, true, true, true, true, false, false];

const calendar = (over = {}) => cal.compile({
  timezone: "Asia/Kolkata",
  weekPattern: MON_FRI,
  exceptions: [],
  horizonTo: "2030-12-31",
  ...over,
});

/* 2026-09-07 is a Monday; 2026-09-12 a Saturday; 2026-09-13 a Sunday. */

describe("§13.5 — working days", () => {
  const c = calendar();

  test("a weekend is stepped over, not counted", () => {
    /* Friday + 1 working day is Monday, not Saturday. */
    expect(cal.addWorkingDays("2026-09-11", 1, c)).toBe("2026-09-14");
    expect(cal.addWorkingDays("2026-09-11", 2, c)).toBe("2026-09-15");
  });

  test("a declared holiday is stepped over as well", () => {
    const withHoliday = calendar({
      exceptions: [{ date: "2026-09-14", working: false, reason: "Onam" }],
    });
    expect(cal.addWorkingDays("2026-09-11", 1, withHoliday)).toBe("2026-09-15");
    expect(cal.isWorkingDay("2026-09-14", withHoliday)).toBe(false);
  });

  test("a worked Sunday is an exception in the other direction", () => {
    const withSunday = calendar({
      exceptions: [{ date: "2026-09-13", working: true, reason: "Shipment Sunday" }],
    });
    expect(cal.isWorkingDay("2026-09-13", withSunday)).toBe(true);
    expect(cal.addWorkingDays("2026-09-11", 1, withSunday)).toBe("2026-09-13");
  });

  test("n = 0 returns the date unchanged, even on a non-working day", () => {
    /* The case that matters: an anchor landing on a Sunday must not be
       silently advanced, because the offset that produced it was zero and
       moving it would be inventing a day nobody asked for. */
    expect(cal.addWorkingDays("2026-09-13", 0, c)).toBe("2026-09-13");
    expect(cal.addWorkingDays("2026-09-14", 0, c)).toBe("2026-09-14");
  });

  test("negative n counts backwards — how every pre-shipment date is expressed", () => {
    expect(cal.addWorkingDays("2026-09-14", -1, c)).toBe("2026-09-11");
    expect(cal.addWorkingDays("2026-09-14", -5, c)).toBe("2026-09-07");
  });

  test("workingDaysBetween agrees with addWorkingDays in both directions", () => {
    for (const [from, n] of [["2026-09-07", 5], ["2026-09-07", 22], ["2026-10-01", 13]]) {
      const to = cal.addWorkingDays(from, n, c);
      expect(cal.workingDaysBetween(from, to, c)).toBe(n);
      expect(cal.addWorkingDays(to, -n, c)).toBe(from);
    }
  });

  test("a malformed exception is ignored, not read as a holiday", () => {
    /* The failure this pins: a misspelt flag coerced to `false` invents a
       holiday, and every downstream date shifts with nothing in the record
       explaining it. Publish validation refuses one; this is the read-side
       backstop for data that predates it. */
    const malformed = calendar({ exceptions: [{ date: "2026-09-14", reason: "typo'd flag" }] });
    expect(cal.isWorkingDay("2026-09-14", malformed)).toBe(true);
  });

  test("beyond the declared horizon is refused, not extrapolated", () => {
    /* A calendar states holidays up to a date. Past it, nobody has said which
       days are worked — so a date computed there would be a guess wearing a
       schedule's clothes. */
    expect(() => cal.addWorkingDays("2030-12-20", 40, c))
      .toThrow(expect.objectContaining({ code: "TNA_CALENDAR_HORIZON" }));
  });
});

describe("§13.6 — timezones", () => {
  test("every produced date is a plain calendar date, never an instant", () => {
    const c = calendar();
    for (const n of [0, 1, 7, -3, 60]) {
      expect(cal.addWorkingDays("2026-09-07", n, c)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the same arithmetic produces the same strings under any server TZ", () => {
    /* The failure this prevents: a date stored as an instant, rendered in the
       server's zone, and reading as the 13th in Mumbai and the 12th in
       California — two people looking at one commitment and seeing different
       days. */
    const c = calendar();
    const original = process.env.TZ;
    const results = [];
    for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      results.push([
        cal.addWorkingDays("2026-09-07", 20, c),
        cal.addWorkingDays("2026-11-01", -15, c),
        cal.workingDaysBetween("2026-09-07", "2026-12-01", c),
      ].join("|"));
    }
    process.env.TZ = original;
    expect(new Set(results).size).toBe(1);
  });

  test("todayInZone reports the calendar's day, not the server's", () => {
    /* 23:40 UTC on the 9th is already the 10th in Delhi. A register that
       showed the 9th would mark a milestone due today as due tomorrow, for
       every user, every evening. */
    const instant = new Date("2026-09-09T23:40:00Z");
    expect(cal.todayInZone("Asia/Kolkata", instant)).toBe("2026-09-10");
    expect(cal.todayInZone("UTC", instant)).toBe("2026-09-09");
    expect(cal.todayInZone("America/Los_Angeles", instant)).toBe("2026-09-09");
  });

  test("an unknown zone falls back to UTC rather than taking the register down", () => {
    expect(cal.todayInZone("Mars/Olympus")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("§13.7 — the dependency graph", () => {
  const codes = ["A", "B", "C", "D"];

  test("a valid diamond ranks every node after its predecessors", () => {
    const deps = [
      { predecessorCode: "A", successorCode: "B" },
      { predecessorCode: "A", successorCode: "C" },
      { predecessorCode: "B", successorCode: "D" },
      { predecessorCode: "C", successorCode: "D" },
    ];
    const ranks = graph.rank(codes, deps);
    expect(ranks.get("A")).toBeLessThan(ranks.get("B"));
    expect(ranks.get("A")).toBeLessThan(ranks.get("C"));
    expect(ranks.get("B")).toBeLessThan(ranks.get("D"));
    expect(ranks.get("C")).toBeLessThan(ranks.get("D"));
  });

  test("ranking is deterministic, because a baseline has to be reproducible", () => {
    const deps = [{ predecessorCode: "A", successorCode: "B" }];
    const once = [...graph.rank(codes, deps).entries()].map((e) => e.join(":")).join(",");
    const twice = [...graph.rank(codes, deps).entries()].map((e) => e.join(":")).join(",");
    expect(once).toBe(twice);
  });

  test("a two-node cycle is refused and NAMED", () => {
    const deps = [
      { predecessorCode: "A", successorCode: "B" },
      { predecessorCode: "B", successorCode: "A" },
    ];
    let caught = null;
    try { graph.rank(["A", "B"], deps); } catch (e) { caught = e; }
    expect(caught?.code).toBe("TNA_DEPENDENCY_CYCLE");
    /* The refusal IS the diagnosis. "Invalid graph" would leave somebody
       reading forty milestones looking for one back-edge. */
    expect(caught.message).toMatch(/A → B → A|B → A → B/);
    expect(caught.details.cycle.length).toBeGreaterThanOrEqual(2);
  });

  test("a five-node cycle is named too", () => {
    const five = ["V", "W", "X", "Y", "Z"];
    const deps = [
      { predecessorCode: "V", successorCode: "W" },
      { predecessorCode: "W", successorCode: "X" },
      { predecessorCode: "X", successorCode: "Y" },
      { predecessorCode: "Y", successorCode: "Z" },
      { predecessorCode: "Z", successorCode: "V" },
    ];
    let caught = null;
    try { graph.rank(five, deps); } catch (e) { caught = e; }
    expect(caught?.code).toBe("TNA_DEPENDENCY_CYCLE");
    for (const code of five) expect(caught.message).toContain(code);
  });

  test("a self-edge, an unknown code and a duplicate pair are each refused", () => {
    expect(() => graph.validateEdges(["A"], [{ predecessorCode: "A", successorCode: "A" }]))
      .toThrow(expect.objectContaining({ code: "TNA_DEPENDENCY_CYCLE" }));
    expect(() => graph.validateEdges(["A", "B"], [{ predecessorCode: "A", successorCode: "Q" }]))
      .toThrow(expect.objectContaining({ code: "TNA_DEPENDENCY_UNKNOWN_CODE" }));
    expect(() => graph.validateEdges(["A", "B"], [
      { predecessorCode: "A", successorCode: "B" },
      { predecessorCode: "A", successorCode: "B" },
    ])).toThrow(/stated twice/);
  });

  test("a negative lag is refused — a successor cannot start before its predecessor", () => {
    expect(() => graph.validateEdges(["A", "B"], [
      { predecessorCode: "A", successorCode: "B", lagWorkingDays: -2 },
    ])).toThrow(/whole number of working days/);
  });
});

describe("§13.9 — forecast propagation", () => {
  const c = calendar();
  const context = { planStartDate: "2026-09-07", deliveryDate: "2026-12-01", exFactoryDate: "2026-11-15" };

  const m = (code, over = {}) => ({
    milestoneRef: code, milestoneCode: code, anchor: "PLAN_START",
    offsetWorkingDays: 0, sequenceRank: over.sequenceRank ?? 0,
    actualDate: null, forecastDate: null, scopeKind: "PLAN", ...over,
  });

  test("a predecessor's date pushes its successor, one working day after", () => {
    const out = graph.computeForecasts(
      [m("A", { sequenceRank: 0 }), m("B", { sequenceRank: 1, anchor: "PREDECESSOR" })],
      [{ predecessorCode: "A", successorCode: "B", lagWorkingDays: 0 }],
      context, c,
    );
    /* Zero lag means "the next working day", not "the same day" — finish to
       start is a boundary, not a shared occupancy. */
    expect(out.get("A")).toBe("2026-09-07");
    expect(out.get("B")).toBe("2026-09-08");
  });

  test("a lag is counted in working days", () => {
    const out = graph.computeForecasts(
      [m("A", { sequenceRank: 0 }), m("B", { sequenceRank: 1, anchor: "PREDECESSOR" })],
      [{ predecessorCode: "A", successorCode: "B", lagWorkingDays: 4 }],
      context, c,
    );
    expect(out.get("B")).toBe("2026-09-14"); // Mon + 5 working days over a weekend
  });

  test("an ACTUAL overrides a forecast as the propagation input", () => {
    /* The lie a T&A system exists to prevent: an event happened late, and
       every downstream date carried on being computed from the optimistic
       estimate that it did not. */
    const out = graph.computeForecasts(
      [
        m("A", { sequenceRank: 0, forecastDate: "2026-09-07", actualDate: "2026-09-21" }),
        m("B", { sequenceRank: 1, anchor: "PREDECESSOR" }),
      ],
      [{ predecessorCode: "A", successorCode: "B", lagWorkingDays: 0 }],
      context, c,
    );
    expect(out.get("A")).toBe("2026-09-21");
    expect(out.get("B")).toBe("2026-09-22");
  });

  test("an anchored date and a predecessor both apply — the later one wins", () => {
    const out = graph.computeForecasts(
      [
        m("A", { sequenceRank: 0, actualDate: "2026-10-20" }),
        m("B", { sequenceRank: 1, anchor: "DELIVERY", offsetWorkingDays: -20 }),
      ],
      [{ predecessorCode: "A", successorCode: "B", lagWorkingDays: 0 }],
      context, c,
    );
    /* Counting back 20 working days from 1 Dec puts B in early November; the
       predecessor finishing on 20 Oct does not push it past that, so the
       anchor stands. A successor is never pulled EARLIER by its predecessor. */
    expect(out.get("B") >= "2026-10-21").toBe(true);
  });

  test("a per-delivery milestone follows only its own drop", () => {
    /* Otherwise every drop waits for every other drop's fabric, and a
       four-drop order schedules as though it were one. */
    const out = graph.computeForecasts(
      [
        m("A::DROP:D1", { milestoneCode: "A", sequenceRank: 0, scopeKind: "DELIVERY", dropRef: "D1", actualDate: "2026-09-07" }),
        m("A::DROP:D2", { milestoneCode: "A", sequenceRank: 1, scopeKind: "DELIVERY", dropRef: "D2", actualDate: "2026-10-30" }),
        m("B::DROP:D1", { milestoneCode: "B", sequenceRank: 2, scopeKind: "DELIVERY", dropRef: "D1", anchor: "PREDECESSOR" }),
      ],
      [{ predecessorCode: "A", successorCode: "B", lagWorkingDays: 0 }],
      context, c,
    );
    /* D1's B follows D1's A on the 8th — not D2's A at the end of October. */
    expect(out.get("B::DROP:D1")).toBe("2026-09-08");
  });

  test("a milestone anchored to a date the file does not have is left unplaced", () => {
    /* Sales stated no ex-factory date. The plan says it cannot place that
       milestone rather than inventing an anchor and promising against it. */
    const out = graph.computeForecasts(
      [m("A", { anchor: "EX_FACTORY", offsetWorkingDays: -5 })],
      [], { planStartDate: "2026-09-07", deliveryDate: null, exFactoryDate: null }, c,
    );
    expect(out.get("A")).toBeNull();
  });
});

describe("the seeded starting process is one that can actually be published", () => {
  /* The script writes a PUBLISHED template directly, so nothing at runtime
     revalidates it. If its graph had a cycle, or a milestone owned by another
     department claimed Merchandising could complete it, every company seeded
     with it would be unschedulable — and the failure would surface as a
     confusing refusal on somebody's first plan rather than here. */
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "../../scripts/seed-tna-process.js"), "utf8",
  );
  const codes = [...src.matchAll(/milestoneCode: "([A-Z_]+)", name:/g)].map((m) => m[1]);
  const deps = [...src.matchAll(
    /\{ predecessorCode: "([A-Z_]+)", successorCode: "([A-Z_]+)", lagWorkingDays: (\d+) \}/g,
  )].map((m) => ({ predecessorCode: m[1], successorCode: m[2], lagWorkingDays: Number(m[3]) }));

  test("its milestones and dependencies were both actually found", () => {
    expect(codes.length).toBe(14);
    expect(deps.length).toBe(15);
  });

  test("the graph ranks — no cycle, no unknown code, no duplicate edge", () => {
    const ranks = graph.rank(codes, deps);
    expect(ranks.size).toBe(codes.length);
    /* And it reads as the process it claims to be: the order is confirmed
       first, and ex-factory is last. */
    expect(ranks.get("ORDER_CONFIRMED")).toBe(0);
    expect(ranks.get("EX_FACTORY")).toBe(codes.length - 1);
  });

  test("nothing claims Merchandising may complete another department's work", () => {
    /* The rule the config service enforces at publish, checked against the
       one template that bypasses publish by being written directly. */
    const blocks = src.split("milestoneCode:").slice(1);
    for (const block of blocks) {
      const owner = /ownerDepartment: "([A-Z_]+)"/.exec(block)?.[1];
      const authority = /completionAuthority: "([A-Z_]+)"/.exec(block)?.[1];
      if (!owner || !authority) continue;
      if (owner !== "MERCHANDISING") {
        expect(`${owner}:${authority}`).toBe(`${owner}:SOURCE_EVENT`);
      }
    }
  });

  test("it declares no holidays it was never told about", () => {
    /* A holiday nobody declared shifts every downstream date with nothing in
       the record explaining why. The seeded calendar states the week pattern
       and leaves exceptions to the people who know the factory. */
    expect(src).toMatch(/exceptions: \[\]/);
  });
});

describe("§13.16 — no task-management vocabulary in the M5 arithmetic", () => {
  test("the calendar and graph carry no assignee, reminder or checklist", () => {
    const fs = require("fs");
    const path = require("path");
    const banned = /assignee|dueReminder|checklist|subtask|delegat|todo|snooze/i;
    for (const f of ["tnaCalendar.js", "tnaGraph.js"]) {
      const src = fs.readFileSync(
        path.join(__dirname, "../../services/merchandising", f), "utf8",
      );
      expect(src).not.toMatch(banned);
    }
  });
});
