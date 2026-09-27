// test/accountant/reporting-workbook.test.js
//
// SLICE B5: THE DOWNLOADED FILE READS LIKE A REPORT, NOT LIKE A DATABASE DUMP.
//
// The audit found the workbook carrying `Period Month`, `Group Name`,
// `Period Month: Day` and `Sum of Debit` as headings, a month printed as
// "August 1, 2025", and money as a bare number — the engine's own vocabulary,
// in the one artefact that leaves the building and gets attached to an email.
//
// What is pinned here:
//
//   · the user's headings, with a renamed heading respected exactly;
//   · a month as a real Excel date formatted `mmmm yyyy`, built from the ISO
//     date PART so a UTC process cannot slide it into July;
//   · `00531` as the string `00531`;
//   · money as a NUMBER with a money format — sortable and summable, not a
//     pretty string — and a negative that stays negative;
//   · a count as an integer with no rupee sign, a rate that does not become
//     1800%, and a blank that stays blank rather than becoming zero;
//   · and the whole file written from the engine's rows, in the engine's
//     order, with no arithmetic on this side.
//
// Every workbook here is OPENED WITH EXCELJS and read back cell by cell. A
// test that asserted on the writer's inputs would pass while the file on disk
// said something else.
//
// The last block mutates the real module and requires these tests to die.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");
const { Writable } = require("stream");

const ExcelJS = require("exceljs");
const workbook = require("../../services/reporting/workbook");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");

const CO = "6a08040a1fecacc9bb7149c2";
const layout = (raw) => validateLayout({ name: "t", companyIds: [CO], ...raw },
  { approvedCompanyIds: [CO] });

/** Write a workbook with the real streaming writer and read it back. */
async function roundTrip(l, rows, { writer = workbook, sheetName = "Report" } = {}) {
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  await writer.writeWorkbook({ layout: l, rows, stream: sink, sheetName });
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.concat(chunks));
  return back.worksheets[0];
}

const AUG = "2025-08-01T00:00:00+05:30";

