// services/industrialEngineering/ieOperationLibrary.service.js
//
// THE COMPANY OPERATION LIBRARY — IE'S FIRST WRITE PATH (Chunk 2A).
//
// Five things happen here and nothing else: list, read, create, edit, and move
// an operation between ACTIVE and RETIRED. There is no delete, no import, no
// SAM, no approval and no route editing — see the model header for why each of
// those is deliberately absent from this slice.
//
// ── THE TWO CHECKS THAT ARE NOT THE SAME CHECK ──────────────────────────────
// Every write proves both, and neither substitutes for the other:
//
//   1. WHAT THE PERSON MAY DO — an `ie` DepartmentRole of at least `editor`,
//      re-read from the database on every request. This is authorisation.
//   2. WHOSE DATA IT IS — a company membership row, resolved by the shared
//      company-context service. This is tenancy.
//
// A person with an `ie` owner grant and no membership in company A cannot touch
// company A's library; a person with a membership and only a `viewer` grant
// cannot write anything anywhere. The route wires both; this service refuses to
// act without a resolved company at all (`assertContext`), so a future caller
// that forgets one gets an error rather than a cross-tenant write.
//
// ── NON-DISCLOSURE ──────────────────────────────────────────────────────────
// Every lookup is `{ _id, companyId }`. An operation that does not exist, one
// that belongs to another company, and an id that is not an ObjectId are ONE
// answer: `IE_OPERATION_NOT_FOUND`. Returning 403 for the foreign case would
// confirm that a competitor's operation exists, and "does this id exist" is
// exactly the question a tenant boundary must not answer.
//
// ── EVERY MUTATION IS ONE CONDITIONAL DATABASE OPERATION ────────────────────
// Read-compare-write is not optimistic concurrency, it is a race with a
// comment: two requests can both read revision 1, both find it acceptable, and
// both save revision 2 — one engineer's change silently gone. So no mutation
// here reads a document and then saves it. Each is a single
// `findOneAndUpdate` whose FILTER carries the whole precondition —
//
//     { _id, companyId, revision: expectedRevision, status: <required state> }
//
// — and whose update increments the revision in the same operation. MongoDB
// applies a single-document update atomically, so exactly one of two
// simultaneous requests can match; the other matches nothing.
//
// Matching nothing is not an answer by itself, so a miss is followed by ONE
// company-scoped re-read to say which precondition failed: no such operation
// here (404), the wrong lifecycle state (409 already-retired / already-active),
// or a revision that moved (409 conflict). That re-read is scoped to
// `{ _id, companyId }` exactly like every other lookup, so a foreign
// operation is still indistinguishable from one that never existed.
//
// A query update runs no document middleware, so anything the schema would
// have derived on `save()` — `codeNormalised`, the field the unique index is
// built on — is written EXPLICITLY in the `$set`. Leaving it to a hook that
// does not run is how a renamed code keeps its old uniqueness key.
//
// ── UNKNOWN FIELDS ARE REFUSED, BY NAME ─────────────────────────────────────
// One documented rule for the whole surface: a body may carry only the
// allowlisted keys, and anything else is `FIELD_NOT_ACCEPTED` naming the key.
// Ignoring unknown keys silently is what lets a client believe it set a SAM
// this slice does not store — and a caller who is told which key was refused
// can fix it, where a caller whose field vanished cannot.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
/* `fail` takes the KEY, not the table entry: StorePurchaseError looks the key
   up in CODES and falls back to VALIDATION for anything it cannot find, so a
   `fail(CODES.X, …)` silently answers 400 VALIDATION for every refusal. */
const { fail } = require("../storePurchase/errors");
const { literalRegex, encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");

const { LIMITS, WORKER_TYPES, normaliseCode, displayCode } = IeOperation;

const STATUS = Object.freeze({ ACTIVE: "ACTIVE", RETIRED: "RETIRED" });

/* ── THE ALLOWLIST ────────────────────────────────────────────────────────
   The writable surface of Chunk 2A, stated once. `expectedRevision` is not a
   stored field — it is the concurrency token — so it is accepted on every
   mutation and never assigned. */
const WRITABLE = Object.freeze(["code", "name", "machineType", "aliases"]);
const CREATE_FIELDS = Object.freeze([...WRITABLE]);
const EDIT_FIELDS = Object.freeze([...WRITABLE, "expectedRevision"]);
const LIFECYCLE_FIELDS = Object.freeze(["expectedRevision"]);

/* ── FIELDS THIS DOOR REFUSES BY NAME, WITH THE REASON ────────────────────
   Not merely "unknown": each of these is a field somebody will reasonably try
   to send, and a message naming where it actually lives is worth more than
   "not accepted". They are refused rather than accepted-and-dropped so no
   screen can believe it stored an unapproved standard. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  operationId: "its own identity",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  status: "its status — use the retire and restore actions",
  totalSam: "a standard time. SAM arrives with the approval lifecycle, not here",
  samMinutes: "a standard time. SAM arrives with the approval lifecycle, not here",
  durationSeconds: "a standard time. SAM arrives with the approval lifecycle, not here",
  salaryDept: "a salary basis. IE owns the time; payroll owns the money",
  salaryDesig: "a salary basis. IE owns the time; payroll owns the money",
  skill: "a skill grade, which this slice does not model yet",
  attachments: "attachments, which this slice does not model yet",
});

/* ═══ CONTEXT ══════════════════════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const notFound = () => fail("IE_OPERATION_NOT_FOUND", "That operation was not found.");

/* ═══ THE PUBLISHED SHAPE ══════════════════════════════════════════════════
 *
 * Built field by field. `codeNormalised` is persistence — it exists so an index
 * can be unique — and publishing it would invite a client to compare on it and
 * then to send it. `__v`, `createdBy` ids and the raw document are likewise not
 * part of the contract; the two `*ByName` strings are, because "who retired
 * this" is a question the register is asked constantly.
 */
function publish(doc) {
  return {
    operationId: String(doc._id),
    companyId: String(doc.companyId),
    code: doc.code,
    name: doc.name,
    machineType: doc.machineType || "",
    aliases: Array.isArray(doc.aliases) ? [...doc.aliases] : [],
    status: doc.status,
    isActive: doc.status === STATUS.ACTIVE,
    revision: doc.revision,
    statusChangedAt: doc.statusChangedAt ? new Date(doc.statusChangedAt).toISOString() : null,
    statusChangedByName: doc.statusChangedByName || "",
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

/* ═══ VALIDATION ═══════════════════════════════════════════════════════════
 *
 * ── THE FIELD-ERROR SHAPE LANE B BINDS TO ─────────────────────────────────
 * Every refusal a FORM can fix carries:
 *
 *   details.fieldErrors = [{ field, code, message }]
 *   details.field       = fieldErrors[0].field
 *
 * The array because a form with three empty inputs should light all three at
 * once rather than one per round trip; the singular `field` because every
 * existing screen in this codebase already reads `details.field` (see
 * services/sales/costingBrief.service.js) and dropping it would make this
 * chunk a regression for a client that follows the established shape.
 *
 * `code` is a stable machine reason — REQUIRED, TOO_LONG, INVALID, TOO_MANY,
 * NOT_A_LIST, NOT_AN_INTEGER, NOT_ACCEPTED, DUPLICATE_ACTIVE_CODE — so a
 * client can decide what to say without parsing prose.
 */
class FieldErrors {
  constructor() { this.list = []; }
  add(field, code, message) { this.list.push({ field, code, message }); return this; }
  get any() { return this.list.length > 0; }
  throwIfAny(message = "Some of these details need fixing.") {
    if (!this.any) return;
    throw fail("VALIDATION", message, {
      fieldErrors: this.list,
      field: this.list[0].field,
    });
  }
}

/** Refuse a body that names something this door does not accept. */
function assertShape(body, allowed, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `That is not ${label}.`);
  }
  for (const key of Object.keys(body)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED",
        `An operation in this library cannot carry ${refused}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `This library does not accept "${key}".` }] });
    }
    if (!allowed.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${label}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of ${label}.` }] });
    }
  }
}

