// services/marketing/marketingConsent.service.js
//
// THE ONLY PLACE THAT ANSWERS "MAY WE MARKET TO THIS PERSON".
//
// ── THE SHAPE OF THE PROBLEM THIS FIXES ────────────────────────────────────
// Before this file, eligibility was decided by reading the caller's own
// `consent` argument. That is not a permission check; it is a spelling check on
// a request. Anything that could call `syncContact` could enrol anybody by
// asserting `{ emailConsent: "opted_in" }`, and nothing in the database would
// ever record who had claimed it or on what basis.
//
// So the question moves server-side. `resolveEffective` reads the canonical
// record and nothing else — no argument it is handed can change its answer —
// and `assertMarketingEmailEligible` is the gate every outbound path goes
// through.
//
// ── CONSERVATIVE BY CONSTRUCTION, NOT BY CARE ──────────────────────────────
// Every way of not knowing resolves to ineligible, and most of them resolve
// that way because of how the query is built rather than because a branch
// remembers to:
//
//   another company's consent   the selector is company-scoped, so it is not
//                               found at all → CONSENT_MISSING
//   another person's consent    keyed on gravPersonKey → not found
//   transactional consent       keyed on purpose, so a marketing lookup never
//                               sees it → not found
//   no record                   → CONSENT_MISSING
//   a row that says `unknown`   → CONSENT_UNKNOWN
//
// There is no code path that returns `eligible: true` without having read a row
// whose state is literally `opted_in` for the asked-for channel and purpose.
//
// ── AND SUPPRESSION CROSSES PURPOSES ───────────────────────────────────────
// "Conflicts resolve toward suppression until reviewed" (product plan §7).
// Suppression is a fact about the ADDRESS, not about a purpose: a hard bounce
// or a spam complaint means the channel is unusable, and a marketing lookup
// that ignored a suppression recorded under another purpose would keep sending
// to it. So a suppressed row on the same channel suppresses every purpose on
// that channel — the one place a lookup deliberately reads beyond its own
// purpose, and it only ever reads in the refusing direction.
"use strict";

const {
  MarketingConsent, MarketingConsentHistory,
} = require("../../models/CMS_Models/Marketing/MarketingConsent");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { fail } = require("../storePurchase/errors");
const {
  CONSENT_STATE_CODES, CONSENT_CHANNEL_CODES, CONSENT_PURPOSE_CODES, MARKETING_EMAIL,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/** The states that are a withdrawal of permission rather than a grant. */
const WITHDRAWING_STATES = new Set(["opted_out", "suppressed"]);

/* ── INPUT VALIDATION ───────────────────────────────────────────────────────
   Refused, never coerced. A mistyped channel that silently became "email"
   would record an answer the person never gave for a channel they were never
   asked about. */
function assertTuple({ companyId, gravPersonKey, channel, purpose }) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Marketing consent cannot be read or written without a company.");
  }
  if (!str(gravPersonKey)) {
    throw fail("MARKETING_CONSENT_INVALID", "Marketing consent needs the canonical GRAV person key.", {
      field: "gravPersonKey", reasonCode: "CONSENT_IDENTITY_MISSING",
    });
  }
  if (!CONSENT_CHANNEL_CODES.includes(channel)) {
    throw fail("MARKETING_CONSENT_INVALID", `"${channel}" is not a communication channel this application models.`, {
      field: "channel", accepted: CONSENT_CHANNEL_CODES,
    });
  }
  if (!CONSENT_PURPOSE_CODES.includes(purpose)) {
    throw fail("MARKETING_CONSENT_INVALID", `"${purpose}" is not a communication purpose this application models.`, {
      field: "purpose", accepted: CONSENT_PURPOSE_CODES,
    });
  }
  return {
    companyId, gravPersonKey: str(gravPersonKey), channel, purpose,
  };
}

/* ═══ THE RESOLVER ═════════════════════════════════════════════════════════ */

/**
 * The effective consent for one company, person, channel and purpose.
 *
 * Reads the canonical record. Takes no state from its caller and cannot be
 * persuaded by one.
 *
 * @returns {Promise<{state:string, eligible:boolean, reasonCode:string,
 *                    reason:string, record:object|null, suppressedBy:object|null}>}
 */
