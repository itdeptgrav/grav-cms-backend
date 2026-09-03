// models/CMS_Models/StorePurchase/SpIdempotencyRecord.js
//
// Store & Purchase — Chunk 1. ONE USER ACTION, ONE EFFECT.
//
// Chunk 0 pinned the behaviour this exists to stop: re-posting a goods
// receipt is accepted and silently books the whole delivery into stock a
// second time as "surplus", and a double-clicked payment is recorded twice.
// Nothing in the domain is idempotent today.
//
// ── WHY THE PAYLOAD IS HASHED AND NOT STORED ────────────────────────────────
// The record must be able to say "this is the same request" without keeping
// the request. A SHA-256 of the canonical body does that, and cannot leak a
// bank reference or a price if the collection is ever read by the wrong
// person. The stored RESPONSE is the one thing that has to be kept verbatim,
// because replaying it is the point.
"use strict";

const mongoose = require("mongoose");

/**
 * ── WHY THERE IS AN EFFECT_APPLIED STATE ────────────────────────────────────
 * The first version had three states, and a hole between two of them: the
 * business mutation could succeed, the history write then fail, the request
 * return 500, and the record be marked FAILED — at which point a retry was
 * told to go ahead and do the mutation AGAIN. Stock moved twice for one
 * delivery, which is the exact failure idempotency exists to prevent.
 *
 * EFFECT_APPLIED is the durable marker that closes it. Once the domain
 * mutation has committed, the record says so, and no retry may re-run it —
 * only finish what is left (history, response) and replay.
 */
const STATUSES = ["IN_PROGRESS", "EFFECT_APPLIED", "COMPLETED", "FAILED"];

/**
 * ── THE RECOVERY RECEIPT: SHARED, DOMAIN-NEUTRAL, CLOSED AND BOUNDED ─────────
 * An EFFECT_APPLIED marker says a mutation happened. It does not say WHAT, and
 * that gap is where invented audit history came from: reconstructing the event
 * from the record's CURRENT state is wrong the moment a later legitimate write
 * moves the record on. So the facts a recovery needs are captured AT THE MOMENT
 * THE EFFECT COMMITS and stored beside the marker.
 *
 * This collection is SHARED INFRASTRUCTURE — warehouses, suppliers and every
 * future Store/Purchase domain write through it. The receipt therefore carries
 * NO domain-specific field. A warehouse location maps onto the generic
 * `subject*` fields; a supplier assessment score maps onto a bounded `facts`
 * entry. Nothing here is named "location" or "supplier", so no domain has to
 * add a column to shared infrastructure to consume the contract.
 *
 * It is a strict subdocument and never `Mixed`. Every path is a small, typed,
 * length-bounded fact about the OPERATION. There is nowhere to put an address,
 * a contact, a bank value or a nested object, because the schema has no such
 * path and the builder copies only allowlisted keys. `facts` is the one
 * extensible slot, and it takes a key and a single bounded scalar — a string
 * or a finite number — never an object.
 *
 * `v` is a schema discriminator, not decoration: a record written by an older
 * or newer deployment must FAIL CLOSED into reconciliation rather than be read
 * through a shape it was never written in.
 */
const RECOVERY_RECEIPT_VERSION = 2;

/* Every bound in one place, so tests and callers agree with the schema. */
const RECEIPT_LIMITS = Object.freeze({
  ACTION: 64,
  ENTITY_TYPE: 64,
  SUBJECT_TYPE: 64,
  SUBJECT_CODE: 120,
  DOCUMENT_NUMBER: 120,
  STATE: 64,
  FIELD_NAME: 64,
  MAX_FIELDS: 50,
  REASON: 500,
  MAX_FACTS: 20,
  FACT_KEY: 64,
  FACT_VALUE: 200,
});

/* One typed fact. A key plus EITHER a bounded string OR a finite number —
   stored in separate typed columns so there is no `Mixed` and no way to slip
   an object in. Read with `readFact()`. */
const receiptFactSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: RECEIPT_LIMITS.FACT_KEY },
    value: { type: String, trim: true, maxlength: RECEIPT_LIMITS.FACT_VALUE, default: undefined },
    num: { type: Number, default: undefined },
  },
  { _id: false },
);

/** The scalar a fact carries, whichever column holds it. */
const readFact = (fact) => (fact && fact.num !== undefined && fact.num !== null ? fact.num : fact?.value);

