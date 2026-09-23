// services/ppc/stageSchedule.service.js
//
// PPC'S MULTI-STAGE SCHEDULE FOR ONE PERMANENT SALES ORDER LINE.
//
// ── WHICH STAGES ────────────────────────────────────────────────────────────
// Exactly the REQUIRED stages of the IE process route frozen in the planning
// file's own release, read through IE's published contract
// (`publishReleaseProcessRoute`) by that release's id — never the style's
// current release, never inferred from operation names or machine codes. An
// optional stage appears only if the approved route marks it REQUIRED; a
// NOT_APPLICABLE stage is listed as such and cannot be dated. A route IE could
// not prove (`UNKNOWN`) is a blocker: nothing can be scheduled against it.
//
// ── ONLY IF THAT ROUTE IS PROVABLY THIS LINE'S ──────────────────────────────
// IE's route is per style; two lines of one style can differ. So before any
// stage is dated, `lineRouteApplicability.prove` checks the whole frozen chain
// — company, permanent line, the Sales handover version the frozen pack names,
// the release's style, and the line's stated special processes. Anything
// missing, contradictory, historical-UNKNOWN or unreadable blocks every save
// with a named reason. An existing schedule and its history stay readable.
//
// ── WHAT A DATE MEANS HERE ──────────────────────────────────────────────────
// A PPC-internal planning target. Nothing is published to Cutting, Embroidery
// or any other app: a WorkOrder is not yet provably linked to the Sales line,
// so every handoff reads "not connected". Nothing here books capacity — the
// sewing booking is read, beside the sewing stage, and never written — and
// nothing authorizes Production to start.
//
// ── NOTHING IS OVERWRITTEN SILENTLY ─────────────────────────────────────────
// Each save is a schedule version. Moving a date that was already set is a
// replan and needs a reason; the version records every changed stage's old and
// new dates. A stage cannot start before a predecessor's planned finish, so a
// moved predecessor cannot leave a dependent silently in conflict.
"use strict";

const mongoose = require("mongoose");

