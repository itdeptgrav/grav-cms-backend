// services/production/cuttingResource.service.js
//
// CUTTING'S OWN RESOURCES — AUTHORED, PUBLISHED AND PUBLISHED *TO* PPC.
//
// The cutting room says what it has: which tables and knives, on which days,
// for how many minutes, with how many people in which roles, and how well it
// really runs. Cutting editors author a draft and publish a version; Cutting
// viewers read; PPC reads the published projection at the bottom of this file
// and nothing else.
//
// ── THE SEAM ────────────────────────────────────────────────────────────────
// `publishResourcesForPlanning` is the whole of PPC's access. It returns
// identity, working time and crew — no draft, no note history, no actor
// trail, no unpublished version — and it is a READ. There is no function here
// that lets a planning department change a roster, and there is deliberately
// no route that would.
//
// ── AND WHAT CUTTING DOES NOT OWN ───────────────────────────────────────────
// The minutes a piece takes are Industrial Engineering's, frozen in the
// approved release. Nothing in this file states, edits or overrides one: a
// resource says how much time is available, never how much work there is.
"use strict";

const mongoose = require("mongoose");

const {
  CuttingResource, RESOURCE_STATE, RESOURCE_TYPES, LIMITS,
} = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingResource");
const { CREW_ROLES } = require("../../models/CMS_Models/IndustrialEngineering/processRoute.schema");
const { sumShifts, weekdayIndex } = require("../ppc/capacityCalendar");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const isBusinessDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

const RESOURCE_FIELDS = Object.freeze([
  "resourceRef", "name", "siteRef", "resourceType", "timezone", "isActive",
  "effectiveFrom", "effectiveTo", "weekPattern", "exceptions", "crew",
  "operationalEfficiencyPercent", "note",
]);

/* Facts somebody will try to put on a resource, refused by name with where
   they actually live. A resource says what Cutting HAS; it never says what
   the work is, when it is due, or who it is for. */
const REFUSED = Object.freeze({
  standardMinutesPerPiece: "an engineering standard, which Industrial Engineering owns and freezes in its release",
  setupMinutesPerOrder: "an engineering standard, which Industrial Engineering owns",
  capacityModel: "an engineering standard's crew assumptions, which Industrial Engineering owns",
  sam: "a standard minute value, which Industrial Engineering owns",
  planningFileId: "a plan, which PPC owns",
  orderLineRef: "an order line. A resource is not booked to one here",
  workOrderId: "a work order, which Production owns",
  plannedStart: "a date, which Planning decides",
  plannedEnd: "a date, which Planning decides",
  bookedMinutes: "a booking. This slice reserves nothing",
  quantity: "a quantity, which the confirmed order line carries",
  companyId: "the company — that comes from your own membership",
  versionNo: "a version number, which the server mints on publish",
  state: "a lifecycle state, which publishing and retiring decide",
  publishedBy: "who published it — the server records that from your session",
  publishedAt: "when it was published — the server records that",
});

const invalid = (message, fieldErrors) => fail("CUTTING_RESOURCE_INVALID", message, {
  field: fieldErrors[0]?.field || "resource", fieldErrors,
});

/* ══ SHAPE ════════════════════════════════════════════════════════════════ */

function shapeShifts(list, at, errs) {
  if (!Array.isArray(list)) {
    errs.push({ field: at, code: "INVALID", message: "Shifts are a list." });
    return [];
  }
  if (list.length > LIMITS.SHIFTS_PER_DAY) {
    errs.push({ field: at, code: "TOO_MANY", message: `At most ${LIMITS.SHIFTS_PER_DAY} shifts a day.` });
    return [];
  }
  return list.map((s, i) => {
    const where = `${at}.${i}`;
    const shift = {
      shiftKey: str(s?.shiftKey) || `S${i + 1}`,
      start: str(s?.start), end: str(s?.end),
      breakMinutes: s?.breakMinutes,
    };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.start)) {
      errs.push({ field: `${where}.start`, code: "INVALID", message: "A time is written HH:MM." });
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.end)) {
      errs.push({ field: `${where}.end`, code: "INVALID", message: "A time is written HH:MM." });
    }
    if (typeof shift.breakMinutes !== "number" || !Number.isFinite(shift.breakMinutes)
      || shift.breakMinutes < 0 || shift.breakMinutes > 600) {
      errs.push({ field: `${where}.breakMinutes`, code: "INVALID", message: "Break minutes are 0–600." });
    }
    return shift;
  });
}

