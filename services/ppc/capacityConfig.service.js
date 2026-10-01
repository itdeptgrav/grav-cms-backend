// services/ppc/capacityConfig.service.js
//
// PPC'S CAPACITY CONFIGURATION — ITS CALENDARS AND ITS LINES.
//
// Configuration is an OWNER's act on PPC's ladder: it decides the hours every
// later booking is measured against, and a planner who could change them could
// make any booking fit. Reading it is a viewer's.
//
// ── A CALENDAR IS DRAFTED, THEN PUBLISHED, THEN NEVER EDITED ────────────────
// A draft can be rewritten freely. Publishing is a separate, idempotent command
// that moves the previous published version to SUPERSEDED and this one to
// PUBLISHED in one transaction, so there is never a moment with two answers or
// none. After that, the version is permanent — the model refuses content
// changes to anything not pinned as a DRAFT — because bookings were proved
// against it and must stay explainable. A correction is a new version.
//
// ── A LINE CHANGE MOVES ITS REVISION ────────────────────────────────────────
// Headcount and calendar are what a booking was sized against. Changing either
// bumps the revision, so any preview a planner is looking at becomes stale and
// the booking command refuses it rather than quietly booking against a line
// that is no longer the one they saw.
"use strict";

const mongoose = require("mongoose");

const {
  PpcCapacityCalendar, PpcCapacityCalendarVersion, VERSION_STATE, EXCEPTION_KIND,
} = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
const { PpcCapacityLine, LINE_STATUS } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const { contentProblems, shiftNetMinutes } = require("./capacityCalendar");
const { planningCommand } = require("./planningCommand");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}
function person(actor) {
  if (!actor?.id) throw fail("PPC_ACTOR_UNRESOLVED", "A configuration change has to be attributable to the signed-in person.");
  return { id: oid(actor.id), name: str(actor.name) };
}
const expectRevision = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw fail("PPC_EXPECTED_REVISION_REQUIRED", "Send the revision you read.", { field: "expectedRevision" });
  }
  return n;
};
function refuseUnknown(body, allowed) {
  const unknown = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("PPC_CAPACITY_FIELD_UNKNOWN", "This command does not take those fields.",
      { fields: unknown, allowed: [...allowed] });
  }
}

/* ══ PROJECTIONS ══════════════════════════════════════════════════════════ */

const shiftOut = (s) => ({
  shiftKey: str(s.shiftKey), start: str(s.start), end: str(s.end),
  breakMinutes: s.breakMinutes, netMinutes: shiftNetMinutes(s),
});

function versionOut(v) {
  return {
    versionId: String(v._id),
    calendarId: String(v.calendarId),
    versionNo: v.versionNo,
    state: str(v.state),
    validFrom: v.validFrom,
    validTo: v.validTo || null,
    weekPattern: (v.weekPattern || []).map((d) => ({
      working: d.working === true, shifts: (d.shifts || []).map(shiftOut),
    })),
    exceptions: (v.exceptions || []).map((e) => ({
      date: e.date, kind: e.kind, reason: str(e.reason), shifts: (e.shifts || []).map(shiftOut),
    })),
    note: str(v.note),
    revision: v.revision,
    publishedAt: v.publishedAt ? new Date(v.publishedAt).toISOString() : null,
    publishedBy: v.publishedBy?.name || null,
    supersededByVersionNo: v.supersededByVersionNo ?? null,
  };
}

function calendarOut(c, versions = []) {
  const published = versions.find((v) => v.state === VERSION_STATE.PUBLISHED) || null;
  const drafts = versions.filter((v) => v.state === VERSION_STATE.DRAFT);
  return {
    calendarId: String(c._id),
    calendarRef: str(c.calendarRef),
    name: str(c.name),
    timezone: str(c.timezone),
    active: c.active !== false,
    revision: c.revision,
    /* The one answer a booking reads: which published version applies now.
       No published version is "provisional" — drafts exist, nothing is proved. */
    publishedVersionNo: published ? published.versionNo : null,
    status: published ? "PUBLISHED" : (drafts.length ? "PROVISIONAL" : "MISSING"),
    draftVersionNos: drafts.map((v) => v.versionNo),
    versions: versions.map(versionOut),
  };
}

const lineOut = (l) => ({
  lineId: String(l._id),
  lineRef: str(l.lineRef),
  name: str(l.name),
  factoryRef: str(l.factoryRef),
  externalRef: str(l.externalRef),
  calendarId: String(l.calendarId),
  operatorCount: l.operatorCount,
  status: str(l.status),
  revision: l.revision,
});

/* ══ CALENDARS ════════════════════════════════════════════════════════════ */

