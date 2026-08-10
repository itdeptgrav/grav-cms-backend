"use strict";
/**
 * Central GRAV assistant — POST /api/ai/assistant/message (+ /history, /reset)
 * AND the shared HR-access resolver that now gates the HR tools.
 *
 * The resolver runs against REAL access records (in-memory Mongo from
 * test/setup): AccessDepartment grants, Employee assignments and DeptUser
 * admin. Ollama and the two HR context builders are mocked, so the tests are
 * about PERMISSION and TOOL SELECTION, not the model or attendance maths.
 *
 * Scenarios required by the fix:
 *   • HR manager (has HR department)                     → allowed
 *   • administrator / authorised executive (DeptUser.isAdmin, or CEO dept) → allowed
 *   • multi-department employee with HR while in Sales   → allowed
 *   • Sales-only employee                                → denied
 *   • Daily Attendance tool selection                    → hr_daily_attendance attached
 *   • route context neither grants nor removes permission
 */

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/EmployeeAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required" });
  req.user = JSON.parse(raw);
  next();
});

jest.mock("../../services/ollamaClient", () => {
  const actual = jest.requireActual("../../services/ollamaClient");
  return { ...actual, chatJson: jest.fn() };
});

jest.mock("../../services/hrOverviewContext", () => ({
  buildHrOverviewContext: jest.fn().mockResolvedValue({ headcount: { active: 121 }, marker: "HR_OVERVIEW_CONTEXT" }),
}));

jest.mock("../../services/dailyAttendanceContext", () => ({
  buildDailyAttendanceContext: jest.fn().mockResolvedValue({
    ok: true,
    scope: { date: "2026-08-08", department: "all" },
    context: {
      date: "2026-08-08",
      scope: { department: "all" },
      dataState: "synced",
      holiday: null,
      totals: { inScope: 3, late: 1 },
      breakdown: { P: 2, AB: 1, marker: "DAILY_ATT_CONTEXT" },
      legend: {},
      records: [{ name: "Asha", status: "P" }],
      recordsTruncated: false,
    },
  }),
}));

const { chatJson } = require("../../services/ollamaClient");
const { resolveHrAccess } = require("../../services/access/hrAccess");
const convo = require("../../services/ai/conversationStore");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");

let server, base, ids;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", require("../../routes/ai/assistant"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/ai/assistant`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function seed() {
  const dep = (slug, name, path) => AccessDepartment.create({ slug, name, dashboardPath: path, isActive: true });
  const hr = await dep("hr", "HR", "/hr/dashboard");
  const sales = await dep("sales", "Sales", "/sales/dashboard");
  const ceo = await dep("ceo", "CEO", "/ceo/dashboard");

  const emp = (bio, extra) => Employee.create({ biometricId: bio, ...extra });
  const hrEmp = await emp("GRHR1", { accessDepartmentId: hr._id });
  const salesEmp = await emp("GRS1", { accessDepartmentId: sales._id });
  const multiEmp = await emp("GRM1", { accessDepartmentId: sales._id, additionalDepartmentIds: [hr._id] });
  const ceoEmp = await emp("GRC1", { accessDepartmentId: ceo._id });
  await DeptUser.create({ email: "admin@grav.in", passwordHash: "x", name: "Admin", isAdmin: true, isActive: true });

  return {
    // x-test-user payloads
    HR: { id: hrEmp._id.toString(), email: "hana@grav.in", employeeId: "GRHR1", role: "hr_manager" },
    SALES: { id: salesEmp._id.toString(), email: "sam@grav.in", employeeId: "GRS1", role: "sales" },
    // multi-dept: currently in SALES (role sales) but holds an HR grant too
    MULTI_IN_SALES: { id: multiEmp._id.toString(), email: "mia@grav.in", employeeId: "GRM1", role: "sales" },
    CEO: { id: ceoEmp._id.toString(), email: "cyra@grav.in", employeeId: "GRC1", role: "ceo" },
    // admin recognised by email via DeptUser, regardless of their current role
    ADMIN: { id: new mongoose.Types.ObjectId().toString(), email: "admin@grav.in", employeeId: "GRA1", role: "sales" },
  };
}

beforeEach(async () => {
  chatJson.mockReset();
  chatJson.mockResolvedValue({ model: "qwen3:8b", data: { reply: "Here is what I found." } });
  convo._clearAll();
  ids = await seed();
});

