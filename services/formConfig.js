// services/formConfig.js
//
// The bridge between form DEFINITIONS (FormFieldDef, set on the developer
// side) and form VALUES (the Employee model's five *CustomFields arrays).
//
//   validateAndNormalise("hr:employee:personal", submittedArray, { isCreate })
//     → { values, errors }
//
// WHAT NORMALISATION PROMISES
//   - Unknown keys are DROPPED, not stored: a request cannot invent fields the
//     configuration never defined, so the arrays cannot become a dumping
//     ground for arbitrary payloads.
//   - Labels and fieldTypes are FORCED from the definition, never taken from
//     the request — the stored label is what the admin configured, not what a
//     client claimed.
//   - Values are strings in storage (the existing customFieldSchema's shape);
//     typed validation happens here, before storage.
//   - Required-but-missing is an error ON CREATE; on update only fields the
//     request carries are judged, matching how the rest of the API treats
//     partial bodies.
//   - Enabled fields absent from a CREATE get their configured default, so a
//     newly configured field materialises on new records without any client
//     change.
//
// Cached 30s like devConfig, and for the same reason: this runs inside every
// employee create/update, and the definitions change rarely.

"use strict";

const FormFieldDef = require("../models/DevOps/FormFieldDef");
const { PATTERNS } = FormFieldDef;

/**
 * The registry of forms this system manages, and where each one's values
 * live. Adding a form is one row — the admin UI, validation and rendering all
 * read this. The storage path names a field on the Employee document today;
 * a future form on another model adds a `model` hint here.
 */
const FORMS = [
  { formKey: "hr:employee:personal", label: "Employee · Personal", storagePath: "personalCustomFields" },
  { formKey: "hr:employee:work", label: "Employee · Work", storagePath: "workCustomFields" },
  { formKey: "hr:employee:salary", label: "Employee · Salary", storagePath: "salaryCustomFields" },
  { formKey: "hr:employee:documents", label: "Employee · Documents", storagePath: "documentCustomFields" },
  { formKey: "hr:employee:address", label: "Employee · Address", storagePath: "addressCustomFields" },
];
const FORM_KEYS = new Set(FORMS.map((f) => f.formKey));

const CACHE_TTL_MS = 30 * 1000;
let _cache = null; // Map(formKey -> defs[])
let _cachedAt = 0;

async function loadAll() {
  const rows = await FormFieldDef.find({}).sort({ order: 1, createdAt: 1 }).lean();
  _cache = new Map();
  for (const r of rows) {
    if (!_cache.has(r.formKey)) _cache.set(r.formKey, []);
    _cache.get(r.formKey).push(r);
  }
  _cachedAt = Date.now();
}

function invalidate() {
  _cache = null;
  _cachedAt = 0;
}

/** Every definition for one form, enabled and disabled alike (the admin UI needs both). */
async function listDefs(formKey) {
  if (!FORM_KEYS.has(formKey)) throw new Error(`Unknown form "${formKey}"`);
  if (!_cache || Date.now() - _cachedAt > CACHE_TTL_MS) await loadAll();
  return _cache.get(formKey) || [];
}

