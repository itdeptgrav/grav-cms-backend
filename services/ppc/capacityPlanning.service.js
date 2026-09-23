// services/ppc/capacityPlanning.service.js
//
// CAPACITY PREVIEW AND CAPACITY BOOKING — TWO DIFFERENT ACTS.
//
// ── A PREVIEW WRITES NOTHING ────────────────────────────────────────────────
// `preview` reads the planning file, its frozen engineering release, the line,
// the line's published calendar and what is already booked, and computes what a
// booking WOULD take. It creates no booking, no line-day counter and no ledger
// row, and its answer says `booksCapacity: false`. A planning file being PLANNED
// books nothing either; only the booking command does.
//
// ── A BOOKING IS PROVED, OR IT DOES NOT HAPPEN ──────────────────────────────
// `book` recomputes the preview inside its own command and refuses unless every
// one of these holds, naming each that does not:
//
//   · the planning file is PLANNED, at the revision the caller previewed, and
//     none of its authoritative sources has moved (or could not be read);
//   · its frozen engineering release is still that release, still ISSUED, and
//     carries a garment SAM and an efficiency — so demand is known;
//   · the line is ACTIVE, at the revision previewed;
//   · the line's calendar has a PUBLISHED version — not missing, not only a
//     draft (provisional), not a different version from the one previewed
//     (stale), and readable — and that version describes every day in the window;
//   · the window holds enough free operator-minutes for the whole demand.
//
// Then it takes its minutes day by day with a conditional `$inc` that matches
// only while the day still fits, and inserts the booking — all in ONE
// transaction with its idempotency ledger row. Any day that no longer fits
// aborts everything; nothing is half-booked.
//
// ── THE ARITHMETIC, STATED ONCE ─────────────────────────────────────────────
//   demand standard minutes   = garment SAM × confirmed quantity
//   required operator-minutes = demand ÷ (efficiency ÷ 100)
//   line-day capacity         = manned operators × calendar net minutes that day
//
// Efficiency is IE's, from the frozen release: the ramp stage's if IE froze one
// (the stage the line is planned at), the steady-state target otherwise. The
// working time is PPC's calendar. IE's own working-time ASSUMPTION is never read
// — the IE contract does not even return it.
//
// ── AND NOTHING HERE RELEASES PRODUCTION ────────────────────────────────────
// No work order, no production release, no Store, Merchandising or IE write.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  PpcCapacityBooking, PpcCapacityLineDay, BOOKING_STATE, RELEASE_REASON,
} = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const {
  PpcCapacityCalendar, PpcCapacityCalendarVersion, VERSION_STATE,
} = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
const { PpcCapacityLine, LINE_STATUS } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const {
  PpcPlanningFile, PLANNING_STATE, fencePlannedFileForBooking,
} = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const ie = require("../industrialEngineering/releasePublication.service");
const orderBook = require("./orderBook.service");
const { netMinutesOn, eachDay, spanDays } = require("./capacityCalendar");
const { isBusinessDate } = require("./businessDate");
const { planningCommand } = require("./planningCommand");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

/** The widest window one booking may span. Bounded, so a preview is bounded. */
const MAX_WINDOW_DAYS = 120;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}
function person(actor) {
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "A booking decision has to be attributable to the signed-in person.");
  return { id: oid(actor.id), name: str(actor.name) };
}

/** A problem that stops a booking. `code` is stable; `message` is for a person. */
const blocker = (code, message, details = {}) => ({ code, message, ...details });

/* ══ READING EACH INPUT HONESTLY ══════════════════════════════════════════
 *
 * Each read returns what it found AND a state, and a failed read is its own
 * state. `UNREADABLE` never becomes `MISSING`: "we could not check" and "there
 * is nothing there" send a planner to different people.
 */

async function readPlanningFile(ctx, planningFileId) {
  if (!isId(planningFileId)) throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that reference.");
  const doc = await PpcPlanningFile.findOne({ _id: oid(planningFileId), companyId: oid(ctx.companyId) }).lean();
  if (!doc) throw fail("PPC_PLANNING_FILE_NOT_FOUND", "No planning file of yours has that reference.");
  return doc;
}

