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

const cv = require("./targetCurve");
const minutesOfClock = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/** The day's number when the line is up to speed — before the ramp. */
function basePerDay(t) {
  if (t.kind === "per_day") return t.pieces;
  if (t.kind === "per_hour") return Math.round(t.pieces * windowHours(t));
  const n = targetDays(t).length || 1;
  return t.pieces / n;
}

/**
 * What the target expects on ONE working day.
 *
 * With `index` — which working day of the target it is — the ramp applies, so
 * day one of a new style asks for its share and not the steady number. Called
 * without one (every reader written before ramps), it answers the steady
 * number exactly as it always did.
 */
function expectedPerDay(t, index = null) {
  const base = basePerDay(t);
  return index == null ? base : cv.expectedOnDay(base, t.ramp, index);
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
  const days = Array.isArray(t.dayPlan) && t.dayPlan.length
    ? [...new Set(t.dayPlan.map((b) => b.date).filter(Boolean))].sort()
    : targetDays(t);
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

  /* THE RAMP MOVES EVERY FIGURE BELOW (16 Oct 2026). Each working day asks
     for its own share — half on day one of a new style — so "expected", "so
     far", "short" and the span's total are all read off the shape rather
     than off one repeated number. With no ramp, `expectedOnDay` IS that
     number and every figure is what it was. */
  const ramp = Array.isArray(t.ramp) ? t.ramp : [];
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  /* With a cap, each day asks the shape's figure or what is still unasked,
     whichever is smaller, so the pace stops when the quantity is reached. */
  const cap = Number(t.cap) > 0 && t.kind !== "total" ? Number(t.cap) : null;
  const askedByDay = new Map();
  { let left = cap ?? Infinity; for (const d of days) { const shape = cv.expectedOnDay(perDay, ramp, dayIndex.get(d) ?? 0); const a = Math.max(0, Math.min(shape, left)); askedByDay.set(d, a); left -= a; } }
  /* A batch plan replaces the shape: each day asks what its batches deliver. */
  const batches = Array.isArray(t.dayPlan) ? t.dayPlan.filter((b) => b && b.date) : [];
  if (batches.length) {
    askedByDay.clear();
    for (const b of batches) askedByDay.set(b.date, (askedByDay.get(b.date) || 0) + (Number(b.pieces) || 0));
  }
  const askedOn = (d) => askedByDay.get(d) ?? 0;

  const rows = [];
  let expectedToDate = 0, doneToDate = 0;
  const cutoff = over ? t.to : asOfDay;
  for (const d of days) {
    if (d > cutoff) break;
    const done = doneOn(events, t, d);
    const expected = askedOn(d);
    /* Today's share of a batch plan is the batches already due, not a
       straight fraction of the day: a lay still on the table owes nothing. */
    const dueToday = batches.length && dayOf(now) === d
      ? batches.filter((b) => b.date === d).reduce((nn, b) => nn + (((b.time ? minutesOfClock(b.time) : minutesOfClock(t.hoursTo || "18:30")) <= Math.round((now - instant(d, "00:00")) / 60000)) ? (Number(b.pieces) || 0) : 0), 0)
      : null;
    expectedToDate += dueToday != null ? dueToday : expected * soFarFraction(d); doneToDate += done;
    rows.push({ date: d, expected: Math.round(expected), done, short: Math.max(0, Math.round(expected) - done), pct: expected ? Math.round((done / expected) * 100) : 0, ramped: ramp.length > 0 && (dayIndex.get(d) ?? 99) < ramp.length });
  }
  const totalExpected = t.kind === "total" ? t.pieces : days.reduce((nn, d) => nn + askedOn(d), 0);
  const doneWholeSpan = days.reduce((n, d) => n + doneOn(events, t, d), 0);

  /* Today's own figure. For an hourly target the expected-so-far grows with
     the clock, so a 09:00 reading does not call a 10-hour target "behind". */
  let today = null;
  if (covers) {
    const done = doneOn(events, t, asOfDay);
    const asked = askedOn(asOfDay);
    /* What is due SO FAR comes from the hour plan — the hours typed by hand,
       or today's number spread across the window — rather than from a flat
       share of the day, so an hour that was never going to carry its ninth
       of the day is not counted as if it had. */
    const minuteNow = dayOf(now) === asOfDay ? Math.round((now - instant(asOfDay, "00:00")) / 60000) : 24 * 60;
    /* A batch is due whole at its time — nothing before it, all of it after;
       a batch with no time is due at the end of the window. A paced target
       is due hour by hour as before. */
    const todays = batches.filter((b) => b.date === asOfDay);
    const windowEnd = minutesOfClock(t.hoursTo || "18:30");
    const plan = todays.length
      ? todays.map((b) => ({ from: b.time || t.hoursTo || "18:30", to: b.time || t.hoursTo || "18:30", pieces: Number(b.pieces) || 0, label: b.label || "" }))
      : cv.hourPlan({ hoursFrom: t.hoursFrom || "09:30", hoursTo: t.hoursTo || "18:30", hours: t.hours }, asked);
    const expectedSoFar = todays.length
      ? todays.reduce((nn, b) => nn + ((b.time ? minutesOfClock(b.time) : windowEnd) <= minuteNow ? (Number(b.pieces) || 0) : 0), 0)
      : cv.dueByMinute(plan, minuteNow);
    today = {
      expected: Math.round(asked), expectedSoFar, done, short: Math.max(0, Math.round(asked) - done),
      pct: asked ? Math.round((done / asked) * 100) : 0,
      ramped: ramp.length > 0 && (dayIndex.get(asOfDay) ?? 99) < ramp.length,
      plan,
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
  /* The standing in one formal sentence: condition, figures, required rate
     (16 Oct 2026 — the earlier wording was conversational). */
  let advice;
  if (!started) advice = `Scheduled to start on ${dayWords(t.from)}.`;
  else if (nothingDueYet) advice = `No quantity is due yet; the ${t.hoursFrom && t.hoursTo ? `${t.hoursFrom}–${t.hoursTo}` : "09:30–18:30"} window has not opened.`;
  else if (over) advice = doneWholeSpan >= totalExpected ? `Achieved: ${doneWholeSpan} of ${totalExpected} by ${dayWords(t.to)}.` : `Not achieved: ${doneWholeSpan} of ${totalExpected} by ${dayWords(t.to)}; shortfall ${totalExpected - doneWholeSpan}.`;
  else if (remainingToTarget === 0) advice = `Target achieved with ${daysLeft} working day${daysLeft === 1 ? "" : "s"} remaining.`;
  else if (!daysLeft) advice = `Final day: ${remainingToTarget} required today.`;
  else if (neededPerDay > Math.round(perDay)) advice = `Behind plan by ${Math.max(0, Math.round(expectedToDate) - doneToDate)}. Required rate: ${neededPerDay} per day for the remaining ${daysLeft} working day${daysLeft === 1 ? "" : "s"} (planned rate ${Math.round(perDay)}).`;
  else advice = `On plan. Required rate: ${neededPerDay} per day for the remaining ${daysLeft} working day${daysLeft === 1 ? "" : "s"}.`;

  return {
    targetId: String(t._id || ""),
    department: t.department, kind: t.kind, pieces: t.pieces, from: t.from, to: t.to,
    hoursFrom: t.hoursFrom || "", hoursTo: t.hoursTo || "", note: t.note || "",
    /* the shape, so a reader can draw the plan the way it is evaluated */
    workingDays: Array.isArray(t.workingDays) ? t.workingDays : [], ramp: Array.isArray(t.ramp) ? t.ramp : [],
    hours: Array.isArray(t.hours) ? t.hours : [], cap: t.cap ?? null,
    dayPlan: Array.isArray(t.dayPlan) ? t.dayPlan.map((b) => ({ date: b.date, time: b.time || "", pieces: b.pieces, label: b.label || "", workOrderId: b.workOrderId || "", layKey: b.layKey || "" })) : [],
    planSource: t.planSource || "",
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

/** A day as people read it: "3 Oct 2026" (27 Sep 2026 — ISO dates were printed in every sentence). */
const dayWords = (ymd) => { const [y, m, d] = String(ymd).split("-").map(Number); return y && m && d ? `${d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${y}` : String(ymd || ""); };

/** Describe a target in one sentence — used by the PPC form's live preview and every card. */
function describeTarget(t) {
  const dept = DEPARTMENT_META[t.department]?.label || t.department;
  if (Array.isArray(t.dayPlan) && t.dayPlan.length) {
    const byDay = new Map();
    for (const b of t.dayPlan) byDay.set(b.date, (byDay.get(b.date) || 0) + (Number(b.pieces) || 0));
    const total = [...byDay.values()].reduce((nn, x) => nn + x, 0);
    const days = [...byDay.keys()].sort();
    const span = days.length === 1 ? `on ${dayWords(days[0])}` : `over ${days.length} days, ${dayWords(days[0])} to ${dayWords(days[days.length - 1])}`;
    /* a plan by work order: day by day or hour by hour, with how many work
       orders and slots it covers */
    const wos = new Set(t.dayPlan.map((b) => b.workOrderId).filter(Boolean)).size;
    const woWords = wos ? ` across ${wos} work order${wos === 1 ? "" : "s"}` : "";
    /* Batches — "Lay 3", "Loads 1–2", "Run 4" — each due when it comes off;
       and dispatch's "Shipment 2" days. */
    const BATCH = /^(Lay|Load|Run)s? (\d+)(?:–(\d+))?/;
    const kinds = new Set(), batchNos = new Set();
    for (const b of t.dayPlan) { const m = BATCH.exec(b.label || ""); if (m) { kinds.add(m[1]); for (let i = Number(m[2]); i <= Number(m[3] || m[2]) && i < Number(m[2]) + 50; i++) batchNos.add(i); } }
    if (batchNos.size && kinds.size === 1 && t.dayPlan.every((b) => BATCH.test(b.label || ""))) {
      const word = { Lay: ["lay", "lays"], Load: ["load", "loads"], Run: ["run", "runs"] }[[...kinds][0]];
      return `${dept}: ${total} garments${woWords} in ${batchNos.size} ${batchNos.size === 1 ? word[0] : word[1]} ${span}; each ${word[0]}'s garments are due when it comes off.`;
    }
    const ships = new Set(t.dayPlan.map((b) => (/^Shipment (\d+)/.exec(b.label || "") || [])[1]).filter(Boolean));
    if (ships.size && t.dayPlan.every((b) => /^Shipment \d+/.test(b.label || ""))) {
      return `${dept}: ${total} garments${woWords} in ${ships.size} shipment${ships.size === 1 ? "" : "s"} ${span}; each day's shipment is due by the end of its day.`;
    }
    const hourly = t.dayPlan.every((b) => /^\d{2}:\d{2}–\d{2}:\d{2}$/.test(b.label || ""));
    if (hourly) {
      const hours = new Set(t.dayPlan.map((b) => `${b.date} ${b.time}`)).size;
      return `${dept}: ${total} garments${woWords}, hour by hour ${span}, in ${hours} planned hour${hours === 1 ? "" : "s"}; each hour's garments are due by its end.`;
    }
    if (wos || t.dayPlan.every((b) => !b.time && !b.label)) return `${dept}: ${total} garments${woWords}, day by day ${span}; each day's garments are due by the end of the day.`;
    return `${dept}: ${total} garments in ${t.dayPlan.length} batch${t.dayPlan.length === 1 ? "" : "es"} ${span}, each due when its lay is cut.`;
  }
  /* A scoped target says so in its own sentence, or two targets on the same
     department read as the same promise written twice (16 Oct 2026). */
  const on = t.scope && t.scope.kind === "work_orders" && t.scope.label ? ` on ${t.scope.label}` : "";
  const ramped = cv.describeRamp(t.ramp);
  const ramp = ramped ? ` — ${ramped}` : "";
  const capWords = Number(t.cap) > 0 && t.kind !== "total" ? ` until ${t.cap} are done` : "";
  const hours = t.hoursFrom && t.hoursTo ? ` between ${t.hoursFrom} and ${t.hoursTo}` : "";
  const span = t.from === t.to ? `on ${dayWords(t.from)}` : `from ${dayWords(t.from)} to ${dayWords(t.to)}`;
  const n = targetDays(t).length;
  if (t.kind === "per_day") return `${dept}${on}: ${t.pieces} pieces a day${hours}${capWords}, ${span}${ramp} (${n} working day${n === 1 ? "" : "s"} → ${Number(t.cap) > 0 ? Math.min(t.cap, cv.expectedTotal(t.pieces, t.ramp, n)) : cv.expectedTotal(t.pieces, t.ramp, n)} in total).`;
  if (t.kind === "per_hour") { const h = windowHours(t); const day = Math.round(t.pieces * h); const all = cv.expectedTotal(day, t.ramp, n); return `${dept}${on}: ${t.pieces} pieces an hour${hours}${capWords}, ${span}${ramp} (${day} a day → ${Number(t.cap) > 0 ? Math.min(t.cap, all) : all} in total).`; }
  return `${dept}${on}: ${t.pieces} pieces in total by ${dayWords(t.to)}, starting ${dayWords(t.from)} (${n} working day${n === 1 ? "" : "s"} → about ${Math.round(t.pieces / (n || 1))} a day).`;
}

module.exports = { DEPARTMENT_META, KIND_META, evaluateTarget, describeTarget, assessTarget, capacityAt, efficiencyOf, targetDays, expectedPerDay, doneOn, dayOf, shiftDay, instant, windowHours };
