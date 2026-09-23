// services/ppc/cuttingCapacityPreview.service.js
//
// WHEN COULD CUTTING DO THIS? — A PREVIEW, AND NOTHING ELSE.
//
// Two records meet here and neither is written. Industrial Engineering's
// approved standard says how much work the order is and what the minutes
// mean. Cutting's published resource says what the cutting room has: which
// days, how many minutes, how many people in which roles, and how well it
// really runs. This service multiplies one by the other and says which days
// the work would fall on.
//
// ── PREVIEW ONLY, AND THAT IS A DESIGN DECISION, NOT A LIMITATION ───────────
// Nothing here reserves a resource, books a minute, publishes a target or
// releases anything to Production. There is no write in this file at all.
// Every answer says so on its face, because a screen showing dates that look
// like a commitment is how a preview becomes a promise nobody made.
//
// ── EFFICIENCY IS APPLIED EXACTLY ONCE, AND THE ANSWER SAYS WHICH ───────────
// Two efficiency figures exist and they are NOT multiplied together:
//
//   IE's `standardEfficiencyPercent` — what IE's own minutes ALREADY assume.
//     It is informational here. Applying it again would deflate the standard
//     by its own allowance, which is the classic way a plan comes out half
//     the length it should.
//
//   Cutting's `operationalEfficiencyPercent` — what this table actually
//     achieves. This is the one that is applied, because IE's minutes are a
//     standard and Cutting's floor is not a standard floor.
//
// Every answer carries `efficiency.appliedFrom` naming which one was used and
// `efficiency.informationalOnly` naming the one that was not, so a reader is
// never left to infer it from a number that looks slightly wrong.
//
// ── AND THE SCALING RULE IS IE'S, NEVER GUESSED ─────────────────────────────
// Whether a fourth person helps is a question only the approved standard can
// answer, and `cuttingTechnicalBasis.effectiveCrew` answers it. Above a
// LINEAR standard's validated range this service REFUSES rather than
// extrapolating: IE measured to four and said nothing about five.
"use strict";

const crypto = require("crypto");

const { eachDay, addDays } = require("./capacityCalendar");
const cuttingResources = require("../production/cuttingResource.service");
const { cuttingBasis, effectiveCrew, BASIS_STATE } = require("./cuttingTechnicalBasis.service");

const str = (v) => String(v ?? "").trim();
const round2 = (n) => Math.round(n * 100) / 100;

/** How far ahead a preview will look before giving up. */
const MAX_HORIZON_DAYS = 180;

/**
 * Why a published resource cannot do this work, by name.
 *
 * Each is a different conversation with a different person, so none of them
 * is collapsed into "not eligible": a type mismatch is IE's or Cutting's
 * vocabulary, a short crew is Cutting's roster, and a crew outside the
 * validated range is a question for IE.
 */
const EXCLUSION = Object.freeze({
  RESOURCE_TYPE_MISMATCH: "PPC_CUTTING_RESOURCE_TYPE_MISMATCH",
  RESOURCE_INACTIVE: "PPC_CUTTING_RESOURCE_INACTIVE",
  RESOURCE_NOT_EFFECTIVE: "PPC_CUTTING_RESOURCE_NOT_EFFECTIVE",
  CREW_BELOW_MINIMUM: "PPC_CUTTING_CREW_BELOW_MINIMUM",
  CREW_ROLE_MISSING: "PPC_CUTTING_CREW_ROLE_MISSING",
  CREW_OUTSIDE_VALIDATED_RANGE: "PPC_CUTTING_CREW_OUTSIDE_VALIDATED_RANGE",
  CALENDAR_UNREADABLE: "PPC_CUTTING_CALENDAR_UNREADABLE",
});

/** Why the preview as a whole has no answer. */
const PREVIEW_BLOCKER = Object.freeze({
  NO_RESOURCES: "PPC_CUTTING_NO_PUBLISHED_RESOURCES",
  NONE_ELIGIBLE: "PPC_CUTTING_NO_ELIGIBLE_RESOURCE",
  CAPACITY_INSUFFICIENT: "PPC_CUTTING_CAPACITY_INSUFFICIENT",
  STANDARD_BLOCKED: "PPC_CUTTING_STANDARD_BLOCKED",
});