async function readDemand(ctx, planningFile) {
  const b = planningFile.sourceBasis || {};
  let eng;
  try {
    eng = await ie.publishReleaseEngineering(ctx, String(b.ieReleaseId));
  } catch (err) {
    return { state: "UNREADABLE", fault: str(err?.message).slice(0, 200) };
  }
  if (!eng) return { state: "MISSING", reason: "RELEASE_NOT_FOUND" };

  const base = {
    ieReleaseId: eng.releaseId, ieReleaseRef: eng.releaseRef, ieReleaseVersionNo: eng.versionNo,
    releaseState: eng.state, plannedOperatorCount: eng.plannedOperatorCount,
    workingTimeAssumption: eng.workingTimeAssumption,
  };
  /* The release the plan froze, and no other. A superseded release has moved
     out from under the plan; its figures are not the plan's. */
  if (eng.versionNo !== b.ieReleaseVersionNo || eng.state !== "ISSUED") {
    return { ...base, state: "MOVED", reason: "RELEASE_MOVED",
      frozenVersionNo: b.ieReleaseVersionNo, currentState: eng.state };
  }
  const efficiency = eng.rampEfficiencyPercent ?? eng.targetEfficiencyPercent;
  const qty = Number(b.confirmedQuantity);
  if (!eng.garmentSamMinutes || !efficiency || !(qty > 0)) {
    return { ...base, state: "UNKNOWN",
      reason: !eng.garmentSamMinutes ? "NO_GARMENT_SAM" : !efficiency ? "NO_EFFICIENCY" : "NO_QUANTITY" };
  }
  const demandStandardMinutes = round2(eng.garmentSamMinutes * qty);
  return {
    ...base,
    state: "KNOWN",
    confirmedQuantity: qty,
    garmentSamMinutes: eng.garmentSamMinutes,
    efficiencyPercent: efficiency,
    efficiencySource: eng.rampEfficiencyPercent ? "IE_RAMP_STAGE" : "IE_TARGET",
    rampStageLabel: eng.rampStageLabel || null,
    demandStandardMinutes,
    /* Rounded UP to a whole minute: a booking that is short by a fraction of a
       minute is short, and rounding down would call it complete. */
    requiredOperatorMinutes: Math.ceil(demandStandardMinutes / (efficiency / 100)),
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

async function readLine(ctx, lineId) {
  if (!isId(lineId)) return { state: "MISSING" };
  try {
    const line = await PpcCapacityLine.findOne({ _id: oid(lineId), companyId: oid(ctx.companyId) }).lean();
    if (!line) return { state: "MISSING" };
    if (line.status !== LINE_STATUS.ACTIVE) return { state: "RETIRED", line };
    return { state: "ACTIVE", line };
  } catch (err) {
    return { state: "UNREADABLE", fault: str(err?.message).slice(0, 200) };
  }
}

/**
 * The calendar a line works to, and which of its versions is authoritative.
 *
 * PUBLISHED — one published version exists: bookable.
 * PROVISIONAL — only drafts exist: nothing is proved, nothing may be booked.
 * MISSING — no version at all, or the calendar itself is gone.
 * UNREADABLE — the read failed.
 */
async function readCalendar(ctx, calendarId) {
  try {
    const cal = await PpcCapacityCalendar.findOne({ _id: calendarId, companyId: oid(ctx.companyId) }).lean();
    if (!cal) return { state: "MISSING" };
    const published = await PpcCapacityCalendarVersion.findOne({
      companyId: cal.companyId, calendarId: cal._id, state: VERSION_STATE.PUBLISHED,
    }).lean();
    if (published) return { state: "PUBLISHED", calendar: cal, version: published };
    const drafts = await PpcCapacityCalendarVersion.countDocuments({
      companyId: cal.companyId, calendarId: cal._id, state: VERSION_STATE.DRAFT,
    });
    return { state: drafts ? "PROVISIONAL" : "MISSING", calendar: cal };
  } catch (err) {
    return { state: "UNREADABLE", fault: str(err?.message).slice(0, 200) };
  }
}

/** Operator-minutes already booked on each day, excluding one booking if replanning it. */
async function readBooked(ctx, lineId, from, to, excludeBooking) {
  const days = await PpcCapacityLineDay.find({
    companyId: oid(ctx.companyId), lineId, date: { $gte: from, $lte: to },
  }).lean();
  const booked = new Map(days.map((d) => [d.date, d.bookedOperatorMinutes]));
  /* The booking being replanned gives its own minutes back, so a replan onto the
     same days is not refused for competing with itself. */
  for (const a of excludeBooking?.allocations || []) {
    if (String(excludeBooking.lineId) === String(lineId) && booked.has(a.date)) {
      booked.set(a.date, Math.max(0, booked.get(a.date) - a.operatorMinutes));
    }
  }
  return booked;
}

/* ══ THE PREVIEW — ONE CODE PATH FOR SCREEN AND COMMAND ═══════════════════ */

async function computePlan(ctx, {
  planningFileId, lineId, windowStart, windowEnd, excludeBookingId = null,
} = {}) {
  assertContext(ctx);
  const blockers = [];
  const unknowns = [];

  /* ── THE WINDOW ───────────────────────────────────────────────────────── */
  if (!isBusinessDate(windowStart) || !isBusinessDate(windowEnd)) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", "A window is two dates written YYYY-MM-DD.",
      { fields: ["windowStart", "windowEnd"] });
  }
  if (windowEnd < windowStart) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", "The window ends before it starts.",
      { fields: ["windowStart", "windowEnd"] });
  }
  if (spanDays(windowStart, windowEnd) > MAX_WINDOW_DAYS) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", `A window is at most ${MAX_WINDOW_DAYS} days.`,
      { fields: ["windowEnd"], max: MAX_WINDOW_DAYS });
  }

  /* ── THE PLAN ─────────────────────────────────────────────────────────── */
  const pf = await readPlanningFile(ctx, planningFileId);
  if (pf.state !== PLANNING_STATE.PLANNED) {
    blockers.push(blocker("PLANNING_FILE_NOT_PLANNED",
      pf.state === PLANNING_STATE.ON_HOLD
        ? "This plan is on hold. Lift the hold before booking capacity for it."
        : `Only a PLANNED plan can have capacity booked. This one is ${pf.state}.`,
      { state: pf.state }));
  }

  let health;
  try { health = await orderBook.sourceHealth(ctx, pf); } catch (err) {
    health = { undetermined: true, moved: false, movements: [], faults: [{ source: "SOURCE_HEALTH" }] };
  }
  if (health.undetermined) {
    unknowns.push(blocker("SOURCES_UNREADABLE",
      "At least one authoritative source could not be read, so this plan cannot be proved current.",
      { faults: (health.faults || []).map((f) => f.source) }));
  } else if (health.moved) {
    blockers.push(blocker("SOURCES_MOVED",
      "An authoritative source has moved since this plan was made. Create a successor plan first.",
      { movements: health.movements }));
  }

  /* ── THE DEMAND ───────────────────────────────────────────────────────── */
  const demand = await readDemand(ctx, pf);
  if (demand.state === "UNREADABLE") {
    unknowns.push(blocker("RELEASE_UNREADABLE", "The engineering release could not be read."));
  } else if (demand.state === "MISSING") {
    blockers.push(blocker("RELEASE_MISSING", "The engineering release this plan froze no longer exists."));
  } else if (demand.state === "MOVED") {
    blockers.push(blocker("RELEASE_MOVED",
      "The engineering release this plan froze has been superseded. Its figures are no longer the plan's.",
      { frozenVersionNo: demand.frozenVersionNo, currentState: demand.currentState }));
  } else if (demand.state === "UNKNOWN") {
    unknowns.push(blocker("DEMAND_UNKNOWN",
      "The release does not carry a garment SAM, an efficiency and a quantity, so demand cannot be calculated.",
      { reason: demand.reason }));
  }

  /* ── THE LINE ─────────────────────────────────────────────────────────── */
  const lineRead = await readLine(ctx, lineId);
  if (lineRead.state === "MISSING") {
    throw fail("PPC_LINE_NOT_FOUND", "No line of yours has that reference.");
  }
  if (lineRead.state === "UNREADABLE") {
    unknowns.push(blocker("LINE_UNREADABLE", "The line could not be read."));
  } else if (lineRead.state === "RETIRED") {
    blockers.push(blocker("LINE_RETIRED", "That line is retired. Choose an active line."));
  }
  const line = lineRead.line || null;

  /* ── THE CALENDAR ─────────────────────────────────────────────────────── */
  const calRead = line ? await readCalendar(ctx, line.calendarId) : { state: "MISSING" };
  if (calRead.state === "UNREADABLE") {
    unknowns.push(blocker("CALENDAR_UNREADABLE", "The line's calendar could not be read."));
  } else if (calRead.state === "PROVISIONAL") {
    blockers.push(blocker("CALENDAR_PROVISIONAL",
      "The line's calendar has only draft versions. A draft proves no hours — publish a version first."));
  } else if (calRead.state === "MISSING") {
    blockers.push(blocker("CALENDAR_MISSING", "The line has no calendar with any version."));
  }
  const version = calRead.version || null;

  /* ── THE DAYS ─────────────────────────────────────────────────────────── */
  const exclude = excludeBookingId && isId(excludeBookingId)
    ? await PpcCapacityBooking.findOne({ _id: oid(excludeBookingId), companyId: oid(ctx.companyId),
      state: BOOKING_STATE.ACTIVE }).lean()
    : null;
  const booked = line ? await readBooked(ctx, line._id, windowStart, windowEnd, exclude) : new Map();

  const required = demand.state === "KNOWN" ? demand.requiredOperatorMinutes : null;
  let remaining = required ?? 0;
  const days = [];
  const unknownDays = [];
  for (const date of eachDay(windowStart, windowEnd)) {
    const cal = version ? netMinutesOn(version, date) : { known: false, minutes: null, reason: "NO_CALENDAR", source: "NONE" };
    if (!cal.known) unknownDays.push(date);
    const capacity = cal.known && line ? cal.minutes * line.operatorCount : null;
    const already = booked.get(date) || 0;
    const free = capacity === null ? null : Math.max(0, capacity - already);
    const take = free && required !== null && remaining > 0 ? Math.min(free, remaining) : 0;
    remaining -= take;
    days.push({
      date,
      known: cal.known,
      working: cal.known ? cal.minutes > 0 : null,
      netMinutes: cal.known ? cal.minutes : null,
      calendarSource: cal.source,
      calendarReason: cal.reason || "",
      capacityOperatorMinutes: capacity,
      bookedOperatorMinutes: already,
      freeOperatorMinutes: free,
      /* Over capacity already — a calendar or headcount change shrank the day
         below what earlier bookings took. Shown, never silently absorbed. */
      overbooked: capacity !== null && already > capacity,
      allocatedOperatorMinutes: take,
    });
  }
  if (version && unknownDays.length) {
    blockers.push(blocker("CALENDAR_GAP",
      "The published calendar version does not describe every day in this window. A day it says nothing about is unknown, not closed.",
      { dates: unknownDays.slice(0, 31), count: unknownDays.length }));
  }

  const allocated = days.reduce((a, d) => a + d.allocatedOperatorMinutes, 0);
  const available = days.reduce((a, d) => a + (d.freeOperatorMinutes || 0), 0);
  const shortage = required === null ? null : Math.max(0, required - allocated);
  if (required !== null && shortage > 0) {
    blockers.push(blocker("CAPACITY_SHORTAGE",
      `The window is ${shortage.toLocaleString("en-IN")} operator-minutes short.`, { shortage }));
  }

  /* ── ANY ACTIVE BOOKING FOR THIS PLAN ALREADY? ────────────────────────── */
  const active = await PpcCapacityBooking.findOne({
    companyId: oid(ctx.companyId), planningFileId: pf._id, state: BOOKING_STATE.ACTIVE,
  }).lean();
  if (active && String(active._id) !== String(exclude?._id || "")) {
    blockers.push(blocker("ALREADY_BOOKED",
      `This plan already has an active booking (${active.bookingRef}). Replan or release it instead.`,
      { bookingRef: active.bookingRef, bookingId: String(active._id) }));
  }

  return {
    pf, line, version, calendar: calRead.calendar || null, demand, exclude, active,
    result: {
      planningFile: {
        planningFileId: String(pf._id), planningFileRef: pf.planningFileRef,
        orderLineRef: pf.orderLineRef, state: pf.state, revision: pf.revision,
      },
      line: line ? {
        lineId: String(line._id), lineRef: line.lineRef, name: line.name,
        operatorCount: line.operatorCount, revision: line.revision, status: line.status,
        factoryRef: line.factoryRef || "",
      } : null,
      calendar: {
        state: calRead.state,
        calendarId: calRead.calendar ? String(calRead.calendar._id) : null,
        calendarRef: calRead.calendar?.calendarRef || null,
        versionNo: version ? version.versionNo : null,
        validFrom: version?.validFrom || null,
        validTo: version?.validTo || null,
      },
      demand: demand.state === "KNOWN" ? {
        state: "KNOWN",
        ieReleaseRef: demand.ieReleaseRef, ieReleaseVersionNo: demand.ieReleaseVersionNo,
        confirmedQuantity: demand.confirmedQuantity,
        garmentSamMinutes: demand.garmentSamMinutes,
        efficiencyPercent: demand.efficiencyPercent,
        efficiencySource: demand.efficiencySource,
        rampStageLabel: demand.rampStageLabel,
        demandStandardMinutes: demand.demandStandardMinutes,
        requiredOperatorMinutes: demand.requiredOperatorMinutes,
        ieWorkingTimeAssumption: "EXCLUDED",
        styleOperatorCount: demand.plannedOperatorCount ?? null,
      } : { state: demand.state, reason: demand.reason || null },
      window: { start: windowStart, end: windowEnd, days: days.length },
      days,
      totals: {
        requiredOperatorMinutes: required,
        availableOperatorMinutes: version && line ? available : null,
        allocatedOperatorMinutes: allocated,
        shortageOperatorMinutes: shortage,
      },
      unknowns,
      blockers,
      /* Bookable only when there is nothing unknown AND nothing blocking. */
      bookable: unknowns.length === 0 && blockers.length === 0 && required !== null,
      /* What a booking must pin. Anything that moves between preview and book
         makes the booking refuse, naming what moved. */
      proof: {
        planningFileRevision: pf.revision,
        lineRevision: line ? line.revision : null,
        calendarVersionNo: version ? version.versionNo : null,
        ieReleaseVersionNo: demand.ieReleaseVersionNo ?? null,
      },
      booksCapacity: false,
      releasesProduction: false,
    },
  };
}

