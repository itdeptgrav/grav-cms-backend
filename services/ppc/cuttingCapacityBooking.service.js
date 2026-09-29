// services/ppc/cuttingCapacityBooking.service.js
//
// PPC RESERVES CUTTING CAPACITY — EXPLICITLY, ONCE, AND FROM A PREVIEW.
//
// Booking is a separate act from previewing, and a separate act again from
// publishing a target. A planner reads a preview, decides, and issues this
// command naming the plan, the resource and the proof they read. Everything
// else is recomputed here from the records themselves.
//
// ── WHAT THE CLIENT MAY SEND, AND WHY IT IS SO LITTLE ───────────────────────
// A planning file id, a resource id, a proof string and an idempotency key.
// No dates, no crew, no workload, no quantity, no efficiency, no IE figure.
// Every one of those is derived here from Industrial Engineering's approved
// release and Cutting's published roster — because a number a client supplies
// is a number nobody approved, and a booking built on one would reserve real
// capacity against a fiction.
//
// The proof is not data either. It is a hash the preview produced over
// everything that must not move; this command recomputes it from scratch and
// compares. A client cannot make a stale window current by echoing it back,
// because echoing it back is all it can do.
//
// ── AND WHY CAPACITY IS THE DATABASE'S JOB ──────────────────────────────────
// Two planners looking at the same free hour both see it. A read-then-create
// would let both take it. So the reservation is a conditional `$inc` on a
// per-resource-per-day counter that matches only while the result still fits,
// with a unique index behind it: exactly one update matches, and the loser's
// whole transaction rolls back. The test that proves it races two bookings for
// the last minutes and asserts the sum never exceeds the day.
//
// ── WHAT A BOOKING IS NOT ───────────────────────────────────────────────────
// Not Cutting's acceptance — that is Cutting's own answer on its own door, and
// a refusal releases nothing here. Not a deadline. Not actual output. Not a
// Production release. Nothing in this file writes any of them.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  CuttingCapacityBooking, CuttingResourceDay, BOOKING_STATE, RELEASE_REASON, LIMITS,
} = require("../../models/CMS_Models/PPC/CuttingCapacityBooking");
const { PpcPlanningFile, ACTIVE_STATES } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const cuttingResources = require("../production/cuttingResource.service");
const preview = require("./cuttingCapacityPreview.service");
const { planningCommand } = require("./planningCommand");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const BODY_FIELDS = Object.freeze(["planningFileId", "resourceRef", "proof"]);

/* Everything a planner might try to send as authoritative, refused by name
   with where it actually comes from. None of these is a field this command
   has; naming them is how somebody finds out why, rather than wondering. */
const REFUSED = Object.freeze({
  windowStart: "a start date, which the booking calculates from the resource's own calendar",
  windowEnd: "a finish date, which the booking calculates",
  plannedStart: "a date, which the booking calculates",
  plannedEnd: "a date, which the booking calculates",
  allocations: "daily minutes, which the server computes and the ledger enforces",
  reservedMinutes: "a reservation, which the server computes",
  workloadMinutes: "a workload, which comes from IE's standard and Sales' quantity",
  quantity: "a quantity, which the confirmed order line carries",
  confirmedQuantity: "a quantity, which the confirmed order line carries",
  standardMinutesPerPiece: "an engineering standard, which Industrial Engineering owns",
  setupMinutesPerOrder: "an engineering standard, which Industrial Engineering owns",
  capacityModel: "an engineering standard's crew assumptions, which Industrial Engineering owns",
  crew: "a crew, which Cutting publishes on the resource",
  usableCrew: "a usable crew, which the approved scaling rule decides",
  headcount: "a headcount, which Cutting publishes on the resource",
  operationalEfficiencyPercent: "an efficiency, which Cutting publishes on the resource",
  efficiencyPercent: "an efficiency, which Cutting publishes on the resource",
  ieReleaseId: "an IE release, which the planning file froze",
  ieReleaseVersionNo: "an IE release version, which the planning file froze",
  stageId: "a stage, which the approved route names — there is one cutting stage",
  companyId: "the company — that comes from your own membership",
});

