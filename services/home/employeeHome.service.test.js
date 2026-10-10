"use strict";

// The home service against recording stand-ins — no database. Proves who "me"
// is for each kind of session, that self-service is offered only where the
// /api/employee routes would accept the token, that a failing source is
// "unavailable" (never empty), and that colleague search returns name, role,
// department and photo only.

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.HOME_CACHE_MS = "0";
process.env.HOME_PEOPLE_CACHE_MS = "0";
process.env.HOME_SECTION_TIMEOUT_MS = "200";

const svc = require("./employeeHome.service");
const M = svc._models;

const EMP = "64b000000000000000000001";
const DU = "64b000000000000000000002";
const NOW = new Date("2026-10-10T05:00:00Z"); // 10:30 IST

/** A chainable query that resolves to `rows` (or throws `fail`). */
function q(rows, fail) {
  const p = {
    select() { return p; }, sort() { return p; }, limit() { return p; }, maxTimeMS() { return p; },
    lean() { return fail ? Promise.reject(new Error(fail)) : Promise.resolve(rows); },
    then(ok, bad) { return p.lean().then(ok, bad); },
  };
  return p;
}

const employees = [
  { _id: EMP, firstName: "Rishi", lastName: "Das", designation: "Merchandiser", department: "Merchandising", biometricId: "GR0067", email: "rishi@grav.in", dateOfBirth: new Date("1994-10-12T00:00:00Z"), dateOfJoining: new Date("2022-10-15T00:00:00Z"), personalEmail: "secret@home", phone: "999" },
  { _id: "64b000000000000000000003", firstName: "Asha", lastName: "Rao", designation: "QC Inspector", department: "Quality Control", dateOfJoining: new Date("2026-10-01T00:00:00Z") },
];

function install({ leaveFails = false } = {}) {
  M.Employee = () => ({
    findOne: (f) => q(employees.find((e) => String(e._id) === String(f._id)) || null),
    find: (f) => q(f.email ? employees.filter((e) => e.email === f.email) : f.biometricId ? employees.filter((e) => e.biometricId === f.biometricId) : employees),
  });
  M.DeptUser = () => ({ findById: (id) => q(id === DU ? { _id: DU, employeeRef: EMP } : null) });
  M.Leave = () => ({
    LeaveApplication: {
      find: (f) => (f.employeeId
        ? q([
          { _id: "l1", leaveType: "CL", fromDate: "2026-10-20", toDate: "2026-10-20", status: "pending" },
          { _id: "l2", leaveType: "SL", fromDate: "2026-10-10", toDate: "2026-10-10", status: "hr_approved", isHalfDay: true },
          { _id: "l3", leaveType: "PL", fromDate: "2026-11-02", toDate: "2026-11-04", status: "hr_approved" },
        ], leaveFails ? "boom" : null)
        : q([{ employeeId: EMP, employeeName: "Rishi Das" }, { employeeId: "x", employeeName: "Bikash" }])),
    },
    RegularizationRequest: { countDocuments: () => q(2) },
    CompanyHoliday: { find: () => q([{ date: "2026-10-20", name: "Durga Puja" }]) },
  });
  M.DailyAttendance = () => ({ findOne: () => q({ employees: [{ biometricId: "GR0067", inTime: new Date("2026-10-10T04:05:00Z"), systemPrediction: "P" }] }) });
  M.EmployeeDocument = () => ({ countDocuments: () => q(1) });
  M.EmployeeTask = () => ({ find: () => q([]) });
  M.PlannerTask = () => ({ find: () => q([
    { _id: "t1", title: "Send tech pack", status: "todo", dueOn: new Date("2026-10-08T00:00:00Z") },
    { _id: "t2", title: "Call mill", status: "doing", dueOn: new Date("2026-10-10T00:00:00Z") },
  ]) });
  M.firestore = () => ({
    collection: () => ({ where: () => ({ get: async () => ({ forEach: (fn) => [
      { id: "m1", data: () => ({ title: "Fit review", dateTime: "2026-10-10T15:00:00+05:30", participants: ["GR0067"], createdBy: "GR0067", googleMeetLink: "https://meet.google.com/x" }) },
      { id: "m2", data: () => ({ title: "Tomorrow", dateTime: "2026-10-11T10:00:00+05:30" }) },
      { id: "m3", data: () => ({ title: "Cancelled", dateTime: "2026-10-10T11:00:00+05:30", isCancelled: true }) },
    ].forEach(fn) }) }) }),
  });
}

