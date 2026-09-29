// models/CMS_Models/Marketing/MarketingContentPlanItem.js
//
// ONE PIECE OF CONTENT SOMEBODY INTENDS TO PRODUCE, AND ITS OWN HISTORY.
//
// ── THE HISTORY LIVES ON THE ITEM, AND THAT IS WHAT MAKES IT EXACT ─────────
// Every write is one `findOneAndUpdate` fenced on `revision`, which sets the new
// fields, increments the revision and `$push`es the history entry in the same
// single-document operation. MongoDB applies that atomically, so an item can
// never be at revision 5 with four history entries, and two competing edits
// cannot both land: the second one's fence no longer matches.
//
// ── APPEND-ONLY, ENFORCED ──────────────────────────────────────────────────
// Every update path is checked: an update that touches `history` in any way
// other than `$push` is refused, as is any delete. An item is cancelled, never
// removed.
//
// ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
// No scheduled or published date. Those are facts about the world, and the
// planner only ever reads them from a source that observed them.
"use strict";

const mongoose = require("mongoose");

const C = require("../../../constants/marketingContentPlan");
const { CONTENT_KIND_CODES } = require("../../../constants/marketing");

const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Snapshots for a reader. Never the authority for anything. */
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    /* The revision this change PRODUCED. */
    revision: { type: Number, required: true, min: 1 },
    action: { type: String, required: true, enum: ["created", "edited", ...C.ACTION_CODES] },
    fromState: { type: String, enum: [...C.STATE_CODES, null], default: null },
    toState: { type: String, enum: C.STATE_CODES, required: true },
    changedFields: { type: [String], default: [] },
    reason: { type: String, trim: true, default: "", maxlength: C.LIMITS.REASON_MAX },
    actor: { type: actorSchema, required: true },
    at: { type: Date, required: true },
    /* The creative as it stood when this entry was written. On an approval it
       is what was approved. */
    creativeFingerprint: { type: String, default: "" },
  },
  { _id: false },
);

/* ── A CREATIVE REFERENCE ───────────────────────────────────────────────────
   An image already held in the company's advertising image library (by its
   internal id, with the hash, name and size of the exact version referenced),
   or a written note. Never a URL, a path or bytes: the planner stores no
   files. */
const referenceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: C.REFERENCE_KIND_CODES, required: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sha256: { type: String, default: "" },
    fileName: { type: String, trim: true, default: "" },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    text: { type: String, trim: true, default: "", maxlength: C.LIMITS.REFERENCE_NOTE_MAX },
    /* A creative media library version: its public reference, the file it is
       a version of, and which version. The bytes are pinned by `sha256`. */
    mediaRef: { type: String, default: "" },
    groupRef: { type: String, default: "" },
    version: { type: Number, default: null },
    mimeType: { type: String, default: "" },
  },
  { _id: false },
);

/* One platform version of the idea. Not a post: no state, no date. */
const variantSchema = new mongoose.Schema(
  {
    variantRef: { type: String, required: true, trim: true },
    platform: { type: String, enum: C.PLATFORM_CODES, required: true },
    format: { type: String, enum: C.FORMAT_CODES, required: true },
    caption: { type: String, trim: true, default: "", maxlength: C.LIMITS.CAPTION_MAX },
    callToAction: {
      type: new mongoose.Schema(
        {
          type: { type: String, enum: C.CALL_TO_ACTION_CODES, required: true },
          text: { type: String, trim: true, default: "", maxlength: C.LIMITS.CTA_TEXT_MAX },
        },
        { _id: false },
      ),
      default: null,
    },
    references: { type: [referenceSchema], default: [] },
  },
  { _id: false },
);