const bookingRefFor = (companyId, planningFileId, generation) => `CUTBK-${crypto.createHash("sha256")
  .update(`${companyId}:${planningFileId}:${generation}`).digest("hex").slice(0, 10).toUpperCase()}`;

const person = (actor) => ({
  id: isId(actor?.id) ? oid(actor.id) : undefined,
  name: str(actor?.name || actor?.email),
});

function refuseUnknown(body) {
  for (const field of Object.keys(body || {})) {
    const refused = REFUSED[field];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A cutting booking cannot carry ${refused}.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${field}" is not accepted.` }] });
    }
    if (!BODY_FIELDS.includes(field)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a cutting booking request.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${field}" is not accepted.` }] });
    }
  }
}

/* ══ WHAT IS RESERVED NOW ═════════════════════════════════════════════════ */

/**
 * Minutes already reserved on each of this company's cutting resources, by
 * day — everybody's ACTIVE bookings, including this plan's own predecessor
 * when it has one.
 *
 * Read for the preview so a planner is never shown a day somebody else holds,
 * and read again inside the booking transaction so the decision is taken on
 * what is free at that instant rather than what was free when the screen
 * loaded.
 */
async function reservedByResource(companyId, { excludeBookingId = null, session = null } = {}) {
  const q = { companyId: oid(companyId), state: BOOKING_STATE.ACTIVE };
  if (excludeBookingId && isId(excludeBookingId)) q._id = { $ne: oid(excludeBookingId) };
  const rows = await CuttingCapacityBooking.find(q)
    .select({ resourceRef: 1, allocations: 1 }).session(session).lean();
  const out = new Map();
  for (const b of rows) {
    const key = str(b.resourceRef);
    if (!out.has(key)) out.set(key, new Map());
    const byDate = out.get(key);
    for (const a of b.allocations || []) {
      byDate.set(a.date, (byDate.get(a.date) || 0) + a.reservedMinutes);
    }
  }
  return out;
}

/* ══ RECOMPUTE, FROM THE RECORDS THEMSELVES ═══════════════════════════════ */

const stale = (moved, detail) => fail("PPC_CUTTING_BOOKING_STALE",
  `${moved} since this preview was taken. Nothing was booked — preview again.`, detail || {});

/**
 * The plan, the release, the standard, the resource and the free minutes, as
 * they are RIGHT NOW — and the option this booking would take.
 *
 * Nothing the caller sent contributes a value here; the caller only says which
 * plan and which resource.
 */
