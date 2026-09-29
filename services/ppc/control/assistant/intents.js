// services/ppc/control/assistant/intents.js
//
// THE PRODUCTION ASSISTANT'S UNDERSTANDING — pure, deterministic, tested.
//
// A question in English becomes { intent, entities }. No model is involved:
// the words are matched against a small vocabulary of departments, dates,
// identifiers and question shapes. When a language model is connected later
// it will produce THIS SAME shape (an intent and its entities) as a tool call,
// and engine.js answers it from the same reporting services — so nothing built
// here is thrown away.
//
// Entities: department, date/from/to (IST "YYYY-MM-DD"), hoursFrom/hoursTo
// ("HH:MM"), po, mo, wo, barcode, product, size, variant, person, days.
"use strict";

const shift = require("../../../manufacturing/shiftHours");

const DEPARTMENT_WORDS = [
  ["cutting", /\b(cutting|cut|cutter|cutting master)\b/],
  ["embroidery", /\b(embroidery|embroider(ed|y)?|emb)\b/],
  ["printing", /\b(printing|print(ed|s)?)\b/],
  ["washing", /\b(washing|wash(ed)?)\b/],
  ["trimming", /\b(trimming|trim(med)?)\b/],
  ["ironing", /\b(ironing|iron(ed)?|pressing)\b/],
  ["production", /\b(sewing|sew(n|ed)?|stitching|stitch(ed)?|production line|sewing line|production department|production floor)\b/],
  ["qc", /\b(qc|quality|inspection|inspect(ed)?|passed qc|quality control)\b/],
  ["packaging", /\b(packaging|packing|packed|pack|cartons?)\b/],
  ["dispatch", /\b(dispatch(ed|es)?|shipping|shipped|delivered|challan)\b/],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");

function normalize(text) {
  /* a possessive ("today's", "Kumar's") loses its 's before the quotes go */
  return String(text || "").replace(/(['’])s\b/g, "").replace(/[“”"'’]/g, "").replace(/\s+/g, " ").trim();
}

/* ── dates ──────────────────────────────────────────────────────────────── */

function clockOf(h, m, ampm) {
  let hh = Number(h); const mm = Number(m || 0);
  if (ampm) { const p = ampm.toLowerCase(); if (p.startsWith("p") && hh < 12) hh += 12; if (p.startsWith("a") && hh === 12) hh = 0; }
  return `${pad(hh)}:${pad(mm)}`;
}

function extractDates(lower, today) {
  const out = {};
  const day = (n) => shift.shiftDayKey(today, n);
  const y = Number(today.slice(0, 4));
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/g) || [];
  if (iso.length >= 2) { out.from = iso[0]; out.to = iso[1]; } else if (iso.length === 1) out.date = iso[0];
  const dmy = [...lower.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/g)].filter((m) => Number(m[2]) <= 12);
  if (!iso.length && dmy.length) {
    const toYmd = (m) => `${m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : y}-${pad(m[2])}-${pad(m[1])}`;
    if (dmy.length >= 2) { out.from = toYmd(dmy[0]); out.to = toYmd(dmy[1]); } else out.date = toYmd(dmy[0]);
  }
  const named = [...lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/g)];
  if (!out.date && !out.from && named.length) {
    const toYmd = (m) => `${m[3] || y}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(m[1])}`;
    if (named.length >= 2) { out.from = toYmd(named[0]); out.to = toYmd(named[1]); } else out.date = toYmd(named[0]);
  }
  if (/\bday before yesterday\b/.test(lower)) out.date = day(-2);
  else if (/\byesterday\b/.test(lower)) { if (/\b(vs|versus|compare|against)\b/.test(lower) && /\btoday\b/.test(lower)) { out.from = day(-1); out.to = today; out.compare = true; } else out.date = day(-1); }
  else if (/\btoday\b|\bright now\b|\bcurrently\b|\bnow\b/.test(lower) && !out.date && !out.from) out.date = today;
  if (/\bthis week\b/.test(lower)) { const wd = new Date(shift.istDayWindow(today).start.getTime() + shift.IST_OFFSET_MS).getUTCDay(); const back = (wd + 6) % 7; out.from = day(-back); out.to = today; }
  else if (/\blast week\b/.test(lower)) { const wd = new Date(shift.istDayWindow(today).start.getTime() + shift.IST_OFFSET_MS).getUTCDay(); const back = (wd + 6) % 7; out.from = day(-back - 7); out.to = day(-back - 1); }
  else if (/\bthis month\b/.test(lower)) { out.from = `${today.slice(0, 7)}-01`; out.to = today; }
  else if (/\blast month\b/.test(lower)) { const [yy, mm] = today.split("-").map(Number); const prev = new Date(Date.UTC(yy, mm - 2, 1)); const last = new Date(Date.UTC(yy, mm - 1, 0)); out.from = prev.toISOString().slice(0, 10); out.to = last.toISOString().slice(0, 10); }
  const lastN = lower.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/);
  if (lastN) { out.from = day(-(Number(lastN[1]) - 1)); out.to = today; out.days = Number(lastN[1]); }
  else if (/\blast\s+(seven|7)\s+days\b/.test(lower)) { out.from = day(-6); out.to = today; }
  /* hours: "between 11 am and 2 pm", "from 10:30 to 13:30", "11-2 pm" */
  const hrs = lower.match(/\b(?:between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:and|to|-|–)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) || lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (hrs) {
    const a1 = hrs[3] || (hrs[6] && Number(hrs[1]) <= Number(hrs[4]) ? hrs[6] : hrs[6]);
    out.hoursFrom = clockOf(hrs[1], hrs[2], hrs[3] || (hrs[6] && Number(hrs[1]) < 12 && Number(hrs[1]) <= Number(hrs[4]) ? hrs[6] : null));
    out.hoursTo = clockOf(hrs[4], hrs[5], hrs[6]);
    if (out.hoursTo <= out.hoursFrom && !hrs[3]) out.hoursFrom = clockOf(hrs[1], hrs[2], "am");
    void a1;
  }
  return out;
}

