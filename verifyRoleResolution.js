// verifyRoleResolution.js
//
// An approver is recognised as one, whichever of their addresses the grant
// sits on — and every grant that nobody can log in with is named.
//
// Run:  node -r dotenv/config verifyRoleResolution.js      (READ-ONLY)

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { getEffectiveRole, getRole, roleAtLeast } = require("./services/departmentRoles");
  const DepartmentRole = require("./models/Access/DepartmentRole");
  const Employee = require("./models/Employee");

  console.log("the strongest grant wins, across addresses");
  const grants = await DepartmentRole.find({ departmentSlug: "hr", isActive: { $ne: false } }).lean();
  check("HR has grants to test against", grants.length > 0, `${grants.length}`);

  /* Somebody holding an approver grant must resolve to approver when they sign
     in — from the token's email, or from the address on their own record. */
  for (const g of grants) {
    const emp = await Employee.findOne({ email: g.email }).select("_id email biometricId").lean();
    if (!emp) continue;
    const role = await getEffectiveRole("hr", {
      user: { email: emp.email, id: String(emp._id), employeeId: emp.biometricId },
    });
    check(`${g.email} resolves to at least ${g.role}`,
      role && roleAtLeast(role, g.role), `got ${role}`);
  }

  console.log("\na grant on another of the same person's addresses still counts");
  /* Simulated rather than written: the token carries one address, the employee
     record carries the one the grant was made against. */
  const target = grants.find((g) => g.role === "editor") || grants[0];
  const emp = await Employee.findOne({ email: target.email }).select("_id email biometricId").lean();
  if (emp) {
    const viaOtherAddress = await getEffectiveRole("hr", {
      user: { email: "an-address-with-no-grant@example.invalid", id: String(emp._id), employeeId: emp.biometricId },
    });
    check("resolved from the employee record when the token's email has none",
      viaOtherAddress === target.role, `got ${viaOtherAddress}`);
  }
  check("an unknown person resolves to no role",
    (await getEffectiveRole("hr", { user: { email: "nobody@example.invalid" } })) === null);
  check("it never matches on name alone",
    (await getEffectiveRole("hr", { user: { email: "", name: "SOUMYA PRAHARAJ" } })) === null);

  console.log("\ngrants nobody can sign in with");
  const orphans = [];
  for (const g of await DepartmentRole.find({ isActive: { $ne: false } }).lean()) {
    const asEmployee = await Employee.findOne({ email: g.email }).select("_id").lean();
    if (asEmployee) continue;
    /* Department logins live in their own collections; check the one this
       department uses before calling a grant unreachable. */
    const { DEPARTMENTS } = require("./services/ensureAccessDepartments");
    const dept = DEPARTMENTS.find((d) => d.slug === g.departmentSlug || d.key === g.departmentSlug);
    let asDeptLogin = null;
    if (dept?.legacyCollection) {
      asDeptLogin = await mongoose.connection.db
        .collection(dept.legacyCollection)
        .findOne({ email: g.email }, { projection: { _id: 1 } });
    }
    if (!asDeptLogin) orphans.push(g);
  }

  if (orphans.length) {
    console.log(`  ${orphans.length} grant(s) are on an address with no login:`);
    for (const o of orphans) {
      const sameName = await Employee.findOne({
        $expr: { $eq: [{ $concat: ["$firstName", " ", "$lastName"] }, o.name] },
      }).select("email biometricId").lean();
      console.log(`     ${o.departmentSlug}/${o.role.padEnd(9)} ${o.email}  (${o.name || "no name"})`);
      if (sameName) {
        console.log(`        "${o.name}" signs in as ${sameName.email} — that grant never applies`);
      }
    }
  }
  /* Reported, not failed. Orphaned grants are a data state somebody has to
     decide about, and a harness that fails on them would cry wolf until they
     are cleaned up. */
  check(`the orphan check ran (${orphans.length} found)`, Array.isArray(orphans));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
