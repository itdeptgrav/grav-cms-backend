// services/builtInEmployeeFields.js
//
// The employee form's BUILT-IN fields, transcribed from the form itself.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The Forms screen on the developer side listed only administrator-ADDED
// fields, so every section read "0/0" and looked broken — when in fact the
// employee form has 94 fields, all of them hand-written JSX in
// app/hr/dashboard/employees/new-employee/components/EmployeeForm.js. An
// administrator opening "Employee · Personal" wants to see the form they know:
// DOB, Blood Group, Father's Name, and then whatever has been added on top.
// This is that list.
//
// ── IT IS A DESCRIPTION, NOT A DEFINITION ───────────────────────────────────
// Nothing here changes how the employee form behaves. These fields are
// rendered, validated and stored by the form and the Employee model exactly as
// they were; this module only tells the Forms screen what already exists so it
// can show it, marked read-only, above the fields an administrator may add.
// Editing one of these means editing the form — which is why every row carries
// `source: "app"` and the screen says so rather than offering a switch that
// would not be honoured.
//
// ── HOW IT WAS BUILT, AND HOW TO KEEP IT TRUE ───────────────────────────────
// Transcribed by pairing each `label="…"` in the form with the state key it
// writes, then reconciling against every `form.<key>` the section touches so
// nothing was silently dropped. The fields that reconciliation surfaced as
// unlabelled are the derived ones (EPF, EDLI, admin charges, net salary), the
// three override flags beside them and the address's same-as-current toggle;
// they are included and marked, because an administrator asking "is EPF a
// field?" deserves "yes, and it is calculated" rather than silence.
//
// A field added to the employee form and not added here shows up nowhere on
// the Forms screen. verifyBuiltInFields.js reads the form and fails if the two
// have drifted, so that stays a caught mistake rather than a slow lie.

"use strict";

// ── HIDING A FIELD ──────────────────────────────────────────────────────────
// A built-in field can be hidden from the employee page (FormFieldOverride
// stores that choice; the form reads it and renders nothing for that key).
// Hidden means NOT SHOWN — values already saved are kept, exactly as removing
// an added field keeps its values. Nothing here deletes employee data.
//
// `locked` fields refuse to hide, and each says why. This is not caution for
// its own sake: the employee form refuses to save without an email, a
// confirmation date, a shift and — for a paid internship — a stipend. Hide one
// of those and you get a form that cannot be saved and does not show you the
// field that is blocking it. Others are locked because something downstream
// reads them: `biometricId` joins the Mongo and Firestore records, and
// `department`/`designation` decide both the manager list and which ledger
// payroll posts a salary to.

/**
 * `derived`  — computed by the form or the server; shown, never typed into.
 * `uiOnly`   — a control that shapes the form but is not stored on its own.
 * `composite`— one control that writes several stored keys.
 * `locked`   — may not be hidden; the string says why.
 * `internal` — stored, but has no control of its own to hide. Listed so the
 *              screen is a complete answer to "what is on this record", with
 *              no Remove button, because there is nothing for one to act on.
 */