async function recompute(ctx, { planningFileId, resourceRef, from = null, excludeBookingId = null, session = null }) {
  const schedule = require("./stageSchedule.service");
  const plan = await schedule.loadPlan(ctx, planningFileId, session);
  if (!ACTIVE_STATES.includes(str(plan.state))) {
    throw fail("PPC_CUTTING_BOOKING_PLAN_CLOSED",
      `This plan is ${plan.state}, so no capacity can be reserved for it.`, { state: plan.state });
  }

  const route = await schedule.routeFor(ctx, plan);
  const stage = (route.stages || []).find((s) => str(s.process) === "CUTTING");
  if (!stage) {
    throw fail("PPC_CUTTING_BOOKING_NO_STAGE",
      "This plan's approved route has no cutting stage, so there is nothing to reserve capacity for.");
  }

  /* The resource, by id, from Cutting's PUBLISHED projection only. A draft,
     a superseded version and a retired one are each absent from it. */
  const published = await cuttingResources.publishResourcesForPlanning(String(ctx.companyId));
  /* BY REFERENCE, NOT BY ID. Cutting publishes each version as its own
     document, so the id a preview showed an hour ago belongs to the version
     that was current then. The reference is the table itself, and looking it
     up this way is what turns a re-rostered table into a STALE PROOF — which
     is true and actionable — rather than a resource that has vanished. */
  const resource = published.find((r) => str(r.resourceRef) === str(resourceRef));
  if (!resource) {
    throw fail("PPC_CUTTING_RESOURCE_NOT_FOUND",
      "No published cutting resource of yours has that reference. Cutting publishes its resources in its own screen.");
  }

  const reserved = await reservedByResource(ctx.companyId, { excludeBookingId, session });
  const out = preview.previewCutting({
    stage,
    release: { releaseId: route.releaseId, releaseRef: route.releaseRef, versionNo: route.versionNo },
    quantity: plan.sourceBasis?.confirmedQuantity,
    resources: [resource],
    from: from || todayIso(),
    planningFileRevision: plan.revision,
    reservedByResource: reserved,
  });

  return { plan, route, stage, resource, preview: out, option: out.options?.[0] || null };
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/* ══ THE COMMAND ══════════════════════════════════════════════════════════ */

/**
 * Reserve the previewed capacity.
 *
 * @param body `{ planningFileId, resourceRef, proof }` — and nothing else.
 */
async function bookCuttingCapacity(ctx, { body = {}, actor, idempotencyKey, from = null } = {}) {
  const schedule = require("./stageSchedule.service");
  schedule.assertContext(ctx);
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  refuseUnknown(body);

  const planningFileId = str(body.planningFileId);
  const resourceRef = str(body.resourceRef);
  const proof = str(body.proof);
  if (!isId(planningFileId)) {
    throw fail("VALIDATION", "Say which planning file this reserves capacity for.", { field: "planningFileId" });
  }
  if (!resourceRef) {
    throw fail("VALIDATION", "Say which cutting resource to reserve.", { field: "resourceRef" });
  }
  if (!proof) {
    throw fail("PPC_CUTTING_BOOKING_PROOF_REQUIRED",
      "Send the proof from the preview you read, so a window that has moved cannot be booked.",
      { field: "proof" });
  }

  const target = await schedule.loadPlan(ctx, planningFileId);

  return planningCommand(ctx, {
    scope: `ppc:cutting-booking:${String(target._id)}`,
    command: "CUTTING_CAPACITY_BOOKED",
    idempotencyKey,
    request: { planningFileId: String(target._id), resourceRef, proof },
  }, async (session) => {
    /* A plan's cutting stage holds at most one reservation. The partial
       unique index is what enforces it; this says so by name, because
       "duplicate key" is not an answer a planner can act on. Moving an
       existing reservation is `replan`, which returns its minutes first. */
    const held = await activeBooking(ctx, { planningFileId: target._id, session });
    if (held) {
      throw fail("PPC_CUTTING_BOOKING_NOT_BOOKABLE",
        `This plan already holds ${held.bookingRef} on ${held.resource.name}. Release it or replan it; `
        + "nothing was booked.",
        { reason: "ALREADY_BOOKED", bookingId: held.bookingId, bookingRef: held.bookingRef });
    }

    /* ── AND NOTHING UNDERNEATH THE PLAN MAY HAVE MOVED ──────────────
       A booking commits real minutes on a real table. The proof below proves
       the plan's OWN figures have not moved; this asks the question the proof
       cannot, because a plan's frozen basis does not change when Sales does:
       is the confirmed line, the execution pack or the frozen release still
       what this plan was made from? The publication asks the same question
       before it sends the dates out; asking it here too means capacity is
       never held against a quantity that no longer exists. */
    const orderBook = require("./orderBook.service");
    const health = await orderBook.sourceHealth(ctx, target);
    if (health?.moved) {
      throw stale("What this plan was made from has moved", {
        reason: "SOURCE_MOVED", movements: health.movements,
      });
    }

    const now = await recompute(ctx, { planningFileId: target._id, resourceRef, from, session });
    const option = now.option;

    if (!option) {
      const why = now.preview.blocker || now.preview.state;
      throw fail("PPC_CUTTING_BOOKING_NOT_BOOKABLE",
        `${now.preview.message || "That resource cannot do this work now."} Nothing was booked.`,
        { reason: why, excluded: now.preview.excluded });
    }
    if (!option.complete) {
      throw fail("PPC_CUTTING_BOOKING_NOT_BOOKABLE",
        "That resource cannot finish this work within the horizon. Nothing was booked.",
        { reason: "CAPACITY_INSUFFICIENT", remainingMinutes: option.remainingMinutes });
    }

    /* ── THE PROOF ────────────────────────────────────────────────────
       Recomputed above from the plan, the release, the standard, the roster
       and what is reserved at this instant. If any of them moved since the
       preview was read, the hash differs and nothing is booked. */
    if (str(option.proof) !== proof) {
      throw stale("Something moved", {
        moved: [
          "the plan or its generation", "the confirmed quantity",
          "the IE release or cutting standard", "the resource version",
          "the crew, efficiency or calendar", "a downtime or exception",
          "another plan's reservation", "the calculated window",
        ],
        previewedProof: proof.slice(0, 12), currentProof: str(option.proof).slice(0, 12),
      });
    }

    /* ── THE PLAN MUST STILL BE THE ONE THAT WAS CALCULATED ──────────
       Read inside the transaction, by the revision and state the calculation
       read. It is a read and not a write on purpose: a planning file is
       permanent evidence and its model refuses every write that is not one of
       the lifecycle's own shapes, so a booking may not stamp a fence counter
       into it. What actually serialises this command is below and elsewhere —
       the conditional `$inc` on each resource-day, the partial unique index
       that allows one ACTIVE booking per stage, and the schedule's own
       revision — and this check turns a plan that moved underneath into a
       named refusal rather than a booking against stale arithmetic. */
    const planNow = await PpcPlanningFile.findOne(
      { _id: now.plan._id, companyId: oid(ctx.companyId), revision: now.plan.revision,
        state: { $in: ACTIVE_STATES } },
    ).select({ _id: 1 }).session(session).lean();
    if (!planNow) throw stale("The plan changed", { key: "planningFileRevision" });

    const allocations = option.days.filter((d) => d.usedMinutes > 0)
      .map((d) => ({
        date: d.date,
        availableMinutes: d.grossCapacityMinutes ?? d.capacityMinutes,
        reservedMinutes: d.usedMinutes,
      }));

    /* ── TAKE THE MINUTES, DAY BY DAY, CONDITIONALLY ─────────────────
       The one place capacity is actually protected. The filter matches only
       while what is already reserved leaves room for this; the upsert's
       unique index catches the two-writers-no-document race. */
    await takeMinutes(ctx, {
      resource: now.resource, allocations, session,
    });

    const generation = (await CuttingCapacityBooking.countDocuments({
      companyId: oid(ctx.companyId), planningFileId: now.plan._id, stageId: now.stage.stageId,
    }).session(session)) + 1;

    const who = person(actor);
    const at = new Date();
    const [created] = await CuttingCapacityBooking.create([{
      companyId: oid(ctx.companyId),
      bookingRef: bookingRefFor(String(ctx.companyId), String(now.plan._id), generation),
      orderLineRef: str(now.plan.orderLineRef),
      planningFileId: now.plan._id,
      planningFileRef: str(now.plan.planningFileRef),
      planningGeneration: now.plan.generation ?? null,
      planningFileRevision: now.plan.revision,
      stageId: str(now.stage.stageId),

      ieReleaseId: oid(now.route.releaseId),
      ieReleaseRef: str(now.route.releaseRef),
      ieReleaseVersionNo: now.route.versionNo ?? null,
      standardFingerprint: preview.standardFingerprint(now.preview.basis.standard),

      confirmedQuantity: now.preview.basis.quantity,
      workloadMinutes: now.preview.basis.workloadMinutes,
      timeBasis: str(now.preview.basis.workloadTimeBasis),

      resourceId: oid(now.resource.resourceId),
      resourceRef: str(now.resource.resourceRef),
      resourceName: str(now.resource.name),
      resourceType: str(now.resource.resourceType),
      resourceVersionNo: now.resource.versionNo,
      siteRef: str(now.resource.siteRef),

      crew: (now.resource.crew || []).map((c) => ({ role: str(c.role), count: c.count })),
      headcount: option.headcount,
      usableCrew: option.usableCrew,
      scalingMethod: str(now.preview.basis.standard.capacityModel.scalingMethod),
      operationalEfficiencyPercent: now.resource.operationalEfficiencyPercent,
      ieStandardEfficiencyPercent: now.preview.basis.standard.capacityModel.standardEfficiencyPercent,

      windowStart: option.earliestStart,
      windowEnd: option.earliestFinish,
      allocations,
      reservedMinutes: allocations.reduce((sum, a) => sum + a.reservedMinutes, 0),
      proofHash: str(option.proof),

      state: BOOKING_STATE.ACTIVE,
      generation,
      revision: 1,
      history: [{ type: "BOOKED", at, actorName: who.name, toState: BOOKING_STATE.ACTIVE }],
      createdBy: who,
    }], { session, ordered: true });

    /* ── AND THE SCHEDULE FOLLOWS THE BOOKING ────────────────────────
       The cutting stage's dates are written FROM the reservation, as a new
       schedule version. A planner never types them, and the two can never
       disagree because only one of them is authored. */
    const scheduleOut = await schedule.setStageDatesFromBooking(ctx, {
      plan: now.plan,
      stageId: str(now.stage.stageId),
      plannedStart: option.earliestStart,
      plannedEnd: option.earliestFinish,
      reason: `Cutting capacity reserved on ${now.resource.name} (${created.bookingRef}).`,
      actor,
      session,
    });

    return { booking: bookingOut(created.toObject()), schedule: scheduleOut };
  });
}

/**
 * Take the minutes, one day at a time, conditionally.
 *
 * The filter is the protection: it matches only while `reservedMinutes` plus
 * this request still fits in the day. Two transactions racing for the last
 * minutes both issue it; one matches, and the other finds no document and
 * either fails the upsert at the unique index or matches nothing — both of
 * which refuse. Nothing here reads first and writes after.
 */
async function takeMinutes(ctx, { resource, allocations, session }) {
  for (const a of allocations) {
    const refuse = () => fail("PPC_CUTTING_CAPACITY_OVERBOOKED",
      `${resource.name} no longer has ${a.reservedMinutes.toLocaleString("en-IN")} free minutes on ${a.date}. `
      + "Nothing was booked — preview again.",
      { date: a.date, resourceRef: resource.resourceRef, requested: a.reservedMinutes, available: a.availableMinutes });
    if (a.reservedMinutes > a.availableMinutes) throw refuse();
    try {
      const held = await CuttingResourceDay.findOneAndUpdate(
        {
          companyId: oid(ctx.companyId), resourceRef: str(resource.resourceRef), date: a.date,
          reservedMinutes: { $lte: a.availableMinutes - a.reservedMinutes },
        },
        {
          $inc: { reservedMinutes: a.reservedMinutes },
          $set: { availableMinutes: a.availableMinutes, resourceVersionNo: resource.versionNo },
        },
        { new: true, upsert: true, session },
      );
      if (!held) throw refuse();
    } catch (err) {
      if (err?.code === 11000) throw refuse();
      throw err;
    }
  }
}

/** Give the minutes back. Used by release and by replan's successor. */
async function returnMinutes(ctx, { booking, session }) {
  for (const a of booking.allocations || []) {
    await CuttingResourceDay.updateOne(
      { companyId: booking.companyId, resourceRef: str(booking.resourceRef), date: a.date },
      { $inc: { reservedMinutes: -a.reservedMinutes } },
      { session },
    );
  }
}

/* ══ RELEASE AND REPLAN ═══════════════════════════════════════════════════ */

function releaseReason(body) {
  const reason = str(body?.reason).toUpperCase();
  if (!RELEASE_REASON.includes(reason)) {
    throw fail("PPC_CUTTING_BOOKING_REASON_INVALID",
      "Say why this reservation is being given up.", { field: "reason", allowed: RELEASE_REASON });
  }
  const note = str(body?.note).replace(/\s+/g, " ");
  if (note.length < 10) {
    throw fail("PPC_CUTTING_BOOKING_REASON_INVALID",
      "Say in at least 10 characters what changed.", { field: "note" });
  }
  return { reason, note: note.slice(0, LIMITS.REASON) };
}

async function loadBooking(ctx, bookingId, session = null) {
  if (!isId(bookingId)) {
    throw fail("PPC_CUTTING_BOOKING_NOT_FOUND", "No cutting booking of yours has that id.");
  }
  const doc = await CuttingCapacityBooking.findOne({
    _id: oid(bookingId), companyId: oid(ctx.companyId),
  }).session(session);
  if (!doc) throw fail("PPC_CUTTING_BOOKING_NOT_FOUND", "No cutting booking of yours has that id.");
  return doc;
}

/**
 * Give up the reservation.
 *
 * The minutes go back to the ledger and the booking becomes RELEASED — it is
 * not deleted, and the schedule dates it produced stay exactly where they are.
 * What changes is that the plan no longer holds capacity, which every reader
 * of the target is told.
 */
async function releaseBooking(ctx, { bookingId, body = {}, actor, idempotencyKey } = {}) {
  const schedule = require("./stageSchedule.service");
  schedule.assertContext(ctx);
  const { reason, note } = releaseReason(body);
  const at = new Date();
  const who = person(actor);

  return planningCommand(ctx, {
    scope: `ppc:cutting-booking:release:${str(bookingId)}`,
    command: "CUTTING_CAPACITY_RELEASED",
    idempotencyKey,
    request: { bookingId: str(bookingId), reason, note },
  }, async (session) => {
    const doc = await loadBooking(ctx, bookingId, session);
    if (doc.state !== BOOKING_STATE.ACTIVE) {
      throw fail("PPC_CUTTING_BOOKING_CLOSED",
        `This booking is ${doc.state}; there is nothing to release.`, { state: doc.state });
    }
    await returnMinutes(ctx, { booking: doc, session });
    doc.state = BOOKING_STATE.RELEASED;
    doc.releaseReason = reason;
    doc.releaseNote = note;
    doc.releasedAt = at;
    doc.releasedBy = who;
    doc.revision += 1;
    doc.history.push({ type: "RELEASED", at, actorName: who.name,
      fromState: BOOKING_STATE.ACTIVE, toState: BOOKING_STATE.RELEASED, reason: note });
    await doc.save({ session });
    return { booking: bookingOut(doc.toObject()) };
  });
}

/**
 * Move the reservation: a successor booking, from a fresh preview.
 *
 * The old one's minutes are returned inside the same transaction that takes
 * the new one's, so a replan onto the same resource does not lose to itself,
 * and it becomes SUPERSEDED rather than disappearing.
 */
async function replanBooking(ctx, { bookingId, body = {}, actor, idempotencyKey, from = null } = {}) {
  const schedule = require("./stageSchedule.service");
  schedule.assertContext(ctx);
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  const { reason, note } = releaseReason(body);
  const resourceRef = str(body.resourceRef);
  const proof = str(body.proof);
  if (!resourceRef) {
    throw fail("VALIDATION", "Say which cutting resource the successor reserves.", { field: "resourceRef" });
  }
  if (!proof) {
    throw fail("PPC_CUTTING_BOOKING_PROOF_REQUIRED",
      "Send the proof from the preview you read.", { field: "proof" });
  }

  return planningCommand(ctx, {
    scope: `ppc:cutting-booking:replan:${str(bookingId)}`,
    command: "CUTTING_CAPACITY_REPLANNED",
    idempotencyKey,
    request: { bookingId: str(bookingId), resourceRef, proof, reason, note },
  }, async (session) => {
    const old = await loadBooking(ctx, bookingId, session);
    if (old.state !== BOOKING_STATE.ACTIVE) {
      throw fail("PPC_CUTTING_BOOKING_CLOSED",
        `This booking is ${old.state}; there is nothing to replan.`, { state: old.state });
    }

    /* The old minutes go back FIRST, inside this transaction, so a successor
       on the same resource is proved against a ledger that no longer counts
       the reservation it is replacing. */
    await returnMinutes(ctx, { booking: old, session });

    const now = await recompute(ctx, {
      planningFileId: old.planningFileId, resourceRef, from,
      excludeBookingId: String(old._id), session,
    });
    const option = now.option;
    if (!option || !option.complete) {
      throw fail("PPC_CUTTING_BOOKING_NOT_BOOKABLE",
        "That resource cannot do this work now. Nothing was changed.",
        { reason: now.preview.blocker || "CAPACITY_INSUFFICIENT" });
    }
    if (str(option.proof) !== proof) {
      throw stale("Something moved", {
        previewedProof: proof.slice(0, 12), currentProof: str(option.proof).slice(0, 12),
      });
    }

    const allocations = option.days.filter((d) => d.usedMinutes > 0)
      .map((d) => ({
        date: d.date,
        availableMinutes: d.grossCapacityMinutes ?? d.capacityMinutes,
        reservedMinutes: d.usedMinutes,
      }));
    await takeMinutes(ctx, { resource: now.resource, allocations, session });

    const at = new Date();
    const who = person(actor);
    const generation = old.generation + 1;

    /* ── THE PREDECESSOR STEPS DOWN FIRST ────────────────────────────
       One ACTIVE booking per plan and stage is a PARTIAL UNIQUE INDEX, and
       the index is checked at the instant of the write, not at commit — so a
       successor inserted while its predecessor is still ACTIVE is refused by
       the database. The predecessor is moved to SUPERSEDED here, and told
       which booking replaced it below, once that booking has an id. Both
       writes are inside this transaction: either the whole replan happens or
       none of it does. */
    old.state = BOOKING_STATE.SUPERSEDED;
    old.releaseReason = reason;
    old.releaseNote = note;
    old.revision += 1;
    old.history.push({ type: "SUPERSEDED", at, actorName: who.name,
      fromState: BOOKING_STATE.ACTIVE, toState: BOOKING_STATE.SUPERSEDED, reason: note });
    await old.save({ session });

    const [created] = await CuttingCapacityBooking.create([{
      companyId: oid(ctx.companyId),
      bookingRef: bookingRefFor(String(ctx.companyId), String(now.plan._id), generation),
      orderLineRef: str(now.plan.orderLineRef),
      planningFileId: now.plan._id,
      planningFileRef: str(now.plan.planningFileRef),
      planningGeneration: now.plan.generation ?? null,
      planningFileRevision: now.plan.revision,
      stageId: str(now.stage.stageId),
      ieReleaseId: oid(now.route.releaseId),
      ieReleaseRef: str(now.route.releaseRef),
      ieReleaseVersionNo: now.route.versionNo ?? null,
      standardFingerprint: preview.standardFingerprint(now.preview.basis.standard),
      confirmedQuantity: now.preview.basis.quantity,
      workloadMinutes: now.preview.basis.workloadMinutes,
      timeBasis: str(now.preview.basis.workloadTimeBasis),
      resourceId: oid(now.resource.resourceId),
      resourceRef: str(now.resource.resourceRef),
      resourceName: str(now.resource.name),
      resourceType: str(now.resource.resourceType),
      resourceVersionNo: now.resource.versionNo,
      siteRef: str(now.resource.siteRef),
      crew: (now.resource.crew || []).map((c) => ({ role: str(c.role), count: c.count })),
      headcount: option.headcount,
      usableCrew: option.usableCrew,
      scalingMethod: str(now.preview.basis.standard.capacityModel.scalingMethod),
      operationalEfficiencyPercent: now.resource.operationalEfficiencyPercent,
      ieStandardEfficiencyPercent: now.preview.basis.standard.capacityModel.standardEfficiencyPercent,
      windowStart: option.earliestStart,
      windowEnd: option.earliestFinish,
      allocations,
      reservedMinutes: allocations.reduce((sum, a) => sum + a.reservedMinutes, 0),
      proofHash: str(option.proof),
      state: BOOKING_STATE.ACTIVE,
      supersedesBookingId: old._id,
      supersedesBookingRef: str(old.bookingRef),
      generation,
      revision: 1,
      history: [{ type: "REPLANNED", at, actorName: who.name,
        toState: BOOKING_STATE.ACTIVE, reason: note }],
      createdBy: who,
    }], { session, ordered: true });

    /* And now it can name the booking that replaced it. */
    old.supersededByBookingId = created._id;
    old.supersededByBookingRef = str(created.bookingRef);
    await old.save({ session });

    const scheduleOut = await schedule.setStageDatesFromBooking(ctx, {
      plan: now.plan,
      stageId: str(now.stage.stageId),
      plannedStart: option.earliestStart,
      plannedEnd: option.earliestFinish,
      reason: note,
      actor,
      session,
    });

    return { booking: bookingOut(created.toObject()), supersededBookingRef: str(old.bookingRef), schedule: scheduleOut };
  });
}

/* ══ READING ══════════════════════════════════════════════════════════════ */

function bookingOut(b) {
  return {
    bookingId: String(b._id),
    bookingRef: str(b.bookingRef),
    state: str(b.state),
    generation: b.generation,
    orderLineRef: str(b.orderLineRef),
    planningFileId: String(b.planningFileId),
    planningFileRef: str(b.planningFileRef),
    stageId: str(b.stageId),
    ieRelease: { releaseId: String(b.ieReleaseId), releaseRef: str(b.ieReleaseRef), versionNo: b.ieReleaseVersionNo ?? null },
    standardFingerprint: str(b.standardFingerprint),
    confirmedQuantity: b.confirmedQuantity,
    workloadMinutes: b.workloadMinutes,
    timeBasis: str(b.timeBasis),
    resource: {
      resourceId: String(b.resourceId), resourceRef: str(b.resourceRef), name: str(b.resourceName),
      resourceType: str(b.resourceType), versionNo: b.resourceVersionNo, siteRef: str(b.siteRef),
    },
    crew: (b.crew || []).map((c) => ({ role: str(c.role), count: c.count })),
    headcount: b.headcount,
    usableCrew: b.usableCrew,
    scalingMethod: str(b.scalingMethod),
    efficiency: {
      appliedPercent: b.operationalEfficiencyPercent, appliedFrom: "CUTTING_OPERATIONAL",
      informationalOnly: { source: "IE_STANDARD", percent: b.ieStandardEfficiencyPercent },
      appliedOnce: true,
    },
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    allocations: (b.allocations || []).map((a) => ({
      date: a.date, availableMinutes: a.availableMinutes, reservedMinutes: a.reservedMinutes,
    })),
    reservedMinutes: b.reservedMinutes,
    proofHash: str(b.proofHash),
    releaseReason: b.releaseReason || null,
    releaseNote: str(b.releaseNote),
    releasedAt: b.releasedAt ? new Date(b.releasedAt).toISOString() : null,
    supersedesBookingRef: str(b.supersedesBookingRef) || null,
    supersededByBookingRef: str(b.supersededByBookingRef) || null,
    revision: b.revision,
    history: (b.history || []).map((e) => ({
      type: e.type, at: e.at ? new Date(e.at).toISOString() : null, actorName: str(e.actorName),
      fromState: e.fromState || null, toState: e.toState || null, reason: str(e.reason),
    })),
    createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
    /* Said on every answer, so no reader has to infer any of it. */
    isDepartmentAcceptance: false,
    isDeadline: false,
    recordsActuals: false,
    releasesProduction: false,
  };
}

/** The booking in force for one plan's cutting stage, or null. */
async function activeBooking(ctx, { planningFileId, stageId, session = null } = {}) {
  if (!isId(planningFileId)) return null;
  const q = {
    companyId: oid(ctx.companyId), planningFileId: oid(planningFileId), state: BOOKING_STATE.ACTIVE,
  };
  if (stageId) q.stageId = str(stageId);
  const doc = await CuttingCapacityBooking.findOne(q).session(session).lean();
  return doc ? bookingOut(doc) : null;
}

/** Every booking a plan's cutting stage has had, newest first. */
async function bookingsFor(ctx, planningFileId) {
  if (!isId(planningFileId)) return [];
  const rows = await CuttingCapacityBooking.find({
    companyId: oid(ctx.companyId), planningFileId: oid(planningFileId),
  }).sort({ generation: -1 }).lean();
  return rows.map(bookingOut);
}

module.exports = {
  BOOKING_STATE, RELEASE_REASON, BODY_FIELDS, REFUSED,
  bookCuttingCapacity, releaseBooking, replanBooking,
  activeBooking, bookingsFor, bookingOut, recompute, reservedByResource,
  takeMinutes, returnMinutes,
};
