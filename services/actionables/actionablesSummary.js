// services/actionables/actionablesSummary.js
//
// Pure half of the cross-application actionables read (`GET /api/me/actionables`).
// No database, no clock beyond what is passed in — tested in
// actionablesSummary.test.js.
//
// A PROVIDER (actionableProviders.js) answers, for one application, a list of
// ITEMS: `{ key, label, count, tone, href, hint? }` — "7 leave requests waiting
// for a decision, open /hr/…". This module turns every application's answer
// into what the launcher draws: per-application blocks with the empty items
// dropped, the totals, and one ranked "needs your attention" list across all
// of them.
//
// Counts only. Nothing here (or in any provider) carries a name, an amount or
// a record — the page links to the application, which shows the records under
// its own access rules.

"use strict";

/** How loud an item is. Ranked: urgent before attention before info. */
const TONE = Object.freeze({ URGENT: "urgent", ATTENTION: "attention", INFO: "info" });
const TONE_RANK = Object.freeze({ urgent: 3, attention: 2, info: 1 });

/** What happened when an application was asked. */
const STATUS = Object.freeze({
  OK: "ok", // answered (possibly with nothing pending)
  NONE: "none", // this application has no actionables defined yet
  UNAVAILABLE: "unavailable", // the read failed or timed out — never shown as "all clear"
});

const MAX_TOP = 12;

/** One item, bounded and normalised; null when it is not a usable item. */
function cleanItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const count = Number(raw.count);
  if (!Number.isFinite(count) || count <= 0) return null;
  const key = String(raw.key || "").trim();
  const label = String(raw.label || "").trim();
  if (!key || !label) return null;
  const tone = TONE_RANK[raw.tone] ? raw.tone : TONE.INFO;
  // A PATH inside the CMS, never a URL: the page navigates to it after
  // switching into the application, and a full address would make that an
  // open redirect for whoever can shape a provider's answer.
  const href = typeof raw.href === "string" && raw.href.startsWith("/") && !raw.href.startsWith("//")
    ? raw.href
    : null;
  const item = { key, label, count: Math.floor(count), tone, href };
  if (raw.hint) item.hint = String(raw.hint).slice(0, 160);
  return item;
}

function byLoudness(a, b) {
  return (TONE_RANK[b.tone] - TONE_RANK[a.tone]) || (b.count - a.count) || a.label.localeCompare(b.label);
}

/**
 * @param {Array<{slug, name, role, status, items}>} apps  in catalogue order
 * @returns {{ apps, totals, top }}
 */
function summarise(apps, { maxTop = MAX_TOP } = {}) {
  const blocks = (apps || []).map((app) => {
    const items = app.status === STATUS.OK
      ? (app.items || []).map(cleanItem).filter(Boolean).sort(byLoudness)
      : [];
    const pending = items.reduce((n, i) => n + i.count, 0);
    const loudest = items[0]?.tone || null;
    return {
      slug: app.slug,
      name: app.name,
      role: app.role || null,
      status: app.status,
      pending,
      tone: loudest,
      items,
    };
  });

  const all = [];
  for (const b of blocks) {
    for (const i of b.items) all.push({ ...i, slug: b.slug, appName: b.name });
  }
  all.sort(byLoudness);

  const totals = {
    pending: all.reduce((n, i) => n + i.count, 0),
    urgent: all.filter((i) => i.tone === TONE.URGENT).reduce((n, i) => n + i.count, 0),
    attention: all.filter((i) => i.tone === TONE.ATTENTION).reduce((n, i) => n + i.count, 0),
    apps: blocks.length,
    appsWithWork: blocks.filter((b) => b.pending > 0).length,
    appsClear: blocks.filter((b) => b.status === STATUS.OK && b.pending === 0).length,
    appsUnavailable: blocks.filter((b) => b.status === STATUS.UNAVAILABLE).length,
  };

  return { apps: blocks, totals, top: all.slice(0, Math.max(0, maxTop)) };
}

/** Reject after `ms` — a slow application must not hold the whole page. */
function withTimeout(promise, ms, label = "read") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { TONE, TONE_RANK, STATUS, MAX_TOP, cleanItem, summarise, withTimeout };