const OWNER = Object.freeze({
  [EXCLUSION.RESOURCE_TYPE_MISMATCH]: "Industrial Engineering / Cutting",
  [EXCLUSION.RESOURCE_INACTIVE]: "Cutting",
  [EXCLUSION.RESOURCE_NOT_EFFECTIVE]: "Cutting",
  [EXCLUSION.CREW_BELOW_MINIMUM]: "Cutting",
  [EXCLUSION.CREW_ROLE_MISSING]: "Cutting",
  [EXCLUSION.CREW_OUTSIDE_VALIDATED_RANGE]: "Industrial Engineering",
  [EXCLUSION.CALENDAR_UNREADABLE]: "Cutting",
  [PREVIEW_BLOCKER.NO_RESOURCES]: "Cutting",
  [PREVIEW_BLOCKER.NONE_ELIGIBLE]: "Cutting",
  [PREVIEW_BLOCKER.CAPACITY_INSUFFICIENT]: "Cutting",
  [PREVIEW_BLOCKER.STANDARD_BLOCKED]: "Industrial Engineering",
});

/** The people this resource has, keyed by role. */
const crewByRole = (resource) => new Map(
  (resource.crew || []).map((c) => [str(c.role), c.count]),
);

/**
 * Is this resource able to do this work at all, and with how many people?
 *
 * Returns either an eligible resource with its usable crew, or an exclusion
 * with the code and the department that owns it.
 */
function assess(resource, capacityModel, requiredType) {
  const exclude = (code, detail) => ({
    eligible: false, code, owner: OWNER[code], detail: detail || null,
  });

  if (str(resource.resourceType) !== str(requiredType)) {
    return exclude(EXCLUSION.RESOURCE_TYPE_MISMATCH,
      { required: str(requiredType), found: str(resource.resourceType) });
  }
  if (resource.isActive !== true) return exclude(EXCLUSION.RESOURCE_INACTIVE);

  /* ── THE CREW THE STANDARD REQUIRES ──────────────────────────────── */
  const have = crewByRole(resource);
  const missing = [];
  for (const need of capacityModel.requiredRoles || []) {
    const got = have.get(str(need.role)) || 0;
    if (got < need.count) missing.push({ role: str(need.role), required: need.count, available: got });
  }
  if (missing.length) return exclude(EXCLUSION.CREW_ROLE_MISSING, { missing });

  const headcount = [...have.values()].reduce((sum, n) => sum + n, 0);
  if (headcount < capacityModel.minimumCrewSize) {
    return exclude(EXCLUSION.CREW_BELOW_MINIMUM,
      { available: headcount, minimumCrewSize: capacityModel.minimumCrewSize });
  }

  /* ── AND WHAT THE APPROVED SCALING RULE SAYS ABOUT IT ────────────── */
  const scaled = effectiveCrew(capacityModel, headcount);
  if (scaled.usable === null) {
    return exclude(
      scaled.reason === "BELOW_MINIMUM_CREW"
        ? EXCLUSION.CREW_BELOW_MINIMUM : EXCLUSION.CREW_OUTSIDE_VALIDATED_RANGE,
      { available: headcount, reason: scaled.reason, ...scaled },
    );
  }
  return {
    eligible: true,
    headcount,
    usableCrew: scaled.usable,
    crewNote: scaled.reason,
    scales: scaled.scales !== false,
  };
}

/**
 * The minutes this resource offers on one day, after its own efficiency.
 *
 * `LABOUR_MINUTES` — the work is labour content, so every usable person's
 *   minutes count: net shift minutes × usable crew × efficiency.
 *
 * `TEAM_ELAPSED_MINUTES` — the work is wall-clock time for the approved crew,
 *   so the day offers its shift minutes ONCE however many people are on it.
 *   Multiplying by headcount here is the mistake the whole capacity model
 *   exists to prevent.
 */
function dayCapacity({ netMinutes, timeBasis, usableCrew, efficiencyPercent }) {
  const factor = efficiencyPercent / 100;
  const raw = timeBasis === "LABOUR_MINUTES" ? netMinutes * usableCrew : netMinutes;
  return round2(raw * factor);
}

/**
 * When could this resource finish the work, starting no earlier than `from`?
 *
 * Walks real calendar days, taking what each one offers, until the workload
 * is consumed or the horizon runs out. Produces days, never a duration: a
 * cutting room's week has holidays in it and a "three day" answer that
 * ignored them would be wrong by the weekend.
 */