async function preview(ctx, args) {
  const { result } = await computePlan(ctx, args);
  return { preview: result };
}

/* ══ WRITING ══════════════════════════════════════════════════════════════ */

const PROOF_KEYS = ["planningFileRevision", "lineRevision", "calendarVersionNo", "ieReleaseVersionNo"];

function assertProof(expected, proof) {
  const e = expected || {};
  const missing = PROOF_KEYS.filter((k) => !Number.isInteger(Number(e[k])) || e[k] === null || e[k] === undefined);
  if (missing.length) {
    throw fail("PPC_CAPACITY_PROOF_REQUIRED",
      "Send the versions the preview showed, so a booking cannot land on inputs you did not see.",
      { fields: missing.map((k) => `expected.${k}`) });
  }
  const moved = PROOF_KEYS.filter((k) => Number(e[k]) !== proof[k]);
  if (moved.length) {
    throw fail("PPC_CAPACITY_STALE",
      "Something moved since you previewed this booking. Preview again.",
      { moved: moved.map((k) => ({ key: k, previewed: Number(e[k]), now: proof[k] })) });
  }
}

function refuseUnlessBookable(result) {
  if (result.bookable) return;
  const all = [...result.unknowns, ...result.blockers];
  const unreadable = result.unknowns.length > 0;
  throw fail(unreadable ? "PPC_CAPACITY_UNDETERMINED" : "PPC_CAPACITY_NOT_BOOKABLE",
    unreadable
      ? "An input could not be read, so this booking cannot be proved. Nothing was booked."
      : "This booking is not proved. Nothing was booked.",
    { blockers: all.map((b) => ({ code: b.code, message: b.message })) });
}

