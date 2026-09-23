"use strict";
/**
 * services/ai/openJev/attendanceToday.js — GRAV's own answer to "is <person>
 * present today?", once a router has suggested that intent.
 *
 * Everything here is deterministic and owned by GRAV. The router's probability
 * is not an input: it chose which code path to try, nothing more. This module:
 *
 *   1. re-reads the question with fixed rules and REFUSES the route (→ existing
 *      assistant path) when the question is about another day, a group, the
 *      user themselves, or leave;
 *   2. resolves the named person against the CALLER-VISIBLE directory — an
 *      exact unique match is required to answer; a typo, a partial match or
 *      several matches produces a clarifying question, never a guess;
 *   3. reads that one employee's entry for today (company time zone) from the
 *      attendance store, and builds a small versioned evidence packet;
 *   4. states only what the packet says: "checked in at …" when a check-in
 *      time is recorded, "no check-in recorded" when it is not, the recorded
 *      status and whether HR has finalised it, and a stale-sync caveat.
 *
 * Data access goes through two ports so the same logic runs against Mongo in
 * the app (./mongoPorts) and against fixtures in the offline evaluation:
 *
 *   directory.listVisible() → [{ employeeRef, employeeId, firstName,
 *                                middleName, lastName }]   (active, visible)
 *   attendance.readEmployeeDay({ dateStr, employeeId })
 *        → null (no sync for that day) |
 *          { syncedAt, holiday, entry: null | { inTime, outTime,
 *                                               hrFinalStatus, systemPrediction } }
 */

const EVIDENCE_SCHEMA = "grav.hr.attendance-today.evidence/1";
const TIME_ZONE = "Asia/Kolkata"; // the HR domain's day boundary (see hrEmployeeContext)
const TZ_OFFSET_MIN = 330;

const OUTCOME = Object.freeze({
  CHECKED_IN: "checked_in",
  NO_CHECKIN: "no_checkin_recorded",
  NO_ENTRY: "no_attendance_entry",
  NO_SYNC: "no_attendance_sync_today",
  CLARIFY_AMBIGUOUS: "clarify_ambiguous",
  CLARIFY_CONFIRM: "clarify_confirm",
  NOT_FOUND: "not_found",
  DEFER: "defer_to_assistant",
});

const STATUS_WORD = {
  P: "present", "P*": "present (arrived late)", "P~": "present",
  AB: "absent", LAB: "absent", EAB: "absent",
  HD: "half-day", LHD: "half-day", MP: "present (missed a punch)",
  WO: "weekly off", FH: "holiday", NH: "holiday", OH: "holiday", RH: "holiday", PH: "holiday",
  "L-CL": "on leave (casual)", "L-SL": "on leave (sick)", "L-EL": "on leave (earned)",
  LWP: "on leave (unpaid)", CO: "comp-off", WFH: "work from home",
};

// ── Question analysis ────────────────────────────────────────────────────────

/* Words that carry no name. Anything NOT listed here, and not a fuzzy variant
   of a cue word below, is treated as part of the person's name — so an unknown
   word makes resolution stricter, never looser. */
const STOP = new Set(
  (
    "is was are were am has have had did does do be been the a an at in on to for of our your " +
    "office work working desk here there come came coming comes present attendance attended " +
    "checked check checkin checkedin punched punch clocked clock arrived arrive reached reach " +
    "turned turn up showed show shown logged login available around inside yet still already " +
    "please can could you tell me if whether know let status what whats about and how mark marked " +
    "hey hi hello grav kindly pls plz ok okay sir madam ji mr mrs ms miss dr " +
    "kya hai hain aaya aayi aaye hua aa gaya gayi"
  ).split(/\s+/),
);
const TODAY_WORDS = new Set(["today", "now", "currently", "right", "morning", "aaj", "abhi", "todays"]);
const OTHER_DAY_WORDS = new Set(
  (
    "yesterday tomorrow kal last next week month year date day before after " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec"
  ).split(/\s+/),
);
const SELF_WORDS = new Set(["i", "my", "mine", "myself", "im"]);
const GROUP_WORDS = new Set(
  "who whom whos everyone anyone anybody everybody all staff employees people team department departments many list count total".split(/\s+/),
);
const LEAVE_WORDS = new Set("leave leaves off holiday vacation sick absent wfh".split(/\s+/));
/* Absent is a leave-ish/negative question ("is X absent today"); it is sent
   back to the assistant rather than answered with a presence template. */

// Cue words whose MISSPELLINGS should be recognised ("presnt", "todya").
const FUZZY_CUES = [
  ["present", "stop"], ["attendance", "stop"], ["office", "stop"], ["checked", "stop"],
  ["arrived", "stop"], ["available", "stop"], ["currently", "today"], ["today", "today"],
  ["morning", "today"], ["yesterday", "other_day"], ["tomorrow", "other_day"],
  ["absent", "leave"], ["holiday", "leave"], ["leave", "leave"],
];

const BIO_RE = /^([a-z]{1,3}\d{2,6}|e\d{3,4})$/i;

