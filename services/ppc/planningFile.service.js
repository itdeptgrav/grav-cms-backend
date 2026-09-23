// services/ppc/planningFile.service.js
//
// PPC'S PLANNING FILE — CREATED ONCE PER LINE, AND NEVER RE-BASED SILENTLY.
//
// ── WHAT A COMMAND HERE MAY AND MAY NOT SETTLE ──────────────────────────────
// A caller settles: which order line (by its permanent reference), and which
// PPC-owned planning fields to record. Everything else is the server's:
//
//   · the company comes from the actor's own membership;
//   · the person comes from the verified session;
//   · the frozen source basis — including the identities of PPC's own receipts
//     for the exact pack and release versions — is READ from the published
//     contracts and PPC's own records at creation time, and never accepted
//     from a body.
//
// A request carrying `sourceBasis`, a pack version, a release id, a receipt id
// or a state is REFUSED BY NAME rather than ignored. Ignoring is worse than
// refusing: a client that believed it was setting the basis would carry on
// believing it, and the first symptom would be a plan whose recorded basis is
// not the one anybody sent.
//
// ── `PLANNED` IS NOT A COMMITMENT TO MAKE ANYTHING — BUT IT IS PERMANENT ────
// It means PPC has finished stating its planning assumptions. No command in
// this file books capacity, allocates a line, promises a start date, releases
// to Production, creates a Work Order or touches Store stock — there is no code
// path to any of those and no field that could hold one.
//
// What PLANNED does mean is that those assumptions are now evidence. A planned
// file's planning fields are never edited again: it may be held (and lifted
// back to PLANNED), superseded by an explicit successor, or cancelled, and
// nothing else. The model refuses every other write itself, so this service is
// not the only thing standing between a planned file and an edit.
//
// ── CONCURRENCY IS THE DATABASE'S JOB, NOT A READ-THEN-WRITE'S ──────────────
// Every state change is one conditional update matched on `{_id, companyId,
// revision, state}`, run inside a transaction with its idempotency ledger row
// (`planningCommand.js`). The new revision is always the MATCHED revision plus
// one — never computed from a document read earlier — so a stale command
// matches nothing, changes nothing and is told the revision to re-read.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  PpcPlanningFile, PLANNING_STATE, ACTIVE_STATES, HOLDABLE_STATES, EDITABLE_STATES,
  PRIORITIES, HOLD_REASON, CANCELLATION_REASON, LIMITS,
} = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const {
  DownstreamHandoverReceipt,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const merch = require("../merchandising/planningPublication.service");
const orderBook = require("./orderBook.service");
const { planningCommand } = require("./planningCommand");
const { isBusinessDate, businessDateFromInstant } = require("./businessDate");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/* ══ WHAT A BODY MAY AND MAY NOT CARRY ════════════════════════════════════ */

/**
 * The PPC-owned fields a browser may select. This list IS the write surface.
 *
 * Note what is not here: no line id, no shift, no booked minutes, no daily
 * target, no release number, no work order. Those belong to later PPC chunks,
 * and a field accepted early is a field a screen starts rendering.
 */
const PERMITTED_FIELDS = Object.freeze([
  "owner", "priority", "proposedFactoryRef",
  "planningNote", "riskNote",
  "requestedProductionStart", "requestedProductionEnd", "requestedCompletionDate",
  "assumptions",
]);

/**
 * Creation takes one more: the reference of the CANCELLED file a new plan
 * follows. Required when one exists, so a new plan after a cancellation is a
 * decision somebody named rather than a duplicate POST that happened to land.
 */
const CREATE_FIELDS = Object.freeze([...PERMITTED_FIELDS, "afterCancelledFileRef"]);

/**
 * Fields whose presence is a refusal, each with the reason a caller needs.
 *
 * Every one of these is either the server's to derive or a later chunk's to
 * introduce. Naming them individually means the refusal explains itself instead
 * of saying "unknown field".
 */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company comes from your own membership, never from a body",
  state: "a lifecycle state is reached through its own command, never by assignment",
  revision: "send the revision you read as `expectedRevision`",
  sourceBasis: "the frozen basis is read from the published sources by the server",
  executionPackId: "an upstream identity is the server's to derive",
  executionPackVersionNo: "an upstream identity is the server's to derive",
  ieReleaseId: "an upstream identity is the server's to derive",
  ieReleaseRef: "an upstream identity is the server's to derive",
  ieReleaseVersionNo: "an upstream identity is the server's to derive",
  ppmMeetingId: "an upstream identity is the server's to derive",
  ppmVersionNo: "an upstream identity is the server's to derive",
  packReceiptId: "PPC's own receipt is the server's to derive",
  packReceiptVersionNo: "PPC's own receipt is the server's to derive",
  ieReceiptId: "PPC's own receipt is the server's to derive",
  ieReceiptVersionNo: "PPC's own receipt is the server's to derive",
  planningFileRef: "the planning file's reference is issued once, by the server",
  orderRef: "the order identity is the server's to derive from the line",
  executionFileId: "the Execution File is the server's to derive from the line",
  sampleStyleId: "the style identity is the server's to derive from the line",
  history: "the audit trail is appended by the server",
  generation: "the generation is the server's to count",
  supersededByFileId: "a successor is created through its own command",
  plannedAt: "a plan is marked planned through its own command",
  cancelledAt: "a plan is cancelled through its own command",
  /* Later chunks, refused now so nobody builds against them by accident. */
  lineId: "line allocation is a later PPC chunk and books nothing here",
  shiftId: "shift allocation is a later PPC chunk",
  bookedMinutes: "capacity booking is a later PPC chunk",
  dailyTarget: "daily targets are a later PPC chunk",
  productionReleaseNo: "releasing to Production is a later PPC chunk",
  workOrderId: "creating a Work Order is a later PPC chunk",
});

function refuseUnknown(body, allowed) {
  const sent = Object.keys(body || {});
  const named = sent.filter((k) => has(REFUSED_FIELDS, k));
  if (named.length) {
    throw fail("PPC_PLANNING_FIELD_REFUSED",
      "Some of those fields are not a planner's to set.",
      {
        fields: named,
        because: Object.fromEntries(named.map((k) => [k, REFUSED_FIELDS[k]])),
      });
  }
  const unknown = sent.filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("PPC_PLANNING_FIELD_UNKNOWN",
      "This command does not take those fields.", { fields: unknown, allowed: [...allowed] });
  }
}

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

function assertActor(actor) {
  if (!actor?.id) {
    throw fail("PPC_ACTOR_UNRESOLVED",
      "A planning decision has to be attributable to the signed-in person.");
  }
  return { id: oid(actor.id), name: str(actor.name), email: str(actor.email) };
}

