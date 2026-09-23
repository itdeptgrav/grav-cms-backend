// services/production/sewingStageTarget.service.js
//
// PRODUCTION'S SIDE OF THE PPC SEWING TARGET: SEE IT, ACCEPT IT, OR REFUSE IT.
//
// PPC publishes a sewing target for one Sales line (services/ppc/
// stagePublication.service.js). This is the only way Production answers it,
// and the only thing Production may write on it: its own acceptance or
// refusal of one exact published version.
//
// ── WHY PRODUCTION AND NOT "SEWING" ─────────────────────────────────────────
// Cutting and Embroidery each have a department, an app and a grant of their
// own, so each answers on its own door. Sewing has none of those: the sewing
// floor is the Production Manager's, and the manufacturing order is the screen
// they already work from. So the Production Manager answers for Sewing, using
// the `project-manager` grant that already exists, rather than a new
// department invented to hold one process.
//
// ── TWO DECISIONS THAT LOOK ALIKE AND ARE NOT ───────────────────────────────
// A CAPACITY BOOKING is PPC reserving a factory line for a window. It is made
// in Capacity, before any target exists, and it is PPC's alone.
//
// THIS ANSWER is Production saying whether it will sew that window.
//
// Neither implies the other, and nothing in this file touches a booking:
//
//   · accepting does not confirm, consume or complete a booking;
//   · refusing does not release one — the reservation stays ACTIVE and
//     unchanged until PPC itself replans or releases it in Capacity, which
//     is the only place that decision is made;
//   · a target frozen against a booking PPC has since replanned is not
//     quietly re-pointed: PPC publishes a SUCCESSOR target for the new
//     reservation, and Production answers that one afresh.
//
// The target names the booking it was published against because a sewing
// window with no line held for it is a date with no factory behind it, and
// the manager answering deserves to see which line and which reservation.
// Naming is all it does.
//
// ── AND IT RELEASES NOTHING ─────────────────────────────────────────────────
// Accepting a sewing target creates no manufacturing order, no work order, no
// scan, no progress actual and no completion, and it is not a Production
// release: releasing an order to the floor is a separate act with no field
// here. PPC owns the dates — a refusal changes no schedule and no booking, it
// tells PPC the window does not work and leaves PPC to replan.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// Every read and write is company-scoped by the acting user's own membership,
// and a target of another company reads exactly like one that does not exist.
// Two more things a target must be, to be answerable:
//
//   · SEWING'S. Every lookup, queue read and update filters on the process, so
//     a cutting or embroidery target can never appear here or be answered
//     here — they are those departments' business, on their own doors.
//   · THE LIVE PLAN'S. A planning file that has been superseded or cancelled
//     no longer owns its line, so a target published from it is a retired
//     plan's statement. It leaves the queue and cannot be answered; the
//     successor plan publishes its own.
"use strict";

const mongoose = require("mongoose");

