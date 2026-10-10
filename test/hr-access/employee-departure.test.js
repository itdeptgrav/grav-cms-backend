"use strict";
/**
 * WHEN SOMEBODY LEAVES, NOTHING CURRENT POINTS AT THEM — and nothing is deleted.
 *
 * services/employeeDeparture.js against a real (in-memory) database, shaped
 * like the record that prompted it: PRADEEP PRADHAN, inactive, was still RANI
 * TUDU's secondary manager, two of her regularizations waited on him, and a
 * departed colleague still held a Store approver grant.
 */

const mongoose = require("mongoose");
const { detachDepartedEmployee, hasLeft } = require("../../services/employeeDeparture");

const db = () => mongoose.connection.db;
const oid = () => new mongoose.Types.ObjectId();

async function seed() {
  const pradeep = { _id: oid(), firstName: "PRADEEP", lastName: "PRADHAN", biometricId: "GR0025", email: "pradeep@grav.in", isActive: false, status: "inactive" };
  const rani = { _id: oid(), firstName: "RANI", lastName: "TUDU", biometricId: "GR0054", status: "active",
    primaryManager: { managerId: oid(), managerName: "SHAIK SAKIB (GR0063)" },
    secondaryManager: { managerId: pradeep._id, managerName: "PRADEEP PRADHAN (GR0025)" } };
  const formerReport = { _id: oid(), firstName: "GOBINDA", lastName: "SWAIN", biometricId: "GR0103", isActive: false, status: "inactive",
    primaryManager: { managerId: pradeep._id, managerName: "PRADEEP PRADHAN (GR0025)" } };
  await db().collection("employees").insertMany([pradeep, rani, formerReport]);

  const waiting = { _id: oid(), employeeName: "RANI TUDU", dateStr: "2026-09-01", status: "manager_approved",
    managersNotified: [
      { managerId: rani.primaryManager.managerId, type: "primary", managerName: "SHAIK SAKIB (GR0063)" },
      { managerId: pradeep._id, type: "secondary", managerName: "PRADEEP PRADHAN (GR0025)" },
    ] };
  const decided = { _id: oid(), employeeName: "RANI TUDU", dateStr: "2026-08-01", status: "hr_approved",
    managersNotified: [{ managerId: pradeep._id, type: "secondary" }] };
  await db().collection("regularizationrequests").insertMany([waiting, decided]);

  await db().collection("departments").insertOne({ name: "PRODUCTION", secondaryManager: { managerId: pradeep._id, managerName: "PRADEEP", designation: "SUPERVISOR" } });
  await db().collection("department_roles").insertOne({ email: "pradeep@grav.in", departmentSlug: "store", role: "approver", isActive: true });
  return { pradeep, rani, formerReport, waiting, decided };
}

describe("detachDepartedEmployee", () => {
  test("an active employee no longer reports to somebody who has left", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const rani = await db().collection("employees").findOne({ _id: s.rani._id });
    expect(rani.secondaryManager.managerId).toBeNull();
    expect(rani.primaryManager.managerName).toBe("SHAIK SAKIB (GR0063)"); // untouched
  });

  test("a FORMER report keeps him on record — that is history, not a reporting line", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const gobinda = await db().collection("employees").findOne({ _id: s.formerReport._id });
    expect(String(gobinda.primaryManager.managerId)).toBe(String(s.pradeep._id));
  });

  test("a request still waiting on him is released to HR, never approved on his behalf", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const r = await db().collection("regularizationrequests").findOne({ _id: s.waiting._id });
    expect(r.status).toBe("manager_approved"); // NOT moved to approved
    expect(r.managersNotified.map((m) => m.type)).toEqual(["primary"]);
    expect(r.departedManagerNote).toMatch(/left the company.*HR decides/);
  });

  test("a request already decided keeps the chain it was decided under", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const r = await db().collection("regularizationrequests").findOne({ _id: s.decided._id });
    expect(r.managersNotified).toHaveLength(1);
  });

  test("no department hands new joiners to him", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const d = await db().collection("departments").findOne({ name: "PRODUCTION" });
    expect(d.secondaryManager.managerId).toBeNull();
  });

  test("his access grants are switched off, and kept", async () => {
    const s = await seed();
    await detachDepartedEmployee(db(), s.pradeep);
    const g = await db().collection("department_roles").findOne({ email: "pradeep@grav.in" });
    expect(g).toBeTruthy(); // not deleted
    expect(g.isActive).toBe(false);
    expect(g.deactivatedReason).toMatch(/left/);
  });

  test("his own employee record is not touched at all", async () => {
    const s = await seed();
    const before = await db().collection("employees").findOne({ _id: s.pradeep._id });
    await detachDepartedEmployee(db(), s.pradeep);
    expect(await db().collection("employees").findOne({ _id: s.pradeep._id })).toEqual(before);
  });

  test("a dry run writes nothing, and a second run finds nothing", async () => {
    const s = await seed();
    const plan = await detachDepartedEmployee(db(), s.pradeep, { dryRun: true });
    expect(plan.reports).toHaveLength(1);
    expect((await db().collection("employees").findOne({ _id: s.rani._id })).secondaryManager.managerId).toBeTruthy();
    await detachDepartedEmployee(db(), s.pradeep);
    const again = await detachDepartedEmployee(db(), s.pradeep, { dryRun: true });
    expect(again.reports.length + again.departments.length + again.requests.length + again.grants.length).toBe(0);
  });

  test("hasLeft reads either flag", () => {
    expect(hasLeft({ status: "inactive" })).toBe(true);
    expect(hasLeft({ isActive: false })).toBe(true);
    expect(hasLeft({ status: "active", isActive: true })).toBe(false);
    expect(hasLeft({})).toBe(false);
  });
});
