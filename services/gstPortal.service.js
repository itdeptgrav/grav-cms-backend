"use strict";
/**
 * services/gstPortal.service.js
 * ───────────────────────────────────────────────────────────────────────────
 * ASKING SOMEBODY WHO ACTUALLY KNOWS WHETHER THIS GSTIN EXISTS.
 *
 * services/taxIdentity.service.js can prove a GSTIN is well-formed. It cannot
 * prove the registration EXISTS, that it belongs to this company, or that it
 * is still active — and a cancelled GSTIN is well-formed forever. This file
 * is the other half: one call out, to a provider that reads the GST Network.
 *
 * ── WHY A PROVIDER AND NOT THE PORTAL ──────────────────────────────────────
 * There is no public API on services.gst.gov.in. Its search is behind a
 * captcha, deliberately, and scraping it would be against its terms, break on
 * every markup change, and put the company's compliance data behind a screen
 * scraper. So the real answer comes from a GSP or a KYC provider that holds
 * the licence to read GSTN — Masters India, Surepass, Appyflow, KnowYourGST
 * and friends. All of them are paid, and that is a fact about the problem,
 * not about this code.
 *
 * ── WHY THIS IS NOT THE EXISTING LOOKUP ────────────────────────────────────
 * routes/Accountant_Routes/Acc_chartOfAccounts.js already had ninety lines of
 * inline provider call. It works, and it has three problems that matter once
 * anybody relies on it: no TIMEOUT (a slow provider holds our request open
 * until something else gives up), no CACHE (a form that checks as you type
 * would bill the company per keystroke), and no comparison of what came back
 * against what was typed — which is the entire point of asking.
 *
 * This replaces that with one configured, cached, timed-out call, and returns
 * a normalised shape so nothing downstream has to know whose JSON it is.
 * That route now delegates here.
 */

/* ── PROVIDER PRESETS ──────────────────────────────────────────────────────
 * Every provider spells the same request differently. Rather than make
 * whoever configures this read four sets of API docs, the common ones are
 * described here and selected by name:
 *
 *   GST_PORTAL_PROVIDER=surepass
 *   GST_PORTAL_API_KEY=<token>
 *
 * `custom` keeps the fully manual escape hatch the old code had, so a
 * provider nobody here has heard of still works without a code change.
 */
const PRESETS = {
  "masters-india": {
    url: "https://commonapi.mastersindia.co/commonapis/searchgstin?gstin={GSTIN}",
    method: "GET",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    /* Masters India also wants the client id on every call. */
    extraHeaders: () => ({ client_id: process.env.GST_PORTAL_CLIENT_ID || "" }),
  },
  surepass: {
    url: "https://kyc-api.surepass.io/api/v1/corporate/gstin",
    method: "POST",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    body: (gstin) => ({ id_number: gstin }),
  },
  appyflow: {
    /* Appyflow puts the key in the query string rather than a header. */
    url: "https://appyflow.in/api/verifyGST?gstNo={GSTIN}&key_secret={KEY}",
    method: "GET",
  },
  knowyourgst: {
    url: "https://www.knowyourgst.com/developers/gstincall/?gstin={GSTIN}",
    method: "GET",
    authHeader: "passthrough",
  },
  /* Built per call rather than declared, for the reason below. */
  custom: null,
};

/* ── EVERY SETTING IS READ WHEN IT IS USED, NOT WHEN THIS FILE LOADS ───────
 * The first version froze all of these into consts at import time, and it was
 * wrong in a way that only shows up in production: whether `require("dotenv")`
 * has run yet depends on which file pulled this one in first. Get that order
 * wrong and the whole service silently reports "not configured" with a
 * perfectly good key sitting in .env — a failure that looks like a missing
 * subscription rather than a bug, and would be debugged in the billing portal.
 *
 * Reading `process.env` at call time also makes the settings changeable
 * without a restart, and is what lets the tests exercise a 50ms timeout
 * instead of waiting eight seconds for the real one.
 */
function customPreset() {
  return {
    url: process.env.GST_PORTAL_API_URL || process.env.GSTIN_LOOKUP_API_URL || "",
    method: (process.env.GST_PORTAL_METHOD || process.env.GSTIN_LOOKUP_METHOD || "GET").toUpperCase(),
    authHeader:
      process.env.GST_PORTAL_API_KEY_HDR || process.env.GSTIN_LOOKUP_API_KEY_HDR || "X-API-Key",
    authPrefix: process.env.GST_PORTAL_API_KEY_PREFIX || "",
    body: (gstin) => ({ gstin }),
  };
}

/** The preset in force, with `custom` resolved from the environment now. */
function presetFor(name) {
  return name === "custom" ? customPreset() : PRESETS[name];
}

const timeoutMs = () => Number(process.env.GST_PORTAL_TIMEOUT_MS || 8000);
/* A registration's legal name and status change on the order of years, not
   minutes. Caching for a day turns "check as you type" from a per-keystroke
   bill into one call per company per day, and makes a re-check instant. */
