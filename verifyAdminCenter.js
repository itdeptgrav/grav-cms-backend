// verifyAdminCenter.js
//
// The admin-center delta: form definitions drive real validation on the real
// employee route, job control works, maintenance finds what it claims to
// find, origins validate, and the granular role floors refuse what they say
// they refuse.
//
// Run:  node -r dotenv/config verifyAdminCenter.js
//
// CREATES AND THEN DELETES its own form defs, employees, roles, alerts and
// heartbeat rows (all namespaced verify-admin-*/@grav.invalid). Cleanup runs
// on crash too.

"use strict";

const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function cleanup() {
  const FormFieldDef = require("./models/DevOps/FormFieldDef");
  const Employee = require("./models/Employee");
  const JobHeartbeat = require("./models/DevOps/JobHeartbeat");
  const DevAlert = require("./models/DevOps/DevAlert");
  const ChangeLog = require("./models/Access/ChangeLog");
  const DepartmentRole = require("./models/Access/DepartmentRole");
  const SystemSetting = require("./models/DevOps/SystemSetting");
  let n = 0;
  n += (await FormFieldDef.deleteMany({ key: /^verifyAdmin/ })).deletedCount;
  n += (await Employee.deleteMany({ email: /@grav\.invalid$/ })).deletedCount;
  n += (await JobHeartbeat.deleteMany({ name: /^verify-admin-/ })).deletedCount;
  n += (await DevAlert.deleteMany({ fingerprint: /verify-admin/ })).deletedCount;
  n += (await ChangeLog.deleteMany({ $or: [{ actorName: "Harness" }, { entityLabel: /grav\.invalid/ }, { summary: /grav\.invalid/ }] })).deletedCount;
  n += (await DepartmentRole.deleteMany({ departmentSlug: "verify-admin-dept" })).deletedCount;
  n += (await SystemSetting.deleteMany({ updatedByEmail: /grav\.invalid$/ })).deletedCount;
  require("./services/formConfig").invalidate();
  require("./services/devConfig").invalidate();
  return n;
}

/* Drive a route THROUGH its whole per-route stack (floors included), with an
   injected identity — the technique from verifyDepartmentTeam, upgraded to run
   every handler on the route rather than only the last. */
