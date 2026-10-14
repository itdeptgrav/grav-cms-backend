"use strict";
/**
 * WHERE AN HR APPROVAL REQUEST GOES, END TO END (14 Oct 2026, owner: "make
 * sure wherever the approval request is sent it reaches them … there should
 * not be any bug where we send an approval but the owner isn't getting it").
 *
 * Signs in as an editor, a viewer, an approver, the owner and a platform
 * administrator, each with a real role record in the in-memory database, and
 * drives the real stack in server.js order: the HR contract, the department
 * write guard, the approval queue router and — on approval — the real replay
 * of the held request back through the same stack. Notifications are checked
 * through notifyChangeRequest's injectable transport, so WHO is told is
 * asserted without Firebase.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
  cmsToken,
  bearer,
} = require("../hr-access/helpers");

const hrContract = require("../../Middlewear/hrContract");
const departmentWrites = require("../../Middlewear/departmentWriteGuard");
const ChangeRequest = require("../../models/Access/ChangeRequest");
const { notifyChangeRequest } = require("../../services/departmentApprovalNotifications.service");

let server, base, hr;
const committed = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const hrWrites = departmentWrites("hr", {
    entity: "HR record",
    exempt: ["/api/hr/profile", "/api/hr/change-password", "/change-history", "/import-export",
             "/sync-period", "/backfill", "/day-range", "/notification-"],
  });
  for (const prefix of ["/api/hr", "/hr", "/api/employees"]) {
    app.use(prefix, hrContract());
    app.use(prefix, hrWrites);
  }
  app.use("/api/change-requests", require("../../routes/Access/changeRequests"));
  /* The routers behind the guards: record what actually reached them. */
  app.use((req, res) => {
    committed.push({ method: req.method, path: req.originalUrl, replay: Boolean(req.get("x-approval-replay") || req.get("X-Change-Request-Replay")) });
    res.json({ success: true, committed: true });
  });

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  /* An approval replays the held request against "this server". */
  process.env.INTERNAL_API_ORIGIN = base;
});

afterAll(async () => {
  delete process.env.INTERNAL_API_ORIGIN;
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  committed.length = 0;
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
});

