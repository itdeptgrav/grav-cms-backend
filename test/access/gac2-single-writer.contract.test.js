// test/access/gac2-single-writer.contract.test.js
//
// SOURCE CONTRACT — access authority has one writer (GAC-2 correction).
//
// Reads the production source (routes/, services/, Middlewear/, middleware/,
// utils/, config/, server.js) and fails when anything other than
// services/access/accessGrantAdmin.service.js writes application-access
// authority:
//
//   · DepartmentRole rows (any create/update/delete)
//   · Acc_User role, isActive, loginMode or organisation, or creating/deleting
//     an Acc_User at all
//   · DeptUser.isAdmin anywhere but the one administrator write
//   · the append-only access audit (never mutated by anyone)
//
// Each exception is listed below WITH ITS REASON AND ITS DELETION CONDITION.
// A new writer fails this test until it is either routed through
// changeAppAccess() or added here deliberately, in review.
//
// The scanner is exercised against synthetic bypasses at the bottom, so a
// regex that silently stopped matching would fail too.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const ROOTS = ["routes", "services", "Middlewear", "middleware", "utils", "config", "server.js"];
const CANONICAL = "services/access/accessGrantAdmin.service.js";

function listFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    // Always "/"-separated, so the pinned lists below match on Windows too.
    if (st.isFile()) { if (/\.js$/.test(rel) && !/\.test\.js$/.test(rel)) out.push(rel.split(path.sep).join("/")); return; }
    for (const name of fs.readdirSync(abs)) {
      // Skip transient files other suites create and delete while running
      // (test/accountant/reporting-mutation.test.js writes __mutant_*.js).
      if (name === "node_modules" || name.startsWith(".") || name.startsWith("__mutant_")) continue;
      walk(path.join(rel, name));
    }
  };
  ROOTS.forEach(walk);
  return out;
}

