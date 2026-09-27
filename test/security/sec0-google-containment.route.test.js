// test/security/sec0-google-containment.route.test.js
//
// SEC-0 — /api/google is administrator-only and never returns OAuth tokens.
//
// Every Google service is mocked: nothing here reaches Google. The assertions
// are about who may reach the router at all, and about what an OAuth response
// may contain.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "sec0-google-containment-secret";

const SECRET_TOKENS = {
  access_token: "ya29.SECRET-ACCESS-TOKEN-VALUE",
  refresh_token: "1//SECRET-REFRESH-TOKEN-VALUE",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  token_type: "Bearer",
  expiry_date: 1,
};

const called = [];
const svc = (name, value = []) => jest.fn(async () => { called.push(name); return value; });

jest.mock("../../routes/services/googleAuthService", () => ({
  getAuthUrl: jest.fn(() => { called.push("getAuthUrl"); return "https://accounts.google.test/consent"; }),
  getTokensFromCode: jest.fn(async () => { called.push("getTokensFromCode"); return { ...SECRET_TOKENS }; }),
  getSpaces: svc("getSpaces"),
  getAllSpacesWithMessages: svc("getAllSpacesWithMessages"),
  getSpaceMessages: svc("getSpaceMessages"),
  getSpaceMembers: svc("getSpaceMembers"),
}));
jest.mock("../../routes/services/googleTasksService", () => ({
  getTaskLists: svc("getTaskLists"), getAllTasks: svc("getAllTasks"), getAllTasksFlat: svc("getAllTasksFlat"),
  getTasksInList: svc("getTasksInList"), createGoogleTask: svc("createGoogleTask", {}),
  createSubtask: svc("createSubtask", {}), updateGoogleTask: svc("updateGoogleTask", {}),
}));
jest.mock("../../routes/services/googleGmailService", () => ({
  getInboxMessages: svc("getInboxMessages"), getEmailBody: svc("getEmailBody", {}), getUnreadCount: svc("getUnreadCount", 0),
  searchEmails: svc("searchEmails"), getEmailsForUser: svc("getEmailsForUser"), getAllInbox: svc("getAllInbox"),
}));
jest.mock("../../routes/services/googleCalendarService", () => ({
  getCalendars: svc("getCalendars"), getUpcomingEvents: svc("getUpcomingEvents"),
  getTodayEvents: svc("getTodayEvents"), createEvent: svc("createEvent", {}),
}));
jest.mock("../../routes/services/googleDriveService", () => ({
  getRecentFiles: svc("getRecentFiles"), searchFiles: svc("searchFiles"),
}));
jest.mock("../../routes/services/googleEmployeeGmailService", () => ({
  getEmployeeAuthUrl: jest.fn(() => { called.push("getEmployeeAuthUrl"); return "https://accounts.google.test/consent"; }),
  parseOAuthState: jest.fn(() => ({ employeeId: "E001", returnTo: null })),
  saveEmployeeGmailToken: jest.fn(async () => { called.push("saveEmployeeGmailToken"); return { connectedEmail: "person@grav.test" }; }),
  getEmployeeGmailToken: jest.fn(async () => { called.push("getEmployeeGmailToken"); return { ...SECRET_TOKENS, connectedEmail: "person@grav.test" }; }),
  disconnectEmployeeGmail: svc("disconnectEmployeeGmail", {}),
  getEmployeeInbox: svc("getEmployeeInbox"), markRead: svc("markRead", {}), toggleStar: svc("toggleStar", {}),
  trashMessage: svc("trashMessage", {}), archiveMessage: svc("archiveMessage", {}),
  sendEmail: svc("sendEmail", {}), replyToEmail: svc("replyToEmail", {}),
  getAttachment: svc("getAttachment", {}), getLabels: svc("getLabels"), getThread: svc("getThread", {}),
}));
// The Firestore backfill route requires firebase lazily; keep it inert.
jest.mock("../../config/firebaseAdmin", () => ({ db: { collection: () => ({ get: async () => ({ docs: [] }) }) } }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts it: the router carries its own gate.
  app.use("/api/google", require("../../routes/googleWorkspaceRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { called.length = 0; });

const call = (p, { method = "GET", token, body } = {}) => fetch(`${base}${p}`, {
  method,
  redirect: "manual",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => {
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* redirect or empty */ }
  return { status: r.status, text, body: json, location: r.headers.get("location") || "" };
});

/** Representative endpoints across every area of the router. */
const ENDPOINTS = [
  ["GET", "/api/google/dashboard"],
  ["GET", "/api/google/tasks"],
  ["POST", "/api/google/tasks", { title: "x" }],
  ["PATCH", "/api/google/tasks/list1/task1", { title: "y" }],
  ["GET", "/api/google/calendar/events"],
  ["POST", "/api/google/calendar/events", { summary: "x" }],
  ["GET", "/api/google/drive/files"],
  ["GET", "/api/google/gmail/inbox"],
  ["GET", "/api/google/gmail/my-inbox?email=anyone@grav.test"],
  ["GET", "/api/google/employee-gmail/inbox?employeeId=E001"],
  ["POST", "/api/google/employee-gmail/send?employeeId=E001", { to: "x@y.test", subject: "s", body: "b" }],
  ["DELETE", "/api/google/employee-gmail/trash?employeeId=E001&messageId=m1"],
  ["GET", "/api/google/chat/spaces"],
  ["GET", "/api/google/auth/url"],
  ["GET", "/api/google/auth/callback?code=abc"],
  ["GET", "/api/google/employee-gmail/auth-url?employeeId=E001"],
  ["GET", "/api/google/employee-gmail/callback?code=abc&state=E001"],
/* Every row padded to [method, path, body]: test.each passes a row's values as
   arguments, and a 3-argument callback given a 2-element row is handed jest's
   `done` callback as the third — which then hangs the test. */
].map(([method, p, body]) => [method, p, body === undefined ? null : body]);

async function seed() {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
}

async function deptUserToken({ isAdmin, isActive = true, claimAdmin = isAdmin } = {}) {
  await seed();
  const dept = await AccessDepartment.findOne({ slug: "ceo" });
  const user = await DeptUser.create({
    name: `Google ${++n}`, email: `google${n}@grav.test`, passwordHash: "x",
    departmentId: dept._id, isAdmin, isActive,
  });
  return jwt.sign(
    { v: 2, id: String(user._id), deptId: String(dept._id), deptSlug: dept.slug,
      email: user.email, isAdmin: claimAdmin, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "5m" },
  );
}

const employeeToken = () => jwt.sign(
  { v: 2, id: String(new mongoose.Types.ObjectId()), subject: "employee", email: `emp${++n}@grav.test`,
    role: "sales", deptSlug: "sales", isAdmin: false, tv: 0 },
  process.env.JWT_SECRET, { expiresIn: "5m" },
);

describe("anonymous callers", () => {
  test.each(ENDPOINTS)("%s %s answers 401 and touches no Google service", async (method, p, body) => {
    const res = await call(p, { method, body });
    expect(res.status).toBe(401);
    expect(called).toEqual([]);
  });
});

describe("a normal CMS user", () => {
  test.each(ENDPOINTS)("%s %s answers 403", async (method, p, body) => {
    const res = await call(p, { method, body, token: employeeToken() });
    expect(res.status).toBe(403);
    expect(called).toEqual([]);
  });
});

describe("a forged administrator claim", () => {
  test("a validly-signed isAdmin claim with no DeptUser at all is refused", async () => {
    const token = jwt.sign(
      { v: 2, id: String(new mongoose.Types.ObjectId()), deptId: String(new mongoose.Types.ObjectId()),
        email: "forged@grav.test", isAdmin: true, tv: 0 },
      process.env.JWT_SECRET, { expiresIn: "5m" },
    );
    for (const [method, p, body] of ENDPOINTS) {
      const res = await call(p, { method, body, token });
      expect({ p, status: res.status }).toEqual({ p, status: 403 });
    }
    expect(called).toEqual([]);
  });

  test("an isAdmin claim on an account the database says is not an administrator is refused", async () => {
    const token = await deptUserToken({ isAdmin: false, claimAdmin: true });
    expect((await call("/api/google/gmail/inbox", { token })).status).toBe(403);
    expect((await call("/api/google/auth/callback?code=abc", { token })).status).toBe(403);
    expect(called).toEqual([]);
  });

  test("a deactivated administrator is refused", async () => {
    const token = await deptUserToken({ isAdmin: true, isActive: false });
    expect((await call("/api/google/drive/files", { token })).status).toBe(403);
  });
});

describe("an active, database-verified platform administrator", () => {
  test("reaches representative routes in every area", async () => {
    const token = await deptUserToken({ isAdmin: true });
    for (const p of ["/api/google/tasks", "/api/google/calendar/events", "/api/google/drive/files",
      "/api/google/gmail/inbox", "/api/google/chat/spaces", "/api/google/auth/url"]) {
      const res = await call(p, { token });
      expect({ p, status: res.status }).toEqual({ p, status: 200 });
    }
  });

  test("the OAuth callback answers success without any token material", async () => {
    const token = await deptUserToken({ isAdmin: true });
    const res = await call("/api/google/auth/callback?code=abc", { token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refreshTokenIssued).toBe(true);
    expect(res.body).not.toHaveProperty("tokens");
    expect(res.body).not.toHaveProperty("refresh_token");
    expect(res.body).not.toHaveProperty("access_token");
    expect(res.text).not.toMatch(/refresh_token|access_token|SECRET-REFRESH|SECRET-ACCESS/);
  });

  test("the employee Gmail callback redirects without token material, and status carries none", async () => {
    const token = await deptUserToken({ isAdmin: true });
    const cb = await call("/api/google/employee-gmail/callback?code=abc&state=E001", { token });
    expect(cb.status).toBe(302);
    expect(`${cb.location} ${cb.text}`).not.toMatch(/refresh_token|access_token|SECRET-REFRESH|SECRET-ACCESS/);

    const status = await call("/api/google/employee-gmail/status?employeeId=E001", { token });
    expect(status.status).toBe(200);
    expect(status.text).not.toMatch(/refresh_token|access_token|SECRET-REFRESH|SECRET-ACCESS|"tokens"/);
  });
});
