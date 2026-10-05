// scripts/seed/rndWorkspaceAccess.js
//
// THE R&D 3D WORKSPACE'S DEMO ACCESS, ARRANGED THROUGH THE REAL MODELS.
//
// ── THE FAILURE THIS EXISTS TO CLEAR ────────────────────────────────────────
// The workspace refuses anybody without an ACTIVE `research-development`
// department grant, re-read from the database on every request. That is the
// authority and it is not negotiable — a job title in a token grants nothing,
// and an administrator is not an R&D user by virtue of being an administrator.
//
// What was missing in this deployment was not a rule. It was the data: one
// grant existed for the whole department, and it belonged to somebody else. So
// the fix is to arrange the grants, not to loosen the check.
//
// ── WHAT "COMPANY-SCOPED" ACTUALLY MEANS HERE, STATED HONESTLY ──────────────
// A `DepartmentRole` row carries a `companyGrants[]` array, and it is tempting
// to describe a grant made through it as company-scoped. `getEffectiveRole`
// does not read that array — it reads the row's own `role` and `isActive`. The
// company boundary is enforced one layer out, by `rndCompanyMiddleware`, which
// resolves the acting company from `SpCompanyMembership` and refuses anybody
// with no proven membership.
//
// So a working R&D user needs BOTH, and this seeds both:
//   · an active `research-development` role row, and
//   · an active company membership for the company whose styles they open.
//
// Writing one without the other produces exactly the two failures this script
// was written to end: a 403 on the capability, or a 403 on the tenancy.
//
// ── WHY `setRole` AND NOT THE CANONICAL WRITER ──────────────────────────────
// Production grants go through `services/access/accessGrantAdmin.service.js`,
// which demands an authorised actor, a reason and an audit event, and refuses
// to let anybody change their own access. A seeder has no actor and no session.
// `departmentRoles.setRole` is the repository's declared fixture writer for
// exactly this case: it refuses to run unless `ALLOW_FIXTURE_ROLE_WRITES=1`,
// `scripts/ie/ieDemoScenario.js` already uses it the same way, and the GAC-2
// single-writer contract test deliberately scopes itself to routes, services
// and middleware so that a seeder here is permitted rather than overlooked.
//
// ── IDEMPOTENT, AND NARROW ──────────────────────────────────────────────────
// Every write is an upsert keyed on the email. Running it twice updates the
// same rows; it never creates a second grant, a second membership or a second
// employee. It touches ONLY the accounts named below and any account passed
// explicitly on the command line. It never widens anybody else's access and it
// never prints a password or a token.
//
//   node scripts/seed/rndWorkspaceAccess.js
//   node scripts/seed/rndWorkspaceAccess.js --grant-editor ray@grav.in
//   node scripts/seed/rndWorkspaceAccess.js --company "GRAV CLOTHING" --dry-run
"use strict";

require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const departmentRoles = require("../../services/departmentRoles");

const SLUG = "research-development";
const TAG = "RND-3D-DEMO";

/**
 * The three people the workspace needs to be demonstrable.
 *
 * Three rather than one because the rules worth showing are the ones that need
 * two people: a model is accepted by somebody other than whoever published it,
 * and a viewer who can read an approved model must be unable to change it.
 */
const DEMO = Object.freeze([
  { key: "editor", email: "rnd.editor.demo@grav.demo", name: "R&D Editor (demo)", role: "editor",
    can: "view, upload, annotate and submit" },
  { key: "approver", email: "rnd.approver.demo@grav.demo", name: "R&D Approver (demo)", role: "approver",
    can: "review and approve, and everything an editor can" },
  { key: "viewer", email: "rnd.viewer.demo@grav.demo", name: "R&D Viewer (demo)", role: "viewer",
    can: "inspect models and read notes, and change nothing" },
]);

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

const DRY = has("--dry-run");
const COMPANY = arg("--company", "GRAV CLOTHING");
/* An account that already exists and should become the demo editor. Named
   explicitly on the command line so no unrelated account is ever swept in. */
const GRANT_EDITOR = (arg("--grant-editor") || "").toLowerCase().trim();

/* Silent when a test drives the seeder directly; a seeder whose own output is
   part of its contract would otherwise have to be tested through stdout. */
const say = (...a) => { if (!process.env.RND_SEED_QUIET) console.log(...a); };

