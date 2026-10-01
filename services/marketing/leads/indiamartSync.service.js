// services/marketing/leads/indiamartSync.service.js
//
// PULLING INDIAMART ENQUIRIES INTO THE MARKETING INBOX — BOUNDED, ONE CALL AT
// A TIME, AND SAFE TO REPEAT.
//
// ── ONE CHECK ──────────────────────────────────────────────────────────────
//   1. The company must be the Marketing company and the deployment must hold
//      a key; otherwise the source is not configured and nothing is called.
//   2. The state row is taken atomically: no other check running, at least 5
//      minutes since the last call, and no 429 backoff in force. `lastCallAt`
//      is written in the same step, BEFORE the call — a call whose answer is
//      lost still counted against IndiaMART's limit.
//   3. The window: from the last covered moment less a 15-minute overlap (or 7
//      days back on the first check), to 7 days later or now, whichever is
//      first, never earlier than IndiaMART's 365 days.
//   4. One call. Every record is saved under IndiaMART's own UNIQUE_QUERY_ID;
//      one already held is counted and left alone.
//   5. Only when every record in the window is saved does `coveredThrough`
//      move forward. A failed call, a cut-short answer or a failed save leaves
//      it where it was, so the next check fetches the same window again — and
//      deduplication makes that harmless.
//
// ── WHAT A CHECK NEVER DOES ────────────────────────────────────────────────
// It never processes an enquiry, creates a person, records or infers marketing
// permission, or writes anything in Sales. It never calls IndiaMART from a
// read, and never more than once per check.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const { MarketingSourceEnquiry } = require("../../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const { MarketingLeadSourceState } = require("../../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const client = require("./indiamartClient");
const I = require("../../../constants/marketingIndiamart");

const str = (v) => String(v ?? "").trim();
const L = I.LIMITS;

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIGURATION — THE KEY IS READ HERE AND RETURNED TO ONE CALLER ONLY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The key for this company, or null. A key is bound to the one Marketing
 * company (MARKETING_COMPANY_ID); for any other company the source is simply
 * not configured.
 */
function keyFor(companyId, env = process.env) {
  const key = str(env[I.KEY_ENV]);
  const company = str(env.MARKETING_COMPANY_ID);
  if (!key || /\s/.test(key) || key.length > 256) return null;
  if (!/^[a-f\d]{24}$/i.test(company)) return null;
  if (company.toLowerCase() !== str(companyId).toLowerCase()) return null;
  return key;
}

const isConfigured = (companyId, env) => Boolean(keyFor(companyId, env));

/* ═══════════════════════════════════════════════════════════════════════════
   THE WINDOW
   ═══════════════════════════════════════════════════════════════════════════ */

const floorSecond = (ms) => Math.floor(ms / 1000) * 1000;

/**
 * The next window to ask for.
 *
 * @returns {{ from: Date, to: Date, gap: {from: Date, to: Date}|null }}
 */
