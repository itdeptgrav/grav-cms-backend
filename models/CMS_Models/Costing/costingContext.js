// models/CMS_Models/Costing/costingContext.js
//
// Central Costing — Chunk 1. WHAT A COSTING IS FOR, WITHOUT BORROWING ITS
// AUTHORITY FROM THAT THING.
//
// ── THE DISTINCTION THIS FILE EXISTS TO KEEP ────────────────────────────────
// A costing is always ABOUT something: a style, a style inside an enquiry, an
// order. The tempting shortcut is to hang the costing off that document —
// `ref: "Enquiry"`, populate it, read the company off it. That is the exact
// circularity the tenant rules refuse: the enquiry would then decide which
// company owns the costing, so anyone who could reach an enquiry could reach
// its costing.
//
// So the reference is TYPED AND INERT. It says what kind of thing and which
// id, it is validated for shape, and it is never consulted for company scope,
// permission or price. Company comes from the actor's proven membership and
// from nowhere else.
//
// ── AND A SNAPSHOT, BECAUSE HISTORY MUST STILL READ ─────────────────────────
// A version frozen in March must still print "Blazer / ENQ-118 / Acme" in
// September, after the style was renamed and the enquiry archived. A live
// populate cannot do that — it shows today's names against last spring's
// numbers. The snapshot is a display copy taken at creation and never
// refreshed; it is explicitly NOT authority for anything.
"use strict";

const mongoose = require("mongoose");

/**
 * The kinds of business context a costing may be raised against.
 *
 * `ENQUIRY_STYLE` carries BOTH an enquiry id and the product key, because the
 * legacy `Enquiry.costingSheets` this will eventually adopt is keyed by
 * product NAME within an enquiry, not by a product id — see that field's own
 * schema comment. Chunk 2's adapter needs to address the same pair.
 *
 * `ADHOC` is honest rather than convenient: a costing raised before any
 * document exists is a real case, and pretending it points at a style would
 * put an id in the record that resolves to nothing.
 */
const CONTEXT_TYPES = Object.freeze([
  "STYLE",
  "ENQUIRY_STYLE",
  "ORDER",
  "SAMPLE_STYLE",
  "ADHOC",
]);

/**
 * The context types the HTTP API accepts today.
 *
 * ── WHY THE OTHERS ARE DECLARED BUT NOT ENABLED ─────────────────────────────
 * `CONTEXT_TYPES` is the vocabulary — what the stored enum permits, so a later
 * chunk can enable one without a data migration. `ENABLED_CONTEXT_TYPES` is
 * what the API will accept, and it is deliberately shorter.
 *
 * A context type is only safe to enable once the server can RESOLVE it: prove
 * the referenced document exists, prove it is not another company's, and build
 * the display snapshot itself instead of trusting the client's. Only
 * `ENQUIRY_STYLE` has that resolution today (see
 * `services/centralCosting/contextResolver.service.js`), and `ADHOC`
 * references nothing at all so there is nothing to resolve.
 *
 * `STYLE`, `ORDER` and `SAMPLE_STYLE` would each need a resolver against a
 * master that has no company scope yet. Writing one that could not check
 * ownership — and calling the result validated — is exactly the unsafe adapter
 * this chunk refuses to build, so they are refused with a stable
 * `CONTEXT_NOT_SUPPORTED_YET` until their masters can answer the question.
 */
const ENABLED_CONTEXT_TYPES = Object.freeze(["ADHOC", "ENQUIRY_STYLE"]);

/** Which context types must name a primary id, and which must name a key. */
const CONTEXT_RULES = Object.freeze({
  STYLE:         { primaryId: true,  externalKey: false },
  ENQUIRY_STYLE: { primaryId: true,  externalKey: true  },
  ORDER:         { primaryId: true,  externalKey: false },
  SAMPLE_STYLE:  { primaryId: true,  externalKey: false },
  ADHOC:         { primaryId: false, externalKey: false },
});

const contextRefSchema = new mongoose.Schema(
  {
    type: { type: String, enum: CONTEXT_TYPES, required: true },

    /* The document this costing is about. NOT a `ref`: nothing populates it,
       and nothing may resolve company, permission or price through it. */
    primaryId: { type: mongoose.Schema.Types.ObjectId, default: undefined },

    /* A second id where the context genuinely has two parts (an order line, a
       style version). Reserved; unused by any current context type. */
    secondaryId: { type: mongoose.Schema.Types.ObjectId, default: undefined },

    /* The non-ObjectId half of a compound context — today, the product name a
       legacy costing sheet is keyed by. Bounded, trimmed, never interpreted. */
    externalKey: { type: String, trim: true, maxlength: 200, default: undefined },
  },
  { _id: false },
);

/* One display fact. Typed key/value pair — never `Mixed`, so there is nowhere
   to put a nested document, a price or a supplier record. */
const snapshotFactSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 64 },
    value: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { _id: false },
);

const contextSnapshotSchema = new mongoose.Schema(
  {
    /* What a human calls this costing. Frozen at creation. */
    label: { type: String, trim: true, maxlength: 300, default: "" },
    /* Up to a handful of supporting display facts: buyer, enquiry number,
       season. Bounded in count by the parser, in size by the schema. */
    facts: { type: [snapshotFactSchema], default: () => [] },
    capturedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

module.exports = {
  CONTEXT_TYPES, ENABLED_CONTEXT_TYPES, CONTEXT_RULES,
  contextRefSchema, contextSnapshotSchema, snapshotFactSchema,
};
