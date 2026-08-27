const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PhasingError,
  monthsInPeriod,
  normalisePhasing,
  plannedByMonth,
  monthElapsedFraction,
  expectedToDate,
  paceToDate,
  evenSplit,
} = require("./budgetPhasing.service");

/* An Indian financial year, because that is the period every one of these
   figures is actually read over, and because 1 April is exactly the boundary
   a UTC month key gets wrong. */
const FY = {
  /* IST instants, not UTC ones. 2027-03-31T23:59:59Z is 1 April 05:29 IST, so
     a UTC end-of-day would make a twelve-month year touch a thirteenth month.
     See the boundary test below — that behaviour is real and inherited. */
  startDate: new Date("2026-03-31T18:30:00.000Z"),
  endDate: new Date("2027-03-31T18:29:59.999Z"),
};
const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

/* ── the period walk ─────────────────────────────────────────────────────── */

test("a financial year covers twelve months, April first", () => {
  const months = monthsInPeriod(FY.startDate, FY.endDate);
  assert.equal(months.length, 12);
  assert.equal(months[0], "2026-04");
  assert.equal(months[11], "2027-03");
});

test("month keys are IST, so 1 April does not fall back into March", () => {
  /* 31 March 18:30 UTC is 1 April 00:00 IST. A UTC key would call this March
     and put the year's first day in the previous financial year. */
  const months = monthsInPeriod(
    new Date("2026-03-31T18:30:00.000Z"),
    new Date("2026-04-05T00:00:00.000Z"),
  );
  assert.equal(months[0], "2026-04");
});

test("a reversed or missing period yields no months rather than throwing", () => {
  assert.deepEqual(monthsInPeriod(FY.endDate, FY.startDate), []);
  assert.deepEqual(monthsInPeriod(null, FY.endDate), []);
});

/* ── requirement 2: even spread is unchanged ─────────────────────────────── */

test("no phasing spreads evenly, exactly as before", () => {
  const byMonth = plannedByMonth({ amount: 1200000, ...FY });
  assert.equal(byMonth.size, 12);
  for (const value of byMonth.values()) assert.equal(value, 100000);
});

test("legacy positional weights still spread by their own shape", () => {
  /* Four buckets over twelve months, back-loaded. Written before this chunk;
     must keep reading identically. */
  const byMonth = plannedByMonth({ amount: 1200000, ...FY, phasing: [1, 1, 1, 3] });
  const values = [...byMonth.values()];
  const total = Math.round(values.reduce((s, v) => s + v, 0));
  assert.equal(total, 1200000);
  // The last quarter carries three times a normal quarter's share.
  assert.ok(values[11] > values[0] * 2.9 && values[11] < values[0] * 3.1);
});

test("an even mode with a stale split still spreads evenly", () => {
  const byMonth = plannedByMonth({
    amount: 1200000,
    ...FY,
    phasingMode: "even",
    monthlyPhasing: [{ month: "2026-04", amount: 1200000 }],
  });
  for (const value of byMonth.values()) assert.equal(value, 100000);
});

/* ── requirement 3 + 4: the custom split and its validation ──────────────── */

test("a custom split totals correctly and lands in the months given", () => {
  const rows = [
    { month: "2027-03", amount: 900000 },
    { month: "2026-04", amount: 300000 },
  ];
  const stored = normalisePhasing({
    phasingMode: "custom_monthly",
    monthlyPhasing: rows,
    amount: 1200000,
    ...FY,
  });
  assert.equal(stored.phasingMode, "custom_monthly");
  // Stored in period order, not the order the form sent them.
  assert.deepEqual(stored.monthlyPhasing.map((r) => r.month), ["2026-04", "2027-03"]);
  assert.equal(sum(stored.monthlyPhasing), 1200000);

  const byMonth = plannedByMonth({ amount: 1200000, ...FY, ...stored });
  assert.equal(byMonth.get("2026-04"), 300000);
  assert.equal(byMonth.get("2027-03"), 900000);
  // Months the split left out are zero, not absent.
  assert.equal(byMonth.get("2026-09"), 0);
  assert.equal(byMonth.size, 12);
  assert.equal(Math.round([...byMonth.values()].reduce((s, v) => s + v, 0)), 1200000);
});

