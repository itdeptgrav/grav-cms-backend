"use strict";
/**
 * EVERY HR ROUTE HAS AN EXPLICIT AUTHORISATION DECLARATION.
 *
 * This is the test the chunk exists to leave behind. It walks the REAL Express
 * routers — `router.stack`, not a regular expression over the source — and
 * asks services/access/hrRouteContract.js for a declaration for each mounted
 * (method, path). A new HR route with no declaration fails here, which is the
 * only thing that stops the next unguarded endpoint from shipping.
 *
 * It fails in the other direction too. A declaration for a route that no longer
 * exists is a lie about coverage: it makes the registry look complete while the
 * real surface has moved, so a stale entry is a failure, not a warning.
 */

/* Static analysis only: this file walks routers and compares them with the
   declaration registry. It reads no collection, so it opts out of the shared
   in-memory mongod — see test/setup.js. */
process.env.TEST_WITHOUT_MONGO = "1";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "hr-contract-test-secret";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MOUNTS } = require("../../services/access/hrMountRegistry");
const {
  DECLARATIONS,
  findDeclaration,
  validateDeclarations,
} = require("../../services/access/hrRouteContract");
const { CAPABILITIES, ALL_CAPABILITIES, ROLE_TEMPLATES, isCapability } =
  require("../../services/access/hrCapabilities");

/**
 * The inventory is produced by a CHILD NODE PROCESS, not by requiring the
 * routers here.
 *
 * Two of them pull in ESM-only dependencies through their own imports —
 * puppeteer via the payslip PDF renderer, expo-server-sdk via payroll's push
 * notifications — and Jest's CommonJS loader refuses those outright. Requiring
 * them in-process would report a load error for two of the most sensitive
 * routers in HR and the suite would be measuring less than it claimed. A real
 * node process loads them the way the server does.
 */
let inventory;