const isString = (v) => typeof v === "string";

/** A code a person can read, quote and search for. */
function shapeCode(raw, errs) {
  if (!isString(raw)) {
    errs.add("code", "REQUIRED", "Give this operation a code.");
    return null;
  }
  const display = displayCode(raw);
  if (!display) {
    errs.add("code", "REQUIRED", "Give this operation a code.");
    return null;
  }
  if (display.length > LIMITS.CODE) {
    errs.add("code", "TOO_LONG", `A code is at most ${LIMITS.CODE} characters.`);
    return null;
  }
  /* Printable, and starting with a letter or digit. A code beginning with a
     dash or a space is a code nobody can dictate over a telephone, and one
     containing a control character corrupts every export it appears in. */
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(display)) {
    errs.add("code", "INVALID",
      "A code may use letters, digits, spaces and . _ / - and must start with a letter or digit.");
    return null;
  }
  return display;
}

function shapeName(raw, errs) {
  if (!isString(raw) || !raw.trim()) {
    errs.add("name", "REQUIRED", "Give this operation a name.");
    return null;
  }
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > LIMITS.NAME) {
    errs.add("name", "TOO_LONG", `A name is at most ${LIMITS.NAME} characters.`);
    return null;
  }
  return name;
}

function shapeMachineType(raw, errs) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (!isString(raw)) {
    errs.add("machineType", "INVALID", "A machine type is text.");
    return null;
  }
  const machine = raw.trim().replace(/\s+/g, " ");
  if (machine.length > LIMITS.MACHINE_TYPE) {
    errs.add("machineType", "TOO_LONG", `A machine type is at most ${LIMITS.MACHINE_TYPE} characters.`);
    return null;
  }
  return machine;
}

/**
 * Aliases, deduplicated case-insensitively and against the code itself.
 *
 * Deduplication is normalisation rather than refusal: sending "Overlock" twice,
 * or sending the code as one of its own synonyms, is a harmless import artefact
 * and the response echoes exactly what was stored, so nothing is hidden. What
 * IS refused is a shape that cannot be stored — a non-list, a non-string entry,
 * an over-long synonym, or more than the cap.
 */
function shapeAliases(raw, code, errs) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errs.add("aliases", "NOT_A_LIST", "Aliases are a list of alternative names.");
    return null;
  }
  if (raw.length > LIMITS.ALIASES) {
    errs.add("aliases", "TOO_MANY", `An operation may hold at most ${LIMITS.ALIASES} aliases.`);
    return null;
  }
  const out = [];
  const seen = new Set(code ? [normaliseCode(code)] : []);
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!isString(entry)) {
      errs.add("aliases", "INVALID", "Every alias is text.");
      return null;
    }
    const alias = entry.trim().replace(/\s+/g, " ");
    if (!alias) continue;
    if (alias.length > LIMITS.ALIAS) {
      errs.add("aliases", "TOO_LONG", `An alias is at most ${LIMITS.ALIAS} characters.`);
      return null;
    }
    const key = alias.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * The concurrency token, as a NUMBER — checked for shape only.
 *
 * Whether it MATCHES is not decided here: that comparison belongs in the
 * update's filter, where it is applied atomically with the write. This
 * function only refuses a token that could never match anything, and it does
 * so before any database work so a malformed body costs nothing.
 */
function readExpectedRevision(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") {
    throw fail("VALIDATION", "Say which revision of this operation you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this operation you read." }],
    });
  }
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

/* ═══ LOOKUP ═══════════════════════════════════════════════════════════════ */

/** One operation of THIS company, or the one non-disclosing refusal. */
function ownedId(ctx, operationId) {
  assertContext(ctx);
  if (!operationId || !mongoose.Types.ObjectId.isValid(String(operationId))) throw notFound();
  return new mongoose.Types.ObjectId(String(operationId));
}

async function loadOwned(ctx, operationId) {
  const doc = await IeOperation.findOne({ _id: ownedId(ctx, operationId), companyId: ctx.companyId }).lean();
  if (!doc) throw notFound();
  return doc;
}

