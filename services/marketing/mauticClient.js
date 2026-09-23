// services/marketing/mauticClient.js
//
// GRAV'S ONLY DOOR INTO MAUTIC.
//
// ── WHAT THIS IS ALLOWED TO DO ─────────────────────────────────────────────
// Speak Mautic's supported REST API over HTTP. That is the whole permission.
// It opens no database connection, reads no Mautic table, and imports no
// Mautic code — ADR-004 refuses all three, and the deployment enforces the
// first by putting MariaDB on a network with no published port.
//
// ── THE ENDPOINTS, VERIFIED AGAINST MAUTIC 7.2.0 ───────────────────────────
// Read from `mautic/core-lib` at tag 7.x on 9 September 2026 — from the
// routing config and the API functional tests, not from a blog post:
//
//   GET   /api/contacts?where[0][col]=email&where[0][expr]=eq&where[0][val]=…
//   POST  /api/contacts/new
//   PATCH /api/contacts/{id}/edit
//   GET   /api/contacts/{id}
//   GET   /api/segments
//   POST  /api/segments/{id}/contact/{contactId}/add
//
// `where[]` rather than `search=`: `search` is a fuzzy full-text match and a
// fuzzy match is not an identity rule. Asking for an exact `email eq` is the
// difference between "the same person" and "a person whose name looks
// similar", and only one of those may be allowed to update a contact.
//
// ── A FAILURE IS NEVER AN ANSWER ───────────────────────────────────────────
// Every method distinguishes three outcomes and the caller can tell them
// apart: the thing exists, the thing does not exist, or MAUTIC COULD NOT BE
// ASKED. Returning `[]` or `0` for the third is the specific failure the
// product plan names twice ("Never report a failed or unavailable Mautic read
// as zero"; "Mautic downtime renders unavailable states rather than false
// zeroes"), because a false zero is indistinguishable from a real one and
// every screen downstream will present it as fact.
//
// ── RETRIES ARE FOR TRANSIENT FAILURES ONLY ────────────────────────────────
// A timeout, a connection reset, a 429 or a 5xx may be retried, with backoff.
// A 400 or a 422 is a statement about the request and retrying it is a way of
// making the same mistake more times; a 401 or 403 is a credential problem
// that a retry cannot fix and that hammering may lock out. Both are terminal.
"use strict";

const axios = require("axios");

const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const int = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

/* ── SAFE LOGGING ───────────────────────────────────────────────────────────
   A log line is read by more people than the record it describes. These strip
   the two things that must never reach one: the credential, and the person. */
const maskEmail = (email) => {
  const v = str(email).toLowerCase();
  const at = v.indexOf("@");
  if (at <= 0) return v ? "***" : "";
  return `${v[0]}***@${v.slice(at + 1)}`;
};

/** A URL with its query values replaced by their shape. `?where[0][val]=…`
 *  carries an email address, and the path alone is what a log needs. */
const safeUrl = (url) => str(url).split("?")[0];

/* ── CONFIGURATION ──────────────────────────────────────────────────────────
   Read once, validated once, and refused rather than defaulted. An auth mode
   that silently falls back to the weaker scheme is a downgrade nobody sees. */