/** One field's submitted value checked against its definition. Returns an error string or null. */
function checkValue(def, raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return def.required ? `${def.label} is required.` : null;

  switch (def.type) {
    case "number": {
      const n = Number(s);
      if (!Number.isFinite(n)) return `${def.label} must be a number.`;
      if (def.min !== undefined && def.min !== null && n < def.min) return `${def.label} must be at least ${def.min}.`;
      if (def.max !== undefined && def.max !== null && n > def.max) return `${def.label} must be at most ${def.max}.`;
      return null;
    }
    case "date":
      if (Number.isNaN(new Date(s).getTime())) return `${def.label} must be a date.`;
      return null;
    case "boolean":
      if (!["true", "false", "yes", "no", "1", "0"].includes(s.toLowerCase())) {
        return `${def.label} must be yes or no.`;
      }
      return null;
    case "dropdown":
      if (def.options?.length && !def.options.includes(s)) {
        return `${def.label} must be one of: ${def.options.join(", ")}.`;
      }
      return null;
    case "multiselect": {
      const picked = s.split(",").map((x) => x.trim()).filter(Boolean);
      if (def.options?.length && picked.some((p) => !def.options.includes(p))) {
        return `${def.label} may only contain: ${def.options.join(", ")}.`;
      }
      return null;
    }
    case "email":
      return PATTERNS.email.test(s) ? null : `${def.label} must be an email address.`;
    case "phone":
      return PATTERNS.phone.test(s) ? null : `${def.label} must be a phone number.`;
    default: {
      // text / longtext / file — length bounds and the chosen pattern.
      if (def.min !== undefined && def.min !== null && s.length < def.min) {
        return `${def.label} must be at least ${def.min} characters.`;
      }
      if (def.max !== undefined && def.max !== null && s.length > def.max) {
        return `${def.label} must be at most ${def.max} characters.`;
      }
      const rx = PATTERNS[def.pattern || "none"];
      if (rx && !rx.test(s)) return `${def.label} is not in the expected format.`;
      return null;
    }
  }
}

/** The storage fieldType the legacy customFieldSchema understands. */
function storageType(type) {
  if (type === "number") return "number";
  if (type === "date") return "date";
  if (type === "boolean") return "boolean";
  if (type === "dropdown" || type === "multiselect") return "select";
  return "text";
}

/**
 * Validate one section's submitted values against its definitions.
 *
 * @param {string} formKey
 * @param {Array}  submitted  [{key, value}] — labels/types in the request are ignored
 * @param {object} [opts]
 * @param {boolean} [opts.isCreate]  required + defaults apply
 * @returns {{values: Array, errors: string[]}}  values in the stored shape
 */
async function validateAndNormalise(formKey, submitted, { isCreate = false } = {}) {
  const defs = (await listDefs(formKey)).filter((d) => d.enabled);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const sent = new Map(
    (Array.isArray(submitted) ? submitted : [])
      .filter((f) => f && typeof f.key === "string")
      .map((f) => [f.key, f.value]),
  );

  const errors = [];
  const values = [];

  for (const def of defs) {
    const has = sent.has(def.key);
    let raw = has ? sent.get(def.key) : undefined;

    if (!has) {
      if (!isCreate) continue; // partial update: absent means untouched
      raw = def.defaultValue || "";
      if (def.required && String(raw).trim() === "") {
        errors.push(`${def.label} is required.`);
        continue;
      }
      if (String(raw).trim() === "") continue; // optional, no default — nothing to store
    }

    const problem = checkValue(def, raw);
    if (problem) {
      errors.push(problem);
      continue;
    }
    if (String(raw ?? "").trim() === "") continue; // cleared an optional field

    values.push({
      key: def.key,
      label: def.label, // forced from the definition — see the header
      value: String(raw).trim(),
      fieldType: storageType(def.type),
    });
  }

  // Unknown keys: dropped silently by construction (only defs are walked).
  return { values, errors };
}

/**
 * Run every employee section present on a request body through validation,
 * REPLACING each submitted array with its normalised form. One call from the
 * employee routes covers all five sections.
 *
 * @returns {string[]} every validation error across the sections
 */
async function applyEmployeeFormConfig(body, { isCreate = false } = {}) {
  const errors = [];
  for (const form of FORMS) {
    const submitted = body[form.storagePath];
    // On update, an absent array means "not touching custom fields" — leave it
    // absent so the route's partial-update semantics hold. On create, run even
    // when absent so enabled defaults materialise.
    if (submitted === undefined && !isCreate) continue;
    const { values, errors: errs } = await validateAndNormalise(form.formKey, submitted || [], { isCreate });
    if (errs.length) errors.push(...errs);
    else if (submitted !== undefined || values.length) body[form.storagePath] = values;
  }
  return errors;
}

module.exports = {
  FORMS,
  FORM_KEYS,
  listDefs,
  validateAndNormalise,
  applyEmployeeFormConfig,
  invalidate,
};