function expectedRevisionOf(value) {
  const expected = Number(value);
  if (value === null || value === undefined || value === ""
    || !Number.isInteger(expected) || expected < 1) {
    throw fail("PPC_EXPECTED_REVISION_REQUIRED",
      "Send the revision you read, so a stale command cannot overwrite a newer one.",
      { field: "expectedRevision" });
  }
  return expected;
}

const stale = (expected, now) => fail("PPC_PLANNING_REVISION_STALE",
  "This planning file moved while you were deciding. Re-read it and try again.",
  {
    expectedRevision: expected,
    currentRevision: now?.revision ?? null,
    currentState: now?.state ?? null,
  });

/* ══ THE HUMAN REFERENCE ══════════════════════════════════════════════════ */

/**
 * `PPCPF-` plus ten hex characters of the line's own identity.
 *
 * Derived from (companyId, orderLineRef, generation) rather than random, so a
 * retry that lost its answer computes the SAME reference and collides on the
 * unique index instead of minting a second file with a different name for one
 * plan.
 */
function planningFileRefFor({ companyId, orderLineRef, generation }) {
  const digest = crypto.createHash("sha256")
    .update(`${String(companyId)}:${str(orderLineRef)}:${generation}`)
    .digest("hex").slice(0, 10).toUpperCase();
  return `PPCPF-${digest}`;
}

/* ══ PROJECTION ═══════════════════════════════════════════════════════════ */

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * What a planning file looks like on the wire.
 *
 * The frozen basis travels as versions and states. PPC's receipt identities do
 * not: they are provenance held on the record, not something a screen prints.
 * The internal `_id` of upstream records, `__v` and raw actor objects do not
 * travel either. Business dates travel as the `YYYY-MM-DD` they are stored as.
 */
