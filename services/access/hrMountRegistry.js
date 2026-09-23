"use strict";
/**
 * services/access/hrMountRegistry.js — every router the HR authorisation
 * contract covers, with the prefix `server.js` mounts it on.
 *
 * ONE LIST, THREE READERS
 * -----------------------
 *   • test/hr-access/route-coverage.test.js walks these routers and fails when
 *     any route has no declaration in hrRouteContract.js;
 *   • the endpoint matrix in docs/audits/ is generated from it;
 *   • verifyHrWriteCoverage.js keeps its own copy of the HR subset for the
 *     approval-queue question, and a test asserts the two agree.
 *
 * A router added to server.js and not added here is the failure this list
 * exists to cause: the coverage test compares against the contract, so a new HR
 * router with no declarations shows up as a red build rather than as an
 * unguarded endpoint.
 */

/* [mounted prefix, module path] — the pairs from server.js, in mount order. */
const MOUNTS = Object.freeze([
  /* HR administration */
  ["/api/employees", "./routes/HrRoutes/Employee-Section"],
  ["/api/employees/import-export", "./routes/HrRoutes/employeeImportExport"],
  ["/api/hr", "./routes/HrRoutes/HrProfile-Section"],
  ["/api/hr/overview", "./routes/HrRoutes/Overview-Section"],
  ["/api/hr/change-history", "./routes/HrRoutes/ChangeHistory"],
  ["/api/hr/departments", "./routes/HrRoutes/Departments"],
  ["/api/hr/app", "./routes/HrRoutes/Appversionroutes"],
  ["/api/hr/job-postings", "./routes/HrRoutes/JobPosting_Section"],
  ["/api/hr/candidates", "./routes/HrRoutes/Candidates_section"],
  ["/api/hr/tasks", "./routes/HrRoutes/EmployeeTasks_section"],
  ["/api/hr/payroll", "./routes/HrRoutes/Payroll_section"],
  ["/api/hr/payslip", "./routes/HrRoutes/Payslip_section"],
  ["/api/hr/leaves", "./routes/HrRoutes/Leave_section"],
  ["/api/hr/policy", "./routes/HrRoutes/policyRoutes"],
  ["/api/hr/sop", "./routes/HrRoutes/hrSopRoutes"],
  ["/api/hr/documents", "./routes/HrRoutes/EmployeeDocuments_section"],
  ["/api/hr/password-management", "./routes/HrRoutes/Passwordmanagement"],
  ["/api/hr/vendors", "./routes/Vendor_Routes/vendorRoutes"],
  ["/hr/attendance", "./routes/HrRoutes/Attendance_section"],
  ["/hr/shift-swaps", "./routes/HrRoutes/ShiftSwap_section"],
  ["/hr/face-registration", "./routes/HrRoutes/FaceRegistration_section"],
  ["/hr/performance", "./routes/HrRoutes/Performance_section"],
  ["/hr/reports", "./routes/HrRoutes/Reports_section"],

  /* Management's read-only HR projection */
  ["/api/ceo/hr", "./routes/CEO_Routes/hr"],

  /* Employee and manager self-service (the mobile app's HR surface) */
  ["/api/employee", "./routes/Employee_Routes/employeeAuth"],
  ["/api/employee", "./routes/Employee_Routes/pushToken"],
  ["/api/employee/auth", "./routes/Employee_Routes/login"],
  ["/api/employee/attendance", "./routes/Employee_Routes/employeeAttendance"],
  ["/api/employee/leave-applications", "./routes/Employee_Routes/leaveRoutes"],
  ["/api/employee/regularizations", "./routes/Employee_Routes/regularization"],
  ["/api/employee/overtime", "./routes/Employee_Routes/Overtimeroutes"],
  ["/api/employee/documents", "./routes/Employee_Routes/documents"],
  ["/api/employee/payslip", "./routes/Employee_Routes/Payslip"],
  ["/api/employee/performance", "./routes/Employee_Routes/performance"],
  ["/api/employee/leaderboard", "./routes/Employee_Routes/leaderboard"],
  ["/api/employee/absence-calendar", "./routes/Employee_Routes/absenceCalendar"],
  ["/api/employee/notification-settings", "./routes/Employee_Routes/notificationSettings"],
  ["/api/employee/tasks", "./routes/Employee_Routes/TasksEmployee"],

  /* The public identity page */
  ["/employee", "./routes/Employee_Routes/publicProfileAPI"],
]);

/**
 * Walk the real Express routers and return every mounted (method, full path).
 *
 * Reads `router.stack`, so it sees what the server actually serves rather than
 * what a regular expression over the source thinks it sees — the same technique
 * verifyHrWriteCoverage.js uses.
 */
function walkMountedRoutes({ require: req = require, root = "../../" } = {}) {
  const path = require("path");
  const out = [];

  /* Express hides a `router.use(mw, subRouter)` mount one level down, so a
     walker that only looks at `layer.route` misses every route inside it —
     which is exactly how /api/employee/notification-settings, four real
     endpoints, would have gone undeclared and unnoticed. */
  const mountPathOf = (layer) => {
    if (layer.path) return layer.path === "/" ? "" : layer.path;
    /* Express 5 keeps the mount pattern on the layer's matcher; a "/" mount has
       none, which is the common case here. */
    const src = layer.regexp?.source || "";
    const m = src.match(/^\^\\\/(?:\?\()?([A-Za-z0-9_\-\/\\.]*)/);
    if (!m || !m[1]) return "";
    return "/" + m[1].replace(/\\/g, "");
  };

  const walk = (stack, prefix, mod, mount) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const declared = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const one of declared) {
          const methods = Object.entries(layer.route.methods || {}).filter(([, on]) => on);
          /* `router.all()` records a single `_all` flag rather than a verb per
             method. Reported as "*" so a declaration can answer for it once. */
          const verbs = methods.length
            ? methods.map(([m]) => (m === "_all" ? "*" : m.toUpperCase()))
            : ["*"];
          for (const method of verbs) {
            const suffix = one === "/" ? "" : one;
            const full = `${prefix}${suffix}`.replace(/\/+$/, "") || "/";
            out.push({ method, full, module: mod, mount });
          }
        }
        continue;
      }
      const sub = layer.handle;
      if (sub && typeof sub === "function" && Array.isArray(sub.stack)) {
        walk(sub.stack, `${prefix}${mountPathOf(layer)}`, mod, mount);
      }
    }
  };

  for (const [prefix, mod] of MOUNTS) {
    let router;
    try {
      router = req(path.join(__dirname, root, mod));
    } catch (err) {
      out.push({ method: "LOAD_ERROR", full: prefix, module: mod, error: err.message });
      continue;
    }
    walk(router?.stack, prefix, mod, prefix);
  }

  /* One route can be reached through two mounts (payroll is mounted twice at
     /api/hr/payroll); the contract answers once, so report it once. */
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.method} ${r.full}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { MOUNTS, walkMountedRoutes };