const { PpcPlanningFile, ACTIVE_STATES } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcStageSchedule, LIMITS } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const ie = require("../industrialEngineering/releasePublication.service");
const { planningCommand } = require("./planningCommand");
const { isBusinessDate } = require("./businessDate");
const { resolutionProblem } = require("./planningFile.service");
const applicability = require("./lineRouteApplicability.service");
const cuttingBasis = require("./cuttingTechnicalBasis.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/* ══ HANDOFFS — HONEST ABOUT WHAT IS NOT CONNECTED ═══════════════════════ */

const NO_WORKORDER_LINK = "Handoff not connected — WorkOrder is not linked to this Sales line.";
const NO_RECEIVER = "Handoff not connected — no receiving app contract yet.";

/**
 * What PPC can truthfully say about each stage's handoff today. Cutting,
 * Embroidery, Sewing and Packing have a receiving contract; other processes
 * have none and say so rather than borrowing one.
 *
 * ── SEWING SAYS TWO THINGS, AND THEY ARE NOT THE SAME THING ────────────────
 * A capacity booking is PPC's own reservation of a factory line, made in
 * Capacity. Production's acceptance is a different department agreeing to the
 * window. A booking is therefore never reported as an acceptance, and an
 * acceptance never implies one: the booking line is carried alongside every
 * sewing answer below, so the row shows both facts at once. Nothing here
 * changes either: this file reads the booking and never writes one.
 */
/* The departments a target can be published to, and the name each is called
   on the row. A process not here has no receiving contract yet. */
const RECEIVER = Object.freeze({
  CUTTING: "Cutting", EMBROIDERY: "Embroidery", SEWING: "Production",
  PACKING: "Packaging & Dispatch",
});

/** "Sewing capacity booked: …", or the honest absence of one. */
const bookingLine = (booking) => (booking
  ? `Sewing capacity booked: ${booking.bookingRef} on ${booking.lineRef}, ${booking.windowStart} → ${booking.windowEnd}.`
  : "No sewing capacity booked yet — booked separately in Capacity.");

/* What PPC did to the reservation a target was published against. Each is a
   different act with a different remedy, so none of them is called by
   another's name. */
const STANDING_SENTENCE = Object.freeze({
  RELEASED: "PPC has since released that reservation",
  SUPERSEDED: "PPC has since moved that reservation by replanning it",
  MISSING: "that reservation can no longer be found",
});
const standingSentence = (standing) => STANDING_SENTENCE[standing] || "that reservation is no longer held";

function handoffFor(process, booking, { publication = null, workLinked = false } = {}) {
  const receiver = RECEIVER[process];
  if (process === "SEWING") {
    /* The reservation, always; the department's answer when there is one. */
    const standing = publication?.capacityBooking?.standing || null;
    /* A target says whether ITS OWN frozen reservation is still held. The
       plan's currently active booking is a different question — after a
       replan there is one, and it is not this target's. */
    const held = standing ? standing === "ACTIVE" : Boolean(booking);
    const capacity = {
      booking: booking || null,
      capacityStanding: standing,
      capacityHeld: publication ? held : Boolean(booking),
      capacityMessage: bookingLine(booking),
    };
    if (!publication) {
      return booking
        ? { state: "CAPACITY_BOOKED", ...capacity,
          message: `${bookingLine(booking)} Not published to Production yet.` }
        : { state: "NO_BOOKING", ...capacity, message: bookingLine(booking) };
    }
    const answer = answerOf(receiver, publication, process);
    /* ── AN ACCEPTANCE IS NOT A DEADLINE WITHOUT A LINE ────────────────
       Production did accept these dates, and that stays true and readable:
       the response, the responder and the time are untouched. What stops
       being true is that the schedule has an accepted deadline standing on a
       reserved line. Its own state, so nothing reading `ACCEPTED_DEADLINE`
       can pick this up by mistake. */
    if (publication.state === "ACCEPTED" && !held) {
      const frozen = publication.capacityBooking;
      return { ...answer, ...capacity,
        state: "ACCEPTED_CAPACITY_NOT_HELD",
        message: `${receiver} accepted ${publication.plannedStart} → ${publication.plannedEnd}, but `
          + `${standingSentence(standing)}${frozen?.bookingRef ? ` (${frozen.bookingRef})` : ""}. `
          + "The acceptance stands as history; it is no longer a current accepted deadline. "
          + "Book the line again and publish a new target.",
      };
    }
    return { ...answer, ...capacity };
  }
  if (receiver) {
    /* Published: the receiver's own answer, and nothing stronger than it —
       a target is AWAITING until that department itself accepts it. */
    if (publication) return answerOf(receiver, publication, process);
    /* Not published. Publishable only when a WorkOrder of this exact company
       and line exists; without one there is nobody to publish to. */
    return workLinked
      ? { state: "NOT_PUBLISHED", message: `Internal target only — not published to ${receiver}.` }
      : { state: "NOT_CONNECTED", reason: "WORKORDER_NOT_LINKED", message: NO_WORKORDER_LINK };
  }
  return { state: "NOT_CONNECTED", reason: "NO_RECEIVER", message: NO_RECEIVER };
}

/** One receiving department's own answer to one published version. */
function answerOf(receiver, publication, process) {
  const dates = `${publication.plannedStart} → ${publication.plannedEnd}`;
  if (publication.state === "ACCEPTED") {
    return { state: "ACCEPTED_DEADLINE", publicationVersionNo: publication.publicationVersionNo,
      message: `${receiver} accepted this target: ${dates}.` };
  }
  if (publication.state === "REFUSED") {
    return { state: "REFUSED", publicationVersionNo: publication.publicationVersionNo,
      message: `${receiver} refused this target: ${publication.response?.reason || "no reason recorded"}` };
  }
  if (publication.state === "SUPERSEDED") {
    return { state: "SUPERSEDED", publicationVersionNo: publication.publicationVersionNo,
      message: publication.supersededByPlan
        /* The plan itself stopped owning the line: its target went with
           it, and the department can no longer answer it. */
        ? `This plan no longer owns its line, so its published target is superseded. ${receiver} cannot answer it.`
        : "Replaced by a newer published target." };
  }
  return { state: `AWAITING_${process}`, publicationVersionNo: publication.publicationVersionNo,
    message: `Published to ${receiver}: ${dates} — awaiting ${receiver}'s response.` };
}

/* ══ READING ═════════════════════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function loadPlan(ctx, planningFileId, session = null) {
  if (!isId(planningFileId)) {
    throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that id.");
  }
  const q = PpcPlanningFile.findOne({ _id: oid(planningFileId), companyId: oid(ctx.companyId) });
  if (session) q.session(session);
  const plan = await q.lean();
  if (!plan) throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that id.");
  return plan;
}

/**
 * The route for the release this plan FROZE. `UNREADABLE` when IE could not be
 * read — a failed read, never an empty route — and `NO_RELEASE` when the plan
 * froze none.
 */
async function routeFor(ctx, plan) {
  const releaseId = plan.sourceBasis?.ieReleaseId ? String(plan.sourceBasis.ieReleaseId) : null;
  if (!releaseId) return { state: "NO_RELEASE", stages: null };
  let r;
  try {
    r = await ie.publishReleaseProcessRoute({ companyId: ctx.companyId }, releaseId);
  } catch {
    return { state: "UNREADABLE", stages: null };
  }
  if (!r) return { state: "UNREADABLE", stages: null };
  return {
    state: r.routeState === "DECLARED" ? "DECLARED" : "UNKNOWN",
    releaseId: r.releaseId, releaseRef: r.releaseRef, versionNo: r.versionNo, releaseState: r.state,
    sampleStyleId: r.sampleStyleId ? String(r.sampleStyleId) : null,
    stages: r.routeState === "DECLARED" ? r.stages : null,
  };
}

async function activeBooking(ctx, plan) {
  const b = await PpcCapacityBooking.findOne({
    companyId: oid(ctx.companyId), planningFileId: plan._id, state: "ACTIVE",
  }).select({ bookingRef: 1, lineRef: 1, windowStart: 1, windowEnd: 1, state: 1 }).lean();
  return b ? { bookingRef: b.bookingRef, lineRef: b.lineRef, windowStart: b.windowStart, windowEnd: b.windowEnd } : null;
}

const editableState = (plan) => ACTIVE_STATES.includes(str(plan.state));

/* The answer's applicability block: the verdict, the named reason, who can
   resolve it, and the exact versions it was proved (or refused) against. */
const applicabilityView = (a) => ({
  state: a.state, reason: a.reason, kind: a.kind, owner: a.owner, message: a.message,
  evidence: a.evidence, processes: a.processes,
});

function project({ plan, route, schedule, booking, proof, publications = [], workLinked = false }) {
  /* ── A RETIRED PLAN'S TARGET IS SUPERSEDED, AND SAYS SO ──────────────
     When the plan stops owning its line — withdrawn, or replaced by a
     successor — a target it published can no longer be answered by anybody.
     It reads as superseded here rather than as still awaiting an answer
     that will never come; the stored record keeps what it was. */
  const planActive = editableState(plan);
  const shown = publications.map((p) => (!planActive && p.state === "AWAITING"
    ? { ...p, state: "SUPERSEDED", supersededByPlan: true, isAcceptedDeadline: false }
    : p));
  /* The target in force for each stage, and every version of it. */
  const currentByStage = new Map(shown.filter((p) => p.isCurrent).map((p) => [str(p.stageId), p]));
  const historyByStage = new Map();
  for (const p of shown) {
    const key = str(p.stageId);
    if (!historyByStage.has(key)) historyByStage.set(key, []);
    historyByStage.get(key).push(p);
  }
  /* A style route that is not proven to be this line's is not presented as
     this line's stages. A schedule already saved is PPC's own record and
     stays readable whatever the proof says now. */
  const proven = proof?.state === applicability.STATE.PROVEN;
  const routeStages = proven ? (route.stages || []) : [];
  /* Always from the ROUTE's own stage, never from the saved schedule: the
     schedule is PPC's record of dates, and the standard is IE's record of
     work. Reading it off the schedule would let a stage keep a figure the
     frozen release no longer publishes. */
  const basisByStage = cuttingBasis.cuttingBasisByStage({
    stages: route.stages || [],
    release: { releaseId: route.releaseId, releaseRef: route.releaseRef, versionNo: route.versionNo },
    quantity: plan.sourceBasis?.confirmedQuantity,
  });
  const required = schedule
    ? schedule.stages
    : routeStages.filter((s) => s.applicability === "REQUIRED")
      .map((s) => ({ ...s, plannedStart: null, plannedEnd: null, setInVersion: null }));
  const notApplicable = (schedule ? (route.stages || []) : routeStages)
    .filter((s) => s.applicability === "NOT_APPLICABLE")
    .map((s) => ({ stageId: s.stageId, process: s.process, label: s.label }));
  return {
    planningFile: {
      planningFileId: String(plan._id), planningFileRef: str(plan.planningFileRef),
      orderLineRef: str(plan.orderLineRef), state: str(plan.state),
      generation: plan.generation ?? null, ownsLine: editableState(plan),
    },
    route: {
      state: route.state,
      releaseRef: route.releaseRef || str(plan.sourceBasis?.ieReleaseRef) || null,
      versionNo: route.versionNo ?? plan.sourceBasis?.ieReleaseVersionNo ?? null,
      releaseState: route.releaseState || null,
    },
    stages: [...required].sort((a, b) => a.sequence - b.sequence).map((s) => ({
      stageId: s.stageId, process: s.process, label: s.label, sequence: s.sequence,
      predecessorStageIds: [...(s.predecessorStageIds || [])],
      plannedStart: s.plannedStart || null, plannedEnd: s.plannedEnd || null,
      setInVersion: s.setInVersion ?? null,
      handoff: handoffFor(s.process, booking, {
        publication: currentByStage.get(str(s.stageId)) || null,
        workLinked,
      }),
      /* IE's approved statement of how much work this stage is, read from the
         release this plan froze, with PPC's own multiplication beside it.
         Null on every process that has no such contract yet. Read-only: it is
         reported here and written nowhere. */
      technicalBasis: basisByStage.get(str(s.stageId)) || null,
      /* The published target in force for this stage, and its earlier
         versions with whatever answer each of them got. */
      publication: currentByStage.get(str(s.stageId)) || null,
      publicationHistory: (historyByStage.get(str(s.stageId)) || []),
    })),
    notApplicable,
    applicability: proof ? applicabilityView(proof) : null,
    schedule: schedule ? {
      versionNo: schedule.versionNo, revision: schedule.revision,
      updatedAt: iso(schedule.updatedAt), updatedByName: str(schedule.updatedBy?.name),
    } : null,
    history: schedule ? [...schedule.history].sort((a, b) => b.versionNo - a.versionNo).map((h) => ({
      versionNo: h.versionNo, kind: h.kind, reason: str(h.reason), at: iso(h.at), actorName: str(h.actorName),
      changes: (h.changes || []).map((c) => ({
        stageId: c.stageId, process: c.process, label: c.label,
        fromStart: c.fromStart, fromEnd: c.fromEnd, toStart: c.toStart, toEnd: c.toEnd,
      })),
    })) : [],
    sewingBooking: booking,
    editable: editableState(plan) && proven,
    /* Said on every answer, so a reader never infers it from an absent field. */
    planningTargetsOnly: true,
    publishedToOtherApps: false,
    booksCapacity: false,
    releasesProduction: false,
  };
}

async function read(ctx, { planningFileId }) {
  assertContext(ctx);
  const plan = await loadPlan(ctx, planningFileId);
  const [route, schedule, booking] = await Promise.all([
    routeFor(ctx, plan),
    PpcStageSchedule.findOne({ companyId: oid(ctx.companyId), planningFileId: plan._id }).lean(),
    activeBooking(ctx, plan),
  ]);
  const proof = await applicability.prove(ctx, { plan, route, schedule });
  /* Published targets, and whether Cutting could be published to at all —
     read through the same modules that write them. */
  const publication = require("./stagePublication.service");
  const [publications, linkedWorkOrders] = await Promise.all([
    /* With each frozen reservation's PRESENT standing, so an acceptance given
       against a line PPC has since let go is not reported as a live deadline.
       One extra query per read, and only when a target names a booking. */
    publication.publicationsFor(ctx, plan._id)
      .then((rows) => publication.withAllCapacityStandings(ctx.companyId, rows.map(publication.publicationView))),
    (route.stages || []).some((s) => publication.PUBLISHABLE_PROCESSES.includes(s.process))
      ? publication.eligibleWorkOrders(ctx.companyId, plan.orderLineRef).catch(() => [])
      : Promise.resolve([]),
  ]);
  return project({ plan, route, schedule, booking, proof, publications, workLinked: linkedWorkOrders.length > 0 });
}

/* ══ SAVING — A NEW VERSION, NEVER AN OVERWRITE ══════════════════════════ */

function refuseUnknown(body, allowed) {
  const extra = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw fail("PPC_PLANNING_FIELD_UNKNOWN", "Those fields are not part of a stage schedule.", { fields: extra });
  }
}

