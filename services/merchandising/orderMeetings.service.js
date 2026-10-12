// services/merchandising/orderMeetings.service.js
//
// PPM MEETINGS A MERCHANDISER SCHEDULES AGAINST A RELEASED ORDER (11 Oct 2026,
// owner: "the merchandiser will arrange the meeting from this CMS dashboard,
// so automatically it will get created in the CoWork side for that user … a
// special connection will link that meeting to that order, so the transcript,
// audio recording and all — the meeting history — will show against that
// order here. Only those meetings; don't keep join and all here.")
//
// ── ONE MEETING SYSTEM, NOT TWO ──────────────────────────────────────────────
// The meeting IS a CoWork scheduled meet (`cowork_scheduled_meets`), made by
// the same `scheduleCoworkMeet` the CoWork app calls, with the CMS user's
// CoWork identity as the organiser. So the organiser and the participants see
// it in CoWork exactly as any other meeting (list, reminders, notifications,
// Start, Join, recording, summary, transcript); nothing about CoWork changes.
// What this file adds is ONE field on the document, written after the
// service's `.set()`:
//
//   linkedOrder: { source: "cms-merchandising", kind: "ppm",
//                  customerRequestId, orderRef, customerName, companyId,
//                  createdByEmail, createdByName, createdAt }
//
// Every CoWork write after creation is a keyed `.update()` (status, presence,
// LiveKit, chat retention, summary status), so the field survives the meeting's
// whole life. Reads here select on `linkedOrder.customerRequestId`, so a
// meeting scheduled inside CoWork is never shown against an order — only the
// ones made through this door are.
//
// ── THE HISTORY IS READ, NEVER COPIED ───────────────────────────────────────
// Recordings (`meeting_audio_recordings`), the Gemini summary
// (`meeting_summaries/{meetId}`), the Gemini transcript
// (`meeting_transcripts_gemini/{meetId}`) and the live captions
// (`meeting_transcripts/{meetId}`, 24 h retention) are read by meetId at
// request time and shaped for the order page. Nothing is duplicated into
// Mongo, so what the merchandiser sees is what CoWork holds.
//
// ── WHO THE ORGANISER IS ────────────────────────────────────────────────────
// The CMS session (JWT) names a person by id and e-mail. Their CoWork identity
// is `Employee.coworkEmployeeId` when the record carries the explicit link
// (the SSO and Access Control write it), else the `cowork_employees` document
// whose `email` (or `legacyEmail`) is the session's e-mail. A person with no
// CoWork account cannot schedule: the refusal says so, in words, and nothing
// is written.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("../storePurchase/errors");
const orders = require("./orders.service");
const cowork = require("../cowork.service");
const { db } = require("../../config/firebaseAdmin");

const { MIN_MINUTES, MAX_MINUTES, DEFAULT_MINUTES, meetingState, normaliseMeeting } = require("./orderMeetings.rules");

const str = (v) => (v === null || v === undefined ? "" : String(v));
const lower = (v) => str(v).trim().toLowerCase();
const Employee = () => mongoose.models.Employee || require("../../models/Employee");

const SOURCE = "cms-merchandising";
const KIND = "ppm";

/* ── People ─────────────────────────────────────────────────────────────── */

const activeEmployee = (d) => d && d.isActive !== false && lower(d.status) !== "inactive" && d.isSystemIdentity !== true;

const personView = (d) => ({
  employeeId: str(d.employeeId || d.id),
  name: str(d.name) || str(d.employeeId || d.id),
  email: str(d.email),
  department: str(d.department),
  role: str(d.role),
});

/** Every active CoWork employee, for the participant picker. */
async function listPeople() {
  const snap = await db.collection("cowork_employees").get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter(activeEmployee)
    .map(personView)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function peopleById() {
  const snap = await db.collection("cowork_employees").get();
  const map = new Map();
  for (const doc of snap.docs) map.set(doc.id, personView({ id: doc.id, ...doc.data() }));
  return map;
}

/**
 * The CMS session's CoWork identity, or null.
 * @returns {{ employeeId, name, email, via: "link"|"email" } | null}
 */
async function resolveCoworkIdentity(user) {
  if (!user) return null;
  const emails = new Set();
  if (user.email) emails.add(lower(user.email));
  if (user.id && mongoose.isValidObjectId(user.id)) {
    const me = await Employee().findById(user.id).select("coworkEmployeeId email name").lean().catch(() => null);
    if (me?.coworkEmployeeId) {
      const doc = await db.collection("cowork_employees").doc(str(me.coworkEmployeeId)).get();
      if (doc.exists) return { ...personView({ id: doc.id, ...doc.data() }), via: "link" };
    }
    if (me?.email) emails.add(lower(me.email));
  }
  for (const email of emails) {
    if (!email) continue;
    for (const field of ["email", "legacyEmail"]) {
      const snap = await db.collection("cowork_employees").where(field, "==", email).limit(1).get();
      if (!snap.empty) return { ...personView({ id: snap.docs[0].id, ...snap.docs[0].data() }), via: "email" };
    }
  }
  return null;
}

async function requireCoworkIdentity(user) {
  const me = await resolveCoworkIdentity(user);
  if (!me) {
    throw fail("CONFLICT", `No CoWork account is linked to ${user?.email || "this sign-in"}. The meeting is created in CoWork under the organiser's own account, so ask the administrator to link this login to a CoWork user (Access Control › CoWork) and try again. Nothing was created.`, { reason: "NO_COWORK_ACCOUNT" });
  }
  return me;
}

/* ── Reading a meeting ──────────────────────────────────────────────────── */

const tsToIso = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (typeof v._seconds === "number") return new Date(v._seconds * 1000).toISOString();
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
};

