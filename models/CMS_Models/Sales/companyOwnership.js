// models/CMS_Models/Sales/companyOwnership.js
//
// THE OWNERSHIP SHAPE EVERY SALES SOURCE RECORD CARRIES.
//
// ── WHY IT IS A SHARED FRAGMENT AND NOT COPIED FOUR TIMES ───────────────────
// `SalesJourney` and `Enquiry` grew this shape independently, and the third
// and fourth copies are where the drift starts: a missing index here, a
// different default there, and a scope helper that works for two models and
// silently does nothing for the others. One definition, four models.
//
// ── THE HIERARCHY THIS ESTABLISHES ──────────────────────────────────────────
//     Company → Account / Lead → Contact → SalesJourney → Enquiry
//
// Every level carries `companyId` DIRECTLY rather than inheriting it through a
// join. A Contact's company is enforceable without loading its Account — which
// matters, because the enforcement has to happen in the same query as the
// selector, and a join cannot be. The direct field is the enforcement; the
// agreement with its parent Account is checked separately at write time, and
// the two must never disagree.
//
// ── `null` MEANS LEGACY, NOT PUBLIC ─────────────────────────────────────────
// Records created before this field exists have none. They are usable only
// where ownership cannot be ambiguous — a proven single-company deployment —
// and are never claimed as a side effect of being read. The backfill in
// `scripts/migrations/backfill-sales-company.js` settles them deliberately.
"use strict";

const mongoose = require("mongoose");

/** Spread into a schema definition. */
const companyOwnershipFields = () => ({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Acc_Company",
    default: null,
    index: true,
  },
  companyOwnership: {
    /* MEMBERSHIP_RECORD, SINGLE_COMPANY_DEPLOYMENT, or a backfill marker.
       Recorded rather than inferred: a company somebody PROVED and one that
       was the only candidate are different facts. */
    source: { type: String, trim: true, default: "" },
    resolvedAt: { type: Date },
    proven: { type: Boolean, default: false },
  },
});

/**
 * Company-prefixed indexes for the patterns a scoped list actually uses.
 *
 * Company leads every one, because a compound index whose leading field is not
 * the tenant scope is an index the scoped query cannot use — and the scoped
 * query is now the only kind there is.
 *
 * Deliberately NOT unique on anything but a key that is genuinely unique
 * per company: two companies may both have a customer called "Acme", and a
 * global unique index would make the second one a duplicate-key error.
 */
function addCompanyIndexes(schema, extras = []) {
  schema.index({ companyId: 1, isActive: 1, updatedAt: -1 });
  for (const spec of extras) schema.index({ companyId: 1, ...spec });
}

/* ═══════════════════════════════════════════════════════════════════════════
   OWNERSHIP IS WRITTEN ONCE, BY THE SERVER, AND NEVER AGAIN
   ═══════════════════════════════════════════════════════════════════════════

   Scoping every query stops one company READING another's records. It does
   nothing about a record CHANGING companies: a PATCH body carrying
   `companyId` passes the scope check (the record is mine when it is read) and
   then hands it to somebody else. The read was legitimate; the write is the
   theft. `{"companyOwnership": {"proven": true}}` is the same move against
   the audit trail — it launders a single-company-deployment inference into a
   membership somebody supposedly proved.

   Two layers, deliberately:

     • `stripCompanyOwnershipInput()` at each route, so the payload that
       reaches the model never contains ownership at all;
     • `sealCompanyOwnership()` at the model, so a route written next year
       that forgets the first layer still cannot move a record.

   The route layer alone is a convention, and conventions are what the
   previous pass proved do not hold. The model layer alone gives a caller a
   500 where a 400 belongs and no clear message. Both.

   ── THE ONE WAY OWNERSHIP IS EVER ASSIGNED AFTER CREATION ──────────────────
   The backfill migration exists precisely to stamp records that have no
   company. `withOwnershipMigration()` opens that door — and it takes a
   callback rather than reading a flag, so there is no request field, header
   or environment variable that turns it on. It is held in AsyncLocalStorage,
   so it covers exactly the async work started inside the callback and cannot
   leak into a concurrent request that happens to be running. */

const { AsyncLocalStorage } = require("node:async_hooks");

const migrationScope = new AsyncLocalStorage();
const inOwnershipMigration = () => migrationScope.getStore() === true;

/**
 * Run `fn` with ownership writes permitted. For migrations ONLY.
 *
 * Not exported through any route module, not switchable by configuration, and
 * scoped to the callback rather than set globally.
 */
const withOwnershipMigration = (fn) => migrationScope.run(true, fn);

class CompanyOwnershipImmutableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompanyOwnershipImmutableError";
    this.status = 400;
  }
}

