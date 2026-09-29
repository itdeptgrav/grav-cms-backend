// services/marketing/channels/campaignInventory.service.js
//
// ONE CAMPAIGN SHAPE, TWO ADVERTISING CHANNELS THAT DISAGREE ABOUT EVERYTHING.
//
// ── WHAT NORMALISATION MAY AND MAY NOT DO ──────────────────────────────────
// It may give a marketer one table they can read. It may NOT make two providers
// agree by discarding the half that disagrees. So every normalised row carries
// the provider's own status word beside GRAV's, and every figure keeps the
// currency and the precision the provider sent.
//
// Money is where this matters most. Google reports micros — 1/1,000,000 of the
// account currency. Meta reports minor units as a string, and how many minor
// units make a unit depends on the currency: 100 for a rupee or a dollar, 1 for
// a yen, 1000 for a dinar. Converting both to "a number of currency units" with
// one divisor would be wrong for a third of the world's currencies, quietly, by
// a factor of ten or a hundred. So the conversion is per-currency, from a table,
// and a currency the table does not know keeps its minor units and says so.
//
// ── AND A FAILED READ IS NEVER AN EMPTY LIST ───────────────────────────────
// Every list carries `readState`. `rows: []` means something only when it is
// `ok`. A channel that refused, timed out or answered unusably reports its own
// state and `campaigns: null` — never zero, never an empty array that a screen
// would render as "you have no campaigns".
"use strict";

const { fail } = require("../../storePurchase/errors");
const {
  GOOGLE_ADS_STATUS_MAP, META_STATUS_MAP, CAMPAIGN_STATUSES, CAMPAIGN_STATUS_CODES,
  CAMPAIGN_PAGE_DEFAULT, CAMPAIGN_PAGE_MAX, MARKETING_CHANNEL_CODES,
  READ_STATES, channel: channelSpec,
} = require("../../../constants/marketingChannels");
const directory = require("./channelDirectory.service");
const identity = require("./campaignIdentity");
const cursors = require("./campaignCursor");
const dates = require("./channelDates");
const googleAds = require("./googleAdsClient");
const metaAds = require("./metaAdsClient");

const str = (v) => String(v ?? "").trim();

/* ── MINOR UNITS PER CURRENCY UNIT ──────────────────────────────────────────
   ISO 4217 exponents for the currencies this deployment plausibly meets. A
   currency absent from this table is NOT assumed to be two-decimal: the amount
   is published in minor units with `precision: "minor_units"` beside it, so a
   reader is told the unit rather than shown a number that is wrong by 100.

   Two decimals is right for most of the world and catastrophically wrong for
   the yen, where it would report ¥5,000 as ¥50. */
const MINOR_UNITS = Object.freeze({
  INR: 100, USD: 100, EUR: 100, GBP: 100, AUD: 100, CAD: 100, SGD: 100,
  AED: 100, CHF: 100, CNY: 100, HKD: 100, NZD: 100, ZAR: 100, SEK: 100,
  JPY: 1, KRW: 1,
  BHD: 1000, KWD: 1000, OMR: 1000, JOD: 1000, TND: 1000,
});

/**
 * A money value in GRAV's shape, or a null with a reason.
 *
 * Never a bare number. A currency without its code is a number somebody will
 * add to a differently-denominated one.
 */
function money({ amount, currency, unit }) {
  if (amount === undefined || amount === null || amount === "") return null;
  const raw = Number(amount);
  if (!Number.isFinite(raw)) return null;

  const code = str(currency).toUpperCase() || null;

  if (unit === "micros") {
    /* Google's micros are exact integers. Divided by a power of ten, which is
       exact in binary floating point only for the integer part — so the value is
       carried as a number AND as the untouched provider figure, and a caller
       reconciling against a Google invoice can use the latter. */
    return {
      amount: raw / 1_000_000,
      currency: code,
      precision: "currency_units",
      providerAmount: String(amount),
      providerUnit: "micros",
    };
  }

  /* Meta's minor units. */
  const divisor = code ? MINOR_UNITS[code] : undefined;
  if (!divisor) {
    return {
      amount: raw,
      currency: code,
      /* Said out loud rather than guessed. A reader is told this figure is in
         the currency's smallest unit. */
      precision: "minor_units",
      providerAmount: String(amount),
      providerUnit: "minor_units",
    };
  }
  return {
    amount: raw / divisor,
    currency: code,
    precision: "currency_units",
    providerAmount: String(amount),
    providerUnit: "minor_units",
  };
}

