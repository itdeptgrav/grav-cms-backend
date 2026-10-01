// services/marketing/salesOutcomeIntake.service.js
//
// MARKETING LEARNS WHAT SALES DECIDED.
//
// ── THE HALF OF THE FEEDBACK LOOP THAT LIVES HERE ──────────────────────────
// Sales records its decision and announces it. This is the only code that
// reads that announcement and changes a Marketing record because of one. Sales
// owns the decision; Marketing owns what it does about it.
//
// Without this, the loop the whole product rests on does not close: campaigns
// would keep running against people Sales has taken over, and nothing would
// ever tell Marketing which audiences produce Prospects a salesperson wants.
//
// ── ACCEPTANCE RAISES AN ACQUISITION HOLD; IT DOES NOT CLAIM ONE ───────────
// "On acceptance, acquisition campaigns pause immediately." Acting on that is a
// Marketing act on a Marketing record, so it happens in this file rather than
// in the Sales decision that triggered it.
//
// What this file used to do was write `permission.acquisitionPausedAt = now`
// and say in its own comment that the Mautic-side removal "is a later chunk's
// outbound work and is not pretended to have happened" — while the field it had
// just written was read by everyone as the claim that it HAD. A salesperson was
// told the person was out of the campaign while the campaign was still sending
// to them.
//
// So acceptance now raises a durable, idempotent PAUSE COMMAND
// (services/marketing/acquisitionHold.service.js) naming the exact company,
// person, Mautic identity and handover, and attempts it at once. The attempt may
// fail; the decision is recorded either way and the command stays queryable and
// recoverable. `acquisitionPausedAt` is written by that service, from a read-back
// of Mautic, and by nothing else.
//
// ── IDEMPOTENT AND ORDER-TOLERANT ──────────────────────────────────────────
// A retry sweep can deliver a decision twice, or late. So a handover that
// already carries an outcome is never overwritten: the second delivery is
// recorded as having changed nothing, and the reason is stored beside it.
"use strict";

const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const acquisitionHold = require("./acquisitionHold.service");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { fail } = require("../storePurchase/errors");
const { SALES_OUTCOME_EVENT_KINDS, SALES_DECISION_CODES } = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/**
 * Receive one Sales decision.
 *
 * @returns {Promise<{applied:boolean, duplicate:boolean, state:string, note:string}>}
 */