/**
 * Take each allocation's minutes on its line-day, or fail the whole booking.
 *
 * One conditional UPSERT per day, inside the booking's transaction:
 *
 *   · no counter yet for this line-day — it is inserted holding exactly these
 *     minutes (the `$lte` condition is not copied into an insert);
 *   · a counter with room — `booked + minutes ≤ capacity` matches, and the
 *     minutes are added while capacity and what it was proved against are
 *     restated;
 *   · a counter WITHOUT room — the condition fails, the upsert tries to insert
 *     a second counter for the same line-day, and the unique index refuses it.
 *     That refusal is the database saying the day is full, and it aborts the
 *     whole transaction: nothing of this booking lands on any day.
 *
 * Two first bookings of an empty day race on the insert; the loser's write
 * conflicts, the driver retries its transaction, and the retry finds the
 * winner's counter and either fits or is refused. The counter is never created
 * outside the transaction, because a row written after the transaction's
 * snapshot began is invisible inside it.
 */
async function takeMinutes(ctx, { line, version, allocations, session }) {
  for (const a of allocations) {
    const capacity = netMinutesOn(version, a.date).minutes * line.operatorCount;
    const refuse = () => fail("PPC_CAPACITY_OVERBOOKED",
      `Line ${line.lineRef} no longer has ${a.operatorMinutes.toLocaleString("en-IN")} operator-minutes free on ${a.date}. Nothing was booked — preview again.`,
      { date: a.date, lineRef: line.lineRef, requested: a.operatorMinutes, capacity });
    if (a.operatorMinutes > capacity) throw refuse();
    try {
      await PpcCapacityLineDay.findOneAndUpdate(
        {
          companyId: oid(ctx.companyId), lineId: line._id, date: a.date,
          bookedOperatorMinutes: { $lte: capacity - a.operatorMinutes },
        },
        {
          $inc: { bookedOperatorMinutes: a.operatorMinutes },
          $set: {
            capacityOperatorMinutes: capacity,
            calendarVersionNo: version.versionNo,
            lineRevision: line.revision,
          },
        },
        { new: true, upsert: true, session },
      );
    } catch (err) {
      if (err?.code === 11000) throw refuse();
      throw err;
    }
  }
}

