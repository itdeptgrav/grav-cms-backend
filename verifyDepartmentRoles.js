// verifyDepartmentRoles.js
//
// Granting and revoking a department role actually works.
//
// Run:  node -r dotenv/config verifyDepartmentRoles.js
//
// CREATES AND THEN DELETES its own DepartmentRole rows for the throwaway
// addresses below, in a throwaway department slug. It touches no real
// department and no real person; cleanup runs on crash too.
//
// WHY THIS EXISTS
// ---------------
// `setRole` called `dropRoleCaches`, which was never defined anywhere. Every
// grant and every revoke threw `ReferenceError: dropRoleCaches is not defined`
// — AFTER the database write, so the change landed and was reported as an
// error. This pins the whole path: grant, read back, promote, demote, revoke.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-harness-dept";
const A = "verify-role-a@grav.invalid";
const B = "verify-role-b@grav.invalid";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function cleanup() {
  const DepartmentRole = require("./models/Access/DepartmentRole");
  return (await DepartmentRole.deleteMany({ departmentSlug: SLUG })).deletedCount;
}

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { getRole, listRoles, setRole } = require("./services/departmentRoles");
  await cleanup();

  console.log("granting");
  const granted = await setRole({
    departmentSlug: SLUG,
    email: A,
    name: "Harness A",
    role: "editor",
  });
  check("a grant returns without throwing", granted.role === "editor");
  check("it reports the row as newly created", granted.created === true);
  check("and the role reads back", (await getRole(SLUG, A)) === "editor");

  console.log("\nchanging a role");
  const changed = await setRole({ departmentSlug: SLUG, email: A, role: "approver" });
  check("the change applies", changed.role === "approver");
  check("it reports what it was before", changed.previous === "editor");
  check("the new role reads back", (await getRole(SLUG, A)) === "approver");

  console.log("\none owner per department");
  await setRole({ departmentSlug: SLUG, email: A, role: "owner" });
  await setRole({ departmentSlug: SLUG, email: B, name: "Harness B", role: "owner" });
  check("the newcomer is the owner", (await getRole(SLUG, B)) === "owner");
  check(
    "the incumbent was demoted rather than left as a second owner",
    (await getRole(SLUG, A)) === "approver",
  );

  console.log("\nlisting");
  const listed = await listRoles(SLUG);
  check("both people are listed", listed.length === 2, `got ${listed.length}`);

  console.log("\nrevoking");
  const revoked = await setRole({ departmentSlug: SLUG, email: A, role: null });
  check("a revoke returns without throwing", revoked.revoked === true);
  check("and the role is gone", (await getRole(SLUG, A)) === null);
  check(
    "the other person is untouched",
    (await getRole(SLUG, B)) === "owner",
  );

  console.log("\nreads that should not explode");
  check("an unknown department is null, not an error", (await getRole("no-such-dept", A)) === null);
  check("a blank email is null", (await getRole(SLUG, "")) === null);

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 1);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} harness row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — delete DepartmentRole rows with departmentSlug "${SLUG}".`);
  }
  process.exit(1);
});