async function receive(event, { mauticClient = null } = {}) {
  const kind = str(event?.kind);
  if (kind !== SALES_OUTCOME_EVENT_KINDS.DECIDED) {
    throw fail("VALIDATION", `Marketing cannot receive "${kind}".`, { kind });
  }

  const companyId = event.companyId;
  const handoverRef = str(event.payload?.handoverRef);
  const decision = str(event.payload?.decision);
  if (!companyId || !handoverRef) {
    throw fail("VALIDATION", "A Sales outcome event needs a company and a handover reference.");
  }
  if (!SALES_DECISION_CODES.includes(decision)) {
    throw fail("VALIDATION", `"${decision}" is not a decision Marketing understands.`, { decision });
  }

  const handover = await Handover.findOne({ companyId, handoverRef });
  if (!handover) throw fail("NOT_FOUND", `Handover ${handoverRef} was not found.`);

  /* ── ALREADY ANSWERED: RECONCILE, DO NOT JUST ACKNOWLEDGE ────────────────
     The first answer is the one Marketing acted on, and it is never overwritten.
     But returning here and nothing else was a durability hole, and a quiet one.

     The ordering is: save the outcome, then create the hold command, then apply
     it. Mongo gives no transaction across those on a single-node deployment, so
     a crash, a refused write or a lost connection BETWEEN the outcome save and
     the hold creation left a handover that was permanently ACCEPTED with no
     command to stop acquisition — and because this branch returned on sight of
     `outcome.decision`, every redelivery for ever after acknowledged the outcome
     and recreated nothing. The gap was invisible and self-sealing.

     So a duplicate delivery now reconciles every side effect the decision
     requires before it returns. That makes the decision and its command
     inseparable in EFFECT, which is the guarantee that matters, without
     depending on a replica set. */
  if (handover.outcome?.decision) {
    const repaired = await reconcileDecisionSideEffects({
      companyId, handover, event, mauticClient,
    });
    return {
      applied: false,
      duplicate: true,
      state: handover.state,
      note: `Already ${handover.outcome.decision}.`,
      reconciled: repaired.reconciled,
      acquisitionHold: repaired.acquisitionHold,
    };
  }

  const at = event.occurredAt ? new Date(event.occurredAt) : new Date();
  const previousState = handover.state;

  handover.state = decision;
  handover.outcome = {
    decision,
    decidedAt: at,
    decidedBy: event.actor || undefined,
    reason: str(event.payload?.reason),
    nurtureTopic: str(event.payload?.nurtureTopic),
    revisitAt: event.payload?.revisitAt ? new Date(event.payload.revisitAt) : null,
    salesRecordType: str(event.payload?.salesRecordType),
    salesRecordId: event.payload?.salesRecordId || null,
    salesRecordRef: str(event.payload?.salesRecordRef),
  };

  await handover.save();

  /* ── THE PAUSE, AS A COMMAND ───────────────────────────────────────────
     Acceptance and a duplicate link both mean the person is now Sales', so
     acquisition messaging must stop for both. A RETURN does not: returning is
     Sales asking Marketing to carry on nurturing, and this slice deliberately
     does not resume anything automatically either — the nurture topic and
     revisit date recorded above are preserved for a later explicit,
     consent-checked re-entry workflow that does not exist yet.

     Raised AFTER the decision is saved, and never allowed to undo it. */
  const hold = await acquisitionHold.request({
    companyId, handover, decision, decidedAt: at, now: at,
  });

  /* The SAME writer the reconciler uses, so the first delivery and a later
     repair cannot describe one event two different ways. */
  await writeDecisionAudit({
    companyId, handover, event, decision, at, previousState,
    details: {
      salesRecordRef: str(event.payload?.salesRecordRef),
      nurtureTopic: str(event.payload?.nurtureTopic),
      /* What is OWED, not what has happened. The old field here was
         `acquisitionPaused: true`, written in the same breath as a timestamp
         nothing had earned. */
      acquisitionHoldOwed: Boolean(hold.owed),
      acquisitionHoldState: hold.row?.state || "NONE",
    },
  });

  /* ── AND TRY IT NOW ────────────────────────────────────────────────────
     The feedback loop is the point, so the stop is attempted immediately rather
     than waiting for a sweep. It is never allowed to fail the decision: a
     Mautic outage leaves the command FAILED and queryable, and recovery repairs
     it without asking Sales anything. */
  let holdOutcome = null;
  if (hold.owed && hold.row) {
    try {
      holdOutcome = await acquisitionHold.apply({
        companyId, handoverRef: handover.handoverRef, client: mauticClient,
      });
    } catch (err) {
      /* `apply` records Mautic failures itself and does not throw for them, so
         reaching here means something further out broke. The decision stands;
         the command is still owed and still queryable. */
      holdOutcome = { state: hold.row.state, changed: false, note: str(err?.message).slice(0, 500) };
    }
  }

  return {
    applied: true,
    duplicate: false,
    state: handover.state,
    note: "",
    acquisitionHold: holdOutcome
      ? { state: holdOutcome.state, changed: Boolean(holdOutcome.changed), note: holdOutcome.note || "" }
      : { state: hold.owed ? (hold.row?.state || "REQUESTED") : "NONE", changed: false, note: "" },
  };
}

/**
 * Bring one already-decided handover's side effects up to date.
 *
 * Every step is idempotent and none of them touches `handover.outcome`. Called
 * on a duplicate delivery, which is the only moment a missing side effect can be
 * noticed without a scheduler.
 *
 * @returns {Promise<{reconciled:string[], acquisitionHold:object}>}
 */