const OWNERSHIP_ROOT_KEYS = ["companyId", "companyOwnership"];

/** Is this a path into the ownership stamp — plain, dotted or nested? */
const isOwnershipPath = (key) =>
  OWNERSHIP_ROOT_KEYS.includes(key) || String(key).startsWith("companyOwnership.");

/**
 * A copy of `payload` with every ownership path removed.
 *
 * Handles the dotted form (`"companyOwnership.proven"`), because that is how a
 * partial nested update is spelled and stripping only the root key would let
 * it through — the whole point of the "nested payloads cannot partially alter
 * the stamp" rule. Also descends one level into update operators (`$set`,
 * `$setOnInsert`, `$unset`, `$rename` …), since a route that builds a query
 * update rather than a plain body is the same hole in different syntax.
 *
 * Never mutates its argument: audit code downstream still logs what the client
 * actually sent, including the part that was refused.
 */
function stripCompanyOwnershipInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isOwnershipPath(key)) continue;
    if (key.startsWith("$") && value && typeof value === "object" && !Array.isArray(value)) {
      const inner = {};
      for (const [k, v] of Object.entries(value)) {
        if (isOwnershipPath(k)) continue;
        /* `$rename: {someField: "companyId"}` names its TARGET in the value. */
        if (key === "$rename" && isOwnershipPath(v)) continue;
        inner[k] = v;
      }
      out[key] = inner;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Does this payload attempt to write ownership anywhere? */
function touchesCompanyOwnership(payload) {
  if (!payload || typeof payload !== "object") return false;
  for (const [key, value] of Object.entries(payload)) {
    if (isOwnershipPath(key)) return true;
    if (key.startsWith("$") && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (isOwnershipPath(k)) return true;
        if (key === "$rename" && isOwnershipPath(v)) return true;
      }
    }
  }
  return false;
}

const stampOf = (doc) => ({
  companyId: doc.companyId ? String(doc.companyId) : null,
  source: doc.companyOwnership?.source ?? null,
  resolvedAt: doc.companyOwnership?.resolvedAt ? +new Date(doc.companyOwnership.resolvedAt) : null,
  proven: doc.companyOwnership?.proven ?? null,
});

const sameStamp = (a, b) =>
  a.companyId === b.companyId && a.source === b.source &&
  a.resolvedAt === b.resolvedAt && a.proven === b.proven;

const REFUSAL =
  "A record's owning company cannot be changed. Ownership is set once, from " +
  "the signed-in user's own company, and is not accepted from a request.";

/**
 * Make the ownership stamp immutable on this schema after creation.
 *
 * ── WHY A VALUE SNAPSHOT AND NOT `modifiedPaths()` ─────────────────────────
 * Mongoose marks a path modified when it applies a DEFAULT to a document that
 * was loaded without it — which is every legacy record, since they predate the
 * field. Trusting `isModified("companyOwnership")` would refuse to save any
 * pre-ownership record at all. So the stamp is snapshotted after hydration
 * (and again after each successful save) and compared by value: only a real
 * assignment differs.
 */
function sealCompanyOwnership(schema) {
  schema.post("init", function () { this.$locals.__ownershipStamp = stampOf(this); });
  schema.post("save", function () { this.$locals.__ownershipStamp = stampOf(this); });

  schema.pre("save", function (next) {
    if (this.isNew || inOwnershipMigration()) return next();
    const at = this.$locals.__ownershipStamp;
    /* No snapshot means the document never came from the database and was
       never saved — there is nothing it could be changing FROM. */
    if (!at || sameStamp(at, stampOf(this))) return next();
    next(new CompanyOwnershipImmutableError(REFUSAL));
  });

  schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "update"], function (next) {
    if (inOwnershipMigration()) return next();
    if (!touchesCompanyOwnership(this.getUpdate())) return next();
    next(new CompanyOwnershipImmutableError(REFUSAL));
  });

  /* A replacement carries no ownership at all, which erases the stamp rather
     than changing it — the same loss by a quieter route. There is no
     legitimate wholesale replacement of a sales source record. */
  schema.pre(["replaceOne", "findOneAndReplace"], function (next) {
    if (inOwnershipMigration()) return next();
    next(new CompanyOwnershipImmutableError(
      "A sales record cannot be replaced wholesale — that would discard its " +
      "owning company. Update the fields you mean to change.",
    ));
  });
}

module.exports = {
  companyOwnershipFields, addCompanyIndexes,
  stripCompanyOwnershipInput, touchesCompanyOwnership, isOwnershipPath,
  sealCompanyOwnership, withOwnershipMigration, inOwnershipMigration,
  CompanyOwnershipImmutableError,
};