async function resolveEffective({ companyId, gravPersonKey, channel, purpose } = {}) {
  const key = assertTuple({ companyId, gravPersonKey, channel, purpose });

  /* ── SUPPRESSION FIRST ───────────────────────────────────────────────────
     Asked before the purpose-specific row, because a suppressed channel cannot
     be rescued by a grant on it and checking in the other order would let an
     `opted_in` marketing row answer before the suppression was seen. */
  const suppressed = await MarketingConsent.findOne({
    companyId: key.companyId,
    gravPersonKey: key.gravPersonKey,
    channel: key.channel,
    state: "suppressed",
  }).lean();

  if (suppressed) {
    return {
      state: "suppressed",
      eligible: false,
      reasonCode: "CONSENT_SUPPRESSED",
      reason: suppressed.purpose === key.purpose
        ? `The ${key.channel} channel is suppressed for this person.`
        : `The ${key.channel} channel is suppressed for this person (recorded under the "${suppressed.purpose}" purpose), so no purpose may use it.`,
      record: suppressed,
      suppressedBy: { purpose: suppressed.purpose, withdrawnAt: suppressed.withdrawnAt, reason: suppressed.withdrawalReason },
    };
  }

  /* ── THE ASKED-FOR TUPLE ─────────────────────────────────────────────────
     `find`, not `findOne`: a unique index should make more than one impossible,
     and the resolver reports the impossible case rather than trusting it. */
  const rows = await MarketingConsent.find({
    companyId: key.companyId,
    gravPersonKey: key.gravPersonKey,
    channel: key.channel,
    purpose: key.purpose,
  }).lean();

  if (rows.length > 1) {
    return {
      state: "unknown",
      eligible: false,
      reasonCode: "CONSENT_AMBIGUOUS",
      reason: `${rows.length} conflicting consent records exist for this person, channel and purpose. A person must review them.`,
      record: null,
      suppressedBy: null,
    };
  }

  const row = rows[0] || null;

  if (!row) {
    return {
      state: "unknown",
      eligible: false,
      reasonCode: "CONSENT_MISSING",
      reason: `No ${key.purpose} consent has been recorded for this person on ${key.channel}.`,
      record: null,
      suppressedBy: null,
    };
  }

  if (row.state === "opted_in") {
    return { state: "opted_in", eligible: true, reasonCode: "", reason: "", record: row, suppressedBy: null };
  }

  const reasonCode = row.state === "opted_out" ? "CONSENT_WITHDRAWN" : "CONSENT_UNKNOWN";
  return {
    state: row.state,
    eligible: false,
    reasonCode,
    reason: row.state === "opted_out"
      ? `This person opted out of ${key.purpose} on ${key.channel}${row.withdrawnAt ? ` on ${row.withdrawnAt.toISOString().slice(0, 10)}` : ""}.`
      : `${key.purpose} consent on ${key.channel} was recorded as unknown — nobody has an answer from this person.`,
    record: row,
    suppressedBy: null,
  };
}

/**
 * The gate. Marketing email, for marketing purposes, and nothing else.
 *
 * `MARKETING_EMAIL` is a constant rather than two string literals spelled here,
 * so "what counts as marketing permission" has one definition that a future
 * channel cannot quietly widen.
 *
 * @throws 403 with a stable `details.reasonCode` the Data Health screen groups by
 */
async function assertMarketingEmailEligible({ companyId, gravPersonKey } = {}) {
  const verdict = await resolveEffective({
    companyId, gravPersonKey, ...MARKETING_EMAIL,
  });
  if (!verdict.eligible) {
    throw fail("MARKETING_CONSENT_INELIGIBLE", verdict.reason, {
      reasonCode: verdict.reasonCode,
      state: verdict.state,
      channel: MARKETING_EMAIL.channel,
      purpose: MARKETING_EMAIL.purpose,
      gravPersonKey: str(gravPersonKey),
      ...(verdict.suppressedBy ? { suppressedBy: verdict.suppressedBy } : {}),
    });
  }
  return verdict;
}

/* ═══ THE COMMANDS ═════════════════════════════════════════════════════════ */

/**
 * Record a consent state, appending to history.
 *
 * Idempotent on `commandKey`: a repeated command finds its own history entry
 * and changes nothing. The unique partial index on (tuple, commandKey) is what
 * enforces that — a read-then-write check can be passed by two requests at
 * once, and this one is called from a webhook, which is exactly where that
 * happens.
 *
 * @param {string} args.state  unknown | opted_in | opted_out | suppressed
 * @returns {Promise<{record:object, applied:boolean, duplicate:boolean, history:object|null}>}
 */