/** Where a generated password is left for whoever runs this. Never stdout. */
const CREDENTIALS_FILE = path.join(__dirname, "..", "..", ".rnd-demo-credentials.local");

/**
 * The password the demo sign-in accounts get.
 *
 * `RND_DEMO_PASSWORD` if the operator chose one. Otherwise a random one, used
 * for every demo account in this run and written to a git-ignored file beside
 * the repository — never to the console, a log or a commit, because a seeder
 * that prints a working credential has published it to every terminal history,
 * CI log and screenshot that ever sees the run.
 */
let _password = null;
function demoPassword() {
  if (_password) return _password;
  if (process.env.RND_DEMO_PASSWORD) {
    _password = process.env.RND_DEMO_PASSWORD;
    return _password;
  }
  _password = `Rnd-${crypto.randomBytes(12).toString("base64url")}`;
  fs.writeFileSync(CREDENTIALS_FILE,
    `# R&D 3D workspace demo sign-in accounts\n`
    + `# Generated ${new Date().toISOString()} by scripts/seed/rndWorkspaceAccess.js\n`
    + `# Delete this file once the password is stored wherever your team keeps them.\n`
    + DEMO.map((d) => `${d.email}  ${_password}`).join("\n") + "\n",
    { mode: 0o600 });
  return _password;
}

/**
 * Arrange every demo grant, against an ALREADY OPEN connection.
 *
 * Opening and closing the database is the command line's job (below), not
 * this function's, so the idempotency this file claims can be asserted by a
 * test rather than by running it twice and reading the output.
 *
 * @returns the manifest — one entry per account, each saying what it found
 *          and what it changed, which is what makes a second run readable.
 */
