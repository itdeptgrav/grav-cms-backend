// models/CMS_Models/Merchandising/TnaConfiguration.js
//
// THE SHARED COLLECTION FOR TIME & ACTION CONFIGURATION.
//
// ── WHY TWO KINDS OF RECORD SHARE ONE COLLECTION ────────────────────────────
// The cluster is at its 500-collection cap. `CLAUDE.md` records it, and
// `cutting_seasons` had to be created by RENAMING an empty orphan because a
// plain create failed with "already using 500 collections of 500". A milestone
// library declaring its own collection would work in every test — tests use an
// in-memory server — and fail on its first write in production.
//
// `merchandising_tna_reason_codes` already holds exactly this shape of thing: a
// company-scoped, code-keyed, named, retirable configuration record that other
// records reference by code. A milestone definition is the same kind of thing.
// So both live here, and this base says what they have in common.
//
// See `docs/decisions/tna-milestone-library-storage.md` for the options that
// were weighed and what is still awaiting a live index build.
//
// ── THE DISCRIMINATOR KEY IS `kind`, WHICH EVERY EXISTING DOCUMENT HAS ──────
// That is the whole reason this needed no migration of existing data. A reason
// code already carries `kind: "BLOCK"` or `kind: "RESCHEDULE"`, so adding
// `kind: "MILESTONE"` extends a field that is already populated and already
// part of the collection's unique index. A NEW discriminator field would have
// been absent on every existing document, and a Mongoose discriminator filters
// by its key on every query — so every reason code in the company would have
// disappeared from its own screens until a backfill ran.
//
// ── AND WHY REASON CODES ARE NOT THEMSELVES A DISCRIMINATOR ─────────────────
// A discriminator has one value; reason codes have two, `BLOCK` and
// `RESCHEDULE`, and those values mean "what the reason is for" — real
// information the product uses, not a type tag. Splitting them into two models
// to satisfy the pattern would have made the pattern the point. `TnaReasonCode`
// therefore stays exactly as it was, on this collection, with a query guard
// that keeps milestones out of it (see `TnaPlan.js`). Its schema, its document
// shape and its indexes are untouched.
"use strict";

const mongoose = require("mongoose");

const TNA_CONFIG_COLLECTION = "merchandising_tna_reason_codes";

/** Every kind of record in this collection. The first two predate the third. */
const CONFIG_KIND = Object.freeze({
  BLOCK: "BLOCK",
  RESCHEDULE: "RESCHEDULE",
  MILESTONE: "MILESTONE",
});

/** The two that are reason codes, which is what `TnaReasonCode` may return. */
const REASON_CODE_KINDS = Object.freeze([CONFIG_KIND.BLOCK, CONFIG_KIND.RESCHEDULE]);

/**
 * ── WHAT IS ON THE BASE, AND WHAT DELIBERATELY IS NOT ──────────────────────
 * Only what both kinds genuinely share, and nothing that would force one kind
 * through the other's rules:
 *
 *   • `companyId` — every configuration record belongs to one company.
 *   • `code` — the stable identity a template, a plan or a reschedule quotes.
 *     The SAME meaning for both: a reason code's code and a milestone's code are
 *     each "the short unchanging name of this entry". That shared meaning is
 *     what lets the collection's existing unique index — `{companyId, code,
 *     kind}` — give company-scoped milestone-code uniqueness with no new index.
 *   • `isActive` — both are retired rather than deleted, because a published
 *     template and a recorded reschedule still name them.
 *
 * NOT here, on purpose: `label`, which `TnaReasonCode` requires. A milestone
 * has a `name` with its own length limit and its own uniqueness rule, and
 * pushing it through a field named `label` to save a line would make two
 * different things look like one.
 */
const configurationSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true, index: true, immutable: true,
    },
    code: { type: String, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    collection: TNA_CONFIG_COLLECTION,
    discriminatorKey: "kind",
  },
);

/* ── NO INDEXES ARE DECLARED HERE ──────────────────────────────────────────
   `{companyId, code, kind}` unique already exists on this collection, declared
   by `reasonCodeSchema` in `TnaPlan.js` where it has always been. Declaring it
   again from the base would be a second definition of one index, and whichever
   loaded second would be the one Mongoose warned about. Each kind declares only
   the indexes that are its own. */

module.exports = {
  TNA_CONFIG_COLLECTION, CONFIG_KIND, REASON_CODE_KINDS,
  TnaConfiguration: mongoose.models.TnaConfiguration
    || mongoose.model("TnaConfiguration", configurationSchema),
};