function readConfig(env = process.env, lane = "operational") {
  const baseUrl = str(env.MAUTIC_BASE_URL).replace(/\/+$/, "");
  const mode = str(env.MAUTIC_AUTH_MODE).toLowerCase() || "oauth2";

  const problems = [];
  if (!baseUrl) problems.push("MAUTIC_BASE_URL is not set.");
  else if (!/^https?:\/\//i.test(baseUrl)) problems.push("MAUTIC_BASE_URL must start with http:// or https://.");

  if (!["oauth2", "basic"].includes(mode)) {
    problems.push(`MAUTIC_AUTH_MODE must be "oauth2" or "basic" (it is "${mode}").`);
  }
  if (mode === "oauth2") {
    if (!str(env.MAUTIC_OAUTH_CLIENT_ID)) problems.push("MAUTIC_OAUTH_CLIENT_ID is not set.");
    if (!str(env.MAUTIC_OAUTH_CLIENT_SECRET)) problems.push("MAUTIC_OAUTH_CLIENT_SECRET is not set.");
  }
  if (mode === "basic") {
    if (!str(env.MAUTIC_BASIC_USERNAME)) problems.push("MAUTIC_BASIC_USERNAME is not set.");
    if (!str(env.MAUTIC_BASIC_PASSWORD)) problems.push("MAUTIC_BASIC_PASSWORD is not set.");
  }

  /* Plain http to anywhere but a development host is refused. A marketing API
     token on the wire in clear is a token somebody else now has, and the
     mistake is one environment variable wide. */
  if (/^http:\/\//i.test(baseUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|mautic)(:|\/|$)/i.test(baseUrl)) {
    problems.push("MAUTIC_BASE_URL uses plain http to a non-local host. Use https.");
  }

  /* ── WHICH CREDENTIAL, AND WHY THERE ARE TWO ──────────────────────────────
     `operational` writes contacts, segments and campaign membership.
     `content` reads the email, form and landing-page catalogue and nothing
     else. They are separate Mautic identities behind separate gateway
     policies, because Mautic authorises `POST /api/emails/{id}/send` with the
     same grant that authorises `GET /api/emails` — so a single credential
     holding both jobs would be one theft away from mailing the contact estate.

     `content` falls back to the operational credential only when no content
     credential is configured, and the content service refuses to run in that
     state rather than quietly using the wrong identity. */
  const contentUser = str(env.MAUTIC_CONTENT_BASIC_USERNAME);
  const contentPass = str(env.MAUTIC_CONTENT_BASIC_PASSWORD);
  const useContent = lane === "content" && contentUser && contentPass;

  return {
    baseUrl,
    mode,
    lane,
    contentCredentialConfigured: Boolean(contentUser && contentPass),
    clientId: str(env.MAUTIC_OAUTH_CLIENT_ID),
    clientSecret: str(env.MAUTIC_OAUTH_CLIENT_SECRET),
    username: useContent ? contentUser : str(env.MAUTIC_BASIC_USERNAME),
    password: useContent ? contentPass : str(env.MAUTIC_BASIC_PASSWORD),
    timeoutMs: int(env.MAUTIC_HTTP_TIMEOUT_MS, 10_000),
    retries: Math.max(0, Math.min(int(env.MAUTIC_HTTP_RETRIES, 2), 5)),
    problems,
    configured: problems.length === 0,
  };
}

/* Which failures are worth trying again. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODE = new Set([
  "ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH",
]);

const isRetryable = (err) => {
  const status = err?.response?.status;
  if (status) return RETRYABLE_STATUS.has(status);
  return RETRYABLE_CODE.has(str(err?.code)) || /timeout/i.test(str(err?.message));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── A NON-200 READ IS NOT AUTOMATICALLY AN OUTAGE ──────────────────────────
   These helpers used to raise MAUTIC_UNAVAILABLE for every status that was not
   200, which put a malformed query — a filter Mautic rejects, a field that does
   not exist — into the same bucket as an unreachable instance. The delivery
   retry policy then treated it as transient and spent six hours of backoff on a
   request that could never succeed, hidden among the genuine outages.

   4xx is the request. 5xx and anything unrecognised is the instance. 401/403
   never reach here — `request()` has already raised AUTH_FAILED for those. */
function failForReadStatus(status, what) {
  if (status >= 400 && status < 500) {
    return fail("MAUTIC_BAD_REQUEST",
      `Mautic refused the ${what} request (${status}). Re-sending it unchanged will not help.`,
      { status });
  }
  return fail("MAUTIC_UNAVAILABLE", `Mautic answered ${status} to a ${what}.`, { status });
}

/**
 * The Mautic client.
 *
 * `transport` is injectable so the synthetic contract double
 * (services/marketing/mauticTestDouble.js) can be put in its place without a
 * network, a container or a credential. That is the seam this whole chunk
 * rests on: the contract can be proved without an instance, and the SAME code
 * then runs against a real one.
 */
class MauticClient {
  /**
   * @param {"operational"|"content"} [lane]  which credential to present.
   *   `operational` writes contacts and memberships; `content` reads the
   *   catalogue. They are separate Mautic identities behind separate gateway
   *   policies — see `readConfig`.
   */
  constructor({ env = process.env, transport = null, lane = "operational" } = {}) {
    this.lane = lane;
    this.config = readConfig(env, lane);
    this.transport = transport || axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      /* Never throw on a status; every status is inspected here, so a 404 can
         mean "not found" rather than becoming an exception that a caller has
         to unwrap to discover it was an ordinary answer. */
      validateStatus: () => true,
    });
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /** Refuse to act on an invalid configuration, naming every problem at once
   *  so it takes one round of fixing rather than four. */
  assertConfigured() {
    if (!this.config.configured) {
      throw fail("MAUTIC_NOT_CONFIGURED", `The Mautic integration is not configured: ${this.config.problems.join(" ")}`, {
        problems: this.config.problems,
      });
    }
  }

  /* ── AUTHENTICATION ─────────────────────────────────────────────────────
     OAuth2 client_credentials against Mautic's own token endpoint, cached
     until shortly before it expires. The 60-second margin is not politeness:
     a token that expires between the check and the call produces a 401 that
     looks exactly like a revoked credential. */
  async authHeaders() {
    this.assertConfigured();
    if (this.config.mode === "basic") {
      const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      return { Authorization: `Basic ${basic}` };
    }
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return { Authorization: `Bearer ${this.token}` };
    }

    const res = await this.transport.request({
      method: "POST",
      url: "/oauth/v2/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });

    if (res.status !== 200 || !res.data?.access_token) {
      /* Neither the secret nor Mautic's response body is logged or returned:
         a token endpoint's error body has been known to echo the credential
         back. The status is what a person needs to act. */
      throw fail("MAUTIC_AUTH_FAILED",
        "GRAV could not authenticate with Mautic. Check the API credentials.",
        { status: res.status });
    }

    this.token = res.data.access_token;
    this.tokenExpiresAt = Date.now() + int(res.data.expires_in, 3600) * 1000;
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * One API call, with bounded retries.
   *
   * @returns {Promise<{status:number, data:any}>} — every status, including
   *   404, comes back as data. Only being unable to ASK throws.
   */
  async request({ method, url, data = undefined, params = undefined }) {
    this.assertConfigured();
    let lastErr = null;

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
      try {
        const headers = { Accept: "application/json", ...(await this.authHeaders()) };
        const res = await this.transport.request({ method, url, data, params, headers });

        if (RETRYABLE_STATUS.has(res.status)) {
          lastErr = Object.assign(new Error(`Mautic returned ${res.status}`), { response: res });
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          /* Terminal. A retry cannot mint permission, and repeating a bad
             credential is how an integration identity gets locked out. */
          throw fail("MAUTIC_AUTH_FAILED",
            "Mautic refused GRAV's credentials. Check the integration user's permissions.",
            { status: res.status, url: safeUrl(url) });
        }
        return { status: res.status, data: res.data };
      } catch (err) {
        if (err?.code === "MAUTIC_AUTH_FAILED" || err?.code === "MAUTIC_NOT_CONFIGURED") throw err;
        if (!isRetryable(err)) {
          throw fail("MAUTIC_UNAVAILABLE",
            "Mautic could not be reached. This is not an empty result — nothing could be checked.",
            { url: safeUrl(url), reason: str(err?.code) || str(err?.message).slice(0, 120) });
        }
        lastErr = err;
      }
    }

    console.error(`[mautic] ${method} ${safeUrl(url)} failed after ${this.config.retries + 1} attempts:`,
      str(lastErr?.code) || str(lastErr?.message).slice(0, 200));
    throw fail("MAUTIC_UNAVAILABLE",
      "Mautic did not respond. This is not an empty result — nothing could be checked.",
      { url: safeUrl(url), attempts: this.config.retries + 1 });
  }

  /* ═══ THE SUPPORTED CALLS ════════════════════════════════════════════════ */

  /**
   * The contact whose email is exactly this one.
   *
   * @returns {Promise<{found:boolean, contact:object|null}>} — `found:false` is
   *   a real answer from a reachable Mautic. An unreachable one throws.
   */
  async findContactByEmail(email) {
    const wanted = str(email).toLowerCase();
    if (!wanted) {
      throw fail("VALIDATION", "A Mautic contact lookup needs an email address.", { field: "email" });
    }
    const { status, data } = await this.request({
      method: "GET",
      url: "/api/contacts",
      params: {
        "where[0][col]": "email",
        "where[0][expr]": "eq",
        "where[0][val]": wanted,
        limit: 2,
        minimal: true,
      },
    });
    if (status !== 200) {
      throw failForReadStatus(status, "contact lookup");
    }

    /* Mautic returns `contacts` as an OBJECT keyed by id, not an array. A
       caller that spreads it into an array gets nothing and reads it as "no
       match" — which would then create a second contact for a person Mautic
       already holds. */
    const rows = Object.values(data?.contacts || {});
    return { found: rows.length > 0, contact: rows[0] || null, total: int(data?.total, rows.length) };
  }

  /** Create one contact. `POST /api/contacts/new`. */
  async createContact(fields) {
    const { status, data } = await this.request({ method: "POST", url: "/api/contacts/new", data: fields });
    if (status !== 200 && status !== 201) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused to create the contact (${status}).`,
        { status, errors: data?.errors || null });
    }
    return data?.contact || null;
  }

  /** Update one contact in place. PATCH, not PUT: PUT on this endpoint is a
   *  full replacement and would blank every field GRAV did not send. */
  async updateContact(id, fields) {
    const { status, data } = await this.request({
      method: "PATCH", url: `/api/contacts/${encodeURIComponent(id)}/edit`, data: fields,
    });
    if (status !== 200) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused to update contact ${id} (${status}).`,
        { status, errors: data?.errors || null });
    }
    return data?.contact || null;
  }

  /** The segments this instance holds. Used to resolve an alias to an id. */
  async listSegments() {
    const { status, data } = await this.request({ method: "GET", url: "/api/segments", params: { limit: 200 } });
    if (status !== 200) {
      throw failForReadStatus(status, "segment list");
    }
    return Object.values(data?.lists || {});
  }

  /**
   * Add a contact to a segment.
   * `POST /api/segments/{id}/contact/{contactId}/add`.
   *
   * Mautic answers `{success: true}` for a contact that was ALREADY in the
   * segment, so enrolment is idempotent at the source and this needs no
   * "already a member" branch of its own.
   */
  async addContactToSegment(segmentId, contactId) {
    const { status, data } = await this.request({
      method: "POST",
      url: `/api/segments/${encodeURIComponent(segmentId)}/contact/${encodeURIComponent(contactId)}/add`,
    });
    if (status !== 200) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused the segment enrolment (${status}).`, { status });
    }
    return { success: data?.success !== false };
  }

  /* ═══ THE PER-PERSON ACQUISITION STOP ════════════════════════════════════
     Four calls, and between them they are the whole supported mechanism for
     taking ONE person out of GRAV-managed acquisition automation in Mautic 7.2
     without touching anybody else and without touching consent.

     Verified against the running 7.2.0 instance and against its own source:

       POST /api/segments/{id}/contact/{leadId}/remove
         → LeadModel::removeFromLists($lead, $lists, $manuallyRemoved = TRUE),
           which sets `manually_removed = 1` on the pivot row. Every segment
           rebuild query in LeadListRepository then excludes that row
           (`ll.manually_removed = 0`), so the removal SURVIVES the nightly
           `mautic:segments:update` instead of being undone by it.

       POST /api/campaigns/{id}/contact/{leadId}/remove
         → MembershipManager::removeContact → Remover::updateExistingMembership,
           which UNSCHEDULES the contact's pending campaign events and then sets
           `manually_removed = true`. A second call finds the membership already
           manually removed, raises ContactAlreadyRemovedFromCampaignException,
           and the manager swallows it — so replay is idempotent at the source,
           which is requirement 7 holding below GRAV rather than only inside it.

     What is NOT used, deliberately:
       - `POST /api/contacts/{id}/dnc/email/add` — that is do-not-contact, i.e.
         Mautic's unsubscribe. Sales taking ownership is not the person
         withdrawing permission, and recording it as one would be a false and
         near-permanent claim about something only they may decide.
       - `PATCH /api/campaigns/{id}/edit` with `isPublished: false` — that stops
         the campaign for EVERYONE. One accepted Prospect must never do that. */

  /** The campaigns one contact is currently in. */
  async contactCampaigns(contactId) {
    const { status, data } = await this.request({
      method: "GET", url: `/api/contacts/${encodeURIComponent(contactId)}/campaigns`,
    });
    if (status !== 200) {
      throw failForReadStatus(status, "contact-campaign read");
    }
    return Object.values(data?.campaigns || {});
  }

  /**
   * The campaigns this instance holds and this identity may SEE.
   *
   * ── WHY A SERVICE CALLS THIS BEFORE TRUSTING A MEMBERSHIP READ ────────────
   * `GET /api/contacts/{id}/campaigns` answers `200` with an EMPTY list for an
   * identity that lacks campaign permission — it does not answer 403. So a
   * caller reading only that endpoint cannot tell "this person is in no
   * campaign" from "I am not allowed to know". This endpoint DOES answer 403,
   * which `request()` turns into MAUTIC_AUTH_FAILED, so one call here converts a
   * silent blindness into a loud, correct refusal.
   */
  async listCampaigns() {
    const { status, data } = await this.request({
      method: "GET", url: "/api/campaigns", params: { limit: 200, minimal: true },
    });
    if (status !== 200) {
      throw failForReadStatus(status, "campaign list");
    }
    return Object.values(data?.campaigns || {});
  }

  /** One segment, with its filters. The filters are what the standing
   *  acquisition-hold exclusion lives in, so they must be readable. */
  async getSegment(segmentId) {
    const { status, data } = await this.request({
      method: "GET", url: `/api/segments/${encodeURIComponent(segmentId)}`,
    });
    if (status !== 200) {
      throw failForReadStatus(status, "segment read");
    }
    return data?.list || null;
  }

  /** Change one segment's definition. PATCH, not PUT: PUT replaces the whole
   *  segment and would drop every field GRAV did not send. */
  async updateSegment(segmentId, fields) {
    const { status, data } = await this.request({
      method: "PATCH", url: `/api/segments/${encodeURIComponent(segmentId)}/edit`, data: fields,
    });
    if (status !== 200) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused to update segment ${segmentId} (${status}).`,
        { status, errors: data?.errors || null });
    }
    return data?.list || null;
  }

  /** One campaign, including the segments it draws contacts from. */
  async getCampaign(campaignId) {
    const { status, data } = await this.request({
      method: "GET", url: `/api/campaigns/${encodeURIComponent(campaignId)}`,
    });
    if (status !== 200) {
      throw failForReadStatus(status, "campaign read");
    }
    return data?.campaign || null;
  }

  /** The contact as Mautic holds it now — used to READ BACK a field GRAV set,
   *  because a 200 on the write is not evidence that the value stuck. */
  async getContact(contactId) {
    const { status, data } = await this.request({
      method: "GET", url: `/api/contacts/${encodeURIComponent(contactId)}`,
    });
    if (status !== 200) {
      throw failForReadStatus(status, "contact read");
    }
    return data?.contact || null;
  }

  /** Take ONE contact out of ONE segment. The segment itself is untouched. */
  async removeContactFromSegment(segmentId, contactId) {
    const { status, data } = await this.request({
      method: "POST",
      url: `/api/segments/${encodeURIComponent(segmentId)}/contact/${encodeURIComponent(contactId)}/remove`,
    });
    if (status !== 200) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused to remove the contact from segment ${segmentId} (${status}).`,
        { status, segmentId });
    }
    return { success: data?.success !== false };
  }

  /** Take ONE contact out of ONE campaign. The campaign keeps running for
   *  everybody else, and its definition is not edited. */
  async removeContactFromCampaign(campaignId, contactId) {
    const { status, data } = await this.request({
      method: "POST",
      url: `/api/campaigns/${encodeURIComponent(campaignId)}/contact/${encodeURIComponent(contactId)}/remove`,
    });
    if (status !== 200) {
      throw fail("MAUTIC_REJECTED_WRITE", `Mautic refused to remove the contact from campaign ${campaignId} (${status}).`,
        { status, campaignId });
    }
    return { success: data?.success !== false };
  }

  /** The segments one contact is in — how the round trip PROVES enrolment
   *  rather than trusting the write's own answer. */
  async contactSegments(contactId) {
    const { status, data } = await this.request({
      method: "GET", url: `/api/contacts/${encodeURIComponent(contactId)}/segments`,
    });
    if (status !== 200) {
      throw failForReadStatus(status, "contact-segment read");
    }
    return Object.values(data?.lists || {});
  }
  /* ═══ THE READ-ONLY CONTENT INVENTORY ════════════════════════════════════

     Emails, forms and landing pages, listed so a marketer can see the estate
     from GRAV. Mautic owns content storage, editing, publishing and sending
     (ADR-004); these three calls read a catalogue and nothing else.

     ── VERIFIED AGAINST THE LIVE 7.2.0 INSTANCE, NOT GUESSED ───────────────
     Every decision below came from probing the running instance:

       envelope     `{ total: <number>, emails|forms|pages: <collection> }`
       container    INCONSISTENT. `emails` comes back as an OBJECT keyed by id;
                    `forms` and `pages` come back as ARRAYS. Both are handled,
                    because a caller that spread the object into an array would
                    read a populated instance as empty.
       paging       offset based: `start` + `limit`. There is no provider
                    cursor. `start` beyond the end returns 200 with zero rows
                    and the correct total.
       ordering     `orderBy` + `orderByDir` work and are stable across calls.
                    Always sent explicitly: an unordered page is a page that can
                    repeat and skip rows as content changes underneath it.
       total        a real count of the collection — but NOT of a filtered
                    query. `search=x` returned `total: 22` beside one row. This
                    slice therefore sends no filter, and says so.

     ── WHY minimal=true IS NOT AN OPTIMISATION ─────────────────────────────
     It is the security boundary. A full email row carries `customHtml`,
     `plainText`, `lists` (the recipient segments), `bccAddress`, `fromAddress`
     and `dynamicContent`; a full form row carries `cachedHtml`, `fields` and
     `actions`; a full page row carries `customHtml`. With `minimal=true` the
     provider returns twelve identity-and-status fields and none of that ever
     crosses the wire into this process — which is a stronger guarantee than
     fetching it and promising to strip it.

     The cost is honest and stated: `publishUp`, `publishDown` and a form's
     language are absent in minimal mode, so GRAV reports them as `null`
     (unknown) rather than inventing them. */

  /**
   * One page of a content collection.
   *
   * @returns {Promise<{rows:Array, total:number|null, start:number, limit:number}>}
   *   `rows` is always an array. `total` is the provider's count, or null when
   *   it did not send a usable one — never a substituted page length.
   */
  async listContent(kind, { start = 0, limit = 25 } = {}) {
    const spec = CONTENT_COLLECTIONS[kind];
    if (!spec) {
      throw fail("VALIDATION", `"${kind}" is not a Mautic content collection GRAV reads.`, {
        kind, accepted: Object.keys(CONTENT_COLLECTIONS),
      });
    }

    /* ── SUPPLIED VALUES ARE VALIDATED, NOT CLAMPED ───────────────────────
       Silently turning a requested 500 into 100, or a requested 0 into 25, is
       an answer to a question nobody asked — and a caller paging by an offset it
       believes it chose will skip rows. An omitted value takes the default; a
       supplied one is either in range or refused. */
    const safeStart = assertBoundedInteger(start, 0, Number.MAX_SAFE_INTEGER, "start", 0);
    const safeLimit = assertBoundedInteger(limit, 1, CONTENT_MAX_LIMIT, "limit", 25);

    const { status, data } = await this.request({
      method: "GET",
      url: spec.url,
      params: {
        start: safeStart,
        limit: safeLimit,
        /* Explicit and stable. Mautic's default order is not documented and is
           not guaranteed to survive a content edit. */
        orderBy: "id",
        orderByDir: "ASC",
        minimal: true,
      },
    });

    if (status !== 200) {
      throw failForReadStatus(status, `${kind} list`);
    }

    /* ── A MALFORMED ENVELOPE IS AN ERROR, NOT AN EMPTY LIST ──────────────
       The difference matters more here than almost anywhere else in this
       integration: "this company has no landing pages" and "GRAV could not
       understand what Mautic sent" would look identical on a screen, and only
       one of them means somebody should go and look. */
    if (!data || typeof data !== "object") {
      throw fail("MAUTIC_MALFORMED_RESPONSE",
        `Mautic's ${kind} list was not an object, so GRAV cannot tell an empty estate from an unreadable one.`,
        { kind });
    }
    const container = data[spec.key];
    if (container === undefined || container === null) {
      throw fail("MAUTIC_MALFORMED_RESPONSE",
        `Mautic's ${kind} list did not contain a "${spec.key}" collection, so GRAV cannot report it as empty.`,
        { kind, expectedKey: spec.key, received: Object.keys(data).slice(0, 10) });
    }
    if (typeof container !== "object") {
      throw fail("MAUTIC_MALFORMED_RESPONSE",
        `Mautic's "${spec.key}" collection was a ${typeof container}, not a list.`,
        { kind, expectedKey: spec.key });
    }

    /* An OBJECT keyed by id for emails, an ARRAY for forms and pages. A real
       difference in the provider, absorbed here so no caller has to know. */
    const rows = Array.isArray(container) ? container : Object.values(container);
    if (rows.some((r) => !r || typeof r !== "object")) {
      throw fail("MAUTIC_MALFORMED_RESPONSE",
        `Mautic's ${kind} list contained an entry that was not an object.`, { kind });
    }

    /* ── A TOTAL IS USABLE ONLY IF IT IS A COUNT ──────────────────────────
       A finite, non-negative INTEGER. A float, a negative, a numeric string, a
       NaN or an absent value all mean the same thing to a reader — GRAV does not
       know how many there are — and every one of them is reported as unavailable
       rather than rounded into a number somebody would act on. Never the page
       length: that says 25 when there are 4,000. */
    const total = (typeof data.total === "number"
      && Number.isInteger(data.total)
      && data.total >= 0)
      ? data.total
      : null;

    return { rows, total, start: safeStart, limit: safeLimit };
  }

  /** Emails, as a catalogue. Never their bodies, recipients or send controls. */
  listEmails(options) { return this.listContent("email", options); }

  /** Forms, as a catalogue. Never their fields, actions or submissions. */
  listForms(options) { return this.listContent("form", options); }

  /** Landing pages, as a catalogue. Never their HTML. */
  listPages(options) { return this.listContent("landing_page", options); }
}