/**
 * Validate one save against the route's required stages and the dates as
 * they will stand. Returns the merged stage list and the changes.
 */
function applyDates(stages, submitted) {
  const byId = new Map(stages.map((s) => [s.stageId, { ...s }]));
  const seen = new Set();
  for (const s of submitted) {
    const id = str(s?.stageId);
    if (!byId.has(id)) {
      throw fail("PPC_STAGE_NOT_IN_ROUTE", "That stage is not a required stage of this plan's IE route.", { stageId: id });
    }
    if (seen.has(id)) throw fail("PPC_STAGE_DATES_INVALID", "A stage appears twice in one save.", { stageId: id });
    seen.add(id);
    const start = s.plannedStart === null ? null : str(s.plannedStart);
    const end = s.plannedEnd === null ? null : str(s.plannedEnd);
    if (!start || !end || !isBusinessDate(start) || !isBusinessDate(end)) {
      throw fail("PPC_STAGE_DATES_INVALID", "Each stage needs a planned start and finish as calendar dates.", { stageId: id });
    }
    if (end < start) throw fail("PPC_STAGE_DATES_INVALID", "A stage cannot finish before it starts.", { stageId: id });
    const cur = byId.get(id);
    byId.set(id, { ...cur, plannedStart: start, plannedEnd: end });
  }

  /* No stage may start before a predecessor's planned finish. */
  const conflicts = [];
  for (const s of byId.values()) {
    if (!s.plannedStart) continue;
    for (const p of s.predecessorStageIds || []) {
      const pred = byId.get(p);
      if (pred?.plannedEnd && s.plannedStart < pred.plannedEnd) {
        conflicts.push({ stageId: s.stageId, label: s.label, predecessorStageId: p, predecessorLabel: pred.label,
          startsOn: s.plannedStart, predecessorFinishes: pred.plannedEnd });
      }
    }
  }
  if (conflicts.length) {
    throw fail("PPC_STAGE_PREDECESSOR_CONFLICT",
      `${conflicts[0].label || "A stage"} would start before ${conflicts[0].predecessorLabel || "its predecessor"} finishes. Move them together in one save.`,
      { conflicts });
  }

  const changes = [];
  for (const before of stages) {
    const after = byId.get(before.stageId);
    if ((before.plannedStart || null) !== (after.plannedStart || null) || (before.plannedEnd || null) !== (after.plannedEnd || null)) {
      changes.push({
        stageId: before.stageId, process: before.process, label: before.label,
        fromStart: before.plannedStart || null, fromEnd: before.plannedEnd || null,
        toStart: after.plannedStart, toEnd: after.plannedEnd,
      });
    }
  }
  return { merged: stages.map((s) => byId.get(s.stageId)), changes };
}