/* A provider status word, normalised. Unknown stays unknown: a status GRAV does
   not recognise must not be bucketed as `ended`, which reads as a decision. */
function normaliseStatus(channel, providerStatus) {
  const word = str(providerStatus).toUpperCase();
  if (!word) return "unknown";
  const map = channel === "google_ads" ? GOOGLE_ADS_STATUS_MAP : META_STATUS_MAP;
  return map[word] || "unknown";
}

/* An ISO date, or null. Google sends `YYYY-MM-DD`; Meta sends a full ISO
   timestamp with an offset. Both are carried as the provider sent them and also
   normalised, because a marketer comparing two channels needs one format and an
   operator reconciling with a dashboard needs the other. */
function when(value) {
  const v = str(value);
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ── THE PUBLIC CURSOR ──────────────────────────────────────────────────────
   Both providers page with an opaque token of their own, and both are provider
   artefacts that must not travel to a browser as themselves.

   This wrapped them in base64 and called it opaque, which was wrong in the way
   that matters: base64 is EDITABLE. A caller could decode the payload, rewrite
   the channel, re-encode, and hand GRAV a cursor that paged one provider's list
   with another's token.

   `campaignCursor.js` signs it instead, under a signing purpose separate from
   the campaign identifier's, and carries the resolved company as well as the
   channel. The payload is still decodable and that is fine — a page token is not
   confidential. It is INTEGRITY-PROTECTED, which is the property a cursor
   actually needs, and nothing here describes it as more than that. */
const encodeCursor = ({ companyId, channel, pageToken }, env) =>
  cursors.encodeCursor({ companyId, channel, pageToken }, env);

const decodeCursor = (raw, { companyId, channel }, env) =>
  cursors.decodeCursor(raw, { companyId, channel }, env);

/**
 * A supplied page size, or a refusal.
 *
 * Refused rather than clamped, for the same reason the content inventory refuses
 * one: a caller that asked for 500 and silently received 100 pages by a position
 * it believes it chose, and skips four hundred rows without an error.
 */
function assertLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return CAMPAIGN_PAGE_DEFAULT;

  let numeric;
  if (typeof limit === "number") numeric = limit;
  else if (typeof limit === "string" && /^\d+$/.test(limit.trim())) numeric = Number(limit.trim());
  else {
    throw fail("VALIDATION",
      `limit must be a whole number between 1 and ${CAMPAIGN_PAGE_MAX}.`,
      { field: "limit", min: 1, max: CAMPAIGN_PAGE_MAX });
  }

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > CAMPAIGN_PAGE_MAX) {
    throw fail("VALIDATION",
      `limit must be a whole number between 1 and ${CAMPAIGN_PAGE_MAX}.`,
      { field: "limit", min: 1, max: CAMPAIGN_PAGE_MAX });
  }
  return numeric;
}

/**
 * The channel to list, which is REQUIRED.
 *
 * ── WHY THERE IS NO MERGED LIST ────────────────────────────────────────────
 * Google and Meta are independently paginated with incomparable cursors and no
 * shared ordering. A merged page would have an order that changes as either
 * provider's data changes, and a paginated list whose order is not stable
 * repeats rows and skips others. Asking for one channel at a time is the honest
 * shape, and the refusal says so rather than answering with a plausible mess.
 */