function schedule(resource, {
  from, workloadMinutes, timeBasis, usableCrew, horizonDays, reservedByDate = new Map(),
}) {
  const days = [];
  let remaining = workloadMinutes;
  let unreadable = null;

  for (const date of eachDay(from, addDays(from, horizonDays - 1))) {
    const net = cuttingResources.netMinutesOn(resource, date);
    if (!net.known) {
      /* The roster says nothing about this day. Stop rather than assume: an
         assumed rest day shortens nothing, but an assumed working day would
         promise a window the floor never offered. */
      unreadable = { date, reason: net.reason };
      break;
    }
    const gross = net.working
      ? dayCapacity({
        netMinutes: net.minutes, timeBasis, usableCrew,
        efficiencyPercent: resource.operationalEfficiencyPercent,
      })
      : 0;
    /* What OTHER plans have already reserved on this resource that day. A
       preview that ignored it would offer minutes somebody else holds, and
       the booking would then be refused by the ledger — correctly, but after
       the planner had been shown a window that never existed. */
    const alreadyReserved = Number(reservedByDate.get(date) || 0);
    const capacity = round2(Math.max(gross - alreadyReserved, 0));
    const used = Math.min(capacity, remaining);
    remaining = round2(remaining - used);
    days.push({
      date,
      working: net.working,
      netShiftMinutes: net.minutes,
      /* Gross, reserved and free, so a planner can see WHY a day is short
         rather than only that it is. */
      grossCapacityMinutes: gross,
      reservedByOthersMinutes: alreadyReserved,
      capacityMinutes: capacity,
      usedMinutes: round2(used),
      remainingAfter: remaining,
      source: net.source,
      reason: net.reason || null,
    });
    if (remaining <= 0) break;
  }

  const worked = days.filter((d) => d.usedMinutes > 0);
  return {
    days,
    complete: remaining <= 0,
    remainingMinutes: Math.max(remaining, 0),
    earliestStart: worked.length ? worked[0].date : null,
    earliestFinish: remaining <= 0 && worked.length ? worked[worked.length - 1].date : null,
    workingDayCount: worked.length,
    unreadable,
  };
}

/**
 * The preview for one cutting stage.
 *
 * @param stage        the CUTTING stage as the FROZEN release publishes it
 * @param release      the release the plan froze
 * @param quantity     Sales' confirmed quantity
 * @param resources    Cutting's PUBLISHED resources (read, never written)
 * @param from         the earliest date the preview may start
 * @param requiredBy   the delivery window's own date, when there is one
 */