/** A signed-in HR person with a real role row and employee record. */
async function signIn(role, { tokenEmail } = {}) {
  const email = `${role}@grav.in`;
  if (role !== "none") await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role.toUpperCase()}`, email, accessDepartmentId: hr._id, firstName: role });
  resetAccessCaches();
  return {
    email,
    emp,
    token: cmsToken({ id: String(emp._id), email: tokenEmail || email, employeeId: `GR${role.toUpperCase()}`, role: "hr_manager", name: role, deptSlug: "hr" }),
  };
}

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const queue = (token, status = "pending") => call("GET", `/api/change-requests/hr?status=${status}`, token);

describe("an editor's held change reaches the approver AND the owner, and only they decide it", () => {
  test("held → listed for approver and owner → approved → applied once, as the editor", async () => {
    const editor = await signIn("editor");
    const approver = await signIn("approver");
    const owner = await signIn("owner");
    const viewer = await signIn("viewer");

    /* Approving a leave is approver-level work an editor may ask for. */
    const held = await call("PATCH", "/api/hr/leaves/60c0000000000000000000aa/approve", editor.token, { note: "ok" });
    expect(held.status).toBe(202);
    expect(committed).toHaveLength(0);
    const [cr] = await ChangeRequest.find({ departmentSlug: "hr" }).lean();
    expect(cr.status).toBe("pending");
    expect(cr.requestedBy.email).toBe(editor.email);

    /* Who sees it */
    const forApprover = await queue(approver.token);
    expect(forApprover.status).toBe(200);
    expect(forApprover.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect(forApprover.body.requests[0].canDecideThis).toBe(true);
    expect(forApprover.body.pendingCount).toBe(1);

    const forOwner = await queue(owner.token);
    expect(forOwner.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect(forOwner.body.requests[0].canDecideThis).toBe(true);

    const forEditor = await queue(editor.token);
    expect(forEditor.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect(forEditor.body.canDecide).toBe(false);

    const forViewer = await queue(viewer.token);
    expect(forViewer.status).toBe(200);
    expect(forViewer.body.requests).toEqual([]); // somebody else's request is not theirs to read

    /* Who may decide */
    expect((await call("POST", `/api/change-requests/${cr._id}/decide`, editor.token, { decision: "approve" })).status).toBe(403);
    expect((await call("POST", `/api/change-requests/${cr._id}/decide`, viewer.token, { decision: "approve" })).status).toBe(403);

    const decided = await call("POST", `/api/change-requests/${cr._id}/decide`, approver.token, { decision: "approve" });
    expect(decided.status).toBe(200);
    const after = await ChangeRequest.findById(cr._id).lean();
    expect(after.status).toBe("approved");
    /* The replay reached the route once, through the same guards. */
    expect(committed.filter((c) => c.path.includes("/leaves/60c0000000000000000000aa/approve"))).toHaveLength(1);

    /* And it leaves the waiting list for everyone. */
    expect((await queue(owner.token)).body.requests).toEqual([]);
    expect((await queue(approver.token)).body.pendingCount).toBe(0);
  });

  test("a rejection applies nothing", async () => {
    const editor = await signIn("editor");
    const owner = await signIn("owner");
    await call("PATCH", "/api/hr/leaves/60c0000000000000000000ab/approve", editor.token, {});
    const [cr] = await ChangeRequest.find({}).lean();
    const r = await call("POST", `/api/change-requests/${cr._id}/decide`, owner.token, { decision: "reject", note: "no" });
    expect(r.status).toBe(200);
    expect((await ChangeRequest.findById(cr._id).lean()).status).toBe("rejected");
    expect(committed).toHaveLength(0);
  });

  test("an approver cannot approve their own request", async () => {
    const approver = await signIn("approver");
    /* An approver's own write commits; build the case directly. */
    const cr = await ChangeRequest.create({
      departmentSlug: "hr", entity: "HR record", action: "update", status: "pending", requiredRole: "approver",
      requestedBy: { email: approver.email, name: "approver" },
      intent: { method: "PATCH", path: "/api/hr/leaves/60c0000000000000000000ac/approve", body: {} },
    });
    const r = await call("POST", `/api/change-requests/${cr._id}/decide`, approver.token, { decision: "approve" });
    expect(r.status).toBe(403);
    expect((await ChangeRequest.findById(cr._id).lean()).status).toBe("pending");
  });
});

describe("an owner-only request reaches the owner", () => {
  test("the owner sees it and decides it; an approver sees it but cannot decide it", async () => {
    const editor = await signIn("editor");
    const approver = await signIn("approver");
    const owner = await signIn("owner");
    const cr = await ChangeRequest.create({
      departmentSlug: "hr", entity: "employee", action: "update", status: "pending", requiredRole: "owner",
      requiredRoleReason: "Sets salary, which only the owner may set.",
      requestedBy: { email: editor.email, name: "editor", id: String(editor.emp._id), role: "hr_manager", userType: "hr" },
      intent: { method: "PATCH", path: "/api/hr/leaves/60c0000000000000000000ad/approve", body: {} },
    });

    const forOwner = await queue(owner.token);
    expect(forOwner.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect(forOwner.body.requests[0].canDecideThis).toBe(true);

    const forApprover = await queue(approver.token);
    expect(forApprover.body.requests[0].canDecideThis).toBe(false);
    expect((await call("POST", `/api/change-requests/${cr._id}/decide`, approver.token, { decision: "approve" })).status).toBe(403);

    expect((await call("POST", `/api/change-requests/${cr._id}/decide`, owner.token, { decision: "approve" })).status).toBe(200);
    expect((await ChangeRequest.findById(cr._id).lean()).status).toBe("approved");
  });
});

describe("the bug this guards: held by the write guard, invisible in the queue", () => {
  test("an owner signed in under another address still sees and decides the request", async () => {
    /* The role row is on the owner's employee address; the session carries a
       different one. The write guard has always found the role through the
       employee record — the queue used to read only the token's address, so
       it answered "Not your department" and the request reached nobody. */
    const editor = await signIn("editor");
    const owner = await signIn("owner", { tokenEmail: "owner.personal@gmail.com" });
    await call("PATCH", "/api/hr/leaves/60c0000000000000000000ae/approve", editor.token, {});
    const [cr] = await ChangeRequest.find({}).lean();

    const forOwner = await queue(owner.token);
    expect(forOwner.status).toBe(200);
    expect(forOwner.body.role).toBe("owner");
    expect(forOwner.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect((await call("POST", `/api/change-requests/${cr._id}/decide`, owner.token, { decision: "approve" })).status).toBe(200);
  });

  test("a platform administrator sees every request and may decide an owner-only one", async () => {
    const editor = await signIn("editor");
    /* An administrator signs in as their admin account: the session's id is
       that account's, and the claim is re-proved against it. */
    const adminRow = await makePlatformAdmin("admin@grav.in", hr._id);
    const admin = cmsToken({ id: String(adminRow._id), email: "admin@grav.in", isAdmin: true, deptSlug: "hr", name: "Admin" });
    const cr = await ChangeRequest.create({
      departmentSlug: "hr", entity: "employee", action: "update", status: "pending", requiredRole: "owner",
      requestedBy: { email: editor.email, name: "editor", id: String(editor.emp._id), role: "hr_manager", userType: "hr" },
      intent: { method: "PATCH", path: "/api/hr/leaves/60c0000000000000000000af/approve", body: {} },
    });
    const list = await queue(admin);
    expect(list.body.requests.map((r) => r.id)).toEqual([String(cr._id)]);
    expect(list.body.requests[0].canDecideThis).toBe(true);
  });
});

describe("who is told", () => {
  async function told(cr, reachable = () => true) {
    const sent = [];
    await notifyChangeRequest(cr, "held", { send: async (person, msg) => { sent.push({ email: person.email, title: msg.title }); return reachable(person); } });
    return sent;
  }

  test("an approver-level request tells the approvers and the owner, never the requester", async () => {
    const editor = await signIn("editor");
    const approver = await signIn("approver");
    const owner = await signIn("owner");
    await signIn("viewer");
    const sent = await told({ departmentSlug: "hr", requiredRole: "approver", entity: "leave", requestedBy: { email: editor.email } });
    expect(sent.map((s) => s.email).sort()).toEqual([approver.email, owner.email].sort());
    expect(sent.every((s) => s.title === "Approval needed")).toBe(true);
  });

  test("an owner-only request tells the owner — not an approver who cannot decide it", async () => {
    const editor = await signIn("editor");
    await signIn("approver");
    const owner = await signIn("owner");
    const sent = await told({ departmentSlug: "hr", requiredRole: "owner", entity: "employee", requestedBy: { email: editor.email } });
    expect(sent.map((s) => s.email)).toEqual([owner.email]);
    expect(sent[0].title).toBe("Owner approval needed");
  });

  test("when no owner can be reached, the platform administrator is told instead of nobody", async () => {
    const editor = await signIn("editor");
    const owner = await signIn("owner");
    await makePlatformAdmin("admin@grav.in", hr._id);
    await makeEmployee({ biometricId: "GRADMIN", email: "admin@grav.in" });
    /* The owner has no working device. */
    const sent = await told(
      { departmentSlug: "hr", requiredRole: "owner", entity: "employee", requestedBy: { email: editor.email } },
      (p) => p.email !== owner.email,
    );
    expect(sent.map((s) => s.email)).toEqual([owner.email, "admin@grav.in"]);
  });

  test("a department with no owner or approver still tells the platform administrator", async () => {
    const editor = await signIn("editor");
    await makePlatformAdmin("admin@grav.in", hr._id);
    await makeEmployee({ biometricId: "GRADMIN", email: "admin@grav.in" });
    const sent = await told({ departmentSlug: "hr", requiredRole: "approver", entity: "leave", requestedBy: { email: editor.email } });
    expect(sent.map((s) => s.email)).toEqual(["admin@grav.in"]);
  });
});

describe("the employee section has no tiers, except an employee's removal", () => {
  test("a viewer and an editor change pay directly — nothing waits for the owner", async () => {
    await signIn("owner");
    for (const role of ["viewer", "editor"]) {
      const who = await signIn(role);
      const r = await call("PUT", "/api/employees/60c0000000000000000000b1", who.token, { salary: { basic: 20000 }, designation: "Lead" });
      expect({ role, status: r.status, committed: r.body.committed }).toEqual({ role, status: 200, committed: true });
    }
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("removing an employee: an editor's is held and reaches the approver; a viewer's is refused", async () => {
    const editor = await signIn("editor");
    const viewer = await signIn("viewer");
    const approver = await signIn("approver");
    const held = await call("DELETE", "/api/employees/60c0000000000000000000b2", editor.token);
    expect(held.status).toBe(202);
    const forApprover = await queue(approver.token);
    expect(forApprover.body.requests).toHaveLength(1);
    expect(forApprover.body.requests[0].method).toBe("DELETE");

    const refused = await call("DELETE", "/api/employees/60c0000000000000000000b3", viewer.token);
    expect(refused.status).toBe(403);
    expect(await ChangeRequest.countDocuments({})).toBe(1);
  });
});