function projected(doc) {
  const actor = (a) => (a?.id
    ? { name: str(a.name), email: str(a.email) } : null);

  return {
    planningFileId: String(doc._id),
    planningFileRef: str(doc.planningFileRef),

    orderRef: str(doc.orderRef),
    orderLineRef: str(doc.orderLineRef),
    executionFileRef: str(doc.executionFileRef),
    styleRef: str(doc.styleRef),
    productName: str(doc.productName),
    buyerDisplayLabel: str(doc.buyerDisplayLabel),

    state: str(doc.state),
    stateBeforeHold: doc.stateBeforeHold || null,
    ownsLine: ACTIVE_STATES.includes(str(doc.state)),
    /* Once planned, the planning fields are permanent — said on the wire so a
       screen offers no edit rather than an edit the server refuses. */
    planningFrozen: Boolean(doc.plannedAt),
    generation: doc.generation,

    holdReason: doc.holdReason || null,
    holdNote: str(doc.holdNote),
    heldAt: iso(doc.heldAt),
    heldBy: actor(doc.heldBy),

    plannedAt: iso(doc.plannedAt),
    plannedBy: actor(doc.plannedBy),

    cancelledAt: iso(doc.cancelledAt),
    cancelledBy: actor(doc.cancelledBy),
    cancellationReason: doc.cancellationReason || null,
    cancellationNote: str(doc.cancellationNote),

    /* ── THE FROZEN BASIS, READ-ONLY EVERYWHERE ──────────────────────── */
    sourceBasis: orderBook.publicSourceBasis(doc.sourceBasis || {}),

    supersedesFileRef: str(doc.supersedesFileRef) || null,
    supersededByFileRef: str(doc.supersededByFileRef) || null,
    supersededAt: iso(doc.supersededAt),
    supersessionReason: str(doc.supersessionReason),
    followsCancelledFileRef: str(doc.followsCancelledFileRef) || null,

    /* ── PPC'S OWN FIELDS ────────────────────────────────────────────── */
    planning: {
      owner: actor(doc.planning?.owner),
      priority: doc.planning?.priority || null,
      proposedFactoryRef: str(doc.planning?.proposedFactoryRef),
      planningNote: str(doc.planning?.planningNote),
      riskNote: str(doc.planning?.riskNote),
      requestedProductionStart: doc.planning?.requestedProductionStart || null,
      requestedProductionEnd: doc.planning?.requestedProductionEnd || null,
      requestedCompletionDate: doc.planning?.requestedCompletionDate || null,
      assumptions: (doc.planning?.assumptions || [])
        .map((a) => ({ key: str(a.key), statement: str(a.statement) })),
    },

    revision: doc.revision,

    /* ── AND WHAT THIS RECORD IS NOT ─────────────────────────────────── */
    /* Said on every answer, in the same words the IE release envelope uses, so
       a reader never has to infer it from the absence of a field. */
    booksCapacity: false,
    allocatesLine: false,
    releasesProduction: false,

    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

/* ══ READING ══════════════════════════════════════════════════════════════ */

async function loadOrFail(ctx, { planningFileId, orderLineRef } = {}, session = null) {
  assertContext(ctx);
  const query = { companyId: oid(ctx.companyId) };
  if (planningFileId) {
    /* A malformed id is the typed not-found, never a cast error. */
    if (!isId(planningFileId)) {
      throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that reference.");
    }
    query._id = oid(planningFileId);
  } else {
    const ref = str(orderLineRef);
    if (!ref) {
      throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that reference.");
    }
    query.orderLineRef = ref;
    query.state = { $in: ACTIVE_STATES };
  }
  const doc = await PpcPlanningFile.findOne(query).session(session).lean();
  if (!doc) {
    throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that reference.");
  }
  return doc;
}

async function get(ctx, selector) {
  const doc = await loadOrFail(ctx, selector);
  return { planningFile: projected(doc) };
}

/** The bounded trail, newest first. Names of changed fields, never their values. */
async function history(ctx, selector, { limit = 50 } = {}) {
  const doc = await loadOrFail(ctx, selector);
  const size = Math.min(Math.max(Number(limit) || 50, 1), LIMITS.HISTORY);
  const events = [...(doc.history || [])]
    .sort((a, b) => new Date(b.at) - new Date(a.at) || (b.revision - a.revision))
    .slice(0, size)
    .map((e) => ({
      eventId: e.eventId,
      type: e.type,
      at: iso(e.at),
      actorName: str(e.actorName),
      fromState: str(e.fromState) || null,
      toState: str(e.toState) || null,
      changed: [...(e.changed || [])],
      reason: str(e.reason),
      hold: e.hold ? {
        reason: str(e.hold.reason) || null,
        note: str(e.hold.note),
        heldAt: iso(e.hold.heldAt),
        heldByName: str(e.hold.heldByName),
        stateBeforeHold: str(e.hold.stateBeforeHold) || null,
      } : null,
      revision: e.revision,
    }));
  return {
    planningFileRef: str(doc.planningFileRef),
    events,
    /* Said plainly, because a trail that silently drops its oldest entries
       would otherwise look complete. */
    bounded: LIMITS.HISTORY,
    truncated: (doc.history || []).length >= LIMITS.HISTORY,
  };
}

/** Source health for one file — delegated, so the comparison has one home. */
async function sourceHealth(ctx, selector) {
  const doc = await loadOrFail(ctx, selector);
  const health = await orderBook.sourceHealth(ctx, doc);
  return { planningFileRef: str(doc.planningFileRef), ...health };
}

/** How many generations one line's chain is read to. Far beyond any real line. */
const MAX_GENERATIONS = 200;

/**
 * Every planning file one permanent order line has ever had, oldest first.
 *
 * Company-scoped, keyed on the line reference, and including superseded and
 * cancelled generations — the point is that an earlier plan stays readable
 * after it stops owning the line. Each entry carries its lifecycle instants and
 * a summary of the versions it was frozen against, and nothing else: no
 * planning notes, no receipt identities, no upstream content.
 */
async function generations(ctx, { orderLineRef } = {}) {
  assertContext(ctx);
  const ref = str(orderLineRef);
  if (!ref) {
    throw fail("PPC_ORDER_LINE_REQUIRED",
      "Name the order line by its permanent line reference.", { field: "orderLineRef" });
  }
  const docs = await PpcPlanningFile.find({ companyId: oid(ctx.companyId), orderLineRef: ref })
    .sort({ generation: 1, createdAt: 1 })
    .limit(MAX_GENERATIONS + 1)
    .lean();
  const truncated = docs.length > MAX_GENERATIONS;
  const list = (truncated ? docs.slice(0, MAX_GENERATIONS) : docs).map((d) => {
    const b = d.sourceBasis || {};
    return {
      planningFileId: String(d._id),
      planningFileRef: str(d.planningFileRef),
      generation: d.generation,
      state: str(d.state),
      ownsLine: ACTIVE_STATES.includes(str(d.state)),
      supersedesFileRef: str(d.supersedesFileRef) || null,
      supersededByFileRef: str(d.supersededByFileRef) || null,
      followsCancelledFileRef: str(d.followsCancelledFileRef) || null,
      createdAt: iso(d.createdAt),
      plannedAt: iso(d.plannedAt),
      heldAt: iso(d.heldAt),
      cancelledAt: iso(d.cancelledAt),
      cancellationReason: d.cancellationReason || null,
      supersededAt: iso(d.supersededAt),
      sourceSummary: {
        confirmedQuantity: b.confirmedQuantity ?? null,
        earliestDeliveryDate: businessDateFromInstant(b.earliestDeliveryDate),
        executionPackVersionNo: b.executionPackVersionNo ?? null,
        ieReleaseRef: str(b.ieReleaseRef),
        ieReleaseVersionNo: b.ieReleaseVersionNo ?? null,
        ppmVersionNo: b.ppmVersionNo ?? null,
      },
    };
  });

  /* Complete means unbroken: generations 1..n with no gap, and every link a
     file names resolves to a file in the chain. Stated rather than assumed. */
  const refs = new Set(list.map((g) => g.planningFileRef));
  const contiguous = list.every((g, i) => g.generation === i + 1);
  const linked = list.every((g) => [g.supersedesFileRef, g.supersededByFileRef,
    g.followsCancelledFileRef].every((r) => !r || refs.has(r)));

  return {
    orderLineRef: ref,
    generations: list,
    activePlanningFileRef: list.find((g) => g.ownsLine)?.planningFileRef || null,
    complete: !truncated && contiguous && linked,
    truncated,
  };
}

/* ══ NORMALISING PPC'S OWN FIELDS ═════════════════════════════════════════ */

const DATE_FIELDS = Object.freeze([
  "requestedProductionStart", "requestedProductionEnd", "requestedCompletionDate",
]);

function normalisePlanningFields(body, { actor }) {
  const out = {};
  const changed = [];

  if (has(body, "owner")) {
    const o = body.owner;
    /* An explicit null hands the line back to nobody, which is a real decision
       and different from not mentioning the field. */
    if (o === null) { out["planning.owner"] = { id: null, name: "", email: "" }; }
    else if (o === "me") { out["planning.owner"] = actor; }
    else if (o && isId(o.id)) {
      out["planning.owner"] = { id: oid(o.id), name: str(o.name), email: str(o.email) };
    } else {
      throw fail("PPC_PLANNING_OWNER_INVALID",
        "An owner is a person with an id, `\"me\"`, or null to clear it.", { field: "owner" });
    }
    changed.push("owner");
  }

  if (has(body, "priority")) {
    const p = str(body.priority).toUpperCase();
    if (!PRIORITIES.includes(p)) {
      throw fail("PPC_PLANNING_PRIORITY_INVALID",
        "That is not one of PPC's priorities.", { field: "priority", allowed: [...PRIORITIES] });
    }
    out["planning.priority"] = p;
    changed.push("priority");
  }

  for (const [field, path, max] of [
    ["proposedFactoryRef", "planning.proposedFactoryRef", 120],
    ["planningNote", "planning.planningNote", LIMITS.NOTE],
    ["riskNote", "planning.riskNote", LIMITS.NOTE],
  ]) {
    if (!has(body, field)) continue;
    const v = str(body[field]);
    if (v.length > max) {
      throw fail("PPC_PLANNING_TEXT_TOO_LONG",
        `That is longer than ${max} characters.`, { field, max });
    }
    out[path] = v;
    changed.push(field);
  }

  /* Factory calendar days: exactly `YYYY-MM-DD`, a real day, and stored as the
     same string. An ISO instant is refused rather than truncated, because
     truncating one in the wrong timezone is how a day goes missing. */
  for (const field of DATE_FIELDS) {
    if (!has(body, field)) continue;
    const raw = body[field];
    if (raw === null || raw === "") { out[`planning.${field}`] = null; changed.push(field); continue; }
    if (!isBusinessDate(raw)) {
      throw fail("PPC_PLANNING_DATE_INVALID",
        "A planning date is a calendar day written YYYY-MM-DD.", { field, format: "YYYY-MM-DD" });
    }
    out[`planning.${field}`] = raw;
    changed.push(field);
  }

  if (has(body, "assumptions")) {
    const list = body.assumptions;
    if (!Array.isArray(list)) {
      throw fail("PPC_PLANNING_ASSUMPTIONS_INVALID",
        "Assumptions are a list.", { field: "assumptions" });
    }
    if (list.length > LIMITS.ASSUMPTIONS) {
      throw fail("PPC_PLANNING_ASSUMPTIONS_INVALID",
        `At most ${LIMITS.ASSUMPTIONS} assumptions.`,
        { field: "assumptions", max: LIMITS.ASSUMPTIONS });
    }
    const seen = new Set();
    const normalised = list.map((a, i) => {
      const key = str(a?.key);
      const statement = str(a?.statement);
      if (!key || !statement) {
        throw fail("PPC_PLANNING_ASSUMPTIONS_INVALID",
          "Each assumption needs a key and a statement.",
          { field: `assumptions[${i}]` });
      }
      if (statement.length > LIMITS.ASSUMPTION) {
        throw fail("PPC_PLANNING_TEXT_TOO_LONG",
          `An assumption is at most ${LIMITS.ASSUMPTION} characters.`,
          { field: `assumptions[${i}].statement` });
      }
      if (seen.has(key)) {
        throw fail("PPC_PLANNING_ASSUMPTIONS_INVALID",
          "Two assumptions share a key, so one would silently win.",
          { field: `assumptions[${i}].key`, key });
      }
      seen.add(key);
      return { key, statement };
    });
    out["planning.assumptions"] = normalised;
    changed.push("assumptions");
  }

  return { set: out, changed };
}

/**
 * The window has to be a window — checked against what the file WILL hold,
 * not just what this request sent, so moving only the end before a stored start
 * is refused too. String comparison is exact for `YYYY-MM-DD`.
 */
function assertDateOrder(stored = {}, set = {}) {
  const value = (field) => (has(set, `planning.${field}`) ? set[`planning.${field}`] : (stored[field] ?? null));
  const start = value("requestedProductionStart");
  const end = value("requestedProductionEnd");
  const completion = value("requestedCompletionDate");
  if (start && end && end < start) {
    throw fail("PPC_PLANNING_WINDOW_INVALID",
      "The requested production window ends before it starts.",
      { fields: ["requestedProductionStart", "requestedProductionEnd"] });
  }
  if (start && completion && completion < start) {
    throw fail("PPC_PLANNING_WINDOW_INVALID",
      "The requested completion is before the requested production start.",
      { fields: ["requestedProductionStart", "requestedCompletionDate"] });
  }
}

/* ══ THE AUDIT EVENT ══════════════════════════════════════════════════════ */

const event = ({ type, actor, fromState = "", toState = "", changed = [], reason = "", revision, hold = null }) => ({
  eventId: crypto.randomUUID(),
  type,
  at: new Date(),
  actorId: actor?.id || null,
  actorName: str(actor?.name),
  fromState: str(fromState),
  toState: str(toState),
  changed: changed.slice(0, 40),
  reason: str(reason).slice(0, LIMITS.REASON),
  revision,
  ...(hold ? {
    hold: {
      reason: str(hold.reason),
      note: str(hold.note).slice(0, LIMITS.REASON),
      heldAt: hold.heldAt || null,
      heldByName: str(hold.heldByName),
      stateBeforeHold: str(hold.stateBeforeHold),
    },
  } : {}),
});

/**
 * Append one event and keep the trail bounded, in ONE atomic update.
 *
 * `$push` with `$slice: -HISTORY` drops the oldest as the newest arrives, so
 * the document cannot grow without limit and no separate trim job can fall
 * behind. `$slice` is negative because the newest are at the tail.
 */
const pushEvent = (e) => ({ $each: [e], $slice: -LIMITS.HISTORY });

/* ══ READINESS, AND THE EXACT RECEIPTS IT FREEZES ═════════════════════════ */

/**
 * Re-check readiness from the published sources, and return what to freeze.
 *
 * The register's classification is reused rather than re-implemented, so the
 * rule a planner saw is the rule that runs. On top of it, the exact PPC
 * receipts are re-read by their own ids immediately before the write, and must
 * still be acceptances of exactly the pack and release versions being frozen —
 * a receipt that moved after the register was classified is not an
 * authorisation. They are read OUTSIDE the transaction's snapshot on purpose:
 * the snapshot was fixed when the transaction began, and would still show a
 * receipt that has since been superseded.
 */
async function readyBasis(ctx, line, { refusal }) {
  const { rows, provenance } = await orderBook.gather(ctx, [line], []);
  const row = rows[0];
  if (row.undetermined) {
    throw fail("PPC_PLANNING_READINESS_UNDETERMINED",
      "At least one authoritative input could not be read, so readiness cannot be decided. This is a failed read, not a missing input.",
      { unreadable: row.unreadableInputs });
  }
  if (!row.readyToPlan) {
    throw fail("PPC_PLANNING_NOT_READY", refusal,
      {
        unsatisfied: row.unsatisfiedInputs,
        /* Store status is reported for context and is NOT among the reasons. */
        materialContext: row.material.statements,
      });
  }

  const p = provenance.get(line.orderLineRef) || null;
  const i = row.inputs;
  const receiptsMissing = () => fail("PPC_PLANNING_NOT_READY",
    "PPC's own acceptance of the exact current pack and release could not be identified, so this line is not ready.",
    { unsatisfied: ["executionPack", "ieRelease"], reason: "RECEIPT_IDENTITY_UNRESOLVED" });

  if (!p || !p.packReceiptId || !p.ieReceiptId
    || p.packReceiptVersionNo !== i.executionPack.versionNo
    || p.ieReceiptVersionNo !== i.ieRelease.versionNo) {
    throw receiptsMissing();
  }

  const companyId = oid(ctx.companyId);
  const [packReceipt, ieReceipt] = await Promise.all([
    DownstreamHandoverReceipt.findOne({
      _id: oid(p.packReceiptId), companyId, packId: oid(p.packId),
      packVersionNo: p.packVersionNo, state: "ACCEPTED",
    }).lean(),
    IeReleaseReceipt.findOne({
      _id: oid(p.ieReceiptId), companyId, ieReleaseId: oid(p.ieReleaseId),
      releaseRef: p.ieReleaseRef, releaseVersionNo: p.ieReleaseVersionNo, state: "ACCEPTED",
    }).lean(),
  ]);
  if (!packReceipt || !ieReceipt) throw receiptsMissing();

  return {
    capturedAt: new Date(),
    confirmedQuantity: line.confirmedQuantity ?? 0,
    earliestDeliveryDate: businessDateFromInstant(line.earliestDeliveryDate),
    deliveryRequirement: str(line.deliveryRequirement),
    deliveryCount: line.deliveryCount ?? 0,

    executionPackId: oid(p.packId),
    executionPackVersionNo: i.executionPack.versionNo,
    executionPackState: str(i.executionPack.sourceState),
    packReceiptId: packReceipt._id,
    packReceiptVersionNo: packReceipt.packVersionNo,
    packReceiptState: str(packReceipt.state),

    ieReleaseId: oid(p.ieReleaseId),
    ieReleaseRef: str(i.ieRelease.releaseRef),
    ieReleaseVersionNo: i.ieRelease.versionNo,
    ieReleaseState: str(i.ieRelease.sourceState),
    ieReceiptId: ieReceipt._id,
    ieReceiptVersionNo: ieReceipt.releaseVersionNo,
    ieReceiptState: str(ieReceipt.state),

    ppmMeetingId: i.ppmMinutes.meetingId ? oid(i.ppmMinutes.meetingId) : null,
    ppmVersionNo: i.ppmMinutes.versionNo ?? null,
    ppmState: str(i.ppmMinutes.sourceState),

    nominatedFactoryRef: line.nominatedFactoryRefs?.[0] || str(line.factoryRef),
  };
}

const lineIdentity = (line) => ({
  orderRef: str(line.orderRef),
  handoverRef: str(line.handoverRef),
  executionFileId: oid(line.executionFileId),
  executionFileRef: str(line.executionFileRef),
  sampleStyleId: line.sampleStyleId ? oid(line.sampleStyleId) : null,
  styleRef: str(line.styleRef),
  productName: str(line.productName),
  buyerDisplayLabel: str(line.buyerDisplayLabel),
});

const isActiveLineCollision = (err) => err?.code === 11000
  && (err?.keyPattern?.orderLineRef || /ppc_planning_one_active_per_line|ppc_planning_ref_unique/.test(str(err?.message)));

/* ══ CREATE ═══════════════════════════════════════════════════════════════ */

/**
 * Create the one active planning file for a confirmed order line.
 *
 * Readiness is re-checked HERE, from the published sources, at the moment of
 * creation — never taken from a body and never trusted from the register the
 * planner was looking at a minute ago.
 *
 * After a CANCELLED file, a new one is allowed — the cancelled file no longer
 * holds the line's active index — but only when the request names the
 * cancelled file it follows. The new file continues the line's generation count
 * and records what it follows, so the chain stays one walkable history.
 */
async function create(ctx, {
  orderLineRef, body = {}, actor, idempotencyKey,
} = {}) {
  assertContext(ctx);
  const person = assertActor(actor);
  const ref = str(orderLineRef);
  if (!ref) {
    throw fail("PPC_ORDER_LINE_REQUIRED",
      "Name the order line by its permanent line reference.", { field: "orderLineRef" });
  }
  refuseUnknown(body, CREATE_FIELDS);
  const { afterCancelledFileRef: afterRaw, ...planningBody } = body;
  const afterCancelledFileRef = str(afterRaw);
  const fields = normalisePlanningFields(planningBody, { actor: person });
  assertDateOrder({}, fields.set);

  const attempt = () => planningCommand(ctx, {
    scope: `ppc:planning:create:${ref}`,
    command: "create",
    idempotencyKey,
    request: { command: "create", orderLineRef: ref, body },
  }, async (session) => {
    const companyId = oid(ctx.companyId);

    /* ── 0. A FILE ALREADY OWNS THE LINE — that is the answer ────────── */
    const owning = await PpcPlanningFile.findOne({
      companyId, orderLineRef: ref, state: { $in: ACTIVE_STATES },
    }).session(session).lean();
    if (owning) return { planningFile: projected(owning), created: false };

    /* ── 1. THE LINE MUST BE ONE OF OURS ──────────────────────────────── */
    const line = await merch.publishConfirmedOrderLine(ctx, { orderLineRef: ref });
    if (!line) {
      throw fail("PPC_ORDER_LINE_NOT_FOUND",
        "No confirmed order line of yours has that reference.", { orderLineRef: ref });
    }

    /* ── 2. AFTER A CANCELLATION, ONLY BY NAME ────────────────────────── */
    const latest = await PpcPlanningFile.findOne({ companyId, orderLineRef: ref })
      .sort({ generation: -1 }).session(session).lean();
    const cancelled = latest && latest.state === PLANNING_STATE.CANCELLED ? latest : null;
    if (cancelled && afterCancelledFileRef !== str(cancelled.planningFileRef)) {
      throw fail("PPC_PLANNING_PRIOR_CANCELLED",
        "This line's last planning file was cancelled. To open a new one, say that you are opening it after that cancellation.",
        { cancelledFileRef: str(cancelled.planningFileRef), field: "afterCancelledFileRef" });
    }
    if (!cancelled && afterCancelledFileRef) {
      throw fail("PPC_PLANNING_PRIOR_CANCELLED",
        "That is not this line's most recent cancelled planning file.",
        { field: "afterCancelledFileRef" });
    }

    /* ── 3. IT MUST BE READY, AND ITS RECEIPTS EXACT ──────────────────── */
    const sourceBasis = await readyBasis(ctx, line, {
      refusal: "This line is in the order book, but it is not ready for a planning file yet.",
    });

    /* ── 4. FREEZE WHAT AUTHORISED IT ─────────────────────────────────── */
    const generation = (latest?.generation || 0) + 1;
    const [doc] = await PpcPlanningFile.create([{
      planningFileRef: planningFileRefFor({ companyId: ctx.companyId, orderLineRef: ref, generation }),
      companyId,
      orderLineRef: ref,
      ...lineIdentity(line),
      state: PLANNING_STATE.OPEN,
      sourceBasis,
      generation,
      followsCancelledFileId: cancelled ? cancelled._id : null,
      followsCancelledFileRef: cancelled ? str(cancelled.planningFileRef) : "",
      planning: {
        owner: fields.set["planning.owner"] || person,
        priority: fields.set["planning.priority"] || "NORMAL",
        proposedFactoryRef: fields.set["planning.proposedFactoryRef"] || "",
        planningNote: fields.set["planning.planningNote"] || "",
        riskNote: fields.set["planning.riskNote"] || "",
        requestedProductionStart: fields.set["planning.requestedProductionStart"] || null,
        requestedProductionEnd: fields.set["planning.requestedProductionEnd"] || null,
        requestedCompletionDate: fields.set["planning.requestedCompletionDate"] || null,
        assumptions: fields.set["planning.assumptions"] || [],
      },
      revision: 1,
      history: [event({
        type: "PLANNING_FILE_CREATED", actor: person,
        toState: PLANNING_STATE.OPEN, changed: fields.changed, revision: 1,
        reason: cancelled ? `Opened after cancelled ${str(cancelled.planningFileRef)}` : "",
      })],
      createdBy: person,
      updatedBy: person,
    }], { session });
    return { planningFile: projected(doc.toObject()), created: true };
  });

  /* ── ONE FILE, DECIDED AT THE INDEX ─────────────────────────────────────
     A concurrent create under a DIFFERENT key can win the active-line index.
     The honest answer is then THEIR file, reported as not created — so the
     command is asked once more, finds the owner in step 0, and records that
     answer against this key. */
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isActiveLineCollision(err) || tries >= 2) throw err;
    }
  }
}

