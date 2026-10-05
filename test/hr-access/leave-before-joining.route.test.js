"use strict";
/**
 * A LEAVE CANNOT START BEFORE THE EMPLOYEE JOINED — through the real router.
 *
 * services/leaveDateWindow.test.js proves the rule. This proves the ROUTE uses
 * it, which is where the bug lived: `POST /api/employee/leave-applications`
 * already loaded `dateOfJoining` for the waiting-period check and never
 * compared it with `fromDate`, so a half-day sick leave dated 5 Sept 2025 was
 * accepted from somebody who joined on 4 May 2026. It minted a 2025 balance,
 * and the day they actually meant — 5 Sept 2026 — went on reading HD in HR,
 * because no leave named it.
 *
 * The real leave router and its real auth middleware, a real signed app token,
 * an in-memory database. Only the refusal path is exercised: it returns before
 * any notification, socket or balance write, so nothing here needs stubbing —
 * and the test asserts nothing was written, which is the property that
 * matters if the guard is ever moved below a side effect.
 */

/* The leave router reaches the push service, whose SDK is ESM and which jest
   cannot load untransformed. Mocked exactly as manager-scope.route.test.js and
   self-service-mass-assignment.route.test.js do; nothing here sends a push. */
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() { return false; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const express = require("express");
const cookieParser = require("cookie-parser");

const { makeEmployee, appToken } = require("./helpers");

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employee/leave-applications", require("../../routes/Employee_Routes/leaveRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** The employee the bug was found on: joined 4 May 2026. */
async function asha() {
  return makeEmployee({
    firstName: "Asha",
    lastName: "Naik",
    email: "asha.test@grav.in",
    biometricId: "GR0087",
    dateOfJoining: new Date("2026-05-04T00:00:00.000Z"),
  });
}

const apply = (emp, body) =>
  fetch(`${base}/api/employee/leave-applications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appToken({ id: String(emp._id), email: emp.email })}`,
    },
    body: JSON.stringify({
      leaveType: "SL",
      applicationDate: "2026-09-16",
      reason: "Unwell",
      isHalfDay: true,
      halfDaySlot: "first_half",
      ...body,
    }),
  });

describe("POST /api/employee/leave-applications — the joining-date bound", () => {
  it("refuses a leave dated before the employee joined, and says which year", async () => {
    const emp = await asha();
    const res = await apply(emp, { fromDate: "2025-09-05", toDate: "2025-09-05" });
    const payload = await res.json();

    expect(res.status).toBe(400);
    expect(payload.code).toBe("BEFORE_DATE_OF_JOINING");
    expect(payload.message).toMatch(/5 Sept 2025/);
    expect(payload.message).toMatch(/4 May 2026/);
  });

  it("writes nothing when it refuses", async () => {
    const emp = await asha();
    await apply(emp, { fromDate: "2025-09-05", toDate: "2025-09-05" });

    const db = require("mongoose").connection.db;
    expect(await db.collection("leaveapplications").countDocuments({})).toBe(0);
    /* The refused application used to mint a LeaveBalance for its year — a
       2025 row for somebody who joined in 2026. */
    expect(await db.collection("leavebalances").countDocuments({ year: 2025 })).toBe(0);
  });
});

describe("PUT /api/employee/leave-applications/:id — an edit cannot move it before joining", () => {
  /* Inserted straight into the collection: the create path reaches balances,
     notifications and sockets, none of which this is about, and the edit
     route reads the row with a plain findOne. Pending, not quick-apply —
     the two preconditions the edit checks before it looks at dates. */
  async function pendingLeave(emp, fromDate) {
    const db = require("mongoose").connection.db;
    const { insertedId } = await db.collection("leaveapplications").insertOne({
      employeeId: emp._id,
      biometricId: emp.biometricId,
      employeeName: "Asha Naik",
      leaveType: "SL",
      applicationDate: "2026-09-16",
      fromDate,
      toDate: fromDate,
      totalDays: 0.5,
      isHalfDay: true,
      halfDaySlot: "first_half",
      reason: "Unwell",
      status: "pending",
      isQuickApply: false,
    });
    return String(insertedId);
  }

  const edit = (emp, id, body) =>
    fetch(`${base}/api/employee/leave-applications/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appToken({ id: String(emp._id), email: emp.email })}`,
      },
      body: JSON.stringify(body),
    });

  it("refuses moving a good leave to before the joining date", async () => {
    const emp = await asha();
    const id = await pendingLeave(emp, "2026-09-05");
    const res = await edit(emp, id, { fromDate: "2025-09-05", toDate: "2025-09-05", isHalfDay: true });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BEFORE_DATE_OF_JOINING");
  });

  it("still lets the bad 2025 leave be CORRECTED to the day that was meant", async () => {
    /* The repair path for the real record. If the guard checked the stored
       date instead of the change, this leave could never be fixed. */
    const emp = await asha();
    const id = await pendingLeave(emp, "2025-09-05");
    const res = await edit(emp, id, { fromDate: "2026-09-05", toDate: "2026-09-05", isHalfDay: true });
    const payload = await res.json();
    expect(payload.code).not.toBe("BEFORE_DATE_OF_JOINING");
    expect(res.status).toBe(200);
    const db = require("mongoose").connection.db;
    const row = await db.collection("leaveapplications").findOne({ _id: new (require("mongoose").Types.ObjectId)(id) });
    expect(row.fromDate).toBe("2026-09-05");
  });
});