/**
 * Fence the line and the calendar this booking was proved against.
 *
 * A conditional write to each, pinned to the revision the proof read, inside the
 * booking's transaction. Two things follow. If either has ALREADY moved, the
 * filter misses and the booking is refused as stale. And if an owner's edit or
 * publish is in flight at the same moment, both transactions now write the same
 * document, so the database serialises them: whichever commits second is
 * retried, re-reads, and sees the other. Without this, a headcount change or a
 * republished calendar could commit in the gap between a booking's proof and
 * its commit, and the booking would land on figures that no longer existed.
 *
 * The planning file is fenced the same way, through the one write its model
 * permits a capacity command: `$inc: { bookingFence: 1 }` matched on its exact
 * id, company, the revision the proof read and PLANNED. A hold, successor or
 * cancellation that committed after the proof makes the filter miss; one still
 * in flight writes the same document and the database serialises the two. The
 * plan's business revision, history and timestamps are not touched.
 */
async function fence(ctx, { planningFile, line, calendar, session }) {
  const planHeld = await fencePlannedFileForBooking({
    companyId: ctx.companyId, planningFileId: planningFile._id, revision: planningFile.revision,
  }, session);
  if (!planHeld) {
    throw fail("PPC_CAPACITY_STALE",
      "The plan was held, replaced or changed while this booking was being made. Preview again.",
      { moved: [{ key: "planningFileRevision", previewed: planningFile.revision, now: null }] });
  }
  const lineHeld = await PpcCapacityLine.findOneAndUpdate(
    { _id: line._id, companyId: oid(ctx.companyId), revision: line.revision, status: LINE_STATUS.ACTIVE },
    { $inc: { bookingFence: 1 } },
    { session },
  );
  if (!lineHeld) {
    throw fail("PPC_CAPACITY_STALE", "The line changed while this booking was being made. Preview again.",
      { moved: [{ key: "lineRevision", previewed: line.revision, now: null }] });
  }
  const calHeld = await PpcCapacityCalendar.findOneAndUpdate(
    { _id: calendar._id, companyId: oid(ctx.companyId), revision: calendar.revision },
    { $inc: { bookingFence: 1 } },
    { session },
  );
  if (!calHeld) {
    throw fail("PPC_CAPACITY_STALE", "The calendar was republished while this booking was being made. Preview again.",
      { moved: [{ key: "calendarVersionNo", previewed: null, now: null }] });
  }
}

/** Give a booking's minutes back. Matches only while the day still holds them. */
async function returnMinutes(ctx, { booking, session }) {
  for (const a of booking.allocations || []) {
    const back = await PpcCapacityLineDay.findOneAndUpdate(
      {
        companyId: oid(ctx.companyId), lineId: booking.lineId, date: a.date,
        bookedOperatorMinutes: { $gte: a.operatorMinutes },
      },
      { $inc: { bookedOperatorMinutes: -a.operatorMinutes } },
      { new: true, session },
    );
    if (!back) {
      /* The counter holds less than this booking says it took — the two records
         disagree, and pretending otherwise would hide the disagreement. */
      throw fail("PPC_CAPACITY_LEDGER_MISMATCH",
        "The line's booked minutes do not match this booking. Nothing was changed.",
        { date: a.date, bookingRef: booking.bookingRef });
    }
  }
}

const bookingRefFor = (companyId, planningFileId, generation) => `PPCBK-${crypto.createHash("sha256")
  .update(`${companyId}:${planningFileId}:${generation}`).digest("hex").slice(0, 10).toUpperCase()}`;

function bookingOut(b) {
  return {
    bookingId: String(b._id),
    bookingRef: b.bookingRef,
    state: b.state,
    generation: b.generation,
    planningFileId: String(b.planningFileId),
    planningFileRef: b.planningFileRef,
    planningFileRevision: b.planningFileRevision,
    orderLineRef: b.orderLineRef,
    lineId: String(b.lineId),
    lineRef: b.lineRef,
    lineRevision: b.lineRevision,
    lineOperatorCount: b.lineOperatorCount,
    calendarRef: b.calendarRef,
    calendarVersionNo: b.calendarVersionNo,
    basis: {
      ieReleaseRef: b.basis.ieReleaseRef,
      ieReleaseVersionNo: b.basis.ieReleaseVersionNo,
      confirmedQuantity: b.basis.confirmedQuantity,
      garmentSamMinutes: b.basis.garmentSamMinutes,
      efficiencyPercent: b.basis.efficiencyPercent,
      efficiencySource: b.basis.efficiencySource,
      demandStandardMinutes: b.basis.demandStandardMinutes,
      requiredOperatorMinutes: b.basis.requiredOperatorMinutes,
    },
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    allocations: (b.allocations || []).map((a) => ({ date: a.date, operatorMinutes: a.operatorMinutes })),
    bookedOperatorMinutes: b.bookedOperatorMinutes,
    releaseReason: b.releaseReason || null,
    releaseNote: b.releaseNote || "",
    releasedAt: b.releasedAt ? new Date(b.releasedAt).toISOString() : null,
    releasedBy: b.releasedBy?.name || null,
    supersedesBookingRef: b.supersedesBookingRef || null,
    supersededByBookingRef: b.supersededByBookingRef || null,
    revision: b.revision,
    history: (b.history || []).map((e) => ({
      type: e.type, at: e.at ? new Date(e.at).toISOString() : null,
      actorName: e.actorName || "", fromState: e.fromState || null, toState: e.toState || null,
      reason: e.reason || "",
    })),
    createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
    booksCapacity: b.state === BOOKING_STATE.ACTIVE,
    releasesProduction: false,
    createsWorkOrder: false,
  };
}