const cacheTtlMs = () => Number(process.env.GST_PORTAL_CACHE_MS || 24 * 60 * 60 * 1000);

const cache = new Map();

function providerName() {
  const raw = String(process.env.GST_PORTAL_PROVIDER || "").trim().toLowerCase();
  if (raw === "custom" || (raw && PRESETS[raw])) return raw;
  /* No provider named but the old custom variables are set — keep those
     installs working without anybody editing .env. */
  if (process.env.GST_PORTAL_API_URL || process.env.GSTIN_LOOKUP_API_URL) return "custom";
  return null;
}

function apiKey() {
  return process.env.GST_PORTAL_API_KEY || process.env.GSTIN_LOOKUP_API_KEY || "";
}

/** Is a real lookup possible on this install? */
function isConfigured() {
  const name = providerName();
  if (!name) return false;
  const preset = presetFor(name);
  if (!preset || !preset.url) return false;
  return !!apiKey();
}

/** What to tell somebody who has not set it up. Named, not vague. */
function configHint() {
  return (
    "Set GST_PORTAL_PROVIDER (masters-india, surepass, appyflow, knowyourgst or custom) " +
    "and GST_PORTAL_API_KEY in .env to check GSTINs against the GST Network. " +
    "These are paid services — the GST portal itself has no public API."
  );
}

/* ── NORMALISING WHOSE JSON THIS IS ────────────────────────────────────────
 * GSTN's own field names are terse (`lgnm`, `tradeNam`, `sts`), and every
 * provider either passes them through or renames them. Rather than a chain of
 * `||` at the call site, the aliases live here, in one list per field.
 */
const FIELD_ALIASES = {
  legalName: ["lgnm", "legalName", "legal_name", "legal_business_name", "name", "company_name"],
  tradeName: ["tradeNam", "tradeName", "trade_name", "tradingName", "business_name"],
  status: ["sts", "status", "gstin_status", "registration_status", "gstinStatus"],
  registrationDate: ["rgdt", "registrationDate", "registration_date", "date_of_registration"],
  taxpayerType: ["dty", "ctb", "taxpayerType", "taxpayer_type", "constitution_of_business"],
  stateCode: ["stcd", "stateCode", "state_code"],
  cancelledDate: ["cxdt", "cancellationDate", "cancellation_date", "date_of_cancellation"],
  /* The GSTIN the provider believes it is answering about. Not decoration —
     see the identity check in lookupGstin. */
  echoedGstin: ["gstin", "gstIn", "gstNo", "gstin_number", "id_number"],
  pan: ["panNo", "pan", "panNumber", "pan_number"],
};