const BUILT_IN = {
  "hr:employee:personal": [
    // Identity — rendered at the head of the Personal tab.
    { key: "title", label: "Title", type: "text" },
    { key: "firstName", label: "First Name", type: "text", required: true,
      locked: "It is the employee's name." },
    { key: "middleName", label: "Middle Name", type: "text" },
    { key: "lastName", label: "Last Name", type: "text", required: true,
      locked: "It is the employee's name." },
    { key: "nickName", label: "Nick Name", type: "text" },
    { key: "gender", label: "Gender", type: "dropdown" },
    { key: "email", label: "Employee Login (Email)", type: "email", required: true,
      locked: "It is how the employee signs in; the form refuses to save without it." },
    { key: "phone", label: "Mobile", type: "phone" },
    { key: "alternatePhone", label: "Alternate Phone", type: "phone" },
    { key: "workPhone", label: "Corporate / Job Phone", type: "phone" },

    // Personal proper.
    { key: "dateOfBirth", label: "DOB", type: "date" },
    { key: "bloodGroup", label: "Blood Group", type: "dropdown" },
    { key: "personalEmail", label: "Personal Email", type: "email" },
    { key: "maritalStatus", label: "Marital Status", type: "dropdown" },
    { key: "marriageDate", label: "Marriage Date", type: "date" },
    { key: "spouseName", label: "Spouse Name", type: "text" },
    {
      key: "fatherFirstName",
      label: "Father's Name",
      type: "text",
      composite: ["fatherMiddleName", "fatherLastName"],
    },
    { key: "fatherDOB", label: "Father's DOB", type: "date" },
    {
      key: "motherFirstName",
      label: "Mother's Name",
      type: "text",
      composite: ["motherMiddleName", "motherLastName"],
    },
    { key: "nationality", label: "Nationality", type: "text" },
    { key: "residentialStatus", label: "Residential Status", type: "text" },
    { key: "placeOfBirth", label: "Place Of Birth", type: "text" },
    { key: "countryOfOrigin", label: "Country Of Origin", type: "text" },
    { key: "religion", label: "Religion", type: "text" },
    { key: "isInternational", label: "International Employee", type: "boolean" },
    { key: "isPhysicallyChallenged", label: "Physically Challenged", type: "boolean" },
    { key: "isDirector", label: "Is Director", type: "boolean" },
  ],

  "hr:employee:work": [
    { key: "biometricId", label: "Biometric ID", type: "text",
      locked: "It joins this record to attendance and to the Cowork workspace." },
    { key: "identityId", label: "Identity ID", type: "text" },
    { key: "jobTitle", label: "Job Title", type: "text" },
    { key: "department", label: "Department", type: "dropdown", composite: ["departmentId"],
      locked: "It decides the manager list and which ledger payroll posts the salary to." },
    { key: "designation", label: "Designation", type: "dropdown",
      locked: "It decides which managers may be assigned to this employee." },
    { key: "workLocation", label: "Work Location", type: "text" },
    { key: "dateOfJoining", label: "Date of Joining", type: "date" },
    { key: "confirmationDate", label: "Confirmation Date", type: "date", required: true,
      locked: "The form refuses to save without it." },
    { key: "probationPeriod", label: "Probation (months)", type: "number" },
    { key: "employmentType", label: "Employment Type", type: "dropdown" },
    { key: "workShiftMode", label: "Shift", type: "dropdown",
      locked: "Attendance is judged against it; the form refuses to save without one." },
    { key: "workShiftStart", label: "Shift Starts", type: "text",
      locked: "A custom shift cannot be saved without it." },
    { key: "workShiftEnd", label: "Shift Ends", type: "text",
      locked: "A custom shift cannot be saved without it." },
    { key: "workShiftPunches", label: "Punches per day", type: "number" },
    { key: "needsToOperate", label: "Needs to Operate", type: "boolean" },
    /* Chosen from the department's configured managers, not searched over
       staff — see routes/HrRoutes/Departments.js manager-candidates. */
    { key: "primaryManager", label: "Primary Manager", type: "text" },
    { key: "secondaryManager", label: "Secondary Manager", type: "text" },
  ],

  "hr:employee:salary": [
    { key: "grossSalary", label: "Gross Salary (₹)", type: "number", required: true,
      locked: "Payroll is calculated from it." },
    { key: "basic", label: "Basic (₹)", type: "number" },
    { key: "hra", label: "HRA (₹)", type: "number" },
    { key: "foodAllowance", label: "Food Allowance (₹)", type: "number" },
    { key: "epf", label: "EPF (₹)", type: "number", derived: true },
    { key: "epfOverride", label: "EPF overridden", type: "boolean", uiOnly: true,
      internal: "It has no field of its own — it marks EPF as manually overridden." },
    { key: "edli", label: "EDLI (₹)", type: "number", derived: true },
    { key: "edliOverride", label: "EDLI overridden", type: "boolean", uiOnly: true,
      internal: "It has no field of its own — it marks EDLI as manually overridden." },
    { key: "adminCharges", label: "PF Admin Charges (₹)", type: "number", derived: true },
    { key: "adminOverride", label: "Admin charges overridden", type: "boolean", uiOnly: true,
      internal: "It has no field of its own — it marks PF Admin Charges as manually overridden." },
    { key: "eeesic", label: "ESIC — Employee (₹)", type: "number" },
    { key: "erEsic", label: "ESIC — Employer (₹)", type: "number" },
    { key: "otherDeduction", label: "Other Deduction — monthly (₹)", type: "number" },
    { key: "totalDeduction", label: "Total Deductions (₹)", type: "number", derived: true },
    { key: "netSalary", label: "Net Salary (₹)", type: "number", derived: true },
    { key: "employerCost", label: "CTC / Employer Cost (₹)", type: "number", derived: true },

    // Interns are paid a stipend rather than a salary.
    { key: "internStipendType", label: "Internship Arrangement", type: "dropdown",
      locked: "A paid internship with no stipend cannot be saved." },
    { key: "stipend", label: "Monthly Stipend (₹)", type: "number",
      locked: "A paid internship with no stipend cannot be saved." },
    { key: "internStart", label: "Internship Starts", type: "date" },
    { key: "internEnd", label: "Internship Ends", type: "date" },

    { key: "bankName", label: "Bank Name", type: "text" },
    { key: "accountType", label: "Account Type", type: "dropdown" },
    { key: "accountNumber", label: "Account Number", type: "text" },
    { key: "ifscCode", label: "IFSC Code", type: "text" },
    { key: "branchName", label: "Branch Name", type: "text" },
  ],

  "hr:employee:documents": [
    { key: "aadharNumber", label: "Aadhar Number", type: "text" },
    { key: "panNumber", label: "PAN Number", type: "text" },
    { key: "uanNumber", label: "UAN Number", type: "text" },
    { key: "pfNumber", label: "PF Number", type: "text" },
    { key: "esicNumber", label: "ESIC Number", type: "text" },
    { key: "passportNumber", label: "Passport Number", type: "text" },
    { key: "voterIdNumber", label: "Voter ID", type: "text" },
    { key: "drivingLicenseNumber", label: "Driving License", type: "text" },
    /* The upload slots. Each is its own field on the form — folding them into
       one "Uploaded Documents" row would have offered a single switch that
       hid five unrelated things. */
    { key: "aadharFile", label: "Aadhar File", type: "file" },
    { key: "panFile", label: "PAN File", type: "file" },
    { key: "resumeFile", label: "Resume / CV", type: "file" },
    { key: "offerLetter", label: "Offer Letter", type: "file" },
    { key: "appointmentLetter", label: "Appointment Letter", type: "file" },
    { key: "additionalDocs", label: "Additional Documents", type: "file" },
  ],

  "hr:employee:address": [
    { key: "currentStreet", label: "Current — Street", type: "text" },
    { key: "currentCity", label: "Current — City", type: "text" },
    { key: "currentState", label: "Current — State", type: "text" },
    { key: "currentPincode", label: "Current — Pincode", type: "text" },
    { key: "currentCountry", label: "Current — Country", type: "text" },
    { key: "sameAsCurrent", label: "Permanent same as current", type: "boolean", uiOnly: true },
    { key: "permanentStreet", label: "Permanent — Street", type: "text" },
    { key: "permanentCity", label: "Permanent — City", type: "text" },
    { key: "permanentState", label: "Permanent — State", type: "text" },
    { key: "permanentPincode", label: "Permanent — Pincode", type: "text" },
    { key: "permanentCountry", label: "Permanent — Country", type: "text" },
  ],
};