function assertChannel(channel) {
  const code = str(channel);
  if (!code) {
    throw fail("VALIDATION",
      "Name a channel. GRAV lists one channel at a time, because the channels page independently and a merged list would repeat and skip campaigns.",
      { field: "channel", accepted: MARKETING_CHANNEL_CODES });
  }
  const spec = channelSpec(code);
  if (!spec) {
    throw fail("VALIDATION", "That is not a channel GRAV connects to.",
      { field: "channel", accepted: MARKETING_CHANNEL_CODES });
  }
  if (!spec.supports.campaigns) {
    throw fail("CHANNEL_UNSUPPORTED_OPERATION",
      spec.role === "measurement"
        ? `${spec.label} measures activity. It does not publish campaigns, so it has no campaign list.`
        : `${spec.label} has no campaign list.`,
      { channel: code });
  }
  return code;
}

function assertStatus(status) {
  const code = str(status);
  if (!code) return null;
  if (!CAMPAIGN_STATUS_CODES.includes(code)) {
    throw fail("VALIDATION", "That is not a campaign status GRAV recognises.",
      { field: "status", accepted: CAMPAIGN_STATUS_CODES });
  }
  return code;
}

/* An optional date bound. Refused rather than ignored when malformed — a filter
   silently dropped is a list a caller believes is filtered and is not — and
   checked against the real calendar, not just a shape, so `2026-02-31` cannot
   quietly become a filter boundary in March. */
const assertOptionalDate = (value, field) => dates.assertOptionalCalendarDate(value, field);

/**
 * One provider row → one GRAV row.
 *
 * The public identity is minted here and the provider's own id is NOT published
 * under any key. `campaignIdentity` carries the mapping inside a signed token,
 * so a caller can hand one back and GRAV can resolve it, and a caller cannot
 * edit one into another company's campaign.
 */
function normaliseRow(row, { companyId, channel, env }) {
  const providerId = str(row.providerCampaignId);
  if (!providerId) {
    /* A campaign with no id cannot be addressed, so it cannot be listed — a row
       whose performance link would 404 is worse than a row that is absent and
       counted as unreadable. */
    return null;
  }

  const budgetCurrency = str(row.currency) || null;

  return {
    campaignId: identity.encodeCampaignId(
      { companyId, channel, providerCampaignId: providerId }, env,
    ),
    channel,
    channelLabel: channelSpec(channel)?.label || channel,
    name: str(row.name) || null,
    objective: str(row.objective) || null,
    /* Both. GRAV's normalisation for sorting and filtering, the provider's own
       word so a marketer's screen agrees with the dashboard they reconcile
       against — and can show why when it does not. */
    providerStatus: str(row.providerStatus) || null,
    status: normaliseStatus(channel, row.providerStatus),
    startDate: when(row.startDate),
    endDate: when(row.endDate),
    providerStartDate: str(row.startDate) || null,
    providerEndDate: str(row.endDate) || null,
    dailyBudget: channel === "google_ads"
      ? money({ amount: row.dailyBudgetMicros, currency: budgetCurrency, unit: "micros" })
      : money({ amount: row.dailyBudgetMinor, currency: budgetCurrency, unit: "minor" }),
    lifetimeBudget: channel === "google_ads"
      ? money({ amount: row.lifetimeBudgetMicros, currency: budgetCurrency, unit: "micros" })
      : money({ amount: row.lifetimeBudgetMinor, currency: budgetCurrency, unit: "minor" }),
    currency: budgetCurrency,
    providerUpdatedAt: when(row.providerUpdatedAt),
  };
}

/**
 * One page of one channel's campaigns.
 *
 * @returns {Promise<object>} always with a `readState`. `rows` is meaningful
 *   only when that is `ok`.
 */