function bookingSeed({ ctx, plan, who, generation, windowStart, windowEnd, supersedes = null, reason = "" }) {
  const { pf, line, version, calendar, demand, result } = plan;
  const allocations = result.days
    .filter((d) => d.allocatedOperatorMinutes > 0)
    .map((d) => ({ date: d.date, operatorMinutes: d.allocatedOperatorMinutes }));
  return {
    allocations,
    doc: {
      companyId: oid(ctx.companyId),
      bookingRef: bookingRefFor(ctx.companyId, String(pf._id), generation),
      planningFileId: pf._id,
      planningFileRef: pf.planningFileRef,
      planningFileRevision: pf.revision,
      orderLineRef: pf.orderLineRef,
      lineId: line._id, lineRef: line.lineRef, lineRevision: line.revision,
      lineOperatorCount: line.operatorCount,
      calendarId: calendar._id, calendarRef: calendar.calendarRef, calendarVersionNo: version.versionNo,
      basis: {
        ieReleaseId: oid(demand.ieReleaseId), ieReleaseRef: demand.ieReleaseRef,
        ieReleaseVersionNo: demand.ieReleaseVersionNo,
        confirmedQuantity: demand.confirmedQuantity, garmentSamMinutes: demand.garmentSamMinutes,
        efficiencyPercent: demand.efficiencyPercent, efficiencySource: demand.efficiencySource,
        demandStandardMinutes: demand.demandStandardMinutes,
        requiredOperatorMinutes: demand.requiredOperatorMinutes,
      },
      windowStart, windowEnd, allocations,
      bookedOperatorMinutes: allocations.reduce((a, x) => a + x.operatorMinutes, 0),
      state: BOOKING_STATE.ACTIVE,
      generation,
      supersedesBookingId: supersedes?._id || null,
      supersedesBookingRef: supersedes?.bookingRef || "",
      history: [{
        type: supersedes ? "BOOKING_REPLANNED" : "BOOKING_CREATED", at: new Date(),
        actorName: who.name, toState: BOOKING_STATE.ACTIVE, reason,
      }],
      createdBy: who,
    },
  };
}

const bookRequest = (body) => ({
  planningFileId: str(body.planningFileId), lineId: str(body.lineId),
  windowStart: str(body.windowStart), windowEnd: str(body.windowEnd),
  expected: Object.fromEntries(PROOF_KEYS.map((k) => [k, Number(body.expected?.[k] ?? NaN)])),
});

const BOOK_FIELDS = ["planningFileId", "lineId", "windowStart", "windowEnd", "expected"];
function refuseUnknown(body, allowed) {
  const unknown = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("PPC_CAPACITY_FIELD_UNKNOWN",
      "A booking takes a plan, a line, a window and the versions you previewed — nothing else. Allocations and capacity are the server's to compute.",
      { fields: unknown, allowed: [...allowed] });
  }
}

/* ══ BOOK ═════════════════════════════════════════════════════════════════ */

async function book(ctx, { body = {}, actor, idempotencyKey } = {}) {
  assertContext(ctx);
  const who = person(actor);
  refuseUnknown(body, BOOK_FIELDS);
  const request = bookRequest(body);

  return planningCommand(ctx, {
    scope: `ppc:capacity:plan:${request.planningFileId}`,
    command: "CAPACITY_BOOKED",
    idempotencyKey,
    request: { command: "book", ...request },
  }, async (session) => {
    const plan = await computePlan(ctx, request);
    /* Bookability FIRST: an input that is missing, provisional or unreadable
       is the answer a planner needs, and it must not be reported as "send the
       versions you previewed" or as "stale" just because the missing input has
       no version to compare. Only a bookable plan is then checked against what
       was previewed. */
    refuseUnlessBookable(plan.result);
    assertProof(request.expected, plan.result.proof);

    const generation = (await PpcCapacityBooking.countDocuments({
      companyId: oid(ctx.companyId), planningFileId: plan.pf._id,
    }).session(session)) + 1;
    const { doc, allocations } = bookingSeed({
      ctx, plan, who, generation, windowStart: request.windowStart, windowEnd: request.windowEnd,
    });
    await fence(ctx, { planningFile: plan.pf, line: plan.line, calendar: plan.calendar, session });
    await takeMinutes(ctx, { line: plan.line, version: plan.version, allocations, session });
    try {
      const [created] = await PpcCapacityBooking.create([doc], { session });
      return {
        booking: bookingOut(created.toObject()),
        planningFile: { planningFileId: String(plan.pf._id) },
      };
    } catch (err) {
      if (err?.code === 11000) {
        throw fail("PPC_CAPACITY_ALREADY_BOOKED",
          "Another booking for this plan landed first. Nothing was booked by this request.");
      }
      throw err;
    }
  });
}

/* ══ RELEASE ══════════════════════════════════════════════════════════════ */

function releaseReason(body) {
  const reason = str(body.reason).toUpperCase();
  if (!RELEASE_REASON.includes(reason)) {
    throw fail("PPC_CAPACITY_REASON_INVALID", "Give one of PPC's release reasons.",
      { field: "reason", allowed: [...RELEASE_REASON] });
  }
  const note = str(body.note);
  if (note.length > 2000) throw fail("PPC_CAPACITY_REASON_INVALID", "The note is too long.", { field: "note" });
  if (reason === "OTHER" && note.length < 15) {
    throw fail("PPC_CAPACITY_REASON_INVALID", "For OTHER, say in at least 15 characters why.", { field: "note" });
  }
  return { reason, note };
}

async function loadBooking(ctx, bookingId) {
  assertContext(ctx);
  if (!isId(bookingId)) throw fail("PPC_CAPACITY_BOOKING_NOT_FOUND", "No booking of yours has that reference.");
  const b = await PpcCapacityBooking.findOne({ _id: oid(bookingId), companyId: oid(ctx.companyId) }).lean();
  if (!b) throw fail("PPC_CAPACITY_BOOKING_NOT_FOUND", "No booking of yours has that reference.");
  return b;
}