/** Optimal-string-alignment distance: Levenshtein plus adjacent transposition. */
function osaDistance(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - osaDistance(a, b) / Math.max(a.length, b.length);
}

function fuzzyCue(token) {
  if (token.length < 4) return null;
  for (const [word, role] of FUZZY_CUES) {
    const allowed = word.length >= 8 ? 2 : 1;
    if (Math.abs(word.length - token.length) <= allowed && osaDistance(token, word) <= allowed) return role;
  }
  return null;
}

function tokenize(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * @returns {{ nameTokens:string[], bioIds:string[], day:"today"|"unspecified"|"other",
 *             self:boolean, group:boolean, leave:boolean }}
 */
function analyseQuestion(message) {
  const out = { nameTokens: [], bioIds: [], day: "unspecified", self: false, group: false, leave: false };
  let otherDay = false;
  let today = false;
  for (const t of tokenize(message)) {
    if (BIO_RE.test(t)) {
      out.bioIds.push(t.toUpperCase());
      continue;
    }
    if (/\d/.test(t)) {
      otherDay = true; // a number that is not an employee code reads as a date
      continue;
    }
    if (SELF_WORDS.has(t)) { out.self = true; continue; }
    if (GROUP_WORDS.has(t)) { out.group = true; continue; }
    if (LEAVE_WORDS.has(t)) { out.leave = true; continue; }
    if (OTHER_DAY_WORDS.has(t)) { otherDay = true; continue; }
    if (TODAY_WORDS.has(t)) { today = true; continue; }
    if (STOP.has(t)) continue;
    const cue = fuzzyCue(t);
    if (cue === "stop") continue;
    if (cue === "today") { today = true; continue; }
    if (cue === "other_day") { otherDay = true; continue; }
    if (cue === "leave") { out.leave = true; continue; }
    if (t.length >= 2) out.nameTokens.push(t);
  }
  out.day = otherDay ? "other" : today ? "today" : "unspecified";
  return out;
}

// ── Person resolution ────────────────────────────────────────────────────────

const FUZZY_THRESHOLD = 0.75;

function displayName(e) {
  return [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.employeeId || "Unnamed";
}

function tokenMatch(token, parts) {
  let best = "none";
  for (const p of parts) {
    if (p === token) return "exact";
    if ((token.length >= 3 && p.startsWith(token)) || similarity(token, p) >= FUZZY_THRESHOLD) best = "fuzzy";
  }
  return best;
}

/**
 * @returns {{kind:"resolved", employee} | {kind:"confirm", candidates:[...]}
 *         | {kind:"ambiguous", candidates:[...]} | {kind:"not_found"}}
 */
function resolvePerson({ nameTokens, bioIds }, directory) {
  const people = Array.isArray(directory) ? directory : [];
  if (bioIds.length) {
    const hits = people.filter((e) => e.employeeId && bioIds.includes(String(e.employeeId).toUpperCase()));
    if (hits.length === 1 && !nameTokens.length) return { kind: "resolved", employee: hits[0] };
    if (hits.length === 1) {
      // An ID plus words: the words must agree with that person's name.
      const parts = [hits[0].firstName, hits[0].middleName, hits[0].lastName].filter(Boolean).map((x) => String(x).toLowerCase());
      if (nameTokens.every((t) => tokenMatch(t, parts) === "exact")) return { kind: "resolved", employee: hits[0] };
      return { kind: "confirm", candidates: hits };
    }
    if (!hits.length && !nameTokens.length) return { kind: "not_found" };
  }
  if (!nameTokens.length) return { kind: "not_found" };

  const exact = [];
  const full = [];
  const partial = [];
  for (const e of people) {
    const parts = [e.firstName, e.middleName, e.lastName].filter(Boolean).map((x) => String(x).toLowerCase());
    if (!parts.length) continue;
    const m = nameTokens.map((t) => tokenMatch(t, parts));
    if (m.every((x) => x === "exact")) exact.push(e);
    else if (m.every((x) => x !== "none")) full.push(e);
    else if (m.some((x) => x !== "none")) partial.push(e);
  }
  if (exact.length === 1) return { kind: "resolved", employee: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  const near = full.length ? full : partial;
  if (near.length === 1) return { kind: "confirm", candidates: near };
  if (near.length > 1) return { kind: "ambiguous", candidates: near };
  return { kind: "not_found" };
}

// ── Evidence and answer ──────────────────────────────────────────────────────

function companyDateStr(now) {
  const t = new Date(now.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function fmtTime(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE });
}

function buildEvidence({ employee, dateStr, day, now, staleMinutes }) {
  const syncedAt = day && day.syncedAt ? new Date(day.syncedAt) : null;
  const ageMin = syncedAt ? Math.round((now.getTime() - syncedAt.getTime()) / 60000) : null;
  const entry = day && day.entry ? day.entry : null;
  const finalised = Boolean(entry && entry.hrFinalStatus);
  const code = entry ? (finalised ? entry.hrFinalStatus : entry.systemPrediction || null) : null;
  return {
    schema: EVIDENCE_SCHEMA,
    date: dateStr,
    timeZone: TIME_ZONE,
    employee: { employeeId: employee.employeeId || null, name: displayName(employee) },
    day: {
      synced: Boolean(day),
      syncedAt: syncedAt ? syncedAt.toISOString() : null,
      syncAgeMinutes: ageMin,
      stale: ageMin !== null && ageMin > staleMinutes,
      holiday: day && day.holiday && day.holiday.name ? String(day.holiday.name) : null,
    },
    entry: entry
      ? {
          checkInRecorded: Boolean(entry.inTime),
          checkIn: fmtTime(entry.inTime),
          checkOut: fmtTime(entry.outTime),
          statusCode: code,
          status: code ? STATUS_WORD[code] || code : null,
          statusSource: finalised ? "hr_final" : code ? "system_prediction" : null,
        }
      : null,
    readAt: now.toISOString(),
  };
}

function composeAnswer(ev) {
  const who = ev.employee.name;
  const on = `today (${ev.date})`;
  if (!ev.day.synced) {
    return {
      outcome: OUTCOME.NO_SYNC,
      reply: `Attendance for ${on} has not been synced yet, so I can't tell whether ${who} has checked in.`,
    };
  }
  const tail = [];
  if (ev.entry && ev.entry.status) {
    tail.push(
      `Recorded status: ${ev.entry.status} (${ev.entry.statusSource === "hr_final" ? "finalised by HR" : "system prediction, not yet reviewed by HR"}).`,
    );
  }
  if (ev.day.holiday) tail.push(`Today is marked as a holiday: ${ev.day.holiday}.`);
  if (ev.day.stale) {
    const last = fmtTime(ev.day.syncedAt);
    tail.push(`Attendance was last synced at ${last}, so anything recorded after that may not be shown yet.`);
  }
  const rest = tail.length ? ` ${tail.join(" ")}` : "";
  if (!ev.entry) {
    return { outcome: OUTCOME.NO_ENTRY, reply: `There is no attendance entry for ${who} ${on}, so no check-in is recorded.${rest}` };
  }
  if (ev.entry.checkInRecorded) {
    return { outcome: OUTCOME.CHECKED_IN, reply: `${who} checked in at ${ev.entry.checkIn} ${on}.${rest}` };
  }
  return { outcome: OUTCOME.NO_CHECKIN, reply: `No check-in is recorded for ${who} ${on}.${rest}` };
}

function listNames(candidates) {
  return candidates
    .slice(0, 5)
    .map((e) => `${displayName(e)}${e.employeeId ? ` (${e.employeeId})` : ""}`)
    .join(", ");
}

/**
 * The whole GRAV-side step. Authorisation is the CALLER's job and must already
 * have succeeded; this function never decides who may see what.
 *
 * @returns {Promise<{outcome:string, reply?:string, evidence?:object, reason?:string}>}
 */
async function answerAttendanceToday({ message, ports, now = new Date(), staleMinutes = 90 }) {
  const q = analyseQuestion(message);
  if (q.day === "other") return { outcome: OUTCOME.DEFER, reason: "not_today" };
  if (q.self) return { outcome: OUTCOME.DEFER, reason: "self_question" };
  if (q.group) return { outcome: OUTCOME.DEFER, reason: "group_question" };
  if (q.leave) return { outcome: OUTCOME.DEFER, reason: "leave_question" };
  if (!q.nameTokens.length && !q.bioIds.length) return { outcome: OUTCOME.DEFER, reason: "no_person_named" };
  if (q.nameTokens.length > 4) return { outcome: OUTCOME.DEFER, reason: "too_many_unrecognised_words" };

  const directory = await ports.directory.listVisible();
  const r = resolvePerson(q, directory);
  const asked = [...q.nameTokens, ...q.bioIds].join(" ");
  if (r.kind === "not_found") {
    return {
      outcome: OUTCOME.NOT_FOUND,
      reply: `I couldn't find an active employee matching "${asked}" in the directory you can access. Could you check the name or give their employee ID?`,
    };
  }
  if (r.kind === "ambiguous") {
    return {
      outcome: OUTCOME.CLARIFY_AMBIGUOUS,
      reply: `More than one employee matches "${asked}": ${listNames(r.candidates)}. Which one do you mean?`,
    };
  }
  if (r.kind === "confirm") {
    return {
      outcome: OUTCOME.CLARIFY_CONFIRM,
      reply: `I couldn't match "${asked}" exactly. Did you mean ${listNames(r.candidates)}?`,
    };
  }

  const dateStr = companyDateStr(now);
  const day = r.employee.employeeId
    ? await ports.attendance.readEmployeeDay({ dateStr, employeeId: r.employee.employeeId })
    : null;
  const evidence = buildEvidence({ employee: r.employee, dateStr, day, now, staleMinutes });
  const { outcome, reply } = composeAnswer(evidence);
  return { outcome, reply, evidence };
}

module.exports = {
  answerAttendanceToday,
  analyseQuestion,
  resolvePerson,
  buildEvidence,
  composeAnswer,
  companyDateStr,
  osaDistance,
  OUTCOME,
  EVIDENCE_SCHEMA,
};
