// services/marketing/trackingConfig.service.js
//
// VALIDATING AND STORING WHAT THE PUBLIC WEBSITE IS TOLD TO MEASURE.
//
// ── NOTHING HERE CALLS GOOGLE OR META ──────────────────────────────────────
// No network client is imported and no request is made. A saved identifier is a
// statement of intent by an administrator, and this slice's whole discipline is
// refusing to dress that up as a working installation. `verified` is reserved
// for a later probe that reads the public site; `assertNeverVerified` below
// makes writing it from here impossible rather than merely discouraged.
//
// ── NOTHING HERE STORES A SECRET OR A SCRIPT ───────────────────────────────
// A submitted access token, Conversions API token, client secret or refresh
// token is REFUSED BY NAME. Dropping it silently would be worse than useless:
// the person would go on believing GRAV held their token, and would stop
// looking for the place it actually needs to go. The same refusal covers
// anything that would store executable content — a snippet field is a stored
// cross-site scripting vector aimed at a public website, and there is no
// version of this feature that needs one.
//
// ── WHY THE HISTORY IS WRITTEN FIRST ───────────────────────────────────────
// Two collections change on one save and this deployment cannot assume a
// replica set, so the pair cannot be made atomic. That leaves a choice about
// which half survives an interruption, and the two orders fail very
// differently:
//
//   current first  →  the setting changes and the trail never records who
//                     changed it. The record is wrong about its own past and
//                     nothing can reconstruct it.
//   history first  →  the trail records a decision the current record has not
//                     caught up with. Nothing is lost, the gap is DETECTABLE
//                     (history holds a revision the current record does not),
//                     and the resulting configuration is right there in the
//                     history row to finish applying.
//
// So the history row is written first, keyed uniquely on (company, revision) so
// a retry cannot append twice, and `reconcile()` finishes an interrupted write.
// Every read runs it, which means the repair happens the next time anybody looks
// rather than waiting for a scheduler this deployment does not have.
"use strict";

const {
  MarketingTrackingConfig, MarketingTrackingConfigHistory,
} = require("../../models/CMS_Models/Marketing/MarketingTrackingConfig");
const { fail } = require("../storePurchase/errors");
const {
  TRACKING_MODE_CODES, TRACKING_ID_PATTERNS, TRACKING_REFUSED_FIELD_PARTS,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* The only fields a caller may send. Anything else is refused rather than
   ignored: an unknown field is either a typo, in which case silence means the
   setting the author believed they changed did not change, or an attempt, in
   which case silence is the wrong answer too. */
const ACCEPTED_FIELDS = Object.freeze([
  "siteUrl", "trackingMode", "gtmContainerId", "ga4MeasurementId", "metaPixelId",
  "enabled", "expectedRevision", "note",
]);

const ID_FIELDS = Object.freeze(["gtmContainerId", "ga4MeasurementId", "metaPixelId"]);

const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]", "::1"]);

/* ═══ VALIDATION ═══════════════════════════════════════════════════════════ */

const normaliseName = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Refuse a payload that carries a secret, a script or an unknown field.
 *
 * Runs before anything else, so a request containing a token is refused whether
 * or not the rest of it would have validated. The refusal names the field, which
 * is the point: the author needs to know GRAV did not take it.
 */