/* ══ UPDATING PPC'S OWN FIELDS ════════════════════════════════════════════ */

/**
 * Edit the planning fields. One conditional update, matched on the revision,
 * the exact state, and `plannedAt: null`.
 *
 * Not idempotency-keyed: an edit is last-writer-with-the-right-revision, and a
 * retry that already applied simply conflicts and re-reads.
 *
 * A file that has ever been PLANNED is refused outright — including while it
 * is ON_HOLD from PLANNED — because its planning fields are the evidence of an
 * approved plan. The filter carries the same rule, so the database refuses the
 * write even if this check were removed.
 */
async function updateFields(ctx, { planningFileId, expectedRevision, body = {}, actor } = {}) {
  assertContext(ctx);
  const person = assertActor(actor);
  refuseUnknown(body, PERMITTED_FIELDS);
  const expected = expectedRevisionOf(expectedRevision);

  const current = await loadOrFail(ctx, { planningFileId });
  if (current.state === PLANNING_STATE.CANCELLED || current.state === PLANNING_STATE.SUPERSEDED) {
    throw fail("PPC_PLANNING_FILE_CLOSED",
      "That planning file no longer owns its line, so it cannot be edited.",
      { state: current.state, supersededByFileRef: str(current.supersededByFileRef) || null });
  }
  if (current.plannedAt || current.state === PLANNING_STATE.PLANNED) {
    throw fail("PPC_PLANNING_FILE_FROZEN",
      "This plan has been marked planned, so its planning fields are permanent. To change the plan, create a successor.",
      { state: current.state, planningFileRef: str(current.planningFileRef) });
  }

  const fields = normalisePlanningFields(body, { actor: person });
  if (!fields.changed.length) {
    /* Nothing was sent. Reported as a no-op rather than burning a revision,
       because a revision bump with no change makes every other reader stale. */
    return { planningFile: projected(current), updated: false };
  }
  if (current.revision !== expected) throw stale(expected, current);
  assertDateOrder(current.planning || {}, fields.set);

  const updated = await PpcPlanningFile.findOneAndUpdate(
    {
      _id: current._id, companyId: oid(ctx.companyId), revision: expected,
      state: current.state, plannedAt: null,
    },
    {
      $set: { ...fields.set, revision: expected + 1, updatedBy: person },
      $push: {
        history: pushEvent(event({
          type: "PLANNING_FIELDS_UPDATED", actor: person,
          fromState: current.state, toState: current.state,
          changed: fields.changed, revision: expected + 1,
        })),
      },
    },
    { new: true, lean: true, runValidators: true },
  );

  if (!updated) {
    const now = await PpcPlanningFile.findById(current._id).lean();
    if (now?.plannedAt) {
      throw fail("PPC_PLANNING_FILE_FROZEN",
        "This plan was marked planned while you were editing it, so its planning fields are now permanent.",
        { state: now.state, planningFileRef: str(now.planningFileRef) });
    }
    throw stale(expected, now);
  }
  return { planningFile: projected(updated), updated: true };
}

