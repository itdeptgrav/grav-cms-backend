// services/actionables/actionables.service.js
//
// GET /api/me/actionables — "what is waiting on me, in every application I
// hold" — for the /onboarding dashboard (10 Oct 2026).
//
// ACCESS. The applications asked are exactly `listAccessibleApps` — the one
// resolver /verify and the launcher's tiles use — so an application this person
// cannot open is never even counted. Each provider is handed the resolved role
// and decides what that role is shown (an approval queue only to someone who
// may approve). Nothing is taken from the token beyond the identifiers the
// resolver re-reads from the database.
//
// COST. The database is ~234 ms away (services/memo.js). Every application is
// asked at once and every provider runs its counts at once, so the page costs
// about one round trip plus the resolver, not one per count. A provider that
// takes longer than PROVIDER_TIMEOUT_MS is answered "unavailable" — shown as
// "couldn't check", never as "all clear". The whole answer is memoised per
// identity for ACTIONABLES_CACHE_MS (default 30 s; 0 disables): the page is
// opened by everybody at the start of a shift and polls while left open.
//
// COUNTS ONLY. No names, amounts or records leave here.

"use strict";

const { listAccessibleApps } = require("../access/appAccess.service");
const { summarise, withTimeout, STATUS } = require("./actionablesSummary");
const { PROVIDERS } = require("./actionableProviders");

const PROVIDER_TIMEOUT_MS = Number(process.env.ACTIONABLES_PROVIDER_TIMEOUT_MS || 6000);
const CACHE_MS = (() => {
  const v = Number(process.env.ACTIONABLES_CACHE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
})();

const cache = new Map(); // key -> { at, value }
const inFlight = new Map(); // key -> Promise

function cacheKey(user) {
  return `${user.subject || ""}:${user.id || ""}:${user.email || ""}:${user.tv || 0}`;
}

/** The context every provider receives. */
function contextFor(user, access, isPlatformAdmin) {
  return {
    role: access.role,
    capabilities: access.capabilities || {},
    canApprove: Boolean(access.capabilities?.approve),
    isPlatformAdmin: Boolean(isPlatformAdmin),
    email: String(user.email || "").toLowerCase(),
    userId: user.id ? String(user.id) : "",
    subject: user.subject || "",
  };
}

async function askApp({ department, access }, user, isPlatformAdmin) {
  const base = { slug: department.slug, name: department.name, role: access.role };
  const provider = PROVIDERS[department.slug];
  if (!provider) return { ...base, status: STATUS.NONE, items: [] };
  try {
    const items = await withTimeout(
      Promise.resolve().then(() => provider(contextFor(user, access, isPlatformAdmin))),
      PROVIDER_TIMEOUT_MS,
      `actionables:${department.slug}`,
    );
    return { ...base, status: STATUS.OK, items: Array.isArray(items) ? items : [] };
  } catch (err) {
    console.warn(`[actionables] ${department.slug}:`, err?.message || err);
    return { ...base, status: STATUS.UNAVAILABLE, items: [] };
  }
}

async function compute(user) {
  const out = await listAccessibleApps(user);
  if (!out.ok) return { ok: false, code: out.denialCode };
  const apps = await Promise.all(out.apps.map((a) => askApp(a, user, out.isPlatformAdmin)));
  return { ok: true, generatedAt: new Date().toISOString(), ...summarise(apps) };
}

/**
 * @param {{id, email, subject, tv}} user  req.user from authenticateCmsSession
 * @param {{fresh?: boolean}} opts         fresh skips the memo (the Refresh button)
 */
async function actionablesFor(user, { fresh = false } = {}) {
  const key = cacheKey(user);
  const hit = cache.get(key);
  if (!fresh && CACHE_MS > 0 && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = compute(user)
    .then((value) => {
      if (value.ok && CACHE_MS > 0) {
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

module.exports = { actionablesFor, PROVIDER_TIMEOUT_MS };
