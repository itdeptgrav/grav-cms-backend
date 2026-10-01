// models/CMS_Models/Marketing/MarketingCampaignAnalysis.js
//
// ONE EXPLANATION, AND EVERYTHING NEEDED TO JUDGE IT LATER.
//
// ── AN ANALYSIS IS IMMUTABLE ───────────────────────────────────────────────
// It is a statement a model made, at a moment, about a specific set of facts,
// under a specific prompt version. Every one of those can change; the statement
// cannot. Changed evidence, a changed model or a changed prompt produces a NEW
// analysis that supersedes this one, so a recommendation somebody acted on can
// still be found beside the figures that produced it.
//
// ── WHAT IS NOT STORED ─────────────────────────────────────────────────────
// The raw provider envelope. Hidden reasoning. Chain-of-thought. Three
// different names for the same decision: GRAV keeps the validated structured
// result and the evidence it was given, because those are what can be checked.
// A raw envelope carries provider metadata, request fragments and, for some
// providers, reasoning traces that are neither reviewable nor safe to render —
// and storing it would put all of that in every backup.
//
// ── AND A DISMISSAL IS A SEPARATE, APPEND-ONLY FACT ────────────────────────
// Not a flag on this row. §9 requires evaluation to include harmful
// recommendations, not only accepted ones — which means a dismissal has to
// survive, with its reason and the person who gave it, even after the analysis
// it dismissed has been superseded three times.
"use strict";

const mongoose = require("mongoose");

const {
  ALLOWED_RECOMMENDATION_CODES,
  CONFIDENCE_CODES,
} = require("../../../constants/marketingCampaignHealth");

const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/* ── ONE STATEMENT THE MODEL MADE ───────────────────────────────────────────
   `evidenceRefs` is required and validated to be non-empty. An observation
   citing nothing is an assertion, and an assertion is what this whole design
   exists to prevent — the ids are checked against GRAV's own list before the
   analysis is ever stored, so a row here cannot cite something that was not
   measured. */
const observationSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 600 },
    evidenceRefs: {
      type: [{ type: String, trim: true, maxlength: 32 }],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 1,
        message: "Every observation must cite the evidence it rests on.",
      },
    },
  },
  { _id: false },
);

const recommendationSchema = new mongoose.Schema(
  {
    /* A closed enum, so a stored row cannot carry an action outside what this
       adviser may suggest even if a future validation path is weakened. */
    type: { type: String, enum: ALLOWED_RECOMMENDATION_CODES, required: true },
    text: { type: String, required: true, trim: true, maxlength: 600 },
    evidenceRefs: {
      type: [{ type: String, trim: true, maxlength: 32 }],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 1,
        message: "Every recommendation must cite the evidence it rests on.",
      },
    },
  },
  { _id: false },
);

const analysisSchema = new mongoose.Schema(
  {
    /* ── EVERY SELECTOR CARRIES THIS ─────────────────────────────────────── */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },
    /* The revision the analysis is OF. A plan edited and re-approved is a
       different campaign, and an explanation of the old one must not appear
       beside the new one's figures. */
    approvedRevision: { type: Number, required: true, min: 1 },

    /* ── WHAT MAKES AN ANALYSIS REUSABLE ─────────────────────────────────
       A hash of the evidence packet. Identical evidence under an identical
       prompt version means the model would be asked exactly the same question,
       so asking again spends tokens to get the same answer. */
    inputFingerprint: { type: String, required: true, trim: true, maxlength: 64 },

    /* The facts the model was given, stored so a reader can see what an
       explanation was based on rather than taking the explanation's word for
       it. Free of names, addresses, account numbers and database ids — the
       gateway refuses to transmit a packet carrying any of those. */
    evidencePacket: { type: mongoose.Schema.Types.Mixed, required: true },
    evidenceIds: { type: [{ type: String, trim: true, maxlength: 32 }], default: [] },

    /* How fresh the figures were when the explanation was made. An analysis of
       stale figures is not wrong, but a reader needs to know. */
    performanceFreshness: {
      code: { type: String, trim: true, default: "" },
      observedAt: { type: Date, default: null },
    },

    /* ── WHO ANSWERED, AND UNDER WHICH INSTRUCTION ───────────────────────
       Provider and model as the provider named it — not as configured, which
       differ when a provider serves an alias. `promptVersion` because a changed
       prompt is a changed analysis. */
    provider: { type: String, required: true, trim: true, maxlength: 40 },
    model: { type: String, required: true, trim: true, maxlength: 80 },
    promptVersion: { type: String, required: true, trim: true, maxlength: 40 },

    /* ── THE VALIDATED RESULT. NOTHING RAW. ─────────────────────────────── */
    headline: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, required: true, trim: true, maxlength: 2000 },
    observations: { type: [observationSchema], default: [] },
    recommendations: { type: [recommendationSchema], default: [] },
    confidence: { type: String, enum: CONFIDENCE_CODES, required: true },
    uncertainty: { type: String, trim: true, default: "", maxlength: 1000 },
    missingInformation: { type: [{ type: String, trim: true, maxlength: 300 }], default: [] },

    tokenUsage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
      cachedTokens: { type: Number, default: null },
    },

    generatedAt: { type: Date, required: true, default: Date.now },
    requestedBy: { type: actorSchema, required: true },

    /* `current` is what a screen shows. `superseded` is kept because somebody
       may have acted on it. `dismissed` is set when a person says so — and the
       reason lives in its own append-only row, not here. */
    status: { type: String, enum: ["current", "superseded", "dismissed"], required: true, default: "current" },
    supersededAt: { type: Date, default: null },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: "marketing_campaign_analyses", strict: "throw" },
);

