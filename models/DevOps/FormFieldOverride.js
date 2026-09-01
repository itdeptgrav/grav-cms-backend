// models/DevOps/FormFieldOverride.js
//
// An administrator's decision about a field the APP defines.
//
// FormFieldDef holds fields an administrator ADDED — it owns them completely,
// so hiding one is just a flag on the definition. The employee form's own ~90
// fields are different: they are code, and no row in a database can delete
// them. What an administrator can decide is whether the form still ASKS for
// one. That decision is this collection.
//
// ── ABSENT MEANS SHOWN ──────────────────────────────────────────────────────
// A field with no row here renders exactly as it always has. That is what
// makes this safe to add to a running system: the collection starts empty and
// nothing changes until somebody hides something. It also means "show it
// again" is a delete, not a second flag.
//
// ── HIDDEN IS NOT DELETED ───────────────────────────────────────────────────
// Hiding stops the form asking for a field. It does not touch a single
// employee record, and every value already saved under that key stays exactly
// where it is — so hiding "Nick Name" and changing your mind a month later
// brings the nicknames back, not a column of blanks. This mirrors how removing
// an ADDED field already behaves, and for the same reason: form configuration
// must never be able to destroy employee data.
//
// ── WHAT CANNOT BE HIDDEN ───────────────────────────────────────────────────
// `locked` fields are refused at the route, not merely hidden in the UI, so a
// hand-made request cannot hide the login field and leave every future
// employee unable to sign in. The reasons live beside the fields in
// services/builtInEmployeeFields.js.

"use strict";

const mongoose = require("mongoose");

const formFieldOverrideSchema = new mongoose.Schema(
  {
    // "hr:employee:personal" — the same keys services/formConfig.js registers.
    formKey: { type: String, required: true, lowercase: true, trim: true },

    // The built-in field's key, e.g. "nickName".
    key: { type: String, required: true, trim: true },

    hidden: { type: Boolean, default: true },

    /* Why, in the administrator's words. Asked for at the point of hiding
       because "who hid the Blood Group field and why" is the question someone
       always asks three months later, and the audit entry alone answers only
       half of it. */
    reason: { type: String, default: "", trim: true },

    hiddenByEmail: { type: String, default: "", lowercase: true },
    hiddenByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "form_field_overrides" },
);

/* One decision per field. The upsert in the route relies on this. */
formFieldOverrideSchema.index({ formKey: 1, key: 1 }, { unique: true });

module.exports =
  mongoose.models.FormFieldOverride ||
  mongoose.model("FormFieldOverride", formFieldOverrideSchema, "form_field_overrides");