/**
 * The body a caller sent, as a resource version this may store — or a refusal
 * naming every problem at once.
 */
function shapeResource(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("A resource is an object.", [{ field: "resource", code: "INVALID", message: "A resource is an object." }]);
  }
  for (const field of Object.keys(body)) {
    if (field === "expectedRevision") continue;
    const refused = REFUSED[field];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A cutting resource cannot carry ${refused}.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${field}" is not accepted.` }] });
    }
    if (!RESOURCE_FIELDS.includes(field)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a cutting resource.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${field}" is not accepted.` }] });
    }
  }

  const errs = [];
  const bad = (field, code, message) => { errs.push({ field, code, message }); };

  const resourceRef = str(body.resourceRef);
  if (!resourceRef || resourceRef.length > 60) {
    bad("resourceRef", "REQUIRED", "Give this table or knife its own permanent reference.");
  }
  const name = str(body.name);
  if (!name || name.length > LIMITS.NAME) bad("name", "REQUIRED", "Name it as the floor calls it.");
  const siteRef = str(body.siteRef);
  if (!siteRef || siteRef.length > LIMITS.SITE) bad("siteRef", "REQUIRED", "Say which site it is at.");
  const timezone = str(body.timezone);
  if (!timezone) bad("timezone", "REQUIRED", "Say which timezone its days are counted in.");

  const resourceType = str(body.resourceType).toUpperCase();
  if (!RESOURCE_TYPES.includes(resourceType)) {
    bad("resourceType", "INVALID", `Choose the type: ${RESOURCE_TYPES.join(", ")}.`);
  }

  const effectiveFrom = str(body.effectiveFrom);
  if (!isBusinessDate(effectiveFrom)) bad("effectiveFrom", "REQUIRED", "A date is written YYYY-MM-DD.");
  const effectiveTo = body.effectiveTo === null || body.effectiveTo === undefined ? null : str(body.effectiveTo);
  if (effectiveTo !== null && !isBusinessDate(effectiveTo)) {
    bad("effectiveTo", "INVALID", "A date is written YYYY-MM-DD, or leave it open.");
  }
  if (effectiveTo && isBusinessDate(effectiveFrom) && effectiveTo < effectiveFrom) {
    bad("effectiveTo", "OUT_OF_RANGE", "The end of the period cannot be before its start.");
  }

  /* ── THE WEEK ────────────────────────────────────────────────────── */
  let weekPattern = [];
  if (!Array.isArray(body.weekPattern) || body.weekPattern.length !== 7) {
    bad("weekPattern", "REQUIRED", "A week pattern has seven days, Monday first.");
  } else {
    weekPattern = body.weekPattern.map((d, i) => {
      const working = d?.working === true;
      const shifts = working ? shapeShifts(d?.shifts || [], `weekPattern.${i}.shifts`, errs) : [];
      if (working && !shifts.length) {
        bad(`weekPattern.${i}.shifts`, "REQUIRED", "A working day has at least one shift.");
      }
      if (!working && Array.isArray(d?.shifts) && d.shifts.length) {
        bad(`weekPattern.${i}.shifts`, "NOT_ACCEPTED", "A non-working day carries no shifts.");
      }
      return { working, shifts };
    });
    if (!weekPattern.some((d) => d.working)) {
      bad("weekPattern", "INVALID", "At least one day of the week is worked.");
    }
  }

  /* ── THE DAYS THAT ARE NOT THE WEEK ──────────────────────────────── */
  let exceptions = [];
  if (body.exceptions !== undefined) {
    if (!Array.isArray(body.exceptions) || body.exceptions.length > LIMITS.EXCEPTIONS) {
      bad("exceptions", "INVALID", `A list of at most ${LIMITS.EXCEPTIONS} dated exceptions.`);
    } else {
      const seen = new Set();
      exceptions = body.exceptions.map((e, i) => {
        const date = str(e?.date);
        const kind = str(e?.kind).toUpperCase();
        if (!isBusinessDate(date)) bad(`exceptions.${i}.date`, "INVALID", "A date is written YYYY-MM-DD.");
        if (seen.has(date)) bad(`exceptions.${i}.date`, "DUPLICATE", "That date already has an exception.");
        seen.add(date);
        if (!["WORKING_DAY", "HOLIDAY", "DOWNTIME"].includes(kind)) {
          bad(`exceptions.${i}.kind`, "INVALID", "An exception is a WORKING_DAY, a HOLIDAY or planned DOWNTIME.");
        }
        const shifts = kind === "WORKING_DAY"
          ? shapeShifts(e?.shifts || [], `exceptions.${i}.shifts`, errs) : [];
        if (kind === "WORKING_DAY" && !shifts.length) {
          bad(`exceptions.${i}.shifts`, "REQUIRED", "A make-up working day states its own shifts.");
        }
        if (kind !== "WORKING_DAY" && Array.isArray(e?.shifts) && e.shifts.length) {
          bad(`exceptions.${i}.shifts`, "NOT_ACCEPTED", "A holiday or downtime day carries no shifts.");
        }
        return { date, kind, shifts, reason: str(e?.reason).slice(0, LIMITS.REASON) };
      });
    }
  }

  /* ── THE PEOPLE ──────────────────────────────────────────────────── */
  let crew = [];
  if (!Array.isArray(body.crew) || !body.crew.length) {
    bad("crew", "REQUIRED", "Say who is on this resource, by role.");
  } else if (body.crew.length > LIMITS.ROLES) {
    bad("crew", "TOO_MANY", `At most ${LIMITS.ROLES} roles.`);
  } else {
    const seen = new Set();
    crew = body.crew.map((c, i) => {
      const role = str(c?.role).toUpperCase();
      if (!CREW_ROLES.includes(role)) {
        bad(`crew.${i}.role`, "INVALID", `Choose a role: ${CREW_ROLES.join(", ")}.`);
      } else if (seen.has(role)) {
        bad(`crew.${i}.role`, "DUPLICATE", "That role already has a count.");
      }
      seen.add(role);
      const count = c?.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > LIMITS.MAX_CREW) {
        bad(`crew.${i}.count`, "INVALID", `A whole number of people, 0–${LIMITS.MAX_CREW}.`);
      }
      return { role, count };
    });
  }

  const eff = body.operationalEfficiencyPercent;
  if (typeof eff !== "number" || !Number.isFinite(eff)
    || eff < LIMITS.MIN_EFFICIENCY || eff > LIMITS.MAX_EFFICIENCY) {
    bad("operationalEfficiencyPercent", "OUT_OF_RANGE",
      `How well this resource actually runs, ${LIMITS.MIN_EFFICIENCY}–${LIMITS.MAX_EFFICIENCY}%. `
      + "This is Cutting's own observation, not Industrial Engineering's standard.");
  }

  if (errs.length) throw invalid("Some of this resource needs fixing.", errs);

  return {
    resourceRef, name, siteRef, resourceType, timezone,
    isActive: body.isActive === undefined ? true : body.isActive === true,
    effectiveFrom, effectiveTo, weekPattern, exceptions, crew,
    operationalEfficiencyPercent: eff,
    note: str(body.note).slice(0, LIMITS.NOTE),
  };
}

