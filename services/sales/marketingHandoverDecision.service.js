// services/sales/marketingHandoverDecision.service.js
//
// SALES ANSWERS. ACCEPTING IS NOT PROMOTING.
//
// ── THE DISTINCTION THIS FILE IS BUILT AROUND ──────────────────────────────
// "Accept" means a salesperson has taken ownership of the Prospect and will
// make the first personal contact. It does NOT mean the Prospect becomes an
// Active Lead. The product plan's own sequence is explicit:
//
//     Sales accepts → salesperson makes the first personal contact
//     → confirmed two-way interest + internal approval → Active Lead
//
// So accepting assigns an owner and leaves `captureStatus` at "draft" and
// `reviewStatus` at "researching". Becoming an Active Lead stays exactly what
// it already was: a Sales act, performed by a Sales user, through
// services/leadReview.js. Nothing in this file imports that service, and
// nothing here writes `captureStatus`, `reviewStatus` or `qualificationState`
// on an accept.
//
// ── THE THREE ANSWERS THAT ARE NOT "YES" ───────────────────────────────────
//   RETURN            the Prospect is archived as a draft and Marketing is
//                     told what to nurture and when to look again. Archiving
//                     uses the EXISTING draft-archive fields, the same ones
//                     "Archive Draft" already writes — a returned Prospect is
//                     exactly as disposed as one a salesperson archived, and
//                     no new disposal concept is introduced.
//   REJECT            the same disposal with a different reason: invalid,
//                     irrelevant, spam or out of scope.
//   LINK DUPLICATE    the created Prospect is archived and the handover is
//                     attached to the record Sales says this really is.
//
// `reviewStatus` is deliberately left alone in all three. Setting it to
// "rejected" would put a HOD's verdict on a Prospect no HOD saw, and
// services/leadReview.js is the only writer of that field.
//
// ── EVERY DECISION ANNOUNCES ITSELF ────────────────────────────────────────
// The decision and its outbox row are written together, so a recorded decision
// always has an announcement waiting for Marketing. Delivery is separate and
// may fail; the decision is not undone by that, and the row stays PENDING.
"use strict";

