// services/maintenance/maintenanceOrderFlow.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const flow = require("./maintenanceOrderFlow");

test("both kinds go Open → In progress → Report pending → (report) → Closed, and no further", () => {
  for (const type of ["service", "product"]) {
    assert.equal(flow.INITIAL[type], "OPEN", type);
    let s = "OPEN";
    for (const [action, to] of [["start", "IN_PROGRESS"], ["done", "DONE"], ["report", "CLOSED"]]) {
      const r = flow.stepFor(type, s, action);
      assert.equal(r.ok, true, `${type}: ${action} from ${s}`);
      assert.equal(r.step.to, to);
      s = to;
    }
    assert.deepEqual(flow.availableActions(type, "CLOSED"), []);
    assert.deepEqual(flow.availableActions(type, "CANCELLED"), []);
    for (const a of ["start", "done", "report", "close", "cancel"]) assert.equal(flow.stepFor(type, "CLOSED", a).ok, false, a);
    assert.deepEqual(flow.availableActions(type, "DONE").map((a) => a.key), ["report"], "the ONLY way out of Report pending is the report");
  }
  assert.deepEqual(flow.STATUSES, ["OPEN", "IN_PROGRESS", "DONE", "CLOSED", "CANCELLED"]);
});

test("cancel needs a reason and is open only before the work is done", () => {
  assert.deepEqual(flow.ACTIONS.service.cancel.needs, ["reason"]);
  assert.equal(flow.stepFor("service", "OPEN", "cancel").ok, true);
  assert.equal(flow.stepFor("product", "IN_PROGRESS", "cancel").ok, true);
  assert.equal(flow.stepFor("service", "DONE", "cancel").ok, false);
});

test("steps cannot be skipped or repeated", () => {
  assert.equal(flow.stepFor("service", "OPEN", "done").ok, false);
  assert.equal(flow.stepFor("service", "IN_PROGRESS", "start").ok, false);
  assert.equal(flow.stepFor("product", "OPEN", "close").ok, false);
  assert.equal(flow.stepFor("nonsense", "OPEN", "start").ok, false);
  assert.equal(flow.stepFor("service", "OPEN", "teleport").ok, false);
});

test("the clock starts on Start and stops on Repair completed; closing needs the report", () => {
  assert.equal(flow.ACTIONS.service.start.clock, "start");
  assert.equal(flow.ACTIONS.service.done.clock, "stop");
  assert.equal(flow.ACTIONS.service.done.needs, undefined, "Repair completed asks for nothing — the report comes next");
  assert.deepEqual(flow.ACTIONS.service.report.needs, ["report"]);
  assert.equal(flow.ACTIONS.service.close, undefined, "there is no bare Close");
  assert.equal(flow.STATUS_LABEL.DONE, "Report pending");
  assert.equal(flow.formatReportNumber(1), "MR-0001");
  assert.equal(flow.formatReportNumber(12345), "MR-12345");
  assert.equal(flow.ACTIONS.product, flow.ACTIONS.service, "one set of steps for both kinds");
});

test("the first version's statuses and step names are read as the new ones", () => {
  const cases = { DRAFT: "OPEN", CREATED: "OPEN", IN_MAINTENANCE: "OPEN", IN_PROGRESS: "IN_PROGRESS", WORK_IN_PROGRESS: "IN_PROGRESS",
    REPAIR_COMPLETED: "DONE", SOLVED: "DONE", CLOSED: "CLOSED", COMPLETED: "CLOSED", CANCELLED: "CANCELLED" };
  for (const [old, now] of Object.entries(cases)) assert.equal(flow.normalizeStatus(old), now, old);
  assert.deepEqual(flow.storedAs("OPEN").sort(), ["CREATED", "DRAFT", "IN_MAINTENANCE", "OPEN"]);
  assert.deepEqual(flow.storedAs("DONE").sort(), ["DONE", "REPAIR_COMPLETED", "SOLVED"]);
  /* An old job, an old button: still the right step. */
  assert.equal(flow.stepFor("product", "WORK_IN_PROGRESS", "solve").action, "done");
  assert.equal(flow.stepFor("service", "IN_PROGRESS", "complete-repair").step.to, "DONE");
  assert.equal(flow.stepFor("product", "SOLVED", "complete").action, "report", "an old Close button now means the report");
  assert.equal(flow.stepFor("service", "DONE", "close").action, "report");
  assert.deepEqual(flow.availableActions("service", "DRAFT").map((a) => a.key), ["start", "cancel"]);
});

test("repair time is computed from the two timestamps", () => {
  assert.equal(flow.minutesBetween("2026-10-03T04:45:00Z", "2026-10-03T06:10:00Z"), 85);
  assert.equal(flow.formatDuration(85), "1 hr 25 min");
  assert.equal(flow.formatDuration(45), "45 min");
  assert.equal(flow.formatDuration(60), "1 hr");
  assert.equal(flow.formatDuration(0), "0 min");
  assert.equal(flow.formatDuration(1440 * 2 + 180), "2 days 3 hr");
  assert.equal(flow.minutesBetween(null, "2026-10-03T06:10:00Z"), null);
  assert.equal(flow.minutesBetween("2026-10-03T06:10:00Z", "2026-10-03T04:45:00Z"), null);
  assert.equal(flow.formatDuration(null), null);
});

test("job numbers are prefixed and padded", () => {
  assert.equal(flow.formatOrderNumber("service", 1), "MSO-0001");
  assert.equal(flow.formatOrderNumber("product", 19), "MPO-0019");
  assert.equal(flow.formatOrderNumber("service", 12345), "MSO-12345");
});

test("repair figures count only finished repairs, newest first, across both kinds — old statuses included", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const orders = [
    { orderType: "service", status: "CLOSED", workDoneAt: "2026-10-03T06:10:00Z", repairMinutes: 85 },
    { orderType: "product", status: "COMPLETED", workDoneAt: "2026-10-20T10:00:00Z", repairMinutes: 130 },
    { orderType: "service", status: "DONE", workDoneAt: "2026-11-04T05:00:00Z", repairMinutes: 45 },
    { orderType: "service", status: "IN_PROGRESS" },
    { orderType: "product", status: "OPEN" },
    { orderType: "product", status: "CANCELLED" },
  ];
  const s = flow.repairStats(orders, now);
  assert.equal(s.repairs, 3);
  assert.equal(s.lastRepairedAt, "2026-11-04T05:00:00Z");
  assert.equal(s.previousRepairedAt, "2026-10-20T10:00:00Z");
  assert.equal(s.daysSinceLastRepair, 0);
  assert.equal(s.lastRepairMinutes, 45);
  assert.equal(s.averageRepairMinutes, 87);
  assert.equal(s.open, 2);
  assert.deepEqual(flow.repairStats([]), {
    repairs: 0, lastRepairedAt: null, previousRepairedAt: null, daysSinceLastRepair: null,
    daysBetweenLastTwo: null, lastRepairMinutes: null, averageRepairMinutes: null, open: 0,
  });
});