/* ── ONE CURRENT ANALYSIS PER PLAN REVISION ─────────────────────────────────
   The partial filter is what allows many superseded rows beside one current
   one. Without it a plan could show two contradictory explanations and nothing
   would say which to believe. */
analysisSchema.index(
  { companyId: 1, campaignDraftId: 1, approvedRevision: 1 },
  { unique: true, partialFilterExpression: { status: "current" } },
);

/* The reuse lookup: same company, same plan revision, same evidence, same
   prompt version. */
analysisSchema.index({ companyId: 1, campaignDraftId: 1, inputFingerprint: 1, promptVersion: 1 });
analysisSchema.index({ companyId: 1, campaignDraftId: 1, generatedAt: -1 });

/* ── THE RESULT CANNOT BE EDITED ────────────────────────────────────────────
   An analysis is a statement somebody may have acted on. Only its lifecycle
   fields move; the words and the evidence do not. Enforced on the document path
   AND every query path, because a `pre("save")` hook alone leaves `updateOne`
   and its siblings open. */
const FROZEN = [
  "headline", "summary", "observations", "recommendations", "confidence",
  "uncertainty", "missingInformation", "evidencePacket", "evidenceIds",
  "inputFingerprint", "model", "provider", "promptVersion", "generatedAt",
  "companyId", "campaignDraftId", "approvedRevision", "tokenUsage",
];

analysisSchema.pre("save", function refuseEdit(next) {
  if (this.isNew) return next();
  const moved = FROZEN.filter((f) => this.isModified(f));
  if (moved.length) {
    return next(new Error(
      `An analysis is immutable: ${moved.join(", ")} cannot change. Generate a new one instead.`,
    ));
  }
  return next();
});

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  analysisSchema.pre(op, function refuseEditByQuery(next) {
    const update = this.getUpdate() || {};
    const touched = new Set();
    for (const [key, value] of Object.entries(update)) {
      if (key.startsWith("$")) {
        if (value && typeof value === "object") {
          for (const field of Object.keys(value)) touched.add(field.split(".")[0]);
        }
      } else {
        touched.add(key.split(".")[0]);
      }
    }
    const moved = FROZEN.filter((f) => touched.has(f));
    if (moved.length) {
      return next(new Error(
        `An analysis is immutable: ${moved.join(", ")} cannot change. Generate a new one instead.`,
      ));
    }
    return next();
  });
}

const MarketingCampaignAnalysis = mongoose.models.MarketingCampaignAnalysis
  || mongoose.model("MarketingCampaignAnalysis", analysisSchema);

/* ── WHY SOMEBODY REJECTED A RECOMMENDATION ─────────────────────────────────
   Its own append-only collection, because §9 requires evaluation to include
   HARMFUL recommendations rather than only accepted ones — and a dismissal
   stored as a flag on a row that later gets superseded takes that evidence with
   it.

   The reason is required and free text on purpose: an enum of dismissal reasons
   would collect the ones somebody anticipated, and the useful signal is always
   the one nobody did. */
const dismissalSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    analysisId: { type: mongoose.Schema.Types.ObjectId, required: true },
    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    approvedRevision: { type: Number, required: true, min: 1 },

    /* Which recommendation, or the whole analysis. */
    recommendationType: { type: String, trim: true, default: "" },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    actor: { type: actorSchema, required: true },
    at: { type: Date, required: true, default: Date.now },

    /* What was dismissed, kept beside the reason so an evaluation does not have
       to join back to a row that may have been superseded. */
    dismissedHeadline: { type: String, trim: true, default: "", maxlength: 200 },
    promptVersion: { type: String, trim: true, default: "", maxlength: 40 },
    model: { type: String, trim: true, default: "", maxlength: 80 },
  },
  { timestamps: false, collection: "marketing_campaign_analysis_dismissals", strict: "throw" },
);

dismissalSchema.index({ companyId: 1, analysisId: 1, at: 1 });
dismissalSchema.index({ companyId: 1, campaignDraftId: 1, at: -1 });

const refuse = function refuseMutation(next) {
  next(new Error("marketing_campaign_analysis_dismissals is append-only: a recorded dismissal cannot be changed or removed."));
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  dismissalSchema.pre(op, refuse);
}
dismissalSchema.pre("save", function refuseRewrite(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

const MarketingCampaignAnalysisDismissal = mongoose.models.MarketingCampaignAnalysisDismissal
  || mongoose.model("MarketingCampaignAnalysisDismissal", dismissalSchema);

module.exports = {
  MarketingCampaignAnalysis,
  MarketingCampaignAnalysisDismissal,
  FROZEN,
};