const recoveryReceiptSchema = new mongoose.Schema(
  {
    v: { type: Number, required: true },
    action: { type: String, required: true, trim: true, maxlength: RECEIPT_LIMITS.ACTION },

    /* WHAT KIND of record, and which one. Generic — a warehouse, a supplier,
       anything. The route asserts this equals the domain it serves. */
    entityType: { type: String, required: true, trim: true, maxlength: RECEIPT_LIMITS.ENTITY_TYPE },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* An optional child the operation acted on — a warehouse location, a
       supplier contact — addressed generically so no domain name leaks here. */
    subjectType: { type: String, trim: true, maxlength: RECEIPT_LIMITS.SUBJECT_TYPE, default: undefined },
    subjectId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    subjectCode: { type: String, trim: true, maxlength: RECEIPT_LIMITS.SUBJECT_CODE, default: undefined },

    /* The code/number as it stood when the operation ran, so the trail reads
       as it did then rather than as the record reads now. */
    documentNumber: { type: String, trim: true, maxlength: RECEIPT_LIMITS.DOCUMENT_NUMBER, default: "" },

    /* WHEN the event happened. Recovery uses this as the history `at`, so a
       repair long afterwards does not backdate — or forward-date — the event. */
    occurredAt: { type: Date, required: true },

    /* The transition the operation actually made. */
    previousState: { type: String, trim: true, maxlength: RECEIPT_LIMITS.STATE, default: "" },
    resultingState: { type: String, trim: true, maxlength: RECEIPT_LIMITS.STATE, default: "" },

    /* Field NAMES only — never their values. */
    fields: {
      type: [{ type: String, trim: true, maxlength: RECEIPT_LIMITS.FIELD_NAME }],
      default: undefined,
    },

    /* Any audit fact the original entry recorded that must survive recovery —
       an archive reason, a deactivation reason. Bounded. */
    reason: { type: String, trim: true, maxlength: RECEIPT_LIMITS.REASON, default: "" },

    /* The one extensible slot, for a small typed value another domain needs. */
    facts: { type: [receiptFactSchema], default: undefined },
  },
  { _id: false },
);

/**
 * Validate and normalise a caller's receipt into the stored shape.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SCHEMA ──────────────────────────────
 * The schema is the last line of defence (casting on write, validators when
 * asked). This is the FIRST: the unit of work calls it BEFORE the business
 * mutation, so a malformed receipt stops the operation before anything is
 * written — never after, which would leave a mutation with no marker.
 *
 * It is allowlist-by-construction: it names every field it copies, so nothing
 * a caller happens to pass — an address, a bank value, a nested object — can
 * ride along. Unknown keys are dropped deterministically. Anything malformed
 * throws, and the throw carries `name: "RecoveryReceiptError"`.
 *
 * @returns {object} a clean, validated plain object safe to store
 * @throws  {Error}  name === "RecoveryReceiptError" on any violation
 */
function buildRecoveryReceipt(input) {
  const bad = (message) => {
    const err = new Error(`Invalid recovery receipt: ${message}`);
    err.name = "RecoveryReceiptError";
    return err;
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw bad("it must be an object");
  }

  const str = (label, value, max, { required = false } = {}) => {
    if (value === undefined || value === null || value === "") {
      if (required) throw bad(`${label} is required`);
      return undefined;
    }
    if (typeof value !== "string") throw bad(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) throw bad(`${label} is required`);
    if (trimmed.length > max) throw bad(`${label} exceeds ${max} characters`);
    return trimmed;
  };

  const id = (label, value, { required = false } = {}) => {
    if (value === undefined || value === null || value === "") {
      if (required) throw bad(`${label} is required`);
      return undefined;
    }
    if (!mongoose.Types.ObjectId.isValid(value)) throw bad(`${label} is not a valid id`);
    return new mongoose.Types.ObjectId(value);
  };

  /* Event time. Required, and a real date — never coerced from "now". */
  const when = input.occurredAt;
  const occurredAt = when instanceof Date ? when : (typeof when === "string" || typeof when === "number" ? new Date(when) : null);
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) throw bad("occurredAt must be a valid date");

  /* Fields — names only, count- and length-bounded. */
  let fields;
  if (input.fields !== undefined && input.fields !== null) {
    if (!Array.isArray(input.fields)) throw bad("fields must be an array");
    if (input.fields.length > RECEIPT_LIMITS.MAX_FIELDS) throw bad(`fields exceeds ${RECEIPT_LIMITS.MAX_FIELDS}`);
    fields = input.fields.map((f, i) => {
      if (typeof f !== "string" || !f.trim()) throw bad(`fields[${i}] must be a non-empty string`);
      if (f.length > RECEIPT_LIMITS.FIELD_NAME) throw bad(`fields[${i}] exceeds ${RECEIPT_LIMITS.FIELD_NAME}`);
      return f.trim();
    });
    if (!fields.length) fields = undefined;
  }

  /* Facts — a key and a single bounded scalar. Never an object. */
  let facts;
  if (input.facts !== undefined && input.facts !== null) {
    if (!Array.isArray(input.facts)) throw bad("facts must be an array");
    if (input.facts.length > RECEIPT_LIMITS.MAX_FACTS) throw bad(`facts exceeds ${RECEIPT_LIMITS.MAX_FACTS}`);
    facts = input.facts.map((f, i) => {
      if (!f || typeof f !== "object" || Array.isArray(f)) throw bad(`facts[${i}] must be an object`);
      const key = str(`facts[${i}].key`, f.key, RECEIPT_LIMITS.FACT_KEY, { required: true });
      /* IDEMPOTENT: accept both the caller's `{ key, value }` and the stored
         `{ key, num }` / `{ key, value }` split, so validating an already-built
         receipt (the second-defence pass in markEffectApplied) does not choke. */
      const v = f.value !== undefined && f.value !== null ? f.value
        : (f.num !== undefined && f.num !== null ? f.num : undefined);
      if (typeof v === "number") {
        if (!Number.isFinite(v)) throw bad(`facts[${i}].value must be finite`);
        return { key, num: v };
      }
      if (typeof v === "string") {
        if (v.length > RECEIPT_LIMITS.FACT_VALUE) throw bad(`facts[${i}].value exceeds ${RECEIPT_LIMITS.FACT_VALUE}`);
        return { key, value: v };
      }
      throw bad(`facts[${i}].value must be a string or a finite number`);
    });
    if (!facts.length) facts = undefined;
  }

  /* Built from named keys only — nothing else is copied. */
  const receipt = {
    v: RECOVERY_RECEIPT_VERSION,
    action: str("action", input.action, RECEIPT_LIMITS.ACTION, { required: true }),
    entityType: str("entityType", input.entityType, RECEIPT_LIMITS.ENTITY_TYPE, { required: true }),
    entityId: id("entityId", input.entityId, { required: true }),
    documentNumber: str("documentNumber", input.documentNumber, RECEIPT_LIMITS.DOCUMENT_NUMBER) || "",
    occurredAt,
  };
  const subjectType = str("subjectType", input.subjectType, RECEIPT_LIMITS.SUBJECT_TYPE);
  const subjectId = id("subjectId", input.subjectId);
  const subjectCode = str("subjectCode", input.subjectCode, RECEIPT_LIMITS.SUBJECT_CODE);
  const previousState = str("previousState", input.previousState, RECEIPT_LIMITS.STATE);
  const resultingState = str("resultingState", input.resultingState, RECEIPT_LIMITS.STATE);
  const reason = str("reason", input.reason, RECEIPT_LIMITS.REASON);

  if (subjectType !== undefined) receipt.subjectType = subjectType;
  if (subjectId !== undefined) receipt.subjectId = subjectId;
  if (subjectCode !== undefined) receipt.subjectCode = subjectCode;
  if (previousState !== undefined) receipt.previousState = previousState;
  if (resultingState !== undefined) receipt.resultingState = resultingState;
  if (reason !== undefined) receipt.reason = reason;
  if (fields !== undefined) receipt.fields = fields;
  if (facts !== undefined) receipt.facts = facts;

  return receipt;
}

