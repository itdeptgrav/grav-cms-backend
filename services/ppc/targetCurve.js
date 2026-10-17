"use strict";
// services/ppc/targetCurve.js
//
// THE SHAPE OF A TARGET — the ramp, and the hour by hour.
//
// A target used to be one number repeated: 260 a day, every day, and within a
// day 260 ÷ nine hours, every hour. No line in a garment factory works like
// that, and PPC knows it:
//
//   · A STYLE THAT IS NEW TO THE LINE ramps. The operators learn it: day one
//     is half the number, day two three quarters, and the line reaches its
//     own efficiency on day three or four. Planning the first day at the
//     steady-state number is how an order is called "behind" on the day it
//     started, and how the line stops believing the board.
//   · AN HOUR IS NOT AN HOUR. The hour before lunch and the hour after it are
//     not the hour at 11am, and the last hour of a shift carries the push.
//
// So a target carries a RAMP (what share of the day's number each of the
// first days asks for) and, within a day, an HOUR PLAN. Both are optional and
// both default to flat, which is exactly what every target written before
// this one meant — nothing is reinterpreted.
//
// WHAT IS PROMISED IS WHAT THE SHAPE ADDS UP TO. A ramp does not quietly
// shrink a commitment: `expectedOnDay` is what the department is asked for on
// that day, and the target's total is the sum of its days. The form shows
// that total before it is saved, so "50% on day one" is a choice made with
// the number in sight, not a discount discovered later.
//
// Pure: no database, no clock beyond what it is handed.

/** A day's share, as a percentage of the day's number. 100 = the full number. */
const MAX_RAMP_DAYS = 14;

/** Presets a planner recognises. The percentages are the share of the day's number. */
const RAMP_PRESETS = Object.freeze({
  none: [],
  gentle: [50, 75, 100],
  slow: [35, 55, 75, 90, 100],
  half_first_day: [50],
});

/** Clean what the form sent: whole percentages, 1–200, at most a fortnight. */
function normaliseRamp(input) {
  const list = Array.isArray(input) ? input : (RAMP_PRESETS[String(input || "")] || []);
  const out = [];
  for (const v of list.slice(0, MAX_RAMP_DAYS)) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 200) continue;
    out.push(n);
  }
  /* A ramp that ends below the full number would ask less for ever, which is
     a different target, not a ramp. The last day of the ramp is the day the
     line is expected to be up to speed. */
  while (out.length && out[out.length - 1] === 100) out.pop();
  return out;
}

/** The share for the n-th working day of the target (0-based). */
function dayFactor(ramp, index) {
  const list = Array.isArray(ramp) ? ramp : [];
  if (!list.length || index >= list.length) return 1;
  return list[index] / 100;
}

/**
 * What ONE day asks for.
 * @param base   the day's number when the line is up to speed
 * @param ramp   percentages for the first days
 * @param index  which working day of the target this is (0-based)
 */
const expectedOnDay = (base, ramp, index) => Math.round(base * dayFactor(ramp, index));

/** What the whole span asks for, with the ramp applied. */
function expectedTotal(base, ramp, days) {
  let n = 0;
  for (let i = 0; i < days; i++) n += expectedOnDay(base, ramp, i);
  return n;
}

/**
 * The day split into hours, with what each hour asks for.
 *
 * `hours` is an explicit plan — `[{ from, to, pieces }]` — when PPC has typed
 * one; otherwise the day's number is spread evenly across the window and the
 * rounding is carried, so the hours always add up to the day exactly rather
 * than to one or two less.
 */
function hourPlan({ hoursFrom, hoursTo, hours }, dayPieces) {
  const explicit = (Array.isArray(hours) ? hours : []).filter((h) => h && h.from && h.to && Number(h.pieces) >= 0);
  if (explicit.length) {
    return explicit.map((h) => ({ from: String(h.from), to: String(h.to), pieces: Math.round(Number(h.pieces)) }));
  }
  const fromMin = toMinutes(hoursFrom || "00:00");
  const toMin = toMinutes(hoursTo || "24:00");
  const slots = Math.max(1, Math.ceil((toMin - fromMin) / 60));
  const out = [];
  let left = Math.round(dayPieces);
  for (let i = 0; i < slots; i++) {
    const start = fromMin + i * 60;
    const end = Math.min(toMin, start + 60);
    const share = Math.round(left / (slots - i));
    left -= share;
    out.push({ from: hhmm(start), to: hhmm(end), pieces: share });
  }
  return out;
}

/** What is due by a moment inside the day, from the hour plan. */
function dueByMinute(plan, minute) {
  let n = 0;
  for (const h of plan) {
    const from = toMinutes(h.from), to = toMinutes(h.to);
    if (minute >= to) { n += h.pieces; continue; }
    if (minute <= from) break;
    /* Part-way through an hour, that hour's share is due in proportion — the
       same rule the flat target always used, applied per hour. */
    n += Math.round(h.pieces * ((minute - from) / Math.max(1, to - from)));
    break;
  }
  return n;
}

const toMinutes = (hhmmStr) => {
  const [h, m] = String(hhmmStr || "0:0").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Said in one clause, for the target's sentence. */
function describeRamp(ramp) {
  const list = normaliseRamp(ramp);
  if (!list.length) return "";
  return `ramping ${list.map((p) => `${p}%`).join(" → ")} over the first ${list.length} day${list.length === 1 ? "" : "s"}, then the full number`;
}

module.exports = { MAX_RAMP_DAYS, RAMP_PRESETS, normaliseRamp, dayFactor, expectedOnDay, expectedTotal, hourPlan, dueByMinute, describeRamp, toMinutes };