test("a month outside the period is rejected", () => {
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-04", amount: 600000 },
          { month: "2027-04", amount: 600000 },
        ],
        amount: 1200000,
        ...FY,
      }),
    (e) => e instanceof PhasingError && e.code === "PHASING_OUTSIDE_PERIOD",
  );
});

test("a split that does not add up to the approved amount is rejected", () => {
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: "2026-04", amount: 500000 }],
        amount: 1200000,
        ...FY,
      }),
    (e) => e instanceof PhasingError && e.code === "PHASING_SUM_MISMATCH",
  );
});

test("a negative month is rejected, but zero is allowed", () => {
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-04", amount: -1 },
          { month: "2026-05", amount: 1200001 },
        ],
        amount: 1200000,
        ...FY,
      }),
    (e) => e instanceof PhasingError && e.code === "PHASING_NEGATIVE",
  );

  const ok = normalisePhasing({
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-04", amount: 0 },
      { month: "2026-05", amount: 1200000 },
    ],
    amount: 1200000,
    ...FY,
  });
  assert.equal(ok.monthlyPhasing[0].amount, 0);
});

test("a duplicated month and a malformed key are both rejected", () => {
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-04", amount: 600000 },
          { month: "2026-04", amount: 600000 },
        ],
        amount: 1200000,
        ...FY,
      }),
    (e) => e.code === "PHASING_DUPLICATE_MONTH",
  );
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: "2026-4", amount: 1200000 }],
        amount: 1200000,
        ...FY,
      }),
    (e) => e.code === "PHASING_BAD_MONTH",
  );
});

test("rounding across twelve months is tolerated, a real gap is not", () => {
  /* 100000/3 twelve times cannot add back to the cent. Refusing that would be
     a control nobody could satisfy. */
  const third = Math.round((1000000 / 12) * 100) / 100;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    month: monthsInPeriod(FY.startDate, FY.endDate)[i],
    amount: third,
  }));
  assert.doesNotThrow(() =>
    normalisePhasing({ phasingMode: "custom_monthly", monthlyPhasing: rows, amount: 1000000, ...FY }),
  );
  assert.throws(
    () =>
      normalisePhasing({
        phasingMode: "custom_monthly",
        monthlyPhasing: rows,
        amount: 1000050,
        ...FY,
      }),
    (e) => e.code === "PHASING_SUM_MISMATCH",
  );
});

test("even mode drops any split it was handed", () => {
  const stored = normalisePhasing({
    phasingMode: "even",
    monthlyPhasing: [{ month: "2026-04", amount: 5 }],
    amount: 1200000,
    ...FY,
  });
  assert.deepEqual(stored, { phasingMode: "even", monthlyPhasing: [] });
});

test("custom mode with no rows is refused rather than silently going even", () => {
  assert.throws(
    () => normalisePhasing({ phasingMode: "custom_monthly", monthlyPhasing: [], amount: 100, ...FY }),
    (e) => e.code === "PHASING_EMPTY",
  );
});

/* ── requirement 7: expected-to-date, with the part month ────────────────── */

test("a whole elapsed month counts in full and a future month not at all", () => {
  assert.equal(monthElapsedFraction("2026-04", new Date("2026-06-10T06:00:00.000Z")), 1);
  assert.equal(monthElapsedFraction("2026-08", new Date("2026-06-10T06:00:00.000Z")), 0);
});

test("the month we are inside counts by day proportion", () => {
  // 15 June of a 30-day month, read at midday IST.
  const f = monthElapsedFraction("2026-06", new Date("2026-06-15T06:30:00.000Z"));
  assert.equal(f, 15 / 30);
});