async function listCalendars(ctx) {
  assertContext(ctx);
  const cals = await PpcCapacityCalendar.find({ companyId: oid(ctx.companyId) }).sort({ calendarRef: 1 }).lean();
  const versions = await PpcCapacityCalendarVersion.find({
    companyId: oid(ctx.companyId), calendarId: { $in: cals.map((c) => c._id) },
  }).sort({ versionNo: -1 }).lean();
  return {
    calendars: cals.map((c) => calendarOut(c, versions.filter((v) => String(v.calendarId) === String(c._id)))),
  };
}

async function loadCalendar(ctx, calendarId) {
  assertContext(ctx);
  if (!isId(calendarId)) throw fail("PPC_CALENDAR_NOT_FOUND", "No calendar of yours has that reference.");
  const cal = await PpcCapacityCalendar.findOne({ _id: oid(calendarId), companyId: oid(ctx.companyId) }).lean();
  if (!cal) throw fail("PPC_CALENDAR_NOT_FOUND", "No calendar of yours has that reference.");
  return cal;
}

async function getCalendar(ctx, calendarId) {
  const cal = await loadCalendar(ctx, calendarId);
  const versions = await PpcCapacityCalendarVersion.find({ companyId: cal.companyId, calendarId: cal._id })
    .sort({ versionNo: -1 }).lean();
  return { calendar: calendarOut(cal, versions) };
}

async function createCalendar(ctx, { body = {}, actor } = {}) {
  assertContext(ctx);
  const who = person(actor);
  refuseUnknown(body, ["calendarRef", "name", "timezone"]);
  const calendarRef = str(body.calendarRef).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(calendarRef)) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", "A calendar reference is 2–40 letters, digits, - or _.", { field: "calendarRef" });
  }
  const name = str(body.name);
  if (!name) throw fail("PPC_CAPACITY_INPUT_INVALID", "Name the calendar.", { field: "name" });
  try {
    const [doc] = await PpcCapacityCalendar.create([{
      companyId: oid(ctx.companyId), calendarRef, name,
      timezone: str(body.timezone) || "Asia/Kolkata",
      history: [{ type: "CALENDAR_CREATED", at: new Date(), actorName: who.name }],
      createdBy: who,
    }]);
    return { calendar: calendarOut(doc.toObject(), []) };
  } catch (err) {
    if (err?.code === 11000) {
      throw fail("PPC_CAPACITY_REF_TAKEN", "Another calendar already uses that reference.", { calendarRef });
    }
    throw err;
  }
}

