// services/production/packingStageTarget.service.js
//
// PACKAGING & DISPATCH'S SIDE OF THE PPC PACKING TARGET: SEE IT, ACCEPT IT,
// OR REFUSE IT.
//
// PPC publishes a packing target for one Sales line (services/ppc/
// stagePublication.service.js). This is the only way Packaging & Dispatch
// answers it, and the only thing it may write on it: its own acceptance or
// refusal of one exact published version.
//
// ── THE GRAIN: ONE LINE, ONE ANSWER ─────────────────────────────────────────
// A target is published for one Sales order line and answered once, even
// though the line's work is done against several WorkOrders and the floor
// packs one unit at a time. Those unit records are Packaging's own execution
// actuals and stay exactly where they are: accepting a target packs no unit,
// and no number of packed units ever amounts to an acceptance.
//
// ── WHAT AN ACCEPTANCE IS NOT ───────────────────────────────────────────────
// It is not packing completion. `packagingRoutes.js` treats packing a unit as
// the authoritative "this unit is fully done" signal, writes packagingRecords
// and moves `overallCompletedQuantity`; none of that is touched from here and
// none of it is implied by an answer. Accepting creates no packaging record,
// no label, no scan, no quantity, no dispatch challan and no actual, and it
// authorises no dispatch. It is not a Production release either. It says one
// thing: Packaging & Dispatch can have the order packed inside the window PPC
// asked about.
//
// ── WHOSE DECISION IS WHOSE ─────────────────────────────────────────────────
// PPC owns the dates: nothing here edits a target, a schedule or a plan, and
// a refusal changes none of them — it tells PPC the window does not work and
// leaves PPC to replan. Packaging & Dispatch owns this answer: PPC cannot
// accept on its behalf, because PPC's own door has no accept command, and PPC
// cannot mark packing complete.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// Every read and write is company-scoped by the acting user's own membership,
// and a target of another company reads exactly like one that does not exist.
// Two more things a target must be, to be answerable:
//
//   · PACKING'S. Every lookup, queue read and update filters on the process,
//     so a cutting, embroidery or sewing target can never appear here or be
//     answered here — they are those departments' business, on their own
//     doors.
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
const { publicationView } = require("../ppc/stagePublication.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const REFUSAL_MIN = 10;
/** The one published process this department answers. */
const PACKING = "PACKING";

/**
 * A refusal has to say something PPC can act on. The same shape as PPC's own
 * "why did this move" rule: long enough, in words, and not one character
 * repeated.
 */
function refusalProblem(raw) {
  const note = str(raw).replace(/\s+/g, " ");
  if (!note) return "Say why Packaging & Dispatch cannot pack this window.";
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

/** The packing targets in force for these WorkOrders, within one company. */
async function currentForWorkOrders(companyId, workOrderIds = []) {
  const ids = [...new Set((workOrderIds || []).map(str).filter(isId))];
  if (!isId(companyId) || !ids.length) return [];
  const rows = await PpcStagePublication.find({
    companyId: oid(companyId),
    process: PACKING,
    isCurrent: true,
    "workOrders.workOrderId": { $in: ids.map(oid) },
  }).lean();
  if (!rows.length) return [];
  const live = await livePlanIds(companyId, rows.map((r) => r.planningFileId));
  return rows.filter((r) => live.has(str(r.planningFileId))).map(publicationView);
}

/** Packaging's view of one target: what to pack, by when, and what it answered. */
const targetView = (p) => (p ? {
  publicationId: p.publicationId,
  publicationVersionNo: p.publicationVersionNo,
  /* The PPC stage-schedule version these dates were read from, frozen with
     the target: the floor is answering one exact version of PPC's plan, and
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
  /* What moved since the version before it, and why PPC moved it. */
  changes: p.changes,
  replanReason: p.replanReason,
  response: p.response,
  awaitingResponse: p.state === PUBLICATION_STATE.AWAITING,
  /* Said plainly, so no screen has to infer any of it: a target is PPC's
     request, not a released work instruction, not packing done, and not
     permission to dispatch. */
  isAcceptedDeadline: p.isAcceptedDeadline,
  booksCapacity: false,
  releasesProduction: false,
  authorisesDispatch: false,
  completesPacking: false,
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
 * Packaging & Dispatch answers one exact published version.
 *
 * @param decision "ACCEPTED" — it can pack inside these dates for this exact
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
  if (!isId(publicationId)) throw fail("PACKING_TARGET_NOT_FOUND", "No packing target of yours has that id.");
  const doc = await PpcStagePublication.findOne({
    _id: oid(publicationId), companyId: oid(companyId), process: PACKING,
  }).lean();
  if (!doc) throw fail("PACKING_TARGET_NOT_FOUND", "No packing target of yours has that id.");

  const note = str(reason).replace(/\s+/g, " ");
  if (wanted === PUBLICATION_STATE.REFUSED) {
    const problem = refusalProblem(note);
    if (problem) throw fail("PACKING_TARGET_REFUSAL_REASON_REQUIRED", problem, { field: "reason" });
  }

  /* The plan behind it must still own its line. */
  const live = await livePlanIds(companyId, [doc.planningFileId]);
  if (!live.has(str(doc.planningFileId))) {
    throw fail("PACKING_TARGET_PLAN_RETIRED",
      "The plan this target came from no longer owns its line. PPC's successor plan publishes its own target.",
      { publicationVersionNo: doc.publicationVersionNo });
  }

  /* ── ONE ANSWER, DECIDED BY THE DATABASE ───────────────────────────────
     Two packaging editors answering at once both pass a read-then-check, and
     the second write would quietly replace the first answer. The state is
     part of the filter instead, so exactly one update can match.

     The update sets the answer and NOTHING else: no packaging record, no
     label, no scanned unit, no quantity, no dispatch, no release. */
  const answered = await PpcStagePublication.findOneAndUpdate(
    { _id: doc._id, companyId: oid(companyId), process: PACKING, isCurrent: true, state: PUBLICATION_STATE.AWAITING },
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
  if (answered) return { target: targetView(publicationView(answered)) };

  /* It was not awaiting. The SAME answer, from the same person, is that
     answer again — a double click or a dropped connection must not read as a
     failure. Anything else is somebody else's decision, or a version PPC has
     since replaced, and says so. */
  const now = await PpcStagePublication.findById(doc._id).lean();
  if (now?.response?.state === wanted && str(now.response.by?.id) === str(actor.id)) {
    return { target: targetView(publicationView(now)), replayed: true };
  }
  if (now?.state === PUBLICATION_STATE.SUPERSEDED || !now?.isCurrent) {
    throw fail("PACKING_TARGET_ALREADY_ANSWERED",
      "PPC has published a newer version of this target. Answer that one.",
      { state: now?.state, publicationVersionNo: now?.publicationVersionNo });
  }
  throw fail("PACKING_TARGET_ALREADY_ANSWERED",
    `This target was already ${str(now?.state).toLowerCase()}${now?.response?.by?.name ? ` by ${str(now.response.by.name)}` : ""}. `
    + "PPC publishes a new version if it changes.", { state: now?.state });
}

module.exports = {
  REFUSAL_MIN, PACKING, refusalProblem, currentForWorkOrders, targetsByWorkOrder, targetView, respond,
};
