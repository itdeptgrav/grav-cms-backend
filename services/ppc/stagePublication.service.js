// services/ppc/stagePublication.service.js
//
// PPC PUBLISHES ONE STAGE TARGET TO THE DEPARTMENT THAT WILL DO THE WORK.
//
// Saving stage dates is planning; publishing is telling somebody. They are
// deliberately two acts: a schedule save writes nothing anybody else can see,
// and this command is the only way a target reaches the floor. Nothing here
// books capacity, releases production, or records what anybody has done.
//
// ── THE THREE RECEIVERS, AND THE ONE THAT NEEDS A LINE HELD ─────────────────
// Cutting and Embroidery answer on their own departments' doors. Sewing is
// answered by the Production Manager, and is the only process whose target
// stands on a reservation: PPC books the sewing line in Capacity first, as a
// separate decision, and this command refuses to publish a sewing window that
// the plan's own ACTIVE booking does not match exactly. It reads that booking
// and freezes what it says; it never creates, moves or releases one.
//
// ── WHAT THE SERVER FREEZES, AND WHY IT DERIVES ALL OF IT ───────────────────
// A published target is read by another department and answered by it, so
// every word of it has to be the server's own: the company and the permanent
// Sales line, the planning file with its generation, the exact stage-schedule
// version the dates came from, the frozen IE release and IE's own stage id,
// Sales' confirmed quantity, the dates, and every WorkOrder the Sales-line ↔
// WorkOrder bridge proves belongs to that exact company and line. The caller
// says which stage, and which schedule version it believes it is publishing.
//
// ── WHAT IS REFUSED, AND NOTHING IS PUBLISHED ON ANY OF THEM ────────────────
//   · the route is not proved to be this line's (the applicability contract);
//   · the stage is absent, not required, undated, or moved since that version;
//   · the plan, the IE release, the readiness basis or the schedule has moved;
//   · no WorkOrder is provably this company's and this line's;
//   · a named WorkOrder is historical, another company's, another line's or
//     cancelled;
//   · that schedule version was already published with different content.
//
// ── VERSIONS ────────────────────────────────────────────────────────────────
// A retry with the same idempotency key returns the original publication. A
// replan publishes a NEW version carrying the old dates beside the new ones
// and the reason; the version it replaces becomes SUPERSEDED with whatever
// answer Cutting had given it, and stays readable.
"use strict";

const mongoose = require("mongoose");

