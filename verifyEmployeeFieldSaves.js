// verifyEmployeeFieldSaves.js
//
// An employee field that was saved is still there after a refresh.
//
// Run:  node verifyEmployeeFieldSaves.js      (no database, no network, no writes)
//
// WHY THIS EXISTS
// HR reported two things about the employee form, and they were one bug:
// a field edited and saved was gone after a refresh, and a field overwritten
// came back as it had been. Both are `$set` on a NESTED OBJECT.
//
// `PUT /api/employees/:id` passed its payload straight to findByIdAndUpdate,
// which treats each top-level key as `$set`. `$set: { documents: {…} }`
// REPLACES the whole sub-document, so a Documents-section save — which always
// carries the identity numbers, carries the file objects only when a fresh
// upload is in browser state, and never carries additionalDocuments — erased
// whatever it did not resend. `address` replaced the same way could drop
// `address.permanent.state`, which is what the 7/10-day monthly leave cap is
// judged on, so the blast radius reached pay.
//
// `PATCH /api/employees/bulk-update`, three hundred lines below, had always
// flattened to dot paths and carried the only copy of the helper, with the
// comment this harness is named after. One route doing it right and its
// neighbour doing it wrong is the state that produced the bug.
//
// It also pins the biometric ID being EDITABLE (asked for, 10 Oct 2026) while
// still reporting what a rename leaves behind.

"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { flattenToPaths } = require("./services/mongoPaths");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};
const head = (t) => console.log(`\n${t}`);

const ROUTE = path.join(__dirname, "routes", "HrRoutes", "Employee-Section.js");
const src = fs.readFileSync(ROUTE, "utf8");