/**
 * Why a conditional update matched nothing — the ONE re-read, and no more.
 *
 * ALWAYS THROWS. A miss has three possible causes and every one of them is a
 * refusal, so there is no "it was fine after all" path out of here.
 *
 * Called only after a miss, and scoped to this company, so it cannot be used
 * to ask about anybody else's register. It answers in the order a person needs
 * to hear: does this exist for you at all, is it in the wrong state for what
 * you asked, and only then did somebody save first. State before revision
 * deliberately: telling an engineer their revision is stale, when the real
 * situation is that the operation was retired, sends them to re-read and try
 * again for ever.
 */
async function explainMiss(ctx, _id, { expected, requiredStatus }) {
  const current = await IeOperation.findOne({ _id, companyId: ctx.companyId })
    .select("_id status revision")
    .lean();
  if (!current) throw notFound();

  if (requiredStatus && current.status !== requiredStatus) {
    if (current.status === STATUS.RETIRED) {
      throw fail("IE_OPERATION_ALREADY_RETIRED",
        requiredStatus === STATUS.ACTIVE && expected === current.revision
          ? "This operation is retired. Restore it before changing it."
          : "This operation is already retired.",
        {
          operationId: String(current._id),
          status: current.status,
          ...(requiredStatus === STATUS.ACTIVE ? { allowedAction: "restore" } : {}),
        });
    }
    throw fail("IE_OPERATION_ALREADY_ACTIVE", "This operation is already active.",
      { operationId: String(current._id), status: current.status });
  }

  /* Not the caller's mistake and not fixable by re-sending: somebody else
     saved first, and applying this body would erase their change. */
  throw fail("IE_OPERATION_REVISION_CONFLICT",
    "Somebody changed this operation while you were editing it. Re-read it and decide again.",
    { expected, actual: current.revision, operationId: String(current._id) });
}

/**
 * The active row of this company holding this code, if any.
 *
 * A pre-check, and honest about being one: between this read and the write the
 * index is what actually guarantees uniqueness (`duplicateCode` below turns the
 * lost race into the same answer). It exists so the ordinary case gets a
 * message naming the operation that already holds the code, rather than a
 * database error the form cannot explain.
 */
function findActiveWithCode(ctx, code, exceptId = null) {
  const query = {
    companyId: ctx.companyId,
    codeNormalised: normaliseCode(code),
    status: STATUS.ACTIVE,
  };
  if (exceptId) query._id = { $ne: exceptId };
  return IeOperation.findOne(query).select("_id code name").lean();
}

/** Is this the unique index refusing a duplicate active code? */
const isDuplicateKey = (err) =>
  err?.code === 11000 || /E11000|duplicate key/i.test(String(err?.message || ""));

/**
 * The duplicate-active-code refusal, in its two situations.
 *
 * ── THE RESTORE MESSAGE NAMES THE ONE ACTION THAT EXISTS ────────────────────
 * It used to offer "give this one a different code" — advice this API cannot
 * carry out. A retired operation cannot be edited (that is the frozen-history
 * rule, and it stays), and `restore` accepts nothing but `expectedRevision`,
 * so there is no request anybody could send that re-codes it. The only
 * executable resolution is to retire whichever active operation holds the code
 * and then retry the restore, so that is what it says — and `resolution`
 * carries the same instruction as a stable machine value, with the id of the
 * operation to retire beside it.
 */
const codeTaken = (code, holder = null, restore = false) => fail(
  restore ? "IE_OPERATION_RESTORE_CODE_CONFLICT" : "IE_OPERATION_CODE_TAKEN",
  restore
    ? `${code} is now used by an active operation. Retire that one, then try restoring this operation again.`
    : `${code} is already used by an active operation in your company.`,
  {
    code,
    ...(holder ? { conflictingOperationId: String(holder._id), conflictingName: holder.name } : {}),
    ...(restore ? { resolution: "RETIRE_CONFLICTING_THEN_RESTORE" } : {}),
    fieldErrors: [{ field: "code", code: "DUPLICATE_ACTIVE_CODE", message: `${code} is already used by an active operation.` }],
    field: "code",
  },
);

/* ═══ READING ══════════════════════════════════════════════════════════════ */

/**
 * The company's library, one page at a time.
 *
 * Retired rows are INCLUDED by default and labelled, not hidden: a style
 * written last season names an operation that may since have been retired, and
 * a register that stops showing it makes that style unreadable. `status=ACTIVE`
 * narrows it for a picker, which is the one place only live options belong.
 */