function meetView(meet, people) {
  const who = (id) => people.get(str(id)) || { employeeId: str(id), name: str(id), email: "" };
  const presence = meet.presence && typeof meet.presence === "object" ? meet.presence : {};
  return {
    meetId: str(meet.meetId || meet.id),
    title: str(meet.title),
    description: str(meet.description),
    agenda: Array.isArray(meet.agenda) ? meet.agenda.filter((a) => typeof a === "string") : [],
    dateTime: str(meet.dateTime) || null,
    endsAt: str(meet.endsAt) || null,
    state: meetingState(meet),
    status: str(meet.status),
    isCancelled: meet.isCancelled === true,
    createdBy: who(meet.createdBy),
    participants: (Array.isArray(meet.participants) ? meet.participants : []).map(who),
    presence: Object.entries(presence).map(([id, p]) => ({ ...who(id), joinedAt: str(p?.joinedAt) || null, leftAt: str(p?.leftAt) || null })),
    startedAt: str(meet.startedAt) || tsToIso(meet.livekitStartedAt),
    endedAt: str(meet.endedAt) || tsToIso(meet.livekitEndedAt),
    cancelledAt: str(meet.cancelledAt) || null,
    cancelledBy: meet.cancelledBy ? who(meet.cancelledBy) : null,
    createdAt: tsToIso(meet.createdAt),
    summaryStatus: str(meet.summary_status) || null,
    linkedOrder: meet.linkedOrder || null,
  };
}

/* The history, read by meetId. A missing document is `null`, never an
   empty shape — the page says "no recording yet" from that. */
async function historyOf(meetId) {
  const [recSnap, summaryDoc, geminiDoc, captionsDoc] = await Promise.all([
    db.collection("meeting_audio_recordings").where("meetId", "==", meetId).get(),
    db.collection("meeting_summaries").doc(meetId).get(),
    db.collection("meeting_transcripts_gemini").doc(meetId).get(),
    db.collection("meeting_transcripts").doc(meetId).get(),
  ]);

  const recordings = recSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => lower(r.status) !== "rejected")
    .map((r) => ({
      id: r.id,
      employeeId: str(r.employeeId),
      employeeName: str(r.employeeName || r.recordedByName || r.firstName),
      fileName: str(r.fileName),
      mimeType: str(r.mimeType),
      fileSize: Number.isFinite(Number(r.fileSize)) ? Number(r.fileSize) : null,
      viewUrl: str(r.driveViewUrl) || null,
      downloadUrl: str(r.driveDownloadUrl) || null,
      uploadedAt: tsToIso(r.uploadedAt),
      status: str(r.status),
      isBackup: r.isBackup === true,
      isGuest: r.isGuest === true,
      emergency: r.emergency === true,
    }))
    .sort((a, b) => str(a.uploadedAt).localeCompare(str(b.uploadedAt)));

  let summary = null;
  if (summaryDoc.exists) {
    const s = summaryDoc.data() || {};
    summary = {
      text: str(s.summary),
      actionItems: Array.isArray(s.actionItems) ? s.actionItems : [],
      tasksAssigned: Array.isArray(s.tasksAssigned) ? s.tasksAssigned : [],
      deadlines: Array.isArray(s.deadlines) ? s.deadlines : [],
      conversationFlow: Array.isArray(s.conversationFlow) ? s.conversationFlow : (s.conversationFlow ? [s.conversationFlow] : []),
      participants: Array.isArray(s.participants) ? s.participants : [],
      audioFilesCount: Number(s.audioFilesCount) || 0,
      source: str(s.source) || "audio",
      createdAt: s.createdAtMs ? new Date(Number(s.createdAtMs)).toISOString() : tsToIso(s.createdAt),
    };
  }

  let transcript = null;
  if (geminiDoc.exists) {
    const t = geminiDoc.data() || {};
    const modes = {};
    for (const mode of ["verbatim", "translate"]) {
      const m = t[mode];
      if (!m || !Array.isArray(m.utterances)) continue;
      modes[mode] = {
        utterances: m.utterances.map((u) => ({
          start: Number.isFinite(Number(u?.start)) ? Number(u.start) : null,
          end: Number.isFinite(Number(u?.end)) ? Number(u.end) : null,
          speaker: str(u?.speaker),
          text: str(u?.text),
          translated: u?.translated ? str(u.translated) : undefined,
          needsReview: u?.needsReview === true,
        })),
        createdAt: m.createdAtMs ? new Date(Number(m.createdAtMs)).toISOString() : null,
        unparsedLineCount: Number(m.unparsedLineCount) || 0,
      };
    }
    if (Object.keys(modes).length) {
      transcript = { participantNames: Array.isArray(t.participantNames) ? t.participantNames : [], audioFileCount: Number(t.audioFileCount) || 0, ...modes };
    }
  }

  let captions = null;
  if (captionsDoc.exists) {
    const c = captionsDoc.data() || {};
    captions = {
      lines: (Array.isArray(c.lines) ? c.lines : []).map((l) => ({ name: str(l?.name), text: str(l?.text), time: str(l?.time) })),
      savedAt: tsToIso(c.savedAt),
      expiresAt: c.deleteAtMs ? new Date(Number(c.deleteAtMs)).toISOString() : null,
    };
  }

  return { recordings, summary, transcript, captions };
}

