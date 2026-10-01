// models/CMS_Models/Marketing/MarketingIdentity.js
//
// ONE PERSON, SEVERAL SYSTEMS, ONE MAPPING ROW.
//
// The product plan is explicit (§10): the durable identity key is an opaque
// GRAV identifier, never an email address. An email address is a routing
// detail — people change jobs, addresses get reassigned, and a mapping keyed
// on one silently becomes a mapping to somebody else.
//
// So this row is the mapping, and the email is only ever a lookup hint stored
// beside it. `graveId` is the GRAV person identity; `externals[]` holds one
// entry per outside system that knows the same person.
//
// ── WHY EXTERNALS ARE A LIST AND NOT A COLUMN PER SYSTEM ───────────────────
// `mauticContactId` as a column works until the second provider arrives, and
// then the second provider is added as a second column by whoever is in a
// hurry. A list with a named system cannot be extended that way, and makes
// "which systems hold this person" a question the row answers by itself —
// which is the question a deletion request actually asks.
"use strict";

const mongoose = require("mongoose");

const externalSchema = new mongoose.Schema(
  {
    /* "mautic", a discovery provider's name, or any future system. Free text
       rather than an enum on purpose: an enum here would have to be edited in
       GRAV every time an integration is configured in deployment. */
    system: { type: String, trim: true, required: true },
    externalId: { type: String, trim: true, required: true },
    linkedAt: { type: Date, default: Date.now },
    /* Whether GRAV proved this link or inferred it. An inferred match is
       usable and is never presented as proven. */
    proven: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, default: null },
    lastSyncError: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const identitySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* The opaque GRAV key. Minted by Marketing for a person Marketing met
       first; it is NOT a Sales record id, because most people Marketing knows
       have no Sales record and the ones that do may acquire it later. */
    gravPersonKey: { type: String, trim: true, required: true },

    /* Lookup hints only. Never the identity. */
    email: { type: String, trim: true, lowercase: true, default: "", index: true },
    normalizedPhone: { type: String, trim: true, default: "" },
    companyDomain: { type: String, trim: true, lowercase: true, default: "" },

    externals: { type: [externalSchema], default: [] },

    /* Set once Sales holds a record for this person — a link, not a copy. */
    salesLeadId: { type: mongoose.Schema.Types.ObjectId, default: null },
    salesAccountId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: "marketing_identities" },
);

identitySchema.index({ companyId: 1, gravPersonKey: 1 }, { unique: true });
identitySchema.index({ companyId: 1, "externals.system": 1, "externals.externalId": 1 });

module.exports = mongoose.models.MarketingIdentity
  || mongoose.model("MarketingIdentity", identitySchema);