/* ══ STATE COMMANDS ═══════════════════════════════════════════════════════ */

/**
 * One shape for every lifecycle move: a permitted set of from-states, the
 * to-state, and whatever else the move writes.
 *
 * Everything decided from the record is decided INSIDE the transaction, from
 * the record as the transaction reads it — including where a hold returns to.
 * The update matches the exact revision the caller sent and the exact state
 * the record is in, and writes that revision plus one.
 *
 * ── SCOPED TO THE RECORD, NOT TO THE COMMAND ────────────────────────────────
 * `ppc:planning:cmd:<id>` is shared by every lifecycle command on this file,
 * cancellation and succession included. So one key does ONE thing to one
 * planning file: the same key re-sent for a different command, or for the same
 * command against a different revision, has a different request hash and is
 * refused as reused.
 */
async function transition(ctx, {
  planningFileId, expectedRevision, actor, idempotencyKey,
  type, command, from, to, reason = "", shape = () => ({}), request = {},
  /* `(current) => snapshot | null` — the hold the event is about, read from
     the record INSIDE the transaction, like everything else it decides. */
  holdSnapshot = null,
}) {
  assertContext(ctx);
  const person = assertActor(actor);
  const expected = expectedRevisionOf(expectedRevision);
  const target = await loadOrFail(ctx, { planningFileId });

  return planningCommand(ctx, {
    scope: `ppc:planning:cmd:${String(target._id)}`,
    command,
    idempotencyKey,
    request: {
      command, planningFileId: String(target._id), expectedRevision: expected, ...request,
    },
  }, async (session) => {
    const current = await loadOrFail(ctx, { planningFileId: target._id }, session);
    const destination = typeof to === "function" ? to(current) : to;

    if (!from.includes(str(current.state))) {
      throw fail("PPC_PLANNING_STATE_INVALID",
        `A planning file in ${current.state} cannot make that move.`,
        { state: current.state, allowedFrom: [...from], attempted: destination });
    }
    if (current.revision !== expected) throw stale(expected, current);

    const extra = shape(current, person) || {};
    const update = {
      $set: {
        state: destination, revision: expected + 1, updatedBy: person, ...(extra.set || {}),
      },
      $push: {
        history: pushEvent(event({
          type, actor: person, fromState: current.state, toState: destination,
          reason, revision: expected + 1,
          hold: holdSnapshot ? holdSnapshot(current, person) : null,
        })),
      },
    };
    if (extra.unset && Object.keys(extra.unset).length) update.$unset = extra.unset;

    const updated = await PpcPlanningFile.findOneAndUpdate(
      {
        _id: current._id, companyId: oid(ctx.companyId),
        revision: expected, state: current.state, ...(extra.filter || {}),
      },
      update,
      { new: true, lean: true, session, runValidators: true },
    );
    if (!updated) {
      throw stale(expected, await PpcPlanningFile.findById(current._id).session(session).lean());
    }
    return { planningFile: projected(updated) };
  });
}

