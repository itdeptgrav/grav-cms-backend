"use strict";
/**
 * EXPLOIT-FIRST — `scope: "manager"` used to mean nothing.
 *
 * `authorizeHr` handled `scope: "self"` and had no branch for `"manager"` at
 * all, so eighteen declarations fell straight through to "permitted" and the
 * entire proof lived inside each handler. Anything the handlers had not
 * defended — a route added later, an early lookup before the check, a code path
 * that 404s before it reaches the guard clause — was authorised by nothing but
 * a valid employee session.
 *
 * The contract now proves the relationship from STORED reporting records before
 * the handler is entered. These tests drive the guard directly, against real
 * leave, regularisation and overtime rows.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  makeLegacyAccount,
  cmsToken,
  appToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const { LeaveApplication, RegularizationRequest } =
  require("../../models/HR_Models/LeaveManagement");
const OvertimeReport = require("../../models/HR_Models/OvertimeReport");

let server, base, sales;
let boss, stranger, report;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/employee", hrContract());
  /* Stub: the contract's decision is what is under test, and it happens before
     any handler runs. `reached: true` means the request got past the guard. */
  app.use("/api/employee", (req, res) => res.json({ reached: true }));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  resetAccessCaches();
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");

  boss = await makeEmployee({ biometricId: "GRBOSS", email: "boss@grav.in", accessDepartmentId: sales._id });
  stranger = await makeEmployee({ biometricId: "GRSTR", email: "stranger@grav.in", accessDepartmentId: sales._id });
  report = await makeEmployee({
    biometricId: "GRREP",
    email: "report@grav.in",
    accessDepartmentId: sales._id,
    dateOfJoining: new Date("2024-01-01"),
    primaryManager: { managerId: boss._id, managerName: "Boss" },
  });
});

const asBoss = () => appToken({ id: String(boss._id), email: "boss@grav.in" });
const asStranger = () => appToken({ id: String(stranger._id), email: "stranger@grav.in" });

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body || {}) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function makeLeave(extra = {}) {
  return LeaveApplication.create({
    employeeId: report._id,
    employeeName: "Report",
    leaveType: "CL",
    fromDate: new Date("2026-10-05"),
    toDate: new Date("2026-10-05"),
    totalDays: 1,
    applicationDate: new Date("2026-09-20"),
    reason: "Personal",
    status: "pending",
    managersNotified: [{ managerId: boss._id, type: "primary" }],
    ...extra,
  });
}

async function makeRegularization() {
  return RegularizationRequest.create({
    employeeId: report._id,
    employeeName: "Report",
    dateStr: "2026-10-05",
    type: "miss_punch",
    reason: "Forgot to punch out",
    managersNotified: [{ managerId: boss._id, type: "primary" }],
  });
}

async function makeOvertime() {
  return OvertimeReport.create({
    employeeId: report._id,
    employeeName: "Report",
    dateStr: "2026-10-05",
    actualOutTime: "21:45",
    description: "Finished the dispatch",
    managersNotified: [{ managerId: boss._id, type: "primary" }],
  });
}

describe("leave decisions", () => {
  test("the proven manager is let through and an unrelated employee is not", async () => {
    const leave = await makeLeave();
    for (const path of [
      `/api/employee/leave-applications/manager/${leave._id}/approve`,
      `/api/employee/leave-applications/manager/${leave._id}/reject`,
      `/api/employee/leave-applications/manager/${leave._id}/approve-withdraw`,
      `/api/employee/leave-applications/manager/${leave._id}/reject-withdraw`,
      `/api/employee/leave-applications/quick-apply/${leave._id}/resolve`,
    ]) {
      expect({ path, status: (await call("PATCH", path, asBoss())).status })
        .toEqual({ path, status: 200 });

      const refused = await call("PATCH", path, asStranger());
      expect({ path, status: refused.status, code: refused.body.code })
        .toEqual({ path, status: 403, code: "HR_OUT_OF_SCOPE" });
    }
  });

  test("editing a report's leave is the same proof", async () => {
    const leave = await makeLeave();
    const p = `/api/employee/leave-applications/manager/${leave._id}/edit`;
    expect((await call("PUT", p, asBoss())).status).toBe(200);
    expect((await call("PUT", p, asStranger())).status).toBe(403);
  });

  test("the stored reporting row is enough when the chain is empty", async () => {
    /* A record raised before `managersNotified` existed still resolves, from
       the employee's own primaryManager/secondaryManager. */
    const leave = await makeLeave({ managersNotified: [] });
    const p = `/api/employee/leave-applications/manager/${leave._id}/approve`;
    expect((await call("PATCH", p, asBoss())).status).toBe(200);
    expect((await call("PATCH", p, asStranger())).status).toBe(403);
  });

  test("a SECONDARY manager is a manager", async () => {
    const second = await makeEmployee({ biometricId: "GRSEC", email: "sec@grav.in", accessDepartmentId: sales._id });
    await require("../../models/Employee").updateOne(
      { _id: report._id },
      { $set: { secondaryManager: { managerId: second._id, managerName: "Second" } } },
    );
    const leave = await makeLeave({ managersNotified: [] });
    const p = `/api/employee/leave-applications/manager/${leave._id}/approve`;
    expect((await call("PATCH", p, appToken({ id: String(second._id), email: "sec@grav.in" }))).status).toBe(200);
  });
});