async function reconcileDecisionSideEffects({ companyId, handover, event, mauticClient }) {
  const decision = str(handover.outcome?.decision);
  const reconciled = [];

  /* 1. THE AUDIT LINE.
        ── WHY IT IS PART OF THE DURABLE CONTRACT ───────────────────────────
        It is the only record that Marketing ever learned the decision, and the
        handover read serves it as the history a person reads. Losing it to the
        same window would leave an ACCEPTED handover whose trail says it was only
        ever submitted. So exactly one line per decision, ensured here.

        Deduplicated BY THE DATABASE, on a `dedupeKey` covered by a company-scoped
        partial unique index. It used to be an `exists()` followed by a
        `create()`, which two concurrent replays could both pass — writing two
        identical lines and making the trail say the decision arrived twice. The
        partial index leaves the repeated per-attempt lines alone, because those
        carry no key. */
  const wrote = await writeDecisionAudit({
    companyId, handover, event, decision, at: handover.outcome.decidedAt || new Date(),
  });
  if (wrote.created) reconciled.push("audit");

  /* 2. THE ACQUISITION HOLD. `request` is idempotent on (company, handoverRef)
        at the database, so a concurrent replay cannot make a second one. */
  const hold = await acquisitionHold.request({
    companyId, handover, decision, decidedAt: handover.outcome.decidedAt, now: new Date(),
  });
  if (!hold.owed) return { reconciled, acquisitionHold: { state: "NONE", changed: false, note: "" } };
  if (hold.created) reconciled.push("acquisitionHold");

  /* 3. AND DRIVE IT, IF IT IS STILL OWED AND ITS BACKOFF HAS ELAPSED.
        A command waiting on its backoff is left exactly where it is: it is
        correctly scheduled, and re-attempting it early would defeat the
        backoff. */
  const current = hold.row;
  const unfinished = acquisitionHold.UNFINISHED_STATES.includes(str(current?.state));
  const due = !current?.nextAttemptAt || new Date(current.nextAttemptAt) <= new Date();
  if (!unfinished) {
    return { reconciled, acquisitionHold: { state: str(current?.state), changed: false, note: "Already settled." } };
  }
  if (!due) {
    return {
      reconciled,
      acquisitionHold: { state: str(current.state), changed: false, note: "Awaiting its scheduled retry." },
    };
  }

  try {
    const out = await acquisitionHold.apply({
      companyId, handoverRef: handover.handoverRef, client: mauticClient,
    });
    if (out.changed) reconciled.push("acquisitionHoldApplied");
    return { reconciled, acquisitionHold: { state: out.state, changed: Boolean(out.changed), note: out.note || "" } };
  } catch (err) {
    return {
      reconciled,
      acquisitionHold: { state: str(current.state), changed: false, note: str(err?.message).slice(0, 500) },
    };
  }
}

/**
 * The one audit line a decision leaves.
 *
 * Shared by the first delivery and the reconciler so the two cannot describe the
 * same event differently, and idempotent at the database rather than by a check
 * a concurrent caller could also pass.
 *
 * A duplicate-key error is resolved by READING THE MATCHING ROW. If none comes
 * back, something other than this decision owns that key and the error is
 * re-raised — a duplicate key is evidence about one specific row, not a general
 * licence to call a failed write a success.
 *
 * @returns {Promise<{created:boolean, row:object}>}
 */
async function writeDecisionAudit({ companyId, handover, event, decision, at, previousState = "", details = {} }) {
  /* One per company per handover per decision. Not per delivery. */
  const dedupeKey = `${handover.handoverRef}:decision:${decision.toLowerCase()}`;

  const existing = await MarketingAuditEvent.findOne({ companyId, dedupeKey }).lean();
  if (existing) return { created: false, row: existing };

  try {
    const row = await MarketingAuditEvent.create({
      companyId,
      handoverRef: handover.handoverRef,
      handoverId: handover._id,
      action: `handover.${decision.toLowerCase()}`,
      /* No actor of Marketing's own: this is Sales' act, observed. Inventing a
         marketer for it would be a false attribution. */
      at,
      reason: str(event?.payload?.reason) || str(handover.outcome?.reason),
      previousState,
      resultingState: handover.state,
      correlationId: str(event?.correlationId) || `${handover.handoverRef}:decision`,
      dedupeKey,
      details,
    });
    return { created: true, row: row.toObject() };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const raced = await MarketingAuditEvent.findOne({ companyId, dedupeKey }).lean();
    if (!raced) throw err;
    return { created: false, row: raced };
  }
}

module.exports = { receive, reconcileDecisionSideEffects };