function previewCutting({
  stage, release = {}, quantity, resources = [], from, requiredBy = null,
  horizonDays = MAX_HORIZON_DAYS, reservedByResource = new Map(), planningFileRevision = null,
} = {}) {
  const basis = cuttingBasis({ stage, release, quantity });

  const shell = {
    /* Said on every answer, however it turns out. */
    previewOnly: true,
    notice: "Preview only — no Cutting capacity has been reserved and no target has been published.",
    reservesCapacity: false,
    publishesTarget: false,
    releasesProduction: false,
    basis,
  };

  if (!basis || basis.state === BASIS_STATE.NOT_APPLICABLE) {
    return { ...shell, state: "NOT_APPLICABLE", blocker: null, options: [], excluded: [] };
  }
  if (!basis.schedulable) {
    /* The engineering is not stated or not readable. Cutting's roster cannot
       rescue that, and the preview does not pretend otherwise. */
    return {
      ...shell,
      state: PREVIEW_BLOCKER.STANDARD_BLOCKED,
      blocker: basis.blocker,
      owner: OWNER[PREVIEW_BLOCKER.STANDARD_BLOCKED],
      message: basis.message,
      options: [], excluded: [],
    };
  }

  const cm = basis.standard.capacityModel;
  const requiredType = basis.standard.resourceType;

  if (!resources.length) {
    return {
      ...shell,
      state: PREVIEW_BLOCKER.NO_RESOURCES,
      blocker: PREVIEW_BLOCKER.NO_RESOURCES,
      owner: OWNER[PREVIEW_BLOCKER.NO_RESOURCES],
      message: "Cutting has published no resources for this company, so no cutting window can be previewed. "
        + "Cutting publishes its tables, shifts and crew in its own screen.",
      options: [], excluded: [],
    };
  }

  const options = [];
  const excluded = [];
  for (const resource of resources) {
    const verdict = assess(resource, cm, requiredType);
    if (!verdict.eligible) {
      excluded.push({
        resourceRef: resource.resourceRef, name: resource.name, siteRef: resource.siteRef,
        resourceType: resource.resourceType,
        reason: verdict.code, owner: verdict.owner, detail: verdict.detail,
      });
      continue;
    }
    const run = schedule(resource, {
      from, workloadMinutes: basis.workloadMinutes, timeBasis: cm.timeBasis,
      usableCrew: verdict.usableCrew, horizonDays,
      reservedByDate: reservedByResource.get(String(resource.resourceRef)) || new Map(),
    });
    if (run.unreadable && !run.days.some((d) => d.usedMinutes > 0)) {
      excluded.push({
        resourceRef: resource.resourceRef, name: resource.name, siteRef: resource.siteRef,
        resourceType: resource.resourceType,
        reason: EXCLUSION.RESOURCE_NOT_EFFECTIVE, owner: OWNER[EXCLUSION.RESOURCE_NOT_EFFECTIVE],
        detail: run.unreadable,
      });
      continue;
    }
    options.push({
      resourceRef: resource.resourceRef,
      resourceId: resource.resourceId,
      name: resource.name,
      siteRef: resource.siteRef,
      resourceType: resource.resourceType,
      timezone: resource.timezone,
      resourceVersionNo: resource.versionNo,
      /* The crew, and what the approved rule made of it. */
      crew: resource.crew,
      headcount: verdict.headcount,
      usableCrew: verdict.usableCrew,
      crewNote: verdict.crewNote,
      scalesWithCrew: verdict.scales,
      /* Exactly one efficiency, named. */
      efficiency: {
        appliedPercent: resource.operationalEfficiencyPercent,
        appliedFrom: "CUTTING_OPERATIONAL",
        informationalOnly: {
          source: "IE_STANDARD", percent: cm.standardEfficiencyPercent,
          note: "Industrial Engineering's minutes already assume this; applying it again would "
            + "deflate the standard by its own allowance.",
        },
        appliedOnce: true,
      },
      days: run.days,
      earliestStart: run.earliestStart,
      earliestFinish: run.earliestFinish,
      workingDayCount: run.workingDayCount,
      complete: run.complete,
      remainingMinutes: run.remainingMinutes,
      /* Does it land inside the window the order needs? Reported, never
         acted on: the preview chooses nothing. */
      meetsRequiredBy: requiredBy && run.earliestFinish ? run.earliestFinish <= requiredBy : null,
      /* ── THE PROOF ────────────────────────────────────────────────
         Everything that must not have moved between reading this preview
         and taking the booking, in one opaque string. The booking command
         recomputes it from the records themselves and compares; a client
         cannot make a stale window current by echoing numbers back. */
      proof: run.complete ? proofOf({
        planningFileRevision,
        quantity: basis.quantity,
        ieReleaseId: basis.ieReleaseId,
        ieReleaseVersionNo: basis.ieReleaseVersionNo,
        standardFingerprint: standardFingerprint(basis.standard),
        stageId: basis.stageId,
        resourceRef: resource.resourceRef,
        resourceVersionNo: resource.versionNo,
        usableCrew: verdict.usableCrew,
        efficiencyPercent: resource.operationalEfficiencyPercent,
        workloadMinutes: basis.workloadMinutes,
        allocations: run.days.filter((d) => d.usedMinutes > 0)
          .map((d) => [d.date, d.usedMinutes, d.capacityMinutes]),
      }) : null,
    });
  }

  if (!options.length) {
    return {
      ...shell,
      state: PREVIEW_BLOCKER.NONE_ELIGIBLE,
      blocker: PREVIEW_BLOCKER.NONE_ELIGIBLE,
      owner: OWNER[PREVIEW_BLOCKER.NONE_ELIGIBLE],
      message: "No published cutting resource can do this work. Each one is listed below with the "
        + "reason it was excluded and the department that owns it.",
      options: [], excluded,
    };
  }

  /* Soonest finish first, then fewest working days — a preview's ordering,
     not a choice. Nothing is selected and nothing is reserved. */
  const ranked = [...options].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    if (a.earliestFinish && b.earliestFinish && a.earliestFinish !== b.earliestFinish) {
      return a.earliestFinish < b.earliestFinish ? -1 : 1;
    }
    return a.workingDayCount - b.workingDayCount;
  });

  const best = ranked[0];
  const insufficient = !best.complete;
  const misses = requiredBy && best.earliestFinish ? best.earliestFinish > requiredBy : false;

  return {
    ...shell,
    state: insufficient || misses ? PREVIEW_BLOCKER.CAPACITY_INSUFFICIENT : "PREVIEWED",
    blocker: insufficient || misses ? PREVIEW_BLOCKER.CAPACITY_INSUFFICIENT : null,
    owner: insufficient || misses ? OWNER[PREVIEW_BLOCKER.CAPACITY_INSUFFICIENT] : null,
    message: insufficient
      ? `No published cutting resource can finish this work within ${horizonDays} days. `
        + "Cutting can add shifts, crew or a resource; PPC cannot."
      : (misses
        ? `The soonest cutting finish is ${best.earliestFinish}, after the ${requiredBy} this order needs. `
          + "Cutting can add capacity, or PPC can revisit the plan."
        : null),
    requiredBy: requiredBy || null,
    options: ranked,
    excluded,
  };
}

