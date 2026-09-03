// models/DevOps/FormFieldDef.js
//
// One administrator-defined field on one form.
//
// The Employee model has carried five per-section custom-field arrays
// (personalCustomFields, workCustomFields, …) since long before this file —
// storage that nothing wrote and nothing rendered. This model is the missing
// half: WHAT fields exist, so the server can validate what arrives, fill in
// defaults, and the UI can render an editor from configuration instead of a
// deploy.
//
// DEFINITIONS ARE CONFIG, VALUES ARE DATA. A definition here never contains a
// value from any record, and deleting a definition never touches stored
// values — records keep what they carried; it simply stops being asked for,
// validated, or shown. That asymmetry is deliberate: form configuration must
// never be able to destroy employee data.
//
// `key` is immutable once created (enforced in the route): values are stored
// under it, and renaming a key would orphan every value written so far.

"use strict";

const mongoose = require("mongoose");

/** The complete set of types the renderer and validator understand. */
const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "date",
  "boolean",
  "dropdown",
  "multiselect",
  "email",
  "phone",
  "file", // a URL/reference to an uploaded file — never file content
];

/**
 * Validation patterns are CHOSEN, never typed. A free-text regex from an admin
 * screen is a ReDoS and an injection surface; a fixed vocabulary is neither.
 */
const PATTERNS = {
  none: null,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^[+\d][\d\s\-()]{5,19}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  pincode: /^\d{6}$/,
};

const formFieldDefSchema = new mongoose.Schema(
  {
    // Which form (and section) this belongs to: "hr:employee:personal",
    // "hr:employee:work", … — the registry of valid keys lives in
    // services/formConfig.js beside the storage mapping.
    formKey: { type: String, required: true, index: true, lowercase: true, trim: true },

    // The storage key values are written under. Immutable after creation.
    key: { type: String, required: true, trim: true },

    label: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },

    type: { type: String, enum: FIELD_TYPES, default: "text" },

    required: { type: Boolean, default: false },
    // Disabled = kept but dormant: not rendered, not validated, defaults not
    // filled. The definition (and every stored value) survives.
    enabled: { type: Boolean, default: true },

    order: { type: Number, default: 0 },

    // dropdown / multiselect choices.
    options: { type: [String], default: [] },

    // number bounds; string length bounds.
    min: { type: Number },
    max: { type: Number },

    // A key of PATTERNS — never a raw regex.
    pattern: { type: String, enum: Object.keys(PATTERNS), default: "none" },

    defaultValue: { type: String, default: "" },

    createdByEmail: { type: String, default: "", lowercase: true },
    updatedByEmail: { type: String, default: "", lowercase: true },
  },
  { timestamps: true, collection: "form_field_defs" },
);

formFieldDefSchema.index({ formKey: 1, key: 1 }, { unique: true });
formFieldDefSchema.index({ formKey: 1, order: 1 });

module.exports =
  mongoose.models.FormFieldDef ||
  mongoose.model("FormFieldDef", formFieldDefSchema, "form_field_defs");

module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.PATTERNS = PATTERNS;