beforeAll(() => {
  const script = path.join(__dirname, "../../scripts/hrRouteInventory.js");
  /* Via a FILE, not a pipe: the routers keep timers alive so the child has to
     exit()ourselves, and exit() does not drain stdout — that truncated the
     ~700 KB inventory at 64 KB and made every assertion here a JSON parse
     error rather than a real result. */
  const out = path.join(os.tmpdir(), `hr-route-inventory-${process.pid}.json`);
  try {
    execFileSync(process.execPath, [script, "--json", "--out", out], {
      encoding: "utf8",
      timeout: 150000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    inventory = JSON.parse(fs.readFileSync(out, "utf8"));
  } finally {
    try { fs.unlinkSync(out); } catch { /* already gone */ }
  }
}, 180000);

describe("route coverage", () => {
  test("every HR router loads", () => {
    expect(inventory.loadErrors.map((b) => `${b.module}: ${b.error}`)).toEqual([]);
  });

  test("the walk finds the HR surface it is supposed to", () => {
    /* A floor, not an exact count: the point is to catch a walker that silently
       stops finding routes, which would make every other assertion here pass
       vacuously. */
    expect(inventory.routeCount).toBeGreaterThan(280);
    expect(MOUNTS.length).toBeGreaterThan(30);
  });

  test("NO mounted HR route is missing an authorisation declaration", () => {
    expect(inventory.undeclared).toEqual([]);
  });

  test("no declaration is stale", () => {
    expect(inventory.stale).toEqual([]);
  });

  test("the registry is internally consistent", () => {
    expect(validateDeclarations()).toEqual([]);
  });

  test("every route that can carry protected data is declared as protected", () => {
    /* A declaration that returns an employee record, a payslip or a candidate
       file and is NOT marked protected is a documentation bug that hides a real
       one — the matrix would tell a reviewer there is nothing sensitive there. */
    const shouldBeProtected = inventory.routes.filter(
      (r) =>
        r.declared &&
        /payslip|payroll\/item|payroll\/preview|payroll\/export|password-management/.test(r.path) &&
        /* `…/payslip/employees` is the PICKER — names and ids, so somebody can
           choose whose payslip to open. It carries no pay figure and is
           correctly not marked protected. */
        !/\/payslip\/employees$/.test(r.path),
    );
    expect(shouldBeProtected.length).toBeGreaterThan(8);
    const unmarked = shouldBeProtected
      .filter((r) => !r.declaration.protectedData)
      .map((r) => `${r.method} ${r.path}`);
    expect(unmarked).toEqual([]);
  });
});

describe("capability catalogue", () => {
  test("the catalogue covers every capability the plan names", () => {
    /* Verbatim from docs/product/hrms-professionalisation-plan.md §4 and the
       Chunk 1 brief. A rename that loses one of these breaks a grant. */
    const required = [
      "hr.access",
      "people.read.directory", "people.read.private", "people.write", "employment.change",
      "compensation.read", "compensation.write",
      "attendance.read", "attendance.correct", "attendance.close",
      "leave.read", "leave.configure", "leave.decide.manager", "leave.decide.hr",
      "payroll.read", "payroll.prepare", "payroll.approve", "payroll.reopen",
      "recruitment.read", "recruitment.manage", "offer.approve", "hire.convert",
      "documents.read", "documents.issue", "documents.release",
      "skills.read", "skills.assess", "training.manage",
      "compliance.read", "compliance.manage", "cases.manage",
      "analytics.workforce", "audit.read", "audit.export",
      "security.credentials.manage", "hr.configuration.manage",
    ];
    for (const cap of required) expect(isCapability(cap)).toBe(true);
  });

  test("every declared capability exists in the catalogue", () => {
    const unknown = new Set();
    for (const d of DECLARATIONS) {
      for (const cap of d.capabilities) if (!ALL_CAPABILITIES.includes(cap)) unknown.add(cap);
    }
    expect([...unknown]).toEqual([]);
  });

  test("all eight role templates exist and none is empty", () => {
    for (const name of [
      "hr_viewer", "hr_editor", "hr_approver", "hr_owner",
      "platform_admin", "ceo_projection", "employee_self", "manager_self",
    ]) {
      expect(ROLE_TEMPLATES[name]).toBeDefined();
      expect(ROLE_TEMPLATES[name].length).toBeGreaterThan(0);
    }
  });
});

/* ── The separations the brief asks for, asserted on the DECLARATIONS ────────
 *
 * Checked here as well as end-to-end because this is where they can be stated
 * as "these two routes do not require the same capability" — a property no
 * single request can prove. */
describe("capabilities that must stay separate", () => {
  const capsFor = (method, path) => findDeclaration(method, path)?.capabilities || [];

  test("payroll approval and reopen are distinct authorities", () => {
    const approve = capsFor("PATCH", "/api/hr/payroll/mark-paid");
    const reopen = capsFor("PATCH", "/api/hr/payroll/run/revert-to-draft");
    const prepare = capsFor("POST", "/api/hr/payroll/run");

    expect(approve).toContain(CAPABILITIES.PAYROLL_APPROVE);
    expect(reopen).toContain(CAPABILITIES.PAYROLL_REOPEN);
    expect(prepare).toContain(CAPABILITIES.PAYROLL_PREPARE);

    expect(approve).not.toContain(CAPABILITIES.PAYROLL_REOPEN);
    expect(prepare).not.toContain(CAPABILITIES.PAYROLL_APPROVE);
    expect(reopen).not.toContain(CAPABILITIES.PAYROLL_APPROVE);
  });

  test("attendance correction and attendance close are distinct authorities", () => {
    const correct = capsFor("PUT", "/hr/attendance/day-override");
    const close = capsFor("POST", "/hr/attendance/sync-period");

    expect(correct).toContain(CAPABILITIES.ATTENDANCE_CORRECT);
    expect(close).toContain(CAPABILITIES.ATTENDANCE_CLOSE);
    expect(correct).not.toContain(CAPABILITIES.ATTENDANCE_CLOSE);
  });

  test("document issue and document release are distinct authorities", () => {
    const issue = capsFor("POST", "/api/hr/documents");
    const release = capsFor("PATCH", "/api/hr/documents/60c000000000000000000000/release");

    expect(issue).toContain(CAPABILITIES.DOCUMENTS_ISSUE);
    expect(release).toContain(CAPABILITIES.DOCUMENTS_RELEASE);
    expect(issue).not.toContain(CAPABILITIES.DOCUMENTS_RELEASE);
  });

  test("credential administration has its own dedicated capability", () => {
    for (const [method, path] of [
      ["GET", "/api/hr/password-management/users"],
      ["PATCH", "/api/hr/password-management/change-password/employee/abc"],
      ["POST", "/api/hr/password-management/reset-password/employee/abc"],
      ["POST", "/api/hr/password-management/bulk-reset"],
    ]) {
      expect(capsFor(method, path)).toContain(CAPABILITIES.SECURITY_CREDENTIALS_MANAGE);
    }
    /* And nothing else claims it — a capability that is required in twenty
       places is not a dedicated one. */
    const holders = DECLARATIONS.filter((d) =>
      d.capabilities.includes(CAPABILITIES.SECURITY_CREDENTIALS_MANAGE),
    );
    expect(holders.every((d) => d.path.startsWith("/api/hr/password-management"))).toBe(true);
  });

  test("every compensation-bearing endpoint requires the compensation capability", () => {
    for (const [method, path] of [
      ["GET", "/api/hr/payslip/GR0001"],
      ["GET", "/api/hr/payslip/GR0001/history"],
      ["GET", "/api/hr/payslip/GR0001/pdf"],
      ["GET", "/api/hr/payroll/items"],
      ["GET", "/api/hr/payroll/preview"],
      ["GET", "/api/hr/payroll/export"],
      ["GET", "/api/employees/config/salary"],
      ["GET", "/api/employees/import-export/export"],
    ]) {
      expect(capsFor(method, path)).toContain(CAPABILITIES.COMPENSATION_READ);
    }
  });

  test("the CEO/management projection is read-only and holds no protected read", () => {
    const ceo = new Set(ROLE_TEMPLATES.ceo_projection);
    for (const denied of [
      CAPABILITIES.COMPENSATION_READ,
      CAPABILITIES.COMPENSATION_WRITE,
      CAPABILITIES.PEOPLE_READ_PRIVATE,
      CAPABILITIES.PEOPLE_READ_IDENTIFIERS,
      CAPABILITIES.PEOPLE_READ_MEDICAL,
      CAPABILITIES.CASES_MANAGE,
      CAPABILITIES.PEOPLE_WRITE,
      CAPABILITIES.PAYROLL_APPROVE,
      CAPABILITIES.ATTENDANCE_CORRECT,
      CAPABILITIES.ATTENDANCE_CLOSE,
      CAPABILITIES.SECURITY_CREDENTIALS_MANAGE,
      CAPABILITIES.HR_CONFIGURATION_MANAGE,
    ]) {
      expect(ceo.has(denied)).toBe(false);
    }

    /* Structural read-only: every /api/ceo/hr declaration a CEO satisfies is a
       GET. The one POST there needs attendance.close, which the CEO lacks. */
    const ceoRoutes = DECLARATIONS.filter((d) => d.path.startsWith("/api/ceo/hr"));
    expect(ceoRoutes.length).toBeGreaterThan(5);
    for (const d of ceoRoutes) {
      const satisfiable = d.capabilities.every((c) => ceo.has(c));
      if (satisfiable) expect(d.method).toBe("GET");
    }
  });

  test("an HR viewer holds no write capability at all", () => {
    const viewer = new Set(ROLE_TEMPLATES.hr_viewer);
    for (const denied of [
      CAPABILITIES.PEOPLE_WRITE, CAPABILITIES.EMPLOYMENT_CHANGE,
      CAPABILITIES.COMPENSATION_READ, CAPABILITIES.COMPENSATION_WRITE,
      CAPABILITIES.ATTENDANCE_CORRECT, CAPABILITIES.ATTENDANCE_CLOSE,
      CAPABILITIES.LEAVE_CONFIGURE, CAPABILITIES.LEAVE_DECIDE_HR,
      CAPABILITIES.PAYROLL_PREPARE, CAPABILITIES.PAYROLL_APPROVE, CAPABILITIES.PAYROLL_REOPEN,
      CAPABILITIES.RECRUITMENT_MANAGE, CAPABILITIES.DOCUMENTS_ISSUE, CAPABILITIES.DOCUMENTS_RELEASE,
      CAPABILITIES.SECURITY_CREDENTIALS_MANAGE, CAPABILITIES.HR_CONFIGURATION_MANAGE,
      CAPABILITIES.PEOPLE_READ_PRIVATE, CAPABILITIES.PEOPLE_READ_IDENTIFIERS,
      CAPABILITIES.PEOPLE_READ_MEDICAL, CAPABILITIES.AUDIT_EXPORT,
    ]) {
      expect(viewer.has(denied)).toBe(false);
    }
  });

  test("self-service templates carry no HR application access", () => {
    for (const name of ["employee_self", "manager_self"]) {
      expect(ROLE_TEMPLATES[name]).not.toContain(CAPABILITIES.HR_ACCESS);
    }
  });
});

describe("the write-coverage harness and the mount registry agree", () => {
  test("every HR router verifyHrWriteCoverage knows about is in the mount registry", () => {
    /* The two lists answer different questions — this one "is it declared", the
       harness "does its write reach an approver" — but they must describe the
       same HR surface, or one of them is quietly reporting on less than it
       claims. */
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../../verifyHrWriteCoverage.js"), "utf8");
    const block = src.slice(src.indexOf("const MOUNTS = ["), src.indexOf("];", src.indexOf("const MOUNTS = [")));
    const harnessModules = [...block.matchAll(/"(\.\/routes\/[^"]+)"/g)].map((m) => m[1]);
    const registryModules = new Set(MOUNTS.map(([, mod]) => mod));

    const missing = harnessModules.filter((m) => !registryModules.has(m));
    expect(missing).toEqual([]);
  });
});