/** OPEN → PLANNING. A planner has picked the line up. */
const markPlanningStarted = (ctx, args) => transition(ctx, {
  ...args,
  type: "PLANNING_STARTED",
  command: "planning-started",
  from: [PLANNING_STATE.OPEN],
  to: PLANNING_STATE.PLANNING,
});

/**
 * PLANNING → PLANNED. PPC's planning assumptions are complete — and permanent.
 *
 * This books nothing. The reply says so on its face, and there is no code below
 * this line that could reach capacity, a line, a date promise or Production.
 */
const markPlanned = (ctx, args) => transition(ctx, {
  ...args,
  type: "MARKED_PLANNED",
  command: "marked-planned",
  from: [PLANNING_STATE.PLANNING],
  to: PLANNING_STATE.PLANNED,
  shape: (current, person) => ({ set: { plannedAt: new Date(), plannedBy: person } }),
});

/**
 * A hold, with a classified reason. Touches the hold fields and nothing else,
 * so a hold on a PLANNED file leaves its planning content exactly as approved.
 */
async function placeHold(ctx, args) {
  refuseUnknown(args.body, ["reason", "note"]);
  const reason = str(args.body?.reason).toUpperCase();
  if (!HOLD_REASON.includes(reason)) {
    throw fail("PPC_HOLD_REASON_INVALID",
      "A hold needs one of PPC's hold reasons.",
      { field: "reason", allowed: [...HOLD_REASON] });
  }
  const note = str(args.body?.note);
  if (note.length > LIMITS.REASON) {
    throw fail("PPC_PLANNING_TEXT_TOO_LONG",
      `A hold note is at most ${LIMITS.REASON} characters.`, { field: "note" });
  }
  /* `OTHER` with no note is a hold nobody can act on. */
  if (reason === "OTHER" && note.length < 10) {
    throw fail("PPC_HOLD_REASON_INVALID",
      "A hold for `OTHER` needs a note saying what it is waiting for.",
      { field: "note" });
  }

  return transition(ctx, {
    ...args,
    type: "HOLD_PLACED",
    command: "hold-placed",
    from: HOLDABLE_STATES,
    to: PLANNING_STATE.ON_HOLD,
    reason,
    request: { reason, note },
    holdSnapshot: (current, person) => ({
      reason, note, heldAt: new Date(), heldByName: person?.name, stateBeforeHold: str(current.state),
    }),
    shape: (current, person) => ({
      set: {
        holdReason: reason, holdNote: note, heldAt: new Date(), heldBy: person,
        /* Remembered, so removing the hold restores the state rather than
           guessing OPEN and quietly undoing a planner's progress. */
        stateBeforeHold: str(current.state),
      },
    }),
  });
}

