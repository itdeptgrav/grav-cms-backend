"use strict";
/**
 * THE REPAIRS TRAVEL WITH THE CODE.
 *
 * services/startupRepairs.js runs on every boot against whatever database the
 * server is connected to — production's is not the one the fixes were first
 * made on. These run it against a fresh (in-memory) database shaped like the
 * records that needed repairing, and then run it AGAIN to prove a second boot
 * changes nothing.
 */

const mongoose = require("mongoose");
const { repairLateRegularized, repairDepartedEmployees, ensureAdminAccounting } = require("../../services/startupRepairs");

const db = () => mongoose.connection.db;
const oid = () => new mongoose.Types.ObjectId();

describe("late-streak markers", () => {
  async function seed() {
    const emp = oid();
    await db().collection("dailyattendances").insertMany([
      { dateStr: "2026-09-03", employees: [{ employeeDbId: emp, biometricId: "GR0063", isLate: false, systemPrediction: "P" }] },
      { dateStr: "2026-09-10", employees: [{ employeeDbId: emp, biometricId: "GR0063", isLate: false, systemPrediction: "P" }] },
      { dateStr: "2026-09-11", employees: [{ employeeDbId: emp, biometricId: "GR0063", isLate: true, systemPrediction: "P*" }] },
    ]);
    const base = { employeeId: String(emp), biometricId: "GR0063", status: "hr_approved", appliedToAttendance: true };
    await db().collection("regularizationrequests").insertMany([
      { ...base, dateStr: "2026-09-03", originalSnapshot: { lateMins: 25, systemPrediction: "P*" } }, // late, taken away
      { ...base, dateStr: "2026-09-10", originalSnapshot: { lateMins: 40, systemPrediction: "HD" } }, // a half day, not a late
      { ...base, dateStr: "2026-09-11", originalSnapshot: { lateMins: 10, systemPrediction: "P*" } }, // still late
    ]);
  }
  const marker = async (d) => (await db().collection("dailyattendances").findOne({ dateStr: d })).employees[0].lateRegularized;

  test("stamps only a late day the regularization took the late away from", async () => {
    await seed();
    expect(await repairLateRegularized(db())).toMatchObject({ stamped: 1 });
    expect(await marker("2026-09-03")).toBe(true);
    expect(await marker("2026-09-10")).toBeUndefined();
    expect(await marker("2026-09-11")).toBeUndefined();
  });

  test("a second boot stamps nothing", async () => {
    await seed();
    await repairLateRegularized(db());
    expect(await repairLateRegularized(db())).toMatchObject({ stamped: 0 });
  });
});

describe("departed employees", () => {
  test("a current report is detached from a manager who left, once", async () => {
    const gone = { _id: oid(), firstName: "PRADEEP", lastName: "PRADHAN", biometricId: "GR0025", isActive: false, status: "inactive" };
    const here = { _id: oid(), firstName: "RANI", biometricId: "GR0054", status: "active", primaryManager: { managerId: gone._id, managerName: "PRADEEP" } };
    await db().collection("employees").insertMany([gone, here]);

    const first = await repairDepartedEmployees(db());
    expect(first.detached).toHaveLength(1);
    expect((await db().collection("employees").findOne({ _id: here._id })).primaryManager.managerId).toBeNull();
    expect(await db().collection("employees").findOne({ _id: gone._id })).toBeTruthy(); // kept

    expect((await repairDepartedEmployees(db())).detached).toHaveLength(0);
  });
});

describe("administrator accounting access", () => {
  test("a platform administrator with no Accounting record gets a role-only one; nobody else does", async () => {
    const org = oid();
    await db().collection("acc_organizations").insertOne({ _id: org, name: "GRAV" });
    await db().collection("dept_users").insertMany([
      { email: "ceo@grav.in", name: "CEO", isAdmin: true, isActive: true },
      { email: "staff@grav.in", name: "Staff", isAdmin: false, isActive: true },
    ]);
    expect((await ensureAdminAccounting(db())).created).toEqual(["ceo@grav.in"]);
    const row = await db().collection("acc_users").findOne({ email: "ceo@grav.in" });
    expect(row).toMatchObject({ loginMode: "none", role: "approver", isActive: true });
    expect(String(row.organizationId)).toBe(String(org));
    expect(await db().collection("acc_users").findOne({ email: "staff@grav.in" })).toBeNull();
    expect((await ensureAdminAccounting(db())).created).toEqual([]);
  });

  test("an existing (even inactive) record is somebody's decision and is left alone", async () => {
    const org = oid();
    await db().collection("acc_organizations").insertOne({ _id: org, name: "GRAV" });
    await db().collection("dept_users").insertOne({ email: "ceo@grav.in", isAdmin: true, isActive: true });
    await db().collection("acc_users").insertOne({ organizationId: org, email: "ceo@grav.in", role: "viewer", isActive: false });
    expect((await ensureAdminAccounting(db())).created).toEqual([]);
    expect(await db().collection("acc_users").findOne({ email: "ceo@grav.in" })).toMatchObject({ isActive: false, role: "viewer" });
  });
});