test("an employee login is themselves, and may self-serve", async () => {
  install();
  const out = await svc._compute({ id: EMP, subject: "employee", email: "rishi@grav.in" }, NOW);
  assert.equal(out.me.name, "Rishi Das");
  assert.equal(out.me.selfService, true);
  const s = out.sections;
  assert.equal(s.attendance.recorded, true);
  assert.equal(s.attendance.code, "P");
  assert.deepEqual(s.leave.pending.map((l) => l.id), ["l1"]);
  assert.equal(s.leave.today.id, "l2");
  assert.deepEqual(s.leave.upcoming.map((l) => l.id), ["l3"]);
  assert.deepEqual([s.requests.regularizations, s.requests.documents], [2, 1]);
  assert.deepEqual([s.planner.overdue, s.planner.dueToday], [1, 1]);
  assert.deepEqual(s.meetings.items.map((m) => m.id), ["m1"]);
  assert.equal(s.away.count, 1, "the person themself is not listed as away");
  assert.equal(s.holidays.items[0].name, "Durga Puja");
  assert.ok(Array.isArray(s.holidays.month), "the calendar's month of holidays is sent");
  assert.deepEqual(s.holidays.range, { from: "2026-10-01", before: "2026-12-01" });
  assert.deepEqual(out.shift, { start: "09:30", end: "18:30" });
  assert.deepEqual(s.people.birthdays.map((p) => p.name), ["Rishi Das"]);
  assert.deepEqual(s.people.joiners.map((p) => p.name), ["Asha Rao"]);
});

test("a department login reaches its linked employee but is not offered self-service", async () => {
  install();
  const out = await svc._compute({ id: DU, subject: "dept_user", email: "store@grav.in" }, NOW);
  assert.equal(out.me.name, "Rishi Das");
  assert.equal(out.me.via, "linked");
  assert.equal(out.me.selfService, false);
});

test("an accounting login is matched by email; with no match it still gets the company sections", async () => {
  install();
  const hit = await svc._compute({ id: "acc1", subject: "accountant", email: "rishi@grav.in" }, NOW);
  assert.equal(hit.me.via, "email");
  const miss = await svc._compute({ id: "acc2", subject: "accountant", email: "nobody@grav.in", name: "Books" }, NOW);
  assert.equal(miss.me.linked, false);
  assert.equal(miss.me.name, "Books");
  assert.equal(miss.sections.leave.status, "none");
  assert.equal(miss.sections.holidays.status, "ok");
});

test("a failing source is unavailable, not empty, and the rest still answers", async () => {
  install({ leaveFails: true });
  const out = await svc._compute({ id: EMP, subject: "employee" }, NOW);
  assert.equal(out.sections.leave.status, "unavailable");
  assert.equal(out.sections.leave.pending, undefined);
  assert.equal(out.sections.attendance.status, "ok");
});

test("colleague search: two characters, every word, name/role/department/photo only", async () => {
  install();
  assert.deepEqual(await svc.searchPeople("r"), []);
  const out = await svc.searchPeople("qc insp");
  assert.deepEqual(out.map((p) => p.name), ["Asha Rao"]);
  assert.deepEqual(Object.keys(out[0]).sort(), ["department", "id", "name", "photo", "role"]);
  const byName = await svc.searchPeople("ris");
  assert.equal(byName[0].name, "Rishi Das");
});