/* ══ CUTTING'S OWN COMMANDS ═══════════════════════════════════════════════ */

const person = (actor) => ({
  id: isId(actor?.id) ? oid(actor.id) : undefined,
  name: str(actor?.name || actor?.email),
});

/** Draft a new version of a resource — or the first one. */
async function saveDraft(companyId, { body = {}, actor } = {}) {
  if (!isId(companyId)) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  const shaped = shapeResource(body);

  const existing = await CuttingResource.findOne({
    companyId: oid(companyId), resourceRef: shaped.resourceRef, state: RESOURCE_STATE.DRAFT,
  });
  if (existing) {
    Object.assign(existing, shaped);
    existing.updatedBy = person(actor);
    existing.revision += 1;
    await existing.save();
    return { resource: resourceOut(existing.toObject()) };
  }
  const [highest] = await CuttingResource.find({
    companyId: oid(companyId), resourceRef: shaped.resourceRef,
  }).sort({ versionNo: -1 }).limit(1).lean();

  const doc = await CuttingResource.create({
    ...shaped,
    companyId: oid(companyId),
    versionNo: (highest?.versionNo || 0) + 1,
    state: RESOURCE_STATE.DRAFT,
    createdBy: person(actor), updatedBy: person(actor), revision: 1,
  });
  return { resource: resourceOut(doc.toObject()) };
}