async function record({
  companyId, gravPersonKey, channel, purpose, state,
  capturedSource = "", capturedAt = null, noticeVersion = "", evidenceRef = "",
  actor = null, reason = "", commandKey = "", now = new Date(),
} = {}) {
  const key = assertTuple({ companyId, gravPersonKey, channel, purpose });

  if (!CONSENT_STATE_CODES.includes(state)) {
    throw fail("MARKETING_CONSENT_INVALID", `"${state}" is not a consent state.`, {
      field: "state", accepted: CONSENT_STATE_CODES,
    });
  }

  /* An opt-in with nothing behind it is the thing this whole slice exists to
     refuse. "They agreed" has to be answerable with "where does it say so". */
  if (state === "opted_in" && !str(capturedSource)) {
    throw fail("MARKETING_CONSENT_INVALID",
      "Recording an opt-in needs its capture source — where the person gave permission.",
      { field: "capturedSource" });
  }
  if (WITHDRAWING_STATES.has(state) && !str(reason)) {
    throw fail("MARKETING_CONSENT_INVALID",
      `Recording "${state}" needs a reason. It is what a later review reads.`,
      { field: "reason" });
  }

  const recordedBy = normaliseActor(actor);
  const cmd = str(commandKey);

  /* ── ALREADY APPLIED? AND IF SO, IS IT ACTUALLY REFLECTED? ──────────────
     A history entry alone used to end this function. It is not proof: history
     is written BEFORE the current row, so a crash between the two leaves the
     entry with no projection — and a replay then reported `duplicate: true`
     while the canonical row was still `opted_in`. The caller marked suppression
     applied, and the person kept receiving mail they had asked to stop.

     So a replay now RECONCILES: it rebuilds the current state from durable
     history and reports whether that command is genuinely reflected. */
  if (cmd) {
    const seen = await MarketingConsentHistory.findOne({ ...tupleOf(key), commandKey: cmd }).lean();
    if (seen) {
      const repaired = await reconcileFromHistory(key);
      const current = repaired.record;
      const currentRevision = Number(current?.revision) || 0;

      /* ── REFLECTED, SUPERSEDED, OR NEITHER ──────────────────────────────
         Three genuinely different answers, and collapsing them into one boolean
         is what made a settled command look like a permanent failure.

         REFLECTED   the canonical row IS this command's revision. It happened,
                     and it is what is true now.
         SUPERSEDED  the command is durably in history, and a LATER valid
                     revision has replaced it — the person opted back in, say.
                     Nothing is broken and nothing is owed; the command's own
                     effect is simply no longer the present state. A caller must
                     stop retrying it, and must not claim the person is
                     currently suppressed.
         neither     history holds it and the projection is behind, which is the
                     crash case reconciliation exists to repair. */
      const reflected = Boolean(current) && currentRevision === seen.revision;
      const superseded = Boolean(current) && currentRevision > seen.revision;

      return {
        record: current,
        applied: false,
        duplicate: true,
        history: seen,
        repaired: repaired.repaired,
        reflected,
        superseded,
        /* Whether the command is finished with, either way. A caller may stop
           retrying on this; it may only claim the person is suppressed on
           `reflected` plus the state it can read for itself. */
        settled: reflected || superseded,
        /* The state that actually stands now, so a caller never has to infer it
           from the command it happened to replay. */
        currentState: current?.state || "unknown",
        supersededBy: superseded
          ? { revision: currentRevision, state: current.state, recordedAt: current.recordedAt }
          : null,
      };
    }
  }

  const existing = await MarketingConsent.findOne(tupleOf(key));
  const fromState = existing ? existing.state : null;

  /* A command that changes nothing still records that it arrived, when it
     carries a key — "we were told again" is a fact, and swallowing it would
     make a replay indistinguishable from a gap. Without a key there is nothing
     to distinguish a genuine repeat from a duplicate, so a no-op is a no-op. */
  if (existing && fromState === state && !cmd) {
    return { record: existing.toObject(), applied: false, duplicate: false, history: null };
  }

  const revision = existing ? existing.revision + 1 : 1;
  const evidence = {
    capturedSource: str(capturedSource),
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    noticeVersion: str(noticeVersion),
    evidenceRef: str(evidenceRef),
  };

  /* ── HISTORY FIRST ───────────────────────────────────────────────────────
     Deliberate ordering. If the process dies between the two writes, the
     survivor is a history entry with no current row — which a reconciliation
     can see and replay. The other order leaves a current state nothing explains,
     which is the failure this model exists to prevent. The unique index on
     (tuple, commandKey) makes the replay safe. */
  let history;
  try {
    history = await appendHistory({
      ...tupleOf(key),
      fromState,
      toState: state,
      revision,
      ...evidence,
      recordedBy,
      at: now,
      reason: str(reason),
      commandKey: cmd,
    }, key);
  } catch (err) {
    if (err?.code === 11000 && cmd) {
      /* Two deliveries of the same command raced; the loser reports the
         duplicate it lost to rather than a failure that would be retried. */
      const seen = await MarketingConsentHistory.findOne({ ...tupleOf(key), commandKey: cmd }).lean();
      const current = await MarketingConsent.findOne(tupleOf(key)).lean();
      return { record: current, applied: false, duplicate: true, history: seen };
    }
    throw err;
  }

  /* ── THE REVISION THAT WAS ACTUALLY APPENDED ────────────────────────────
     `revision` above was this command's guess, computed before the append. When
     two commands race, `appendHistory` retries onto the next free revision — so
     the guess can be stale by the time the entry exists. Using it here would
     write a current row claiming revision 2 while history holds the same
     command at revision 3: the two records disagree from the moment they are
     written, and every later reconciliation has to repair a row nothing broke. */
  const appliedRevision = Number(history.revision) || revision;

  const update = {
    state,
    ...evidence,
    recordedBy,
    recordedAt: now,
    revision: appliedRevision,
    lastCommandKey: cmd,
  };
  if (WITHDRAWING_STATES.has(state)) {
    update.withdrawnAt = now;
    update.withdrawalReason = str(reason);
  }
  /* Withdrawal fields are NOT cleared on a later opt-in — see the model. */

  /* ── THE CURRENT ROW IS ADVANCED, NEVER JUST OVERWRITTEN ────────────────
     This was an unconditional upsert, and under concurrency that means the last
     writer by wall-clock wins rather than the highest revision. Two commands
     appending revisions 3 and 4 could land 4 then 3, leaving the canonical row
     claiming revision 3 while history held a legitimate 4 — a state nothing
     could explain and a suppression that a later opt-in silently undid.

     The filter carries the revision this write is advancing FROM. A write that
     matches nothing has been overtaken, and the reconciliation below rebuilds
     the row from durable history instead of forcing a stale value into it. */
  let saved = await MarketingConsent.findOneAndUpdate(
    { ...tupleOf(key), $or: [{ revision: { $lt: appliedRevision } }, { revision: { $exists: false } }] },
    { $set: update, $setOnInsert: tupleOf(key) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(async (err) => {
    /* Somebody inserted between the filter and the upsert. */
    if (err?.code === 11000) return null;
    throw err;
  });

  if (!saved) {
    const reconciled = await reconcileFromHistory(key);
    saved = reconciled.record;
  }

  return {
    record: saved?.toObject?.() || saved,
    applied: true,
    duplicate: false,
    history: history.toObject(),
    /* Whether THIS command is the one the canonical row now reflects. A caller
       may only report the command as done on this — a history row alone has
       never been proof. */
    reflected: Boolean(saved) && (saved.revision ?? 0) >= appliedRevision,
  };
}

/* ── REBUILDING THE CURRENT STATE FROM DURABLE HISTORY ──────────────────────
   History is the record of record: it is append-only, it is written first, and
   the current row is a projection of it. So a projection that is missing or
   behind can be rebuilt, and this is the only place that does it.

   Ordered by REVISION, not by time. Two entries can share a timestamp to the
   millisecond, and an import backdates `capturedAt` deliberately; revision is
   the sequence the entries were actually appended in, which is the only
   ordering that answers "which one is later". */
async function reconcileFromHistory(key) {
  const entries = await MarketingConsentHistory.find(tupleOf(key)).sort({ revision: 1, _id: 1 }).lean();
  if (!entries.length) return { record: null, repaired: false };

  const latest = entries[entries.length - 1];
  const current = await MarketingConsent.findOne(tupleOf(key)).lean();

  /* Already at or ahead of history: nothing to repair. Ahead should not happen,
     and if it does, history is not the thing to trust downwards — a projection
     is never rolled BACK from here. */
  if (current && current.revision >= latest.revision) {
    return { record: current, repaired: false };
  }

  const update = {
    state: latest.toState,
    capturedSource: latest.capturedSource,
    capturedAt: latest.capturedAt,
    noticeVersion: latest.noticeVersion,
    evidenceRef: latest.evidenceRef,
    recordedBy: latest.recordedBy,
    recordedAt: latest.at,
    revision: latest.revision,
    lastCommandKey: latest.commandKey,
  };
  if (WITHDRAWING_STATES.has(latest.toState)) {
    update.withdrawnAt = latest.at;
    update.withdrawalReason = latest.reason;
  }

  /* ── AN OLDER REPLAY CANNOT OVERWRITE A NEWER DECISION ─────────────────
     The filter carries the revision this repair believes it is advancing FROM.
     If another writer got there first the update matches nothing, and the row
     that is already newer stands. */
  const repaired = await MarketingConsent.findOneAndUpdate(
    { ...tupleOf(key), $or: [{ revision: { $lt: latest.revision } }, { revision: { $exists: false } }] },
    { $set: update, $setOnInsert: tupleOf(key) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(async (err) => {
    /* Somebody inserted between the read and the upsert. Theirs is the row. */
    if (err?.code === 11000) return MarketingConsent.findOne(tupleOf(key));
    throw err;
  });

  return { record: repaired ? repaired.toObject?.() || repaired : current, repaired: true };
}

/* ── APPENDING, WITH BOUNDED RETRY ON REVISION CONTENTION ────────────────────
   Two concurrent DIFFERENT commands both compute `revision + 1` from the same
   read. The unique index on (tuple, revision) refuses the loser, and rather
   than failing the caller this re-reads the revision it can now see and tries
   again. Bounded, because an unbounded retry under real contention is a hang
   rather than a fix. */
async function appendHistory(entry, key, attempts = 5) {
  let candidate = entry;
  for (let i = 0; i < attempts; i++) {
    try {
      return await MarketingConsentHistory.create(candidate);
    } catch (err) {
      const revisionClash = err?.code === 11000
        && JSON.stringify(err?.keyPattern || {}).includes("revision");
      if (!revisionClash) throw err;

      const current = await MarketingConsent.findOne(tupleOf(key)).lean();
      const highest = await MarketingConsentHistory.findOne(tupleOf(key))
        .sort({ revision: -1 }).select("revision").lean();
      const next = Math.max(Number(current?.revision) || 0, Number(highest?.revision) || 0) + 1;
      candidate = { ...candidate, revision: next, fromState: current?.state ?? candidate.fromState };
    }
  }
  throw fail("CONFLICT", "Consent history is under contention; the command was not appended.", {});
}

/** Withdraw permission. A named command because "they asked us to stop" is a
 *  specific act with a required reason, not a generic state write. */
async function withdraw(args = {}) {
  return record({ ...args, state: "opted_out" });
}

/** Suppress a channel — a hard bounce, a complaint, an undeliverable address.
 *  Channel-wide by effect (see resolveEffective), so the reason matters. */
async function suppress(args = {}) {
  return record({ ...args, state: "suppressed" });
}

/** One person's consent history for a tuple, oldest first. Read-only. */
async function historyFor({ companyId, gravPersonKey, channel, purpose } = {}) {
  const key = assertTuple({ companyId, gravPersonKey, channel, purpose });
  return MarketingConsentHistory.find(tupleOf(key)).sort({ at: 1, _id: 1 }).lean();
}

/**
 * The identity key for a person Marketing already knows, or null.
 *
 * Exists so a caller holding only an email address cannot bypass the identity
 * rule: it resolves through `MarketingIdentity`, which is the mapping that
 * survives a changed address, and returns null rather than minting anything.
 * Consent for a person GRAV has no identity for is not a thing that can exist.
 */
async function personKeyForEmail({ companyId, email } = {}) {
  if (!companyId || !str(email)) return null;
  const row = await MarketingIdentity
    .findOne({ companyId, email: str(email).toLowerCase() })
    .select("gravPersonKey").lean();
  return row?.gravPersonKey || null;
}

const tupleOf = (k) => ({
  companyId: k.companyId,
  gravPersonKey: k.gravPersonKey,
  channel: k.channel,
  purpose: k.purpose,
});

function normaliseActor(actor) {
  if (!actor) return { id: null, name: "", email: "", kind: "system" };
  return {
    id: actor.id || null,
    name: str(actor.name),
    email: str(actor.email).toLowerCase(),
    /* A named person is a user act; anything else is the system's. Derived
       rather than trusted, so a caller cannot label an automatic suppression as
       somebody's decision. */
    kind: actor.id || str(actor.name) ? "user" : "system",
  };
}

module.exports = {
  reconcileFromHistory,
  resolveEffective,
  assertMarketingEmailEligible,
  record,
  withdraw,
  suppress,
  historyFor,
  personKeyForEmail,
  MARKETING_EMAIL,
};