const creativeSchema = new mongoose.Schema(
  {
    concept: { type: String, trim: true, default: "", maxlength: C.LIMITS.CONCEPT_MAX },
    references: { type: [referenceSchema], default: [] },
    variants: { type: [variantSchema], default: [] },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* GRAV's public identity for the item. Random, so it carries no database
       id, no time and no sequence. */
    itemRef: { type: String, required: true, trim: true },

    /* The creator's retry key. A second create with the same key returns the
       first item rather than a duplicate. */
    idempotencyKey: { type: String, required: true, trim: true },
    createFingerprint: { type: String, required: true },

    revision: { type: Number, required: true, min: 1, default: 1 },
    state: { type: String, enum: C.STATE_CODES, required: true, default: "idea" },

    title: { type: String, required: true, trim: true, maxlength: C.LIMITS.TITLE_MAX },
    contentType: { type: String, enum: C.CONTENT_TYPE_CODES, required: true },
    channel: { type: String, enum: C.CHANNEL_CODES, required: true },
    brief: { type: String, trim: true, default: "", maxlength: C.LIMITS.BRIEF_MAX },
    notes: { type: String, trim: true, default: "", maxlength: C.LIMITS.NOTES_MAX },

    /* ── THE PLANNED MOMENT ──────────────────────────────────────────────
       `date`/`time`/`timeZone` are what somebody typed, kept verbatim so the
       item reads back as it was written. `startsAt` is the instant they name,
       computed once from them, and is what a calendar range is queried on. An
       all-day item has no time; its `startsAt` is the start of that day in
       its own zone, and a calendar places it by `date`, not by instant. */
    planned: {
      type: new mongoose.Schema(
        {
          date: { type: String, required: true },
          time: { type: String, default: null },
          timeZone: { type: String, required: true },
          allDay: { type: Boolean, required: true },
          startsAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    owner: {
      type: new mongoose.Schema(
        {
          membershipId: { type: mongoose.Schema.Types.ObjectId, required: true },
          name: { type: String, trim: true, default: "" },
          email: { type: String, trim: true, lowercase: true, default: "" },
          employeeRef: { type: mongoose.Schema.Types.ObjectId, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    campaign: {
      type: new mongoose.Schema(
        {
          draftId: { type: mongoose.Schema.Types.ObjectId, required: true },
          draftRef: { type: String, required: true, trim: true },
          /* A snapshot, shown only if the plan can no longer be read. */
          capturedName: { type: String, trim: true, default: "" },
        },
        { _id: false },
      ),
      default: null,
    },

    /* The content-library asset that realises this item. The identifier is the
       library's own opaque content id, confirmed to exist when it was linked. */
    asset: {
      type: new mongoose.Schema(
        {
          kind: { type: String, enum: CONTENT_KIND_CODES, required: true },
          contentId: { type: String, required: true, trim: true },
          capturedName: { type: String, trim: true, default: "", maxlength: C.LIMITS.CAPTURED_NAME_MAX },
          confirmedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    creative: { type: creativeSchema, default: null },

    /* ── WHAT EXACTLY WAS APPROVED ───────────────────────────────────────
       The revision the approver was looking at and the fingerprint of the
       creative at that revision. Cleared when the item is reopened. */
    approvedRevision: { type: Number, default: null },
    approvedCreativeFingerprint: { type: String, default: "" },

    /* The last submitter, compared by id to refuse self-approval. */
    submittedBy: { type: actorSchema, default: null },
    submittedAt: { type: Date, default: null },
    approvedBy: { type: actorSchema, default: null },
    approvedAt: { type: Date, default: null },

    createdBy: { type: actorSchema, required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, collection: "marketing_content_plan_items", strict: "throw" },
);

itemSchema.index({ companyId: 1, itemRef: 1 }, { unique: true });
itemSchema.index({ companyId: 1, idempotencyKey: 1 }, { unique: true });
itemSchema.index({ companyId: 1, "planned.startsAt": 1 });
itemSchema.index({ companyId: 1, "planned.date": 1 });
itemSchema.index({ companyId: 1, state: 1, updatedAt: -1 });

/* ── THE HISTORY CAN ONLY GROW ──────────────────────────────────────────── */
const APPEND_ONLY = "marketing_content_plan_items keeps its history append-only: entries can be added, never changed or removed, and items are cancelled rather than deleted.";

function touchesHistory(update) {
  if (!update || typeof update !== "object") return false;
  for (const [op, body] of Object.entries(update)) {
    if (op === "$push") continue;
    if (!op.startsWith("$")) {
      if (op === "history" || op.startsWith("history.")) return true;
      continue;
    }
    if (body && typeof body === "object"
      && Object.keys(body).some((k) => k === "history" || k.startsWith("history."))) {
      return true;
    }
  }
  return false;
}

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  itemSchema.pre(op, function guardHistory(next) {
    if (op === "findOneAndReplace" || op === "replaceOne") return next(new Error(APPEND_ONLY));
    if (touchesHistory(this.getUpdate())) return next(new Error(APPEND_ONLY));
    return next();
  });
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  itemSchema.pre(op, function refuseDelete(next) { next(new Error(APPEND_ONLY)); });
}
itemSchema.pre("save", function refuseResave(next) {
  if (!this.isNew) return next(new Error(APPEND_ONLY));
  return next();
});

const MarketingContentPlanItem = mongoose.models.MarketingContentPlanItem
  || mongoose.model("MarketingContentPlanItem", itemSchema);

module.exports = { MarketingContentPlanItem, APPEND_ONLY };