function nextWindow(state, nowMs) {
  const now = floorSecond(nowMs);
  const floor = now - L.RETENTION_MS + L.RETENTION_MARGIN_MS;
  let from = state?.coveredThrough
    ? new Date(state.coveredThrough).getTime() - L.OVERLAP_MS
    : now - L.MAX_WINDOW_MS;
  let gap = null;
  if (from < floor) {
    /* IndiaMART no longer holds this range. Recorded, never glossed over. */
    if (state?.coveredThrough) gap = { from: new Date(state.coveredThrough), to: new Date(floor) };
    from = floor;
  }
  from = floorSecond(from);
  const to = Math.min(from + L.MAX_WINDOW_MS, now);
  return { from: new Date(from), to: new Date(to), gap };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ONE RECORD, UNDER GRAV'S NAMES
   ═══════════════════════════════════════════════════════════════════════════ */

/* Control characters out (tabs and newlines kept), then cut to the stored
   length so a long field is shortened rather than the whole record refused. */
const clean = (v, max) => str(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * IndiaMART's record → the stored shape, or null when it cannot be held
 * (no usable UNIQUE_QUERY_ID means nothing to deduplicate on).
 */
function normalise(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const externalEventKey = str(raw.UNIQUE_QUERY_ID);
  if (!KEY_PATTERN.test(externalEventKey)) return null;

  const typeCode = str(raw.QUERY_TYPE).toUpperCase();
  const name = clean(raw.SENDER_NAME, 200);
  const placeholder = I.PLACEHOLDER_NAMES.includes(name.toLowerCase());
  const seconds = /^\d{1,7}$/.test(str(raw.CALL_DURATION)) ? Number(str(raw.CALL_DURATION)) : null;
  const submittedAtText = clean(raw.QUERY_TIME, 40);

  return {
    externalEventKey,
    kind: I.kindFor(typeCode),
    sourceType: /^[A-Z]{1,16}$/.test(typeCode) ? typeCode : "",
    submittedAt: client.parseIst(submittedAtText),
    submittedAtText,
    contact: {
      fullName: placeholder ? "" : name,
      nameIsPlaceholder: placeholder,
      companyName: clean(raw.SENDER_COMPANY, 300),
      phone: clean(raw.SENDER_MOBILE, 40),
      phoneAlt: clean(raw.SENDER_MOBILE_ALT, 40),
      landline: clean(raw.SENDER_PHONE, 40),
      landlineAlt: clean(raw.SENDER_PHONE_ALT, 40),
      email: clean(raw.SENDER_EMAIL, 254),
      emailAlt: clean(raw.SENDER_EMAIL_ALT, 254),
      streetAddress: clean(raw.SENDER_ADDRESS, 500),
      city: clean(raw.SENDER_CITY, 120),
      region: clean(raw.SENDER_STATE, 120),
      postalCode: clean(raw.SENDER_PINCODE, 20),
      country: clean(raw.SENDER_COUNTRY_ISO, 8).toUpperCase(),
    },
    context: {
      subject: clean(raw.SUBJECT, 500),
      productName: clean(raw.QUERY_PRODUCT_NAME, 300),
      categoryName: clean(raw.QUERY_MCAT_NAME, 300),
      message: clean(raw.QUERY_MESSAGE, 5000),
      callDurationSeconds: seconds,
      receiverPhone: clean(raw.RECEIVER_MOBILE, 40),
    },
  };
}

const newRef = () => `MSE-${crypto.randomBytes(8).toString("hex")}`;

const isDuplicate = (err) => err?.code === 11000 || err?.code === 11001;
const isOnKey = (err) => Boolean(err?.keyPattern?.externalEventKey)
  || /externalEventKey/.test(String(err?.message || ""));
const isRecordInvalid = (err) => ["ValidationError", "CastError", "StrictModeError"].includes(err?.name);

/**
 * Save every record of one window. Returns the counts; throws `storage_failed`
 * when the database itself failed, because then the window is not covered.
 */
async function saveAll({ companyId, records, window, pulledAt }) {
  const counts = { received: records.length, recorded: 0, alreadyHeld: 0, unreadable: 0 };
  for (const raw of records) {
    const rec = normalise(raw);
    if (!rec) {
      counts.unreadable += 1;
      continue;
    }
    const doc = {
      companyId,
      source: I.SOURCE,
      ...rec,
      receivedAt: pulledAt,
      provenance: { method: "pull_api", windowFrom: window.from, windowTo: window.to, pulledAt },
    };
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      try {
        await MarketingSourceEnquiry.create({ ...doc, submissionRef: newRef() });
        counts.recorded += 1;
        saved = true;
      } catch (err) {
        if (isDuplicate(err) && isOnKey(err)) {
          counts.alreadyHeld += 1;
          saved = true;
        } else if (isDuplicate(err)) {
          /* A reference collision: draw another once. */
          continue;
        } else if (isRecordInvalid(err)) {
          counts.unreadable += 1;
          saved = true;
        } else {
          const e = new client.IndiamartError("storage_failed");
          e.counts = counts;
          throw e;
        }
      }
    }
    if (!saved) {
      const e = new client.IndiamartError("storage_failed");
      e.counts = counts;
      throw e;
    }
  }
  return counts;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE STATE ROW — CURSOR, RATE FENCE AND LEASE
   ═══════════════════════════════════════════════════════════════════════════ */

const selectorFor = (companyId) => ({ companyId, source: I.SOURCE });

async function ensureState(companyId) {
  try {
    await MarketingLeadSourceState.updateOne(
      selectorFor(companyId),
      { $setOnInsert: selectorFor(companyId) },
      { upsert: true },
    );
  } catch (err) {
    /* Two first checks at once: one upsert wins, the other finds the row. */
    if (!isDuplicate(err)) throw err;
  }
}

function nextAllowedAt(state) {
  const times = [];
  if (state?.lastCallAt) times.push(new Date(state.lastCallAt).getTime() + L.MIN_CALL_INTERVAL_MS);
  if (state?.blockedUntil) times.push(new Date(state.blockedUntil).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

const running = (state, nowMs) => Boolean(state?.leaseUntil && new Date(state.leaseUntil).getTime() > nowMs);

async function acquire(companyId, nowMs) {
  const now = new Date(nowMs);
  const token = crypto.randomBytes(12).toString("hex");
  const state = await MarketingLeadSourceState.findOneAndUpdate(
    {
      ...selectorFor(companyId),
      $and: [
        { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $or: [{ lastCallAt: null }, { lastCallAt: { $lte: new Date(nowMs - L.MIN_CALL_INTERVAL_MS) } }] },
        { $or: [{ blockedUntil: null }, { blockedUntil: { $lte: now } }] },
      ],
    },
    { $set: { leaseUntil: new Date(nowMs + L.LEASE_MS), leaseToken: token, lastCallAt: now } },
    /* The row as it was: its cursor is what this check starts from. */
    { new: false, lean: true },
  );
  return state ? { state, token } : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHECK NOW
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One check. Refuses (throws) when the source is not configured, a check is
 * already running, or it is too soon; otherwise always answers with what
 * happened, including a failure.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {object}   [args.env]
 * @param {Function} [args.now]        () => ms; injectable for tests
 * @param {Function} [args.transport]  see indiamartClient
 */
async function check({ companyId, env = process.env, now = Date.now, transport, startedBy = "manual" } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Lead sources need a company.");
  const company = new mongoose.Types.ObjectId(String(companyId));
  const key = keyFor(company, env);
  if (!key) {
    throw fail("LEAD_SOURCE_NOT_CONFIGURED",
      "IndiaMART is not connected for this company. An administrator must add the seller's IndiaMART key to GRAV's server settings.");
  }

  await ensureState(company);
  const startedMs = now();
  const taken = await acquire(company, startedMs);
  if (!taken) {
    const current = await MarketingLeadSourceState.findOne(selectorFor(company)).lean();
    if (running(current, startedMs)) {
      throw fail("LEAD_SOURCE_CHECK_IN_PROGRESS", "GRAV is already checking IndiaMART. Its result will appear here when it finishes.");
    }
    const at = nextAllowedAt(current);
    throw fail("LEAD_SOURCE_CHECK_TOO_SOON",
      "IndiaMART allows one check every 5 minutes. Check now is available again at the time given.",
      { nextAllowedAt: at ? at.toISOString() : null });
  }

  const { state, token } = taken;
  const window = nextWindow(state, startedMs);
  const run = {
    startedAt: new Date(startedMs),
    startedBy: ["scheduler", "manual"].includes(startedBy) ? startedBy : "",
    windowFrom: window.from,
    windowTo: window.to,
  };

  let counts = { received: 0, recorded: 0, alreadyHeld: 0, unreadable: 0 };
  let errorCode = "";
  try {
    const answer = await client.fetchWindow({ key, from: window.from, to: window.to, transport });
    counts = await saveAll({ companyId: company, records: answer.records, window, pulledAt: new Date(now()) });
  } catch (err) {
    errorCode = err instanceof client.IndiamartError && I.ERROR_CODES.includes(err.code) ? err.code : "storage_failed";
    if (err?.counts) counts = err.counts;
  }

  const finishedAt = new Date(now());
  const mine = { ...selectorFor(company), leaseToken: token };
  const release = { leaseUntil: null, leaseToken: "" };

  if (errorCode) {
    const set = {
      ...release,
      lastRun: { ...run, finishedAt, outcome: "failed", counts, errorCode },
      lastFailureAt: finishedAt,
    };
    if (errorCode === "rate_limited") set.blockedUntil = new Date(finishedAt.getTime() + L.RATE_LIMITED_BACKOFF_MS);
    await MarketingLeadSourceState.updateOne(mine, { $set: set, $inc: { consecutiveFailures: 1 } });
  } else {
    const through = state.coveredThrough && new Date(state.coveredThrough) > window.to
      ? new Date(state.coveredThrough) : window.to;
    const set = {
      ...release,
      /* The start of UNBROKEN coverage ending at coveredThrough. A gap breaks
         it, so after one it restarts where the gap ends. */
      coveredFrom: window.gap ? window.from : (state.coveredFrom || window.from),
      coveredThrough: through,
      blockedUntil: null,
      lastRun: { ...run, finishedAt, outcome: "completed", counts, errorCode: "" },
      lastSuccessAt: finishedAt,
      consecutiveFailures: 0,
    };
    const update = { $set: set };
    if (window.gap) update.$push = { gaps: { $each: [window.gap], $slice: -L.MAX_GAPS_KEPT } };
    await MarketingLeadSourceState.updateOne(mine, update);
  }

  return {
    outcome: errorCode ? "failed" : "completed",
    window: { from: window.from, to: window.to },
    reachedNow: window.to.getTime() === floorSecond(startedMs),
    counts,
    error: errorCode ? errorView(errorCode, finishedAt) : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STATUS — READ ONLY, NEVER CALLS INDIAMART
   ═══════════════════════════════════════════════════════════════════════════ */

const view = (x) => ({ code: x.code, label: x.label, means: x.means });
const find = (list, code) => list.find((x) => x.code === code);

function errorView(code, at) {
  const e = I.ERROR_BY_CODE[code] || I.ERROR_BY_CODE.provider_error;
  return { code: e.code, label: e.label, means: e.means, action: e.action, retryable: e.retryable, at: at || null };
}

async function countsByKind(companyId) {
  const rows = await MarketingSourceEnquiry.aggregate([
    { $match: { companyId, source: I.SOURCE } },
    { $group: { _id: "$kind", n: { $sum: 1 } } },
  ]);
  const by = new Map(rows.map((r) => [r._id, r.n]));
  const byKind = I.KINDS.map((k) => ({ code: k.code, label: k.label, isEnquiry: k.isEnquiry, count: by.get(k.code) || 0 }));
  return { total: byKind.reduce((s, k) => s + k.count, 0), byKind };
}

/**
 * What a marketer may see about the IndiaMART connection. Never the key, the
 * URL, a contact detail, IndiaMART's ids or IndiaMART's messages.
 */
async function status({
  companyId, env = process.env, now = Date.now, canAdminister = false, scheduleEnabled = null,
} = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Lead sources need a company.");
  const company = new mongoose.Types.ObjectId(String(companyId));
  const nowMs = now();
  const configured = isConfigured(company, env);
  const state = await MarketingLeadSourceState.findOne(selectorFor(company)).lean();
  const last = state?.lastRun || null;

  let connection = "not_configured";
  if (configured) connection = !last ? "configured_unverified" : (last.outcome === "completed" ? "connected" : "failing");

  const at = nextAllowedAt(state);
  const isRunning = running(state, nowMs);
  let blockedBy = null;
  if (!canAdminister) blockedBy = "not_administrator";
  else if (!configured) blockedBy = "not_configured";
  else if (isRunning) blockedBy = "running";
  else if (at && at.getTime() > nowMs) blockedBy = "too_soon";

  const through = state?.coveredThrough ? new Date(state.coveredThrough) : null;
  const lastOk = state?.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : null;
  let freshness = "never_checked";
  if (through) {
    if (nowMs - through.getTime() <= I.SCHEDULE.CURRENT_WITHIN_MS) freshness = "current";
    else if (lastOk && nowMs - lastOk <= I.SCHEDULE.STALE_AFTER_MS) freshness = "catching_up";
    else freshness = "stalled";
  }
  const enabled = scheduleEnabled === null
    ? await require("../../jobRegistry").isEnabled(I.SCHEDULE.JOB_NAME)
    : Boolean(scheduleEnabled);

  return {
    source: { code: I.SOURCE, label: I.SOURCE_LABEL, method: "pull_api" },
    configured,
    connection: view(find(I.CONNECTION_STATES, connection)),
    lastCheck: last ? {
      startedAt: last.startedAt,
      finishedAt: last.finishedAt,
      startedBy: last.startedBy || null,
      outcome: view(find(I.RUN_OUTCOMES, last.outcome)),
      window: { from: last.windowFrom, to: last.windowTo },
      counts: {
        received: last.counts?.received || 0,
        recorded: last.counts?.recorded || 0,
        alreadyHeld: last.counts?.alreadyHeld || 0,
        unreadable: last.counts?.unreadable || 0,
      },
    } : null,
    lastSuccessAt: state?.lastSuccessAt || null,
    lastFailureAt: state?.lastFailureAt || null,
    consecutiveFailures: state?.consecutiveFailures || 0,
    lastError: last && last.outcome === "failed" ? errorView(last.errorCode, last.finishedAt) : null,
    coverage: {
      coveredFrom: state?.coveredFrom || null,
      coveredThrough: through,
      freshness: view(find(I.COVERAGE_FRESHNESS, freshness)),
      /* Minutes between the end of coverage and now; enquiries after that
         moment have not been fetched. */
      lagMinutes: through ? Math.max(0, Math.floor((nowMs - through.getTime()) / 60000)) : null,
      /* More than one check's worth behind: each check catches up 7 days. */
      catchingUp: Boolean(through && nowMs - through.getTime() > L.MAX_WINDOW_MS),
      gaps: (state?.gaps || []).map((g) => ({ from: g.from, to: g.to })),
      retentionDays: L.RETENTION_DAYS,
      maxWindowDays: L.MAX_WINDOW_DAYS,
      notes: I.COVERAGE_NOTES,
    },
    enquiries: await countsByKind(company),
    checkNow: {
      allowed: blockedBy === null,
      blockedBy: blockedBy ? view(find(I.CHECK_BLOCKS, blockedBy)) : null,
      running: isRunning,
      nextAllowedAt: at && at.getTime() > nowMs ? at : null,
    },
    automaticChecks: (() => {
      /* No key wins: with no key nothing runs, whatever the switch says. */
      const code = !configured ? "no_key" : (enabled ? "scheduled" : "switched_off");
      const stateView = view(find(I.AUTOMATIC_CHECK_STATES, code));
      /* Only a value the vocabulary labels is ever published. */
      const outcome = I.SCHEDULED_CYCLE_OUTCOME_CODES.includes(state?.lastScheduledCycleOutcome)
        ? state.lastScheduledCycleOutcome : null;
      return {
        state: stateView,
        /* Scheduled only when a key is configured and the job switch is on. */
        enabled: code === "scheduled",
        switchedOff: !enabled,
        everyMinutes: I.SCHEDULE.EVERY_MS / 60000,
        /* The last scheduled cycle — history, kept even when checks are now
           switched off or the key has gone. */
        lastCycleAt: state?.lastScheduledCycleAt || null,
        lastCycleOutcome: outcome,
        lastCycleOutcomeLabel: outcome ? view(find(I.SCHEDULED_CYCLE_OUTCOMES, outcome)) : null,
        means: stateView.means,
      };
    })(),
  };
}

const vocabulary = Object.freeze({
  connectionStates: I.CONNECTION_STATES.map(view),
  coverageFreshness: I.COVERAGE_FRESHNESS.map(view),
  automaticCheckStates: I.AUTOMATIC_CHECK_STATES.map(view),
  scheduledCycleOutcomes: I.SCHEDULED_CYCLE_OUTCOMES.map(view),
  kinds: I.KINDS.map((k) => ({ ...view(k), isEnquiry: k.isEnquiry })),
  errors: I.ERRORS.map((e) => ({ ...view(e), action: e.action, retryable: e.retryable })),
  runOutcomes: I.RUN_OUTCOMES.map(view),
  checkBlocks: I.CHECK_BLOCKS.map(view),
});

module.exports = {
  check,
  status,
  vocabulary,
  isConfigured,
  keyFor,
  __internals: { keyFor, nextWindow, normalise, saveAll, nextAllowedAt },
};