function pick(source, names) {
  for (const n of names) {
    const v = source?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** The provider's address object → one line. GSTN nests it two levels deep. */
function flattenAddress(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  const a = raw.adr || raw.addr || raw;
  if (typeof a === "string") return a;
  const parts = [a.bnm, a.bno, a.flno, a.st, a.loc, a.city, a.dst, a.stcd, a.pncd]
    .filter(Boolean)
    .map(String);
  return parts.length ? parts.join(", ") : null;
}

function normalise(payload) {
  /* Providers wrap the real object under any of these, or none. */
  const d = payload?.data || payload?.result || payload?.response || payload?.taxpayerInfo || payload;
  const addressSource = d?.pradr || d?.principalAddress || d?.address || d?.adr || null;

  return {
    echoedGstin: pick(d, FIELD_ALIASES.echoedGstin),
    pan: pick(d, FIELD_ALIASES.pan),
    legalName: pick(d, FIELD_ALIASES.legalName),
    tradeName: pick(d, FIELD_ALIASES.tradeName),
    status: pick(d, FIELD_ALIASES.status),
    registrationDate: pick(d, FIELD_ALIASES.registrationDate),
    taxpayerType: pick(d, FIELD_ALIASES.taxpayerType),
    stateCode: pick(d, FIELD_ALIASES.stateCode),
    cancelledDate: pick(d, FIELD_ALIASES.cancelledDate),
    address: flattenAddress(addressSource),
  };
}

function buildRequest(gstin) {
  const name = providerName();
  const preset = presetFor(name);
  const key = apiKey();

  const url = String(preset.url)
    .replace("{GSTIN}", encodeURIComponent(gstin))
    .replace("{KEY}", encodeURIComponent(key));

  const headers = { Accept: "application/json" };
  if (preset.authHeader && preset.authHeader !== "passthrough") {
    headers[preset.authHeader] = `${preset.authPrefix || ""}${key}`;
  } else if (preset.authHeader === "passthrough") {
    headers["passthrough"] = key;
  }
  Object.assign(headers, preset.extraHeaders ? preset.extraHeaders() : {});

  let body;
  if (preset.method === "POST") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(preset.body ? preset.body(gstin) : { gstin });
  }

  return { url, method: preset.method, headers, body, provider: name };
}

/**
 * Ask the provider about one GSTIN.
 *
 * NEVER THROWS. A compliance form must not break because a third party is
 * having a bad afternoon, so every failure is a typed result the caller can
 * render — and the difference between "the provider is down" and "this GSTIN
 * does not exist" is preserved, because they call for different actions.
 */
async function lookupGstin(gstin, { force = false } = {}) {
  const key = String(gstin || "").trim().toUpperCase();
  if (!key) return { ok: false, reason: "empty" };

  if (!isConfigured()) {
    return { ok: false, reason: "not-configured", hint: configHint() };
  }

  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheTtlMs()) {
      return { ...hit.value, cached: true };
    }
  }

  const req = buildRequest(key);
  const controller = new AbortController();
  const ms = timeoutMs();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    if (!res.ok) {
      /* 404 from these providers means "no such registration", which is a
         real answer about the GSTIN. Everything else is a fault on their
         side and must not be reported as a verdict on the number. */
      if (res.status === 404) {
        const miss = { ok: true, found: false, provider: req.provider, gstin: key };
        cache.set(key, { at: Date.now(), value: miss });
        return miss;
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "auth", provider: req.provider, status: res.status };
      }
      if (res.status === 429) {
        return { ok: false, reason: "rate-limited", provider: req.provider };
      }
      return { ok: false, reason: "provider-error", provider: req.provider, status: res.status };
    }

    const payload = await res.json();

    /* Several providers answer 200 with a body saying it failed. A flag that
       says "not found" has to beat the HTTP status, or a missing GSTIN comes
       back looking like a successful lookup of nothing. */
    const explicitlyFailed =
      payload?.success === false ||
      /* Appyflow's shape: HTTP 200 with `error: true` and a message. Without
         this, a failed lookup there would fall through to the field scan and
         be reported as an empty-but-successful record. */
      payload?.error === true ||
      payload?.status_code === 404 ||
      /not\s*found|invalid\s*gstin/i.test(String(payload?.message || ""));

    const data = normalise(payload);
    if (explicitlyFailed || (!data.legalName && !data.tradeName && !data.status)) {
      const miss = {
        ok: true,
        found: false,
        provider: req.provider,
        gstin: key,
        message: payload?.message || null,
      };
      cache.set(key, { at: Date.now(), value: miss });
      return miss;
    }

    /* ── DID THEY ANSWER ABOUT THE GSTIN WE ASKED ABOUT? ─────────────────
     * They must, and one of them does not.
     *
     * Appyflow's FREE credits are a sandbox: every lookup, whatever GSTIN you
     * send, returns one fixed demo record — a proprietorship in Ludhiana. It
     * says so in a `message` field that nothing was reading, and the record
     * comes back HTTP 200 with `error: false`, looking exactly like a
     * successful verification.
     *
     * Unchecked, that is not merely useless, it is dangerous: every company
     * in the system would "verify" as somebody else's, the name comparison
     * would flag a mismatch against every real record, and the Use-it button
     * beside it would offer to rename the company to the demo company. One
     * click to overwrite a company master with a stranger's name.
     *
     * The providers echo the GSTIN they are answering about, so comparing it
     * to the one we sent catches this — and catches the more general bug it
     * is an instance of: a provider, proxy or cache handing back the wrong
     * record. A response that is not about our GSTIN is not evidence about
     * our GSTIN, whatever the reason. */
    const echoed = String(data.echoedGstin || "").trim().toUpperCase();
    if (echoed && echoed !== key) {
      return {
        ok: false,
        reason: "mismatched-response",
        provider: req.provider,
        asked: key,
        answered: echoed,
        /* Providers tend to say so in plain words when it is a sandbox. */
        sandbox: /sandbox|free\s*credit|test(ing)?\s*only|demo/i.test(
          String(payload?.message || ""),
        ),
        providerMessage: payload?.message || null,
      };
    }

    /* Appyflow leaves the top-level state code out and only names the state
       inside the address; the GSTIN it echoes carries it in its first two
       digits, which is the authoritative place anyway. */
    if (!data.stateCode && echoed.length === 15) data.stateCode = echoed.slice(0, 2);

    const value = { ok: true, found: true, provider: req.provider, gstin: key, data };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (e?.name === "AbortError") {
      return { ok: false, reason: "timeout", provider: req.provider, timeoutMs: ms };
    }
    return { ok: false, reason: "network", provider: req.provider, message: e?.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Drop a cached answer — used after somebody fixes a registration. */
function forget(gstin) {
  cache.delete(String(gstin || "").trim().toUpperCase());
}

module.exports = {
  isConfigured,
  configHint,
  lookupGstin,
  forget,
  normalise,
  providerName,
  PRESETS,
  /* Exported for the tests, which must be able to empty it between cases. */
  _cache: cache,
};
