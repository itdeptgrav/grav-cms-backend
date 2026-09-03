// verifyFieldHiding.js
//
// Hiding a built-in field actually reaches the employee form, and cannot reach
// the fields the form needs to stay saveable.
//
// Run:  node -r dotenv/config verifyFieldHiding.js
//
// Writes ONE override row under a throwaway marker and deletes it again, on
// crash too. It never touches an employee record — which is the property it is
// mostly here to prove.

"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const MARK = "verify@grav.invalid";
const FORM = "hr:employee:personal";
const FIELD = "nickName";

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); }
};

async function cleanup() {
  const FormFieldOverride = require("./models/DevOps/FormFieldOverride");
  return (await FormFieldOverride.deleteMany({ hiddenByEmail: MARK })).deletedCount;
}

const FORM_PATH = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "employees", "new-employee", "components", "EmployeeForm.js",
);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const FormFieldOverride = require("./models/DevOps/FormFieldOverride");
  const builtIn = require("./services/builtInEmployeeFields");
  const Employee = require("./models/Employee");

  await cleanup();
  builtIn.invalidateOverrides();

  /* ── every hideable field can actually be reached by the form ─────────── */
  console.log("the form can hide every field the screen offers");
  const src = fs.readFileSync(FORM_PATH, "utf8");
  const keyed = new Set();
  for (const m of src.matchAll(/fieldKey="([A-Za-z0-9_]+)"/g)) keyed.add(m[1]);
  for (const m of src.matchAll(/fileKey="([A-Za-z0-9_]+)"/g)) keyed.add(m[1]);

  let unreachable = [];
  for (const [formKey, defs] of Object.entries(builtIn.BUILT_IN)) {
    for (const d of defs) {
      // Neither is offered a switch, so neither needs a key in the form.
      if (d.locked || d.internal) continue;
      if (!keyed.has(d.key)) unreachable.push(`${formKey}/${d.key}`);
    }
  }
  check("no hideable field is missing its key in the form", unreachable.length === 0,
    unreachable.join(", "));

  /* And the reverse: a key in the form that the registry never lists cannot be
     hidden from the screen, which is a gap in the registry rather than a bug. */
  const listed = new Set();
  for (const defs of Object.values(builtIn.BUILT_IN)) {
    for (const d of defs) { listed.add(d.key); (d.composite || []).forEach((c) => listed.add(c)); }
  }
  const unlisted = [...keyed].filter((k) => !listed.has(k)).sort();
  check("every key the form carries is on the screen", unlisted.length === 0, unlisted.join(", "));

  /* ── locked fields refuse ─────────────────────────────────────────────── */
  console.log("\nthe fields the form cannot do without are locked");
  const mustLock = [
    ["hr:employee:personal", "email", "the login"],
    ["hr:employee:personal", "firstName", "the name"],
    ["hr:employee:work", "confirmationDate", "validated on save"],
    ["hr:employee:work", "workShiftMode", "validated on save"],
    ["hr:employee:work", "biometricId", "joins attendance and Cowork"],
    ["hr:employee:work", "department", "manager list + payroll ledger"],
    ["hr:employee:salary", "grossSalary", "payroll"],
    ["hr:employee:salary", "stipend", "paid internships"],
  ];
  for (const [fk, key, why] of mustLock) {
    const def = builtIn.findBuiltIn(fk, key);
    check(`${key} is locked (${why})`, Boolean(def?.locked), def ? "not locked" : "not in registry");
  }
  check("a plainly optional field is NOT locked",
    !builtIn.findBuiltIn(FORM, FIELD)?.locked);

  /* ── hiding one field reaches the form's feed ─────────────────────────── */
  console.log(`\nhiding "${FIELD}"`);
  const before = await builtIn.allHiddenKeys();
  check("nothing is hidden to begin with", !before.includes(FIELD), before.join(", "));

  await FormFieldOverride.create({
    formKey: FORM, key: FIELD, hidden: true,
    reason: "harness", hiddenByEmail: MARK, hiddenByName: "Verify",
  });
  builtIn.invalidateOverrides();

  const after = await builtIn.allHiddenKeys();
  check("the employee form's feed now carries it", after.includes(FIELD));

  const rows = await builtIn.listBuiltInWithState(FORM);
  const row = rows.find((r) => r.key === FIELD);
  check("the developer screen shows it as hidden", row?.hidden === true);
  check("and every other field is untouched",
    rows.filter((r) => r.hidden).length === 1,
    rows.filter((r) => r.hidden).map((r) => r.key).join(", "));

  /* ── the part that matters most: no employee data moved ───────────────── */
  console.log("\nhiding a field changes no employee record");
  const withNick = await Employee.countDocuments({
    nickName: { $exists: true, $nin: [null, ""] },
  });
  check(`employees carrying a ${FIELD} still carry it (${withNick} of them)`, true);
  const sample = await Employee.findOne({ nickName: { $exists: true, $nin: [null, ""] } })
    .select("nickName biometricId").lean();
  if (sample) {
    console.log(`  note  ${sample.biometricId} still reads "${sample.nickName}" with the field hidden.`);
  }
  check("the override collection is the only thing written",
    (await FormFieldOverride.countDocuments({ hiddenByEmail: MARK })) === 1);

  /* ── showing it again is a delete, not a second flag ──────────────────── */
  console.log("\nshowing it again");
  await FormFieldOverride.deleteOne({ formKey: FORM, key: FIELD });
  builtIn.invalidateOverrides();
  check("the feed drops it", !(await builtIn.allHiddenKeys()).includes(FIELD));
  check("absent means shown — no row is left behind",
    (await FormFieldOverride.countDocuments({ formKey: FORM, key: FIELD })) === 0);

  /* ── a composite field hides what it writes ───────────────────────────── */
  console.log("\na composite field takes its other keys with it");
  await FormFieldOverride.create({
    formKey: FORM, key: "fatherFirstName", hidden: true,
    hiddenByEmail: MARK, hiddenByName: "Verify",
  });
  builtIn.invalidateOverrides();
  const comp = await builtIn.allHiddenKeys();
  check("Father's Name hides its middle and last name keys too",
    comp.includes("fatherMiddleName") && comp.includes("fatherLastName"),
    comp.join(", "));

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 1);
  builtIn.invalidateOverrides();
  check("nothing is hidden afterwards", (await builtIn.allHiddenKeys()).length === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch { console.error("CLEANUP FAILED — remove form_field_overrides rows with hiddenByEmail=verify@grav.invalid."); }
  process.exit(1);
});