const idempotencySchema = new mongoose.Schema(
  {
    /* Scope. A key is only ever meaningful within one company, for one actor,
       on one operation — so the same key from two people, or on two different
       endpoints, is two different things and must not collide. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    actorId: { type: String, required: true, trim: true },
    operation: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },

    /* Canonical SHA-256 of the request body. Same key + different hash is a
       client bug worth refusing loudly, not a replay. */
    requestHash: { type: String, required: true, trim: true },

    status: { type: String, enum: STATUSES, default: "IN_PROGRESS", index: true },

    /* Kept only for COMPLETED records — what to replay. */
    responseStatus: { type: Number },
    responseBody: { type: mongoose.Schema.Types.Mixed },

    /* For diagnosis; never replayed. */
    failureReason: { type: String, trim: true, default: "" },

    /* When the domain mutation committed. Its presence — not the status
       string alone — is what a recovery path checks before deciding whether
       re-running the work is safe. */
    effectAppliedAt: { type: Date, default: null },

    /* Renewed while a request is running, so a crashed process can be told
       apart from a slow one. Without it an IN_PROGRESS record would lock the
       action until the 30-day TTL expired. */
    heartbeatAt: { type: Date, default: Date.now },

    /* What the operation produced, so a replay is traceable to its document
       even if the response body is later trimmed. */
    resultEntityType: { type: String, trim: true, default: "" },
    resultEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Written with the effect marker, in the same update. Optional: every
       existing caller omits it, and a record without one is not readable as
       a completed event — it reconciles instead of guessing. */
    recoveryReceipt: { type: recoveryReceiptSchema, default: null },

    completedAt: { type: Date },
  },
  { timestamps: true, collection: "sp_idempotency_records" },
);

/* The uniqueness that makes concurrent duplicates impossible: the second
   insert loses on this index and is told to replay rather than to execute. */
idempotencySchema.index(
  { companyId: 1, actorId: 1, operation: 1, key: 1 },
  { unique: true },
);

/* Documented retention: 30 days. Long enough for any realistic retry — a
   user re-submitting a form, a mobile client resuming, an operator coming
   back after a network failure — and short enough that the collection is not
   an indefinite record of who did what, which is action history's job. */
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports.STATUSES = STATUSES;
module.exports =
  mongoose.models.SpIdempotencyRecord ||
  mongoose.model("SpIdempotencyRecord", idempotencySchema);
module.exports.STATUSES = STATUSES;
module.exports.RECOVERY_RECEIPT_VERSION = RECOVERY_RECEIPT_VERSION;
module.exports.RECEIPT_LIMITS = RECEIPT_LIMITS;
module.exports.buildRecoveryReceipt = buildRecoveryReceipt;
module.exports.readFact = readFact;