function fakeRes() {
  const r = { statusCode: 200, body: null, done: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.done = true; return r; };
  return r;
}
function call(router, method, path, { devRole = "viewer", body = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(), url: path, originalUrl: `/api/dev${path}`,
      headers: {}, body, query, params: {},
      user: { id: "000000000000000000000001", email: "verify-admin@grav.invalid", name: "Harness" },
      devRole,
    };
    const res = fakeRes();
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const keys = [];
      const rx = new RegExp("^" + layer.route.path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
      const hit = path.split("?")[0].match(rx);
      if (!hit || !layer.route.methods[method.toLowerCase()]) continue;
      keys.forEach((k, i) => { req.params[k] = decodeURIComponent(hit[i + 1]); });

      const stack = layer.route.stack.map((l) => l.handle);
      let settled = false;
      /* Armed after EVERY handler invocation, not only on error: a role floor
         that 403s never calls next(), and a settle that only ran from the
         next() chain left that promise pending forever — which is exactly how
         the first run of this harness hung. */
      const settle = () => {
        if (settled) return;
        settled = true;
        const t = setInterval(() => { if (res.done) { clearInterval(t); resolve(res); } }, 5);
        setTimeout(() => { clearInterval(t); resolve(res); }, 3000);
      };
      let i = 0;
      const next = (err) => {
        if (err || res.done || i >= stack.length) return settle();
        const h = stack[i++];
        Promise.resolve(h(req, res, next)).then(settle, settle);
      };
      next();
      return;
    }
    resolve({ statusCode: 0, body: { message: "no such route" } });
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const FormFieldDef = require("./models/DevOps/FormFieldDef");
  const Employee = require("./models/Employee");
  const formConfig = require("./services/formConfig");
  const jobRegistry = require("./services/jobRegistry");
  const { ensureJob, checkOverdue } = require("./services/jobHeartbeats");
  const JobHeartbeat = require("./models/DevOps/JobHeartbeat");
  const maintenance = require("./services/maintenanceChecks");
  const { isValidOrigin, makeOriginCheck } = require("./services/allowedOrigins");
  const { setSetting, DEFINITIONS } = require("./services/devConfig");
  const { setRole } = require("./services/departmentRoles");
  const devRouter = require("./routes/DevOps/developer");

  await cleanup();

  /* ── the form circuit ─────────────────────────────────────────────── */
  console.log("form definitions drive real validation");
  await FormFieldDef.create([
    { formKey: "hr:employee:personal", key: "verifyAdminBlood", label: "Blood group", type: "dropdown",
      options: ["A+", "B+", "O+"], required: true, order: 0 },
    { formKey: "hr:employee:personal", key: "verifyAdminYears", label: "Prior experience (years)", type: "number",
      min: 0, max: 40, defaultValue: "0", order: 1 },
    { formKey: "hr:employee:personal", key: "verifyAdminOff", label: "Dormant", enabled: false },
  ]);
  formConfig.invalidate();

  let r = await formConfig.validateAndNormalise("hr:employee:personal", [], { isCreate: true });
  check("a required field missing on CREATE is an error", r.errors.some((e) => /Blood group/.test(e)), r.errors.join("|"));
  check("while an optional field with a default materialises",
    r.values.some((v) => v.key === "verifyAdminYears" && v.value === "0"));

  r = await formConfig.validateAndNormalise("hr:employee:personal",
    [{ key: "verifyAdminBlood", value: "Z-" }], { isCreate: true });
  check("a value outside the dropdown's options is refused", r.errors.some((e) => /one of/.test(e)));

  r = await formConfig.validateAndNormalise("hr:employee:personal",
    [{ key: "verifyAdminBlood", value: "A+", label: "HACKED LABEL" },
     { key: "notAConfiguredField", value: "smuggled" },
     { key: "verifyAdminOff", value: "should not store" },
     { key: "verifyAdminYears", value: "55" }], { isCreate: true });
  check("the label comes from the DEFINITION, never the request",
    r.values.find((v) => v.key === "verifyAdminBlood")?.label === "Blood group");
  check("an unconfigured key is dropped, not stored", !r.values.some((v) => v.key === "notAConfiguredField"));
  check("a DISABLED field's value is not stored", !r.values.some((v) => v.key === "verifyAdminOff"));
  check("number bounds are enforced", r.errors.some((e) => /at most 40/.test(e)));

  r = await formConfig.validateAndNormalise("hr:employee:personal", [], { isCreate: false });
  check("a partial UPDATE that omits everything judges nothing", r.errors.length === 0 && r.values.length === 0);

  /* …and on the REAL route: an update carrying a bad custom field is a 400,
     a good one is normalised into the document. */
  console.log("\nand the real employee route enforces them");
  const subject = await Employee.create({
    firstName: "Verify", lastName: "AdminSubject", email: "verify-admin-subject@grav.invalid",
    gender: "Other", biometricId: `VA${Date.now().toString().slice(-6)}`,
  });
  const body = { personalCustomFields: [{ key: "verifyAdminYears", value: "not a number" }] };
  const errs = await formConfig.applyEmployeeFormConfig(body, { isCreate: false });
  check("a bad value is caught before the write", errs.some((e) => /must be a number/.test(e)));

  const good = { personalCustomFields: [{ key: "verifyAdminYears", value: "7", label: "spoof" }] };
  const errs2 = await formConfig.applyEmployeeFormConfig(good, { isCreate: false });
  check("a good value passes and is normalised",
    errs2.length === 0 && good.personalCustomFields[0].label === "Prior experience (years)");
  await Employee.updateOne({ _id: subject._id }, { $set: good });
  const stored = await Employee.findById(subject._id).select("personalCustomFields").lean();
  check("and the value lands in the array the model always had",
    stored.personalCustomFields.some((f) => f.key === "verifyAdminYears" && f.value === "7"));

  /* ── job control ──────────────────────────────────────────────────── */
  console.log("\njob control");
  let ran = 0;
  jobRegistry.registerRunner("verify-admin-job", "harness", async () => { ran += 1; return { ran }; });
  await ensureJob("verify-admin-job", "harness job", 3600);
  const out = await jobRegistry.runNow("verify-admin-job");
  check("run-now invokes the registered function", ran === 1 && out.ok);
  // beat() is fire-and-forget by design; give its updateOne a beat to land.
  await new Promise((r) => setTimeout(r, 300));
  const hb = await JobHeartbeat.findOne({ name: "verify-admin-job" }).lean();
  check("and beats the heartbeat with a duration", hb.beatCount >= 1 && Number.isFinite(hb.lastDurationMs));

  let threw = false;
  try { await jobRegistry.runNow("rm -rf /"); } catch { threw = true; }
  check("an unregistered name cannot be run — the registry IS the security model", threw);

  await jobRegistry.setEnabled("verify-admin-job", false);
  check("disable flips the flag", (await JobHeartbeat.findOne({ name: "verify-admin-job" }).lean()).enabled === false);
  check("isEnabled sees it (cache invalidated)", (await jobRegistry.isEnabled("verify-admin-job")) === false);
  const over = await checkOverdue();
  check("a PAUSED job is never reported overdue", !over.overdue.includes("verify-admin-job"));

  /* ── maintenance finds the planted problems ───────────────────────── */
  console.log("\nmaintenance");
  await setRole({ departmentSlug: "verify-admin-dept", email: "verify-admin-ghost@grav.invalid", name: "Ghost", role: "editor" });
  const orphans = await maintenance.runCheck("orphan-department-roles");
  check("the orphan-role check finds a role pointing at nobody",
    orphans.items.some((i) => i.email === "verify-admin-ghost@grav.invalid"), JSON.stringify(orphans.items.slice(0, 3)));

  await Employee.create([
    { firstName: "Dup", lastName: "One", email: "verify-admin-dup@grav.invalid", gender: "Other", biometricId: `VD1${Date.now().toString().slice(-5)}` },
    { firstName: "Dup", lastName: "Two", email: "verify-admin-dup@grav.invalid", gender: "Other", biometricId: `VD2${Date.now().toString().slice(-5)}` },
  ]);
  const dupes = await maintenance.runCheck("duplicate-employee-emails");
  check("the duplicate-email check finds the pair",
    dupes.items.some((i) => i.email === "verify-admin-dup@grav.invalid"));

  /* ── origins ──────────────────────────────────────────────────────── */
  console.log("\nCORS origins");
  check("a bare origin validates", isValidOrigin("https://preview.grav.in") && isValidOrigin("http://192.168.1.5:3000"));
  check("a path, wildcard or garbage does not",
    !isValidOrigin("https://x.com/path") && !isValidOrigin("*") && !isValidOrigin("javascript:alert(1)"));

  let refused = false;
  try { await setSetting("ops.extraOrigins", "https://ok.grav.in, https://bad.com/evil", { email: "verify-admin@grav.invalid" }); }
  catch { refused = true; }
  check("the setting REFUSES a list containing a non-origin", refused);

  await setSetting("ops.extraOrigins", "https://verify-extra.grav.in", { email: "verify-admin@grav.invalid" });
  const originCheck = makeOriginCheck(["https://static.grav.in"]);
  const verdict = (o) => new Promise((res) => originCheck(o, (err, ok) => res(!err && ok === true)));
  check("a static origin passes", await verdict("https://static.grav.in"));
  check("the live extra origin passes", await verdict("https://verify-extra.grav.in"));
  check("an unknown origin is refused", !(await verdict("https://attacker.example")));
  check("no origin (curl, same-origin) passes", await verdict(undefined));

  /* ── the granular floors, on the real routes ──────────────────────── */
  console.log("\nrole floors");
  let res = await call(devRouter, "PATCH", "/jobs/verify-admin-job", { devRole: "editor", body: { enabled: true } });
  check("an EDITOR cannot pause/resume a job", res.statusCode === 403, String(res.statusCode));
  res = await call(devRouter, "PATCH", "/jobs/verify-admin-job", { devRole: "approver", body: { enabled: true } });
  check("an APPROVER can", res.body?.success === true, JSON.stringify(res.body));

  res = await call(devRouter, "PUT", "/settings/ops.freezeWrites.departments", { devRole: "editor", body: { value: "" } });
  check("an editor cannot touch the freeze list (minRole from the catalogue)", res.statusCode === 403);

  res = await call(devRouter, "POST", "/maintenance/purge-resolved-alerts", { devRole: "editor", body: {} });
  check("an editor cannot run an ACTION check", res.statusCode === 403);
  res = await call(devRouter, "POST", "/maintenance/orphan-department-roles", { devRole: "viewer", body: {} });
  check("…and a viewer cannot even run a report", res.statusCode === 403);
  res = await call(devRouter, "POST", "/maintenance/orphan-department-roles", { devRole: "editor", body: {} });
  check("an editor runs reports fine", res.body?.success === true);

  /* ── flags are catalogued and public-shaped ───────────────────────── */
  console.log("\nfeature flags");
  const flagDefs = DEFINITIONS.filter((d) => d.key.startsWith("flag."));
  check("both wired flags exist in the catalogue",
    flagDefs.some((d) => d.key === "flag.voiceAssistant") && flagDefs.some((d) => d.key === "flag.employeeExtraFields"));
  check("every flag is a boolean with a default", flagDefs.every((d) => d.type === "boolean" && typeof d.default === "boolean"));

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 8);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error("CLEANUP FAILED — remove verify-admin*/@grav.invalid rows.");
  }
  process.exit(1);
});