/* ══ RESUMING PLANNING ═══════════════════════════════════════════════════
 *
 * Removing a hold is PPC recording ITS OWN decision to resume — never a
 * statement that what the hold was waiting for has arrived. Material in
 * particular is another department's statement, and nothing here reads,
 * writes or implies it. So the decision must say what changed, in words the
 * next reader can check, and that explanation is enforced HERE, where every
 * client arrives — a screen that skipped its dialog cannot skip this.
 */
const RESOLUTION_MIN = 10;

/**
 * Null when the note explains something; otherwise why not. Whitespace is
 * collapsed first, and a note made of one repeated character or with fewer
 * than three letters is not an explanation however long it is.
 */
function resolutionProblem(raw) {
  const note = str(raw).replace(/\s+/g, " ");
  if (!note) return "Say what changed before resuming planning.";
  if (note.length < RESOLUTION_MIN) {
    return `Say what changed in at least ${RESOLUTION_MIN} characters.`;
  }
  const letters = (note.match(/\p{L}/gu) || []).length;
  const distinct = new Set(note.replace(/\s/g, "").toLowerCase()).size;
  if (letters < 3 || distinct < 4) return "Say what changed, in words.";
  if (note.length > LIMITS.REASON) return `A resolution note is at most ${LIMITS.REASON} characters.`;
  return null;
}

/**
 * Resuming returns the file to exactly the state it was held from, records
 * what changed, and keeps the resolved hold — reason, note, who and when — in
 * the trail. It touches the hold fields and nothing else: no Store status, no
 * order, no capacity, no Production.
 */
async function removeHold(ctx, args) {
  refuseUnknown(args.body, ["note"]);
  const note = str(args.body?.note).replace(/\s+/g, " ");
  const problem = resolutionProblem(note);
  if (problem) {
    throw fail(note.length > LIMITS.REASON ? "PPC_PLANNING_TEXT_TOO_LONG" : "PPC_HOLD_RESOLUTION_REQUIRED",
      problem, { field: "note", minLength: RESOLUTION_MIN });
  }
  return transition(ctx, {
    ...args,
    type: "HOLD_REMOVED",
    command: "hold-removed",
    from: [PLANNING_STATE.ON_HOLD],
    to: (current) => {
      const back = str(current.stateBeforeHold);
      if (!HOLDABLE_STATES.includes(back)) {
        throw fail("PPC_PLANNING_STATE_INVALID",
          "This hold does not record the state it was placed from, so it cannot be lifted safely.",
          { state: current.state });
      }
      return back;
    },
    reason: note,
    request: { note },
    holdSnapshot: (current) => ({
      reason: current.holdReason, note: current.holdNote, heldAt: current.heldAt,
      heldByName: current.heldBy?.name, stateBeforeHold: current.stateBeforeHold,
    }),
    shape: (current) => ({
      set: { holdNote: "", heldAt: null, stateBeforeHold: null },
      unset: { holdReason: "" },
      filter: { stateBeforeHold: str(current.stateBeforeHold) },
    }),
  });
}

/* ══ CANCELLATION ═════════════════════════════════════════════════════════ */

const CANCEL_NOTE_MIN_FOR_OTHER = 15;

/**
 * Cancel PPC's plan for a line. Terminal, reasoned, and nothing else.
 *
 * It creates no successor, deletes no history, and writes nothing upstream:
 * cancelling a PLAN says PPC withdrew it, not that the order is cancelled. The
 * cancelled file stops holding the line's active index, and stays readable for
 * ever in the line's generation history. Approver only, at the route.
 */
async function cancel(ctx, args) {
  refuseUnknown(args.body, ["reason", "note"]);
  const reason = str(args.body?.reason).toUpperCase();
  if (!CANCELLATION_REASON.includes(reason)) {
    throw fail("PPC_CANCELLATION_REASON_INVALID",
      "A cancellation needs one of PPC's cancellation reasons.",
      { field: "reason", allowed: [...CANCELLATION_REASON] });
  }
  const note = str(args.body?.note).replace(/\s+/g, " ");
  if (note.length > LIMITS.REASON) {
    throw fail("PPC_PLANNING_TEXT_TOO_LONG",
      `A cancellation note is at most ${LIMITS.REASON} characters.`, { field: "note" });
  }
  if (reason === "OTHER" && note.length < CANCEL_NOTE_MIN_FOR_OTHER) {
    throw fail("PPC_CANCELLATION_REASON_INVALID",
      `A cancellation for \`OTHER\` needs a note of at least ${CANCEL_NOTE_MIN_FOR_OTHER} characters saying why.`,
      { field: "note", minimum: CANCEL_NOTE_MIN_FOR_OTHER });
  }

  return transition(ctx, {
    ...args,
    type: "PLANNING_FILE_CANCELLED",
    command: "cancelled",
    from: ACTIVE_STATES,
    to: PLANNING_STATE.CANCELLED,
    reason,
    request: { reason, note },
    holdSnapshot: (current, person) => ({
      reason, note, heldAt: new Date(), heldByName: person?.name, stateBeforeHold: str(current.state),
    }),
    shape: (current, person) => ({
      set: {
        cancelledAt: new Date(), cancelledBy: person,
        cancellationReason: reason, cancellationNote: note,
      },
    }),
  });
}

