"use strict";
/**
 * 10 — A MANAGER ACTS ONLY INSIDE THEIR SERVER-PROVEN REPORTING SCOPE.
 *
 * The REAL employee leave router, mounted behind the REAL HR contract. The
 * authority under test is not a capability — it is a relationship, and it has
 * to come from the stored `primaryManager` / `secondaryManager` on the target's
 * own record. An employee id in the request body is a request, never a proof.
 *
 * This is the one place these tests load a production router rather than a
 * stub, because the proof lives inside the handler and asserting it any other
 * way would be asserting that the test's own copy of the rule is correct.
 */

/* ── NO EXTERNAL SIDE EFFECTS FROM AN AUTHORISATION TEST ────────────────────
 *
 * Two different problems, both caused by the same thing: this file mounts the
 * REAL leave router, and approving a leave fires notifications the handler
 * never waits for.
 *
 * `expo-server-sdk` is ESM-only and Jest's CommonJS loader refuses it outright,
 * so the module cannot even be required.
 *
 * `emailService` is worse than a load error: it actually tries to reach Brevo.
 * With no API key it rejects, and because the call is fire-and-forget the
 * rejection lands AFTER the test that triggered it has finished — Jest reports
 * "Cannot log after tests are done" and the run exits 1 with every assertion
 * green. An authorisation test has no business sending mail to anyone, so the
 * transport is stubbed rather than the log suppressed: the console stays
 * available to report anything that genuinely goes wrong. */
jest.mock("../../services/emailService", () => {
  /* A Proxy rather than a list of names: emailService is a class instance with
     a dozen send methods and the router probes for them by name
     (`emailService?.sendLeaveManagerApprovedToHR`), so enumerating them here
     would be a second list to keep in step with the first. */
  return new Proxy(
    {},
    { get: () => async () => ({ mocked: true }) },
  );
});

/* Only the SENDER is stubbed. The module also exports three IST date helpers
   that callers destructure and use for real work, and replacing those with
   undefined would break a route for a reason that has nothing to do with
   notifications. */
jest.mock("../../utils/sendExpoPush", () => ({
  ...jest.requireActual("../../utils/sendExpoPush"),
  sendExpoPush: async () => ({ mocked: true }),
}));

jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() { return false; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const express = require("express");
const cookieParser = require("cookie-parser");

const { resetAccessCaches, makeDepartment, makeEmployee, appToken, bearer } = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const { LeaveApplication } = require("../../models/HR_Models/LeaveManagement");

let server, base, sales;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employee", hrContract());
  app.use("/api/employee/leave-applications", require("../../routes/Employee_Routes/leaveRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  resetAccessCaches();
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
});

async function post(path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patch(path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(path, token) {
  const res = await fetch(`${base}${path}`, { headers: bearer(token) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("acting on behalf of somebody", () => {
  test("a manager may raise leave for their OWN report and not for a stranger", async () => {
    const boss = await makeEmployee({ biometricId: "GRBOSS", email: "boss@grav.in", accessDepartmentId: sales._id });
    const mine = await makeEmployee({
      biometricId: "GRMINE",
      email: "mine@grav.in",
      accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: boss._id, managerName: "Boss" },
    });
    const stranger = await makeEmployee({
      biometricId: "GRSTRANGE",
      email: "stranger@grav.in",
      accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
    });

    const token = appToken({ id: String(boss._id), email: "boss@grav.in" });
    const payload = (employeeId) => ({
      employeeId: String(employeeId),
      leaveType: "CL",
      fromDate: "2026-10-01",
      toDate: "2026-10-01",
      reason: "Family work",
    });

    const refused = await post("/api/employee/leave-applications/manager/add-on-behalf", token, payload(stranger._id));
    expect(refused.status).toBe(403);
    /* Refused by the CONTRACT, before the handler runs — which is why the
       message is the contract's uniform one rather than the handler's "Not a
       manager of this employee". The handler's own check remains as defence in
       depth; it is simply no longer the first line, and the caller no longer
       learns from the wording whether the employee exists. */
    expect(refused.body.code).toBe("HR_OUT_OF_SCOPE");
    expect(String(refused.body.message)).toBe("You do not have permission to perform this action.");

    const permitted = await post("/api/employee/leave-applications/manager/add-on-behalf", token, payload(mine._id));
    /* Anything other than a refusal is the point: the relationship was proved
       and the handler went on to do its own work. */
    expect(permitted.status).not.toBe(403);
  });

  test("claiming to be somebody's manager in the body proves nothing", async () => {
    const impostor = await makeEmployee({ biometricId: "GRIMP", email: "imp@grav.in", accessDepartmentId: sales._id });
    const boss = await makeEmployee({ biometricId: "GRBOSS2", email: "boss2@grav.in", accessDepartmentId: sales._id });
    const target = await makeEmployee({
      biometricId: "GRTGT",
      email: "tgt@grav.in",
      accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: boss._id, managerName: "Boss" },
    });

    const token = appToken({ id: String(impostor._id), email: "imp@grav.in" });
    const r = await post("/api/employee/leave-applications/manager/add-on-behalf", token, {
      employeeId: String(target._id),
      /* Every hint the caller can invent, all of it ignored. */
      managerId: String(boss._id),
      isManager: true,
      role: "hr_manager",
      leaveType: "CL",
      fromDate: "2026-10-01",
      toDate: "2026-10-01",
      reason: "Trying it on",
    });
    expect(r.status).toBe(403);
  });
});

describe("deciding somebody else's request", () => {
  test("a manager cannot approve a leave they were never notified on", async () => {
    const boss = await makeEmployee({ biometricId: "GRB3", email: "b3@grav.in", accessDepartmentId: sales._id });
    const other = await makeEmployee({ biometricId: "GRO3", email: "o3@grav.in", accessDepartmentId: sales._id });
    const applicant = await makeEmployee({
      biometricId: "GRA3",
      email: "a3@grav.in",
      accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: boss._id, managerName: "Boss" },
    });

    const leave = await LeaveApplication.create({
      employeeId: applicant._id,
      employeeName: "A3",
      leaveType: "CL",
      fromDate: new Date("2026-10-05"),
      toDate: new Date("2026-10-05"),
      reason: "Personal",
      totalDays: 1,
      applicationDate: new Date("2026-09-20"),
      status: "pending",
      managersNotified: [{ managerId: boss._id, type: "primary" }],
    });

    const stranger = appToken({ id: String(other._id), email: "o3@grav.in" });
    const r = await patch(`/api/employee/leave-applications/manager/${leave._id}/approve`, stranger, {});
    expect([403, 404]).toContain(r.status);

    /* And the queue itself is scoped: a manager sees only what names them. */
    const mine = await get("/api/employee/leave-applications/manager/pending", appToken({ id: String(boss._id), email: "b3@grav.in" }));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((l) => String(l._id))).toContain(String(leave._id));

    /* Somebody who manages nobody does not reach the queue at all any more —
       the central contract refuses the persona before the handler's query runs.
       It used to answer 200 with an empty list, which meant the manager routes
       were open to every authenticated employee. */
    const theirs = await get("/api/employee/leave-applications/manager/pending", stranger);
    expect(theirs.status).toBe(403);
    expect(theirs.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("two real managers each see only their own queue", async () => {
    const bossA = await makeEmployee({ biometricId: "GRBA", email: "ba@grav.in", accessDepartmentId: sales._id });
    const bossB = await makeEmployee({ biometricId: "GRBB", email: "bb@grav.in", accessDepartmentId: sales._id });
    const reportA = await makeEmployee({
      biometricId: "GRRA", email: "ra@grav.in", accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: bossA._id, managerName: "A" },
    });
    const reportB = await makeEmployee({
      biometricId: "GRRB", email: "rb@grav.in", accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: bossB._id, managerName: "B" },
    });

    const leaveFor = (employee, manager) =>
      LeaveApplication.create({
        employeeId: employee._id,
        employeeName: "R",
        leaveType: "CL",
        fromDate: new Date("2026-11-02"),
        toDate: new Date("2026-11-02"),
        totalDays: 1,
        applicationDate: new Date("2026-10-20"),
        reason: "Personal",
        status: "pending",
        managersNotified: [{ managerId: manager._id, type: "primary" }],
      });

    const leaveA = await leaveFor(reportA, bossA);
    const leaveB = await leaveFor(reportB, bossB);

    const queueA = await get("/api/employee/leave-applications/manager/pending", appToken({ id: String(bossA._id), email: "ba@grav.in" }));
    expect(queueA.status).toBe(200);
    const idsA = queueA.body.data.map((l) => String(l._id));
    expect(idsA).toContain(String(leaveA._id));
    expect(idsA).not.toContain(String(leaveB._id));

    const queueB = await get("/api/employee/leave-applications/manager/pending", appToken({ id: String(bossB._id), email: "bb@grav.in" }));
    const idsB = queueB.body.data.map((l) => String(l._id));
    expect(idsB).toContain(String(leaveB._id));
    expect(idsB).not.toContain(String(leaveA._id));
  });

  test("a real manager with an EMPTY queue is still let in", async () => {
    const quietBoss = await makeEmployee({ biometricId: "GRQB", email: "qb@grav.in", accessDepartmentId: sales._id });
    await makeEmployee({
      biometricId: "GRQR", email: "qr@grav.in", accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: quietBoss._id, managerName: "Quiet" },
    });

    const r = await get("/api/employee/leave-applications/manager/pending", appToken({ id: String(quietBoss._id), email: "qb@grav.in" }));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
});