const {
  PpcStagePublication, PUBLICATION_STATE,
} = require("../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcPlanningFile, ACTIVE_STATES } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcCapacityBooking, BOOKING_STATE } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const {
  publicationView, capacityStandingFor, withCapacityStanding, withCapacityStandings,
} = require("../ppc/stagePublication.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const REFUSAL_MIN = 10;
/** The one published process Production answers on this door. */
const SEWING = "SEWING";

/**
 * A refusal has to say something PPC can act on. The same shape as PPC's own
 * "why did this move" rule: long enough, in words, and not one character
 * repeated.
 */
function refusalProblem(raw) {
  const note = str(raw).replace(/\s+/g, " ");
  if (!note) return "Say why Production cannot sew this window.";
  if (note.length < REFUSAL_MIN) return `Say why in at least ${REFUSAL_MIN} characters.`;
  const letters = (note.match(/\p{L}/gu) || []).length;
  const distinct = new Set(note.replace(/\s/g, "").toLowerCase()).size;
  if (letters < 3 || distinct < 4) return "Say why, in words.";
  return null;
}

/** The planning files, of those named, that still own their line. */
async function livePlanIds(companyId, planningFileIds = []) {
  const ids = [...new Set(planningFileIds.map(str).filter(isId))];
  if (!ids.length) return new Set();
  const live = await PpcPlanningFile.find({
    _id: { $in: ids.map(oid) }, companyId: oid(companyId), state: { $in: ACTIVE_STATES },
  }).select({ _id: 1 }).lean();
  return new Set(live.map((p) => str(p._id)));
}

/* WHERE THE FROZEN BOOKING STANDS NOW, and therefore whether an acceptance is
   still a CURRENT accepted deadline. Resolved by PPC's own publication module
   — see `withCapacityStanding` there — so this door and PPC's schedule cannot
   give two answers to one question. Nothing here writes a booking. */
const bookingStanding = capacityStandingFor;
const withStanding = withCapacityStanding;
/* Both kept as this module's own names because its tests and any future
   caller here speak of a BOOKING's standing, not a publication's. */

/** The sewing targets in force for these WorkOrders, within one company. */
async function currentForWorkOrders(companyId, workOrderIds = []) {
  const ids = [...new Set((workOrderIds || []).map(str).filter(isId))];
  if (!isId(companyId) || !ids.length) return [];
  const rows = await PpcStagePublication.find({
    companyId: oid(companyId),
    process: SEWING,
    isCurrent: true,
    "workOrders.workOrderId": { $in: ids.map(oid) },
  }).lean();
  if (!rows.length) return [];
  const live = await livePlanIds(companyId, rows.map((r) => r.planningFileId));
  return withCapacityStandings(companyId,
    rows.filter((r) => live.has(str(r.planningFileId))).map(publicationView));
}

/** Production's view of one sewing target: the window, the line held for it,
    and what this company has already answered. */
const targetView = (p) => (p ? {
  publicationId: p.publicationId,
  publicationVersionNo: p.publicationVersionNo,
  /* The PPC stage-schedule version these dates were read from, frozen with
     the target: Production is answering one exact version of PPC's plan, and
     the screen says which. */
  scheduleVersionNo: p.scheduleVersionNo,
  state: p.state,
  orderLineRef: p.orderLineRef,
  stageLabel: p.stageLabel,
  quantity: p.confirmedQuantity,
  plannedStart: p.plannedStart,
  plannedEnd: p.plannedEnd,
  publishedAt: p.publishedAt,
  publishedByName: p.publishedByName,
  workOrderIds: p.workOrders.map((w) => w.workOrderId),
  /* The reservation PPC proved before publishing, with where it stands now.
     Shown, never actionable from here: Production cannot book, move or
     release a line. */
  capacityBooking: p.capacityBooking,
  /* Is the line still held? A target whose reservation PPC has released or
     replanned cannot be accepted — see `respond` — and the screen says so
     rather than offering a commitment nothing backs. */
  capacityHeld: p.capacityBooking ? p.capacityHeld === true : null,
  /* What moved since the version before it, and why PPC moved it. */
  changes: p.changes,
  replanReason: p.replanReason,
  response: p.response,
  awaitingResponse: p.state === PUBLICATION_STATE.AWAITING,
  /* Said plainly, so no screen has to infer any of it.

     An acceptance given while the line was held stays in `response` above,
     with who gave it and when — it happened, and it is evidence. This is the
     narrower claim, and it is false the moment the reservation stops being
     held: what Production agreed to is no longer a deadline anything backs. */
  isAcceptedDeadline: p.isAcceptedDeadline,
  booksCapacity: false,
  releasesProduction: false,
} : null);

/** The target in force for each of these WorkOrders, keyed by WorkOrder id. */
async function targetsByWorkOrder(companyId, workOrderIds = []) {
  const out = new Map();
  for (const p of await currentForWorkOrders(companyId, workOrderIds)) {
    for (const id of p.workOrders.map((w) => w.workOrderId)) {
      if (!out.has(id)) out.set(id, targetView(p));
    }
  }
  return out;
}

/**
 * Production answers one exact published version.
 *
 * @param decision "ACCEPTED" — Production will sew this window for this
 *                 version; "REFUSED" — it cannot, and says why.
 */
async function respond(companyId, publicationId, { decision, reason = "", actor = null } = {}) {
  if (!isId(companyId)) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  const wanted = str(decision).toUpperCase();
  if (![PUBLICATION_STATE.ACCEPTED, PUBLICATION_STATE.REFUSED].includes(wanted)) {
    throw fail("VALIDATION", "Answer a target by accepting or refusing it.", { field: "decision" });
  }
  /* Missing, another company's, another process's and malformed are one answer. */
  if (!isId(publicationId)) throw fail("SEWING_TARGET_NOT_FOUND", "No sewing target of yours has that id.");
  const doc = await PpcStagePublication.findOne({
    _id: oid(publicationId), companyId: oid(companyId), process: SEWING,
  }).lean();
  if (!doc) throw fail("SEWING_TARGET_NOT_FOUND", "No sewing target of yours has that id.");

  const note = str(reason).replace(/\s+/g, " ");
  if (wanted === PUBLICATION_STATE.REFUSED) {
    const problem = refusalProblem(note);
    if (problem) throw fail("SEWING_TARGET_REFUSAL_REASON_REQUIRED", problem, { field: "reason" });
  }

  /* The plan behind it must still own its line. */
  const live = await livePlanIds(companyId, [doc.planningFileId]);
  if (!live.has(str(doc.planningFileId))) {
    throw fail("SEWING_TARGET_PLAN_RETIRED",
      "The plan this target came from no longer owns its line. PPC's successor plan publishes its own target.",
      { publicationVersionNo: doc.publicationVersionNo });
  }

  /* ── AN ACCEPTANCE NEEDS A LINE THAT IS STILL HELD ─────────────────────
     PPC proved an ACTIVE booking before publishing, and may still release or
     replace it afterwards — that is PPC's decision, made in Capacity, and
     nothing here contests it. What this refuses is the consequence: agreeing
     to sew a window whose line nobody is holding any more. So an ACCEPTED
     target always has a live reservation behind it, and a target whose
     reservation is gone can still be REFUSED — telling PPC the window does
     not work is useful whatever happened to the booking.

     Only on the path that would WRITE an answer. A target that is already
     answered or superseded falls through to the replay and conflict rules
     below unchanged, so a dropped connection retrying an answer that was
     accepted while the line was held still replays, exactly as it does on
     Cutting's and Embroidery's doors. */
  if (wanted === PUBLICATION_STATE.ACCEPTED && doc.capacityBooking
    && doc.state === PUBLICATION_STATE.AWAITING) {
    const held = await PpcCapacityBooking.findOne({
      _id: doc.capacityBooking.bookingId, companyId: oid(companyId), state: BOOKING_STATE.ACTIVE,
    }).select({ _id: 1 }).lean();
    if (!held) {
      throw fail("SEWING_TARGET_BOOKING_INACTIVE",
        `The capacity booking behind this window (${str(doc.capacityBooking.bookingRef)}) is no longer held, `
        + "so it cannot be accepted. PPC publishes a new target for the line it books next.",
        { bookingRef: str(doc.capacityBooking.bookingRef) });
    }
  }

  /* ── ONE ANSWER, DECIDED BY THE DATABASE ───────────────────────────────
     Two managers answering at once both pass a read-then-check, and the
     second write would quietly replace the first answer. The state is part
     of the filter instead, so exactly one update can match.

     The update sets the answer and NOTHING else: no booking field, no
     release, no work order, no actual. */
  const answered = await PpcStagePublication.findOneAndUpdate(
    { _id: doc._id, companyId: oid(companyId), process: SEWING, isCurrent: true, state: PUBLICATION_STATE.AWAITING },
    {
      $set: {
        state: wanted,
        response: {
          state: wanted,
          at: new Date(),
          by: { id: oid(actor.id), name: str(actor.name) },
          reason: wanted === PUBLICATION_STATE.REFUSED ? note : "",
        },
      },
    },
    { new: true },
  ).lean();
  if (answered) {
    /* Resolved AFTER the write, not before it. If PPC released the line in
       the moment between the check above and this update — a narrow race
       neither side can lock against, because answering must not write a
       booking — the answer that comes back already says the reservation is
       gone and is already not a current accepted deadline. */
    const [view] = await withCapacityStandings(companyId, [publicationView(answered)]);
    return { target: targetView(view) };
  }

  /* It was not awaiting. The SAME answer, from the same person, is that
     answer again — a double click or a dropped connection must not read as a
     failure. Anything else is somebody else's decision, or a version PPC has
     since replaced, and says so. */
  const now = await PpcStagePublication.findById(doc._id).lean();
  if (now?.response?.state === wanted && str(now.response.by?.id) === str(actor.id)) {
    const [view] = await withCapacityStandings(companyId, [publicationView(now)]);
    return { target: targetView(view), replayed: true };
  }
  if (now?.state === PUBLICATION_STATE.SUPERSEDED || !now?.isCurrent) {
    throw fail("SEWING_TARGET_ALREADY_ANSWERED",
      "PPC has published a newer version of this target. Answer that one.",
      { state: now?.state, publicationVersionNo: now?.publicationVersionNo });
  }
  throw fail("SEWING_TARGET_ALREADY_ANSWERED",
    `This target was already ${str(now?.state).toLowerCase()}${now?.response?.by?.name ? ` by ${str(now.response.by.name)}` : ""}. `
    + "PPC publishes a new version if it changes.", { state: now?.state });
}

module.exports = {
  REFUSAL_MIN, SEWING, refusalProblem, currentForWorkOrders, targetsByWorkOrder, targetView, respond,
  bookingStanding, withStanding,
};
