// services/ppc/orderTargets.evaluate.js
//
// TARGET vs ACHIEVED, AS ARITHMETIC. No database: a target, the department's
// completion events (each `{ at, qty }`), the day being looked at — and out
// comes what was expected, what was done, where it fell short and what pace
// would recover it. Unit-tested in orderTargets.evaluate.test.js.
//
// Every date is an IST calendar day ("YYYY-MM-DD"); every instant is a Date.
"use strict";

const IST_MS = 330 * 60 * 1000;

const DEPARTMENT_META = Object.freeze({
  cutting:    { label: "Cutting",             done: "cut",          order: 1 },
  embroidery: { label: "Embroidery",          done: "embroidered",  order: 2 },
  printing:   { label: "Printing",            done: "printed",      order: 3 },
  washing:    { label: "Washing",             done: "washed",       order: 4 },
  trimming:   { label: "Trimming",            done: "trimmed",      order: 5 },
  ironing:    { label: "Ironing",             done: "ironed",       order: 6 },
  production: { label: "Production (sewing)", done: "completed",    order: 7 },
  qc:         { label: "Quality Control",     done: "passed QC",    order: 8 },
  packaging:  { label: "Packaging",           done: "packed",       order: 9 },
  dispatch:   { label: "Dispatch",            done: "dispatched",   order: 10 },
});

const KIND_META = Object.freeze({
  per_day:  { label: "Per day",         explain: "The same number of pieces every working day, from the first date to the last." },
  per_hour: { label: "Per hour",        explain: "The same number of pieces every hour, between two clock times, on each working day." },
  total:    { label: "Total by a date", explain: "One overall number to reach by the last date; the expected pace is spread evenly over the working days." },
});

