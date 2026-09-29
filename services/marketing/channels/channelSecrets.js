// services/marketing/channels/channelSecrets.js
//
// WHERE ADVERTISING CREDENTIALS COME FROM, AND WHERE THEY STOP.
//
// ── DEPLOYMENT SECRETS, NOT DATABASE DOCUMENTS ─────────────────────────────
// The product plan is explicit (§12): credentials live in deployment secrets,
// never in database documents or frontend configuration. The website tracking
// configuration in `trackingConfig.service.js` stores PUBLIC IDENTIFIERS ONLY
// and refuses a submitted token by name; nothing here writes to it, reads from
// it, or gives a route a way to put a secret into it.
//
// ── ONE COMPANY, AND THE VAULT THIS DEFERS ─────────────────────────────────
// Environment variables hold ONE company's credentials. That is honest for the
// internal first release — the same shape ADR-004 accepts for the marketing
// engine, and `MARKETING_COMPANY_ID` is already the single company this
// deployment serves — and it does NOT generalise.
//
// A second company needs per-company credentials, which needs a secret store
// with per-tenant isolation, rotation and an audit trail. `docs/decisions/`
// carries that requirement. What matters here is that nothing in this file
// pretends the problem is solved: `assertCompanyMayUseChannels` refuses a
// second company outright rather than serving it company A's advertising
// account, which is what a companyId-less env lookup would silently do.
//
// ── THE VALUES NEVER LEAVE THIS MODULE'S CALLERS ───────────────────────────
// `presence()` is what everything except an adapter is allowed to call. It
// answers "is this configured" and "what is missing", by VARIABLE NAME, never
// by value. `credentials()` returns real secrets and is called only by the
// three adapters. Nothing serialises its result, and `providerPrivacy` scrubs
// the names on the way out as a second line.
"use strict";