/**
 * Publish the draft. The version in force steps down first, so the partial
 * unique index is satisfied at every point and two publishers cannot both
 * win.
 */
async function publish(companyId, resourceRef, { actor } = {}) {
  if (!isId(companyId)) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "Your identity could not be resolved.");
  const ref = str(resourceRef);
  const draft = await CuttingResource.findOne({
    companyId: oid(companyId), resourceRef: ref, state: RESOURCE_STATE.DRAFT,
  });
  if (!draft) throw fail("CUTTING_RESOURCE_NOT_FOUND", "No draft of that cutting resource is yours to publish.");

  const current = await CuttingResource.findOne({
    companyId: oid(companyId), resourceRef: ref, state: RESOURCE_STATE.PUBLISHED,
  });
  if (current) {
    current.$locals.wasPublished = true;
    current.state = RESOURCE_STATE.SUPERSEDED;
    current.supersededByVersionNo = draft.versionNo;
    await current.save();
  }
  draft.state = RESOURCE_STATE.PUBLISHED;
  draft.publishedBy = person(actor);
  draft.publishedAt = new Date();
  draft.revision += 1;
  await draft.save();
  return { resource: resourceOut(draft.toObject()), supersededVersionNo: current?.versionNo ?? null };
}

/** Withdraw the published version: it exists, and is not to be planned against. */
async function retire(companyId, resourceRef, { reason, actor } = {}) {
  if (!isId(companyId)) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const note = str(reason).replace(/\s+/g, " ");
  if (note.length < 10) {
    throw fail("CUTTING_RESOURCE_REASON_REQUIRED",
      "Say why this resource is being withdrawn — a plan previewed against it will show the reason.",
      { field: "reason" });
  }
  const doc = await CuttingResource.findOne({
    companyId: oid(companyId), resourceRef: str(resourceRef), state: RESOURCE_STATE.PUBLISHED,
  });
  if (!doc) throw fail("CUTTING_RESOURCE_NOT_FOUND", "No published cutting resource of yours has that reference.");
  doc.$locals.wasPublished = true;
  doc.state = RESOURCE_STATE.RETIRED;
  doc.retiredReason = note.slice(0, LIMITS.REASON);
  doc.updatedBy = person(actor);
  doc.revision += 1;
  await doc.save();
  return { resource: resourceOut(doc.toObject()) };
}

/** Every version of every resource in this company — Cutting's own screen. */
async function listForCutting(companyId, { resourceRef } = {}) {
  if (!isId(companyId)) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  const q = { companyId: oid(companyId) };
  if (str(resourceRef)) q.resourceRef = str(resourceRef);
  const rows = await CuttingResource.find(q).sort({ resourceRef: 1, versionNo: -1 }).lean();
  return { resources: rows.map(resourceOut) };
}

