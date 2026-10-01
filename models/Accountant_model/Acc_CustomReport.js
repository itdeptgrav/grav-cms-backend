// models/Accountant_model/Acc_CustomReport.js
//
// A SAVED CUSTOM REPORT — the specification, and nothing else.
//
// ── WHAT IS NOT IN HERE, DELIBERATELY ───────────────────────────────────────
// No SQL. No MBQL. No Metabase database, table, field, question or collection
// id. No cached result set. A saved report is a set of SAFE IDENTIFIERS this
// server issued in its own catalogue, and it is re-validated against the
// CURRENT catalogue every time it is opened or run.
//
// That last part is the point of storing so little. A report saved in March
// under one set of permissions may be opened in September under another; a
// field may have been withdrawn from the catalogue; the company may have moved
// to a different organisation. If the stored form carried a compiled query,
// none of those changes would reach it and the report would keep answering with
// data its owner is no longer entitled to. Storing identifiers means every run
// goes back through the same gate a fresh request does.
//
// ── ISOLATION ───────────────────────────────────────────────────────────────
// `organizationId` and `companyId` are both stored and both filtered on for
// every read. The organisation is the tenant boundary; the company is checked
// again by the scope guard on the way through, so a company that moves between
// organisations immediately stops being readable through its old reports —
// there is no copy of the old ownership here to disagree with
// `Acc_Organization.tallyCompanyIds`.

"use strict";

const mongoose = require("mongoose");

const customReportSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Organization",
      required: true,
      index: true,
    },
    /**
     * The companies this report covers.
     *
     * An ARRAY, because the PivotTable layout may compare companies side by
     * side. Every id is re-checked against the organisation's current
     * `tallyCompanyIds` on every read — the stored list says what the report is
     * ABOUT, never what the caller may see.
     */
    companyIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company" },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_User",
      required: true,
    },
    /* Denormalised so a list does not need a second lookup per row, and so the
       audit trail survives the user being deleted. */
    createdByName: { type: String, trim: true, default: "" },

    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * The layout's schema version.
     *
     * Version 1 was the old template/subject contract: `{ subject, columns[],
     * … }`. Version 2 is the blank PivotTable: `{ rows, columns, values,
     * filters, comparisons, sort, totals }`. They are not the same shape and
     * one is not a rename of the other — a v1 report has no Values shelf at
     * all, so there is no mapping from it that is unambiguously right.
     *
     * A v1 document is therefore NOT reinterpreted. It is returned marked
     * `needsRecreation`, and the builder asks the user to rebuild it. Guessing
     * would produce a report that looks like theirs and totals something else.
     */
    schemaVersion: { type: Number, required: true, default: 2, index: true },

    /** A one-line description for the saved list. "Ledger Group by Month". */
    layoutSummary: { type: String, trim: true, default: "" },

    /**
     * The safe layout.
     *
     * `Mixed`, because its shape is owned by
     * `services/reporting/reportLayout.validate.js` and enforced there against
     * the live catalogue — a stronger check than a Mongoose schema could make,
     * since the legal field ids change as the catalogue does. What is written
     * here is always the REBUILT object from `toStoredLayout`, never the
     * caller's, so an unknown key cannot arrive by this route.
     */
    layout: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      default: () => ({}),
    },

    /**
     * How the user last asked for this report to be DRAWN.
     *
     * Only the approved settings — a chart type from the list the result
     * supports, a title, a legend, axis labels, a named palette — as
     * `vizSettings.validate.js` rebuilt them. Never Metabase's own settings
     * object and never anything the browser sent verbatim.
     *
     * NOTE what is deliberately NOT here: the Metabase question. That pointer
     * lives in `Acc_ReportChart`, because this document is serialised to a
     * browser and a field on it is one careless spread away from being in a
     * response.
     */
    visualization: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    /** The v1 specification, kept verbatim on migrated documents so nothing is
     *  lost while the user rebuilds. Never executed. */
    legacySpecification: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    /**
     * THE v1 FIELD, DECLARED SO IT SURVIVES BEING READ.
     *
     * Version 1 stored the report under `specification` beside a `subject`.
     * Neither is written any more — but Mongoose silently DROPS a path that is
     * not in the schema when it reads a document, so leaving them out would
     * have quietly discarded the only copy of an old report the moment a user
     * opened it, which is the opposite of "do not reinterpret, keep it for
     * recreation". They are declared, never written, and never executed.
     */
    specification: { type: mongoose.Schema.Types.Mixed, default: undefined },
    subject: { type: String, default: undefined },
  },
  { timestamps: true, collection: "acc_custom_reports" },
);

/* The listing query: every report of one organisation, newest first, optionally
   narrowed to a company. Compound and in this order because the organisation is
   the tenant boundary and is ALWAYS part of the filter — a prefix that starts
   with anything else would let a company-only query be planned, which is the
   query that must never run. */
customReportSchema.index({ organizationId: 1, companyIds: 1, updatedAt: -1 });

/* Names are unique per company so a list is not three rows called "Untitled".
   Case-insensitive, because "Sales" and "sales" are the same report to a
   person. */
/* A name is unique per organisation, not per company: a report may now cover
   several companies, so "which company's list is it in" no longer has one
   answer. Case-insensitive, because "Sales" and "sales" are the same report to
   a person. */
customReportSchema.index(
  { organizationId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);

const Acc_CustomReport =
  mongoose.models.Acc_CustomReport ||
  mongoose.model("Acc_CustomReport", customReportSchema);

module.exports = { Acc_CustomReport, customReportSchema };