/**
 * Save planned dates for some or all required stages.
 *
 * @param body `{ expectedRevision, stages: [{ stageId, plannedStart, plannedEnd }], reason? }`
 *             `expectedRevision` is 0 for a schedule not yet saved.
 */
async function save(ctx, { planningFileId, body = {}, actor, idempotencyKey }) {
  assertContext(ctx);
  refuseUnknown(body, ["expectedRevision", "stages", "reason"]);
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  const expected = Number(body.expectedRevision);
  if (!Number.isInteger(expected) || expected < 0) {
    throw fail("PPC_EXPECTED_REVISION_REQUIRED", "Send the schedule revision you read (0 for a new schedule).", { field: "expectedRevision" });
  }
  if (!Array.isArray(body.stages) || !body.stages.length) {
    throw fail("PPC_STAGE_DATES_INVALID", "Send at least one stage's planned dates.", { field: "stages" });
  }
  const reason = str(body.reason).replace(/\s+/g, " ");
  const target = await loadPlan(ctx, planningFileId);

  return planningCommand(ctx, {
    scope: `ppc:schedule:${String(target._id)}`,
    command: "stage-schedule-saved",
    idempotencyKey,
    request: { planningFileId: String(target._id), expectedRevision: expected, stages: body.stages, reason },
  }, async (session) => {
    const plan = await loadPlan(ctx, target._id, session);
    if (!editableState(plan)) {
      throw fail("PPC_STAGE_SCHEDULE_CLOSED",
        "This plan no longer owns its line, so its schedule is kept as a record and cannot change.", { state: plan.state });
    }
    const existing = await PpcStageSchedule.findOne({ companyId: oid(ctx.companyId), planningFileId: plan._id })
      .session(session).lean();
    const revision = existing ? existing.revision : 0;
    if (revision !== expected) {
      throw fail("PPC_STAGE_SCHEDULE_STALE", "This schedule changed since you read it. Re-read it and save again.",
        { expectedRevision: expected, currentRevision: revision });
    }

    const route = await routeFor(ctx, plan);
    if (route.state === "UNREADABLE") {
      throw fail("PPC_ROUTE_UNREADABLE", "The IE process route could not be read. Nothing was saved.");
    }
    if (route.state !== "DECLARED") {
      throw fail("PPC_ROUTE_STAGE_UNKNOWN",
        "IE's release for this plan declares no approved process route, so no stage can be scheduled.", { routeState: route.state });
    }
    /* Every save — a first plan or a replan — needs the route proved to be
       this exact line's. Nothing is saved on a blocker. */
    const proof = await applicability.prove(ctx, { plan, route, schedule: existing });
    if (proof.state === applicability.STATE.UNREADABLE) {
      throw fail("PPC_LINE_ROUTE_UNREADABLE", `${proof.message} Nothing was saved.`,
        { reason: proof.reason, ...(proof.details || {}) });
    }
    if (proof.state !== applicability.STATE.PROVEN) {
      throw fail("PPC_LINE_ROUTE_UNPROVEN", `${proof.message} Nothing was saved.`,
        { reason: proof.reason, kind: proof.kind, owner: proof.owner, ...(proof.details || {}) });
    }

    /* ── CUTTING CANNOT BE DATED WITHOUT ITS STANDARD ──────────────────
       A date is a commitment about work, and for cutting this release states
       how much work there is. Without a readable standard there is no
       workload to plan against, and a date typed anyway would be a number
       with nothing behind it. So the stages being dated in THIS request are
       checked, and the refusal names what IE must publish. Stages the caller
       is not touching are left alone — an existing schedule stays readable. */
    const basisNow = cuttingBasis.cuttingBasisByStage({
      stages: route.stages || [],
      release: { releaseId: route.releaseId, releaseRef: route.releaseRef, versionNo: route.versionNo },
      quantity: plan.sourceBasis?.confirmedQuantity,
    });
    /* ── CUTTING DATES ARE NOT TYPED ──────────────────────────────────
       A cutting window comes from a reservation on a Cutting-owned resource,
       written by `setStageDatesFromBooking` below. A planner sending one here
       is sending a guess at a roster they cannot see, and it is refused by
       name rather than silently overwritten by the next booking. */
    const routeById = new Map((route.stages || []).map((st) => [str(st.stageId), st]));
    for (const asked of body.stages || []) {
      const st = routeById.get(str(asked?.stageId));
      if (st && str(st.process) === "CUTTING") {
        throw fail("PPC_CUTTING_DATES_NOT_TYPED",
          "Cutting dates come from a capacity reservation, not from typing. Preview Cutting capacity and "
          + "reserve it; the schedule is written from the booking. Nothing was saved.",
          { stageId: str(asked.stageId), process: "CUTTING" });
      }
    }
    for (const asked of body.stages || []) {
      const basis = basisNow.get(str(asked?.stageId));
      if (cuttingBasis.blocksScheduling(basis)) {
        throw fail(basis.blocker, `${basis.message} Nothing was saved.`, {
          stageId: basis.stageId, process: basis.process,
          ieReleaseRef: basis.ieReleaseRef, ieReleaseVersionNo: basis.ieReleaseVersionNo,
          ...(basis.detail ? { detail: basis.detail } : {}),
        });
      }
    }

    let stages = existing?.stages;
    if (!existing) {
      stages = route.stages.filter((s) => s.applicability === "REQUIRED").map((s) => ({
        stageId: s.stageId, process: s.process, label: s.label, sequence: s.sequence,
        predecessorStageIds: [...(s.predecessorStageIds || [])],
        plannedStart: null, plannedEnd: null, setInVersion: null,
      }));
    }

    const { merged, changes } = applyDates(stages, body.stages);
    if (!changes.length) {
      throw fail("PPC_STAGE_SCHEDULE_UNCHANGED", "Those are already the planned dates. Nothing was saved.");
    }
    const replan = changes.some((c) => c.fromStart || c.fromEnd);
    if (replan) {
      const problem = resolutionProblem(reason);
      if (problem) {
        throw fail("PPC_STAGE_REPLAN_REASON_REQUIRED",
          `Moving a planned date is a replan: ${problem
            .replace(/^Say what changed before resuming planning\./, "say why the dates are moving.")
            .replace(/^Say what changed/, "say why")
            .replace(/^A resolution note/, "a reason")}`, { field: "reason" });
      }
    }
    if (reason.length > LIMITS.REASON) {
      throw fail("PPC_PLANNING_TEXT_TOO_LONG", `A reason is at most ${LIMITS.REASON} characters.`, { field: "reason" });
    }

    const versionNo = (existing?.versionNo || 0) + 1;
    const changedIds = new Set(changes.map((c) => c.stageId));
    const person = { id: oid(actor.id), name: str(actor.name), email: str(actor.email) };
    const entry = {
      versionNo, kind: replan ? "REPLANNED" : "PLANNED", reason, changes, at: new Date(),
      actorId: person.id, actorName: person.name,
    };
    const nextStages = merged.map((s) => ({ ...s, setInVersion: changedIds.has(s.stageId) ? versionNo : s.setInVersion }));

    if (!existing) {
      await PpcStageSchedule.create([{
        companyId: oid(ctx.companyId), orderLineRef: plan.orderLineRef,
        planningFileId: plan._id, planningFileRef: plan.planningFileRef, planningGeneration: plan.generation,
        ieReleaseId: oid(route.releaseId), ieReleaseRef: route.releaseRef, ieReleaseVersionNo: route.versionNo,
        stages: nextStages, versionNo, revision: 1, history: [entry],
        createdBy: person, updatedBy: person,
      }], { session });
    } else {
      const updated = await PpcStageSchedule.findOneAndUpdate(
        { _id: existing._id, companyId: oid(ctx.companyId), revision: expected },
        { $set: { stages: nextStages, versionNo, revision: expected + 1, updatedBy: person }, $push: { history: entry } },
        { new: true, session, runValidators: true },
      );
      if (!updated) {
        throw fail("PPC_STAGE_SCHEDULE_STALE", "This schedule changed since you read it. Re-read it and save again.");
      }
    }

    const schedule = await PpcStageSchedule.findOne({ companyId: oid(ctx.companyId), planningFileId: plan._id })
      .session(session).lean();
    const booking = await activeBooking(ctx, plan);
    /* `planningFile.planningFileId` names the plan in PPC's command ledger.
       Saving dates publishes nothing: the targets are read as they stand. */
    const publication = require("./stagePublication.service");
    const publications = await publication.withAllCapacityStandings(
      ctx.companyId, (await publication.publicationsFor(ctx, plan._id)).map(publication.publicationView));
    const linkedWorkOrders = (route.stages || []).some((s) => publication.PUBLISHABLE_PROCESSES.includes(s.process))
      ? await publication.eligibleWorkOrders(ctx.companyId, plan.orderLineRef).catch(() => [])
      : [];
    return project({ plan, route, schedule, booking, proof, publications, workLinked: linkedWorkOrders.length > 0 });
  });
}