const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcPlanningFile, ACTIVE_STATES } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const {
  PpcStagePublication, PUBLICATION_STATE, LIMITS,
} = require("../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking, BOOKING_STATE } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const capacity = require("./capacityPlanning.service");
const bridge = require("../production/salesLineWorkOrderLink.service");
const orderBook = require("./orderBook.service");
const applicability = require("./lineRouteApplicability.service");
const cuttingBasis = require("./cuttingTechnicalBasis.service");
const schedule = require("./stageSchedule.service");
const { planningCommand } = require("./planningCommand");
const { resolutionProblem } = require("./planningFile.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * The stages that have a department to receive them. Each publishes through
 * this same command and is answered on that department's own door; the rest
 * stay unconnected rather than being published to nobody.
 */
const PUBLISHABLE_PROCESSES = Object.freeze(["CUTTING", "EMBROIDERY", "SEWING", "PACKING"]);
/* Kept for callers that named the first one. */
const PUBLISHABLE_PROCESS = "CUTTING";
/* Sewing is answered by the Production Manager, who owns the sewing floor —
   there is no "Sewing department" to grant, and inventing one would be a
   second access mechanism for one process. */
const RECEIVER_NAME = Object.freeze({
  CUTTING: "Cutting", EMBROIDERY: "Embroidery", SEWING: "Production",
  PACKING: "Packaging & Dispatch",
});

/* Processes a buyer chooses per line. A target for one of these may only be
   published when Sales' own statement for THAT line requires it — the route
   alone is a style's answer, not this line's. */
const BUYER_CHOSEN = Object.freeze(["EMBROIDERY"]);

/* Processes whose dates mean nothing without a reserved line. Sewing occupies
   a factory line for a window, and PPC reserves that window in Capacity as a
   separate, earlier decision; publishing a sewing target is PPC asking
   Production to accept the window it has already reserved. So the booking is
   a PREREQUISITE proved here and frozen onto the target — never created,
   moved or released by it. */
const CAPACITY_BACKED = Object.freeze(["SEWING"]);

/* Processes whose dates were WRITTEN by a reservation on another
   department's resource. Cutting is the first: its window is not typed, so a
   target for it stands on the exact booking that produced the dates, and
   publishing without one would be asking Cutting to accept a window nothing
   is holding a table for. */
const CUTTING_BACKED = Object.freeze(["CUTTING"]);
/* Packing is deliberately NOT here. PPC books sewing lines because sewing
   occupies one for a window; packing is not capacity-planned in PPC at all
   today, and requiring a reservation that nothing creates would make the
   stage unpublishable rather than safe. When packing capacity becomes a PPC
   decision, adding it to the list above is the whole change. */

/** A WorkOrder is eligible when the bridge proves it is this line's, and it lives. */
const DEAD_STATUSES = Object.freeze(["cancelled"]);

/**
 * Every WorkOrder that may carry this target: the bridge's own answer for the
 * exact company and line, minus anything cancelled. Remakes are excluded —
 * a return line is its own Sales line, not this one.
 */
async function eligibleWorkOrders(companyId, orderLineRef) {
  const [answer] = await bridge.workOrdersForLines(companyId, [orderLineRef]);
  if (!answer || answer.state !== bridge.LINK_STATE.LINKED) return [];
  return (answer.workOrders || [])
    .filter((w) => str(w.lineRef) === str(orderLineRef))
    .filter((w) => !DEAD_STATUSES.includes(str(w.status)))
    .map((w) => ({
      workOrderId: oid(w.workOrderId), workOrderNumber: str(w.workOrderNumber),
      lineRef: str(w.lineRef), basis: str(w.basis), variantId: str(w.variantId),
      quantity: w.quantity ?? null,
    }));
}

/** What two publications must agree on to be "the same publication". */
const contentOf = (p) => JSON.stringify({
  scheduleVersionNo: p.scheduleVersionNo,
  plannedStart: p.plannedStart,
  plannedEnd: p.plannedEnd,
  confirmedQuantity: p.confirmedQuantity,
  ieReleaseId: str(p.ieReleaseId),
  ieReleaseVersionNo: p.ieReleaseVersionNo ?? null,
  workOrders: (p.workOrders || []).map((w) => str(w.workOrderId)).sort(),
  /* A replanned booking is a different reservation behind the same dates, so
     it is different content: republishing after one produces a SUCCESSOR
     target awaiting a fresh answer, never a silent replay of the old one. */
  capacityBookingId: p.capacityBooking ? str(p.capacityBooking.bookingId) : null,
  /* A replanned cutting reservation is a different window behind the same
     dates, so it is different content: republishing after one produces a
     SUCCESSOR target awaiting a fresh answer. */
  cuttingBookingId: p.cuttingBooking ? str(p.cuttingBooking.bookingId) : null,
});

/** One publication, as PPC and Cutting both read it. */
function publicationView(p) {
  if (!p) return null;
  return {
    publicationId: str(p._id),
    publicationVersionNo: p.publicationVersionNo,
    state: str(p.state),
    isCurrent: Boolean(p.isCurrent),
    companyId: str(p.companyId),
    orderLineRef: str(p.orderLineRef),
    planningFileId: str(p.planningFileId),
    planningFileRef: str(p.planningFileRef),
    planningGeneration: p.planningGeneration ?? null,
    scheduleVersionNo: p.scheduleVersionNo,
    ieRelease: { releaseId: str(p.ieReleaseId), releaseRef: str(p.ieReleaseRef), versionNo: p.ieReleaseVersionNo ?? null },
    stageId: str(p.stageId),
    process: str(p.process),
    stageLabel: str(p.stageLabel),
    confirmedQuantity: p.confirmedQuantity,
    plannedStart: p.plannedStart,
    plannedEnd: p.plannedEnd,
    workOrders: (p.workOrders || []).map((w) => ({
      workOrderId: str(w.workOrderId), workOrderNumber: str(w.workOrderNumber),
      lineRef: str(w.lineRef), basis: str(w.basis), quantity: w.quantity ?? null,
    })),
    /* The reservation this target was published against, for sewing. Read
       everywhere the target is read; written nowhere but the publish command. */
    capacityBooking: p.capacityBooking ? {
      bookingId: str(p.capacityBooking.bookingId),
      bookingRef: str(p.capacityBooking.bookingRef),
      generation: p.capacityBooking.generation ?? null,
      lineId: str(p.capacityBooking.lineId),
      lineRef: str(p.capacityBooking.lineRef),
      calendarVersionNo: p.capacityBooking.calendarVersionNo ?? null,
      windowStart: p.capacityBooking.windowStart,
      windowEnd: p.capacityBooking.windowEnd,
    } : null,
    /* The cutting reservation this target was published against, frozen.
       Null on a target published before reservations existed — which reads
       as LEGACY_CAPACITY_UNVERIFIED rather than as capacity-backed. */
    cuttingBooking: p.cuttingBooking ? {
      bookingId: str(p.cuttingBooking.bookingId),
      bookingRef: str(p.cuttingBooking.bookingRef),
      generation: p.cuttingBooking.generation ?? null,
      resourceId: str(p.cuttingBooking.resourceId),
      resourceRef: str(p.cuttingBooking.resourceRef),
      resourceName: str(p.cuttingBooking.resourceName),
      resourceType: str(p.cuttingBooking.resourceType),
      resourceVersionNo: p.cuttingBooking.resourceVersionNo ?? null,
      usableCrew: p.cuttingBooking.usableCrew ?? null,
      reservedMinutes: p.cuttingBooking.reservedMinutes ?? null,
      windowStart: p.cuttingBooking.windowStart,
      windowEnd: p.cuttingBooking.windowEnd,
      standardFingerprint: str(p.cuttingBooking.standardFingerprint),
    } : null,
    changes: (p.changes || []).map((c) => ({
      fromStart: c.fromStart || null, fromEnd: c.fromEnd || null, toStart: c.toStart, toEnd: c.toEnd,
    })),
    replanReason: str(p.replanReason),
    response: p.response?.state
      ? { state: str(p.response.state), at: iso(p.response.at), byName: str(p.response.by?.name), reason: str(p.response.reason) }
      : null,
    publishedAt: iso(p.publishedAt),
    publishedByName: str(p.publishedBy?.name),
    supersededByVersionId: p.supersededByVersionId ? str(p.supersededByVersionId) : null,
    /* Said on every answer, so no reader has to infer it from an absence. */
    isAcceptedDeadline: str(p.state) === PUBLICATION_STATE.ACCEPTED,
    booksCapacity: false,
    releasesProduction: false,
    recordsProgress: false,
  };
}

/* ══ WHERE A FROZEN RESERVATION STANDS NOW ════════════════════════════════
 *
 * A sewing target names the booking it was published against, frozen. PPC may
 * afterwards release that reservation or replace it by replanning — both are
 * PPC's own decisions, made in Capacity, and nothing reads a publication
 * before making them. So the booking a target names can stop being the one in
 * force while the target sits there saying it.
 *
 * This resolves what the frozen booking is DOING now, so that no reader — not
 * Production's panel, not PPC's own schedule — presents a window as backed by
 * a line nobody is holding. It is derived at read time and stored nowhere: the
 * publication keeps saying what it was published against, which is the point
 * of freezing it.
 */
const CAPACITY_STANDING = Object.freeze({
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  SUPERSEDED: "SUPERSEDED",
  /* The frozen booking cannot be found at all — a record removed outside the
     lifecycle, or a company mismatch. Neither is "released", and saying so
     would be a guess. */
  MISSING: "MISSING",
});

/** @returns a Map of bookingId → one of `CAPACITY_STANDING`. */
async function capacityStandingFor(companyId, views = []) {
  const ids = [...new Set(views.map((v) => str(v?.capacityBooking?.bookingId)).filter(isId))];
  const out = new Map(ids.map((id) => [id, CAPACITY_STANDING.MISSING]));
  if (!ids.length) return out;
  const rows = await PpcCapacityBooking.find({
    _id: { $in: ids.map(oid) }, companyId: oid(companyId),
  }).select({ _id: 1, state: 1 }).lean();
  for (const b of rows) out.set(str(b._id), str(b.state));
  return out;
}

/**
 * One publication view with its reservation's present standing attached, and
 * the one question every screen actually asks answered plainly.
 *
 * `isAcceptedDeadline` is corrected here and nowhere else: an acceptance given
 * while a line was held is still a real acceptance — it stays in `response`,
 * with who gave it and when — but it is no longer a CURRENT accepted deadline
 * once the line is not held. The two facts are different, and a reader that
 * had to infer the second from the first would get it wrong.
 */
function withCapacityStanding(view, standing) {
  if (!view?.capacityBooking) return view;
  const state = standing.get(str(view.capacityBooking.bookingId)) || CAPACITY_STANDING.MISSING;
  const held = state === CAPACITY_STANDING.ACTIVE;
  return {
    ...view,
    capacityBooking: { ...view.capacityBooking, standing: state },
    capacityHeld: held,
    isAcceptedDeadline: view.isAcceptedDeadline && held,
  };
}

/** The same, for a list, in one query. */
async function withCapacityStandings(companyId, views = []) {
  const standing = await capacityStandingFor(companyId, views);
  return views.map((v) => withCapacityStanding(v, standing));
}

/* ══ AND THE SAME QUESTION FOR A CUTTING RESERVATION ══════════════════════
 *
 * A cutting target's dates were written from a booking. That booking can
 * afterwards be released or superseded — PPC's own decisions — and when it
 * is, the acceptance Cutting gave remains true as HISTORY and stops being a
 * current accepted deadline. There is nothing to sew a table for.
 *
 * And a target published before reservations existed names no booking at
 * all. That is not "released" and not "missing": it is a record that could
 * never have carried the answer, and it says so in its own word.
 */
const CUTTING_CAPACITY = Object.freeze({
  HELD: "HELD",
  RELEASED: "RELEASED",
  SUPERSEDED: "SUPERSEDED",
  MISSING: "MISSING",
  /* Published before cutting reservations existed. */
  LEGACY_CAPACITY_UNVERIFIED: "LEGACY_CAPACITY_UNVERIFIED",
  /* This process reserves no cutting resource. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

/** @returns a Map of bookingId → `ACTIVE` | `RELEASED` | `SUPERSEDED` | `MISSING`. */
async function cuttingBookingStandingFor(companyId, views = []) {
  const ids = [...new Set(views.map((v) => str(v?.cuttingBooking?.bookingId)).filter(isId))];
  const out = new Map(ids.map((id) => [id, "MISSING"]));
  if (!ids.length) return out;
  const { CuttingCapacityBooking } = require("../../models/CMS_Models/PPC/CuttingCapacityBooking");
  const rows = await CuttingCapacityBooking.find({
    _id: { $in: ids.map(oid) }, companyId: oid(companyId),
  }).select({ _id: 1, state: 1 }).lean();
  for (const b of rows) out.set(str(b._id), str(b.state));
  return out;
}

/**
 * One publication with its cutting reservation's present standing, and the
 * accepted-deadline claim corrected.
 *
 * A LEGACY target keeps whatever `isAcceptedDeadline` it had: it was agreed
 * under the rules of its time, and retrospectively failing it would be this
 * system failing its own history. What it does NOT get is a claim to be
 * capacity-backed, which is why the word is its own.
 */
function withCuttingCapacityStanding(view, standing) {
  if (str(view?.process) !== "CUTTING") {
    return { ...view, cuttingCapacity: CUTTING_CAPACITY.NOT_APPLICABLE, cuttingCapacityHeld: null };
  }
  if (!view.cuttingBooking) {
    return {
      ...view,
      cuttingCapacity: CUTTING_CAPACITY.LEGACY_CAPACITY_UNVERIFIED,
      cuttingCapacityHeld: false,
      /* Deliberately unchanged — see above. */
      isAcceptedDeadline: view.isAcceptedDeadline,
    };
  }
  const state = standing.get(str(view.cuttingBooking.bookingId)) || "MISSING";
  const held = state === "ACTIVE";
  return {
    ...view,
    cuttingBooking: { ...view.cuttingBooking, standing: state },
    cuttingCapacity: held ? CUTTING_CAPACITY.HELD : CUTTING_CAPACITY[state] || CUTTING_CAPACITY.MISSING,
    cuttingCapacityHeld: held,
    /* An acceptance without a reservation behind it is history, not a
       current deadline. The response itself is untouched. */
    isAcceptedDeadline: view.isAcceptedDeadline && held,
  };
}

/** Both standings, for a list, in two queries. */
async function withAllCapacityStandings(companyId, views = []) {
  const sewing = await capacityStandingFor(companyId, views);
  const cutting = await cuttingBookingStandingFor(companyId, views);
  return views.map((v) => withCuttingCapacityStanding(withCapacityStanding(v, sewing), cutting));
}

/** Every publication of one planning file's stages, newest version first. */
async function publicationsFor(ctx, planningFileId) {
  if (!isId(planningFileId)) return [];
  return PpcStagePublication.find({ companyId: oid(ctx.companyId), planningFileId: oid(planningFileId) })
    .sort({ stageId: 1, publicationVersionNo: -1 }).lean();
}

/* ══ PUBLISHING ═══════════════════════════════════════════════════════════ */

const refuse = (code, message, details) => { throw fail(code, message, details); };

/**
 * Publish one stage's dates to its executing department.
 *
 * @param body `{ stageId, expectedScheduleVersion, reason?, workOrderIds? }`
 *   `expectedScheduleVersion` is the schedule version the caller read, so a
 *   schedule that moved underneath them refuses rather than publishing dates
 *   they never saw. `workOrderIds`, when sent, must name exactly eligible
 *   WorkOrders — it narrows nothing and proves the caller saw the same list.
 */
async function publish(ctx, { planningFileId, body = {}, actor, idempotencyKey }) {
  schedule.assertContext(ctx);
  schedule.refuseUnknownFields(body, ["stageId", "expectedScheduleVersion", "reason", "workOrderIds"]);
  if (!actor?.id) refuse("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");

  const stageId = str(body.stageId);
  if (!stageId) refuse("PPC_PLANNING_FIELD_UNKNOWN", "Say which stage is being published.", { field: "stageId" });
  const expected = Number(body.expectedScheduleVersion);
  if (!Number.isInteger(expected) || expected < 1) {
    refuse("PPC_EXPECTED_REVISION_REQUIRED",
      "Send the stage-schedule version you read.", { field: "expectedScheduleVersion" });
  }
  const reason = str(body.reason).replace(/\s+/g, " ");
  const target = await schedule.loadPlan(ctx, planningFileId);

  return planningCommand(ctx, {
    scope: `ppc:publish:${String(target._id)}:${stageId}`,
    command: "stage-target-published",
    idempotencyKey,
    request: { planningFileId: String(target._id), stageId, expectedScheduleVersion: expected, reason,
      workOrderIds: (body.workOrderIds || []).map(str).sort() },
  }, async (session) => {
    const plan = await schedule.loadPlan(ctx, target._id, session);
    if (!schedule.planOwnsLine(plan)) {
      refuse("PPC_STAGE_SCHEDULE_CLOSED",
        "This plan no longer owns its line, so nothing can be published from it.", { state: plan.state });
    }

    /* ── The route must still be proved to be this line's ─────────────── */
    const route = await schedule.routeFor(ctx, plan);
    const saved = await PpcStageSchedule.findOne({ companyId: oid(ctx.companyId), planningFileId: plan._id })
      .session(session).lean();
    const proof = await applicability.prove(ctx, { plan, route, schedule: saved });
    if (proof.state === applicability.STATE.UNREADABLE) {
      refuse("PPC_LINE_ROUTE_UNREADABLE", `${proof.message} Nothing was published.`, { reason: proof.reason });
    }
    if (proof.state !== applicability.STATE.PROVEN) {
      refuse("PPC_LINE_ROUTE_UNPROVEN", `${proof.message} Nothing was published.`,
        { reason: proof.reason, kind: proof.kind, owner: proof.owner });
    }

    /* ── The schedule the caller read, and the stage in it ────────────── */
    if (!saved) {
      refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
        "This plan has no stage schedule yet, so there are no dates to publish.", { reason: "NOT_SCHEDULED" });
    }
    if (saved.versionNo !== expected) {
      refuse("PPC_PUBLISH_SCHEDULE_STALE",
        "This stage schedule changed since you read it. Re-read it and publish again.",
        { expectedScheduleVersion: expected, currentScheduleVersion: saved.versionNo });
    }
    const stage = (saved.stages || []).find((s) => str(s.stageId) === stageId);
    if (!stage) {
      refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
        "That stage is not in this plan's schedule.", { reason: "NOT_IN_SCHEDULE", stageId });
    }
    const process = str(stage.process);
    if (!PUBLISHABLE_PROCESSES.includes(process)) {
      refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
        `${process.charAt(0)}${process.slice(1).toLowerCase()} has no receiving department yet — `
        + `only ${PUBLISHABLE_PROCESSES.map((p) => p.toLowerCase()).join(", ")} can be published.`,
        { reason: "NO_RECEIVER", process });
    }
    if (!stage.plannedStart || !stage.plannedEnd) {
      refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
        "This stage has no planned dates yet. Plan it before publishing it.", { reason: "UNDATED", stageId });
    }
    /* Still REQUIRED on the route this plan froze — a stage IE has since
       marked not applicable is not a target anybody should receive. */
    const onRoute = (route.stages || []).find((s) => str(s.stageId) === stageId);
    if (!onRoute || onRoute.applicability !== "REQUIRED") {
      refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
        "The approved IE route does not require this stage for this line.", { reason: "NOT_REQUIRED", stageId });
    }
    /* And for a process the BUYER chooses, Sales' approved statement for this
       exact line must require it.
       Unreachable while the applicability proof holds — a line whose
       statement and route disagree cannot even be DATED, let alone published,
       which its own suite proves. It is kept because it is the sentence this
       command must not lose: if the proof ever loosened, a style's route
       alone must still never publish embroidery the buyer did not ask for. */
    if (BUYER_CHOSEN.includes(process)) {
      const stated = (proof.processes || []).find((p) => p.process === process);
      if (!stated || stated.line !== "REQUIRED" || stated.verdict !== "MATCH") {
        refuse("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE",
          `Sales' approved handover does not require ${process.toLowerCase()} for this exact line, `
          + "so no target can be published for it.",
          { reason: "NOT_REQUIRED_FOR_LINE", process, line: stated?.line || "NOT_STATED" });
      }
    }

    /* ── AND CUTTING'S WORK MUST BE STATED BEFORE IT IS ASKED FOR ─────
       Publishing a cutting target asks a department to accept dates for work
       this release does not say the size of. The same standard the schedule
       needed to set the dates is required to send them. */
    const basis = cuttingBasis.cuttingBasis({
      stage: onRoute,
      release: { releaseId: route.releaseId, releaseRef: route.releaseRef, versionNo: route.versionNo },
      quantity: plan.sourceBasis?.confirmedQuantity,
    });
    if (cuttingBasis.blocksScheduling(basis)) {
      refuse(basis.blocker, `${basis.message} Nothing was published.`, {
        stageId: basis.stageId, process: basis.process,
        ieReleaseRef: basis.ieReleaseRef, ieReleaseVersionNo: basis.ieReleaseVersionNo,
        ...(basis.detail ? { detail: basis.detail } : {}),
      });
    }

    /* ── Nothing underneath it may have moved ────────────────────────── */
    const health = await orderBook.sourceHealth(ctx, plan);
    if (health?.moved) {
      refuse("PPC_PUBLISH_SOURCE_MOVED",
        "A source this plan was frozen against has moved. Reconcile the plan before publishing a target from it.",
        { movements: (health.movements || []).map((m) => ({ key: m.key, label: m.label, kind: m.kind })) });
    }

    /* ── The work it will be done against ────────────────────────────── */
    const eligible = await eligibleWorkOrders(ctx.companyId, plan.orderLineRef);
    if (!eligible.length) {
      refuse("PPC_PUBLISH_NO_WORKORDER",
        "No work order is provably this company's and this Sales line's, so there is nothing to publish a target to. "
        + "A historical work order with no Sales-line link is not one, and is never matched by style, number or customer.",
        { orderLineRef: str(plan.orderLineRef) });
    }
    const asked = (body.workOrderIds || []).map(str).filter(Boolean);
    if (asked.length) {
      const eligibleIds = new Set(eligible.map((w) => str(w.workOrderId)));
      const rejected = asked.filter((id) => !eligibleIds.has(id));
      if (rejected.length) {
        refuse("PPC_PUBLISH_WORKORDER_INELIGIBLE",
          "A work order named here is not one this target may cover: it is another company's, another line's, "
          + "cancelled, or has no proven Sales-line link.", { count: rejected.length });
      }
    }

    /* ── THE RESERVATION A SEWING WINDOW STANDS ON ────────────────────
       PPC books a sewing line in Capacity first. Publishing does not book
       one, and refuses rather than asking Production to accept a window no
       line is held for. Every fact below is compared against the booking
       PPC itself made: any difference is a decision PPC has to take again,
       in Capacity or in the schedule, and is never reconciled here. */
    let bookedAgainst = null;
    if (CAPACITY_BACKED.includes(process)) {
      const booking = await PpcCapacityBooking.findOne({
        companyId: oid(ctx.companyId), planningFileId: plan._id, state: BOOKING_STATE.ACTIVE,
      }).lean();
      if (!booking) {
        refuse("PPC_PUBLISH_NO_CAPACITY_BOOKING",
          "No active capacity booking backs this plan's sewing window. Book the line in Capacity, "
          + "then publish the target for the window you booked.",
          { planningFileId: str(plan._id), process });
      }
      /* Each named on its own, so PPC is told which fact to settle. */
      const differs = [
        ["orderLineRef", str(booking.orderLineRef), str(plan.orderLineRef)],
        ["ieReleaseId", str(booking.basis?.ieReleaseId), str(route.releaseId)],
        ["ieReleaseVersionNo", booking.basis?.ieReleaseVersionNo ?? null, route.versionNo ?? null],
        ["confirmedQuantity", Number(booking.basis?.confirmedQuantity ?? NaN),
          Number(plan.sourceBasis?.confirmedQuantity ?? 0)],
        ["windowStart", str(booking.windowStart), str(stage.plannedStart)],
        ["windowEnd", str(booking.windowEnd), str(stage.plannedEnd)],
      ].find(([, booked, planned]) => booked !== planned);
      if (differs) {
        const [fact, booked, planned] = differs;
        refuse("PPC_PUBLISH_BOOKING_MISMATCH",
          `The active capacity booking does not match this sewing stage: ${fact} is ${booked} on booking `
          + `${booking.bookingRef} and ${planned} in the plan. Replan the booking or the schedule so they agree, `
          + "then publish.",
          { fact, booked, planned, bookingRef: str(booking.bookingRef) });
      }
      /* And nothing may have moved under the booking itself — a republished
         calendar, a changed line, a moved release. Reported, not absorbed. */
      const bookingState = await capacity.bookingHealth(ctx, booking);
      if (bookingState.undetermined || bookingState.moved) {
        refuse("PPC_PUBLISH_BOOKING_UNHEALTHY",
          bookingState.undetermined
            ? "The capacity booking behind this sewing window could not be verified, so nothing was published."
            : "Something has moved under the capacity booking behind this sewing window. Settle the booking "
              + "in Capacity before publishing a target against it.",
          { bookingRef: str(booking.bookingRef),
            movements: (bookingState.movements || []).map((m) => ({ key: m.key, message: m.message })) });
      }
      bookedAgainst = {
        bookingId: booking._id,
        bookingRef: str(booking.bookingRef),
        generation: booking.generation,
        lineId: booking.lineId,
        lineRef: str(booking.lineRef),
        calendarVersionNo: booking.calendarVersionNo,
        windowStart: booking.windowStart,
        windowEnd: booking.windowEnd,
      };
    }

    /* ── A CUTTING TARGET STANDS ON ITS OWN RESERVATION ───────────────
       The dates being published were written from a booking. The same
       booking must still be the one in force, and must still describe this
       exact window — otherwise the target would ask Cutting to accept dates
       whose capacity has since been given up or moved. */
    let cuttingBookedAgainst = null;
    if (CUTTING_BACKED.includes(process)) {
      const bookingService = require("./cuttingCapacityBooking.service");
      const active = await bookingService.activeBooking(ctx, {
        planningFileId: plan._id, stageId, session,
      });
      if (!active) {
        refuse("PPC_PUBLISH_NO_CUTTING_BOOKING",
          "No active cutting capacity reservation backs this stage's dates. Reserve capacity on a "
          + "Cutting resource first — the schedule is written from the booking, and the target stands on it.",
          { planningFileId: str(plan._id), stageId, process });
      }
      const differs = [
        ["windowStart", str(active.windowStart), str(stage.plannedStart)],
        ["windowEnd", str(active.windowEnd), str(stage.plannedEnd)],
        ["confirmedQuantity", Number(active.confirmedQuantity),
          Number(plan.sourceBasis?.confirmedQuantity ?? 0)],
        ["ieReleaseId", str(active.ieRelease.releaseId), str(route.releaseId)],
        ["ieReleaseVersionNo", active.ieRelease.versionNo ?? null, route.versionNo ?? null],
      ].find(([, booked, planned]) => booked !== planned);
      if (differs) {
        const [fact, booked, planned] = differs;
        refuse("PPC_PUBLISH_CUTTING_BOOKING_MISMATCH",
          `The active cutting reservation does not match this stage: ${fact} is ${booked} on booking `
          + `${active.bookingRef} and ${planned} in the plan. Replan the reservation, then publish.`,
          { fact, booked, planned, bookingRef: active.bookingRef });
      }
      cuttingBookedAgainst = {
        bookingId: oid(active.bookingId),
        bookingRef: active.bookingRef,
        generation: active.generation,
        resourceId: oid(active.resource.resourceId),
        resourceRef: active.resource.resourceRef,
        resourceName: active.resource.name,
        resourceType: active.resource.resourceType,
        resourceVersionNo: active.resource.versionNo,
        usableCrew: active.usableCrew,
        reservedMinutes: active.reservedMinutes,
        windowStart: active.windowStart,
        windowEnd: active.windowEnd,
        standardFingerprint: active.standardFingerprint,
      };
    }

    /* ── ONE LIVE TARGET PER SALES LINE ───────────────────────────────
       A successor plan publishes its own target, and the plan it replaced
       may still have one in force. Two live targets for one line would leave
       Cutting looking at two answers to give, so the retired plan's target
       steps down here — it keeps whatever answer it already had, and becomes
       the superseded version of this one. A target belonging to a plan that
       is somehow STILL active is not stepped over: that would be publishing
       past a live plan, and it refuses instead. */
    const onLine = await PpcStagePublication.find({
      companyId: oid(ctx.companyId), orderLineRef: str(plan.orderLineRef),
      process, isCurrent: true, planningFileId: { $ne: plan._id },
    }).session(session);
    if (onLine.length) {
      const owners = await PpcPlanningFile.find({
        _id: { $in: onLine.map((p) => p.planningFileId) }, companyId: oid(ctx.companyId),
      }).select({ _id: 1, state: 1 }).session(session).lean();
      const stillActive = owners.filter((o) => ACTIVE_STATES.includes(str(o.state))).map((o) => str(o._id));
      if (stillActive.length) {
        refuse("PPC_PUBLISH_LINE_ALREADY_TARGETED",
          `Another planning file of this line still owns a published ${process.toLowerCase()} target. `
          + "Withdraw or supersede that plan before publishing from this one.",
          { planningFileIds: stillActive });
      }
    }

    /* ── The version this one follows ────────────────────────────────── */
    const current = await PpcStagePublication.findOne({
      companyId: oid(ctx.companyId), planningFileId: plan._id, stageId, isCurrent: true,
    }).session(session);
    const [highest] = await PpcStagePublication.find({
      companyId: oid(ctx.companyId), planningFileId: plan._id, stageId,
    }).sort({ publicationVersionNo: -1 }).limit(1).session(session).lean();

    const next = {
      companyId: oid(ctx.companyId),
      orderLineRef: str(plan.orderLineRef),
      planningFileId: plan._id,
      planningFileRef: str(plan.planningFileRef),
      planningGeneration: plan.generation ?? null,
      scheduleVersionNo: saved.versionNo,
      ieReleaseId: oid(route.releaseId),
      ieReleaseRef: str(route.releaseRef),
      ieReleaseVersionNo: route.versionNo ?? null,
      stageId,
      process,
      stageLabel: str(stage.label),
      confirmedQuantity: Number(plan.sourceBasis?.confirmedQuantity ?? 0),
      plannedStart: stage.plannedStart,
      plannedEnd: stage.plannedEnd,
      workOrders: eligible,
      capacityBooking: bookedAgainst,
      cuttingBooking: cuttingBookedAgainst,
    };

    if (current) {
      const same = contentOf(current) === contentOf(next);
      if (same) {
        /* Publishing the same statement again is not a second target. */
        return { publication: publicationView(current.toObject()), republished: false };
      }
      if (current.scheduleVersionNo === saved.versionNo) {
        refuse("PPC_PUBLISH_CONTENT_CONFLICT",
          `Schedule version ${saved.versionNo} was already published for this stage, with different content. `
          + "Save the change as a new schedule version, then publish that.",
          { publishedVersionNo: current.publicationVersionNo, scheduleVersionNo: current.scheduleVersionNo });
      }
      const datesMoved = current.plannedStart !== next.plannedStart || current.plannedEnd !== next.plannedEnd;
      if (datesMoved) {
        const problem = resolutionProblem(reason);
        if (problem) {
          refuse("PPC_PUBLISH_REPLAN_REASON_REQUIRED",
            `Publishing moved dates to ${RECEIVER_NAME[process]} is a replan: ${problem
              .replace(/^Say what changed before resuming planning\./, "say why they are moving.")
              .replace(/^Say what changed/, "say why")
              .replace(/^A resolution note/, "a reason")}`, { field: "reason" });
        }
      }
      next.changes = [{
        fromStart: current.plannedStart, fromEnd: current.plannedEnd,
        toStart: next.plannedStart, toEnd: next.plannedEnd,
      }];
      next.replanReason = datesMoved ? reason.slice(0, LIMITS.REASON) : "";
      next.supersedesVersionId = current._id;
    }

    next.publicationVersionNo = (highest?.publicationVersionNo || 0) + 1;
    next.state = PUBLICATION_STATE.AWAITING;
    next.isCurrent = true;
    next.publishedBy = { id: oid(actor.id), name: str(actor.name) };
    next.publishedAt = new Date();

    /* Step the old one down FIRST: one target per stage is in force, and the
       partial unique index is checked as each write lands. Cutting's answer to
       it stays exactly where it was. */
    if (current) {
      current.state = PUBLICATION_STATE.SUPERSEDED;
      current.isCurrent = false;
      await current.save({ session });
    }
    /* The retired plan's targets step down with it. */
    for (const stale of onLine) {
      stale.state = PUBLICATION_STATE.SUPERSEDED;
      stale.isCurrent = false;
      await stale.save({ session });
    }
    const [created] = await PpcStagePublication.create([next], { session });
    if (current) {
      current.supersededByVersionId = created._id;
      await current.save({ session });
    }
    for (const stale of onLine) {
      stale.supersededByVersionId = created._id;
      await stale.save({ session });
    }
    return { publication: publicationView(created.toObject()), republished: Boolean(current) };
  });
}

module.exports = {
  publish, publicationsFor, publicationView, eligibleWorkOrders,
  PUBLISHABLE_PROCESS, PUBLISHABLE_PROCESSES, RECEIVER_NAME, BUYER_CHOSEN, PUBLICATION_STATE,
  CAPACITY_BACKED, CUTTING_BACKED,
  /* One implementation of "is the line still held", shared by PPC's own
     schedule and by Production's door, so the two can never disagree. */
  CAPACITY_STANDING, capacityStandingFor, withCapacityStanding, withCapacityStandings,
  CUTTING_CAPACITY, cuttingBookingStandingFor, withCuttingCapacityStanding, withAllCapacityStandings,
};
