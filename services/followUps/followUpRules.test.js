// services/followUps/followUpRules.test.js — the follow-up rules, no database.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("./followUpRules");

const NOW = new Date("2026-10-09T06:00:00Z");
const ravi = { id: "e1", email: "ravi@grav.in", name: "Ravi", dept: "merchandiser" };
const priya = { id: "e2", email: "priya@grav.in", name: "Priya", dept: "research-development" };
const pm = { id: "e3", email: "pm@grav.in", name: "Asha", dept: "ppc" };

function fu(over = {}) {
  return {
    status: "open", fromDept: "merchandiser", toDept: "research-development",
    assignee: { id: priya.id, email: priya.email, name: priya.name },
    raisedBy: { id: ravi.id, email: ravi.email, name: ravi.name, dept: "merchandiser" },
    needsPerson: false, dueAt: new Date("2026-10-10T00:00:00Z"),
    ...over,
  };
}

test("a session's department: the old Project Manager slug is the production manager", () => {
  assert.equal(rules.deptOfSlug("project-manager"), "ppc");
  assert.equal(rules.deptOfSlug("ppc"), "ppc");
  assert.equal(rules.deptOfSlug("research-development"), "research-development");
  assert.equal(rules.deptOfSlug("store"), "");
  assert.equal(rules.deptOfSlug(""), "");
});

test("the same person by email, else by id", () => {
  assert.ok(rules.samePerson({ id: "x", email: "A@grav.in" }, { id: "y", email: "a@grav.in" }));
  assert.ok(!rules.samePerson({ id: "x", email: "a@grav.in" }, { id: "x", email: "b@grav.in" }));
  assert.ok(rules.samePerson({ id: "x" }, { id: "x", email: "" }));
  assert.ok(!rules.samePerson({ id: "" }, { id: "" }));
});

test("overdue only while open and past the date", () => {
  assert.ok(rules.isOverdue(fu({ dueAt: new Date("2026-10-08T00:00:00Z") }), NOW));
  assert.ok(!rules.isOverdue(fu(), NOW));
  assert.ok(!rules.isOverdue(fu({ status: "answered", dueAt: new Date("2026-10-08T00:00:00Z") }), NOW));
  assert.ok(!rules.isOverdue(fu({ dueAt: null }), NOW));
});

test("waiting on: assignee while open, raiser once answered, nobody for an automatic one answered", () => {
  assert.equal(rules.waitingOn(fu()), "assignee");
  assert.equal(rules.waitingOn(fu({ status: "answered" })), "raiser");
  assert.equal(rules.waitingOn(fu({ status: "answered", raisedBy: { system: true } })), "");
  assert.equal(rules.waitingOn(fu({ status: "closed" })), "");
});

test("'for me' holds what I must do and the answers I must check", () => {
  assert.ok(rules.inView(fu(), "mine", priya, NOW));
  assert.ok(!rules.inView(fu(), "mine", ravi, NOW));
  assert.ok(rules.inView(fu({ status: "answered" }), "mine", ravi, NOW));
  assert.ok(!rules.inView(fu({ status: "answered" }), "mine", priya, NOW));
  // Nobody named yet: the whole owning department sees it as theirs.
  const unnamed = fu({ needsPerson: true, assignee: {} });
  assert.ok(rules.inView(unnamed, "mine", { id: "e9", email: "other@grav.in", dept: "research-development" }, NOW));
  assert.ok(!rules.inView(unnamed, "mine", pm, NOW));
});

test("the other lists", () => {
  assert.ok(rules.inView(fu(), "raised", ravi, NOW));
  assert.ok(!rules.inView(fu({ raisedBy: { system: true, dept: "merchandiser" } }), "raised", ravi, NOW));
  assert.ok(rules.inView(fu(), "department", priya, NOW));
  assert.ok(rules.inView(fu(), "department", ravi, NOW));
  assert.ok(!rules.inView(fu(), "department", pm, NOW));
  assert.ok(rules.inView(fu({ status: "closed" }), "closed", pm, NOW));
  assert.ok(!rules.inView(fu({ status: "closed" }), "open", pm, NOW));
});