const mongoose = require("mongoose");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const {
  MarketingHandoverReceipt, SalesMarketingOutcomeOutboxEvent,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const { fail } = require("../storePurchase/errors");
const {
  SALES_DECISION_CODES, DECISION_REASON_REQUIRED, SALES_OUTCOME_EVENT_KINDS,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/**
 * Record one Sales decision on a received handover.
 *
 * @param {object} args.companyId   the caller's resolved company
 * @param {string} args.handoverRef
 * @param {string} args.decision    ACCEPTED | RETURNED | REJECTED | DUPLICATE_LINKED
 * @param {object} args.actor       who decided
 */
async function decide({
  companyId, handoverRef, decision, reason = "", nurtureTopic = "", revisitAt = null,
  duplicateOfType = "", duplicateOfId = null, assignTo = null, assignToName = "",
  actor = {}, now = new Date(),
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A handover decision needs a company.");
  }
  if (!SALES_DECISION_CODES.includes(decision)) {
    throw fail("VALIDATION", `"${decision}" is not a decision Sales can record.`, {
      field: "decision", accepted: SALES_DECISION_CODES,
    });
  }
  if (DECISION_REASON_REQUIRED.has(decision) && !str(reason)) {
    throw fail("VALIDATION", "A reason is required — Marketing acts on it.", { field: "reason" });
  }
  if (decision === "DUPLICATE_LINKED" && !duplicateOfId) {
    throw fail("VALIDATION", "Say which existing record this is a duplicate of.", { field: "duplicateOfId" });
  }

  const receipt = await MarketingHandoverReceipt.findOne({ companyId, handoverRef: str(handoverRef) });
  if (!receipt) throw fail("NOT_FOUND", "That handover was not found.");

  /* ── ONE ANSWER PER HANDOVER, BUT A REPLAY IS NOT A SECOND ANSWER ───────
     There is only one transition, from undecided to decided. A salesperson who
     changes their mind acts on the Prospect directly — the handover records
     what was decided at the time, and rewriting it would erase the fact
     Marketing already learned from. A DIFFERENT decision is therefore still
     refused, below.

     ── THE GAP THIS BRANCH CLOSES ────────────────────────────────────────
     The order here is: save the Lead, save the receipt's decision, create the
     outcome outbox event. Nothing spans those, so a crash or a refused write
     before the third left the decision permanently stored with no announcement
     — and repeating the very same decision then threw INVALID_TRANSITION, so
     the announcement was never created, Marketing never heard, and no
     acquisition hold was ever raised. The decision was recorded and silently
     inert, and no amount of retrying could fix it.

     So repeating the SAME decision is an idempotent replay that ensures the
     announcement exists before returning. Nothing about the original decision
     is rewritten: not its time, its actor, its reason, its assignment or its
     nurture instruction. */
  if (receipt.decision) {
    if (receipt.decision !== decision) {
      throw fail("INVALID_TRANSITION",
        `That handover was already ${receipt.decision.toLowerCase().replace("_", " ")}.`,
        { decision: receipt.decision, decidedAt: receipt.decidedAt });
    }

    const repaired = await ensureOutcomeEvent(receipt);
    const decidedLead = receipt.leadId ? await Lead.findOne({ companyId, _id: receipt.leadId }) : null;
    return {
      receipt: receipt.toObject(),
      lead: decidedLead ? decidedLead.toObject() : null,
      duplicate: true,
      /* Says whether this replay had to repair anything, so a caller can tell a
         harmless double-click from a genuine repair. */
      outcomeEventRepaired: repaired.created,
    };
  }

  const lead = receipt.leadId ? await Lead.findOne({ companyId, _id: receipt.leadId }) : null;

  /* ── THE SALES-SIDE EFFECT OF EACH ANSWER ─────────────────────────────── */
  if (lead) {
    if (decision === "ACCEPTED") {
      /* Ownership only. captureStatus, reviewStatus and qualificationState are
         untouched — this Prospect is now a salesperson's to work, exactly as
         if they had captured it themselves. */
      lead.assignedTo = assignTo || actor.id || lead.assignedTo;
      lead.assignedToName = assignToName || actor.name || lead.assignedToName;
      lead.updatedBy = { id: actor.id, name: actor.name };
    } else if (lead.captureStatus === "draft") {
      /* The EXISTING draft disposal, unchanged. Same fields "Archive Draft"
         writes, so a returned or rejected handover is exactly as disposed as a
         Prospect a salesperson archived by hand. */
      lead.captureStatus = "archived";
      lead.draftArchivedAt = now;
      lead.draftArchivedBy = { id: actor.id, name: actor.name };
      lead.updatedBy = { id: actor.id, name: actor.name };
    }
    await lead.save();
  }

  receipt.decision = decision;
  receipt.decidedAt = now;
  receipt.decidedBy = { id: actor.id, name: actor.name, email: actor.email };
  receipt.decisionReason = str(reason);
  receipt.nurtureTopic = str(nurtureTopic);
  receipt.revisitAt = revisitAt ? new Date(revisitAt) : null;
  if (decision === "DUPLICATE_LINKED") {
    receipt.duplicateOfType = str(duplicateOfType) || "lead";
    receipt.duplicateOfId = duplicateOfId;
  }
  if (decision === "ACCEPTED") {
    receipt.assignedTo = assignTo || actor.id || null;
    receipt.assignedToName = assignToName || str(actor.name);
  }
  await receipt.save();

  /* ── THE ANNOUNCEMENT ──────────────────────────────────────────────────
     Identity of the Sales record and the decision. Never its lifecycle state,
     its requirement or any commercial figure: Marketing has no business
     holding those, and a field it holds is a field it will eventually
     display. */

  await ensureOutcomeEvent(receipt);

  return {
    receipt: receipt.toObject(),
    lead: lead ? lead.toObject() : null,
    duplicate: false,
    outcomeEventRepaired: false,
  };
}

/**
 * Ensure the one outcome announcement this decided receipt owes.
 *
 * ── WHY IT IS DERIVED FROM THE RECEIPT, NOT FROM THE CALLER'S ARGUMENTS ────
 * A replay reaches here with whatever the caller passed this time, which may be
 * an empty body from a retried request. Every field is therefore read from the
 * stored receipt, so the announcement says what was actually decided rather
 * than what the second caller happened to send. That is also what makes the
 * repair safe to run from a reconciliation sweep, which has no arguments at all.
 *
 * Idempotent at the database: the unique index on
 * (companyId, correlationId, kind) is what guarantees one event, not the read
 * below. A duplicate-key error is resolved by READING THE MATCHING ROW, with
 * the company in the selector — if none comes back, something other than this
 * announcement owns that key and the error is re-raised rather than swallowed
 * as success.
 *
 * @returns {Promise<{created:boolean, event:object}>}
 */
async function ensureOutcomeEvent(receipt) {
  const correlationId = `${receipt.correlationId || receipt.handoverRef}:decision`;
  const kind = SALES_OUTCOME_EVENT_KINDS.DECIDED;

  /* Company first on every lookup, including the duplicate-key read-back below:
     an announcement is only ever this company's. */
  const key = { companyId: receipt.companyId, correlationId, kind };
  const existing = await SalesMarketingOutcomeOutboxEvent.findOne(key).lean();
  if (existing) return { created: false, event: existing };

  const salesRecord = receipt.decision === "DUPLICATE_LINKED"
    ? { type: str(receipt.duplicateOfType) || "lead", id: receipt.duplicateOfId, ref: "" }
    : { type: receipt.leadId ? "lead" : "", id: receipt.leadId, ref: str(receipt.leadRef) };

  try {
    const created = await SalesMarketingOutcomeOutboxEvent.create({
      companyId: receipt.companyId,
      kind,
      payload: {
        handoverRef: receipt.handoverRef,
        receiptId: receipt._id,
        decision: receipt.decision,
        reason: str(receipt.decisionReason),
        nurtureTopic: str(receipt.nurtureTopic),
        revisitAt: receipt.revisitAt,
        salesRecordType: salesRecord.type,
        salesRecordId: salesRecord.id,
        salesRecordRef: salesRecord.ref,
      },
      occurredAt: receipt.decidedAt || new Date(),
      actor: {
        id: receipt.decidedBy?.id, name: str(receipt.decidedBy?.name), email: str(receipt.decidedBy?.email),
      },
      correlationId,
    });
    return { created: true, event: created.toObject() };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* Somebody created it between the read and the insert. Theirs is the one
       that exists — but only if it really is this announcement. */
    const raced = await SalesMarketingOutcomeOutboxEvent.findOne(key).lean();
    if (!raced) throw err;
    return { created: false, event: raced };
  }
}

/* How many decided receipts one scan will read before giving up and saying so.
   A ceiling rather than a silent stop: the caller is told the scan was
   truncated and where to resume. */
const RECONCILE_SCAN_BUDGET = 2000;
const RECONCILE_PAGE = 200;

/**
 * Decided handovers whose announcement never made it, for this company.
 *
 * ── THE BUG THIS SHAPE FIXES ───────────────────────────────────────────────
 * The first version read the OLDEST 200 decided receipts and then asked which
 * of those were missing an announcement. Every sweep therefore examined the
 * same 200 rows for ever. If those 200 were all healthy — which is the normal
 * case, because the oldest decisions are the ones most likely to have been
 * delivered long ago — a receipt at position 201 with a missing announcement
 * was never once looked at, and every sweep reported a clean run.
 *
 * The limit now bounds the MISSING ROWS FOUND, not the rows read. The scan
 * pages forward on `_id`, which is stable while rows are being written
 * underneath it, and stops when it has found what was asked for, run out of
 * receipts, or spent its scan budget — and it says which.
 *
 * @returns {Promise<{rows:Array, examined:number, complete:boolean,
 *                    hasMore:boolean, nextCursor:string|null}>}
 */
async function decidedReceiptsMissingOutcomeEvent({
  companyId, limit = 50, cursor = null, pageSize = RECONCILE_PAGE, scanBudget = RECONCILE_SCAN_BUDGET,
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Reconciling outcome announcements needs a company.");
  }
  const wantMissing = Math.max(1, Math.min(Number(limit) || 50, 200));
  const page = Math.max(1, Math.min(Number(pageSize) || RECONCILE_PAGE, 500));
  const budget = Math.max(page, Number(scanBudget) || RECONCILE_SCAN_BUDGET);

  const rows = [];
  let examined = 0;
  let after = cursor ? new mongoose.Types.ObjectId(String(cursor)) : null;
  let exhausted = false;
  let nextCursor = null;

  while (rows.length < wantMissing && examined < budget) {
    const selector = { companyId, decision: { $exists: true, $ne: null } };
    if (after) selector._id = { $gt: after };

    /* Ascending `_id` is the stable order: a row written during the scan sorts
       after everything already read, so paging cannot skip or repeat. */
    const batch = await MarketingHandoverReceipt
      .find(selector).sort({ _id: 1 }).limit(page).lean();

    if (!batch.length) { exhausted = true; break; }

    examined += batch.length;
    after = batch[batch.length - 1]._id;

    const wanted = batch.map((r) => `${r.correlationId || r.handoverRef}:decision`);
    const present = new Set((await SalesMarketingOutcomeOutboxEvent
      .find({ companyId, kind: SALES_OUTCOME_EVENT_KINDS.DECIDED, correlationId: { $in: wanted } })
      .select("correlationId").lean()).map((e) => e.correlationId));

    for (const r of batch) {
      if (present.has(`${r.correlationId || r.handoverRef}:decision`)) continue;
      rows.push(r);
      if (rows.length >= wantMissing) {
        /* Resume from this row, not from the end of the page: everything after
           it in this page is still unexamined. */
        nextCursor = String(r._id);
        break;
      }
    }
    if (batch.length < page) { exhausted = true; break; }
  }

  const complete = exhausted && rows.length < wantMissing;
  return {
    rows,
    examined,
    /* True only when every decided receipt this company has was looked at. */
    complete,
    hasMore: !complete,
    nextCursor: complete ? null : (nextCursor || (after ? String(after) : null)),
  };
}

/**
 * Create the announcements those receipts owe.
 *
 * Bounded and company-scoped, and honest about a truncated scan: `complete` is
 * false when there may be more to find, so a caller cannot read "0 repaired" as
 * "nothing is wrong". Not a scheduler and not described as one — it runs when
 * the delivery sweep runs or when an operator asks.
 */
async function repairMissingOutcomeEvents({ companyId, limit = 50, cursor = null, pageSize } = {}) {
  const scan = await decidedReceiptsMissingOutcomeEvent({ companyId, limit, cursor, pageSize });
  const summary = {
    examined: scan.examined,
    found: scan.rows.length,
    repaired: 0,
    failed: 0,
    complete: scan.complete,
    hasMore: scan.hasMore,
    nextCursor: scan.nextCursor,
    errors: [],
  };

  for (const row of scan.rows) {
    try {
      const receipt = await MarketingHandoverReceipt.findOne({ companyId, _id: row._id });
      if (!receipt?.decision) continue;
      const out = await ensureOutcomeEvent(receipt);
      if (out.created) summary.repaired += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${row.handoverRef}: ${str(err?.message).slice(0, 200)}`);
    }
  }
  return summary;
}

/** Pending outcome announcements, oldest by when Sales acted. */
async function pendingOutboxEvents({ companyId = null, limit = 50 } = {}) {
  const q = { status: "PENDING" };
  if (companyId) q.companyId = companyId;
  return SalesMarketingOutcomeOutboxEvent.find(q).sort({ occurredAt: 1, _id: 1 }).limit(limit).lean();
}

/* ── EVERY STATUS UPDATE IS ADDRESSED BY COMPANY AND ID, ALWAYS ─────────────
   An id alone would be enough to find the row, which is exactly why it is not
   enough. These two used to fall back to `{ _id: id }` when no company was
   passed — a selector that CAN match another company's row, and one that will
   the day something passes an id from the wrong place. A fallback like that is
   also self-concealing: it works perfectly until the one time it is wrong.

   So the company is required, and its absence is a refusal rather than a
   widened selector. Nothing is written on that path.

   The only production caller is
   services/integration/marketingOutcomeDelivery.service.js, which takes both
   values from the event row it is delivering; `companyId` is required on the
   outbox schema and no read here projects it away, so a pending event always
   carries one. */
function assertOutboxTarget(id, companyId) {
  if (!id) {
    throw fail("VALIDATION", "An outcome announcement is addressed by its id.", { field: "id" });
  }
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN",
      "An outcome announcement cannot be updated without the company that owns it.");
  }
  return { _id: id, companyId };
}

async function markOutboxDelivered(id, companyId) {
  await SalesMarketingOutcomeOutboxEvent.updateOne(
    assertOutboxTarget(id, companyId),
    { $set: { status: "DELIVERED", deliveredAt: new Date(), lastError: "" }, $inc: { attempts: 1 } },
  );
}

async function markOutboxAttemptFailed(id, err, companyId) {
  await SalesMarketingOutcomeOutboxEvent.updateOne(
    assertOutboxTarget(id, companyId),
    {
      $set: { lastAttemptAt: new Date(), lastError: str(err?.message).slice(0, 500) },
      $inc: { attempts: 1 },
    },
  );
}

module.exports = {
  decide,
  ensureOutcomeEvent,
  assertOutboxTarget,
  decidedReceiptsMissingOutcomeEvent,
  repairMissingOutcomeEvents,
  pendingOutboxEvents,
  markOutboxDelivered,
  markOutboxAttemptFailed,
};