/** Read a source file; a file that vanished mid-scan (transient) reads as empty. */
function readSource(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/** The statement starting at `index`: up to the end of its call (balanced parentheses). */
function statementAt(src, index) {
  let depth = 0;
  let started = false;
  for (let i = index; i < Math.min(src.length, index + 2000); i += 1) {
    const ch = src[i];
    if (ch === "(") { depth += 1; started = true; }
    else if (ch === ")") { depth -= 1; if (started && depth === 0) return src.slice(index, i + 1); }
  }
  return src.slice(index, index + 400);
}

/** Name of the nearest enclosing top-level function, and the nearest route declaration. */
function context(src, index) {
  const before = src.slice(0, index);
  const fns = [...before.matchAll(/\n(?:async\s+)?function\s+(\w+)/g)];
  const routes = [...before.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  return {
    fn: fns.length ? fns[fns.length - 1][1] : null,
    route: routes.length ? `${routes[routes.length - 1][1].toUpperCase()} ${routes[routes.length - 1][2]}` : null,
  };
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** The call's top-level arguments, as source text. */
function callArgs(statement) {
  const open = statement.indexOf("(");
  if (open < 0) return [];
  const body = statement.slice(open + 1, statement.lastIndexOf(")"));
  const args = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) args.push(cur);
  return args;
}

const DR_WRITE = /DepartmentRole\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|deleteOne|deleteMany|findOneAndDelete|bulkWrite|collection)\b|new DepartmentRole\(/g;
const ACC_WRITE = /Acc_User\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|deleteOne|deleteMany|findOneAndDelete|bulkWrite|collection)\b|new Acc_User\(/g;
const ACC_AUTHORITY_FIELD = /\b(role|isActive|loginMode|organizationId)\b/;
const ACC_STRUCTURAL = /^(new Acc_User\(|Acc_User\.(create|insertMany|replaceOne|deleteOne|deleteMany|findOneAndDelete|bulkWrite|collection))/;
const DOC_ASSIGN = /\b(\w+)\.(role|isActive|loginMode)\s*=(?!=)/g;
const ADMIN_ASSIGN = /\.isAdmin\s*=(?!=)/g;
const AUDIT_MUTATION = /AccessGrantEvent\.(update\w*|delete\w*|findOneAnd\w+|replaceOne|bulkWrite|collection)|access_grant_events/g;

/* ── DOCUMENTED EXCEPTIONS ─────────────────────────────────────────────── */

/** DepartmentRole writers other than the canonical service. */
const DR_EXCEPTIONS = [
  {
    file: "services/departmentRoles.js", fn: "setRole",
    reason: "FIXTURE writer for tests and demo seeders; refuses unless NODE_ENV=test or ALLOW_FIXTURE_ROLE_WRITES=1, and refuses Accounting always",
    deletion: "when test fixtures seed DepartmentRole directly or through changeAppAccess",
    requires: (src) => src.includes("DIRECT_ROLE_WRITE_RETIRED"),
  },
  {
    file: "services/departmentRoles.js", fn: "followEmailChange",
    reason: "moves existing rows to a person's NEW email address; changes no role, grants and revokes nothing",
    deletion: "when grants are keyed on identity id rather than email",
    statement: (st) => /\$set:\s*\{\s*email:\s*to\s*\}/.test(st),
  },
  {
    file: "services/companyContext/companyAccess.service.js", fn: "change",
    reason: "company-scoped grant writer, RETIRED from production (route returns 410; refuses outside NODE_ENV=test); kept for company-scope characterisation tests",
    deletion: "GAC-5 (company scoping removed)",
    requires: (src) => src.includes("COMPANY_SCOPED_ACCESS_RETIRED"),
  },
];

/** Acc_User writes outside the canonical service that touch NO authority field. */
const ACC_NON_AUTHORITY_REASON = "session/device/display/email bookkeeping — no role, activation, login mode or organisation";

/** Document-level `x.role = …` / `x.isActive = …` assignments that are NOT access authority. */
const DOC_ASSIGN_EXCEPTIONS = [
  { file: "routes/Accountant_Routes/Acc_approvals.js", vars: ["sourceUpdate", "ledger", "grp"], reason: "ledger/group activation (chart of accounts), not access" },
  { file: "routes/Accountant_Routes/Acc_chartOfAccounts.js", vars: ["grp", "ledger", "sourceUpdate", "filter"], reason: "ledger/group activation, not access" },
  { file: "routes/Accountant_Routes/Acc_customers.js", vars: ["ghost"], reason: "customer ghost merge, not access" },
  { file: "routes/Accountant_Routes/Acc_vouchers.js", vars: ["dormant", "raced"], reason: "voucher/party state, not access" },
  { file: "routes/Admin/accessAdmin.js", vars: ["dept", "filter", "user"], reason: "`dept` is application (catalogue) activation; `user` is DeptUser activation in the ONE administrator write (PATCH /users/:id) — see ADMIN_WRITE" },
  { file: "routes/CMS_Routes/Board/policies.js", vars: ["req"], reason: "request-scoped board context, not stored" },
  { file: "routes/CMS_Routes/Manufacturing/QC/qcTeamRoutes.js", vars: ["stage", "row"], reason: "QCStage / QCDefectType catalogue activation, not access" },
];

/** The one place DeptUser.isAdmin (and DeptUser activation) may be written. */
const ADMIN_WRITE = { file: "routes/Admin/accessAdmin.js", route: "PATCH /users/:id" };

/** Every route that calls changeAppAccess must be the canonical route or a documented adapter. */
const ADAPTER_FILES = {
  "routes/Admin/accessAdmin.js": "PUT /app-access (canonical) + department-roles/accountant-role adapters",
  "routes/Access/departmentTeam.js": "HR/department team screen adapter",
  "routes/Accountant_Routes/Acc_team.js": "Accounting team screen adapter",
};

/* ── the scanner ───────────────────────────────────────────────────────── */

function scan(file, src) {
  const violations = [];
  if (file === CANONICAL) return violations;
  const isAccFile = /Acc_OrgModels|Acc_User\b/.test(src);
  const isDrFile = /DepartmentRole\b/.test(src);

  for (const m of src.matchAll(DR_WRITE)) {
    const { fn } = context(src, m.index);
    const st = statementAt(src, m.index);
    const ex = DR_EXCEPTIONS.find((e) => e.file === file && e.fn === fn);
    const ok = ex && (!ex.requires || ex.requires(src)) && (!ex.statement || ex.statement(st));
    if (!ok) violations.push(`${file}:${lineOf(src, m.index)} writes DepartmentRole outside the canonical service (${fn || "top level"})`);
  }

  for (const m of src.matchAll(ACC_WRITE)) {
    const st = statementAt(src, m.index);
    const { fn } = context(src, m.index);
    const followEmail = file === "services/departmentRoles.js" && fn === "followEmailChange" && /\$set:\s*\{\s*email:\s*to\s*\}/.test(st);
    if (followEmail) continue;
    // The UPDATE document (2nd argument; the filter may legitimately name the
    // organisation) must touch no authority field.
    const update = callArgs(st)[1] || "";
    if (ACC_STRUCTURAL.test(st) || ACC_AUTHORITY_FIELD.test(update)) {
      violations.push(`${file}:${lineOf(src, m.index)} writes Acc_User authority outside the canonical service`);
    }
  }

  if (isAccFile || isDrFile) {
    for (const m of src.matchAll(DOC_ASSIGN)) {
      // Inside a documented, guarded fixture writer (DR_EXCEPTIONS) — same exception.
      const { fn } = context(src, m.index);
      const fixture = DR_EXCEPTIONS.find((e) => e.file === file && e.fn === fn && e.requires && e.requires(src));
      if (fixture) continue;
      const ex = DOC_ASSIGN_EXCEPTIONS.find((e) => e.file === file && e.vars.includes(m[1]));
      if (ex) {
        if (file === ADMIN_WRITE.file && m[1] === "user" && context(src, m.index).route !== ADMIN_WRITE.route) {
          violations.push(`${file}:${lineOf(src, m.index)} assigns user.${m[2]} outside ${ADMIN_WRITE.route}`);
        }
        continue;
      }
      violations.push(`${file}:${lineOf(src, m.index)} assigns ${m[1]}.${m[2]} in a file that handles access records`);
    }
  }

  for (const m of src.matchAll(ADMIN_ASSIGN)) {
    const { route } = context(src, m.index);
    if (!(file === ADMIN_WRITE.file && route === ADMIN_WRITE.route)) {
      violations.push(`${file}:${lineOf(src, m.index)} writes isAdmin outside ${ADMIN_WRITE.route}`);
    }
  }

  for (const m of src.matchAll(AUDIT_MUTATION)) {
    violations.push(`${file}:${lineOf(src, m.index)} touches the append-only access audit`);
  }

  // Fixture writers must have no production caller.
  if (file !== "services/departmentRoles.js" && /\bsetRole\s*\(/.test(src) && /departmentRoles/.test(src)) {
    violations.push(`${file} calls the fixture-only departmentRoles.setRole()`);
  }
  if (/companyContext\/companyAccess\.service/.test(src) && /\b(access|companyAccess)\.change\s*\(|\{\s*[^}]*\bchange\b[^}]*\}\s*=\s*require\([^)]*companyAccess\.service/.test(src)) {
    violations.push(`${file} calls the retired companyAccess.change()`);
  }

  // Callers of the canonical write are the canonical route or documented adapters.
  if (/changeAppAccess\s*\(/.test(src) && !ADAPTER_FILES[file]) {
    violations.push(`${file} calls changeAppAccess() but is not a documented canonical route/adapter`);
  }
  return violations;
}

/* ── the contract ──────────────────────────────────────────────────────── */

describe("access authority has one writer", () => {
  const files = listFiles();

  test("the scan covers the production tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(CANONICAL);
    expect(files).toContain("routes/Accountant_Routes/Acc_team.js");
  });

  test("no production file writes access authority outside the canonical service or a documented exception", () => {
    const violations = files.flatMap((f) => scan(f, readSource(f)));
    expect(violations).toEqual([]);
  });

  test("every documented DepartmentRole exception still exists (a stale exception is a hole)", () => {
    for (const ex of DR_EXCEPTIONS) {
      const src = fs.readFileSync(path.join(ROOT, ex.file), "utf8");
      expect(src).toMatch(new RegExp(`function\\s+${ex.fn}\\b`));
      if (ex.requires) expect(ex.requires(src)).toBe(true);
    }
  });

  test("every compatibility adapter documents its consumer and deletion condition", () => {
    for (const file of Object.keys(ADAPTER_FILES)) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(src).toMatch(/[Cc]onsumer/);
      expect(src).toMatch(/[Dd]eletion( condition)?:?/);
    }
  });

  test("the canonical service is the only place that creates an Acc_User", () => {
    const creators = files.filter((f) => /new Acc_User\(|Acc_User\.(create|insertMany)\b/.test(readSource(f)));
    expect(creators).toEqual([CANONICAL]);
  });
});

/* ── NOT YET ROUTED: legacy application assignments ─────────────────────
 * The canonical resolver still honours a legacy department ASSIGNMENT
 * (Employee.accessDepartmentId / additionalDepartmentIds, DeptUser.departmentId)
 * as `editor` for an application with no role rows at all. Writing those
 * fields is therefore still an access change outside changeAppAccess(). They
 * are NOT routed in GAC-2 (doing so is the legacy-bridge retirement, proposed
 * for the guard cutover chunk). Pinned here EXACTLY, so no new one can appear
 * unnoticed; the handoff lists them as what still blocks the "one write"
 * claim. */
const LEGACY_ASSIGNMENT_WRITERS = [
  "routes/Admin/accessAdmin.js POST /users",
  "routes/Admin/accessAdmin.js PATCH /users/:id",
  "routes/Admin/accessAdmin.js PATCH /employees/:id",
  "routes/Admin/accessAdmin.js POST /employees/bulk-assign",
];
const LEGACY_ASSIGNMENT = /\$set\.(accessDepartmentId|additionalDepartmentIds)\s*=|\$set:\s*\{\s*(accessDepartmentId|additionalDepartmentIds)\b|\buser\.departmentId\s*=(?!=)|new DeptUser\(|DeptUser\.create\(/g;

describe("legacy application-assignment writers (known, not yet routed)", () => {
  test("are exactly the pinned list", () => {
    const found = new Set();
    for (const f of listFiles()) {
      const src = readSource(f);
      for (const m of src.matchAll(LEGACY_ASSIGNMENT)) found.add(`${f} ${context(src, m.index).route}`);
    }
    expect([...found].sort()).toEqual([...LEGACY_ASSIGNMENT_WRITERS].sort());
  });
});

describe("the scanner catches the bypasses it exists for", () => {
  const cases = [
    ["routes/X.js", 'const { Acc_User } = require("x");\nrouter.patch("/:id", async () => { user.role = req.body.role; await user.save(); });', /assigns user.role/],
    ["routes/X.js", 'const { Acc_User } = require("x");\nawait Acc_User.updateOne({ _id }, { $set: { isActive: false } });', /Acc_User authority/],
    ["routes/X.js", 'const { Acc_User } = require("x");\nconst u = new Acc_User({ email, role: "viewer" });', /Acc_User authority/],
    ["routes/X.js", 'const DepartmentRole = require("x");\nawait DepartmentRole.updateOne({ email }, { $set: { role: "owner" } });', /writes DepartmentRole/],
    ["routes/X.js", 'router.post("/promote", async () => { user.isAdmin = true; });', /writes isAdmin/],
    ["services/X.js", 'const deptRoles = require("./departmentRoles");\nawait deptRoles.setRole({});', /fixture-only/],
    ["services/X.js", 'await AccessGrantEvent.deleteMany({});', /append-only/],
    ["routes/X.js", 'const { changeAppAccess } = require("y");\nawait changeAppAccess({});', /not a documented/],
  ];
  test.each(cases)("%s → flagged", (file, src, expected) => {
    const v = scan(file, src);
    expect(v.join("\n")).toMatch(expected);
  });

  test("a non-authority Acc_User write is not flagged", () => {
    const src = 'const { Acc_User } = require("x");\nawait Acc_User.updateOne({ _id: id }, { $addToSet: { fcmTokens: token } });';
    expect(scan("routes/X.js", src)).toEqual([]);
  });
});

module.exports = { ACC_NON_AUTHORITY_REASON };