async function list({ companyId, channel, status = null, cursor = null, limit, startDate = null, endDate = null, env = process.env, client = null } = {}) {
  directory.assertCompanyMayRead(companyId, env);

  const wanted = assertChannel(channel);
  const wantedStatus = assertStatus(status);
  const pageSize = assertLimit(limit);
  const from = assertOptionalDate(startDate, "startDate");
  const to = assertOptionalDate(endDate, "endDate");
  if (from && to && from > to) {
    throw fail("VALIDATION", "The start date is after the end date.", { field: "startDate" });
  }

  /* Verified locally. A modified, cross-channel, cross-company or malformed
     cursor is refused here — before any provider is contacted. */
  const pageToken = decodeCursor(cursor, { companyId, channel: wanted }, env);
  const readAt = new Date().toISOString();

  const empty = (readState, reasonCode) => ({
    channel: wanted,
    channelLabel: channelSpec(wanted)?.label || wanted,
    readState,
    reasonCode: reasonCode || null,
    /* NULL, not `[]`. A caller cannot accidentally render "no campaigns" from
       something that was never read. */
    rows: null,
    nextCursor: null,
    hasMore: false,
    campaignCount: null,
    providerTotal: null,
    measuredAt: readAt,
  });

  let page;
  try {
    const provider = client || (wanted === "google_ads" ? googleAds : metaAds);
    page = await provider.listCampaigns(
      { status: wantedStatus, pageToken, pageSize }, env,
    );
  } catch (err) {
    const state = directory.stateForFailure(err);
    /* `unknown` here means GRAV's own code threw. Reported as unavailable to a
       reader because the effect is the same — nothing was read — while the GRAV
       code travels for an administrator. */
    return empty(state === "ready" ? "unavailable" : state, str(err?.code) || null);
  }

  const rows = (page.rows || [])
    .map((r) => normaliseRow(r, { companyId, channel: wanted, env }))
    .filter(Boolean);

  /* ── DATE FILTERING HAPPENS HERE, AND SAYS SO ────────────────────────────
     Neither provider filters a campaign list by an overlapping date window in a
     way that means the same thing on both. Applied in GRAV against the campaign's
     own start and end, and `filteredLocally` is published so a caller knows the
     page size describes what the provider returned rather than what matched. */
  const filtered = (from || to)
    ? rows.filter((r) => {
      const startsBefore = !to || !r.startDate || r.startDate.slice(0, 10) <= to;
      const endsAfter = !from || !r.endDate || r.endDate.slice(0, 10) >= from;
      return startsBefore && endsAfter;
    })
    : rows;

  const nextToken = str(page.nextPageToken) || null;

  return {
    channel: wanted,
    channelLabel: channelSpec(wanted)?.label || wanted,
    readState: "ok",
    reasonCode: null,
    rows: filtered,
    /* The provider's own token, wrapped. A client carries it back unaltered. */
    /* The provider's own token, signed and wrapped. It is never published as
       a field of its own — a caller carries the cursor, not the token. */
    nextCursor: nextToken ? encodeCursor({ companyId, channel: wanted, pageToken: nextToken }, env) : null,
    hasMore: Boolean(nextToken),
    /* The number of rows ON THIS PAGE. Never presented as an estate size. */
    campaignCount: filtered.length,
    /* The provider's own count of the whole collection, when it sent one. Meta
       sends none, and null is the honest answer rather than a page length. */
    providerTotal: Number.isInteger(page.totalResults) ? page.totalResults : null,
    filteredLocally: Boolean(from || to),
    dateFilter: from || to ? { startDate: from, endDate: to } : null,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Resolve a public campaign id to its channel and provider id.
 *
 * Local arithmetic. A malformed, forged or foreign id is refused here, before
 * any provider is contacted — which is the requirement and also what stops this
 * route being used to make GRAV hammer an upstream API.
 */
function resolve(campaignId, { companyId, env = process.env } = {}) {
  return identity.decodeCampaignId(campaignId, { companyId }, env);
}

const vocabulary = Object.freeze({
  statuses: CAMPAIGN_STATUSES,
  readStates: READ_STATES,
  money: Object.freeze({
    precisionMeans: "currency_units is the amount in whole currency units. minor_units means GRAV does not know this currency's subdivision and has published the provider's own smallest-unit figure unchanged.",
    providerAmountMeans: "The provider's own figure, unaltered, for reconciling against their invoice.",
  }),
});

module.exports = {
  list,
  resolve,
  normaliseRow,
  normaliseStatus,
  money,
  encodeCursor,
  decodeCursor,
  assertLimit,
  assertChannel,
  assertStatus,
  MINOR_UNITS,
  vocabulary,
};
