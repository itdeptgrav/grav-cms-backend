"use strict";
/**
 * services/ai/commandSearch/words.js — reading what was typed into Cmd/Ctrl K,
 * the same way in every application.
 *
 * First written inside the books' search; moved here when HR became the third
 * application so "this month", "sales vouchers" and "leaves" are understood
 * identically everywhere. No database, no model — strings in, values out.
 */

const { singularForms } = require("../storeCommandIntent");

const text = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const escapeRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactRx = (v) => new RegExp(`^${escapeRx(String(v).trim())}$`, "i");
const containsRx = (v) => new RegExp(escapeRx(String(v).trim()), "i");
const plural = (label) => (/(s|x|ch|sh)$/i.test(label) ? label : /[^aeiou]y$/i.test(label) ? label.replace(/y$/i, "ies") : `${label}s`);

/** The longest of these names the text contains, on word boundaries, in any singular form. */
function longestName(textIn, entries) {
  /* Every word may carry the plural, not only the last: "sales vouchers this
     FY" has its plural in the MIDDLE, and the shared grammar's forms (which
     singularise the last word, or all of them at once) never produced "sales
     voucher" from it — found on the live books. */
  const lower = String(textIn || "").toLowerCase();
  const words = lower.split(/\s+/);
  const forms = [...new Set([
    lower,
    ...singularForms(lower),
    ...words.map((word, i) => {
      if (!/s$/.test(word) || word.length <= 3) return null;
      const singular = /ies$/.test(word) ? word.replace(/ies$/, "y") : word.replace(/s$/, "");
      return [...words.slice(0, i), singular, ...words.slice(i + 1)].join(" ");
    }).filter(Boolean),
  ])];
  let best = null;
  for (const entry of entries) {
    for (const name of entry.names) {
      const rx = new RegExp(`(^|[^a-z0-9/])${escapeRx(name)}($|[^a-z0-9/])`, "i");
      if (forms.some((form) => rx.test(form)) && (!best || name.length > best.name.length)) best = { entry, name };
    }
  }
  return best;
}

/** Remove a phrase, and its plural, from the text. */
function strip(textIn, phrase) {
  if (!phrase) return textIn;
  /* "policy" also takes "policies" with it. */
  const forms = [escapeRx(phrase), /[^aeiou]y$/i.test(phrase) ? `${escapeRx(phrase.slice(0, -1))}ies` : null].filter(Boolean);
  const rx = new RegExp(`(^|\\s)(?:${forms.join("|")})(e?s)?(?=\\s|$)`, "ig");
  return textIn.replace(rx, " ");
}

/* ── PERIODS PEOPLE SAY ────────────────────────────────────────────────────
   In IST, like every date rule in this system: `Date.now() + 5.5h`, then read
   with getUTC*. A named month, a year or a dated day comes from the shared
   grammar (`dateRangeFrom`); these are the ones that need today's date. */
const IST = 5.5 * 60 * 60 * 1000;
const DAY = 86400000;
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoOf = (ms) => { const t = new Date(ms); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function periodFrom(raw, now = Date.now()) {
  const t = String(raw || "").toLowerCase();
  const ist = new Date(now + IST);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1;
  const d = ist.getUTCDate();
  const today = Date.UTC(y, m - 1, d);
  const fyStart = m >= 4 ? y : y - 1;
  const span = (from, to, source) => ({ from, to, source });
  let match = t.match(/\b(?:fy\s*)?(20\d\d)\s*-\s*(\d\d)\b/);
  if (match && Number(match[2]) === (Number(match[1]) + 1) % 100) {
    const s = Number(match[1]);
    return span(ymd(s, 4, 1), ymd(s + 1, 3, 31), match[0]);
  }
  if ((match = t.match(/\b(this|current) (financial year|fy)\b/))) return span(ymd(fyStart, 4, 1), ymd(fyStart + 1, 3, 31), match[0]);
  if ((match = t.match(/\blast (financial year|fy)\b/))) return span(ymd(fyStart - 1, 4, 1), ymd(fyStart, 3, 31), match[0]);
  /* "this year" is the financial year in the books and the calendar year in
     HR; the caller says which. */
  if ((match = t.match(/\b(this|current) year\b/))) return span(ymd(fyStart, 4, 1), ymd(fyStart + 1, 3, 31), match[0]);
  if ((match = t.match(/\blast year\b/))) return span(ymd(fyStart - 1, 4, 1), ymd(fyStart, 3, 31), match[0]);
  if ((match = t.match(/\b(this|current) month\b/))) return span(ymd(y, m, 1), ymd(y, m, lastDay(y, m)), match[0]);
  if ((match = t.match(/\blast month\b/))) {
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    return span(ymd(py, pm, 1), ymd(py, pm, lastDay(py, pm)), match[0]);
  }
  if ((match = t.match(/\bnext month\b/))) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return span(ymd(ny, nm, 1), ymd(ny, nm, lastDay(ny, nm)), match[0]);
  }
  /* A week runs Monday to Sunday. */
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  if ((match = t.match(/\b(this|current) week\b/))) return span(isoOf(monday), isoOf(monday + 6 * DAY), match[0]);
  if ((match = t.match(/\blast week\b/))) return span(isoOf(monday - 7 * DAY), isoOf(monday - DAY), match[0]);
  if ((match = t.match(/\bnext week\b/))) return span(isoOf(monday + 7 * DAY), isoOf(monday + 13 * DAY), match[0]);
  if ((match = t.match(/\btoday\b/))) return span(isoOf(today), isoOf(today), match[0]);
  if ((match = t.match(/\byesterday\b/))) return span(isoOf(today - DAY), isoOf(today - DAY), match[0]);
  if ((match = t.match(/\btomorrow\b/))) return span(isoOf(today + DAY), isoOf(today + DAY), match[0]);
  /* A day with no year — "3 Oct", "Oct 3" — is this year's. A day WITH a year
     is the shared grammar's, so it is left alone here. */
  const names = Object.keys(MONTHS).join("|");
  match = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${names})\\b(?!,?\\s+\\d{4})`))
    || t.match(new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s+\\d{4})(?!\\d)`));
  if (match) {
    const dayFirst = /^\d/.test(match[1]);
    const mm = MONTHS[(dayFirst ? match[2] : match[1]).toLowerCase()];
    const dd = Number(dayFirst ? match[1] : match[2]);
    if (dd >= 1 && dd <= lastDay(y, mm)) return span(ymd(y, mm, dd), ymd(y, mm, dd), match[0]);
  }
  return null;
}
const dayStart = (s) => new Date(`${s}T00:00:00.000+05:30`);
const dayEnd = (s) => new Date(`${s}T23:59:59.999+05:30`);
const todayIso = (now = Date.now()) => isoOf(now + IST);

module.exports = {
  text, escapeRx, exactRx, containsRx, plural,
  longestName, strip,
  IST, ymd, lastDay, periodFrom, dayStart, dayEnd, todayIso,
};
