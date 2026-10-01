const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("./intents");

const TODAY = "2026-09-25"; // a Friday

const p = (q) => parse(q, TODAY);

test("today's summary and department updates", () => {
  assert.equal(p("How is production today?").intent, "summary_today");
  assert.equal(p("Give me today's production summary").intent, "summary_today");
  const emb = p("Give me today's embroidery update");
  assert.equal(emb.intent, "department_today"); assert.equal(emb.entities.department, "embroidery"); assert.equal(emb.entities.date, TODAY);
  assert.equal(p("Show printing production today").entities.department, "printing");
  assert.equal(p("How much washing happened today?").entities.department, "washing");
  assert.equal(p("What is sewing production right now?").entities.department, "production");
  assert.equal(p("How much QC passed today?").entities.department, "qc");
  assert.equal(p("How many pieces were packed today?").entities.department, "packaging");
});

test("hourly questions, with and without a clock range", () => {
  const a = p("Give me hour-wise embroidery production today");
  assert.equal(a.intent, "hourly"); assert.equal(a.entities.department, "embroidery");
  const b = p("What was sewing production between 11 AM and 2 PM?");
  assert.equal(b.intent, "hourly"); assert.deepEqual([b.entities.hoursFrom, b.entities.hoursTo], ["11:00", "14:00"]);
  assert.equal(p("Which hour had the highest production?").intent, "hourly");
  assert.equal(p("Compare target vs actual hour-wise").intent, "hourly");
});

test("orders by PO, MO and WO, and a barcode", () => {
  const po = p("What is the status of PO GRV/2026/118?");
  assert.equal(po.intent, "order_status"); assert.equal(po.entities.po, "GRV/2026/118");
  const mo = p("Give me the production status of MO-REQ-2026-0003");
  assert.equal(mo.intent, "order_status"); assert.equal(mo.entities.mo, "MO-REQ-2026-0003");
  assert.equal(p("Show all WOs for REQ-2026-0012").entities.mo, "MO-REQ-2026-0012");
  const wo = p("What is the status of WO-a6b16a8f?");
  assert.equal(wo.intent, "wo_status"); assert.equal(wo.entities.wo, "WO-a6b16a8f");
  const bc = p("where is WO-a6b16a8f-012");
  assert.equal(bc.intent, "unit_status"); assert.equal(bc.entities.barcode, "WO-A6B16A8F-012");
  assert.equal(p("Which department has WO-a6b16a8f reached?").intent, "wo_status");
});

test("targets, delays and pace", () => {
  const t = p("What is today's target for embroidery?");
  assert.equal(t.intent, "target_status"); assert.equal(t.entities.department, "embroidery");
  assert.equal(p("Has sewing achieved today's target?").intent, "target_status");
  const m = p("Which departments missed target yesterday?");
  assert.equal(m.intent, "target_missed"); assert.equal(m.entities.date, "2026-09-24");
  assert.equal(p("Which departments are behind target?").intent, "departments_behind");
  assert.equal(p("Which orders are delayed?").intent, "orders_delayed");
  assert.equal(p("Which orders are falling behind?").intent, "orders_delayed");
  assert.equal(p("Which department is causing production delay?").intent, "delay_cause");
  assert.equal(p("What recovery production rate is required?").intent, "recovery_pace");
  assert.equal(p("What pace is required for the remaining hours?").intent, "recovery_pace");
  assert.equal(p("How much more is required to meet today's target?").intent, "recovery_pace");
  assert.equal(p("What quantity is pending?").intent, "pending_quantity");
  assert.equal(p("What remains for MO-REQ-2026-0003?").intent, "order_status");
  assert.equal(p("Which department is performing best today?").intent, "department_best");
  assert.equal(p("Which orders are close to completion?").intent, "orders_near_completion");
});

test("reports and date ranges", () => {
  const r = p("Give me today's day-end production summary");
  assert.equal(r.intent, "report_summary"); assert.equal(r.entities.date, TODAY);
  const w = p("Show this week's production");
  assert.equal(w.intent, "report_summary"); assert.deepEqual([w.entities.from, w.entities.to], ["2026-09-21", TODAY]);
  const c = p("Compare yesterday vs today");
  assert.equal(c.intent, "compare_days"); assert.deepEqual([c.entities.from, c.entities.to], ["2026-09-24", TODAY]);
  assert.equal(p("Give target achievement report").intent, "target_status");
  const d = p("Give me the department-wise report for 2026-09-20");
  assert.equal(d.intent, "report_summary"); assert.equal(d.entities.date, "2026-09-20");
  const l7 = p("Show production for the last 7 days");
  assert.deepEqual([l7.entities.from, l7.entities.to], ["2026-09-19", TODAY]);
  const named = p("production report from 10 Sep to 14 Sep");
  assert.deepEqual([named.entities.from, named.entities.to], ["2026-09-10", "2026-09-14"]);
});

test("products, sizes and people", () => {
  const prod = p("How many pieces of product Front Office Shirt are completed?");
  assert.equal(prod.intent, "product_progress"); assert.equal(prod.entities.product, "Front Office Shirt");
  const size = p("Show production of size M");
  assert.equal(size.intent, "product_progress"); assert.equal(size.entities.size, "M");
  const v = p("Give variant-wise progress for PO 4471");
  assert.equal(v.intent, "order_status"); assert.equal(v.entities.po, "4471");
  const pw = p("Show person-wise production for PO 4471");
  assert.equal(pw.intent, "person_wise"); assert.equal(pw.entities.po, "4471");
  const person = p("What is the status of employee Rakesh Kumar's order?");
  assert.equal(person.intent, "person_wise"); assert.equal(person.entities.person, "Rakesh Kumar");
});

test("unknown questions ask for help rather than guessing", () => {
  assert.equal(p("hello there").intent, "help");
  assert.equal(p("what can you answer?").intent, "help");
});