const expectRev = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw fail("PPC_EXPECTED_REVISION_REQUIRED", "Send the revision you read.", { field: "expectedRevision" });
  return n;
};

async function release(ctx, { bookingId, body = {}, actor, idempotencyKey } = {}) {
  const who = person(actor);
  const expected = expectRev(body.expectedRevision);
  const { reason, note } = releaseReason(body);
  const booking = await loadBooking(ctx, bookingId);

  return planningCommand(ctx, {
    scope: `ppc:capacity:booking:${String(booking._id)}`,
    command: "CAPACITY_RELEASED",
    idempotencyKey,
    request: { command: "release", bookingId: String(booking._id), expectedRevision: expected, reason, note },
  }, async (session) => {
    if (booking.state !== BOOKING_STATE.ACTIVE) {
      throw fail("PPC_CAPACITY_BOOKING_CLOSED", `This booking is ${booking.state} and holds no capacity.`,
        { state: booking.state });
    }
    const now = new Date();
    const released = await PpcCapacityBooking.findOneAndUpdate(
      { _id: booking._id, companyId: booking.companyId, state: BOOKING_STATE.ACTIVE, revision: expected },
      {
        $set: {
          state: BOOKING_STATE.RELEASED, releaseReason: reason, releaseNote: note,
          releasedAt: now, releasedBy: who, revision: expected + 1,
        },
        $push: { history: { $each: [{ type: "BOOKING_RELEASED", at: now, actorName: who.name,
          fromState: BOOKING_STATE.ACTIVE, toState: BOOKING_STATE.RELEASED,
          reason: note ? `${reason}: ${note}` : reason }], $slice: -200 } },
      },
      { new: true, lean: true, session },
    );
    if (!released) {
      throw fail("PPC_CAPACITY_REVISION_STALE", "This booking changed while you were deciding. Re-read it.",
        { expectedRevision: expected });
    }
    await returnMinutes(ctx, { booking, session });
    return {
      booking: bookingOut(released),
      planningFile: { planningFileId: String(booking.planningFileId) },
    };
  });
}

/* ══ REPLAN — AN AUDITABLE SUCCESSOR, NEVER AN EDIT ══════════════════════ */

async function replan(ctx, { bookingId, body = {}, actor, idempotencyKey } = {}) {
  const who = person(actor);
  const { expectedRevision, reason, ...rest } = body;
  const expected = expectRev(expectedRevision);
  const why = str(reason);
  if (why.length < 15) {
    throw fail("PPC_CAPACITY_REASON_INVALID",
      "Say in at least 15 characters why this booking is being replanned.", { field: "reason" });
  }
  refuseUnknown(rest, ["lineId", "windowStart", "windowEnd", "expected"]);
  const old = await loadBooking(ctx, bookingId);
  const request = bookRequest({ ...rest, planningFileId: String(old.planningFileId) });

  return planningCommand(ctx, {
    scope: `ppc:capacity:booking:${String(old._id)}`,
    command: "CAPACITY_REPLANNED",
    idempotencyKey,
    request: { command: "replan", bookingId: String(old._id), expectedRevision: expected, reason: why, ...request },
  }, async (session) => {
    if (old.state !== BOOKING_STATE.ACTIVE) {
      throw fail("PPC_CAPACITY_BOOKING_CLOSED", `This booking is ${old.state}; there is nothing to replan.`,
        { state: old.state });
    }
    /* Proved exactly as a new booking is, with the old booking's own minutes
       counted as free — it is giving them back in this same transaction. */
    const plan = await computePlan(ctx, { ...request, excludeBookingId: String(old._id) });
    /* Bookability FIRST: an input that is missing, provisional or unreadable
       is the answer a planner needs, and it must not be reported as "send the
       versions you previewed" or as "stale" just because the missing input has
       no version to compare. Only a bookable plan is then checked against what
       was previewed. */
    refuseUnlessBookable(plan.result);
    assertProof(request.expected, plan.result.proof);

    const now = new Date();
    const generation = (await PpcCapacityBooking.countDocuments({
      companyId: oid(ctx.companyId), planningFileId: old.planningFileId,
    }).session(session)) + 1;
    const { doc, allocations } = bookingSeed({
      ctx, plan, who, generation, windowStart: request.windowStart, windowEnd: request.windowEnd,
      supersedes: old, reason: why,
    });
    const newId = new mongoose.Types.ObjectId();
    doc._id = newId;

    /* Retire the old one FIRST, so the one-active index admits its successor. */
    const retired = await PpcCapacityBooking.findOneAndUpdate(
      { _id: old._id, companyId: old.companyId, state: BOOKING_STATE.ACTIVE, revision: expected },
      {
        $set: {
          state: BOOKING_STATE.SUPERSEDED, supersededByBookingId: newId,
          supersededByBookingRef: doc.bookingRef, revision: expected + 1,
        },
        $push: { history: { $each: [{ type: "BOOKING_SUPERSEDED", at: now, actorName: who.name,
          fromState: BOOKING_STATE.ACTIVE, toState: BOOKING_STATE.SUPERSEDED, reason: why }], $slice: -200 } },
      },
      { new: true, lean: true, session },
    );
    if (!retired) {
      throw fail("PPC_CAPACITY_REVISION_STALE", "This booking changed while you were replanning it. Re-read it.",
        { expectedRevision: expected });
    }
    await returnMinutes(ctx, { booking: old, session });
    await fence(ctx, { planningFile: plan.pf, line: plan.line, calendar: plan.calendar, session });
    await takeMinutes(ctx, { line: plan.line, version: plan.version, allocations, session });
    const [created] = await PpcCapacityBooking.create([doc], { session });
    return {
      booking: bookingOut(created.toObject()),
      supersededBooking: bookingOut(retired),
      planningFile: { planningFileId: String(old.planningFileId) },
    };
  });
}

