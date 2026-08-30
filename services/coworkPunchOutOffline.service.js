"use strict";

/**
 * Close out a CoWork presence that the person left running when they went home.
 *
 * ## The problem
 *
 * CoWork presence is set by the person, in the browser. Going offline is a
 * button they press. So the one case it cannot cover is the one that happens
 * most: somebody shuts the laptop and leaves. Nothing publishes anything, the
 * duty document keeps saying `online`, and the admin attendance panel shows
 * them present all evening — including the next morning, until they sign in
 * again and the browser finally corrects it.
 *
 * The biometric device already knows they left. This joins the two.
 *
 * ## Why an evidence rule rather than a timeout
 *
 * CoWork used to expire a stale `online` claim on a quiet heartbeat, and that
 * was removed deliberately — `lib/rules/presence/duty.ts:163` in the CoWork
 * repository records why. A backgrounded tab, a sleeping laptop or a minute of
 * refused writes marked people away who were sitting at their desks, their
 * timers auto-paused and their task actions refused, with nothing on screen to
 * explain it. The rule that replaced it: a status is only ever changed by the
 * person whose status it is.
 *
 * A punch-out is not a timeout. It is the person themselves, telling a
 * different machine that they are leaving, at a recorded instant. That is why
 * this is allowed to write where a heartbeat check is not — and it is also why
 * every guard below is about EVIDENCE rather than elapsed time. No punch, no
 * write.
 *
 * ## What it deliberately does not do
 *
 * **It creates no deadline credit.** Returning from an offline span normally
 * shifts every active task deadline by the office-hours part of the absence.
 * That is a consequence of a person deciding to go offline; it should not be a
 * consequence of a nightly job noticing they forgot to. Today, a forgotten
 * `online` grants no credit either, so suppressing it here changes nothing
 * about anybody's deadlines — which is the point. `offlineStartedAtMs` is
 * written null, and the span measures zero on their next sign-in.
 *
 * **It only ever acts on `online`.** Somebody left on a break or in emergency
 * mode is a different state with a different meaning, and neither is the
 * reported problem.
 *
 * **It never overrides a later decision.** If the duty document changed after
 * the punch-out — they came back, took a break, went offline themselves — the
 * person has spoken more recently than the device, and the device loses.
 */