/** Every built-in field of one form, in the order the form renders them. */
function listBuiltIn(formKey) {
  return (BUILT_IN[formKey] || []).map((f, i) => ({
    ...f,
    source: "app",
    order: i,
    /* Named so the screen can explain itself without a lookup table: an
       administrator reading "calculated" understands why there is no switch. */
    note: f.derived
      ? "calculated"
      : f.uiOnly
        ? "controls the form"
        : f.composite
          ? `also fills ${f.composite.join(", ")}`
          : "",
  }));
}

function countBuiltIn(formKey) {
  return (BUILT_IN[formKey] || []).length;
}

/** One field's definition, or null. Used to refuse hiding a locked field. */
function findBuiltIn(formKey, key) {
  return (BUILT_IN[formKey] || []).find((f) => f.key === key) || null;
}

const FormFieldOverride = require("../models/DevOps/FormFieldOverride");

/* Cached for the same reason and the same 30s as the definitions beside them:
   the employee form asks for this on every load, and it changes rarely. */
const CACHE_TTL_MS = 30 * 1000;
let _hidden = null; // Map(formKey -> Set(key))
let _cachedAt = 0;

async function loadHidden() {
  const rows = await FormFieldOverride.find({ hidden: true }).lean();
  _hidden = new Map();
  for (const r of rows) {
    if (!_hidden.has(r.formKey)) _hidden.set(r.formKey, new Set());
    _hidden.get(r.formKey).add(r.key);
  }
  _cachedAt = Date.now();
}

function invalidateOverrides() {
  _hidden = null;
  _cachedAt = 0;
}

/** The keys hidden on one form. */
async function hiddenFor(formKey) {
  if (!_hidden || Date.now() - _cachedAt > CACHE_TTL_MS) await loadHidden();
  return _hidden.get(formKey) || new Set();
}

/**
 * Every hidden key across every form, flat — what the employee form needs, in
 * the shape it needs it. Composite keys are expanded, so hiding "Department"
 * also hides the departmentId it writes rather than leaving a half-field.
 */
async function allHiddenKeys() {
  if (!_hidden || Date.now() - _cachedAt > CACHE_TTL_MS) await loadHidden();
  const out = new Set();
  for (const [formKey, keys] of _hidden) {
    for (const key of keys) {
      out.add(key);
      const def = findBuiltIn(formKey, key);
      for (const c of def?.composite || []) out.add(c);
    }
  }
  return [...out];
}

/** The built-in list with each row's hidden state merged in, for the admin UI. */
async function listBuiltInWithState(formKey) {
  const hidden = await hiddenFor(formKey);
  return listBuiltIn(formKey).map((f) => ({
    ...f,
    hidden: hidden.has(f.key),
    /* `locked` is a sentence, not a boolean, so the screen can say WHY rather
       than showing a disabled button with no explanation. An internal flag
       reads the same way to the screen — no Remove button, and a reason —
       though for a different underlying cause. */
    locked: f.locked || f.internal || "",
  }));
}

module.exports = {
  BUILT_IN,
  listBuiltIn,
  listBuiltInWithState,
  countBuiltIn,
  findBuiltIn,
  hiddenFor,
  allHiddenKeys,
  invalidateOverrides,
};