/* ══ READING BOOKINGS AND LOAD ════════════════════════════════════════════ */

/**
 * A booking and what has moved under it since it was made.
 *
 * Never rewritten: a calendar republished, a headcount changed, a plan held or
 * replaced, a release superseded — each is REPORTED here, and the remedy is a
 * release or a replan a person decides on.
 */
async function bookingHealth(ctx, b) {
  const movements = [];
  let undetermined = false;
  try {
    const line = await PpcCapacityLine.findOne({ _id: b.lineId, companyId: b.companyId }).lean();
    if (!line) movements.push({ key: "line", message: "The line no longer exists." });
    else {
      if (line.revision !== b.lineRevision) movements.push({ key: "line", message: `Line ${line.lineRef} changed (revision ${b.lineRevision} → ${line.revision}).` });
      if (line.status !== LINE_STATUS.ACTIVE) movements.push({ key: "line", message: "The line is retired." });
    }
    const cal = await PpcCapacityCalendarVersion.findOne({ companyId: b.companyId, calendarId: b.calendarId,
      state: VERSION_STATE.PUBLISHED }).lean();
    if (!cal) movements.push({ key: "calendar", message: "The calendar has no published version now." });
    else if (cal.versionNo !== b.calendarVersionNo) {
      movements.push({ key: "calendar", message: `The calendar was republished (v${b.calendarVersionNo} → v${cal.versionNo}).` });
    }
    const pf = await PpcPlanningFile.findOne({ _id: b.planningFileId, companyId: b.companyId }).lean();
    if (!pf) movements.push({ key: "planningFile", message: "The plan no longer exists." });
    else if (pf.state !== PLANNING_STATE.PLANNED || pf.revision !== b.planningFileRevision) {
      movements.push({ key: "planningFile", message: `The plan is now ${pf.state} at revision ${pf.revision}.` });
    }
    const eng = await ie.publishReleaseEngineering(ctx, String(b.basis.ieReleaseId));
    if (!eng || eng.versionNo !== b.basis.ieReleaseVersionNo || eng.state !== "ISSUED") {
      movements.push({ key: "ieRelease", message: "The engineering release has moved." });
    }
  } catch (err) {
    undetermined = true;
  }
  return { moved: movements.length > 0, movements, undetermined };
}

async function listBookings(ctx, { state, planningFileId, lineId, limit = 50 } = {}) {
  assertContext(ctx);
  const q = { companyId: oid(ctx.companyId) };
  if (state) {
    const s = str(state).toUpperCase();
    if (!Object.values(BOOKING_STATE).includes(s)) {
      throw fail("PPC_CAPACITY_INPUT_INVALID", "Unknown booking state.", { allowed: Object.values(BOOKING_STATE) });
    }
    q.state = s;
  }
  if (planningFileId) { if (!isId(planningFileId)) return { bookings: [] }; q.planningFileId = oid(planningFileId); }
  if (lineId) { if (!isId(lineId)) return { bookings: [] }; q.lineId = oid(lineId); }
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = await PpcCapacityBooking.find(q).sort({ _id: -1 }).limit(size).lean();
  const out = [];
  for (const b of rows) {
    const health = b.state === BOOKING_STATE.ACTIVE ? await bookingHealth(ctx, b) : null;
    out.push({ ...bookingOut(b), health });
  }
  return { bookings: out };
}

async function getBooking(ctx, bookingId) {
  const b = await loadBooking(ctx, bookingId);
  const health = b.state === BOOKING_STATE.ACTIVE ? await bookingHealth(ctx, b) : null;
  return { booking: { ...bookingOut(b), health } };
}

/** A line's load by day: capacity from the calendar, booked from the counters. */
async function lineLoad(ctx, { lineId, from, to } = {}) {
  assertContext(ctx);
  if (!isBusinessDate(from) || !isBusinessDate(to) || to < from || spanDays(from, to) > MAX_WINDOW_DAYS) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", `Give a window of up to ${MAX_WINDOW_DAYS} days as YYYY-MM-DD.`,
      { fields: ["from", "to"] });
  }
  const lr = await readLine(ctx, lineId);
  if (lr.state === "MISSING") throw fail("PPC_LINE_NOT_FOUND", "No line of yours has that reference.");
  const line = lr.line;
  const cal = await readCalendar(ctx, line.calendarId);
  const booked = await readBooked(ctx, line._id, from, to, null);
  const days = [];
  for (const date of eachDay(from, to)) {
    const c = cal.version ? netMinutesOn(cal.version, date) : { known: false, minutes: null, source: "NONE", reason: "" };
    const capacity = c.known ? c.minutes * line.operatorCount : null;
    const b = booked.get(date) || 0;
    days.push({
      date, known: c.known, netMinutes: c.known ? c.minutes : null,
      calendarSource: c.source, calendarReason: c.reason || "",
      capacityOperatorMinutes: capacity, bookedOperatorMinutes: b,
      freeOperatorMinutes: capacity === null ? null : Math.max(0, capacity - b),
      overbooked: capacity !== null && b > capacity,
    });
  }
  return {
    line: { lineId: String(line._id), lineRef: line.lineRef, operatorCount: line.operatorCount,
      revision: line.revision, status: line.status },
    calendar: { state: cal.state, versionNo: cal.version?.versionNo ?? null,
      calendarRef: cal.calendar?.calendarRef || null },
    days,
  };
}

module.exports = {
  MAX_WINDOW_DAYS, PROOF_KEYS,
  preview, book, release, replan,
  listBookings, getBooking, lineLoad,
  computePlan, bookingOut,
  /* Read by the stage-publication command, which may not publish a sewing
     target against a booking something has moved under. It reports; the
     remedy is still a release or a replan a person decides on, here. */
  bookingHealth,
};