/* ═══════════════════════════════════════════════════════════════════════════
 * A detail export, opened
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a detail workbook", () => {
  const l = layout({
    rows: [
      { field: "voucher.number" },
      { field: "date.voucher" },
      { field: "ledger.name" },
      { field: "amount.debit" },
      { field: "amount.credit" },
    ],
  });
  const ROWS = [
    ["00531", "2025-08-17T00:00:00+05:30", "Plant & Machinery", 1200.5, null],
    ["0114", "2026-01-31T00:00:00+05:30", "Bank Accounts", null, 98765.43],
  ];
  let ws;
  beforeAll(async () => { ws = await roundTrip(l, ROWS); });

  test("THE HEADINGS ARE THE USER'S, NOT THE ENGINE'S", () => {
    expect(ws.getRow(1).values.slice(1)).toEqual([
      "Voucher Number", "Voucher Date", "Ledger Name", "Debit", "Credit",
    ]);
    const text = JSON.stringify(ws.getRow(1).values);
    for (const engineWord of ["Period Month", "Group Name", "Sum of", "v_general_ledger", "voucher_date"]) {
      expect(text).not.toContain(engineWord);
    }
  });

  test("00531 IS THE STRING 00531", () => {
    const cell = ws.getRow(2).getCell(1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe("00531");
    expect(ws.getRow(3).getCell(1).value).toBe("0114");
  });

  test("A VOUCHER DATE IS THE RIGHT DAY, WITH NO TIMEZONE SLIP", () => {
    const cell = ws.getRow(2).getCell(2);
    expect(cell.type).toBe(ExcelJS.ValueType.Date);
    // 17 August, not the 16th — the mart's `+05:30` must not shift it back.
    expect(cell.value.toISOString()).toBe("2025-08-17T00:00:00.000Z");
    expect(cell.numFmt).toBe("dd mmm yyyy");
    // …and across the year boundary, where an off-by-one is most visible.
    expect(ws.getRow(3).getCell(2).value.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  test("MONEY IS A NUMBER WITH A MONEY FORMAT, NOT A FORMATTED STRING", () => {
    const debit = ws.getRow(2).getCell(4);
    expect(debit.type).toBe(ExcelJS.ValueType.Number);
    expect(debit.value).toBe(1200.5);
    expect(debit.numFmt).toBe(workbook.FORMATS.MONEY);
    expect(debit.numFmt).toContain("0.00");
  });

  test("A BLANK STAYS BLANK — never zero, never the word null", () => {
    const missingCredit = ws.getRow(2).getCell(5);
    const missingDebit = ws.getRow(3).getCell(4);
    for (const cell of [missingCredit, missingDebit]) {
      expect(cell.type).toBe(ExcelJS.ValueType.Null);
      expect(cell.value).toBeNull();
      expect(String(cell.text ?? "")).toBe("");
    }
  });

  test("the sheet is usable: frozen headings, an autofilter, bounded widths", () => {
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBe("A1:E3");
    expect(ws.getRow(1).font.bold).toBe(true);
    for (let c = 1; c <= 5; c += 1) {
      expect(ws.getColumn(c).width).toBeGreaterThanOrEqual(10);
      expect(ws.getColumn(c).width).toBeLessThanOrEqual(40);
    }
  });

  test("A LONG NARRATION DOES NOT CREATE AN UNBOUNDED COLUMN", () => {
    const wide = layout({ rows: [{ field: "voucher.narration" }, { field: "amount.debit" }] });
    const widths = workbook.columnWidths(
      workbook.exportColumns(wide),
      [["x".repeat(4000), 1]],
    );
    expect(widths[0]).toBeLessThanOrEqual(60);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Summaries
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a summary workbook is flat, and honest about it", () => {
  test("A MONTH SUMMARY: friendly heading, `mmmm yyyy`, no day", async () => {
    const l = layout({
      rows: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const ws = await roundTrip(l, [[AUG, 7823251.17], ["2025-12-01T00:00:00+05:30", 91.5]]);

    expect(ws.getRow(1).values.slice(1)).toEqual(["Month", "Total Debit"]);
    const month = ws.getRow(2).getCell(1);
    expect(month.type).toBe(ExcelJS.ValueType.Date);
    expect(month.value.toISOString()).toBe("2025-08-01T00:00:00.000Z");
    expect(month.numFmt).toBe("mmmm yyyy");
    expect(month.numFmt).not.toMatch(/\bd\b/);        // no day token
    expect(ws.getRow(2).getCell(2).value).toBe(7823251.17);
  });

  test("LEDGER GROUP × MONTH IS A THREE-COLUMN LIST WITH FRIENDLY HEADINGS", async () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const ws = await roundTrip(l, [["Bank Accounts", AUG, 100], ["Sundry Debtors", AUG, 200]]);
    expect(ws.getRow(1).values.slice(1)).toEqual(["Ledger Group", "Month", "Total Debit"]);
    expect(ws.getRow(2).values.slice(1)[0]).toBe("Bank Accounts");
  });

  test("A RENAMED HEADING IS USED EXACTLY AS TYPED", async () => {
    const l = layout({
      rows: [{ field: "ledger.group", heading: "Head of account" }],
      values: [{ field: "amount.debit", heading: "Debit for the period", calculation: "total" }],
    });
    const ws = await roundTrip(l, [["Bank Accounts", 1]]);
    expect(ws.getRow(1).values.slice(1)).toEqual(["Head of account", "Debit for the period"]);
  });

  test("COUNT AND MONEY IN ONE WORKBOOK: an integer beside a rupee figure", async () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [
        { field: "amount.debit", calculation: "count" },
        { field: "amount.debit", calculation: "total" },
      ],
    });
    const ws = await roundTrip(l, [["Bank Accounts", 412, 7552307]]);
    expect(ws.getRow(1).values.slice(1)).toEqual(["Ledger Group", "Count of Debit", "Total Debit"]);

    const count = ws.getRow(2).getCell(2);
    expect(count.type).toBe(ExcelJS.ValueType.Number);
    expect(count.value).toBe(412);
    expect(count.numFmt).toBe("#,##0");
    expect(count.numFmt).not.toContain("₹");
    expect(count.numFmt).not.toContain(".00");

    const money = ws.getRow(2).getCell(3);
    expect(money.numFmt).toBe(workbook.FORMATS.MONEY);
    expect(money.numFmt).toContain("₹");
  });

  test("A NEGATIVE SIGNED AMOUNT STAYS A NEGATIVE NUMBER", async () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.signed", calculation: "total" }],
    });
    const ws = await roundTrip(l, [["Sales Accounts", -7527157.62], ["Bank Accounts", 7527157.62]]);
    const negative = ws.getRow(2).getCell(2);
    expect(negative.type).toBe(ExcelJS.ValueType.Number);
    expect(negative.value).toBe(-7527157.62);
    expect(negative.value).toBeLessThan(0);
    // The format carries its own negative section rather than hiding the sign.
    expect(negative.numFmt).toContain(";-");
  });

  test("THE ENGINE'S ORDER IS THE FILE'S ORDER, ASCENDING OR DESCENDING", async () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const descending = [["C", 300], ["B", 200], ["A", 100]];
    const ascending = [...descending].reverse();

    const down = await roundTrip(l, descending);
    const up = await roundTrip(l, ascending);
    const labels = (ws) => [2, 3, 4].map((r) => ws.getRow(r).getCell(1).value);

    // Row for row, whatever the engine sent — this side never re-sorts.
    expect(labels(down)).toEqual(["C", "B", "A"]);
    expect(labels(up)).toEqual(["A", "B", "C"]);
  });

  test("the worksheet is named after the report, within Excel's rules", async () => {
    const l = layout({ rows: [{ field: "ledger.group" }], values: [{ field: "amount.debit", calculation: "total" }] });
    const ws = await roundTrip(l, [["A", 1]], { sheetName: "April / sales [2025]: final?" });
    expect(ws.name).toBe("April sales 2025 final");
    expect(ws.name.length).toBeLessThanOrEqual(31);
    expect(workbook.worksheetName("")).toBe("Report");
    expect(workbook.worksheetName("x".repeat(80)).length).toBe(31);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The formatter, including types no field offers yet
 * ══════════════════════════════════════════════════════════════════════════ */

