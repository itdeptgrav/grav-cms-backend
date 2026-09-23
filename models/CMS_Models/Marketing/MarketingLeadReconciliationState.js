// models/CMS_Models/Marketing/MarketingLeadReconciliationState.js
//
// HOW FAR BACK GRAV HAS CHECKED GOOGLE FOR ENQUIRIES IT MAY HAVE MISSED.
//
// One row per company per delivery binding. It says where the last check got
// to, when it ran, and — the part a screen must never hide — whether there was
// a stretch of time longer than Google keeps leads during which nobody checked.
//
// ── THE CURSOR IS (TIME, ID), NEVER A PAGE TOKEN ───────────────────────────
// Google's page tokens belong to one query and one run, and nothing Google
// publishes says one survives until the next run, so none is stored. The
// cursor is the last submission processed, saved after every page: a run that
// dies re-reads at most that page, and deduplication recognises every row it
// already holds.
//
// ── NOTHING FROM A PERSON, NOTHING FROM A PROVIDER, IN PUBLIC ──────────────
// The cursor's id and any saved page token are Google's, stored `select:false`
// and never published. `publicView` is built field by field.
"use strict";

const mongoose = require("mongoose");
const P = require("../../../constants/marketingLeadProcessing");

const RUN_STATUSES = ["never", "ok", "partial", "failed", "unavailable"];
const ATTENTION_REASON_CODES = P.ATTENTION_REASONS.map((r) => r.code);

const counts = () => ({
  read: { type: Number, default: 0, min: 0 },
  recorded: { type: Number, default: 0, min: 0 },
  alreadyHeld: { type: Number, default: 0, min: 0 },
  heldForReview: { type: Number, default: 0, min: 0 },
  unreadable: { type: Number, default: 0, min: 0 },
});

const stateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    bindingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    channel: { type: String, required: true, trim: true, default: "google_ads" },

    /* ── THE CURSOR ──────────────────────────────────────────────────────
       The latest (submission time, provider id) durably recorded. The id is
       Google's and stays backend-only. */
    cursorAt: { type: Date, default: null },
    cursorId: { type: String, trim: true, default: "", select: false },

    /* ── HOW FAR GRAV IS SURE ────────────────────────────────────────────
       The start of the last run that read every page. Distinct from the
       cursor: a campaign with no enquiries for a month has an old cursor and
       is still fully covered, and treating the cursor as coverage would
       report a gap that is not there. */
    coveredUntil: { type: Date, default: null },

    lastRunAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastStatus: { type: String, enum: RUN_STATUSES, default: "never" },
    /* The window the last run asked Google about, as calendar dates. */
    windowFromDate: { type: String, trim: true, default: "" },
    windowToDate: { type: String, trim: true, default: "" },

    /* ── THE GAP GOOGLE'S RETENTION LEAVES ───────────────────────────────
       Set when a run found that the previous check (or the binding's own
       start) was further back than Google keeps leads. Any enquiry from
       before `gapUntil` that was never delivered is gone, and saying
       otherwise would be a claim no sweep can keep. */
    gapFrom: { type: Date, default: null },
    gapUntil: { type: Date, default: null },
    gapDetectedAt: { type: Date, default: null },

    /* ── WHY SOMEBODY SHOULD LOOK, IN GRAV'S WORDS ────────────────────────
       A closed code. Never the provider's message, which can name accounts. */
    attentionReason: { type: String, enum: [...ATTENTION_REASON_CODES, ""], default: "" },

    lastRun: { type: counts(), default: () => ({}) },
    totals: { type: counts(), default: () => ({}) },

    /* One run at a time per binding. */
    leaseUntil: { type: Date, default: null },
  },
  { timestamps: true, collection: "marketing_lead_reconciliation_states", strict: "throw" },
);

stateSchema.index({ companyId: 1, bindingId: 1 }, { unique: true });

/* What a screen may show. Never the cursor id, the page token, the binding's
   database id or a count of calls to Google. */
stateSchema.methods.publicView = function publicView({ now = new Date() } = {}) {
  return {
    state: coverageStateOf(this, now),
    checkedThrough: this.coveredUntil || null,
    lastCheckedAt: this.lastSuccessAt || null,
    checkedBackTo: this.windowFromDate || null,
    unrecoverableBefore: this.gapUntil || null,
    recoveredEnquiries: Number(this.totals?.recorded || 0),
    duplicatesIgnored: Number(this.totals?.alreadyHeld || 0),
    attentionReason: this.attentionReason || null,
  };
};

function coverageStateOf(doc, now = new Date()) {
  const t = now.getTime();
  const retentionMs = P.RECOVERY.PROVIDER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (doc.lastStatus === "failed" || doc.lastStatus === "unavailable") return "recovery_unavailable";
  if (doc.gapDetectedAt && t - new Date(doc.gapDetectedAt).getTime() <= retentionMs) return "recovery_gap";
  if (doc.lastStatus === "partial") return "recovery_behind";
  if (!doc.lastSuccessAt) return "recovery_never_run";
  if (t - new Date(doc.lastSuccessAt).getTime() > P.COVERAGE_CURRENT_WITHIN_MS) return "recovery_behind";
  return "recovery_current";
}

const MarketingLeadReconciliationState = mongoose.models.MarketingLeadReconciliationState
  || mongoose.model("MarketingLeadReconciliationState", stateSchema);

module.exports = { MarketingLeadReconciliationState, RUN_STATUSES, ATTENTION_REASON_CODES, coverageStateOf };