/* ══ SUCCESSOR ════════════════════════════════════════════════════════════ */

/**
 * A successor, created explicitly, after an authoritative input has moved —
 * or because an approved plan has to change, which is the only way it can.
 *
 * The predecessor is preserved in full — its frozen basis, its planning fields
 * and its whole trail stay exactly as they were, and it moves to SUPERSEDED so
 * it stops owning the line.
 *
 * ── AND IT IS AS CONCURRENCY-SAFE AS EVERY OTHER COMMAND ───────────────────
 * The caller sends the revision it read, and the request hash includes it. The
 * predecessor is retired by ONE conditional update matched on its exact id,
 * company, state and that revision, writing that revision plus one — so an edit
 * that landed a moment earlier makes the retirement match nothing, and nothing
 * is written. The successor's id is minted before the retirement, so the
 * forward pointer is stamped by the same update. Retirement, successor,
 * pointer, both history events and the command's ledger row are one
 * transaction: all of them happen or none does.
 */
async function createSuccessor(ctx, {
  planningFileId, expectedRevision, body = {}, actor, idempotencyKey,
} = {}) {
  assertContext(ctx);
  const person = assertActor(actor);
  refuseUnknown(body, ["reason"]);
  const reason = str(body.reason).replace(/\s+/g, " ");
  if (reason.length < 15) {
    throw fail("PPC_SUCCESSOR_REASON_REQUIRED",
      "Say why a new planning file is needed — an industrial engineer or merchandiser reads this.",
      { field: "reason", minimum: 15 });
  }
  if (reason.length > LIMITS.REASON) {
    throw fail("PPC_PLANNING_TEXT_TOO_LONG",
      `A reason is at most ${LIMITS.REASON} characters.`, { field: "reason" });
  }
  const expected = expectedRevisionOf(expectedRevision);
  const target = await loadOrFail(ctx, { planningFileId });

  return planningCommand(ctx, {
    scope: `ppc:planning:cmd:${String(target._id)}`,
    command: "create-successor",
    idempotencyKey,
    request: {
      command: "create-successor", planningFileId: String(target._id),
      expectedRevision: expected, reason,
    },
  }, async (session) => {
    const companyId = oid(ctx.companyId);
    const predecessor = await loadOrFail(ctx, { planningFileId: target._id }, session);
    if (!ACTIVE_STATES.includes(str(predecessor.state))) {
      throw fail("PPC_PLANNING_FILE_CLOSED",
        "That planning file no longer owns its line, so it has nothing to hand to a successor.",
        { state: predecessor.state, supersededByFileRef: str(predecessor.supersededByFileRef) || null });
    }
    if (predecessor.revision !== expected) throw stale(expected, predecessor);

    /* The successor is planned against what is CURRENT, read fresh. */
    const line = await merch.publishConfirmedOrderLine(ctx, {
      orderLineRef: predecessor.orderLineRef,
    });
    if (!line) {
      throw fail("PPC_ORDER_LINE_NOT_FOUND",
        "The order line this plan belongs to is no longer a confirmed line of yours.");
    }
    const sourceBasis = await readyBasis(ctx, line, {
      refusal: "The current inputs are not complete, so there is nothing new to plan against yet.",
    });

    const generation = predecessor.generation + 1;
    const successorId = new mongoose.Types.ObjectId();
    const planningFileRef = planningFileRefFor({
      companyId: ctx.companyId, orderLineRef: predecessor.orderLineRef, generation,
    });

    /* ── 1. RETIRE THE PREDECESSOR — exactly the revision that was read ── */
    const retired = await PpcPlanningFile.findOneAndUpdate(
      {
        _id: predecessor._id, companyId,
        state: predecessor.state, revision: expected,
      },
      {
        $set: {
          state: PLANNING_STATE.SUPERSEDED,
          supersededByFileId: successorId,
          supersededByFileRef: planningFileRef,
          supersededAt: new Date(),
          supersessionReason: reason,
          revision: expected + 1,
          updatedBy: person,
        },
        $push: {
          history: pushEvent(event({
            type: "SUPERSEDED_BY_SUCCESSOR", actor: person,
            fromState: predecessor.state, toState: PLANNING_STATE.SUPERSEDED,
            reason, revision: expected + 1,
          })),
        },
      },
      { new: true, session, lean: true, runValidators: true },
    );
    if (!retired) {
      throw stale(expected, await PpcPlanningFile.findById(predecessor._id).session(session).lean());
    }

    /* ── 2. THE SUCCESSOR, WITH THE ID THE POINTER ALREADY NAMES ──────── */
    const [created] = await PpcPlanningFile.create([{
      _id: successorId,
      planningFileRef,
      companyId,
      orderLineRef: str(predecessor.orderLineRef),
      ...lineIdentity(line),
      state: PLANNING_STATE.OPEN,
      sourceBasis,
      /* Carried forward, because a successor inherits PPC's intentions — the
         reason for the successor is usually that the SOURCES moved. The
         successor is OPEN and editable; the predecessor keeps its own copy. */
      planning: {
        owner: predecessor.planning?.owner?.id ? predecessor.planning.owner : person,
        priority: predecessor.planning?.priority || "NORMAL",
        proposedFactoryRef: str(predecessor.planning?.proposedFactoryRef),
        planningNote: str(predecessor.planning?.planningNote),
        riskNote: str(predecessor.planning?.riskNote),
        requestedProductionStart: predecessor.planning?.requestedProductionStart || null,
        requestedProductionEnd: predecessor.planning?.requestedProductionEnd || null,
        requestedCompletionDate: predecessor.planning?.requestedCompletionDate || null,
        assumptions: (predecessor.planning?.assumptions || [])
          .map((a) => ({ key: str(a.key), statement: str(a.statement) })),
      },
      supersedesFileId: predecessor._id,
      supersedesFileRef: str(predecessor.planningFileRef),
      generation,
      revision: 1,
      history: [event({
        type: "SUCCESSOR_CREATED", actor: person,
        toState: PLANNING_STATE.OPEN, reason, revision: 1,
      })],
      createdBy: person,
      updatedBy: person,
    }], { session });

    return {
      planningFile: projected(created.toObject()),
      supersededFileRef: str(predecessor.planningFileRef),
      created: true,
    };
  });
}

module.exports = {
  PERMITTED_FIELDS, CREATE_FIELDS, REFUSED_FIELDS, EDITABLE_STATES,
  get, history, sourceHealth, generations,
  create, updateFields,
  markPlanningStarted, markPlanned, placeHold, removeHold, resolutionProblem, RESOLUTION_MIN, cancel, createSuccessor,
  projected, planningFileRefFor, refuseUnknown, normalisePlanningFields, assertDateOrder,
};
