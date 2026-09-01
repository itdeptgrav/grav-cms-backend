// verifyBuiltInFields.js
//
// The built-in field registry still describes the employee form.
//
// Run:  node verifyBuiltInFields.js
//
// The registry in services/builtInEmployeeFields.js is a transcription, and a
// transcription rots: a field added to EmployeeForm.js and not added here
// shows up nowhere on the developer Forms screen, which then quietly
// under-reports the form it claims to describe. This reads the form's source
// and fails when the two have drifted.
//
// No database, no network, no writes — it reads two files.

"use strict";

const fs = require("fs");
const path = require("path");

const FORM_PATH = path.join(
  __dirname,
  "..",
  "grav-cms",
  "app",
  "hr",
  "dashboard",
  "employees",
  "new-employee",
  "components",
  "EmployeeForm.js",
);

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); }
};

/* Section boundaries are found by the form's own `ed("<section>")` guards
   rather than hardcoded line numbers, so the harness survives the form being
   edited above them. */
const SECTION_ORDER = ["personal", "work", "salary", "documents", "address"];

function sectionRanges(src) {
  const lines = src.split("\n");
  const marks = [];
  lines.forEach((line, i) => {
    const m = /\{ed\("(personal|work|salary|documents|address)"\) \? \(/.exec(line);
    if (m) marks.push({ name: m[1], line: i });
  });
  const ranges = {};
  for (let i = 0; i < marks.length; i += 1) {
    // Only the FIRST occurrence of each section opens it; the rest are nested.
    if (ranges[marks[i].name]) continue;
    const next = marks.slice(i + 1).find((x) => !ranges[x.name] && x.name !== marks[i].name);
    ranges[marks[i].name] = [marks[i].line, next ? next.line : lines.length];
  }
  return { lines, ranges };
}

(async () => {
  console.log("");
  check("the employee form is where the registry expects it", fs.existsSync(FORM_PATH), FORM_PATH);
  if (!fs.existsSync(FORM_PATH)) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }

  const src = fs.readFileSync(FORM_PATH, "utf8");
  const { lines, ranges } = sectionRanges(src);
  const { BUILT_IN, listBuiltIn } = require("./services/builtInEmployeeFields");
  const { FORMS } = require("./services/formConfig");

  console.log("\nthe registry covers every form");
  for (const f of FORMS) {
    check(`${f.formKey} has built-in fields listed`, (BUILT_IN[f.formKey] || []).length > 0,
      `${(BUILT_IN[f.formKey] || []).length}`);
  }

  console.log("\nno field is listed twice, and none is nameless");
  for (const [formKey, defs] of Object.entries(BUILT_IN)) {
    const keys = defs.map((d) => d.key);
    check(`${formKey}: keys are unique`, new Set(keys).size === keys.length,
      keys.filter((k, i) => keys.indexOf(k) !== i).join(", "));
    check(`${formKey}: every field has a label and a type`,
      defs.every((d) => d.label && d.type));
  }

  console.log("\nthe registry has not drifted from the form");
  /* Identity fields render above the section guards, so the personal section
     is compared against its own range PLUS the head of the form. */
  const headStart = lines.findIndex((l) => /const ed = \(id\)/.test(l));
  let drift = 0;

  for (const name of SECTION_ORDER) {
    const range = ranges[name];
    if (!range) {
      check(`found the ${name} section in the form`, false);
      continue;
    }
    let chunk = lines.slice(range[0], range[1]).join("\n");
    if (name === "personal" && headStart >= 0) {
      chunk = lines.slice(headStart, range[0]).join("\n") + chunk;
    }

    const touched = new Set();
    for (const m of chunk.matchAll(/form\.([A-Za-z0-9_]+)/g)) touched.add(m[1]);
    for (const m of chunk.matchAll(/setField\("([A-Za-z0-9_]+)"/g)) touched.add(m[1]);
    /* Upload slots are not form state — they live in `files` and are named by
       the fileKey prop. Missing this made the harness call five real fields
       "disappeared from the form" when they were in front of it. */
    for (const m of chunk.matchAll(/fileKey="([A-Za-z0-9_]+)"/g)) touched.add(m[1]);

    const formKey = `hr:employee:${name}`;
    const listed = new Set();
    for (const d of BUILT_IN[formKey] || []) {
      listed.add(d.key);
      for (const c of d.composite || []) listed.add(c);
    }

    /* Keys the form touches that the registry never mentions. These are the
       real drift — a new field nobody added here. */
    const missing = [...touched].filter((k) => !listed.has(k)).sort();
    /* And the reverse: a key the registry claims that the form no longer has.
       Checked across the WHOLE form, because a field may legitimately move
       between sections without that being drift. */
    const anywhere = new Set();
    for (const m of src.matchAll(/form\.([A-Za-z0-9_]+)/g)) anywhere.add(m[1]);
    for (const m of src.matchAll(/fileKey="([A-Za-z0-9_]+)"/g)) anywhere.add(m[1]);
    const stale = [...listed].filter((k) => !anywhere.has(k)).sort();

    check(`${name}: every field the form uses is listed`, missing.length === 0,
      missing.join(", "));
    check(`${name}: nothing listed has disappeared from the form`, stale.length === 0,
      stale.join(", "));
    drift += missing.length + stale.length;
  }

  console.log("\nwhat the screen will render");
  let total = 0;
  for (const f of FORMS) {
    const rows = listBuiltIn(f.formKey);
    total += rows.length;
    const derived = rows.filter((r) => r.note === "calculated").length;
    const uiOnly = rows.filter((r) => r.note === "controls the form").length;
    console.log(
      `  ${f.label.padEnd(22)} ${String(rows.length).padStart(2)} fields` +
        (derived ? `, ${derived} calculated` : "") +
        (uiOnly ? `, ${uiOnly} form controls` : ""),
    );
    check(`${f.formKey}: every row is marked as coming from the app`,
      rows.every((r) => r.source === "app"));
  }
  check(`the screen stops reading "0/0" — ${total} fields across the five sections`, total > 50);

  console.log(`\n${pass} passed, ${fail} failed${drift ? ` (${drift} drifted keys)` : ""}\n`);
  process.exit(fail ? 1 : 0);
})();