/**
 * The preview for one plan's cutting stage, read from the records it names.
 *
 * Every input is fetched, none is accepted from the caller: the release is the
 * one this plan froze, the quantity is the one Sales confirmed, and the
 * resources are the ones Cutting published in this company. A planner cannot
 * preview against engineering or a roster they chose.
 */
async function previewForPlan(ctx, { planningFileId, from = null, horizonDays, excludeBookingId = null } = {}) {
  /* Lazily, as this module's siblings do: the schedule reads publications
     through the publication service and this reads plans through the
     schedule, and a top-level cycle would be the price of saying so. */
  const schedule = require("./stageSchedule.service");
  schedule.assertContext(ctx);

  const plan = await schedule.loadPlan(ctx, planningFileId);
  const route = await schedule.routeFor(ctx, plan);
  const stage = (route.stages || []).find((s) => str(s.process) === "CUTTING");
  if (!stage) {
    return {
      previewOnly: true,
      notice: "Preview only — no Cutting capacity has been reserved and no target has been published.",
      state: "NOT_APPLICABLE", blocker: null, basis: null, options: [], excluded: [],
      message: "This plan's approved route has no cutting stage.",
    };
  }

  const basisPeek = cuttingBasis({ stage, release: {}, quantity: plan.sourceBasis?.confirmedQuantity });
  /* Only resources of the type the approved standard names are even read —
     the rest are not this stage's business and are not listed as excluded
     for a type they were never candidates for. */
  const requiredType = basisPeek?.standard?.resourceType || null;
  const resources = await cuttingResources.publishResourcesForPlanning(
    String(ctx.companyId), requiredType ? { resourceType: requiredType } : {},
  );

  /* What every other plan already holds on these resources. A preview that
     ignored it would offer minutes somebody else has, and — because the proof
     is taken over the calculated days — would produce a proof the booking
     command could never reproduce. Lazily required, as above: the booking
     service reads this module. */
  const booking = require("./cuttingCapacityBooking.service");
  /* This plan's OWN reservation is not competition for itself. A preview read
     while a booking is held is a planner asking where this work could go, and
     the replan command proves its successor against the same ledger — so the
     two see the same free minutes and the proof is reproducible. */
  const mine = excludeBookingId
    || (await booking.activeBooking(ctx, { planningFileId: plan._id }))?.bookingId
    || null;

  return previewCutting({
    stage,
    release: { releaseId: route.releaseId, releaseRef: route.releaseRef, versionNo: route.versionNo },
    quantity: plan.sourceBasis?.confirmedQuantity,
    resources,
    from: from || todayIso(),
    requiredBy: businessDateOf(plan.sourceBasis?.earliestDeliveryDate),
    /* The revision the calculation read. It is inside the proof, so a plan
       that moves between reading and booking cannot be booked. */
    planningFileRevision: plan.revision,
    reservedByResource: await booking.reservedByResource(ctx.companyId, { excludeBookingId: mine }),
    ...(horizonDays ? { horizonDays } : {}),
  });
}

/** The factory-calendar date of an instant, or null. */
function businessDateOf(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * A stable fingerprint of the exact cutting standard a calculation used.
 *
 * The release id and version say WHICH release; this says the figures inside
 * it are the ones that were read. Two standards that differ anywhere produce
 * different strings, so a re-approved minute-per-piece is caught even when
 * every other identifier reads the same.
 */
function standardFingerprint(standard) {
  if (!standard) return "";
  const cm = standard.capacityModel || {};
  return crypto.createHash("sha256").update(JSON.stringify([
    standard.kind, standard.standardMinutesPerPiece, standard.standardUnit,
    standard.setupMinutesPerOrder, standard.setupUnit, standard.resourceType,
    cm.timeBasis, cm.standardCrewSize, cm.minimumCrewSize, cm.maximumUsefulCrewSize,
    cm.scalingMethod, cm.standardEfficiencyPercent,
    (cm.requiredRoles || []).map((r) => [r.role, r.count]),
  ])).digest("hex");
}

/** One opaque string over everything a booking may not have moving under it. */
const proofOf = (parts) => crypto.createHash("sha256")
  .update(JSON.stringify(parts)).digest("hex");

module.exports = {
  MAX_HORIZON_DAYS, EXCLUSION, PREVIEW_BLOCKER, OWNER,
  standardFingerprint, proofOf,
  assess, dayCapacity, schedule, previewCutting, previewForPlan,
};