/* ── day arithmetic (IST) ─────────────────────────────────────────────────── */
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (at) => { const d = new Date(new Date(at).getTime() + IST_MS); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const shiftDay = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const weekdayOf = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
/** The instant an IST day + "HH:MM" names. */
const instant = (ymd, hhmm = "00:00") => { const [y, m, d] = ymd.split("-").map(Number); const [h, mi] = hhmm.split(":").map(Number); return new Date(Date.UTC(y, m - 1, d, h, mi) - IST_MS); };
const minutesOf = (hhmm) => { const [h, m] = String(hhmm || "").split(":").map(Number); return h * 60 + m; };

/** The working days a target covers, in order. */
function targetDays(t) {
  const out = [];
  const working = new Set(t.workingDays?.length ? t.workingDays : [0, 1, 2, 3, 4, 5, 6]);
  for (let d = t.from, i = 0; d <= t.to && i < 400; d = shiftDay(d, 1), i++) if (working.has(weekdayOf(d))) out.push(d);
  return out;
}

/** The clock window on one day, as instants. Whole day when no hours are set. */
function dayWindow(t, ymd) {
  const start = instant(ymd, t.hoursFrom || "00:00");
  const end = t.hoursTo ? instant(ymd, t.hoursTo) : instant(shiftDay(ymd, 1), "00:00");
  return { start, end };
}

/** Hours in the clock window (fractional), 24 when none is set. */
function windowHours(t) {
  if (!t.hoursFrom || !t.hoursTo) return 24;
  return Math.max(0, (minutesOf(t.hoursTo) - minutesOf(t.hoursFrom)) / 60);
}

/** What the target expects on ONE working day. */
function expectedPerDay(t) {
  if (t.kind === "per_day") return t.pieces;
  if (t.kind === "per_hour") return Math.round(t.pieces * windowHours(t));
  const n = targetDays(t).length || 1;
  return t.pieces / n;
}

/** Pieces done inside a day's clock window. */
function doneOn(events, t, ymd) {
  const { start, end } = dayWindow(t, ymd);
  let n = 0;
  for (const e of events) { const at = new Date(e.at); if (at >= start && at < end) n += Number(e.qty) || 0; }
  return n;
}

/** Per-hour breakdown of one day inside the clock window (for per_hour targets). */
function hoursOn(events, t, ymd) {
  const fromMin = t.hoursFrom ? minutesOf(t.hoursFrom) : 0;
  const toMin = t.hoursTo ? minutesOf(t.hoursTo) : 24 * 60;
  const rows = [];
  for (let m = fromMin; m < toMin; m += 60) {
    const s = instant(ymd, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    const endMin = Math.min(m + 60, toMin);
    const e = instant(ymd, `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`);
    const frac = (endMin - m) / 60;
    let done = 0;
    for (const ev of events) { const at = new Date(ev.at); if (at >= s && at < e) done += Number(ev.qty) || 0; }
    const expected = Math.round(t.pieces * frac);
    rows.push({ label: `${pad(Math.floor(m / 60))}:${pad(m % 60)}–${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`, expected, done, short: Math.max(0, expected - done) });
  }
  return rows;
}

function statusOf(pct, { started, over }) {
  if (!started) return "not_started";
  if (pct >= 110) return "exceeded";
  if (pct >= 100) return "achieved";
  if (!over && pct >= 85) return "on_track";
  return "behind";
}

/**
 * Evaluate one target as of a day.
 *
 * @param {object} t        the stored target (plain object)
 * @param {Array}  events   that department's completion events for the order,
 *                          `{ at: Date, qty: number }`, any span
 * @param {string} asOfDay  the IST day being looked at (usually today)
 * @param {object} [extra]  { doneOverall, orderQuantity, now }
 */
function evaluateTarget(t, events, asOfDay, extra = {}) {
  const days = targetDays(t);
  const perDay = expectedPerDay(t);
  const now = extra.now ? new Date(extra.now) : new Date();
  const started = asOfDay >= t.from;
  const over = asOfDay > t.to;
  const covers = started && !over && days.includes(asOfDay);

  /* Day by day, up to the day being looked at (or the whole span if over). */
  /* How much of TODAY's target is due so far: the elapsed share of the
     target's clock window (or of the 09:30–18:30 shift when none is set).
     Before the window opens nothing is due, so a 08:00 reading does not call
     a whole day's target "behind"; after it closes the whole day is due. */
  const soFarFraction = (d) => {
    if (dayOf(now) !== d) return 1;
    const start = t.hoursFrom ? instant(d, t.hoursFrom) : instant(d, "09:30");
    const end = t.hoursTo ? instant(d, t.hoursTo) : instant(d, "18:30");
    if (end <= start) return 1;
    return Math.max(0, Math.min(1, (now - start) / (end - start)));
  };

  const rows = [];
  let expectedToDate = 0, doneToDate = 0;
  const cutoff = over ? t.to : asOfDay;
  for (const d of days) {
    if (d > cutoff) break;
    const done = doneOn(events, t, d);
    const expected = perDay;
    expectedToDate += expected * soFarFraction(d); doneToDate += done;
    rows.push({ date: d, expected: Math.round(expected), done, short: Math.max(0, Math.round(expected) - done), pct: expected ? Math.round((done / expected) * 100) : 0 });
  }
  const totalExpected = t.kind === "total" ? t.pieces : Math.round(perDay * days.length);
  const doneWholeSpan = days.reduce((n, d) => n + doneOn(events, t, d), 0);

  /* Today's own figure. For an hourly target the expected-so-far grows with
     the clock, so a 09:00 reading does not call a 10-hour target "behind". */
  let today = null;
  if (covers) {
    const done = doneOn(events, t, asOfDay);
    const expectedSoFar = Math.round(perDay * soFarFraction(asOfDay));
    today = {
      expected: Math.round(perDay), expectedSoFar, done, short: Math.max(0, Math.round(perDay) - done),
      pct: perDay ? Math.round((done / perDay) * 100) : 0,
      hours: t.kind === "per_hour" ? hoursOn(events, t, asOfDay) : null,
      window: t.hoursFrom && t.hoursTo ? `${t.hoursFrom}–${t.hoursTo}` : "whole day",
      efficiency: efficiencyOf(done, t, asOfDay, extra.standard, now),
    };
  }

  const pctToDate = expectedToDate ? Math.round((doneToDate / expectedToDate) * 100) : 0;
  const daysLeft = days.filter((d) => d > asOfDay).length;
  const remainingToTarget = Math.max(0, totalExpected - doneWholeSpan);
  const activeDays = rows.filter((r) => r.done > 0).length;
  const avgPerActiveDay = activeDays ? Math.round(doneToDate / activeDays) : 0;
  const neededPerDay = daysLeft ? Math.ceil(remainingToTarget / daysLeft) : null;
  const shortDays = rows.filter((r) => r.short > 0 && r.date < asOfDay);

  const nothingDueYet = started && !over && expectedToDate === 0 && doneToDate === 0;
  const status = nothingDueYet ? "not_started" : statusOf(over ? (totalExpected ? Math.round((doneWholeSpan / totalExpected) * 100) : 0) : pctToDate, { started, over });

  /* A sentence the floor can act on. */
  let advice;
  if (!started) advice = `Starts ${t.from}.`;
  else if (nothingDueYet) advice = `Nothing due yet — the ${t.hoursFrom && t.hoursTo ? `${t.hoursFrom}–${t.hoursTo}` : "09:30–18:30"} window has not opened.`;
  else if (over) advice = doneWholeSpan >= totalExpected ? `Met: ${doneWholeSpan} of ${totalExpected} by ${t.to}.` : `Missed: ${doneWholeSpan} of ${totalExpected} by ${t.to} (${totalExpected - doneWholeSpan} short).`;
  else if (remainingToTarget === 0) advice = `Target reached with ${daysLeft} day${daysLeft === 1 ? "" : "s"} to spare.`;
  else if (!daysLeft) advice = `Last day: ${remainingToTarget} more needed today.`;
  else if (neededPerDay > Math.round(perDay)) advice = `Behind by ${Math.max(0, Math.round(expectedToDate) - doneToDate)}: needs ${neededPerDay} a day for the remaining ${daysLeft} day${daysLeft === 1 ? "" : "s"} (target pace is ${Math.round(perDay)}).`;
  else advice = `On pace: ${neededPerDay} a day for the remaining ${daysLeft} day${daysLeft === 1 ? "" : "s"} finishes it.`;

  return {
    targetId: String(t._id || ""),
    department: t.department, kind: t.kind, pieces: t.pieces, from: t.from, to: t.to,
    hoursFrom: t.hoursFrom || "", hoursTo: t.hoursTo || "", note: t.note || "",
    days: days.length, perDay: Math.round(perDay), totalExpected,
    status, started, over, covers,
    today,
    toDate: { expected: Math.round(expectedToDate), done: doneToDate, pct: pctToDate, short: Math.max(0, Math.round(expectedToDate) - doneToDate) },
    span: { done: doneWholeSpan, remaining: remainingToTarget, daysLeft, neededPerDay, avgPerActiveDay, activeDays },
    order: { quantity: extra.orderQuantity ?? t.orderQuantity ?? 0, doneOverall: extra.doneOverall ?? null,
      remaining: extra.orderQuantity != null && extra.doneOverall != null ? Math.max(0, extra.orderQuantity - extra.doneOverall) : null },
    shortDays: shortDays.map((r) => ({ date: r.date, expected: r.expected, done: r.done, short: r.short })),
    rows,
    advice,
  };
}

/* ══ EFFICIENCY AND FEASIBILITY, FROM IE'S DEPARTMENT STANDARD ════════════
 *
 * A standard is { samMinutesPerPiece, operators, hoursPerDay, efficiencyPct }
 * (models/…/IeDepartmentStandard.js). Efficiency is the industry's own
 * figure: earned minutes (pieces × SAM) over the minutes the people were
 * there. Feasibility asks how long a quantity takes at that standard and
 * says, in words, when the dates PPC chose are far off it. */

/** Pieces a day / an hour at the standard. */
function capacityAt(std) {
  if (!std || !std.samMinutesPerPiece || !std.operators || !std.hoursPerDay) return null;
  const perDay = (std.operators * std.hoursPerDay * 60 * ((std.efficiencyPct || 100) / 100)) / std.samMinutesPerPiece;
  return { perDay: Math.max(1, Math.round(perDay)), perHour: Math.max(1, Math.round(perDay / std.hoursPerDay)), availableMinutesPerDay: Math.round(std.operators * std.hoursPerDay * 60) };
}

/** Efficiency for one day up to `now`: earned minutes vs available minutes. */
function efficiencyOf(done, t, ymd, std, now) {
  if (!std || !std.samMinutesPerPiece || !std.operators) return null;
  /* Available = operators × the hours of the target's window that have elapsed
     today (whole standard day when looking back at a past day). */
  const hoursWindow = t.hoursFrom && t.hoursTo ? windowHours(t) : (std.hoursPerDay || 8);
  let elapsedH = hoursWindow;
  if (dayOf(now) === ymd) {
    const { start } = dayWindow(t, ymd);
    const startAt = t.hoursFrom ? start : instant(ymd, "09:30");
    elapsedH = Math.max(0, Math.min(hoursWindow, (now - startAt) / 3600000));
  }
  const available = Math.round(std.operators * elapsedH * 60);
  const earned = Math.round(done * std.samMinutesPerPiece);
  return { earnedMinutes: earned, availableMinutes: available, pct: available ? Math.round((earned / available) * 100) : null, plannedPct: std.efficiencyPct || null };
}

/**
 * Is this target sensible against IE's standard and the department's other
 * commitments? Pure. `others` are the department's OTHER active targets
 * (any order) as stored objects.
 *
 * @returns {{ standard, required, given, busy, warnings: [{level, text}] }}
 */
function assessTarget(t, std, others = []) {
  const days = targetDays(t);
  const perDay = expectedPerDay(t);
  const total = t.kind === "total" ? t.pieces : Math.round(perDay * days.length);
  const warnings = [];
  const cap = capacityAt(std);
  const dept = DEPARTMENT_META[t.department]?.label || t.department;

  /* Busy: other targets whose dates overlap this one. */
  const overlapping = others.filter((o) => o.department === t.department && o.status === "active" && o.from <= t.to && o.to >= t.from);
  const otherLoad = overlapping.reduce((n, o) => n + expectedPerDay(o), 0);
  const busy = {
    free: overlapping.length === 0,
    commitments: overlapping.map((o) => ({ targetId: String(o._id || ""), moNumber: o.moNumber, from: o.from, to: o.to, perDay: Math.round(expectedPerDay(o)), description: describeTarget(o) })),
    otherPerDay: Math.round(otherLoad),
    combinedPerDay: Math.round(otherLoad + perDay),
  };

  let required = null;
  if (!cap) {
    warnings.push({ level: "info", text: `IE has not set a standard for ${dept} yet, so the time this needs cannot be worked out. Ask IE to set the SAM, operators and hours on IE Settings.` });
  } else {
    const minDays = Math.max(1, Math.ceil(total / cap.perDay - 1e-9));
    required = { workMinutes: Math.round(total * std.samMinutesPerPiece), minDays, exactDays: Math.round((total / cap.perDay) * 100) / 100, capacityPerDay: cap.perDay, capacityPerHour: cap.perHour, hours: Math.round((total / cap.perDay) * std.hoursPerDay * 10) / 10 };
    const givenDays = days.length;
    if (t.kind === "per_hour") {
      if (t.pieces > cap.perHour) warnings.push({ level: "warn", text: `Asks ${t.pieces} an hour; at IE's standard ${dept} does about ${cap.perHour} an hour (${std.operators} operators, ${std.samMinutesPerPiece} min a piece, ${std.efficiencyPct}% efficiency).` });
    } else if (Math.round(perDay) > cap.perDay) {
      warnings.push({ level: "warn", text: `Asks ${Math.round(perDay)} a day; at IE's standard ${dept} does about ${cap.perDay} a day. ${total} pieces needs at least ${minDays} working day${minDays === 1 ? "" : "s"} — extend the dates or lower the number.` });
    } else if (givenDays - minDays >= 1 && givenDays >= minDays * 1.5) {
      warnings.push({ level: "warn", text: `Generous: ${total} pieces needs about ${minDays} working day${minDays === 1 ? "" : "s"} at IE's standard (~${cap.perDay} a day), but ${givenDays} day${givenDays === 1 ? "" : "s"} were given. Either ask for more pieces or shorten the dates.` });
    }
    if (!busy.free && busy.combinedPerDay > cap.perDay) {
      warnings.push({ level: "warn", text: `${dept} is already committed to ${busy.otherPerDay} a day on ${overlapping.map((o) => o.moNumber).join(", ")} over these dates; with this that is ${busy.combinedPerDay} a day against about ${cap.perDay} it can do.` });
    }
  }
  if (!busy.free && !warnings.some((w) => w.text.startsWith(dept + " is already"))) {
    warnings.push({ level: "info", text: `${dept} is also working on ${overlapping.map((o) => `${o.moNumber} (${Math.round(expectedPerDay(o))} a day until ${o.to})`).join(", ")} over these dates.` });
  }
  return {
    standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, efficiencyPct: std.efficiencyPct, capacityPerDay: cap?.perDay ?? null, capacityPerHour: cap?.perHour ?? null } : null,
    required,
    given: { days: days.length, perDay: Math.round(perDay), total },
    busy,
    warnings,
  };
}

/** Describe a target in one sentence — used by the PPC form's live preview and every card. */
function describeTarget(t) {
  const dept = DEPARTMENT_META[t.department]?.label || t.department;
  const hours = t.hoursFrom && t.hoursTo ? ` between ${t.hoursFrom} and ${t.hoursTo}` : "";
  const span = t.from === t.to ? `on ${t.from}` : `from ${t.from} to ${t.to}`;
  const n = targetDays(t).length;
  if (t.kind === "per_day") return `${dept}: ${t.pieces} pieces a day${hours}, ${span} (${n} working day${n === 1 ? "" : "s"} → ${t.pieces * n} in total).`;
  if (t.kind === "per_hour") { const h = windowHours(t); return `${dept}: ${t.pieces} pieces an hour${hours}, ${span} (${Math.round(t.pieces * h)} a day → ${Math.round(t.pieces * h * n)} in total).`; }
  return `${dept}: ${t.pieces} pieces in total by ${t.to}, starting ${t.from} (${n} working day${n === 1 ? "" : "s"} → about ${Math.round(t.pieces / (n || 1))} a day).`;
}

module.exports = { DEPARTMENT_META, KIND_META, evaluateTarget, describeTarget, assessTarget, capacityAt, efficiencyOf, targetDays, expectedPerDay, dayOf, shiftDay, instant, windowHours };