const cron = require("node-cron");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");
const Employee = require("../models/Employee");

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar day an instant falls in, as "YYYY-MM-DD". */
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return [
    ist.getUTCFullYear(),
    String(ist.getUTCMonth() + 1).padStart(2, "0"),
    String(ist.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Midnight IST of the day an instant falls in, as epoch ms. */
function istDayStartMs(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return (
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) -
    IST_OFFSET_MS
  );
}

/**
 * When to stamp the OPENING row of the session this close-out ends.
 *
 * ## Why an opening row is needed at all
 *
 * The attendance panel does not read a mode and print it. It builds each
 * stretch by pairing an `online` history row with the `offline` row that
 * follows it, and it ignores an `offline` row that opens nothing
 * (`attendanceRow` in the CoWork repository skips any span whose entry is not
 * `online`). Somebody currently online with no rows at all is covered by a
 * live fallback that draws "on duty since midnight" from the duty document.
 *
 * So writing only the closing row moves a person from one of those cases to
 * neither: no longer live, so the fallback does not apply, and no `online` row
 * to pair with. The panel then reports "Not on duty today · 0m" over a day
 * they worked — the day is not merely uncorrected, it is erased. Observed on
 * 26 Aug over eight people, which is what this exists to prevent.
 *
 * ## Where the start comes from, in order
 *
 * 1. **The duty document's `updatedAt`**, when it falls inside today. Only a
 *    mode change writes it, so it holds the instant this session began — and
 *    it is CoWork's own record of when the person arrived, which beats an
 *    inference every time.
 *
 * 2. **The E-Time punch-IN**, when the session began before today. Somebody
 *    who left CoWork online overnight has a session start dated yesterday, and
 *    two things are wrong with using it: the panel queries a single day's
 *    window, so a row dated yesterday is never returned and the pairing fails
 *    exactly as if no row existed; and the person did not work through the
 *    night. The device knows when they actually arrived. Closing the day with
 *    the device's punch-out and opening it with anything other than the
 *    device's punch-in would be reading half of one record.
 *
 * 3. **Midnight**, when there is no punch-in either. Last resort, and a poor
 *    one — it reports the night as worked. It exists only because erasing the
 *    day is worse than overstating it, and because this is the same reading
 *    the panel's own live fallback already gives.
 *
 * The midnight-only version of this shipped first and was wrong in a way worth
 * recording: eight people on 26 Aug rendered as "12:00 AM → 7:29 PM · 19h 29m".
 * The day was no longer erased, it was inflated — and a 19-hour day on an
 * attendance panel is not a smaller error than a missing one, it is a
 * different one that somebody has to argue with payroll about.
 *
 * Returns null when there is nothing sensible to open: a start at or after the
 * punch-out would be a stretch of zero or negative length, which the panel
 * discards anyway.
 */
function onlineRowAtMs({ sessionStartMs, punchInMs, dayStartMs, punchOutMs }) {
  if (!Number.isFinite(punchOutMs)) return null;

  let began = dayStartMs;
  if (Number.isFinite(sessionStartMs) && sessionStartMs > dayStartMs) {
    began = sessionStartMs;
  } else if (Number.isFinite(punchInMs) && punchInMs >= dayStartMs) {
    began = punchInMs;
  }

  if (began >= punchOutMs) return null;
  return began;
}

function istClock(ms) {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function msOf(value) {
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * The mode a duty document is actually in.
 *
 * Mirrors `storedMode` in the CoWork repository, including its fallback: the
 * old application writes `isOnline` and no `mode`, and a document written by
 * one app has to read the same in the other.
 */
function storedMode(doc) {
  if (!doc || typeof doc !== "object") return "offline";
  const mode = doc.mode;
  if (mode === "online" || mode === "break" || mode === "emergency") return mode;
  if (mode === "offline") return "offline";
  if (doc.isOnline === true) return "online";
  return "offline";
}

/**
 * Whether this person's presence should be closed out, and why not when not.
 *
 * Pure — no database, no clock of its own — because every interesting case
 * here is a combination of two timestamps and a mode, and those are worth
 * testing directly rather than through a cron job and two databases.
 */
function shouldMarkOffline({ duty, punchOutMs, nowMs }) {
  if (!duty) return { act: false, reason: "no-duty-document" };

  const mode = storedMode(duty);
  /* Only `online`. A break or an emergency is a state somebody chose and is
     still in as far as anything here knows. */
  if (mode !== "online") return { act: false, reason: `mode-${mode}` };

  if (!Number.isFinite(punchOutMs) || punchOutMs <= 0)
    return { act: false, reason: "no-punch-out" };

  /* A punch in the future is a device clock problem, not a departure. */
  if (punchOutMs > nowMs) return { act: false, reason: "punch-in-future" };

  /* Today's punch only. A stale row from an earlier day must never close a
     session that belongs to this one. */
  if (istDateStr(punchOutMs) !== istDateStr(nowMs))
    return { act: false, reason: "punch-not-today" };

  /**
   * **The person outranks the device.**
   *
   * `updatedAt` moves only on a mode change, so a value after the punch-out
   * means they did something deliberate afterwards — came back online, started
   * a break — and this session is not the one the punch ended. Writing over it
   * would be the trapdoor all over again, with better evidence and the same
   * result: a status somebody did not ask to lose.
   */
  const updatedAtMs = msOf(duty.updatedAt);
  if (Number.isFinite(updatedAtMs) && updatedAtMs > punchOutMs)
    return { act: false, reason: "newer-decision" };

  return { act: true, reason: "punched-out" };
}

/**
 * The duty-document patch for a system-closed session.
 *
 * Deliberately the same shape `dutyTransition` produces for an offline
 * transition in the CoWork repository, field for field. Both spellings of the
 * mode are written because the old application reads `isOnline` when `mode` is
 * absent, and a half-written document reads differently in each app.
 *
 * `updatedAt` is the punch-out instant, not now: it is what the roster shows as
 * "offline since", and the honest answer is when they left, not when this job
 * noticed. `offlineStartedAtMs` is null on purpose — see the note on deadline
 * credit at the top of this file.
 */
function offlinePatch(employeeId, punchOutMs) {
  return {
    employeeId: String(employeeId),
    mode: "offline",
    isOnline: false,
    updatedAt: punchOutMs,
    heartbeatAt: null,
    presenceConnectionId: null,
    offlineStartedAtMs: null,
    /* Additive markers, so a person looking at their own day can tell a system
       action from one of their own. Nothing reads these yet. */
    offlineSource: "etime-punch-out",
    offlineSourceAtMs: punchOutMs,
  };
}

/**
 * Every biometric id that punched out on `dateStr`, mapped to that instant.
 *
 * Read from the day document the hourly attendance sync already maintains
 * rather than from the device directly. `startHourlyAttendanceSync` refreshes
 * today's punches at :05 past every hour, so by any evening run the punch-outs
 * are already here — matched to employees, with the ghost and name-mismatch
 * handling that route does. Calling eTimeOffice again would repeat all of it
 * for the same answer.
 */
async function punchOutsFor(dateStr) {
  const day = await DailyAttendance.findOne({ dateStr })
    .select("employees.biometricId employees.finalOut employees.inTime")
    .lean();

  const out = new Map();
  for (const e of day?.employees || []) {
    const outMs = msOf(e.finalOut);
    /* The punch-IN travels with the punch-out. Both halves of the day come
       from one record, so the panel does not end it with the device's answer
       and begin it with a guess. */
    if (e.biometricId && Number.isFinite(outMs))
      out.set(String(e.biometricId), { outMs, inMs: msOf(e.inTime) });
  }
  return out;
}

/**
 * Which CoWork account a biometric id belongs to.
 *
 * Usually the same string — a biometric id becomes the CoWork id when an
 * account is provisioned with one. But an account created without one is
 * matched by email and given a generated `E001`-style id, and HR records the
 * result in `Employee.coworkEmployeeId`. That field is the explicit link the
 * SSO route trusts, so it wins here too; the biometric id is the fallback for
 * the ordinary case where no link was ever needed.
 *
 * Returns one entry per biometric id that has a resolvable account.
 */
async function resolveCoworkIds(biometricIds) {
  const ids = [...biometricIds];
  if (!ids.length) return new Map();

  const rows = await Employee.find({ biometricId: { $in: ids } })
    .select("biometricId coworkEmployeeId")
    .lean();

  const linked = new Map();
  for (const r of rows) {
    const explicit = String(r.coworkEmployeeId || "").trim();
    if (explicit) linked.set(String(r.biometricId), explicit);
  }

  const resolved = new Map();
  for (const bid of ids) resolved.set(bid, linked.get(bid) || bid);
  return resolved;
}

/**
 * Close out every CoWork session left online by somebody who has punched out.
 *
 * Safe to re-run: it only ever acts on a document still reading `online`, so a
 * second pass over the same day finds nothing left to do. That matters — a
 * restart at 23:30 would otherwise double-write.
 */
async function runCoworkPunchOutOffline(dateStr = null, nowMs = Date.now()) {
  const day = dateStr || istDateStr(nowMs);
  const { db, admin } = require("../config/firebaseAdmin");

  const punches = await punchOutsFor(day);
  if (!punches.size) {
    console.log(`[COWORK-PUNCHOUT] ${day}: no punch-outs recorded, nothing to do`);
    return { date: day, scanned: 0, marked: 0, skipped: [] };
  }

  const coworkIds = await resolveCoworkIds(punches.keys());

  const dayStartMs = istDayStartMs(nowMs);
  /**
   * Who already has an `online` row today.
   *
   * Read once for the whole day rather than queried per person: it is one
   * small collection scan against a window that holds a few dozen rows, where
   * the alternative is one composite query per employee. It decides only
   * whether an opening row is needed — somebody whose day is already recorded
   * must not be given a second one.
   */
  const opened = new Set();
  try {
    const trail = await db
      .collection("cowork_duty_history")
      .where("at", ">=", dayStartMs)
      .where("at", "<", dayStartMs + 24 * 60 * 60 * 1000)
      .get();
    for (const d of trail.docs) {
      const h = d.data();
      if (h && h.mode === "online" && h.employeeId) opened.add(String(h.employeeId));
    }
  } catch (e) {
    /* Without the trail the safe assumption is "nobody has one": a duplicate
       opening row merges into one stretch when the panel reads it, while a
       missing one erases the day. */
    console.warn("[COWORK-PUNCHOUT] could not read today's history:", e.message);
  }

  const marked = [];
  const skipped = [];

  for (const [biometricId, { outMs: punchOutMs, inMs: punchInMs }] of punches) {
    const employeeId = coworkIds.get(biometricId) || biometricId;
    try {
      const ref = db.collection("cowork_duty_status").doc(String(employeeId));
      const snap = await ref.get();
      const duty = snap.exists ? snap.data() : null;

      const verdict = shouldMarkOffline({ duty, punchOutMs, nowMs });
      if (!verdict.act) {
        skipped.push({ employeeId, reason: verdict.reason });
        continue;
      }

      /* Read BEFORE the patch: `updatedAt` holds the instant this session
         began, and `offlinePatch` overwrites it with the punch-out. */
      const sessionStartMs = msOf(duty.updatedAt);

      await ref.set(offlinePatch(employeeId, punchOutMs), { merge: true });

      /* The opening row, when the day has none — without it the closing row
         below pairs with nothing and the panel reports the day as unworked. */
      if (!opened.has(String(employeeId))) {
        const openAtMs = onlineRowAtMs({
          sessionStartMs,
          punchInMs,
          dayStartMs,
          punchOutMs,
        });
        if (openAtMs !== null) {
          await db.collection("cowork_duty_history").add({
            employeeId: String(employeeId),
            mode: "online",
            at: openAtMs,
            reason: null,
            source: "etime-punch-out",
            recordedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      /**
       * **The history row is the half that shows on screen.**
       *
       * `cowork_duty_status` holds only the current mode; the admin attendance
       * panel builds its timeline from `cowork_duty_history`. Updating the
       * status without appending here would leave that panel showing the person
       * online all evening — the exact screen this job exists to fix.
       */
      await db.collection("cowork_duty_history").add({
        employeeId: String(employeeId),
        mode: "offline",
        at: punchOutMs,
        reason: `Punched out at ${istClock(punchOutMs)} — closed by E-Time`,
        source: "etime-punch-out",
        recordedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      marked.push({ employeeId, at: istClock(punchOutMs) });
    } catch (err) {
      /* One unreachable document must not cost everybody else their correction. */
      console.error(
        `[COWORK-PUNCHOUT] ${employeeId}: ${err.message}`,
      );
      skipped.push({ employeeId, reason: `error:${err.message}` });
    }
  }

  console.log(
    `[COWORK-PUNCHOUT] ${day}: ${marked.length} marked offline, ${skipped.length} left alone`,
    marked.length ? marked : "",
  );
  return { date: day, scanned: punches.size, marked: marked.length, skipped };
}

/**
 * 23:30 IST, every day.
 *
 * Late enough that the evening's punch-outs are in — the hourly sync last ran
 * at 23:05 — and late enough that anybody still working is genuinely still
 * working, so the guards above have nothing to argue with.
 *
 * It still has half an hour of the IST day left, which the guards need: the
 * punch and the run must fall on the same IST date, or `punch-not-today`
 * refuses every one of them.
 */
function startCoworkPunchOutOfflineSync() {
  cron.schedule(
    "30 23 * * *",
    async () => {
      try {
        await runCoworkPunchOutOffline();
      } catch (err) {
        console.error("[COWORK-PUNCHOUT] run failed:", err.message);
      }
    },
    { timezone: "Asia/Kolkata", scheduled: true },
  );
  console.log(
    "✅ [COWORK-PUNCHOUT] Cowork punch-out offline sync scheduled (23:30 IST daily)",
  );
}

module.exports = {
  startCoworkPunchOutOfflineSync,
  runCoworkPunchOutOffline,
  /* Exported for tests. */
  shouldMarkOffline,
  offlinePatch,
  storedMode,
  onlineRowAtMs,
  istDayStartMs,
  istDateStr,
};