/* ── Doors ──────────────────────────────────────────────────────────────── */

async function listForOrder(ctx, { orderId, user } = {}) {
  const order = await orders.loadOwnedOrder(ctx, orderId);
  const [snap, people, me] = await Promise.all([
    db.collection("cowork_scheduled_meets").where("linkedOrder.customerRequestId", "==", str(order._id)).get(),
    peopleById(),
    resolveCoworkIdentity(user),
  ]);
  const meets = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.linkedOrder?.source === SOURCE);
  const views = await Promise.all(meets.map(async (m) => {
    const view = meetView(m, people);
    view.history = await historyOf(view.meetId).catch((e) => {
      console.warn(`[orderMeetings] history of ${view.meetId} unavailable: ${e.message}`);
      return null;
    });
    return view;
  }));
  views.sort((a, b) => str(b.dateTime).localeCompare(str(a.dateTime)));
  return {
    order: { id: str(order._id), orderRef: str(order.requestId), customerName: str(order.customerInfo?.name) },
    me: me ? { employeeId: me.employeeId, name: me.name, email: me.email, via: me.via } : null,
    meetings: views,
  };
}

async function people(ctx, { orderId, user } = {}) {
  await orders.loadOwnedOrder(ctx, orderId);
  const [list, me] = await Promise.all([listPeople(), resolveCoworkIdentity(user)]);
  return { me: me ? { employeeId: me.employeeId, name: me.name, email: me.email, via: me.via } : null, people: list };
}

async function create(ctx, { orderId, body, user } = {}) {
  const order = await orders.loadOwnedOrder(ctx, orderId);
  const me = await requireCoworkIdentity(user);
  const orderRef = str(order.requestId);
  const checked = normaliseMeeting(body, { orderRef });
  if (!checked.ok) {
    const first = Object.values(checked.errors)[0];
    throw fail("VALIDATION", first, { errors: checked.errors });
  }
  const v = checked.value;

  /* Every participant must be a CoWork employee — an unknown id would sit in
     the meet's list for ever and reach nobody. */
  const known = await peopleById();
  const unknown = v.participants.filter((id) => !known.has(id));
  if (unknown.length) {
    throw fail("VALIDATION", `${unknown.length === 1 ? "One participant is not a CoWork user" : `${unknown.length} participants are not CoWork users`}: ${unknown.join(", ")}. Pick people from the list.`, { errors: { participants: "Pick people from the list." } });
  }

  /* The same call CoWork's own "Schedule" makes: id from the shared counter,
     organiser first in `participants`, status scheduled, the audit row, the
     in-app notification, push and e-mail to every other participant. */
  const meet = await cowork.scheduleCoworkMeet({
    title: v.title,
    description: v.description,
    createdBy: me.employeeId,
    participants: v.participants,
    dateTime: v.dateTime,
    endsAt: v.endsAt,
    agenda: v.agenda,
    taskId: null,
  });

  const linkedOrder = {
    source: SOURCE,
    kind: KIND,
    customerRequestId: str(order._id),
    orderRef,
    customerName: str(order.customerInfo?.name),
    companyId: str(ctx.companyId),
    createdByEmail: str(user?.email),
    createdByName: str(user?.name) || me.name,
    createdByCoworkId: me.employeeId,
    createdAt: new Date().toISOString(),
  };
  await db.collection("cowork_scheduled_meets").doc(meet.meetId).update({ linkedOrder });

  const people = await peopleById();
  const view = meetView({ ...meet, createdAt: new Date(), linkedOrder }, people);
  view.history = { recordings: [], summary: null, transcript: null, captions: null };
  return { meeting: view, me: { employeeId: me.employeeId, name: me.name, email: me.email, via: me.via } };
}

module.exports = {
  SOURCE, KIND, MIN_MINUTES, MAX_MINUTES, DEFAULT_MINUTES,
  listForOrder, people, create,
  resolveCoworkIdentity, normaliseMeeting, meetingState, meetView, historyOf,
};