/**
 * WRITE ONE STAGE'S DATES FROM A CAPACITY RESERVATION.
 *
 * The only way a cutting stage gets dates. Called from inside the booking
 * command's own transaction, with the plan it already loaded, so the
 * reservation and the schedule version it produces either both exist or
 * neither does.
 *
 * It mints a new schedule version exactly as a planner's save would — the
 * history reads the same, and its reason says the dates came from a booking.
 */
async function setStageDatesFromBooking(ctx, {
  plan, stageId, plannedStart, plannedEnd, reason, actor, session,
}) {
  const route = await routeFor(ctx, plan);
  const existing = await PpcStageSchedule.findOne({
    companyId: oid(ctx.companyId), planningFileId: plan._id,
  }).session(session).lean();

  let stages = existing?.stages ? existing.stages.map((s) => ({ ...s })) : null;
  if (!stages) {
    stages = (route.stages || []).filter((s) => s.applicability === "REQUIRED").map((s) => ({
      stageId: s.stageId, process: s.process, label: s.label, sequence: s.sequence,
      predecessorStageIds: [...(s.predecessorStageIds || [])],
      plannedStart: null, plannedEnd: null, setInVersion: null,
    }));
  }
  const row = stages.find((s) => str(s.stageId) === str(stageId));
  if (!row) {
    throw fail("PPC_ROUTE_STAGE_UNKNOWN", "That stage is not on this plan's approved route.", { stageId });
  }

  const versionNo = (existing?.versionNo || 0) + 1;
  const change = {
    stageId: str(stageId), process: str(row.process), label: str(row.label),
    fromStart: row.plannedStart || null, fromEnd: row.plannedEnd || null,
    toStart: plannedStart, toEnd: plannedEnd,
  };
  row.plannedStart = plannedStart;
  row.plannedEnd = plannedEnd;
  row.setInVersion = versionNo;

  const person = { id: oid(actor.id), name: str(actor.name), email: str(actor.email) };
  const entry = {
    versionNo,
    kind: change.fromStart ? "REPLANNED" : "PLANNED",
    /* Named so the history says where the dates came from — a reader three
       months later sees a reservation, not somebody's typing. */
    reason: str(reason).slice(0, LIMITS.REASON),
    changes: [change], at: new Date(), actorId: person.id, actorName: person.name,
  };

  if (!existing) {
    await PpcStageSchedule.create([{
      companyId: oid(ctx.companyId), orderLineRef: plan.orderLineRef,
      planningFileId: plan._id, planningFileRef: plan.planningFileRef, planningGeneration: plan.generation,
      ieReleaseId: oid(route.releaseId), ieReleaseRef: route.releaseRef, ieReleaseVersionNo: route.versionNo,
      stages, versionNo, revision: 1, history: [entry],
      createdBy: person, updatedBy: person,
    }], { session });
  } else {
    const updated = await PpcStageSchedule.findOneAndUpdate(
      { _id: existing._id, companyId: oid(ctx.companyId), revision: existing.revision },
      { $set: { stages, versionNo, revision: existing.revision + 1, updatedBy: person }, $push: { history: entry } },
      { new: true, session, runValidators: true },
    );
    if (!updated) {
      throw fail("PPC_STAGE_SCHEDULE_STALE",
        "The stage schedule changed while this booking was being taken. Nothing was booked.");
    }
  }
  return { versionNo, stageId: str(stageId), plannedStart, plannedEnd };
}

module.exports = {
  read, save, handoffFor, NO_WORKORDER_LINK, NO_RECEIVER,
  /* Shared with the publication command, so the plan, the frozen route and
     the "may this plan still act?" rule have one implementation each. */
  assertContext, loadPlan, routeFor, planOwnsLine: editableState, refuseUnknownFields: refuseUnknown,
  /* The only writer of cutting dates — called from inside the booking
     command's transaction, never from a route. */
  setStageDatesFromBooking,
};