async function message(body, user) {
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Resolver unit (real access records) ──────────────────────────────────────
describe("resolveHrAccess (real access records)", () => {
  test("HR manager with an HR department grant → allowed via hr", async () => {
    expect(await resolveHrAccess(ids.HR)).toEqual({ allowed: true, via: "hr" });
  });
  test("platform administrator (DeptUser.isAdmin) → allowed via admin", async () => {
    expect(await resolveHrAccess(ids.ADMIN)).toEqual({ allowed: true, via: "admin" });
  });
  test("Chief Executive (ceo department) → allowed via ceo", async () => {
    expect(await resolveHrAccess(ids.CEO)).toEqual({ allowed: true, via: "ceo" });
  });
  test("multi-department employee with HR, currently in Sales → allowed via hr", async () => {
    expect(ids.MULTI_IN_SALES.role).toBe("sales");
    expect(await resolveHrAccess(ids.MULTI_IN_SALES)).toEqual({ allowed: true, via: "hr" });
  });
  test("Sales-only employee → denied", async () => {
    expect(await resolveHrAccess(ids.SALES)).toEqual({ allowed: false, via: null });
  });
});

// ── Central endpoint tool selection ──────────────────────────────────────────
describe("central assistant tool gating", () => {
  test("401 without authentication", async () => {
    const { status } = await message({ message: "hi" }, null);
    expect(status).toBe(401);
  });

  test("HR manager: HR overview attached on an HR question", async () => {
    const { status, body } = await message({ message: "How many staff are present today?" }, ids.HR);
    expect(status).toBe(200);
    expect(body.meta.toolsUsed).toContain("hr_overview");
    expect(chatJson.mock.calls[0][0].prompt).toContain("HR_OVERVIEW_CONTEXT");
  });

  test("multi-department HR-in-Sales: same access as HR (tools attached)", async () => {
    const { status, body } = await message({ message: "Summarise today's attendance." }, ids.MULTI_IN_SALES);
    expect(status).toBe(200);
    expect(body.meta.toolsUsed.length).toBeGreaterThan(0);
    // being 'in Sales' does not remove the HR grant
    expect(body.meta.toolsUsed.some((t) => t.startsWith("hr_"))).toBe(true);
  });

  test("administrator: HR tools attached regardless of current role", async () => {
    const { body } = await message({ message: "How is attendance today?" }, ids.ADMIN);
    expect(body.meta.toolsUsed.some((t) => t.startsWith("hr_"))).toBe(true);
  });

  test("Sales-only employee: HR data NOT attached", async () => {
    const { status, body } = await message({ message: "How many staff are present today?" }, ids.SALES);
    expect(status).toBe(200);
    expect(body.meta.toolsUsed).not.toContain("hr_overview");
    expect(body.meta.toolsUsed).not.toContain("hr_daily_attendance");
    expect(chatJson.mock.calls[0][0].prompt).not.toContain("HR_OVERVIEW_CONTEXT");
  });

  test("Daily Attendance tool is selected for a day-attendance question", async () => {
    const { body } = await message({ message: "Who is absent today?" }, ids.HR);
    expect(body.meta.toolsUsed).toContain("hr_daily_attendance");
    expect(chatJson.mock.calls[0][0].prompt).toContain("DAILY_ATT_CONTEXT");
  });

  test("route context does NOT grant HR access to a Sales-only user", async () => {
    const { body } = await message(
      { message: "How many staff are present today?", routeContext: "/hr/dashboard" },
      ids.SALES,
    );
    expect(body.meta.routeAware).toBe(true);
    expect(body.meta.toolsUsed).not.toContain("hr_overview");
  });

  test("route context does NOT remove HR access from an authorised user in Sales", async () => {
    const { body } = await message(
      { message: "How many staff are present today?", routeContext: "/sales/dashboard" },
      ids.HR,
    );
    expect(body.meta.toolsUsed).toContain("hr_overview");
  });

  test("conversation persists per-user and stays isolated", async () => {
    await message({ message: "secret for sales" }, ids.SALES);
    const res = await fetch(`${base}/history`, { headers: { "x-test-user": JSON.stringify(ids.HR) } });
    const hist = await res.json();
    expect(JSON.stringify(hist.history)).not.toContain("secret for sales");
  });
});