// ── 1. the write merges ─────────────────────────────────────────────────────
head("the single update writes dot paths, not nested objects");
check(
  "the PUT builds its $set with flattenToPaths",
  /findByIdAndUpdate\(\s*id,\s*\{\s*\$set:\s*flattenToPaths\(updateData\)\s*\}/.test(src),
);
check(
  "and no longer hands findByIdAndUpdate the raw payload",
  !/findByIdAndUpdate\(id,\s*updateData\s*,/.test(src),
  "the nested-object write is back",
);
check(
  "there is ONE flatten implementation, shared with the bulk route",
  (src.match(/const flatten = \(obj/g) || []).length === 0 &&
    (src.match(/flattenToPaths\(/g) || []).length >= 2,
);

// ── 2. what that buys, on the form's real payloads ──────────────────────────
head("a section save cannot erase the keys it did not send");
const docsSave = flattenToPaths({ documents: { aadharNumber: "A1", panNumber: "P1" } });
check(
  "a Documents save addresses only the numbers it carries",
  !("documents" in docsSave) &&
    docsSave["documents.aadharNumber"] === "A1" &&
    Object.keys(docsSave).every((k) => k.startsWith("documents.")),
  JSON.stringify(docsSave),
);
check(
  "so the uploaded files and additionalDocuments are not in the write at all",
  !Object.keys(docsSave).some((k) =>
    /aadharFile|panFile|resumeFile|offerLetterFile|appointmentLetterFile|additionalDocuments/.test(k),
  ),
);
const addrSave = flattenToPaths({ address: { current: { city: "Bhubaneswar" } } });
check(
  "an address edit leaves address.permanent.state — the leave cap — alone",
  !Object.keys(addrSave).some((k) => k.startsWith("address.permanent")),
  JSON.stringify(addrSave),
);
check(
  "an all-undefined sub-object is not read as 'empty it'",
  Object.keys(flattenToPaths({ bankDetails: {} })).length === 0,
);
check(
  "an array is replaced whole, never flattened to indexes",
  Array.isArray(flattenToPaths({ fieldsNotAvailable: ["a"] }).fieldsNotAvailable),
);
check(
  "a Date and an ObjectId are written whole",
  flattenToPaths({ updatedAt: new Date() }).updatedAt instanceof Date &&
    flattenToPaths({ departmentId: new mongoose.Types.ObjectId() }).departmentId
      instanceof mongoose.Types.ObjectId,
);

// ── 3. the one sub-object that MEANT replace ────────────────────────────────
head("merging does not change what a non-custom shift means");
check(
  "the shift times are cleared by name when the mode is not custom",
  /updateData\.workShift\?\.mode && updateData\.workShift\.mode !== "custom"/.test(src) &&
    /updateData\.workShift\.start = ""/.test(src),
  "a stored custom start/end would survive a switch to General",
);

// ── 4. the biometric ID ────────────────────────────────────────────────────
head("the biometric ID is editable, and a rename is reported");
check(
  "the write-once refusal is gone",
  !/code:\s*"BIOMETRIC_ID_IMMUTABLE"/.test(src),
);
check(
  "a changed value is normalised and kept",
  /updateData\.biometricId = next;/.test(src),
);
check(
  "an unchanged value is still dropped, so an ordinary save is not a rename",
  /delete updateData\.biometricId;/.test(src),
);
check(
  "the response says a rename happened",
  /biometricIdRenamed \? \{ biometricIdRenamed \}/.test(src),
);

const FORM = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "employees", "new-employee", "components", "EmployeeForm.js",
);
if (!fs.existsSync(FORM)) {
  check("the employee form is where this expects it", false, FORM);
} else {
  const form = fs.readFileSync(FORM, "utf8");
  check(
    "the form's Biometric ID input is not disabled",
    !/disabled=\{lockedBiometricId\}/.test(form),
  );
  check(
    "and it says what changing it leaves behind",
    /those rows stay under the old ID until they are migrated/.test(form),
  );
}

// ── 5. a section must not demand a capability its fields do not need ───────
//
// The form saves one section at a time and sends that section's keys. The
// server classifies the PAYLOAD, not the intent, and refuses a mixed payload
// WHOLE (Middlewear/hrContract.js) — so one stray key in a section list takes
// the whole section down for anybody who lacks that key's capability.
//
// That is what `bankDetails` did in the `work` list: the bank inputs are
// rendered in the Salary section, but Work posted the object anyway, so every
// Work save demanded `compensation.write` — owner-only — and an HR editor or
// approver editing a department or a job title was answered 403 and wrote
// nothing. On screen, that is the edit reverting.
head("no section asks for a capability its own fields do not need");
if (!fs.existsSync(FORM)) {
  check("the employee form is where this expects it", false, FORM);
} else {
  const form = fs.readFileSync(FORM, "utf8");
  const start = form.indexOf("const SECTION_KEYS = {");
  check("SECTION_KEYS was found in the form", start !== -1);
  if (start !== -1) {
    let depth = 0, i = form.indexOf("{", start), end = -1;
    for (; i < form.length; i += 1) {
      if (form[i] === "{") depth += 1;
      else if (form[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const block = form.slice(start, end);
    const { classifyEmployeeWrite } = require("./services/access/hrWritePolicy");

    /* Each `name: [ … ]` entry, with its quoted keys. */
    const sections = {};
    for (const m of block.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
      sections[m[1]] = [...m[2].matchAll(/"([\w.]+)"/g)].map((x) => x[1]);
    }
    check("every section was parsed", Object.keys(sections).length >= 6,
      Object.keys(sections).join(", "));

    /* Compensation is the owner-only one, so it is the one that silently
       disables a whole section. Only the Salary section may ask for it. */
    const offenders = [];
    for (const [name, keys] of Object.entries(sections)) {
      const payload = {};
      for (const k of keys) payload[k] = k === "documents" ? { aadharNumber: "A" } : "x";
      const verdict = classifyEmployeeWrite(payload);
      if (verdict.capabilities.includes("compensation.write") && name !== "salary") {
        offenders.push(`${name} → ${(verdict.byCapability["compensation.write"] || []).join(", ")}`);
      }
      if (verdict.forbidden.length) {
        offenders.push(`${name} sends a forbidden field: ${verdict.forbidden.join(", ")}`);
      }
    }
    check(
      "only the Salary section needs compensation.write, and none sends a forbidden field",
      offenders.length === 0,
      offenders.join("; "),
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
