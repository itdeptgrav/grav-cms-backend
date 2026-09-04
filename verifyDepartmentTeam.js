// verifyDepartmentTeam.js
//
// The department team screen lets an OWNER manage their own roles, and refuses
// everything that would let a department lock itself out or let the approval
// requirement be voted away by the people it constrains.
//
// Run:  node -r dotenv/config verifyDepartmentTeam.js
//
// CREATES AND THEN DELETES its own roles under a throwaway department slug.
// It never touches the real `hr` slug; cleanup runs on crash too.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-team-dept";
const OWNER = "verify-team-owner@grav.invalid";
const APPROVER = "verify-team-approver@grav.invalid";
const EDITOR = "verify-team-editor@grav.invalid";
const OUTSIDER = "verify-team-outsider@grav.invalid";

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

  return (await DepartmentRole.deleteMany({ departmentSlug: SLUG })).deletedCount + logs.deletedCount;
}

/* A stand-in Express req/res, so the router's own handlers are what runs. */
function fakeRes() {
  const r = { statusCode: 200, body: null, done: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.done = true; return r; };
  return r;
}

/** Drive one route handler off the mounted router's stack. */
function call(router, method, path, { user, body = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url: path, originalUrl: path, body, query, headers: {}, user, params: {} };
    const res = fakeRes();

    const layers = router.stack.filter((l) => l.route || l.handle);
    let i = 0;
    const next = () => {
      if (res.done || i >= layers.length) return resolve(res);
      const layer = layers[i++];
      if (!layer.route) {
        // router.use(authenticateCmsSession) — skipped: identity is injected
        // directly above, and the token path has its own coverage.
        return next();
      }
      const m = layer.route.path;
      const keys = [];
      const rx = new RegExp(
        "^" + m.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$",
      );
      const hit = path.split("?")[0].match(rx);
      if (!hit || !layer.route.methods[method.toLowerCase()]) return next();
      keys.forEach((k, n) => { req.params[k] = decodeURIComponent(hit[n + 1]); });
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      Promise.resolve(handler(req, res, next)).then(() => {
        const settle = setInterval(() => {
          if (res.done) { clearInterval(settle); resolve(res); }
        }, 5);
        setTimeout(() => { clearInterval(settle); resolve(res); }, 3000);
      });
    };
    next();
  });
}

const as = (email, isAdmin = false) => ({ id: "000000000000000000000001", email, name: email, isAdmin });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { setRole, getRole } = require("./services/departmentRoles");
  const router = require("./routes/Access/departmentTeam");

  await cleanup();
  await setRole({ departmentSlug: SLUG, email: OWNER, name: "Owner", role: "owner" });
  await setRole({ departmentSlug: SLUG, email: APPROVER, name: "Approver", role: "approver" });
  await setRole({ departmentSlug: SLUG, email: EDITOR, name: "Editor", role: "editor" });

  console.log("reading the team");
  const asEditor = await call(router, "GET", `/${SLUG}`, { user: as(EDITOR) });
  check("an editor may see who their approvers are", asEditor.body?.success === true);
  check("and is told they cannot manage it", asEditor.body?.canManage === false);
  check("with their own role named", asEditor.body?.myRole === "editor", asEditor.body?.myRole);
  check("everyone holding a role is listed", (asEditor.body?.members || []).length === 3,
    String((asEditor.body?.members || []).length));

  const asOutsider = await call(router, "GET", `/${SLUG}`, { user: as(OUTSIDER) });
  check("somebody with no role here is refused", asOutsider.statusCode === 403, String(asOutsider.statusCode));

  const asOwner = await call(router, "GET", `/${SLUG}`, { user: as(OWNER) });
  check("the owner is told they CAN manage it", asOwner.body?.canManage === true);

  console.log("\nwho may change it");
  const byApprover = await call(router, "PUT", `/${SLUG}`, {
    user: as(APPROVER), body: { email: EDITOR, role: "approver" },
  });
  check("an APPROVER cannot promote anybody", byApprover.statusCode === 403, String(byApprover.statusCode));
  check("so the approval requirement cannot be voted away",
    (await getRole(SLUG, EDITOR)) === "editor");

  const byEditor = await call(router, "PUT", `/${SLUG}`, {
    user: as(EDITOR), body: { email: EDITOR, role: "owner" },
  });
  check("an editor cannot promote themselves", byEditor.statusCode === 403);

  const byOwner = await call(router, "PUT", `/${SLUG}`, {
    user: as(OWNER), body: { email: EDITOR, name: "Editor", role: "approver" },
  });
  check("the owner can", byOwner.body?.success === true, JSON.stringify(byOwner.body));
  check("and the role really changed", (await getRole(SLUG, EDITOR)) === "approver");

  console.log("\nwhat it refuses even from the owner");
  const self = await call(router, "PUT", `/${SLUG}`, {
    user: as(OWNER), body: { email: OWNER, role: "editor" },
  });
  check("the owner cannot demote THEMSELVES", self.statusCode === 400, String(self.statusCode));
  check("with a reason that says what to do", /another owner/i.test(self.body?.message || ""), self.body?.message);
  check("so they are still the owner", (await getRole(SLUG, OWNER)) === "owner");

  // Remove the other two so OWNER is provably the only one left.
  await setRole({ departmentSlug: SLUG, email: EDITOR, role: null });
  await setRole({ departmentSlug: SLUG, email: APPROVER, role: null });

  const lastOut = await call(router, "PUT", `/${SLUG}`, {
    user: as("verify-team-admin@grav.invalid", true), body: { email: OWNER, role: null },
  });
  check("the LAST owner cannot be removed, even by an admin", lastOut.statusCode === 400, String(lastOut.statusCode));
  check("named as the reason", lastOut.body?.code === "LAST_OWNER", lastOut.body?.code);
  check("so the department is never left unmanageable", (await getRole(SLUG, OWNER)) === "owner");

  const bogus = await call(router, "PUT", `/${SLUG}`, {
    user: as(OWNER), body: { email: "someone@grav.invalid", role: "superuser" },
  });
  check("an unknown role is refused", bogus.statusCode === 400, String(bogus.statusCode));

  const noEmail = await call(router, "PUT", `/${SLUG}`, { user: as(OWNER), body: { role: "editor" } });
  check("so is a missing email", noEmail.statusCode === 400);

  console.log("\ncandidate search");
  const searchByEditor = await call(router, "GET", `/${SLUG}/candidates`, {
    user: as(EDITOR), query: { q: "ver" },
  });
  check("only an owner may search for people to add", searchByEditor.statusCode === 403,
    String(searchByEditor.statusCode));

  const shortQ = await call(router, "GET", `/${SLUG}/candidates`, {
    user: as(OWNER), query: { q: "a" },
  });
  check("a one-character query returns nothing rather than the whole workforce",
    (shortQ.body?.candidates || []).length === 0);

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
    console.error(`CLEANUP FAILED — delete rows with departmentSlug "${SLUG}".`);
  }
  process.exit(1);
});