/** Normalise the content a person wrote into a version, or refuse with every problem. */
function normaliseContent(body) {
  const shifts = (list) => (Array.isArray(list) ? list : []).map((s) => ({
    shiftKey: str(s?.shiftKey) || "A",
    start: str(s?.start), end: str(s?.end),
    breakMinutes: Number(s?.breakMinutes ?? 0),
  }));
  const content = {
    validFrom: str(body.validFrom),
    validTo: str(body.validTo) || null,
    weekPattern: Array.isArray(body.weekPattern)
      ? body.weekPattern.map((d) => ({ working: d?.working === true, shifts: shifts(d?.shifts) }))
      : body.weekPattern,
    exceptions: (Array.isArray(body.exceptions) ? body.exceptions : []).map((e) => ({
      date: str(e?.date), kind: str(e?.kind).toUpperCase(), reason: str(e?.reason), shifts: shifts(e?.shifts),
    })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    note: str(body.note),
  };
  const problems = contentProblems(content);
  content.exceptions.forEach((e, i) => {
    if (!EXCEPTION_KIND.includes(e.kind)) {
      problems.push({ field: `exceptions[${i}].kind`, problem: `One of ${EXCEPTION_KIND.join(", ")}.` });
    }
  });
  if (problems.length) {
    throw fail("PPC_CALENDAR_CONTENT_INVALID", "The calendar version has problems to fix.", { problems });
  }
  return content;
}

const CONTENT_FIELDS = ["validFrom", "validTo", "weekPattern", "exceptions", "note"];

async function createDraftVersion(ctx, { calendarId, body = {}, actor } = {}) {
  const who = person(actor);
  const cal = await loadCalendar(ctx, calendarId);
  refuseUnknown(body, CONTENT_FIELDS);
  const content = normaliseContent(body);
  const last = await PpcCapacityCalendarVersion.findOne({ companyId: cal.companyId, calendarId: cal._id })
    .sort({ versionNo: -1 }).lean();
  try {
    const [doc] = await PpcCapacityCalendarVersion.create([{
      companyId: cal.companyId, calendarId: cal._id,
      versionNo: (last?.versionNo || 0) + 1,
      state: VERSION_STATE.DRAFT, ...content, createdBy: who,
    }]);
    return { version: versionOut(doc.toObject()) };
  } catch (err) {
    if (err?.code === 11000) {
      throw fail("PPC_CALENDAR_REVISION_STALE", "Another version was drafted at the same moment. Re-read the calendar.");
    }
    throw err;
  }
}

async function loadVersion(ctx, versionId) {
  assertContext(ctx);
  if (!isId(versionId)) throw fail("PPC_CALENDAR_NOT_FOUND", "No calendar version of yours has that reference.");
  const v = await PpcCapacityCalendarVersion.findOne({ _id: oid(versionId), companyId: oid(ctx.companyId) }).lean();
  if (!v) throw fail("PPC_CALENDAR_NOT_FOUND", "No calendar version of yours has that reference.");
  return v;
}

async function updateDraftVersion(ctx, { versionId, body = {}, actor } = {}) {
  person(actor);
  const { expectedRevision, ...rest } = body;
  const expected = expectRevision(expectedRevision);
  refuseUnknown(rest, CONTENT_FIELDS);
  const current = await loadVersion(ctx, versionId);
  if (current.state !== VERSION_STATE.DRAFT) {
    throw fail("PPC_CALENDAR_VERSION_PUBLISHED",
      "A published calendar version is permanent — bookings were proved against it. Draft a new version instead.",
      { versionNo: current.versionNo, state: current.state });
  }
  const content = normaliseContent({ ...versionOut(current), ...rest });
  const updated = await PpcCapacityCalendarVersion.findOneAndUpdate(
    { _id: current._id, companyId: current.companyId, state: VERSION_STATE.DRAFT, revision: expected },
    { $set: { ...content, revision: expected + 1 } },
    { new: true, lean: true },
  );
  if (!updated) {
    throw fail("PPC_CALENDAR_REVISION_STALE", "This draft changed while you were editing it. Re-read it.",
      { expectedRevision: expected });
  }
  return { version: versionOut(updated) };
}

/**
 * DRAFT → PUBLISHED, and the previous PUBLISHED → SUPERSEDED, as one fact.
 *
 * The partial unique index permits one published version per calendar, so the
 * old one is retired FIRST inside the transaction; two concurrent publishes of
 * two drafts both reach the index and one loses, leaving the calendar with
 * exactly one of them.
 */
async function publishVersion(ctx, { versionId, body = {}, actor, idempotencyKey } = {}) {
  const who = person(actor);
  const expected = expectRevision(body.expectedRevision);
  const draft = await loadVersion(ctx, versionId);

  return planningCommand(ctx, {
    scope: `ppc:capacity:calendar:${String(draft.calendarId)}`,
    command: "CALENDAR_VERSION_PUBLISHED",
    idempotencyKey,
    request: { command: "publish", versionId: String(draft._id), expectedRevision: expected },
  }, async (session) => {
    if (draft.state !== VERSION_STATE.DRAFT) {
      throw fail("PPC_CALENDAR_VERSION_PUBLISHED", "Only a draft can be published.",
        { versionNo: draft.versionNo, state: draft.state });
    }
    const now = new Date();
    await PpcCapacityCalendarVersion.findOneAndUpdate(
      { companyId: draft.companyId, calendarId: draft.calendarId, state: VERSION_STATE.PUBLISHED },
      { $set: { state: VERSION_STATE.SUPERSEDED, supersededAt: now, supersededByVersionNo: draft.versionNo } },
      { session },
    );
    const published = await PpcCapacityCalendarVersion.findOneAndUpdate(
      { _id: draft._id, companyId: draft.companyId, state: VERSION_STATE.DRAFT, revision: expected },
      { $set: { state: VERSION_STATE.PUBLISHED, publishedAt: now, publishedBy: who, revision: expected + 1 } },
      { new: true, lean: true, session },
    );
    if (!published) {
      throw fail("PPC_CALENDAR_REVISION_STALE", "This draft changed while you were publishing it. Re-read it.");
    }
    await PpcCapacityCalendar.updateOne(
      { _id: draft.calendarId, companyId: draft.companyId },
      {
        $inc: { revision: 1 },
        $push: { history: { $each: [{ type: "VERSION_PUBLISHED", at: now, actorName: who.name,
          versionNo: draft.versionNo }], $slice: -200 } },
      },
      { session },
    );
    return { version: versionOut(published) };
  });
}

/* ══ LINES ════════════════════════════════════════════════════════════════ */

async function listLines(ctx, { includeRetired = false } = {}) {
  assertContext(ctx);
  const q = { companyId: oid(ctx.companyId) };
  if (!includeRetired) q.status = LINE_STATUS.ACTIVE;
  const lines = await PpcCapacityLine.find(q).sort({ lineRef: 1 }).lean();
  return { lines: lines.map(lineOut) };
}

async function loadLine(ctx, lineId) {
  assertContext(ctx);
  if (!isId(lineId)) throw fail("PPC_LINE_NOT_FOUND", "No line of yours has that reference.");
  const line = await PpcCapacityLine.findOne({ _id: oid(lineId), companyId: oid(ctx.companyId) }).lean();
  if (!line) throw fail("PPC_LINE_NOT_FOUND", "No line of yours has that reference.");
  return line;
}

function lineFields(body, { requireAll }) {
  const out = {};
  const changed = [];
  if (requireAll || "name" in body) {
    const name = str(body.name);
    if (!name) throw fail("PPC_CAPACITY_INPUT_INVALID", "Name the line.", { field: "name" });
    out.name = name; changed.push("name");
  }
  if (requireAll || "operatorCount" in body) {
    const n = Number(body.operatorCount);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw fail("PPC_CAPACITY_INPUT_INVALID", "Operators is a whole number from 1 to 500.", { field: "operatorCount" });
    }
    out.operatorCount = n; changed.push("operatorCount");
  }
  for (const f of ["factoryRef", "externalRef"]) {
    if (f in body) { out[f] = str(body[f]).slice(0, 120); changed.push(f); }
  }
  return { out, changed };
}