test("viewQuery never matches everybody for a person with no email or id", () => {
  assert.deepEqual(rules.viewQuery("raised", { id: "", email: "" }).$and[1], { _id: null });
  assert.deepEqual(rules.viewQuery("department", { id: "a", email: "", dept: "" }), { _id: null });
});

test("who may do what", () => {
  const f = fu();
  assert.deepEqual(rules.allowed(f, priya), { answer: true, close: false, reopen: false, reassign: true, due: true, comment: true });
  assert.deepEqual(rules.allowed(f, ravi), { answer: false, close: true, reopen: false, reassign: true, due: true, comment: true });
  assert.deepEqual(rules.allowed(f, pm), { answer: false, close: false, reopen: false, reassign: false, due: false, comment: false });
  assert.equal(rules.allowed(f, { ...pm, isAdmin: true }).close, true);
  const answered = fu({ status: "answered" });
  assert.equal(rules.allowed(answered, ravi).reopen, true);
  assert.equal(rules.allowed(answered, priya).answer, false);
  // An automatic one: the assignee finishes it themselves.
  const auto = fu({ raisedBy: { system: true, dept: "sales" }, fromDept: "sales" });
  assert.equal(rules.allowed(auto, priya).close, true);
  assert.equal(rules.allowed(auto, ravi).close, false);
  // Nobody named: anyone in the owning department may answer or pick a person.
  const unnamed = fu({ needsPerson: true, assignee: {} });
  const colleague = { id: "e9", email: "other@grav.in", dept: "research-development" };
  assert.equal(rules.allowed(unnamed, colleague).answer, true);
  assert.equal(rules.allowed(unnamed, colleague).reassign, true);
  // Closed: only reopen and comment remain.
  const closed = rules.allowed(fu({ status: "closed" }), ravi);
  assert.equal(closed.reopen, true);
  assert.equal(closed.reassign, false);
  assert.equal(closed.due, false);
});

test("an automatic due date: the hand-off's own date, else working days skipping Sunday", () => {
  const given = rules.autoDueAt("bom_approval", "2026-10-20T10:00:00Z", NOW);
  assert.equal(given.toISOString(), "2026-10-20T10:00:00.000Z");
  // Fri 9 Oct + 2 working days → Sat 10, (Sun 11 skipped), Mon 12.
  const d = rules.autoDueAt("bom_approval", null, NOW);
  assert.equal(d.toISOString().slice(0, 10), "2026-10-12");
});

test("a manual follow-up needs a title, a department, a person and a date", () => {
  const empty = rules.validateNew({}, { now: NOW });
  assert.ok(empty.errors.length >= 4);
  const ok = rules.validateNew({
    title: "Size set for the polo", toDept: "research-development",
    assignee: { email: priya.email }, dueAt: "2026-10-12", subject: { type: "style", id: "abc" },
  }, { now: NOW });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.subject.type, "style");
  const past = rules.validateNew({ title: "x", toDept: "ppc", assignee: { email: "a@b" }, dueAt: "2026-09-01" }, { now: NOW });
  assert.ok(past.errors.includes("The due date is in the past."));
  const noRecord = rules.validateNew({ title: "x", toDept: "ppc", assignee: { email: "a@b" }, dueAt: "2026-10-12", subject: { type: "order" } }, { now: NOW });
  assert.ok(noRecord.errors.includes("Choose the style or order it is about."));
});

test("numbers and the IST day", () => {
  assert.equal(rules.numberOf(7), "FU-0007");
  assert.equal(rules.numberOf(12345), "FU-12345");
  assert.equal(rules.istDay(new Date("2026-10-09T19:00:00Z")), "2026-10-10");
});

test("every automatic kind is owned by one of the three departments", () => {
  for (const [kind, v] of Object.entries(rules.AUTO_KINDS)) {
    assert.ok(["ppc", "merchandiser", "research-development"].includes(v.toDept), kind);
  }
});