/* ── identifiers ────────────────────────────────────────────────────────── */

function extractIds(text) {
  const out = {};
  const raw = String(text);
  const bc = raw.match(/\bWO-([0-9a-f]{8}|[0-9a-f]{24})-(\d{1,4})\b/i);
  if (bc) out.barcode = bc[0].toUpperCase();
  const wo = !bc && raw.match(/\bWO[-\s]?([0-9a-f]{6,24})\b/i);
  if (wo) out.wo = `WO-${wo[1].toLowerCase()}`;
  const mo = raw.match(/\b(?:MO[-\s]?)?(REQ-\d{4}-\d{3,5}|CR-[A-Z0-9-]+|FLOWDEMO-[A-Z0-9-]+)\b/i);
  if (mo) out.mo = `MO-${mo[1].toUpperCase()}`;
  const moShort = !mo && raw.match(/\b(?:mo|order)\s*(?:number|no\.?|#)?\s*(\d{3,5})\b/i);
  if (moShort) out.moSuffix = moShort[1];
  const po = raw.match(/\bPO\s*(?:number|no\.?|#|:)?\s*([A-Z0-9][A-Z0-9\/-]{1,30})\b/i);
  if (po && !/^(number|no|status|progress|for|of|is|xx+)$/i.test(po[1])) out.po = po[1];
  const size = raw.match(/\bsize\s*[:=]?\s*([A-Za-z0-9]{1,5})\b/i);
  if (size) out.size = size[1].toUpperCase();
  const product = raw.match(/\b(?:product|style|item)\b\s*[:=]?\s*(?:called\s+|named\s+)?([A-Za-z][A-Za-z0-9 &\-]{1,40}?)(?=\s+(?:is|are|completed|done|progress|status|today|for|on|in|of|between|from|by)\b|[?.,]|$)/i);
  if (product) out.product = product[1].trim();
  const person = raw.match(/\b(?:employee|person|worker|staff)\s*[:=]?\s*(?:called\s+|named\s+)?([A-Za-z][A-Za-z .]{1,40}?)(?=\s+(?:is|s|'s|order|status|progress|production|for|on|in|of)\b|[?.,]|$)/i);
  if (person && !/^(x|wise|orders?|production|progress)$/i.test(person[1].trim())) out.person = person[1].trim();
  const variant = raw.match(/\b(?:variant|colou?r)\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9 \-·]{0,30}?)(?=\s+(?:is|are|progress|status|for|on|in|of)\b|[?.,]|$)/i);
  if (variant && !/^(wise|progress)$/i.test(variant[1].trim())) out.variant = variant[1].trim();
  return out;
}

function extractDepartment(lower) {
  for (const [key, re] of DEPARTMENT_WORDS) if (re.test(lower)) return key;
  return null;
}

/* ── the intent ─────────────────────────────────────────────────────────── */

const INTENTS = Object.freeze({
  summary_today: "Today's production summary",
  department_today: "One department today",
  hourly: "Hour-wise production",
  compare_days: "Compare two days",
  departments_behind: "Departments behind target",
  department_best: "Best department today",
  orders_delayed: "Delayed orders",
  orders_near_completion: "Orders close to completion",
  order_status: "One order's status",
  wo_status: "One work order's status",
  unit_status: "One unit (barcode)",
  target_status: "Target status",
  target_missed: "Targets missed on a day",
  report_summary: "A production report",
  product_progress: "A product or variant's progress",
  person_wise: "Person-wise production",
  delay_cause: "Where the delay is",
  pending_quantity: "What is pending",
  recovery_pace: "The recovery pace required",
  help: "What the assistant can answer",
});

function detectIntent(lower, e) {
  const has = (re) => re.test(lower);
  if (has(/\b(help|what can you (do|answer)|how do i|what questions)\b/)) return "help";
  if (e.barcode) return "unit_status";
  if (e.wo) return "wo_status";
  if (has(/\b(person[- ]?wise|employee[- ]?wise|per person|per employee|each person|each employee|mpc|measurement order)\b/) || (e.person && (e.po || e.mo))) return "person_wise";
  if (e.person) return "person_wise";
  if (has(/\b(hour[- ]?wise|hourly|by (the )?hour|each hour|every hour|per hour|which hour|highest production hour|peak hour)\b/) || (e.hoursFrom && e.hoursTo)) return "hourly";
  if (e.compare || has(/\b(compare|versus|vs)\b.*\b(yesterday|today|day)\b/)) return "compare_days";
  if (has(/\b(missed|miss)\b.*\btarget/) || (has(/\btarget/) && has(/\byesterday\b/) && has(/\b(which|who|missed)\b/))) return "target_missed";
  if (has(/\bwhich department/) && has(/\b(behind|missed|short|lagging|under)\b/)) return "departments_behind";
  if (has(/\b(behind|lagging|under target|short of target)\b/) && has(/\bdepartments?\b/) && !e.po && !e.mo) return "departments_behind";
  if (has(/\b(best|top|highest|most productive|performing best|best performing)\b/) && has(/\bdepartment/)) return "department_best";
  if (has(/\b(recovery|recover|required (rate|pace)|what pace|pace (is )?required|rate (is )?required|needed per (hour|day)|how much more)\b/)) return "recovery_pace";
  if (has(/\b(causing|cause of|reason for|why).*\b(delay|late|behind)\b/) || has(/\b(delay|late|behind)\b.*\b(caus|because|why)\b/)) return "delay_cause";
  if (has(/\b(delayed|falling behind|late|overdue|at risk|behind schedule|delay)\b/) && !e.po && !e.mo) return "orders_delayed";
  if (has(/\b(close to completion|near(ly)? complete|almost (done|complete|finished)|about to (finish|complete)|nearly done)\b/)) return "orders_near_completion";
  if (has(/\b(pending|remain(s|ing)?|left|outstanding|balance)\b/) && !e.po && !e.mo && !e.product && !e.size) return "pending_quantity";
  if (has(/\btarget/) || has(/\bachiev/)) return "target_status";
  /* "report", "day-end" and a multi-day span are a REPORT; a bare "summary"
     of today is the summary. */
  const reportish = has(/\b(report|day[- ]?end|end[- ]of[- ]day|eod|department[- ]?wise|dept[- ]?wise)\b/);
  if (reportish && !e.po && !e.mo) return e.department && !has(/\b(report|department[- ]?wise|dept[- ]?wise)\b/) ? "department_today" : "report_summary";
  /* a span of days ("this week", "last 7 days", "10 Sep to 14 Sep") is a report */
  if (e.from && e.to && e.from !== e.to && !e.po && !e.mo && !e.moSuffix && !e.product && !e.size && !e.variant) return "report_summary";
  if (e.po || e.mo || e.moSuffix) return "order_status";
  if (e.product || e.size || e.variant) return "product_progress";
  if (e.department) return "department_today";
  if (has(/\b(production|how is|how's|status|update|going|doing|made|output)\b/)) return "summary_today";
  return "help";
}

/**
 * @param {string} text   the question
 * @param {string} today  IST "YYYY-MM-DD"
 */
function parse(text, today = shift.istDayWindow().label) {
  const clean = normalize(text);
  const lower = clean.toLowerCase();
  const entities = { ...extractDates(lower, today), ...extractIds(clean) };
  entities.department = extractDepartment(lower);
  const intent = detectIntent(lower, entities);
  /* a date-less "today" question is about today */
  if (!entities.date && !entities.from && ["summary_today", "department_today", "hourly", "departments_behind", "department_best", "target_status", "report_summary", "recovery_pace", "pending_quantity"].includes(intent)) entities.date = today;
  if (intent === "compare_days" && !entities.from) { entities.from = shift.shiftDayKey(today, -1); entities.to = today; }
  return { intent, label: INTENTS[intent], entities, text: clean };
}

module.exports = { parse, normalize, extractDates, extractIds, extractDepartment, detectIntent, INTENTS, DEPARTMENT_WORDS };