/** One version, as Cutting's own screens read it. */
function resourceOut(doc) {
  return {
    resourceId: String(doc._id),
    resourceRef: str(doc.resourceRef),
    name: str(doc.name),
    siteRef: str(doc.siteRef),
    resourceType: str(doc.resourceType),
    isActive: doc.isActive !== false,
    timezone: str(doc.timezone),
    versionNo: doc.versionNo,
    state: str(doc.state),
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo ?? null,
    weekPattern: (doc.weekPattern || []).map((d) => ({
      working: d.working === true,
      shifts: (d.shifts || []).map((s) => ({
        shiftKey: str(s.shiftKey), start: str(s.start), end: str(s.end), breakMinutes: s.breakMinutes,
      })),
    })),
    exceptions: (doc.exceptions || []).map((e) => ({
      date: e.date, kind: str(e.kind), reason: str(e.reason),
      shifts: (e.shifts || []).map((s) => ({
        shiftKey: str(s.shiftKey), start: str(s.start), end: str(s.end), breakMinutes: s.breakMinutes,
      })),
    })),
    crew: (doc.crew || []).map((c) => ({ role: str(c.role), count: c.count })),
    operationalEfficiencyPercent: doc.operationalEfficiencyPercent,
    note: str(doc.note),
    publishedByName: str(doc.publishedBy?.name),
    publishedAt: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : null,
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    retiredReason: str(doc.retiredReason),
    revision: doc.revision,
  };
}

/* ══ WHAT PPC MAY READ ════════════════════════════════════════════════════ */

/**
 * The published cutting resources of one company, for a planning department.
 *
 * Published versions only, and PUBLISHED only — a draft is Cutting's
 * workspace, a superseded version is history, and a retired one is a
 * withdrawal. The whole of PPC's access to this record is this function: it
 * returns no draft, no note history and no actor trail, and there is no
 * counterpart that writes.
 */
async function publishResourcesForPlanning(companyId, { resourceType = null } = {}) {
  if (!isId(companyId)) return [];
  const q = { companyId: oid(companyId), state: RESOURCE_STATE.PUBLISHED };
  if (resourceType) q.resourceType = str(resourceType).toUpperCase();
  const rows = await CuttingResource.find(q).sort({ resourceRef: 1 }).lean();
  return rows.map((doc) => {
    const out = resourceOut(doc);
    /* The trail a planner does not need, removed rather than never built: the
       one projection stays one function, and what crosses is stated here. */
    delete out.note;
    delete out.retiredReason;
    delete out.revision;
    return out;
  });
}

/**
 * The net working minutes this resource offers on one calendar date.
 *
 * A date outside the version's own period is UNKNOWN, not a rest day: this
 * version says nothing about it, and a preview that treated silence as zero
 * would quietly shorten every plan that ran past the roster.
 */
function netMinutesOn(resource, date) {
  if (!resource || !isBusinessDate(date)) {
    return { known: false, working: false, minutes: 0, reason: "NO_RESOURCE", source: "NONE" };
  }
  if (date < resource.effectiveFrom || (resource.effectiveTo && date > resource.effectiveTo)) {
    return { known: false, working: false, minutes: 0, reason: "OUTSIDE_RESOURCE_VERSION", source: "NONE" };
  }
  const exception = (resource.exceptions || []).find((e) => e.date === date);
  if (exception) {
    if (exception.kind === "WORKING_DAY") {
      const minutes = sumShifts(exception.shifts);
      return { known: true, working: minutes > 0, minutes, reason: str(exception.reason), source: "EXCEPTION_WORKING_DAY" };
    }
    return { known: true, working: false, minutes: 0, reason: str(exception.reason), source: `EXCEPTION_${exception.kind}` };
  }
  const day = (resource.weekPattern || [])[weekdayIndex(date)];
  if (!day || !day.working) {
    return { known: true, working: false, minutes: 0, reason: "", source: "WEEKLY_REST_DAY" };
  }
  const minutes = sumShifts(day.shifts);
  return { known: true, working: minutes > 0, minutes, reason: "", source: "WEEK_PATTERN" };
}

module.exports = {
  RESOURCE_STATE, RESOURCE_TYPES, LIMITS,
  shapeResource, saveDraft, publish, retire, listForCutting, resourceOut,
  publishResourcesForPlanning, netMinutesOn,
};