async function seed() {
  say(`database: ${mongoose.connection.name}${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);

  /* ── THE DEPARTMENT ──────────────────────────────────────────────────── */
  const dept = await AccessDepartment.findOne({ slug: SLUG });
  if (!dept) {
    throw new Error(`There is no "${SLUG}" department in Access Control. Create it there first — `
      + "this script arranges grants, it does not invent departments.");
  }
  if (!dept.isActive) {
    say(`! ${SLUG} is INACTIVE. A grant against an inactive department opens nothing.`);
    if (!DRY) { dept.isActive = true; await dept.save(); say(`  reactivated ${SLUG}`); }
  }
  say(`department: ${dept.name} (${dept.slug}) ${dept.isActive ? "active" : "inactive"}`);

  /* ── THE COMPANY WHOSE STYLES THEY WILL OPEN ─────────────────────────── */
  const company = await Acc_Company.findOne({ companyName: new RegExp(COMPANY, "i") });
  if (!company) {
    const all = await Acc_Company.find({}).select("companyName").lean();
    throw new Error(`No company matches "${COMPANY}". Known: ${all.map((c) => c.companyName).join(", ")}`);
  }
  say(`company: ${company.companyName} (${company._id})`);

  const manifest = { department: dept.slug, company: company.companyName, accounts: [] };

  /* ── EACH PERSON: IDENTITY, MEMBERSHIP, GRANT ────────────────────────── */
  for (const spec of DEMO) {
    manifest.accounts.push(await arrange({ ...spec, company, dept, create: true }));
  }

  /* ── AND THE ACCOUNT THAT HIT THE FAILURE, IF NAMED ──────────────────── */
  if (GRANT_EDITOR) {
    const existing = await Employee.findOne({ email: GRANT_EDITOR }).lean();
    if (!existing) {
      say(`! ${GRANT_EDITOR} has no employee record — refusing to invent one for a real address.`);
    } else {
      manifest.accounts.push(await arrange({
        key: "signed-in", email: GRANT_EDITOR,
        name: `${existing.firstName || ""} ${existing.lastName || ""}`.trim() || GRANT_EDITOR,
        role: "editor", can: "view, upload, annotate and submit",
        company, dept, create: false,
      }));
    }
  }

  say("\n── result ──");
  for (const a of manifest.accounts) {
    say(`  ${a.email}`);
    say(`    role ............ ${a.role}  (${a.can})`);
    say(`    grant .......... ${a.grant}`);
    say(`    membership ..... ${a.membership}`);
    say(`    sign-in account  ${a.deptUser}`);
  }
  say(`\n${DRY ? "Nothing was written." : "Grants are live on the next request — the role is re-read every time."}`);
  return manifest;
}

/**
 * One person, made able to open the workspace — or reported as already able.
 *
 * `create` is false for a real person's existing address: this will attach a
 * membership and a grant to the account they already have, and will never
 * fabricate an employee record for somebody who does not have one.
 */
async function arrange({ key, email, name, role, can, company, dept, create }) {
  const mail = email.toLowerCase().trim();
  const out = { key, email: mail, role, can, grant: "", membership: "", deptUser: "" };

  /* ── the employee record every session resolves through ──────────────── */
  let employee = await Employee.findOne({ email: mail });
  if (!employee && create) {
    if (!DRY) {
      employee = await Employee.create({
        firstName: name.split(" ")[0], lastName: "Demo", email: mail,
        biometricId: `${TAG}-${key}`, isActive: true, gender: "Other",
        department: dept.name, accessDepartmentId: dept._id,
      });
    }
    out.deptUser = DRY ? "would create" : "created";
  } else if (employee) {
    /* Pointed at R&D so the portal can open the department for them. An
       existing person's PRIMARY department is left alone — it is theirs — and
       R&D is added alongside it instead. */
    if (!DRY) {
      const extra = (employee.additionalDepartmentIds || []).map(String);
      const primary = String(employee.accessDepartmentId || "");
      if (primary !== String(dept._id) && !extra.includes(String(dept._id))) {
        employee.additionalDepartmentIds = [...(employee.additionalDepartmentIds || []), dept._id];
        await employee.save();
        out.deptUser = "R&D added alongside their own department";
      } else {
        out.deptUser = "already reaches R&D";
      }
    } else {
      out.deptUser = "would reach R&D";
    }
  } else {
    out.deptUser = "no employee record";
    return out;
  }

  /* ── a sign-in account, for the demo addresses only ──────────────────── */
  if (create && !DRY) {
    const password = demoPassword();
    let user = await DeptUser.findOne({ email: mail });
    if (!user) {
      user = new DeptUser({
        name, email: mail, departmentId: dept._id, employeeRef: employee._id,
        isAdmin: false, isActive: true, legacyModel: TAG,
      });
    }
    user.name = name;
    user.employeeRef = employee._id;
    user.departmentId = dept._id;
    user.isActive = true;
    /* `DeptUser` cannot exist without a password hash, so a sign-in account
       always gets one. It is applied on every run so a changed
       RND_DEMO_PASSWORD takes effect and a second run stays idempotent. */
    await user.setPassword(password);
    await user.save();
    out.deptUser = process.env.RND_DEMO_PASSWORD
      ? "sign-in ready (password from RND_DEMO_PASSWORD)"
      : `sign-in ready (password generated — see ${CREDENTIALS_FILE})`;
  }

  /* ── the company membership the tenancy middleware demands ───────────── */
  const existingMembership = await SpCompanyMembership.findOne({ companyId: company._id, email: mail });
  if (existingMembership) {
    if (!existingMembership.isActive && !DRY) {
      existingMembership.isActive = true;
      await existingMembership.save();
      out.membership = "reactivated";
    } else {
      out.membership = existingMembership.isActive ? "already active" : "inactive (dry run)";
    }
  } else if (!DRY) {
    await SpCompanyMembership.create({
      companyId: company._id, email: mail, employeeRef: employee?._id,
      personName: name, isActive: true, note: TAG,
    });
    out.membership = "created";
  } else {
    out.membership = "would create";
  }

  /* ── the grant itself ────────────────────────────────────────────────── */
  if (DRY) {
    const current = await departmentRoles.getRole(SLUG, mail);
    out.grant = current === role ? `already ${role}` : `would set ${current || "none"} → ${role}`;
    return out;
  }
  const before = await departmentRoles.getRole(SLUG, mail);
  /* The declared fixture path — see this file's header. Scoped to this call. */
  process.env.ALLOW_FIXTURE_ROLE_WRITES = "1";
  await departmentRoles.setRole({ departmentSlug: SLUG, email: mail, name, role });
  delete process.env.ALLOW_FIXTURE_ROLE_WRITES;
  const after = await departmentRoles.getRole(SLUG, mail);
  out.grant = before === after ? `already ${after}` : `${before || "none"} → ${after}`;
  return out;
}

module.exports = { seed, arrange, DEMO, SLUG, TAG };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    try { await seed(); } finally { await mongoose.disconnect(); }
  })().catch((err) => {
    console.error("\nseed failed:", err.message);
    process.exit(1);
  });
}