const { fail } = require("../../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/* ── THE VARIABLES, BY CHANNEL ──────────────────────────────────────────────
   `required` must all be present for the channel to be usable. `optional` may
   be absent without changing the state — `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is the
   manager account, needed only when the advertising account sits under one.

   Named as data rather than read inline so `presence()` can report exactly what
   is missing without a human maintaining a second list that drifts. */
const CHANNEL_SECRETS = Object.freeze({
  google_ads: Object.freeze({
    required: Object.freeze([
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      /* ── NO DEVELOPER TOKEN ──────────────────────────────────────────────
         Google sunset developer tokens on 2026-09-09. API access now belongs
         to the Google Cloud project that owns the OAuth client above, and a
         developer-token header is "optional and ignored" until a future major
         version rejects it. It is neither required nor read: listing it would
         send an administrator to obtain a credential Google no longer issues,
         and a deployment without it would report itself as unconfigured when
         it is not. Whether that Cloud project HAS access is only knowable by
         asking Google, and a refusal is reported as its own code
         (CHANNEL_API_ACCESS_UNAVAILABLE), never as missing configuration. */
      "GOOGLE_ADS_CUSTOMER_ID",
    ]),
    optional: Object.freeze(["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]),
  }),

  google_analytics: Object.freeze({
    required: Object.freeze(["GA4_PROPERTY_ID"]),
    /* ── EITHER OAUTH OR A SERVICE ACCOUNT, NOT BOTH ────────────────────────
       Two supported ways to authenticate, and requiring both would make a
       correctly configured deployment report as incomplete. `presence()` treats
       this group as satisfied when ANY of its members is set. */
    eitherOf: Object.freeze([
      Object.freeze(["GA4_SERVICE_ACCOUNT_KEY"]),
      Object.freeze(["GA4_CLIENT_ID", "GA4_CLIENT_SECRET", "GA4_REFRESH_TOKEN"]),
    ]),
    optional: Object.freeze([]),
  }),

  meta_ads: Object.freeze({
    required: Object.freeze([
      "META_ADS_ACCESS_TOKEN",
      "META_ADS_ACCOUNT_ID",
    ]),
    /* The app id and secret are needed to refresh or debug a token, not to make
       a read with one that is already long-lived. Optional so a deployment
       holding only a system-user token reports ready rather than incomplete. */
    optional: Object.freeze(["META_ADS_APP_ID", "META_ADS_APP_SECRET"]),
  }),

  /* The email channel is the internal engine. Its configuration is checked by
     `mauticHealth.service.js` and its variable names are never published — they
     would name the product. Deliberately absent from this table rather than
     present and filtered, so nothing can iterate it into a response. */
});

/* Never logged, never returned, never compared to a supplied value. Present so
   `sanitise()` can strip a stray one out of an object somebody built by
   spreading `process.env`. */
const ALL_SECRET_NAMES = Object.freeze(
  Object.values(CHANNEL_SECRETS).flatMap((s) => [
    ...s.required,
    ...(s.optional || []),
    ...(s.eitherOf || []).flat(),
  ]),
);

/**
 * The signing key for opaque campaign identifiers.
 *
 * ── WHY THIS IS REQUIRED RATHER THAN DERIVED ───────────────────────────────
 * A public campaign id is a signed token (see `campaignIdentity.js`), and the
 * signature is what stops a caller from editing a company or a channel out of
 * one. Three tempting shortcuts, all refused:
 *
 *   Reuse `JWT_SECRET`. It authenticates sessions. Using one key for two
 *   purposes means rotating it for one reason breaks the other, and a
 *   confused-deputy bug in either becomes a bug in both.
 *
 *   Generate a random key at boot. Ids would then stop resolving on restart and
 *   would never resolve across two instances — a paging bug that appears only
 *   under load balancing, which is the worst place to find one.
 *
 *   Sign with nothing and encode plainly. Then a caller edits the company id.
 *
 * So it is a named deployment secret, absent from the response, and reported by
 * name in the presence check when it is missing.
 */
const CAMPAIGN_ID_SECRET_VAR = "MARKETING_CHANNEL_ID_SECRET";

function campaignIdSecret(env = process.env) {
  const value = str(env[CAMPAIGN_ID_SECRET_VAR]);
  if (value.length < 16) return null;
  return value;
}

/**
 * Is this channel configured, and what is missing?
 *
 * @returns {{configured:boolean, missing:string[], optionalMissing:string[]}}
 *   `missing` holds VARIABLE NAMES, never values. A name is not a secret: it is
 *   the one thing an operator needs in order to fix this, and withholding it
 *   would turn a five-minute fix into a support conversation.
 */
function presence(channel, env = process.env) {
  const spec = CHANNEL_SECRETS[channel];
  /* A channel with no external credentials — `email` — is not "missing" them. */
  if (!spec) return { configured: true, missing: [], optionalMissing: [] };

  const missing = spec.required.filter((name) => !str(env[name]));

  /* A group is satisfied when any one alternative is complete. Reported as the
     FIRST alternative's names when none is, so the operator is told one way to
     succeed rather than every way at once. */
  for (const group of spec.eitherOf || []) {
    const satisfied = (spec.eitherOf || []).some(
      (alt) => alt.every((name) => str(env[name])),
    );
    if (!satisfied) {
      missing.push(...group);
      break;
    }
  }

  return {
    configured: missing.length === 0,
    missing,
    optionalMissing: (spec.optional || []).filter((name) => !str(env[name])),
  };
}

/**
 * The real credentials for one channel.
 *
 * ONLY the three provider adapters call this. It throws rather than returning a
 * partial object, so an adapter cannot make a half-authenticated request that
 * fails in a way that looks like the channel is down.
 */
function credentials(channel, env = process.env) {
  const state = presence(channel, env);
  if (!state.configured) {
    throw fail("CHANNEL_NOT_CONFIGURED",
      "This advertising channel is not connected in this deployment.",
      { channel, missing: state.missing });
  }

  switch (channel) {
    case "google_ads":
      return {
        clientId: str(env.GOOGLE_ADS_CLIENT_ID),
        clientSecret: str(env.GOOGLE_ADS_CLIENT_SECRET),
        refreshToken: str(env.GOOGLE_ADS_REFRESH_TOKEN),
        /* Google writes customer ids with hyphens on screen and refuses them in
           a URL. Normalised once, here, rather than in each call site. */
        customerId: str(env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, ""),
        loginCustomerId: str(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, "") || null,
      };

    case "google_analytics":
      return {
        propertyId: str(env.GA4_PROPERTY_ID).replace(/^properties\//, ""),
        serviceAccountKey: str(env.GA4_SERVICE_ACCOUNT_KEY) || null,
        clientId: str(env.GA4_CLIENT_ID) || null,
        clientSecret: str(env.GA4_CLIENT_SECRET) || null,
        refreshToken: str(env.GA4_REFRESH_TOKEN) || null,
      };

    case "meta_ads":
      return {
        accessToken: str(env.META_ADS_ACCESS_TOKEN),
        /* Meta's ad account ids are written `act_123` in the API and `123` in
           its interface. Normalised to the bare digits and prefixed at the call
           site, so a value copied from either place works. */
        accountId: str(env.META_ADS_ACCOUNT_ID).replace(/^act_/, ""),
        appId: str(env.META_ADS_APP_ID) || null,
        appSecret: str(env.META_ADS_APP_SECRET) || null,
      };

    default:
      throw fail("VALIDATION", "That is not a channel GRAV connects to.", { channel });
  }
}

/**
 * Strip anything secret-shaped out of an object bound for a log or a response.
 *
 * A backstop, not the mechanism. The mechanism is that secrets are read in one
 * module and passed to one adapter. This catches the case where somebody builds
 * a diagnostic object out of a config and forgets what is in it.
 */
function sanitise(value) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    const normalised = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    const secretish = ALL_SECRET_NAMES.some((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "") === normalised)
      || /token|secret|password|credential|privatekey|refresh|bearer|apikey/.test(normalised);
    if (secretish) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object") {
      out[k] = sanitise(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  CHANNEL_SECRETS,
  ALL_SECRET_NAMES,
  CAMPAIGN_ID_SECRET_VAR,
  campaignIdSecret,
  presence,
  credentials,
  sanitise,
};