/**
 * A supplied paging value, or a refusal.
 *
 * Omitted takes the default. Anything supplied must be a whole number inside the
 * documented range: zero, negatives, fractions, arrays, objects, numeric strings
 * and values above the maximum are all refused by name. Clamping them would be
 * a silent answer to a different question.
 */
function assertBoundedInteger(value, min, max, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    const received = Array.isArray(value) ? "an array" : (value === null ? "null" : `a ${typeof value}`);
    throw fail("VALIDATION",
      `${field} must be a whole number between ${min} and ${max}.`,
      { field, min, max, received: typeof value === "number" ? value : received });
  }
  return value;
}

/* ── THE ONLY CONTENT ENDPOINTS GRAV MAY TOUCH ──────────────────────────────
   A closed table, read by `listContent` and by nothing else. Adding a kind here
   is a deliberate act, and there is no code path that builds one of these URLs
   from a caller-supplied string. */
const CONTENT_COLLECTIONS = Object.freeze({
  email: { url: "/api/emails", key: "emails" },
  form: { url: "/api/forms", key: "forms" },
  landing_page: { url: "/api/pages", key: "pages" },
});

/* Bounded at the client, not only at the route: a service calling this directly
   must not be able to ask Mautic for ten thousand rows either. */
const CONTENT_MAX_LIMIT = 100;

module.exports = { MauticClient, readConfig, maskEmail, safeUrl, isRetryable, failForReadStatus };
module.exports.CONTENT_COLLECTIONS = CONTENT_COLLECTIONS;
module.exports.CONTENT_MAX_LIMIT = CONTENT_MAX_LIMIT;