function assertAcceptableFields(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("VALIDATION", "A tracking configuration must be an object.");
  }

  const keys = Object.keys(payload);

  /* Checked FIRST, before the general unknown-field rule, so a caller who named
     a company is told that specifically rather than being told `companyId` is
     not a field. The two refusals mean different things: one is a typo, the
     other is an attempt to choose whose settings are being written. */
  if (keys.includes("companyId") || keys.includes("company")) {
    throw fail("VALIDATION",
      "The company is taken from your session and cannot be set in the request.",
      { field: "companyId" });
  }

  const secretish = keys.filter((k) => {
    const n = normaliseName(k);
    return TRACKING_REFUSED_FIELD_PARTS.some((part) => n.includes(part));
  });
  if (secretish.length) {
    throw fail("VALIDATION",
      `GRAV does not store provider secrets or embedded code for website tracking, so ${secretish.join(", ")} ${secretish.length === 1 ? "was" : "were"} refused rather than saved. Configure identifiers here and keep credentials in the provider.`,
      { refused: secretish });
  }

  const unknown = keys.filter((k) => !ACCEPTED_FIELDS.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} of a tracking configuration.`,
      { unknown, accepted: ACCEPTED_FIELDS });
  }

  assertDeclaredTypes(payload);
}

/* ── THE DECLARED TYPES, AND WHY COERCION IS REFUSED ────────────────────────
   A JSON API that coerces is a JSON API that accepts things nobody meant. Three
   concrete ways that goes wrong here:

     `enabled: "false"`   a non-empty string is truthy, so a client sending the
                          STRING "false" would switch tracking ON.
     `metaPixelId: 123…`  a pixel id has up to 20 digits and a JSON number
                          carries about 15 significant ones, so a numeric
                          literal silently rounds and the saved id belongs to
                          nobody. It must arrive as a string.
     `siteUrl: null`      `String(null)` is "null", which is not a refusal and
                          not a clear either — it is a value that then fails a
                          URL parse for a reason nobody can act on.

   So each field is checked against its declared type before anything is read
   from it, and this runs inside `assertAcceptableFields`, which every write
   path calls before touching either collection. */
const STRING_FIELDS = Object.freeze([
  "siteUrl", "trackingMode", "gtmContainerId", "ga4MeasurementId", "metaPixelId", "note",
]);

const typeName = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
};

function assertDeclaredTypes(payload) {
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);

  for (const field of STRING_FIELDS) {
    if (!has(field)) continue;
    if (typeof payload[field] !== "string") {
      throw fail("VALIDATION",
        field === "metaPixelId"
          ? `${field} must be sent as a string. A ${typeName(payload[field])} would lose digits from a long pixel ID.`
          : `${field} must be a string, not ${typeName(payload[field])}.`,
        { field, expected: "string", received: typeName(payload[field]) });
    }
  }

  if (has("enabled") && typeof payload.enabled !== "boolean") {
    throw fail("VALIDATION",
      `enabled must be true or false, not ${typeName(payload.enabled)}.`,
      { field: "enabled", expected: "boolean", received: typeName(payload.enabled) });
  }

  if (has("expectedRevision")) {
    const raw = payload.expectedRevision;
    /* A JSON number, and specifically a finite non-negative integer. Not a
       numeric string, because a caller that sends "1" has not read the contract
       and the next thing it sends may be "one". Not null or false, both of which
       `Number()` turns into 0 — a legitimate revision, and therefore the most
       dangerous coercion of the three. */
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw fail("VALIDATION",
        `expectedRevision must be a whole number telling GRAV which version you are replacing, not ${typeName(raw)}.`,
        { field: "expectedRevision", expected: "non-negative integer", received: typeName(raw) });
    }
  }
}

/**
 * A public website origin, or a refusal.
 *
 * ── WHY HTTP IS REFUSED ───────────────────────────────────────────────────
 * The identifiers configured here end up in a page that runs in a visitor's
 * browser, and a page served over plain http can be rewritten in transit by
 * anybody on the path. A measurement configuration delivered that way is a
 * configuration an attacker can replace.
 *
 * The development exception is EXPLICIT and doubly gated: the host must be a
 * loopback address AND `MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP` must be set.
 * Production refuses it whatever the variable says, because the one environment
 * where a forgotten development flag would matter is the one that must not
 * honour it.
 */
function normaliseSiteUrl(raw, env = process.env) {
  const value = str(raw);
  if (!value) return "";

  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("VALIDATION", "The website address is not a valid URL.", { field: "siteUrl" });
  }

  if (url.username || url.password) {
    throw fail("VALIDATION",
      "The website address must not contain a username or password.", { field: "siteUrl" });
  }
  if (url.search) {
    throw fail("VALIDATION",
      "The website address must not contain a query string — it is an origin, not a page.",
      { field: "siteUrl" });
  }
  if (url.hash) {
    throw fail("VALIDATION",
      "The website address must not contain a fragment — it is an origin, not a page.",
      { field: "siteUrl" });
  }
  if (url.pathname && url.pathname !== "/") {
    throw fail("VALIDATION",
      "The website address must be an origin, with no path.", { field: "siteUrl" });
  }

  const isProduction = str(env.NODE_ENV) === "production";
  const loopback = LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());

  if (url.protocol === "https:") return url.origin;

  if (url.protocol === "http:") {
    if (isProduction) {
      throw fail("VALIDATION",
        "The website address must use https. Plain http is never accepted in production.",
        { field: "siteUrl" });
    }
    if (!loopback) {
      throw fail("VALIDATION",
        "The website address must use https. Plain http is accepted only for a loopback development host.",
        { field: "siteUrl" });
    }
    if (!str(env.MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP)) {
      throw fail("VALIDATION",
        "Plain http on localhost is a development-only exception and must be requested explicitly. Set MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP to allow it in this environment.",
        { field: "siteUrl", expected: "MARKETING_TRACKING_ALLOW_LOCALHOST_HTTP" });
    }
    return url.origin;
  }

  throw fail("VALIDATION",
    `The website address must use https (it uses ${url.protocol.replace(":", "")}).`,
    { field: "siteUrl" });
}

/** One identifier, normalised and shape-checked, or cleared. */
function normaliseId(field, raw) {
  const value = str(raw);
  /* An empty string CLEARS an optional identifier. That is a real instruction —
     "we no longer use this" — and it must be distinguishable from not mentioning
     the field, which is why the caller's payload keys are read explicitly. */
  if (!value) return "";

  /* Google's identifiers are conventionally uppercase and are frequently pasted
     with surrounding whitespace or in the case the provider's UI displayed. */
  const candidate = field === "metaPixelId" ? value : value.toUpperCase();
  if (!TRACKING_ID_PATTERNS[field].test(candidate)) {
    throw fail("VALIDATION", `"${value}" is not a valid ${LABELS[field]}.`, {
      field, expected: EXPECTED[field],
    });
  }
  return candidate;
}

const LABELS = Object.freeze({
  gtmContainerId: "Google Tag Manager container ID",
  ga4MeasurementId: "GA4 measurement ID",
  metaPixelId: "Meta Pixel ID",
});
const EXPECTED = Object.freeze({
  gtmContainerId: "GTM- followed by 4 to 10 letters or digits",
  ga4MeasurementId: "G- followed by 4 to 12 letters or digits",
  metaPixelId: "8 to 20 digits",
});

/**
 * Check the mode against the identifiers, refusing anything ambiguous.
 *
 * ── THE AMBIGUITY THIS EXISTS TO PREVENT ─────────────────────────────────
 * A container and a directly installed tag can both send the same page view.
 * A site with both double-counts every visit, and nobody notices until somebody
 * makes a decision on the number. So `direct` refuses a container outright
 * rather than storing one and trusting a future loader to ignore it — a rule
 * enforced at the point of entry cannot be forgotten by the code that reads it
 * later.
 *
 * `gtm` is the reverse case and is allowed deliberately: GA4 and Meta ids under
 * a container are DOCUMENTATION of what the container is expected to fire, which
 * is genuinely useful, and the read model marks them as documented-not-active so
 * the loader contract stays unambiguous.
 */
function assertModeCoherent(next) {
  const { trackingMode, gtmContainerId, ga4MeasurementId, metaPixelId } = next;

  if (trackingMode === "gtm" && !gtmContainerId) {
    throw fail("VALIDATION",
      "Tag Manager mode needs a container ID — without one nothing would be installed.",
      { field: "gtmContainerId" });
  }

  if (trackingMode === "direct") {
    if (!ga4MeasurementId && !metaPixelId) {
      throw fail("VALIDATION",
        "Direct mode needs at least one destination: a GA4 measurement ID or a Meta Pixel ID.",
        { field: "trackingMode" });
    }
    if (gtmContainerId) {
      throw fail("VALIDATION",
        "Direct mode cannot also hold a Tag Manager container: the container and a directly installed tag would both fire and every visit would be counted twice. Choose Tag Manager mode, or clear the container ID.",
        { field: "gtmContainerId" });
    }
  }

  if (trackingMode === "disabled" && next.enabled) {
    throw fail("VALIDATION",
      "A disabled configuration cannot be enabled. Choose a tracking mode first.",
      { field: "enabled" });
  }
}

/**
 * Turn a request payload plus the stored record into the configuration to save.
 *
 * Absent fields keep their stored value; a field present as an empty string
 * clears it. Both are real instructions and they are not the same one.
 */
function buildNext({ payload, current, env = process.env }) {
  assertAcceptableFields(payload);
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);

  const next = {
    siteUrl: has("siteUrl") ? normaliseSiteUrl(payload.siteUrl, env) : str(current?.siteUrl),
    trackingMode: has("trackingMode") ? str(payload.trackingMode) : (current?.trackingMode || "disabled"),
    enabled: has("enabled") ? Boolean(payload.enabled) : Boolean(current?.enabled),
  };

  if (!TRACKING_MODE_CODES.includes(next.trackingMode)) {
    throw fail("VALIDATION", `"${next.trackingMode}" is not a tracking mode.`, {
      field: "trackingMode", accepted: TRACKING_MODE_CODES,
    });
  }

  for (const field of ID_FIELDS) {
    next[field] = has(field) ? normaliseId(field, payload[field]) : str(current?.[field]);
  }

  /* A mode that needs an address needs a real one. Disabled does not. */
  if (next.trackingMode !== "disabled" && !next.siteUrl) {
    throw fail("VALIDATION",
      "A website address is required before tracking can be configured.", { field: "siteUrl" });
  }

  assertModeCoherent(next);
  return next;
}

/* ═══ WHAT IS ACTIVE, AND WHAT IS MERELY RECORDED ══════════════════════════ */

/**
 * The installation contract a future website loader must obey.
 *
 * Derived here rather than left to the loader, so the rule that prevents double
 * firing lives with the configuration it constrains instead of being restated —
 * and eventually mis-restated — by whatever reads it.
 */
function loaderContractOf(config) {
  const enabled = Boolean(config?.enabled);
  const mode = config?.trackingMode || "disabled";

  if (!enabled || mode === "disabled") {
    return { install: "none", activeDestinations: [], documentedNotActive: [] };
  }

  if (mode === "gtm") {
    /* ONLY the container. GA4 and Meta ids under a container describe what the
       container is expected to fire; installing them as well is the duplicate
       every part of this file is arranged to prevent. */
    const documented = [];
    if (str(config.ga4MeasurementId)) documented.push("ga4");
    if (str(config.metaPixelId)) documented.push("meta_pixel");
    return { install: "gtm", activeDestinations: ["gtm"], documentedNotActive: documented };
  }

  const active = [];
  if (str(config.ga4MeasurementId)) active.push("ga4");
  if (str(config.metaPixelId)) active.push("meta_pixel");
  return { install: "direct", activeDestinations: active, documentedNotActive: [] };
}

/**
 * The verification state a saved configuration earns.
 *
 * `verified` is not reachable from here by construction. A configuration with a
 * usable mode is `saved_unverified` — somebody has said what they intend and
 * nothing has looked at the website to see whether it is true.
 */
function verificationFor(next) {
  if (next.trackingMode === "disabled") {
    return {
      state: "not_configured",
      checkedAt: null,
      safeMessage: "No tracking is configured for this company's website.",
    };
  }
  return {
    state: "saved_unverified",
    checkedAt: null,
    safeMessage: "Saved. Nothing has checked the public website yet, so this is not confirmed to be installed.",
  };
}

/** A guard, not a comment. Nothing in this slice may claim verification. */
function assertNeverVerified(verification) {
  if (verification?.state === "verified") {
    throw fail("VALIDATION",
      "A configuration cannot be marked verified by saving it. Verification is a later check against the public website.");
  }
}

/* ═══ READING ══════════════════════════════════════════════════════════════ */

function assertCompany(companyId) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Tracking configuration cannot be read or written without a company.");
  }
  return companyId;
}

const safeOf = (c) => ({
  siteUrl: str(c?.siteUrl),
  trackingMode: c?.trackingMode || "disabled",
  gtmContainerId: str(c?.gtmContainerId),
  ga4MeasurementId: str(c?.ga4MeasurementId),
  metaPixelId: str(c?.metaPixelId),
  enabled: Boolean(c?.enabled),
});

/**
 * Finish a write that was interrupted between its two collections.
 *
 * The history holds a revision the current record does not, which can only mean
 * the process stopped between the append and the update. The history row carries
 * the configuration that was decided, so applying it is a repair rather than a
 * guess — and it is idempotent, because it only fires while the current record
 * is behind.
 *
 * @returns {Promise<{repaired:boolean, toRevision:number|null}>}
 */
async function reconcile({ companyId }) {
  assertCompany(companyId);

  const [current, newest] = await Promise.all([
    MarketingTrackingConfig.findOne({ companyId }).lean(),
    MarketingTrackingConfigHistory.findOne({ companyId }).sort({ revision: -1 }).lean(),
  ]);

  if (!newest) return { repaired: false, toRevision: null };
  const currentRevision = Number(current?.revision) || 0;
  if (newest.revision <= currentRevision) return { repaired: false, toRevision: null };

  await MarketingTrackingConfig.findOneAndUpdate(
    /* Fenced on the revision this repair believes it is advancing from, so two
       concurrent readers cannot both apply it and the second is simply a
       no-op. */
    { companyId, revision: currentRevision },
    {
      $set: {
        ...safeOf(newest.resulting),
        revision: newest.revision,
        configuredAt: newest.at,
        configuredBy: newest.actor,
        verification: verificationFor(newest.resulting),
      },
      $setOnInsert: { companyId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).catch((err) => {
    /* A concurrent repair created the row first. Theirs is the one that
       exists, and it applied the same history row. */
    if (err?.code !== 11000) throw err;
  });

  return { repaired: true, toRevision: newest.revision };
}

/**
 * The current configuration, shaped for a reader.
 *
 * Public identifiers, the mode, the enabled state, the revision and the
 * verification state — and never the word "connected", which would assert
 * something nothing has checked.
 */
async function get({ companyId } = {}) {
  assertCompany(companyId);
  const repair = await reconcile({ companyId });
  const config = await MarketingTrackingConfig.findOne({ companyId }).lean();

  if (!config) {
    return {
      configured: false,
      siteUrl: "",
      trackingMode: "disabled",
      gtmContainerId: "",
      ga4MeasurementId: "",
      metaPixelId: "",
      enabled: false,
      revision: 0,
      configuredAt: null,
      configuredBy: null,
      verification: {
        state: "not_configured",
        checkedAt: null,
        safeMessage: "No tracking has been configured for this company's website.",
      },
      loaderContract: loaderContractOf(null),
      repaired: repair.repaired,
    };
  }

  return {
    configured: true,
    ...safeOf(config),
    revision: Number(config.revision) || 0,
    configuredAt: config.configuredAt || null,
    configuredBy: config.configuredBy?.name ? { name: str(config.configuredBy.name) } : null,
    verification: {
      state: config.verification?.state || "not_configured",
      checkedAt: config.verification?.checkedAt || null,
      safeMessage: str(config.verification?.safeMessage),
    },
    loaderContract: loaderContractOf(config),
    repaired: repair.repaired,
  };
}

/* ═══ WRITING ══════════════════════════════════════════════════════════════ */

/**
 * Save a new configuration, with optimistic revision matching.
 *
 * The history row goes first and carries the whole decision; the current record
 * follows. See the file header for why that order, and `reconcile` for what
 * finishes the job if the process stops in between.
 */
async function save({ companyId, payload = {}, actor = {}, env = process.env, now = new Date() } = {}) {
  assertCompany(companyId);

  /* ── EVERY REFUSAL BEFORE EVERY WRITE ──────────────────────────────────
     Types and field names are checked FIRST, before `reconcile` — which can
     itself write while finishing an earlier interrupted save. A malformed
     payload must not be the reason a repair happens, and a caller sending a
     boolean where a string belongs must be told so without anything in either
     collection having moved. */
  assertAcceptableFields(payload);

  await reconcile({ companyId });

  const current = await MarketingTrackingConfig.findOne({ companyId }).lean();
  const currentRevision = Number(current?.revision) || 0;

  /* ── OPTIMISTIC CONCURRENCY ────────────────────────────────────────────
       Required, not optional. A caller that does not state what it believes it
       is replacing cannot be protected from replacing something else, and a
       company-wide tracking setting is precisely the thing two administrators
       edit at once. */
  if (!Object.prototype.hasOwnProperty.call(payload, "expectedRevision")) {
    throw fail("VALIDATION",
      "State the revision you are replacing, so a concurrent change cannot be overwritten silently.",
      { field: "expectedRevision", currentRevision });
  }
  /* The type was proved above, before either collection was touched; this is
     only the comparison. */
  const expected = payload.expectedRevision;
  if (expected !== currentRevision) {
    throw fail("CONFLICT",
      `This configuration has changed since you loaded it (it is now revision ${currentRevision}, you sent ${expected}). Reload it and reapply your change.`,
      { field: "expectedRevision", currentRevision, sentRevision: expected });
  }

  const next = buildNext({ payload, current, env });
  const verification = verificationFor(next);
  assertNeverVerified(verification);

  const previous = current ? safeOf(current) : null;

  /* ── A SAVE THAT CHANGES NOTHING IS NOT A REVISION ──────────────────────
     Re-submitting an unchanged form, a double-clicked save button, or a client
     that PUTs the whole configuration on every keystroke would otherwise fill
     the trail with revisions in which nothing happened — and an audit trail
     mostly made of non-events is one nobody reads.

     Compared against the CURRENT SAFE CONFIGURATION, which is the whole of what
     this record means. A `note` is not part of it: a note explains a change, and
     a note with no change to explain is not a change. Someone who wants to
     record a remark about an unaltered configuration is asking for a different
     feature. */
  if (previous && deepEqualConfig(previous, next)) {
    return {
      saved: true,
      changed: false,
      noop: true,
      revision: currentRevision,
      previousRevision: currentRevision,
      recovered: false,
      config: await get({ companyId }),
    };
  }
  /* The same rule with no record yet: a first save that asks for the defaults
     has nothing to record either. */
  if (!previous && deepEqualConfig(safeOf(null), next)) {
    return {
      saved: true,
      changed: false,
      noop: true,
      revision: 0,
      previousRevision: 0,
      recovered: false,
      config: await get({ companyId }),
    };
  }

  const revision = currentRevision + 1;

  /* 1. THE TRAIL. Unique on (company, revision), so a retried save collides
        here rather than recording the same decision twice. */
  try {
    await MarketingTrackingConfigHistory.create({
      companyId,
      revision,
      previous,
      resulting: next,
      actor: { id: actor.id, name: str(actor.name), email: str(actor.email) },
      at: now,
      note: str(payload.note),
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* Somebody recorded this revision between the read and the write. Their
       decision is the one that stands; this caller's expected revision is now
       stale and they must reload rather than have their change applied on top
       of a decision they never saw. */
    throw fail("CONFLICT",
      "Another administrator saved a change while this one was being prepared. Reload the configuration and reapply your change.",
      { field: "expectedRevision", currentRevision });
  }

  /* 2. THE CURRENT RECORD, fenced on the revision this save is replacing.
        `upsert` only where there is nothing to fence against: upserting under a
        revision filter that matched nothing would insert a second row for the
        company and collide with the unique index, turning a lost fence into a
        duplicate-key crash. */
  const applied = await applyToCurrentRecord({
    companyId, current, currentRevision, next, revision, verification, actor, now,
  });

  if (applied.ok) {
    return {
      saved: true,
      changed: true,
      noop: false,
      revision,
      previousRevision: currentRevision,
      recovered: false,
      config: await get({ companyId }),
    };
  }

  /* ── THE INTERRUPTED SAVE ───────────────────────────────────────────────
     The decision is durably recorded and the setting has not caught up. The one
     answer that must never be returned here is "nothing was changed": a history
     row exists, and the next read of this configuration will apply it.

     So the repair is attempted immediately rather than left to whoever looks
     next, and the answer depends on whether it finished. */
  const recovered = await recoverAfterFailedApply({ companyId, revision, next });
  if (recovered) {
    return {
      saved: true,
      changed: true,
      noop: false,
      revision,
      previousRevision: currentRevision,
      /* Disclosed, not hidden. The write took a path worth knowing about, and a
         caller that logs this has the thread to pull if it recurs. */
      recovered: true,
      config: await get({ companyId }),
    };
  }

  /* Recorded, not yet applied, and honest about exactly that. No stack, no
     database message: `applied.reason` is a code this file produced. */
  throw fail("TRACKING_CONFIG_REPAIR_PENDING",
    `Your change was recorded as revision ${revision}, but applying it to the live configuration is not yet confirmed. Nothing has been lost. Reload the configuration before trying again — it may already show your change.`,
    { revision, previousRevision: currentRevision, stage: applied.reason });
}

/** Deep equality over the safe configuration, field by field. */
function deepEqualConfig(a, b) {
  const fields = ["siteUrl", "trackingMode", "gtmContainerId", "ga4MeasurementId", "metaPixelId", "enabled"];
  return fields.every((f) => a?.[f] === b?.[f]);
}

/**
 * Write the current record, reporting HOW it failed rather than throwing.
 *
 * A thrown driver error and an update that matched nothing are different
 * failures with the same consequence, and the caller needs to attempt the same
 * repair for both — so both come back as `ok: false` with a reason rather than
 * one throwing and one returning null.
 */
async function applyToCurrentRecord({
  companyId, current, currentRevision, next, revision, verification, actor, now,
}) {
  const update = {
    $set: {
      ...next,
      revision,
      configuredAt: now,
      configuredBy: { id: actor.id, name: str(actor.name), email: str(actor.email) },
      verification,
    },
  };

  try {
    if (!current) {
      const created = await MarketingTrackingConfig.findOneAndUpdate(
        { companyId },
        { ...update, $setOnInsert: { companyId } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return created ? { ok: true } : { ok: false, reason: "current_record_not_created" };
    }

    const saved = await MarketingTrackingConfig.findOneAndUpdate(
      { companyId, revision: currentRevision }, update, { new: true },
    );
    /* Null means the fence did not match — somebody moved the revision between
       the read and this write. Not an exception, and not a success. */
    return saved ? { ok: true } : { ok: false, reason: "revision_fence_did_not_match" };
  } catch (err) {
    /* The reason is one of this file's own words. The driver's message is
       deliberately not carried outward: it can quote a connection string, and
       it is going to a settings screen. */
    return { ok: false, reason: err?.code === 11000 ? "duplicate_current_record" : "current_record_write_failed" };
  }
}

/**
 * Try to finish an interrupted save, and prove it finished.
 *
 * `reconcile` is the existing company-scoped repair and is reused unchanged. The
 * proof afterwards is the point: the repair is only reported as successful when
 * the current record holds THIS revision AND exactly the configuration this save
 * decided. Anything else — including a repair that applied somebody else's
 * newer revision — is not this caller's success to claim.
 */
async function recoverAfterFailedApply({ companyId, revision, next }) {
  try {
    await reconcile({ companyId });
  } catch {
    return false;
  }
  const after = await MarketingTrackingConfig.findOne({ companyId }).lean();
  if (!after) return false;
  return Number(after.revision) === revision && deepEqualConfig(safeOf(after), next);
}

/* ═══ HISTORY ══════════════════════════════════════════════════════════════ */

const MAX_HISTORY_PAGE = 100;

/**
 * This company's configuration trail, newest first.
 *
 * Cursor-paginated on `_id`, which is unique — `revision` would also work here
 * and `at` would not, since two rows can share a timestamp and an ambiguous
 * cursor skips or repeats at a page boundary.
 */
async function history({ companyId, cursor = null, limit = 25 } = {}) {
  assertCompany(companyId);
  const pageSize = Math.max(1, Math.min(Number(limit) || 25, MAX_HISTORY_PAGE));

  const selector = { companyId };
  if (str(cursor)) {
    if (!/^[a-f0-9]{24}$/i.test(str(cursor))) {
      throw fail("VALIDATION", "That is not a valid page cursor.", { field: "cursor" });
    }
    selector._id = { $lt: str(cursor) };
  }

  const found = await MarketingTrackingConfigHistory
    .find(selector).sort({ _id: -1 }).limit(pageSize + 1).lean();
  const hasMore = found.length > pageSize;
  const page = hasMore ? found.slice(0, pageSize) : found;

  return {
    rows: page.map((h) => ({
      revision: h.revision,
      at: h.at,
      actor: str(h.actor?.name),
      note: str(h.note),
      previous: h.previous ? safeOf(h.previous) : null,
      resulting: safeOf(h.resulting),
    })),
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    hasMore,
    page: { size: page.length, maxSize: MAX_HISTORY_PAGE },
  };
}

module.exports = {
  get,
  save,
  history,
  reconcile,
  buildNext,
  normaliseSiteUrl,
  normaliseId,
  assertAcceptableFields,
  assertModeCoherent,
  loaderContractOf,
  verificationFor,
  deepEqualConfig,
  safeOf,
  ACCEPTED_FIELDS,
  MAX_HISTORY_PAGE,
};