describe("regularisation and overtime decisions", () => {
  test("regularisation decisions prove the same relationship", async () => {
    const reg = await makeRegularization();
    for (const verb of ["approve", "reject"]) {
      const p = `/api/employee/regularizations/manager/${reg._id}/${verb}`;
      expect((await call("PATCH", p, asBoss())).status).toBe(200);
      expect((await call("PATCH", p, asStranger())).status).toBe(403);
    }
  });

  test("overtime decisions prove the same relationship", async () => {
    const ot = await makeOvertime();
    for (const verb of ["approve", "reject"]) {
      const p = `/api/employee/overtime/manager/${ot._id}/${verb}`;
      expect((await call("PATCH", p, asBoss())).status).toBe(200);
      expect((await call("PATCH", p, asStranger())).status).toBe(403);
    }
  });
});

describe("acting on behalf of a named employee", () => {
  const path = "/api/employee/leave-applications/manager/add-on-behalf";

  test("the id in the body says WHO, and the stored rows say whether", async () => {
    expect((await call("POST", path, asBoss(), { employeeId: String(report._id) })).status).toBe(200);

    const refused = await call("POST", path, asStranger(), { employeeId: String(report._id) });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("forged manager fields in the body prove nothing", async () => {
    const forged = await call("POST", path, asStranger(), {
      employeeId: String(report._id),
      managerId: String(stranger._id),
      managersNotified: [{ managerId: String(stranger._id), type: "primary" }],
      isManager: true,
      role: "hr_manager",
      approverId: String(stranger._id),
      hrAuth: { capabilities: ["leave.decide.manager"] },
    });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("naming yourself does not make you your own manager", async () => {
    const r = await call("POST", path, asStranger(), { employeeId: String(stranger._id) });
    expect(r.status).toBe(403);
  });
});

describe("nothing can be enumerated through the refusals", () => {
  test("a real record, a deleted one, a malformed id and a missing target answer identically", async () => {
    const leave = await makeLeave();
    const p = (id) => `/api/employee/leave-applications/manager/${id}/approve`;

    const answers = await Promise.all([
      call("PATCH", p(leave._id), asStranger()),              // exists, not theirs
      call("PATCH", p("60c0000000000000000000ff"), asStranger()), // does not exist
      call("PATCH", p("not-an-object-id"), asStranger()),     // malformed
      call("PATCH", p("60c0000000000000000000ff"), asBoss()),  // theirs would be, but absent
    ]);

    const shapes = answers.map((a) => JSON.stringify({ status: a.status, body: a.body }));
    expect(new Set(shapes).size).toBe(1);
    expect(answers[0].status).toBe(403);
    expect(answers[0].body.message).toBe("You do not have permission to perform this action.");
  });

  test("a missing body target is refused, not defaulted", async () => {
    const r = await call("POST", "/api/employee/leave-applications/manager/add-on-behalf", asBoss(), {});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_OUT_OF_SCOPE");
  });
});

describe("queue reads — the manager PERSONA, proved from the org chart", () => {
  test("a current manager with NO pending items still gets in, and gets an empty queue", async () => {
    /* The persona is proved from the reporting rows, not from having work
       waiting: a manager whose team has raised nothing must not be told they
       are not a manager. */
    for (const path of [
      "/api/employee/leave-applications/manager/pending",
      "/api/employee/leave-applications/manager/my-team",
      "/api/employee/leave-applications/manager/withdraw-pending",
      "/api/employee/regularizations/manager/pending",
      "/api/employee/overtime/manager/pending",
    ]) {
      expect({ path, status: (await call("GET", path, asBoss())).status })
        .toEqual({ path, status: 200 });
    }
  });

  test("an unrelated authenticated employee is refused with HR_OUT_OF_SCOPE", async () => {
    /* THE REGRESSION. `{ queue: true }` returned true unconditionally, so every
       authenticated employee passed the central contract for every manager
       queue and the persona was enforced nowhere but inside the handlers. */
    for (const path of [
      "/api/employee/leave-applications/manager/pending",
      "/api/employee/leave-applications/manager/my-team",
      "/api/employee/leave-applications/manager/withdraw-pending",
      "/api/employee/regularizations/manager/pending",
      "/api/employee/overtime/manager/pending",
    ]) {
      const r = await call("GET", path, asStranger());
      expect({ path, status: r.status, code: r.body.code })
        .toEqual({ path, status: 403, code: "HR_OUT_OF_SCOPE" });
    }
  });

  test("forged manager fields in the query or body prove nothing", async () => {
    const forged =
      "?managerId=" + String(boss._id) +
      "&isManager=true&role=hr_manager&managersNotified=" + String(boss._id);
    const r = await call("GET", "/api/employee/leave-applications/manager/pending" + forged, asStranger());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("a SECONDARY manager is a manager for queue purposes too", async () => {
    const second = await makeEmployee({ biometricId: "GRSEC2", email: "sec2@grav.in", accessDepartmentId: sales._id });
    await require("../../models/Employee").updateOne(
      { _id: report._id },
      { $set: { secondaryManager: { managerId: second._id, managerName: "Second" } } },
    );
    const token = appToken({ id: String(second._id), email: "sec2@grav.in" });
    expect((await call("GET", "/api/employee/leave-applications/manager/pending", token)).status).toBe(200);
  });

  test("a manager of a DEPARTED report is no longer a manager", async () => {
    /* A leaver's record still names their old manager for ever. Counting it
       would make somebody a manager of nobody, permanently. */
    await require("../../models/Employee").updateOne(
      { _id: report._id },
      { $set: { isActive: false, status: "inactive" } },
    );
    const r = await call("GET", "/api/employee/leave-applications/manager/pending", asBoss());
    expect(r.status).toBe(403);
  });
});

describe("historical queues keep a FORMER manager's own history", () => {
  test("somebody named on a stored decision chain may read history, but not the live queue", async () => {
    /* A reorganisation moved the report away; the decisions this person made
       are still theirs. */
    const former = await makeEmployee({ biometricId: "GRFMR", email: "former@grav.in", accessDepartmentId: sales._id });
    await makeLeave({ managersNotified: [{ managerId: former._id, type: "primary" }] });
    const token = appToken({ id: String(former._id), email: "former@grav.in" });

    for (const path of [
      "/api/employee/leave-applications/manager/history",
      "/api/employee/regularizations/manager/history",
    ]) {
      expect({ path, status: (await call("GET", path, token)).status })
        .toEqual({ path, status: 200 });
    }

    /* …and the live queue is not theirs any more. */
    expect((await call("GET", "/api/employee/leave-applications/manager/pending", token)).status).toBe(403);
  });

  test("a stored chain on a regularisation or an overtime row counts too", async () => {
    const former = await makeEmployee({ biometricId: "GRFMR2", email: "former2@grav.in", accessDepartmentId: sales._id });
    const reg = await makeRegularization();
    await RegularizationRequest.updateOne(
      { _id: reg._id },
      { $set: { managersNotified: [{ managerId: former._id, type: "primary" }] } },
    );
    const token = appToken({ id: String(former._id), email: "former2@grav.in" });
    expect((await call("GET", "/api/employee/leave-applications/manager/history", token)).status).toBe(200);
  });

  test("somebody who has never managed anybody reads no history either", async () => {
    for (const path of [
      "/api/employee/leave-applications/manager/history",
      "/api/employee/regularizations/manager/history",
    ]) {
      const r = await call("GET", path, asStranger());
      expect({ path, status: r.status, code: r.body.code })
        .toEqual({ path, status: 403, code: "HR_OUT_OF_SCOPE" });
    }
  });
});

describe("a malformed or missing identity fails closed", () => {
  test("a token naming an employee that does not exist proves nothing", async () => {
    const ghost = appToken({ id: "60c0000000000000000000ff", email: "ghost@grav.in" });
    expect((await call("GET", "/api/employee/leave-applications/manager/pending", ghost)).status).toBe(403);
  });

  test("a token with no identity at all proves nothing", async () => {
    const nameless = appToken({ id: undefined, email: undefined });
    const r = await call("GET", "/api/employee/leave-applications/manager/pending", nameless);
    expect([401, 403]).toContain(r.status);
  });

  test("an unauthenticated caller reaches none of them", async () => {
    const res = await fetch(`${base}/api/employee/leave-applications/manager/pending`);
    expect(res.status).toBe(401);
  });

  test("the persona resolver itself refuses an empty identity", async () => {
    const { proveManagerPersona } = require("../../services/access/hrManagerScope");
    expect(await proveManagerPersona("current", new Set())).toBe(false);
    expect(await proveManagerPersona("history", new Set())).toBe(false);
    expect(await proveManagerPersona("current", new Set(["not-an-object-id"]))).toBe(false);
  });
});


describe("a manager must themselves be an active Employee", () => {
  /* Every proof below works by finding the actor's id in a stored record, and
     stored records are retained: `managersNotified` chains and
     `primaryManager.managerId` outlive the person they name. An id that merely
     APPEARS in a reporting field used to be enough. */

  test("an INACTIVE manager with an active report is refused", async () => {
    await require("../../models/Employee").updateOne(
      { _id: boss._id },
      { $set: { isActive: false, status: "inactive" } },
    );
    const leave = await makeLeave();

    for (const [method, path] of [
      ["GET", "/api/employee/leave-applications/manager/pending"],
      ["GET", "/api/employee/leave-applications/manager/my-team"],
      ["GET", "/api/employee/leave-applications/manager/history"],
      ["PATCH", `/api/employee/leave-applications/manager/${leave._id}/approve`],
      ["POST", "/api/employee/leave-applications/manager/add-on-behalf"],
    ]) {
      const r = await call(method, path, asBoss(), { employeeId: String(report._id) });
      expect({ path, status: r.status, code: r.body.code })
        .toEqual({ path, status: 403, code: "HR_OUT_OF_SCOPE" });
    }
  });

  test("an inactive FORMER manager named in history is refused", async () => {
    const former = await makeEmployee({
      biometricId: "GRIFM", email: "ifm@grav.in", accessDepartmentId: sales._id,
      isActive: false, status: "inactive",
    });
    await makeLeave({ managersNotified: [{ managerId: former._id, type: "primary" }] });

    const token = appToken({ id: String(former._id), email: "ifm@grav.in" });
    const r = await call("GET", "/api/employee/leave-applications/manager/history", token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("a HARD-DELETED manager whose reports still name them is refused", async () => {
    /* The report's `primaryManager.managerId` still points at the deleted row —
       that field is not cleaned up — so the old rule found the id and said yes. */
    const gone = await makeEmployee({ biometricId: "GRGONE", email: "gone@grav.in", accessDepartmentId: sales._id });
    await makeEmployee({
      biometricId: "GRORPH", email: "orph@grav.in", accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: gone._id, managerName: "Gone" },
    });
    /* Deleted BEFORE the first request, deliberately. Resolving them first
       would put the answer in the thirty-second actor cache, and this test is
       about the manager rule rather than about cache eviction — production
       revocation through the real routes has its own suite
       (employment-revocation.route.test.js), and HR's delete is a soft delete
       that invalidates. */
    await require("../../models/Employee").deleteOne({ _id: gone._id });

    const token = appToken({ id: String(gone._id), email: "gone@grav.in" });
    const after = await call("GET", "/api/employee/leave-applications/manager/pending", token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_OUT_OF_SCOPE");

    /* The contrast: a live manager of the same orphaned report is let in, so
       the refusal above is about the DELETED actor and not about the report. */
    const live = await makeEmployee({ biometricId: "GRLIVE", email: "live@grav.in", accessDepartmentId: sales._id });
    await require("../../models/Employee").updateOne(
      { biometricId: "GRORPH" },
      { $set: { primaryManager: { managerId: live._id, managerName: "Live" } } },
    );
    const liveToken = appToken({ id: String(live._id), email: "live@grav.in" });
    expect((await call("GET", "/api/employee/leave-applications/manager/pending", liveToken)).status).toBe(200);
  });

  test("a legacy HR or CEO account whose id sits in a manager field is refused", async () => {
    /* A legacy department account has no Employee row at all. Its `_id` landing
       in a manager field — through a bad import, or a DeptUser id reused
       verbatim from the legacy row — must not make it somebody's manager. */
    const legacyHr = await makeLegacyAccount("hr", "legacy.mgr@grav.in");
    await makeEmployee({
      biometricId: "GRLR", email: "lr@grav.in", accessDepartmentId: sales._id,
      dateOfJoining: new Date("2024-01-01"),
      primaryManager: { managerId: legacyHr._id, managerName: "Legacy" },
    });
    await makeLeave({ managersNotified: [{ managerId: legacyHr._id, type: "primary" }] });

    const token = cmsToken({
      id: String(legacyHr._id), email: "legacy.mgr@grav.in", role: "hr_manager", userType: "hr",
    });

    for (const path of [
      "/api/employee/leave-applications/manager/pending",
      "/api/employee/leave-applications/manager/history",
    ]) {
      const r = await call("GET", path, token);
      expect({ path, status: r.status, code: r.body.code })
        .toEqual({ path, status: 403, code: "HR_OUT_OF_SCOPE" });
    }
  });

  test("an ACTIVE current manager still reads an empty current queue", async () => {
    /* The rule must not cost a genuine manager anything. */
    const r = await call("GET", "/api/employee/leave-applications/manager/pending", asBoss());
    expect(r.status).toBe(200);
  });

  test("an ACTIVE former manager still reads their own history", async () => {
    const former = await makeEmployee({ biometricId: "GRAFM", email: "afm@grav.in", accessDepartmentId: sales._id });
    await makeLeave({ managersNotified: [{ managerId: former._id, type: "primary" }] });
    const token = appToken({ id: String(former._id), email: "afm@grav.in" });

    expect((await call("GET", "/api/employee/leave-applications/manager/history", token)).status).toBe(200);
    /* …and only history: the live queue is not theirs. */
    expect((await call("GET", "/api/employee/leave-applications/manager/pending", token)).status).toBe(403);
  });

  test("every negative answer is byte-equivalent — nothing can be enumerated", async () => {
    const leave = await makeLeave();
    const gone = await makeEmployee({ biometricId: "GRG2", email: "g2@grav.in", accessDepartmentId: sales._id });
    const goneId = String(gone._id);
    await require("../../models/Employee").deleteOne({ _id: gone._id });

    const inactive = await makeEmployee({
      biometricId: "GRIN2", email: "in2@grav.in", accessDepartmentId: sales._id,
      isActive: false, status: "inactive",
    });
    const legacyRow = await makeLegacyAccount("ceo", "legacy.enum@grav.in");

    const answers = await Promise.all([
      call("PATCH", `/api/employee/leave-applications/manager/${leave._id}/approve`, asStranger()),
      call("PATCH", `/api/employee/leave-applications/manager/${leave._id}/approve`, appToken({ id: goneId, email: "g2@grav.in" })),
      call("PATCH", `/api/employee/leave-applications/manager/${leave._id}/approve`, appToken({ id: String(inactive._id), email: "in2@grav.in" })),
      call("PATCH", `/api/employee/leave-applications/manager/${leave._id}/approve`, cmsToken({ id: String(legacyRow._id), email: "legacy.enum@grav.in", role: "ceo", userType: "ceo" })),
      call("PATCH", "/api/employee/leave-applications/manager/60c0000000000000000000ff/approve", asBoss()),
      call("GET", "/api/employee/leave-applications/manager/pending", asStranger()),
    ]);

    const shapes = answers.map((a) => JSON.stringify({ status: a.status, body: a.body }));
    expect(new Set(shapes).size).toBe(1);
    expect(answers[0].status).toBe(403);
    expect(answers[0].body).toEqual({
      success: false,
      code: "HR_OUT_OF_SCOPE",
      message: "You do not have permission to perform this action.",
    });
  });
});

describe("every manager declaration carries a descriptor", () => {
  test("none is authorised by a valid session alone", async () => {
    const { DECLARATIONS, validateDeclarations } = require("../../services/access/hrRouteContract");
    const managerDecls = DECLARATIONS.filter((d) => d.scope === "manager");
    expect(managerDecls.length).toBeGreaterThan(15);
    for (const d of managerDecls) {
      expect({ route: `${d.method} ${d.path}`, hasDescriptor: Boolean(d.managerScope) })
        .toEqual({ route: `${d.method} ${d.path}`, hasDescriptor: true });
    }
    /* And the registry's own self-test refuses one without. */
    expect(validateDeclarations()).toEqual([]);
  });
});