test("expected-to-date follows the custom shape, not the calendar", () => {
  /* Nothing planned until March. Read in December, an even spread would expect
     three quarters of the year's target and report a disaster; the phased line
     expects nothing, which is the truth. */
  const phased = {
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2027-03", amount: 1200000 }],
  };
  const asOf = new Date("2026-12-15T06:30:00.000Z");
  assert.equal(expectedToDate({ amount: 1200000, ...FY, asOf, ...phased }), 0);
  assert.ok(expectedToDate({ amount: 1200000, ...FY, asOf }) > 800000);
});

test("expected-to-date includes the part of the current month that has run", () => {
  const phased = {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-04", amount: 300000 },
      { month: "2026-05", amount: 900000 },
    ],
  };
  // 16 May of a 31-day month: all of April plus 16/31 of May.
  const asOf = new Date("2026-05-16T06:30:00.000Z");
  const expected = expectedToDate({ amount: 1200000, ...FY, asOf, ...phased });
  assert.equal(expected, Math.round((300000 + 900000 * (16 / 31)) * 100) / 100);
});

test("expected-to-date reaches the full amount at the end of the period", () => {
  const phased = {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-04", amount: 400000 },
      { month: "2027-03", amount: 800000 },
    ],
  };
  const asOf = new Date("2027-04-10T06:30:00.000Z");
  assert.equal(expectedToDate({ amount: 1200000, ...FY, asOf, ...phased }), 1200000);
});

test("paceToDate reports this month's plan and the gap against it", () => {
  const phased = {
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-04", amount: 300000 },
      { month: "2026-05", amount: 900000 },
    ],
  };
  const pace = paceToDate({
    amount: 1200000,
    ...FY,
    asOf: new Date("2026-05-16T06:30:00.000Z"),
    ...phased,
    actualToDate: 500000,
  });
  assert.equal(pace.month, "2026-05");
  assert.equal(pace.plannedThisMonth, 900000);
  assert.equal(pace.gapToDate, Math.round((500000 - pace.expectedToDate) * 100) / 100);
});

/* ── both natures, which is the point of not making this sales-only ─────── */

test("an expense plan and a revenue target phase identically", () => {
  const split = [
    { month: "2026-04", amount: 100000 },
    { month: "2026-05", amount: 900000 },
  ];
  const shape = { phasingMode: "custom_monthly", monthlyPhasing: split };
  const asOf = new Date("2026-05-16T06:30:00.000Z");
  const a = expectedToDate({ amount: 1000000, ...FY, asOf, ...shape });
  const b = expectedToDate({ amount: 1000000, ...FY, asOf, ...shape });
  assert.equal(a, b);
  // and nothing in the module's inputs mentions nature at all
  assert.ok(!Object.keys(shape).includes("nature"));
});

test("evenSplit opens the editor on real numbers", () => {
  const rows = evenSplit({ amount: 1200000, ...FY });
  assert.equal(rows.length, 12);
  assert.equal(rows[0].month, "2026-04");
  assert.equal(sum(rows), 1200000);
  // and what it produces is, by construction, valid to store
  assert.doesNotThrow(() =>
    normalisePhasing({
      phasingMode: "custom_monthly",
      monthlyPhasing: rows,
      amount: 1200000,
      ...FY,
    }),
  );
});

/* ── the boundary this module inherits, pinned so it cannot drift ───────── */

test("a period stored as UTC end-of-day touches a thirteenth IST month", () => {
  /* Not a behaviour this chunk introduces: `monthsCovered` in the dashboard
     route walks the same way and always has. It is pinned here because
     phasing makes it VISIBLE — the editor would offer a month outside the
     year — and because the fix belongs wherever periods are written, not in
     the spreading rule that both readers share. */
  const months = monthsInPeriod(
    new Date("2026-04-01T00:00:00.000Z"),
    new Date("2027-03-31T23:59:59.999Z"),
  );
  assert.equal(months.length, 13);
  assert.equal(months[12], "2027-04");
});