describe("every semantic type has a cell rule", () => {
  /* `gst_rate`, `quantity` and `boolean` are in the B1 vocabulary but no
     catalogue field carries them today, so they cannot be reached through a
     layout. Pinned at the formatter so they are right the day one is offered,
     rather than discovered in a customer's file. */
  test("A RATE OF 18 DOES NOT BECOME 1800%", () => {
    for (const type of ["gst_rate", "percentage"]) {
      const cell = workbook.cellFor(18, { semanticType: type });
      expect(cell.value).toBe(18);                    // the engine's number, untouched
      expect(cell.numFmt).toBe('0.00"%"');            // a literal sign, not Excel's ×100
      expect(cell.numFmt).not.toBe("0.00%");
    }
  });

  test("a quantity keeps up to three decimals", () => {
    expect(workbook.cellFor(12.125, { semanticType: "quantity" }))
      .toEqual({ value: 12.125, numFmt: "#,##0.###" });
  });

  test("a boolean reads Yes or No", () => {
    expect(workbook.cellFor(true, { semanticType: "boolean" }).value).toBe("Yes");
    expect(workbook.cellFor(false, { semanticType: "boolean" }).value).toBe("No");
    expect(workbook.cellFor("f", { semanticType: "boolean" }).value).toBe("No");
  });

  test("a financial year is text, not a date nobody can sort", () => {
    expect(workbook.cellFor("2025-26", { semanticType: "financial_year" }).value).toBe("2025–26");
  });

  test("a quarter reads Q2 2025", () => {
    expect(workbook.cellFor("2025-07-01T00:00:00+05:30", { semanticType: "quarter" }).value)
      .toBe("Q3 2025");
  });

  test("a coded value is written as its label", () => {
    const cell = workbook.cellFor("credit_note", {
      semanticType: "enum",
      choices: [{ value: "credit_note", label: "Credit Note" }],
    });
    expect(cell.value).toBe("Credit Note");
  });

  test("every blank shape is a blank cell", () => {
    for (const blank of [null, undefined, ""]) {
      for (const type of ["currency", "count", "date", "month", "text", "identifier"]) {
        expect(workbook.cellFor(blank, { semanticType: type })).toEqual({ value: null });
      }
    }
  });

  test("NOTHING IN A CELL OR A HEADING IS ENGINE VOCABULARY", async () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const ws = await roundTrip(l, [["Bank Accounts", AUG, 100]]);
    const text = JSON.stringify([
      ws.name, ws.getRow(1).values, ws.getRow(2).values,
      ws.workbook.creator, ws.workbook.company, ws.workbook.keywords,
    ]);
    for (const leak of [
      "v_general_ledger", "reporting.", "group_name", "period_month", "signed_amount",
      "source-table", "breakout", "aggregation", "metabase", "api_key", "mb_",
    ]) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: would any of this notice?
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the presentation is load-bearing", () => {
  const SERVICES = path.join(__dirname, "..", "..", "services", "reporting");
  const written = [];

  const mutate = (file, edits) => {
    const source = fs.readFileSync(path.join(SERVICES, file), "utf8");
    let mutated = source;
    for (const [find, replace] of edits) {
      if (!mutated.includes(find)) {
        throw new Error(`Mutation target not found in ${file}:\n${find}\nThe code moved — re-point the mutation.`);
      }
      mutated = mutated.replace(find, replace);
    }
    expect(mutated).not.toBe(source);
    const target = path.join(SERVICES, `__mutant_${Date.now()}_${written.length}__.js`);
    fs.writeFileSync(target, mutated);
    written.push(target);
    return require(target);
  };

  afterAll(() => {
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  });

  const survives = async (fn) => { await expect(fn()).resolves.toBeUndefined(); };
  /* The mutant must die of the ASSERTION, not of a crash: a mutation that
     merely breaks ExcelJS would "pass" this block while proving nothing about
     what the test checks. */
  const kills = async (fn) => {
    await expect(fn()).rejects.toThrow(/expect\(|Expected|toEqual|toBe/);
  };

  const SUMMARY = layout({
    rows: [{ field: "date.month" }],
    values: [{ field: "amount.debit", calculation: "total" }],
  });
  const DETAIL = layout({
    rows: [{ field: "voucher.number" }, { field: "amount.debit" }],
  });

  test("RESTORING THE ENGINE'S HEADING FAILS", async () => {
    const check = async (w) => {
      const ws = await roundTrip(SUMMARY, [[AUG, 1]], { writer: w });
      expect(ws.getRow(1).values.slice(1)).toEqual(["Month", "Total Debit"]);
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `      heading: r.heading,\n      semanticType: r.field.semanticType,\n      choices: r.field.choices || null,\n    }));\n  }\n\n  const dimensions`,
      `      heading: "Period Month",\n      semanticType: r.field.semanticType,\n      choices: r.field.choices || null,\n    }));\n  }\n\n  const dimensions`,
    ], [
      `  const dimensions = [...layout.rows, ...layout.columns].map((r) => ({\n    heading: r.heading,`,
      `  const dimensions = [...layout.rows, ...layout.columns].map((r) => ({\n    heading: "Period Month",`,
    ]])));
  });

  test("WRITING A MONTH AS `mmmm d, yyyy` FAILS", async () => {
    const check = async (w) => {
      const ws = await roundTrip(SUMMARY, [[AUG, 1]], { writer: w });
      expect(ws.getRow(2).getCell(1).numFmt).toBe("mmmm yyyy");
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `const MONTH = "mmmm yyyy";`,
      `const MONTH = "mmmm d, yyyy";`,
    ]])));
  });

  test("TURNING A VOUCHER NUMBER INTO A NUMBER FAILS", async () => {
    const check = async (w) => {
      const ws = await roundTrip(DETAIL, [["00531", 1]], { writer: w });
      expect(ws.getRow(2).getCell(1).value).toBe("00531");
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `  return { value: String(raw) };\n}`,
      `  return { value: Number.isNaN(Number(raw)) ? String(raw) : Number(raw) };\n}`,
    ]])));
  });

  test("WRITING MONEY AS TEXT FAILS", async () => {
    const check = async (w) => {
      const ws = await roundTrip(SUMMARY, [[AUG, 1200.5]], { writer: w });
      const cell = ws.getRow(2).getCell(2);
      expect(cell.type).toBe(ExcelJS.ValueType.Number);
      expect(cell.value).toBe(1200.5);
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `    return Number.isFinite(n) ? { value: n, numFmt: MONEY } : { value: String(raw) };`,
      `    return { value: Number.isFinite(n) ? n.toFixed(2) : String(raw) };`,
    ]])));
  });

  test("A PERCENTAGE FORMAT THAT MULTIPLIES FAILS", async () => {
    const check = async (w) => {
      const cell = w.cellFor(18, { semanticType: "gst_rate" });
      expect([cell.value, cell.numFmt]).toEqual([18, '0.00"%"']);
    };
    await survives(async () => check(workbook));
    await kills(async () => check(mutate("workbook.js", [[
      `const PERCENT = '0.00"%"';`,
      `const PERCENT = '0.00%';`,
    ]])));
  });

  test("TURNING A NULL INTO ZERO FAILS", async () => {
    const check = async (w) => {
      const ws = await roundTrip(SUMMARY, [[AUG, null]], { writer: w });
      expect(ws.getRow(2).getCell(2).value).toBeNull();
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `  if (raw === null || raw === undefined || raw === "") return { value: null };`,
      `  if (raw === null || raw === undefined || raw === "") return { value: 0 };`,
    ]])));
  });

  test("RE-SORTING THE ROWS ON THIS SIDE FAILS", async () => {
    const check = async (w) => {
      const l = layout({
        rows: [{ field: "ledger.group" }],
        values: [{ field: "amount.debit", calculation: "total" }],
      });
      const ws = await roundTrip(l, [["C", 300], ["A", 100], ["B", 200]], { writer: w });
      expect([2, 3, 4].map((r) => ws.getRow(r).getCell(1).value)).toEqual(["C", "A", "B"]);
    };
    await survives(() => check(workbook));
    await kills(() => check(mutate("workbook.js", [[
      `  for (const raw of rows) {`,
      `  for (const raw of [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {`,
    ]])));
  });
});
