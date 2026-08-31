// verifyHrApprovalFlow.js
//
// An editor's HR write is held; an approver's is not; and a role follows its
// owner's email when it changes.
//
// Run:  node -r dotenv/config verifyHrApprovalFlow.js
//
// CREATES AND THEN DELETES its own DepartmentRole rows in a throwaway
// department slug, and its own throwaway Employee. It never touches the real
// `hr` slug or a real person; cleanup runs on crash too.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-approval-dept";
const EDITOR = "verify-editor@grav.invalid";
const APPROVER = "verify-approver@grav.invalid";
const MOVED = "verify-editor-new@grav.invalid";

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
  const ChangeRequest = require("./models/Access/ChangeRequest");
  const a = await DepartmentRole.deleteMany({ departmentSlug: SLUG });
  const b = await ChangeRequest.deleteMany({ departmentSlug: SLUG });
  /* The change_logs these actions cause are part of the mess to clear up.
     Without this the harness left rows in the REAL history reading "by
     Harness" — which is exactly how a verification script turns into a
     support question. Matched narrowly: the harness actor, and the throwaway
     names and addresses only these scripts use. */
  const ChangeLog = require("./models/Access/ChangeLog");
  const logs = await ChangeLog.deleteMany({
    $or: [
      { actorName: "Harness" },
      { entityLabel: /^Verify / },
      { summary: /grav\.invalid/ },
      { entityLabel: /grav\.invalid/ },
    ],
  });

  return a.deletedCount + b.deletedCount + logs.deletedCount;
}

/** A stand-in Express response that records what the middleware answered. */
function fakeRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

function fakeReq(email, { method = "PUT", url = "/api/employees/68f0a1b2c3d4e5f60718293a" } = {}) {
  return {
    method,
    url,
    originalUrl: url,
    headers: {},
    body: { email: "someone@example.com" },
    user: { id: "000000000000000000000009", email, name: "Harness" },
  };
}

/** Run a middleware and report whether it called next() or answered. */
function run(mw, req) {
  return new Promise((resolve) => {
    const res = fakeRes();
    mw(req, res, () => resolve({ passed: true, res }));
    const settle = setInterval(() => {
      if (res.headersSent) {
        clearInterval(settle);
        resolve({ passed: false, res });
      }
    }, 10);
    setTimeout(() => { clearInterval(settle); resolve({ passed: !res.headersSent, res }); }, 3000);
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { setRole, getRole, followEmailChange } = require("./services/departmentRoles");
  const departmentWrites = require("./Middlewear/departmentWriteGuard");
  const ChangeRequest = require("./models/Access/ChangeRequest");

  await cleanup();

  await setRole({ departmentSlug: SLUG, email: EDITOR, name: "Ed", role: "editor" });
  await setRole({ departmentSlug: SLUG, email: APPROVER, name: "Ap", role: "approver" });

  const guard = departmentWrites(SLUG, { entity: "HR record" });

  console.log("an editor's write");
  const ed = await run(guard, fakeReq(EDITOR));
  check("is NOT applied — the route never runs", ed.passed === false);
  check("and answers 202, not a success", ed.res.statusCode === 202, `got ${ed.res.statusCode}`);
  check("saying it is waiting for approval", ed.res.body?.held === true);
  const held = await ChangeRequest.countDocuments({ departmentSlug: SLUG, status: "pending" });
  check("a pending request is queued for the approver", held === 1, `found ${held}`);

  console.log("\nan approver's write");
  const ap = await run(guard, fakeReq(APPROVER));
  check("goes straight through", ap.passed === true);
  check("and queues nothing extra",
    (await ChangeRequest.countDocuments({ departmentSlug: SLUG, status: "pending" })) === 1);

  console.log("\nsomebody with no role in the department");
  const nobody = await run(guard, fakeReq("verify-nobody@grav.invalid"));
  check("is refused rather than queued", nobody.passed === false);
  check("with a 403", nobody.res.statusCode === 403, `got ${nobody.res.statusCode}`);

  console.log("\na read");
  const read = await run(guard, fakeReq(EDITOR, { method: "GET" }));
  check("is never touched, even for an editor", read.passed === true);

  console.log("\nwhen the editor's email changes");
  check("the role is theirs before the change", (await getRole(SLUG, EDITOR)) === "editor");
  const moved = await followEmailChange(EDITOR, MOVED);
  check("the access record moves with them", moved >= 1, `moved ${moved}`);
  check("the role answers at the new address", (await getRole(SLUG, MOVED)) === "editor");
  check("and no longer at the old one", (await getRole(SLUG, EDITOR)) === null);
  const after = await run(guard, fakeReq(MOVED));
  check(
    "so they are still an editor rather than locked out",
    after.passed === false && after.res.statusCode === 202,
    `got ${after.res.statusCode}`,
  );

  console.log("\nand it refuses to collide");
  const before = await getRole(SLUG, APPROVER);
  await followEmailChange(MOVED, APPROVER); // the approver already holds a role
  check(
    "an existing role at the new address is left alone",
    (await getRole(SLUG, APPROVER)) === before,
  );

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 2);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} harness row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — delete rows with departmentSlug "${SLUG}".`);
  }
  process.exit(1);
});