async function assertCalendarOwned(ctx, calendarId) {
  const cal = await loadCalendar(ctx, calendarId).catch(() => null);
  if (!cal) throw fail("PPC_CALENDAR_NOT_FOUND", "That calendar is not one of yours.", { field: "calendarId" });
  return cal;
}

async function createLine(ctx, { body = {}, actor } = {}) {
  assertContext(ctx);
  const who = person(actor);
  refuseUnknown(body, ["lineRef", "name", "factoryRef", "externalRef", "calendarId", "operatorCount"]);
  const lineRef = str(body.lineRef).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(lineRef)) {
    throw fail("PPC_CAPACITY_INPUT_INVALID", "A line reference is 1–40 letters, digits, - or _.", { field: "lineRef" });
  }
  const cal = await assertCalendarOwned(ctx, body.calendarId);
  const { out } = lineFields(body, { requireAll: true });
  try {
    const [doc] = await PpcCapacityLine.create([{
      companyId: oid(ctx.companyId), lineRef, calendarId: cal._id, ...out,
      history: [{ type: "LINE_CREATED", at: new Date(), actorName: who.name, revision: 1 }],
      createdBy: who, updatedBy: who,
    }]);
    return { line: lineOut(doc.toObject()) };
  } catch (err) {
    if (err?.code === 11000) throw fail("PPC_CAPACITY_REF_TAKEN", "Another line already uses that reference.", { lineRef });
    throw err;
  }
}

async function updateLine(ctx, { lineId, body = {}, actor } = {}) {
  const who = person(actor);
  const { expectedRevision, ...rest } = body;
  const expected = expectRevision(expectedRevision);
  refuseUnknown(rest, ["name", "factoryRef", "externalRef", "calendarId", "operatorCount", "status"]);
  const line = await loadLine(ctx, lineId);
  const { out, changed } = lineFields(rest, { requireAll: false });
  if ("calendarId" in rest) {
    const cal = await assertCalendarOwned(ctx, rest.calendarId);
    out.calendarId = cal._id; changed.push("calendarId");
  }
  if ("status" in rest) {
    const s = str(rest.status).toUpperCase();
    if (!Object.values(LINE_STATUS).includes(s)) {
      throw fail("PPC_CAPACITY_INPUT_INVALID", "A line is ACTIVE or RETIRED.", { field: "status" });
    }
    out.status = s; changed.push("status");
  }
  if (!changed.length) return { line: lineOut(line), updated: false };
  const updated = await PpcCapacityLine.findOneAndUpdate(
    { _id: line._id, companyId: line.companyId, revision: expected },
    {
      $set: { ...out, revision: expected + 1, updatedBy: who },
      $push: { history: { $each: [{ type: "LINE_UPDATED", at: new Date(), actorName: who.name,
        revision: expected + 1, changed }], $slice: -200 } },
    },
    { new: true, lean: true },
  );
  if (!updated) {
    throw fail("PPC_LINE_REVISION_STALE", "This line changed while you were editing it. Re-read it.",
      { expectedRevision: expected });
  }
  return { line: lineOut(updated), updated: true };
}

module.exports = {
  listCalendars, getCalendar, createCalendar,
  createDraftVersion, updateDraftVersion, publishVersion,
  listLines, createLine, updateLine,
  loadLine, loadCalendar, calendarOut, versionOut, lineOut,
};