async function listOperations(ctx, { q = "", status = "", limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "name");

  const wanted = String(status || "").trim().toUpperCase();
  if (wanted && !Object.values(STATUS).includes(wanted)) {
    throw fail("VALIDATION", "A status filter is ACTIVE or RETIRED.", {
      field: "status",
      fieldErrors: [{ field: "status", code: "INVALID", message: "A status filter is ACTIVE or RETIRED." }],
    });
  }

  const and = [{ companyId: ctx.companyId }];
  if (wanted) and.push({ status: wanted });

  const term = String(q ?? "").trim();
  if (term) {
    /* Name, code and the aliases — which is what aliases are FOR. A literal
       regex, so a caller's bracket is a character and not a syntax error. */
    const rx = literalRegex(term);
    and.push({ $or: [{ name: rx }, { code: rx }, { aliases: rx }] });
  }
  if (after) {
    and.push({
      $or: [
        { name: { $gt: after.n } },
        { name: after.n, _id: { $gt: new mongoose.Types.ObjectId(after.i) } },
      ],
    });
  }

  const found = await IeOperation.find({ $and: and })
    .sort({ name: 1, _id: 1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    scope: Object.freeze({
      companyScoped: true,
      register: "IE_COMPANY_OPERATION_LIBRARY",
      message: "This library belongs to the company you are working in. "
        + "The older global operation register is a separate list and is not shown here.",
    }),
    rows: page.map(publish),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size ? encodeCursor({ n: String(last?.name ?? ""), i: String(last?._id) }) : null,
    sort: "name:asc,_id:asc",
    statusFilter: wanted || null,
  };
}

/** One operation, published. */
async function readOperation(ctx, { operationId } = {}) {
  const doc = await loadOwned(ctx, operationId);
  return { operation: publish(doc) };
}

/* ═══ WRITING ══════════════════════════════════════════════════════════════ */

const actorName = (actor) => String(actor?.name || actor?.email || "").trim();
const actorId = (actor) => (mongoose.Types.ObjectId.isValid(String(actor?.id))
  ? new mongoose.Types.ObjectId(String(actor.id))
  : null);

/** CREATE one operation in the acting company's library. */
async function createOperation(ctx, { body = {}, actor = null } = {}) {
  assertContext(ctx);
  assertShape(body, CREATE_FIELDS, "an operation");

  const errs = new FieldErrors();
  const code = shapeCode(body.code, errs);
  const name = shapeName(body.name, errs);
  const machineType = shapeMachineType(body.machineType, errs);
  const aliases = shapeAliases(body.aliases, code, errs);
  errs.throwIfAny("This operation cannot be created yet.");

  const holder = await findActiveWithCode(ctx, code);
  if (holder) throw codeTaken(code, holder);

  try {
    const doc = await IeOperation.create({
      companyId: ctx.companyId,
      code,
      name,
      machineType,
      aliases,
      status: STATUS.ACTIVE,
      revision: 1,
      createdBy: actorId(actor),
      createdByName: actorName(actor),
      updatedBy: actorId(actor),
      updatedByName: actorName(actor),
    });
    return { operation: publish(doc), created: true };
  } catch (err) {
    /* THE RACE, ANSWERED THE SAME WAY AS THE PRE-CHECK. Two requests can pass
       `findActiveWithCode` together; only one passes the unique index. The
       loser is a duplicate-code refusal, not a 500. */
    if (isDuplicateKey(err)) throw codeTaken(code, await findActiveWithCode(ctx, code));
    throw err;
  }
}

/**
 * EDIT an operation. Only the allowlisted fields, and only while it is active.
 *
 * ── WHY A RETIRED OPERATION CANNOT BE EDITED ────────────────────────────────
 * A retired row is history that other records point at. Renaming or re-coding
 * it would rewrite what a style was engineered against, silently. The only
 * thing that may happen to a retired row is `restore` — the specifically
 * permitted lifecycle action — after which it is editable again.
 */
async function updateOperation(ctx, { operationId, body = {}, actor = null } = {}) {
  const _id = ownedId(ctx, operationId);
  assertShape(body, EDIT_FIELDS, "an operation");
  const expected = readExpectedRevision(body.expectedRevision);

  const errs = new FieldErrors();
  const touched = {};
  if ("code" in body) {
    const code = shapeCode(body.code, errs);
    if (code) {
      touched.code = code;
      /* Written explicitly: a query update runs no `pre("validate")` hook, so
         the key the unique index is built on would otherwise keep the OLD
         code — two live operations, one uniqueness key, and the index none the
         wiser. */
      touched.codeNormalised = normaliseCode(code);
    }
  }
  if ("name" in body) {
    const name = shapeName(body.name, errs);
    if (name) touched.name = name;
  }
  if ("machineType" in body) {
    const machineType = shapeMachineType(body.machineType, errs);
    if (machineType !== null) touched.machineType = machineType;
  }
  if ("aliases" in body) {
    /* Deduplicated against the code this edit LEAVES the operation with. The
       stored code is read here only to shape the aliases; nothing about the
       decision to write depends on it. */
    let against = touched.code;
    if (!against) {
      const current = await IeOperation.findOne({ _id, companyId: ctx.companyId }).select("code").lean();
      if (!current) throw notFound();
      against = current.code;
    }
    const aliases = shapeAliases(body.aliases, against, errs);
    if (aliases !== null) touched.aliases = aliases;
  }
  errs.throwIfAny("This operation cannot be saved yet.");

  if (touched.code) {
    /* A friendly pre-check that can name the holder. The INDEX is what
       actually decides — see the duplicate-key branch below. */
    const holder = await findActiveWithCode(ctx, touched.code, _id);
    if (holder) throw codeTaken(touched.code, holder);
  }

  /* ── THE WHOLE PRECONDITION IS THE FILTER ────────────────────────────────
     Ownership, the revision the caller composed against, and "still active" —
     all three checked by the database in the same operation that writes, and
     the revision incremented there too. Two simultaneous edits both quoting
     revision 1 cannot both match. `status: ACTIVE` is part of it because a
     retired operation is frozen history: restore is its only door. */
  let updated;
  try {
    updated = await IeOperation.findOneAndUpdate(
      { _id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
      {
        $set: { ...touched, updatedBy: actorId(actor), updatedByName: actorName(actor) },
        /* Every accepted mutation moves the revision, an alias-only edit
           included: the revision means "this record moved", which is what a
           stale form needs to know. */
        $inc: { revision: 1 },
      },
      { new: true },
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) throw codeTaken(touched.code || "That code", await findActiveWithCode(ctx, touched.code, _id));
    throw err;
  }

  if (!updated) await explainMiss(ctx, _id, { expected, requiredStatus: STATUS.ACTIVE });
  return { operation: publish(updated), updated: true };
}

/**
 * RETIRE an operation. Reversible, and it deletes nothing.
 *
 * The record stays readable, keeps its code, keeps its history and keeps its
 * identity, so every style and bulletin that names it still resolves. What
 * changes is that it stops being offered, and stops holding its code against
 * the unique index — see the code-reuse decision below.
 */
async function retireOperation(ctx, { operationId, body = {}, actor = null } = {}) {
  const _id = ownedId(ctx, operationId);
  assertShape(body, LIFECYCLE_FIELDS, "a retirement");
  const expected = readExpectedRevision(body.expectedRevision);

  const now = new Date();
  const updated = await IeOperation.findOneAndUpdate(
    /* `status: ACTIVE` in the filter is what makes a second simultaneous
       retirement — and a retire racing an edit — match nothing. */
    { _id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
    {
      $set: {
        status: STATUS.RETIRED,
        statusChangedAt: now,
        statusChangedBy: actorId(actor),
        statusChangedByName: actorName(actor),
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
    },
    { new: true },
  ).lean();

  if (!updated) await explainMiss(ctx, _id, { expected, requiredStatus: STATUS.ACTIVE });
  return { operation: publish(updated), retired: true };
}

/**
 * RESTORE a retired operation.
 *
 * ── THE CODE-REUSE DECISION ─────────────────────────────────────────────────
 * Retiring an operation RELEASES its code: the unique index only counts ACTIVE
 * rows, so `SEW-01` can be registered again the moment the old `SEW-01` is
 * retired. That is deliberate. A factory renumbers and re-issues operation
 * codes, and a register that reserved every code ever used would force
 * `SEW-01-NEW` on somebody within a season.
 *
 * The cost is that a restore can fail, and it must: if another active operation
 * now holds the code, restoring this one would put two live `SEW-01` in one
 * company — the exact ambiguity the legacy register suffers from. So the
 * restore is refused with `IE_OPERATION_RESTORE_CODE_CONFLICT`, naming the
 * operation that took the code, and the fix is a decision a person makes (give
 * this one a different code, or retire the other). Nothing is renamed
 * automatically.
 */
async function restoreOperation(ctx, { operationId, body = {}, actor = null } = {}) {
  const _id = ownedId(ctx, operationId);
  assertShape(body, LIFECYCLE_FIELDS, "a restore");
  const expected = readExpectedRevision(body.expectedRevision);

  const now = new Date();
  let updated;
  try {
    updated = await IeOperation.findOneAndUpdate(
      { _id, companyId: ctx.companyId, revision: expected, status: STATUS.RETIRED },
      {
        $set: {
          status: STATUS.ACTIVE,
          statusChangedAt: now,
          statusChangedBy: actorId(actor),
          statusChangedByName: actorName(actor),
          updatedBy: actorId(actor),
          updatedByName: actorName(actor),
        },
        $inc: { revision: 1 },
      },
      { new: true },
    ).lean();
  } catch (err) {
    /* The partial unique index counts ACTIVE rows, so this update is exactly
       when the code has to be free — and the index says so, whether the
       competing operation was registered a week ago or a millisecond ago. No
       pre-check is needed for correctness; the refusal below adds the name of
       the operation to retire. */
    if (!isDuplicateKey(err)) throw err;
    const mine = await IeOperation.findOne({ _id, companyId: ctx.companyId }).select("code").lean();
    if (!mine) throw notFound();
    throw codeTaken(mine.code, await findActiveWithCode(ctx, mine.code, _id), true);
  }

  /* A taken code raises E11000 above rather than missing the filter, so a
     miss here is ownership, lifecycle state or revision — nothing else. */
  if (!updated) await explainMiss(ctx, _id, { expected, requiredStatus: STATUS.RETIRED });
  return { operation: publish(updated), restored: true };
}

/* ═══ RESOURCE REQUIREMENTS (Chunk 5A) ═════════════════════════════════════
 *
 * What an operation NEEDS to be run: machine types, attachments, and operators
 * or helpers at a skill and grade. Requirements, never allocations — there is
 * no field here for a person, a serial number, an availability or a capacity,
 * and the model header says why the rows are snapshots rather than foreign keys.
 *
 * ── ONE DOOR, NOT A GENERAL MUTATION HELPER ─────────────────────────────────
 * `updateRequirements` is the only writer, it accepts exactly three named
 * groups, and it is the only thing exported for writing. There is deliberately
 * no `setField(operation, path, value)`: a generic helper would make the next
 * field somebody adds writable without anybody deciding it should be.
 */

const REQUIREMENT_FIELDS = Object.freeze(["machineRequirements", "attachmentRequirements", "labourRequirements"]);
const REQUIREMENT_PATCH_FIELDS = Object.freeze(["expectedRevision", ...REQUIREMENT_FIELDS]);

/** Which stored group each request field writes, and what to call it. */
const GROUPS = Object.freeze([
  { field: "machineRequirements", key: "machine", label: "machine types" },
  { field: "attachmentRequirements", key: "attachment", label: "attachments" },
  { field: "labourRequirements", key: "labour", label: "operators and helpers" },
]);

const ROW_FIELDS = Object.freeze({
  machine: ["requirementId", "machineType", "quantity"],
  attachment: ["requirementId", "code", "name", "quantity", "note"],
  labour: ["requirementId", "workerType", "quantity", "skillCode", "skillName", "grade", "note"],
});

/* Fields somebody will reasonably try to send, refused by name with where the
   fact actually lives. A requirement that could name a person or a machine
   would turn this record into an allocation, which is a different department's
   decision and a different chunk. */
const ROW_REFUSED = Object.freeze({
  sequence: "its own position — the order of the list is the sequence",
  employeeId: "an employee. A requirement says what the work needs, never who does it",
  employeeName: "an employee. A requirement says what the work needs, never who does it",
  operatorName: "an operator. A requirement says what the work needs, never who does it",
  machineId: "a specific machine. IE requires a machine TYPE; which machine is Maintenance's record",
  serialNumber: "a machine serial number, which is an asset record and not a requirement",
  assetId: "an asset id, which is an asset record and not a requirement",
  available: "availability, which is Maintenance's and HR's answer and not a requirement",
  availableQuantity: "availability, which is Maintenance's and HR's answer and not a requirement",
  capacity: "a capacity figure, which is calculated from requirements and is a later chunk",
  wageRate: "a wage. IE owns the requirement; payroll owns the money",
  salary: "a salary. IE owns the requirement; payroll owns the money",
});

const mintRequirementId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `ope_${crypto.randomBytes(9).toString("hex")}`;

/** Codes and grades are compared in one normalised form, stored as typed. */
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const normaliseToken = (v) => text(v).replace(/\s+/g, " ").toUpperCase();
const displayToken = (v) => text(v).replace(/\s+/g, " ");

const requirementEvent = (actor, { operationRevision, changed, summary }) => ({
  eventId: mintEventId(),
  type: "OPERATION_REQUIREMENTS_UPDATED",
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  operationRevision,
  changed,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

class RequirementErrors {
  constructor() { this.list = []; }
  /** Every row names itself: by `requirementId` when it has one — a list
   *  reordered on screen is not addressable by index — and by the submitted
   *  index either way. */
  add(field, code, message, { requirementId = "", index = null } = {}) {
    this.list.push({ field, code, message, ...(requirementId ? { requirementId } : {}), ...(index === null ? {} : { index }) });
    return this;
  }
  get any() { return this.list.length > 0; }
  throwIfAny(codeKey, message) {
    if (!this.any) return;
    throw fail(codeKey, message, { fieldErrors: this.list, field: this.list[0].field });
  }
}

/** A positive whole number of things. Fractions are a measurement, not a count. */
function readQuantity(raw, field, errs, ctxRow) {
  if (raw === undefined || raw === null || raw === "") {
    errs.add(field, "REQUIRED", "Say how many are required.", ctxRow);
    return null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errs.add(field, "INVALID", "A quantity is a number.", ctxRow);
    return null;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > LIMITS.QUANTITY) {
    errs.add(field, "OUT_OF_RANGE", `A quantity is a whole number from 1 to ${LIMITS.QUANTITY}.`, ctxRow);
    return null;
  }
  return raw;
}

function readRowText(raw, field, max, errs, ctxRow, { required = false, label = "This" } = {}) {
  if (raw === undefined || raw === null) {
    if (required) errs.add(field, "REQUIRED", `${label} is required.`, ctxRow);
    return "";
  }
  if (typeof raw !== "string") {
    errs.add(field, "INVALID", `${label} is text.`, ctxRow);
    return "";
  }
  const text = displayToken(raw);
  if (required && !text) {
    errs.add(field, "REQUIRED", `${label} is required.`, ctxRow);
    return "";
  }
  if (text.length > max) {
    errs.add(field, "TOO_LONG", `${label} is at most ${max} characters.`, ctxRow);
    return "";
  }
  return text;
}

/**
 * Shape one group of requirement rows.
 *
 * EVERYTHING is validated before anything is written: one bad row refuses the
 * whole profile, because a half-applied requirement list is a specification
 * nobody authored. An id the operation already holds keeps that row's identity
 * through renaming and reordering; an id it does not hold is refused rather
 * than quietly minted, because a client sending an unknown id is out of step
 * with the record and inventing the row would hide that.
 */
function shapeRequirementGroup(key, list, existingById) {
  const label = GROUPS.find((g) => g.key === key).field;
  if (!Array.isArray(list)) {
    throw fail("IE_OPERATION_REQUIREMENTS_INVALID", `\`${label}\` is a list. Send an empty list to record that none are required.`, {
      field: label,
      fieldErrors: [{ field: label, code: "NOT_A_LIST", message: `\`${label}\` is a list.` }],
    });
  }
  const cap = { machine: LIMITS.MACHINE_REQUIREMENTS, attachment: LIMITS.ATTACHMENT_REQUIREMENTS, labour: LIMITS.LABOUR_REQUIREMENTS }[key];
  if (list.length > cap) {
    throw fail("IE_OPERATION_REQUIREMENTS_INVALID", `An operation holds at most ${cap} ${GROUPS.find((g) => g.key === key).label}.`, {
      field: label,
      fieldErrors: [{ field: label, code: "TOO_MANY", message: `At most ${cap} rows.` }],
    });
  }

  const errs = new RequirementErrors();
  const quantityErrs = new RequirementErrors();
  const seenIds = new Set();
  const seenKeys = new Map();
  const shaped = [];

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    const at = (f) => `${label}.${index}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.add(`${label}.${index}`, "INVALID", "Every requirement is an object.", { index });
      continue;
    }
    for (const field of Object.keys(raw)) {
      const refused = ROW_REFUSED[field];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `A requirement cannot carry ${refused}.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `A requirement cannot carry "${field}".`, index }] });
      }
      if (!ROW_FIELDS[key].includes(field)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a ${key} requirement.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not part of a ${key} requirement.`, index }] });
      }
    }

    let requirementId = text(raw.requirementId);
    if (requirementId) {
      if (!existingById.has(requirementId)) {
        /* Its own code: an unknown id is a client out of step with the record,
           not a badly typed field. */
        throw fail("IE_OPERATION_REQUIREMENT_NOT_FOUND",
          "That requirement is not part of this operation.",
          {
            field: at("requirementId"), requirementId, index,
            fieldErrors: [{ field: at("requirementId"), code: "UNKNOWN_REQUIREMENT", message: "That requirement is not part of this operation.", requirementId, index }],
          });
      }
      if (seenIds.has(requirementId)) {
        throw fail("IE_OPERATION_REQUIREMENT_NOT_FOUND", "The same requirement appears twice.",
          {
            field: at("requirementId"), requirementId, index,
            fieldErrors: [{ field: at("requirementId"), code: "DUPLICATE_REQUIREMENT_ID", message: "The same requirement appears twice.", requirementId, index }],
          });
      }
      seenIds.add(requirementId);
    } else {
      requirementId = mintRequirementId({ machine: "mreq", attachment: "areq", labour: "lreq" }[key]);
    }
    const rowCtx = { requirementId, index };

    const quantity = readQuantity(raw.quantity, at("quantity"), quantityErrs, rowCtx);
    const row = { requirementId, sequence: shaped.length + 1, quantity };
    let dedupeKey = null;
    let duplicateCode = null;
    let duplicateField = null;

    if (key === "machine") {
      row.machineType = readRowText(raw.machineType, at("machineType"), LIMITS.MACHINE_TYPE, errs, rowCtx, { required: true, label: "A machine type" });
      dedupeKey = normaliseToken(row.machineType);
      duplicateCode = "IE_OPERATION_REQUIREMENT_MACHINE_DUPLICATE";
      duplicateField = at("machineType");
    } else if (key === "attachment") {
      row.code = normaliseToken(readRowText(raw.code, at("code"), LIMITS.CODE, errs, rowCtx, { required: true, label: "An attachment code" }));
      row.name = readRowText(raw.name, at("name"), LIMITS.NAME, errs, rowCtx, { required: true, label: "An attachment name" });
      row.note = readRowText(raw.note, at("note"), LIMITS.REQUIREMENT_NOTE, errs, rowCtx);
      dedupeKey = row.code;
      duplicateCode = "IE_OPERATION_REQUIREMENT_ATTACHMENT_DUPLICATE";
      duplicateField = at("code");
    } else {
      const workerType = normaliseToken(raw.workerType);
      if (!WORKER_TYPES.includes(workerType)) {
        errs.add(at("workerType"), "INVALID", `A worker type is ${WORKER_TYPES.join(" or ")}.`, rowCtx);
      }
      row.workerType = WORKER_TYPES.includes(workerType) ? workerType : "";
      row.skillCode = normaliseToken(readRowText(raw.skillCode, at("skillCode"), LIMITS.CODE, errs, rowCtx));
      row.skillName = readRowText(raw.skillName, at("skillName"), LIMITS.NAME, errs, rowCtx);
      row.grade = normaliseToken(readRowText(raw.grade, at("grade"), LIMITS.GRADE, errs, rowCtx));
      row.note = readRowText(raw.note, at("note"), LIMITS.REQUIREMENT_NOTE, errs, rowCtx);
      /* ── WHAT MAKES TWO LABOUR ROWS THE SAME REQUIREMENT ────────────────
         The same role at the same skill and grade twice is one requirement for
         a larger quantity, not two rows — two rows would make "how many grade B
         operators" have two answers.

         The skill is identified by its CODE where there is one, so renaming a
         coded skill does not turn one requirement into two. Where there is no
         code — which is most of a factory's vocabulary today, since no skill
         master exists — the normalised NAME identifies it instead. Keying on
         the code alone treated "Sewing" and "Cutting" as the same requirement
         whenever both were uncoded, which is two different jobs collapsed into
         one. Two rows with no skill at all are still duplicates: they say the
         same thing twice. */
      const skillKey = row.skillCode || normaliseToken(row.skillName);
      dedupeKey = [row.workerType, skillKey, row.grade].join("|");
      duplicateCode = "IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE";
      duplicateField = at("workerType");
    }

    if (dedupeKey && seenKeys.has(dedupeKey)) {
      throw fail(duplicateCode,
        key === "labour"
          ? "The same role, skill and grade is required twice. Record it once with the quantity it needs."
          : `${key === "machine" ? row.machineType : row.code} is required twice. Record it once with the quantity it needs.`,
        {
          field: duplicateField, index, requirementId,
          duplicateOf: seenKeys.get(dedupeKey),
          fieldErrors: [{ field: duplicateField, code: "DUPLICATE", message: "This is required twice. Record it once with the quantity it needs.", requirementId, index }],
        });
    }
    if (dedupeKey) seenKeys.set(dedupeKey, requirementId);
    shaped.push(row);
  }

  /* Quantities first: a form showing "a quantity is a whole number" beside the
     row is more actionable than a generic profile error. */
  quantityErrs.throwIfAny("IE_OPERATION_REQUIREMENT_QUANTITY_INVALID", "Some of these quantities need fixing.");
  errs.throwIfAny("IE_OPERATION_REQUIREMENTS_INVALID", "Some of these requirements need fixing.");
  return shaped;
}

/** The stored profile, published. */
function publishRequirements(doc) {
  const req = doc.requirements || {};
  return {
    /* Explicit: nobody has set a profile yet is not the same fact as "none
       required", and a screen must be able to tell them apart. */
    requirementsConfigured: Boolean(req.configured),
    machineRequirements: (req.machine || []).map((r) => ({
      requirementId: r.requirementId, sequence: r.sequence, machineType: r.machineType, quantity: r.quantity,
    })),
    attachmentRequirements: (req.attachment || []).map((r) => ({
      requirementId: r.requirementId, sequence: r.sequence, code: r.code, name: r.name,
      quantity: r.quantity, note: r.note || "",
    })),
    labourRequirements: (req.labour || []).map((r) => ({
      requirementId: r.requirementId, sequence: r.sequence, workerType: r.workerType, quantity: r.quantity,
      skillCode: r.skillCode || "", skillName: r.skillName || "", grade: r.grade || "", note: r.note || "",
    })),
    /* Totals a screen would otherwise re-derive. They are counts of what is
       REQUIRED — never an availability, a shortage or a capacity. */
    totals: {
      machineTypes: (req.machine || []).length,
      machines: (req.machine || []).reduce((n, r) => n + (r.quantity || 0), 0),
      attachments: (req.attachment || []).reduce((n, r) => n + (r.quantity || 0), 0),
      operators: (req.labour || []).filter((r) => r.workerType === "OPERATOR").reduce((n, r) => n + (r.quantity || 0), 0),
      helpers: (req.labour || []).filter((r) => r.workerType === "HELPER").reduce((n, r) => n + (r.quantity || 0), 0),
    },
    /* This chunk states requirements. It allocates nothing and calculates no
       capacity, and says so rather than letting a screen infer a control. */
    allocates: false,
    updatedByName: doc.updatedByName || "",
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

const publishRequirementEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  operationRevision: e.operationRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

/** One operation of THIS company, or the one non-disclosing refusal. */
async function loadOwnedOperation(ctx, operationId) {
  assertContext(ctx);
  if (!operationId || !mongoose.Types.ObjectId.isValid(String(operationId))) throw notFound();
  const doc = await IeOperation.findOne({
    _id: new mongoose.Types.ObjectId(String(operationId)),
    companyId: ctx.companyId,
  }).lean();
  if (!doc) throw notFound();
  return doc;
}

/** READ the profile. Retired operations read exactly like active ones. */
async function readRequirements(ctx, { operationId } = {}) {
  const doc = await loadOwnedOperation(ctx, operationId);
  return {
    operation: publish(doc),
    requirements: publishRequirements(doc),
    history: [...(doc.history || [])].reverse().map(publishRequirementEvent),
  };
}

/** Rows compared as they are persisted — the no-op test. */
function sameRequirementRows(before = [], after = []) {
  if (before.length !== after.length) return false;
  const fields = ["requirementId", "sequence", "machineType", "code", "name", "workerType", "skillCode", "skillName", "grade", "note"];
  for (let i = 0; i < after.length; i += 1) {
    if ((before[i].quantity ?? null) !== (after[i].quantity ?? null)) return false;
    for (const f of fields) {
      if ((before[i][f] ?? "") !== (after[i][f] ?? "")) return false;
    }
  }
  return true;
}

/**
 * REPLACE one or more requirement groups.
 *
 * Each group is optional and an omitted one is left exactly as it is; at least
 * one has to be present, because a PATCH that names no group is a client that
 * lost its payload rather than a decision. An empty list IS a decision — "none
 * required" — and is stored as one.
 *
 * The write is ONE conditional update carrying ownership, the expected revision
 * and the ACTIVE status, incrementing the revision and appending the audit line
 * in the same operation. A retired operation is refused before any of it: its
 * requirements are the record of what it needed while it was in use.
 */
async function updateRequirements(ctx, { operationId, body = {}, actor = null } = {}) {
  const current = await loadOwnedOperation(ctx, operationId);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "That is not a requirement profile.");
  }
  for (const field of Object.keys(body)) {
    const refused = REFUSED_FIELDS[field] || ROW_REFUSED[field];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A requirement profile cannot carry ${refused}.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `This door does not accept "${field}".` }] });
    }
    if (!REQUIREMENT_PATCH_FIELDS.includes(field)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a requirement profile.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${field}" is not part of a requirement profile.` }] });
    }
  }

  const present = REQUIREMENT_FIELDS.filter((f) => f in body);
  if (!present.length) {
    throw fail("IE_OPERATION_REQUIREMENTS_NO_CHANGE_REQUESTED",
      "Say which requirements you are setting. Send an empty list for a group that is deliberately not required.",
      {
        field: "machineRequirements",
        accepts: [...REQUIREMENT_FIELDS],
        fieldErrors: [{ field: "machineRequirements", code: "REQUIRED", message: "Send at least one requirement group." }],
      });
  }

  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.RETIRED) {
    throw fail("IE_OPERATION_ALREADY_RETIRED",
      "This operation is retired. Its requirements are the record of what it needed — restore it before changing them.",
      { operationId: String(current._id), status: current.status, allowedAction: "restore" });
  }
  if (current.revision !== expected) {
    throw fail("IE_OPERATION_REVISION_CONFLICT",
      "Somebody changed this operation while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, operationId: String(current._id) });
  }

  const stored = current.requirements || {};

  /* ── THE FIRST ANSWER HAS TO BE A COMPLETE ONE ──────────────────────────
     `configured` means "somebody has decided what this operation needs", and
     that decision covers all three groups. Accepting a first PATCH that names
     only machines would store the other two as empty and mark the whole profile
     configured — turning "nobody has answered about attachments" into "no
     attachments are required", which is a statement nobody made and which a
     screen can no longer distinguish from a real one.

     So the first accepted profile states all three, each of which may be an
     explicit `[]`. Afterwards a partial PATCH is exactly right: the groups it
     omits already carry an answer. */
  if (stored.configured !== true) {
    const missing = REQUIREMENT_FIELDS.filter((f) => !(f in body));
    if (missing.length) {
      throw fail("IE_OPERATION_REQUIREMENTS_INVALID",
        "The first requirement profile has to answer all three groups. Send an empty list for any that are not required.",
        {
          field: missing[0],
          missing,
          /* One error per missing group, so a form can mark all of them at
             once rather than one per round trip. */
          fieldErrors: missing.map((field) => ({
            field,
            code: "REQUIRED",
            message: `Say what ${GROUPS.find((g) => g.field === field).label} this operation requires, or send an empty list.`,
          })),
        });
    }
  }

  const next = {};
  const changed = [];
  for (const group of GROUPS) {
    const before = (stored[group.key] || []).map((r) => ({ ...r }));
    if (!(group.field in body)) {
      next[group.key] = before;
      continue;
    }
    const existingById = new Map(before.map((r) => [r.requirementId, r]));
    next[group.key] = shapeRequirementGroup(group.key, body[group.field], existingById);
    if (!sameRequirementRows(before, next[group.key])) changed.push(group.key);
  }

  /* A profile recorded for the first time is a change even when every list is
     empty: "none required" is the decision being made. */
  const firstTime = !stored.configured;
  if (!changed.length && !firstTime) {
    return {
      operation: publish(current),
      requirements: publishRequirements(current),
      updated: false,
      events: [],
    };
  }

  const nextRevision = expected + 1;
  const counts = GROUPS.map((g) => `${next[g.key].length} ${g.label}`).join(", ");
  const audit = requirementEvent(actor, {
    operationRevision: nextRevision,
    changed: changed.length ? changed : ["profile"],
    summary: firstTime && !changed.length
      ? `Recorded requirements: ${counts}`
      : `Changed ${changed.join(", ")} — now ${counts}`,
  });

  const updated = await IeOperation.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
    {
      $set: {
        "requirements.configured": true,
        "requirements.machine": next.machine,
        "requirements.attachment": next.attachment,
        "requirements.labour": next.labour,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      /* Requirements are part of what the operation IS, so changing them moves
         its revision — and a bulletin row keeps the revision it captured, which
         is what stops this reaching an approved standard time. */
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeOperation.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw notFound();
    if (now.status === STATUS.RETIRED) {
      throw fail("IE_OPERATION_ALREADY_RETIRED",
        "This operation was retired while you were editing its requirements.",
        { operationId: String(now._id), status: now.status, allowedAction: "restore" });
    }
    throw fail("IE_OPERATION_REVISION_CONFLICT",
      "Somebody changed this operation while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, operationId: String(now._id) });
  }

  return {
    operation: publish(updated),
    requirements: publishRequirements(updated),
    updated: true,
    events: [publishRequirementEvent(audit)],
  };
}

module.exports = {
  STATUS,
  WRITABLE, CREATE_FIELDS, EDIT_FIELDS, LIFECYCLE_FIELDS, REFUSED_FIELDS,
  publish, normaliseCode,
  listOperations, readOperation,
  createOperation, updateOperation, retireOperation, restoreOperation,
  /* Chunk 5A — requirements. One reader, one writer, and the pure shaper the
     tests exercise directly. No general-purpose mutation helper is exported. */
  REQUIREMENT_FIELDS, REQUIREMENT_PATCH_FIELDS, ROW_FIELDS, ROW_REFUSED, GROUPS,
  publishRequirements, shapeRequirementGroup, sameRequirementRows,
  readRequirements, updateRequirements,
};
