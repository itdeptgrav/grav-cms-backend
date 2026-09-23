// services/marketing/acquisitionHold.service.js
//
// STOPPING ACQUISITION FOR ONE PERSON, AND ONLY SAYING SO ONCE IT IS TRUE.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// `salesOutcomeIntake.service.js` used to write `acquisitionPausedAt` in the
// same save as the Sales decision. Nothing had happened in Mautic. The person
// was still in a running campaign, and the Prospect said they were not.
//
// So the decision now RAISES A COMMAND, the command is carried out against
// Mautic, Mautic is READ BACK, and only the read-back writes the timestamp.
// Between those moments the truthful answer is "requested" or "failed", and
// every read boundary says so in those words.
//
// ── THE MECHANISM, AND WHY IT IS THIS ONE ──────────────────────────────────
// Three supported Mautic 7.2 API calls, applied to one contact:
//
//   1. PATCH /api/contacts/{id}/edit  with grav_acquisition_hold = true
//        A GRAV-owned boolean custom field. This is the DEDICATED SALES-OWNED
//        EXCLUSION the requirement asks to prefer. Removing memberships stops
//        the automation the person is in today; this flag is what a segment
//        filter excludes on so they are not enrolled again next week by a
//        segment that does not exist yet.
//   2. POST /api/segments/{id}/contact/{leadId}/remove   for each membership
//   3. POST /api/campaigns/{id}/contact/{leadId}/remove   for each membership
//
// Both removals set Mautic's own `manually_removed` flag, which its segment
// rebuild explicitly honours, and the campaign path additionally unschedules
// the contact's pending events. Proved live: a full `mautic:segments:update`
// plus `mautic:campaigns:update` does not put the person back, and a second
// contact in the same segment and campaign is untouched.
//
// What is NOT used: do-not-contact (that is an unsubscribe, and Sales ownership
// is not a withdrawal of permission), and unpublishing a campaign (that stops
// it for everyone). Canonical consent is never read-modified-written here — it
// is only READ, and only to notice that somebody else has already stopped
// everything for a stronger reason.
//
// ── THE VERIFICATION IS THE POINT ──────────────────────────────────────────
// Mautic answers `{"success":1}` to a removal for a contact that was never in
// the segment. A write's own 200 therefore proves nothing, and `confirmedAt` is
// written from a re-read of the contact's memberships, not from the responses.
//
// ── DURABILITY AND RECOVERY ────────────────────────────────────────────────
// The Sales decision is already recorded and is never undone by a Mautic
// failure. A failed command stays queryable with its reason, and the same
// bounded deterministic backoff, the same lease fence and the same
// classification table as Chunk 1's delivery state drive the retry. Nothing
// here asks Sales to decide again.
"use strict";

const crypto = require("crypto");

const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const consentService = require("./marketingConsent.service");
const { MauticClient } = require("./mauticClient");
const { fail } = require("../storePurchase/errors");
const providerPrivacy = require("./providerPrivacy");
const {
  DELIVERY_RETRY, ACQUISITION_HOLD_FIELD,
} = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/* Unfinished means "Mautic still owes this company a change". APPLIED and
   SUPERSEDED are both settled; only these two are swept. */
const UNFINISHED_STATES = Object.freeze(["REQUESTED", "FAILED"]);

/* Which Sales decisions hold acquisition. RETURNED is absent deliberately: a
   return asks Marketing to carry on nurturing, and this slice does not resume
   anything automatically either (requirement 11). */
const HOLD_REASON_FOR_DECISION = Object.freeze({
  ACCEPTED: "SALES_ACCEPTED",
  DUPLICATE_LINKED: "SALES_DUPLICATE_LINKED",
});

/* ── CLASSIFICATION ─────────────────────────────────────────────────────────
   The same table marketingDelivery.service.js uses, for the same reason: an
   unlisted code is TERMINAL, because an error nobody has classified is an error
   nobody understands, and retrying it for six hours hides it in a backlog. */
const CLASSIFICATION = Object.freeze({
  MAUTIC_UNAVAILABLE: { failureClass: "TRANSIENT", reasonCode: "MAUTIC_UNREACHABLE" },
  MAUTIC_AUTH_FAILED: { failureClass: "TERMINAL", reasonCode: "MAUTIC_AUTH_REFUSED" },
  MAUTIC_NOT_CONFIGURED: { failureClass: "TERMINAL", reasonCode: "MAUTIC_NOT_CONFIGURED" },
  MAUTIC_REJECTED_WRITE: { failureClass: "TERMINAL", reasonCode: "MAUTIC_WRITE_REJECTED" },
  MAUTIC_BAD_REQUEST: { failureClass: "TERMINAL", reasonCode: "MAUTIC_WRITE_REJECTED" },
  VALIDATION: { failureClass: "TERMINAL", reasonCode: "PROJECTION_INVALID" },
  NOT_FOUND: { failureClass: "TERMINAL", reasonCode: "PROJECTION_INVALID" },
  TENANT_MEMBERSHIP_UNPROVEN: { failureClass: "TERMINAL", reasonCode: "PROJECTION_INVALID" },
  /* TERMINAL, not transient: waiting does not register a segment. */
  ACQUISITION_SCOPE_MISSING: { failureClass: "TERMINAL", reasonCode: "ACQUISITION_SCOPE_MISSING" },
  ACQUISITION_SCOPE_UNVERIFIABLE: { failureClass: "TERMINAL", reasonCode: "ACQUISITION_SCOPE_UNVERIFIABLE" },
});
const TERMINAL_FALLBACK = Object.freeze({ failureClass: "TERMINAL", reasonCode: "PROJECTION_INVALID" });

const classify = (err) => CLASSIFICATION[str(err?.code)] || TERMINAL_FALLBACK;
/* The error's own sentence, written for an operator by whichever refusal raised
   it, then bounded. Never a stack, never a provider body. */
const safeMessage = (err) => str(err?.message).slice(0, 500);

function backoffMsFor(retryCount) {
  const n = Math.max(1, Number(retryCount) || 1);
  return Math.min(DELIVERY_RETRY.BASE_MS * 2 ** (n - 1), DELIVERY_RETRY.MAX_DELAY_MS);
}

/* ── EVERY KEY CARRIES THE COMPANY ──────────────────────────────────────────
   Requirement 8. Not a convention: the only way to address a command in this
   file is through this function, so a lookup without a company cannot be
   written by accident. */
function assertKey({ companyId, handoverRef }) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "An acquisition hold cannot be read or written without a company.");
  }
  if (!str(handoverRef)) {
    throw fail("VALIDATION", "An acquisition hold is addressed by its handover reference.", { field: "handoverRef" });
  }
  return { companyId, handoverRef: str(handoverRef) };
}

/* The lease fence, identical in behaviour to delivery state's: with a token,
   settle only while this lease still holds the row; without one, settle only
   while no LIVE lease exists, so a direct call cannot stamp on a sweep's
   in-flight attempt. An expired lease nobody reclaimed is not a conflict. */
function fencedFilter(key, leaseToken, now) {
  if (str(leaseToken)) return { ...key, "claim.token": str(leaseToken) };
  return {
    ...key,
    $or: [
      { "claim.token": { $in: ["", null] } },
      { "claim.token": { $exists: false } },
      { "claim.expiresAt": { $lte: now } },
    ],
  };
}

/* ═══ THE ACQUISITION CLASSIFICATION CONTRACT ══════════════════════════════

   ── WHAT THIS REPLACES, AND WHY IT WAS WRONG ──────────────────────────────
   The first version treated an EMPTY allowlist as "every segment and every
   campaign in the instance", on the reasoning that one Mautic instance serves
   one organisation. That reasoning does not survive the product: §7 of the plan
   keeps transactional communication as a separate purpose, §5 allows an
   approved Sales-assisted nurture path, and a post-sale or service journey is
   an ordinary thing to run in the same instance. Accepting a Prospect would
   have torn the person out of all of it — the acknowledgement of their own form
   submission, the service reminders, the nurture Sales itself asked for.

   So acquisition is now something GRAV must DECLARE, never infer:

     MAUTIC_ACQUISITION_SEGMENTS   comma-separated segment ids or aliases
     MAUTIC_ACQUISITION_CAMPAIGNS  comma-separated campaign ids or aliases

   Every entry must RESOLVE against the live instance. Anything not on those
   lists is not acquisition and is never touched. If the lists are absent, or an
   entry cannot be resolved, or the instance cannot be read to check, the hold
   FAILS VISIBLY: nothing is removed, and `acquisitionPausedAt` stays empty.
   Refusing is the safe direction — the failure mode of guessing is deleting
   somebody's service mail, and the failure mode of refusing is an operator
   seeing a clear message naming the missing variable. */

const SCOPE_ENV = Object.freeze({
  segments: "MAUTIC_ACQUISITION_SEGMENTS",
  campaigns: "MAUTIC_ACQUISITION_CAMPAIGNS",
});

const parseList = (v) => str(v).split(",").map((x) => str(x)).filter(Boolean);

/** What the deployment DECLARES. Unresolved names, exactly as configured. */
function declaredScope(env = process.env) {
  return {
    segments: parseList(env[SCOPE_ENV.segments]),
    campaigns: parseList(env[SCOPE_ENV.campaigns]),
  };
}

const matches = (row, wanted) => {
  const id = str(row?.id);
  const alias = str(row?.alias).toLowerCase();
  return str(wanted) === id || str(wanted).toLowerCase() === alias;
};

/**
 * Turn the declared names into real Mautic objects, or refuse.
 *
 * The collection reads are also the capability check for BOTH resources:
 * `GET /api/segments` and `GET /api/campaigns` each answer 403 for an identity
 * without permission, where the per-contact reads can answer an empty 200. So
 * resolving the scope proves, as a side effect, that the membership reads about
 * to be trusted are not blind.
 *
 * @returns {Promise<{segments:Array,campaigns:Array,declared:object,resolvedAt:Date}>}
 */
async function resolveScope({ client, env = process.env } = {}) {
  const declared = declaredScope(env);

  if (!declared.segments.length && !declared.campaigns.length) {
    throw fail("ACQUISITION_SCOPE_MISSING",
      `No GRAV acquisition scope is registered, so GRAV cannot tell acquisition automation from transactional, service or Sales-assisted nurture automation. Set ${SCOPE_ENV.segments} and/or ${SCOPE_ENV.campaigns} to the registered acquisition segments and campaigns, then retry.`,
      { expected: [SCOPE_ENV.segments, SCOPE_ENV.campaigns] });
  }

  let allSegments = [];
  let allCampaigns = [];
  try {
    /* Read both, always, even when only one list is declared: the guarantee
       being made is about BOTH membership reads, and a campaign read that is
       silently blind would let a still-enrolled person be reported as stopped. */
    allSegments = await client.listSegments();
    allCampaigns = await client.listCampaigns();
  } catch (err) {
    throw fail("ACQUISITION_SCOPE_UNVERIFIABLE",
      "GRAV cannot read the marketing engine's segments and campaigns, so it cannot verify which automation is acquisition or prove a person has left it. Grant the GRAV integration role segment and campaign view and edit permission, then retry.",
      { cause: str(err?.code) });
  }

  const resolve = (wantedList, available, what) => wantedList.map((wanted) => {
    const found = available.find((row) => matches(row, wanted));
    if (!found) {
      throw fail("ACQUISITION_SCOPE_UNVERIFIABLE",
        `The registered acquisition ${what} "${wanted}" does not exist in the marketing engine, so GRAV cannot tell what to stop. Correct the registration or restore the ${what}, then retry.`,
        { declared: wanted, what });
    }
    return { id: str(found.id), alias: str(found.alias), name: str(found.name) };
  });

  return {
    segments: resolve(declared.segments, allSegments, "segment"),
    campaigns: resolve(declared.campaigns, allCampaigns, "campaign"),
    declared,
    resolvedAt: new Date(),
  };
}

/** Is this membership one of the registered acquisition ones? */
const inScope = (row, resolved) => resolved.some((r) => str(r.id) === str(row?.id));

/* ═══ THE STANDING EXCLUSION — WHY REMOVAL ALONE IS NOT A HOLD ═════════════

   Removing today's memberships stops today's automation. It does nothing about
   an acquisition segment somebody builds next week: its filter runs, the held
   person matches it, and they are enrolled again.

   `grav_acquisition_hold` was introduced for that, and on its own it prevented
   nothing — no segment filtered on it. So a hold is not applied until every
   REGISTERED acquisition segment carries the exclusion, and the exclusion is
   read back from Mautic rather than assumed from a successful write.

   The filter is `grav_acquisition_hold != 1`. Proved against the live 7.2.0
   instance: it excludes a contact whose field is 1, and admits both a contact
   whose field is 0 and one whose field has never been set — which matters,
   because almost every contact has never been set. */
const HOLD_EXCLUSION_FILTER = Object.freeze({
  glue: "and",
  field: ACQUISITION_HOLD_FIELD,
  object: "lead",
  type: "boolean",
  operator: "!=",
  properties: { filter: 1 },
});

const hasHoldExclusion = (segment) => (segment?.filters || []).some((f) => str(f?.field) === ACQUISITION_HOLD_FIELD
  && str(f?.operator) === "!="
  && String(f?.properties?.filter) === "1");

/**
 * Ensure every registered acquisition segment excludes held contacts, and
 * verify it by reading the segment back.
 *
 * Idempotent: a segment that already carries the filter is not written. This is
 * a segment-wide change, and it is the one segment-wide change this service
 * makes — a standing rule that no held person enters acquisition, not a pause of
 * anybody's campaign.
 *
 * @returns {Promise<{guarded:Array,added:Array}>}
 */
async function ensureAcquisitionExclusions({ client, scope }) {
  const guarded = [];
  const added = [];

  for (const seg of scope.segments) {
    const current = await client.getSegment(seg.id);
    if (!hasHoldExclusion(current)) {
      const filters = [...(current?.filters || []), { ...HOLD_EXCLUSION_FILTER }];
      await client.updateSegment(seg.id, { filters });
      added.push(str(seg.id));
    }
    /* READ BACK. A 200 on the write is not the fact; the stored filter is. */
    const after = await client.getSegment(seg.id);
    if (!hasHoldExclusion(after)) {
      throw fail("MAUTIC_REJECTED_WRITE",
        `Mautic accepted the change but acquisition segment ${seg.id} still does not exclude held contacts, so a held person could be enrolled again.`,
        { segmentId: str(seg.id) });
    }
    guarded.push(str(seg.id));
  }

  /* A registered acquisition CAMPAIGN is only as protected as the segments it
     draws from. One sourced from a segment nobody registered would keep pulling
     held people in, so an unguarded source is a visible failure rather than a
     silent gap. */
  for (const camp of scope.campaigns) {
    const full = await client.getCampaign(camp.id);
    const sources = (full?.lists || []).map((l) => str(l.id));
    const unguarded = sources.filter((id) => !guarded.includes(id));
    if (unguarded.length) {
      throw fail("ACQUISITION_SCOPE_UNVERIFIABLE",
        `Acquisition campaign ${camp.id} draws contacts from segment(s) ${unguarded.join(", ")}, which are not registered acquisition segments and therefore do not exclude held contacts. Register them, then retry.`,
        { campaignId: str(camp.id), unguarded });
    }
  }

  return { guarded, added };
}

/* ═══ RAISING THE COMMAND ══════════════════════════════════════════════════ */

/**
 * Record that Sales' decision owes Mautic a per-person acquisition stop.
 *
 * Idempotent by unique index, not by a read-then-write check: two deliveries of
 * the same decision race into the same document and the loser is told so.
 *
 * @returns {Promise<{created:boolean, duplicate:boolean, row:object, owed:boolean}>}
 */
async function request({
  companyId, handover, decision, decidedAt = null, now = new Date(),
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "An acquisition hold needs a company.");
  }
  const reason = HOLD_REASON_FOR_DECISION[str(decision)];
  /* Not an error. Most decisions do not hold acquisition, and a caller asking
     about one should get a plain "nothing is owed" rather than an exception it
     has to catch to carry on. */
  if (!reason) return { created: false, duplicate: false, row: null, owed: false };

  const handoverRef = str(handover?.handoverRef);
  if (!handoverRef) {
    throw fail("VALIDATION", "An acquisition hold needs the handover it came from.", { field: "handoverRef" });
  }

  /* The canonical opaque identity, resolved from the identity mapping by the
     handover's own match key. A command for a person Mautic has never heard of
     is still recorded — it is owed, and the attempt will say exactly why it
     cannot be carried out yet. */
  const gravPersonKey = await personKeyFor({ companyId, handover });

  try {
    const created = await Hold.create({
      companyId,
      handoverRef,
      handoverId: handover?._id || null,
      gravPersonKey,
      reason,
      decidedAt: decidedAt ? new Date(decidedAt) : null,
      requestedAt: now,
      state: "REQUESTED",
    });
    return { created: true, duplicate: false, row: created.toObject(), owed: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* The command already exists. The FIRST one is the one that counts — this
       is replay, and a second row would be a second thing to reconcile. */
    const existing = await Hold.findOne({ companyId, handoverRef }).lean();
    return { created: false, duplicate: true, row: existing, owed: true };
  }
}

/**
 * The GRAV person this handover is about.
 *
 * Company-scoped, and falls back to the handover's own recorded key rather than
 * inventing one: an unresolvable identity is a truthful terminal failure later,
 * not a guess now.
 */
async function personKeyFor({ companyId, handover }) {
  const email = str(handover?.matchKeys?.normalizedEmail) || str(handover?.person?.workEmail);
  const externalId = str(handover?.matchKeys?.externalContactId);

  if (externalId) {
    const byExternal = await MarketingIdentity.findOne({
      companyId, "externals.system": "mautic", "externals.externalId": externalId,
    }).lean();
    if (byExternal?.gravPersonKey) return str(byExternal.gravPersonKey);
  }
  if (email) {
    const byEmail = await MarketingIdentity.findOne({ companyId, email }).lean();
    if (byEmail?.gravPersonKey) return str(byEmail.gravPersonKey);
  }
  /* Nothing maps. The command still has to exist, so it is keyed on the
     handover itself — unmistakably not a person key, which is what makes the
     later failure honest rather than silently aimed at the wrong contact. */
  return `unresolved:${str(handover?.handoverRef)}`;
}

/* ═══ CARRYING IT OUT ══════════════════════════════════════════════════════ */

/**
 * Apply one acquisition hold against the live Mautic instance.
 *
 * Never throws for a Mautic failure: the failure is the outcome and is recorded
 * as one. It throws only for a caller mistake — no company, no handover
 * reference — because that is not a state worth storing.
 *
 * @returns {Promise<object>} the settled command, plus `changed` and `note`.
 */
async function apply({
  companyId, handoverRef, client = null, leaseToken = "", now = new Date(), env = process.env,
} = {}) {
  const key = assertKey({ companyId, handoverRef });

  const row = await Hold.findOne(key).lean();
  if (!row) throw fail("NOT_FOUND", "There is no acquisition hold for that handover.");

  /* Settled. Applying again would re-enter Mautic for a change already proved,
     and on a SUPERSEDED row it would undo somebody else's newer decision. */
  if (!UNFINISHED_STATES.includes(row.state)) {
    return { ...row, changed: false, note: `Already ${row.state}.` };
  }

  /* ── IS IT STILL OWED? ─────────────────────────────────────────────────
     Two ways it can have stopped being owed, both of them real and neither of
     them a failure. Checked BEFORE any Mautic write, so a superseded command
     never touches the instance. */
  const superseded = await supersessionFor({ companyId, row });
  if (superseded) {
    return settleSuperseded({ key, row, superseded, leaseToken, now });
  }

  const mautic = client || new MauticClient({ env });
  const contactId = await resolveContactId({ companyId, row });

  const started = await beginAttempt({ key, leaseToken, now });
  if (!started.opened) return { ...row, changed: false, note: started.note };
  const attemptNo = started.attemptNo;

  try {
    if (!contactId) {
      throw fail("NOT_FOUND",
        "This person has no proven marketing engine contact, so there is no acquisition to stop. Project them first, or confirm they were never enrolled.");
    }

    /* 1. RESOLVE THE ACQUISITION SCOPE, AND REFUSE WITHOUT ONE.
          This also proves both membership reads are not blind: the two
          collection endpoints answer 403 for an identity without permission,
          where `GET /api/contacts/{id}/campaigns` answers an empty 200 and would
          have let a still-enrolled person be reported as stopped. */
    const scope = await resolveScope({ client: mautic, env });

    /* 2. THE STANDING EXCLUSION, BEFORE ANYTHING IS REMOVED.
          Removal handles today's memberships; this is what keeps the person out
          of an acquisition segment built next week. Read back, not assumed. */
    const exclusions = await ensureAcquisitionExclusions({ client: mautic, scope });

    /* 3. THE SALES-OWNED FLAG ON THE CONTACT, THEN READ BACK.
          Set before the removals so that a crash between the steps leaves the
          person excluded rather than removed-but-re-enrollable. The read-back is
          the fact: `evidence.holdFieldSet` must never come from a PATCH's own
          200, which says only that Mautic accepted the request. */
    await mautic.updateContact(contactId, { [ACQUISITION_HOLD_FIELD]: 1 });
    const contactAfterFlag = await mautic.getContact(contactId);
    const storedFlag = contactAfterFlag?.fields?.all?.[ACQUISITION_HOLD_FIELD];
    const holdFieldSet = storedFlag === true || String(storedFlag) === "1";
    if (!holdFieldSet) {
      throw fail("MAUTIC_REJECTED_WRITE",
        "The change was accepted but the person is not marked as held, so nothing would keep them out of future acquisition campaigns.",
        { field: ACQUISITION_HOLD_FIELD });
    }

    /* 4. THE REGISTERED MEMBERSHIPS THEY HOLD TODAY. Read, then remove one by
          one — never a campaign-wide write, and never a membership outside the
          registered acquisition scope. */
    const segmentsBefore = await mautic.contactSegments(contactId);
    const campaignsBefore = await mautic.contactCampaigns(contactId);

    const segmentTargets = segmentsBefore.filter((x) => inScope(x, scope.segments));
    const campaignTargets = campaignsBefore.filter((x) => inScope(x, scope.campaigns));
    /* What was deliberately LEFT ALONE, counted so the evidence shows the
       restraint rather than only the removals. */
    const untouched = {
      segments: segmentsBefore.length - segmentTargets.length,
      campaigns: campaignsBefore.length - campaignTargets.length,
    };

    for (const x of segmentTargets) await mautic.removeContactFromSegment(str(x.id), contactId);
    for (const x of campaignTargets) await mautic.removeContactFromCampaign(str(x.id), contactId);

    /* 5. THE READ-BACK. Mautic answers `{"success":1}` to removing a contact
          that was never a member, so the write responses prove nothing at all.
          This is what `confirmedAt` is allowed to be written from. */
    const segmentsAfter = await mautic.contactSegments(contactId);
    const campaignsAfter = await mautic.contactCampaigns(contactId);
    const segmentsRemaining = segmentsAfter.filter((x) => inScope(x, scope.segments));
    const campaignsRemaining = campaignsAfter.filter((x) => inScope(x, scope.campaigns));

    if (segmentsRemaining.length || campaignsRemaining.length) {
      throw fail("MAUTIC_REJECTED_WRITE",
        `The stop was accepted but this person is still in ${segmentsRemaining.length} acquisition audience(s) and ${campaignsRemaining.length} acquisition campaign(s), so it is not confirmed.`,
        { segments: segmentsRemaining.length, campaigns: campaignsRemaining.length });
    }

    const confirmedAt = new Date();
    const settled = await Hold.findOneAndUpdate(
      fencedFilter(key, leaseToken, now),
      {
        $set: {
          state: "APPLIED",
          confirmedAt,
          mauticContactId: str(contactId),
          retryCount: 0,
          nextAttemptAt: null,
          inFlightSince: null,
          activeError: null,
          evidence: {
            /* From the read-back above, never from the PATCH response. */
            holdFieldSet: true,
            segmentsRemoved: segmentTargets.map((x) => str(x.id)),
            campaignsRemoved: campaignTargets.map((x) => str(x.id)),
            segmentsRemainingAfter: segmentsRemaining.length,
            campaignsRemainingAfter: campaignsRemaining.length,
            segmentsLeftAlone: untouched.segments,
            campaignsLeftAlone: untouched.campaigns,
            /* THE EXACT SCOPE THIS COMMAND USED, stored rather than re-derived.
               A later configuration change rewrites what "acquisition" means;
               it must not rewrite what this command is recorded as having
               done. */
            scope: {
              segments: scope.segments,
              campaigns: scope.campaigns,
              declaredSegments: scope.declared.segments,
              declaredCampaigns: scope.declared.campaigns,
              resolvedAt: scope.resolvedAt,
            },
            exclusionsGuarded: exclusions.guarded,
            exclusionsAdded: exclusions.added,
            verifiedAt: confirmedAt,
          },
          "claim.token": "", "claim.at": null, "claim.expiresAt": null, "claim.by": "",
        },
      },
      { new: true },
    );
    if (!settled) return { ...row, changed: false, note: "LEASE_LOST" };

    /* ── AND NOW, AND ONLY NOW, THE HANDOVER MAY SAY IT ──────────────────
       Written from `confirmedAt`, which came from the read-back. This is the
       single line in the codebase that may populate the timestamp, and it runs
       after Mautic has been asked and has agreed. */
    await Handover.updateOne(
      { companyId, handoverRef: key.handoverRef },
      { $set: { "permission.acquisitionPausedAt": confirmedAt } },
    );

    await audit({
      companyId, row: settled.toObject(), action: "handover.acquisition_hold.applied", at: confirmedAt,
      details: {
        mauticContactId: str(contactId),
        segmentsRemoved: settled.evidence?.segmentsRemoved || [],
        campaignsRemoved: settled.evidence?.campaignsRemoved || [],
        segmentsLeftAlone: settled.evidence?.segmentsLeftAlone ?? null,
        campaignsLeftAlone: settled.evidence?.campaignsLeftAlone ?? null,
        exclusionsGuarded: settled.evidence?.exclusionsGuarded || [],
        attemptNo,
      },
    });

    return { ...settled.toObject(), changed: true, note: "" };
  } catch (err) {
    const settled = await recordFailure({ key, err, attemptNo, leaseToken, now, row });
    return { ...(settled || row), changed: false, note: safeMessage(err) };
  }
}

/** Open an attempt. IN FLIGHT is REQUESTED plus `inFlightSince`. */
async function beginAttempt({ key, leaseToken, now }) {
  const opened = await Hold.findOneAndUpdate(
    fencedFilter(key, leaseToken, now),
    {
      $inc: { attempts: 1 },
      $set: { inFlightSince: now, lastAttemptAt: now, state: "REQUESTED", nextAttemptAt: null },
    },
    { new: true },
  );
  if (!opened) return { opened: false, note: "LEASE_LOST", attemptNo: 0 };
  return { opened: true, note: "", attemptNo: Number(opened.attempts) || 1 };
}

/**
 * Record a failed attempt truthfully.
 *
 * A transient failure schedules the next attempt; a terminal one does not, and
 * neither pretends the hold is applied. The Sales decision is not touched by
 * either — it is already recorded and this has no authority over it.
 */
async function recordFailure({ key, err, attemptNo, leaseToken, now, row }) {
  const { failureClass, reasonCode } = classify(err);
  const retryCount = failureClass === "TRANSIENT" ? (Number(row?.retryCount) || 0) + 1 : 0;
  const budgetSpent = failureClass === "TRANSIENT" && retryCount >= DELIVERY_RETRY.MAX_ATTEMPTS;
  const retryable = failureClass === "TRANSIENT" && !budgetSpent;

  const activeError = {
    /* A spent budget stops being "Mautic was unreachable" and becomes "this has
       been tried as often as it is going to be" — which is the thing an operator
       must act on, and it would otherwise hide among the transient failures. */
    reasonCode: budgetSpent ? "RETRY_BUDGET_SPENT" : reasonCode,
    sourceCode: str(err?.code),
    failureClass,
    message: safeMessage(err),
    at: now,
    attemptNo,
  };

  const settled = await Hold.findOneAndUpdate(
    fencedFilter(key, leaseToken, now),
    {
      $set: {
        state: "FAILED",
        activeError,
        retryCount,
        inFlightSince: null,
        nextAttemptAt: retryable ? new Date(now.getTime() + backoffMsFor(retryCount)) : null,
        "claim.token": "", "claim.at": null, "claim.expiresAt": null, "claim.by": "",
      },
    },
    { new: true },
  );
  if (!settled) return null;

  await audit({
    companyId: key.companyId, row: settled.toObject(), action: "handover.acquisition_hold.failed", at: now,
    details: { reasonCode: activeError.reasonCode, failureClass, attemptNo, retryScheduled: Boolean(retryable) },
  });
  return settled.toObject();
}

/* ═══ SUPERSESSION ═════════════════════════════════════════════════════════

   A command can stop being owed without ever being carried out, and saying so
   is not the same as claiming success. Two real causes:

     NEWER_HOLD          a later handover for the same person already has an
                         APPLIED hold. Acquisition is stopped; this command has
                         nothing left to do, and driving it would re-enter
                         Mautic for a change already proved.
     CONSENT_SUPPRESSED  canonical consent now suppresses the channel. Every
                         send is already blocked, for a stronger and
                         person-owned reason.

   Neither writes consent, and neither claims the hold was applied —
   `confirmedAt` stays empty, which the schema enforces. */
async function supersessionFor({ companyId, row }) {
  const newer = await Hold.findOne({
    companyId,
    gravPersonKey: row.gravPersonKey,
    state: "APPLIED",
    handoverRef: { $ne: row.handoverRef },
    requestedAt: { $gt: row.requestedAt },
  }).sort({ requestedAt: -1 }).lean();
  if (newer) return { reason: "NEWER_HOLD", handoverRef: str(newer.handoverRef) };

  if (!str(row.gravPersonKey).startsWith("unresolved:")) {
    const verdict = await consentService.resolveEffective({
      companyId, gravPersonKey: row.gravPersonKey, ...consentService.MARKETING_EMAIL,
    });
    if (verdict.state === "suppressed") return { reason: "CONSENT_SUPPRESSED", handoverRef: "" };
  }
  return null;
}

async function settleSuperseded({ key, row, superseded, leaseToken, now }) {
  const settled = await Hold.findOneAndUpdate(
    fencedFilter(key, leaseToken, now),
    {
      $set: {
        state: "SUPERSEDED",
        /* The failure that was standing is cleared: it is no longer what is
           wrong, because nothing is. */
        activeError: null,
        nextAttemptAt: null,
        inFlightSince: null,
        supersededBy: { reason: superseded.reason, at: now, handoverRef: superseded.handoverRef },
        "claim.token": "", "claim.at": null, "claim.expiresAt": null, "claim.by": "",
      },
    },
    { new: true },
  );
  if (!settled) return { ...row, changed: false, note: "LEASE_LOST" };

  await audit({
    companyId: key.companyId, row: settled.toObject(), action: "handover.acquisition_hold.superseded", at: now,
    details: { supersededBy: superseded.reason, byHandoverRef: superseded.handoverRef },
  });
  return { ...settled.toObject(), changed: true, note: `Superseded by ${superseded.reason}.` };
}

/** The proven Mautic contact for this command's person, company-scoped. */
async function resolveContactId({ companyId, row }) {
  if (str(row.mauticContactId)) return str(row.mauticContactId);
  const identity = await MarketingIdentity.findOne({
    companyId, gravPersonKey: row.gravPersonKey,
  }).lean();
  const external = (identity?.externals || []).find((e) => str(e.system) === "mautic" && str(e.externalId));
  return str(external?.externalId);
}

/* ═══ RECOVERY ═════════════════════════════════════════════════════════════ */

/**
 * Carry out every acquisition hold this company still owes and whose time has
 * come. Company-scoped at the selector, the claim and the read-back.
 *
 * This is the whole of requirement 6: a decision that survived a Mautic outage
 * is repaired here, with no Sales involvement.
 */
async function resumeUnfinished({
  companyId, limit = 25, client = null, now = new Date(), env = process.env,
  by = "acquisition-hold-recovery", actor = null,
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Acquisition-hold recovery needs a company.");
  }

  const due = await Hold.find({
    companyId,
    state: { $in: UNFINISHED_STATES },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  }).sort({ requestedAt: 1, _id: 1 }).limit(Math.max(1, Math.min(Number(limit) || 25, 200))).lean();

  const summary = {
    considered: due.length, applied: 0, superseded: 0, stillFailed: 0, skipped: 0, integrity: [],
  };
  const mautic = client || new MauticClient({ env });

  for (const candidate of due) {
    /* ── THE LEASE, TAKEN COMPANY-SCOPED ──────────────────────────────────
       The filter carries companyId AND the command's own id AND its handover
       reference. A company may not claim, drive or even touch another's
       command, and the claim is the first place that has to hold. */
    const token = crypto.randomBytes(12).toString("hex");
    const claimed = await Hold.findOneAndUpdate(
      {
        _id: candidate._id,
        companyId,
        handoverRef: candidate.handoverRef,
        state: { $in: UNFINISHED_STATES },
        $or: [
          { "claim.token": { $in: ["", null] } },
          { "claim.token": { $exists: false } },
          { "claim.expiresAt": { $lte: now } },
        ],
      },
      {
        $set: {
          "claim.token": token, "claim.at": now, "claim.by": str(by),
          "claim.expiresAt": new Date(now.getTime() + DELIVERY_RETRY.CLAIM_TTL_MS),
        },
      },
      { new: true },
    );
    if (!claimed) { summary.skipped += 1; continue; }

    /* ── WHO ASKED FOR THIS ATTEMPT ───────────────────────────────────────
        There is no scheduler, so every attempt after the first has a person
        behind it. One audit line per claimed command, naming them, because a
        bulk outbound action nobody is recorded as having requested is a bulk
        outbound action nobody can be asked about. */
    if (actor) {
      await MarketingAuditEvent.create({
        companyId,
        handoverRef: candidate.handoverRef,
        handoverId: candidate.handoverId || undefined,
        action: "handover.acquisition_hold.retry_requested",
        actor: { id: actor.id, name: str(actor.name), email: str(actor.email) },
        at: now,
        previousState: str(candidate.state),
        resultingState: str(candidate.state),
        correlationId: `${candidate.handoverRef}:acquisition-hold`,
        details: { requestedBy: str(by) },
      });
    }

    /* ── AND THE HANDOVER MUST BELONG TO THIS COMPANY TOO ─────────────────
        A command is only meaningful beside the decision it came from. Reading
        the handover with the COMPLETE expected identity — id, company and
        reference — is what stops a drifted or hand-edited command from being
        driven against a handover that is not this company's. A mismatch is
        reported, never guessed at. */
    const handover = await Handover.findOne({
      _id: candidate.handoverId || undefined,
      companyId,
      handoverRef: candidate.handoverRef,
    }).lean();
    if (!handover) {
      summary.stillFailed += 1;
      summary.integrity.push({
        handoverRef: candidate.handoverRef,
        reason: "The acquisition hold points at no handover belonging to this company.",
      });
      await releaseClaim({ companyId, handoverRef: candidate.handoverRef, claimToken: token });
      continue;
    }

    const out = await apply({
      companyId, handoverRef: candidate.handoverRef, client: mautic, leaseToken: token, now: new Date(), env,
    });
    if (out.state === "APPLIED") summary.applied += 1;
    else if (out.state === "SUPERSEDED") summary.superseded += 1;
    else summary.stillFailed += 1;
  }

  return summary;
}

async function releaseClaim({ companyId, handoverRef, claimToken } = {}) {
  const key = assertKey({ companyId, handoverRef });
  await Hold.updateOne(
    { ...key, "claim.token": str(claimToken) },
    { $set: { "claim.token": "", "claim.at": null, "claim.expiresAt": null, "claim.by": "" } },
  );
}

/* ═══ READING ══════════════════════════════════════════════════════════════ */

/* The read-time state, with the scheduled split by the clock — the same
   treatment delivery health gets, and for the same reason: a stored value that
   said "retry due" would become wrong as the clock moved with no write to blame.
   A crashed attempt is split out too, because an attempt that opened an hour
   ago and never settled is not an attempt in progress. */
function effectiveState(row, now = new Date()) {
  if (!row) return "NONE";
  if (row.state !== "REQUESTED" && row.state !== "FAILED") return row.state;
  if (row.inFlightSince) {
    const stale = now.getTime() - new Date(row.inFlightSince).getTime() > DELIVERY_RETRY.CLAIM_TTL_MS;
    return stale ? "IN_FLIGHT_STALE" : "IN_FLIGHT";
  }
  if (row.state === "FAILED") {
    if (!row.nextAttemptAt) return "FAILED_NEEDS_PERSON";
    return new Date(row.nextAttemptAt) <= now ? "RETRY_DUE" : "RETRY_WAITING";
  }
  return "REQUESTED";
}

/* ── THE SENTENCE A SALESPERSON READS ───────────────────────────────────────
   Requirement 10. Not one of these says acquisition is paused unless Mautic has
   confirmed it, and the unconfirmed ones say what is actually true instead —
   which is the whole difference between this slice and the version it replaces.

   ── AND NOT ONE OF THEM PROMISES AUTOMATIC RECOVERY ──────────────────────
   `RETRY_WAITING` used to read "it will be retried automatically". Nothing in
   this deployment retries anything: there is no scheduler, and the only thing
   that drives a failed command is an operator asking for it or a later
   redelivery of the same Sales decision. Saying "automatically" made the
   Sales-facing text a second false claim in a feature built to remove the first
   one — and a worse kind, because it tells a salesperson they need do nothing.

   So these say AWAITING RETRY, which is exactly what a scheduled-but-undriven
   command is. When a scheduler is wired in, this is the one place to change. */
const SALES_FACING_LABEL = Object.freeze({
  NONE: "No marketing pause is owed for this handover.",
  REQUESTED: "Marketing pause requested — not yet applied in the marketing engine.",
  IN_FLIGHT: "Marketing pause in progress.",
  IN_FLIGHT_STALE: "Marketing pause unfinished — the last attempt did not complete.",
  RETRY_WAITING: "Marketing pause failed — awaiting retry, which is not automatic.",
  RETRY_DUE: "Marketing pause failed — awaiting retry now; it needs an operator or a redelivery.",
  FAILED_NEEDS_PERSON: "Marketing pause failed — it needs operator attention.",
  APPLIED: "Acquisition marketing stopped for this person.",
  SUPERSEDED: "No marketing pause needed — acquisition is already stopped for this person.",
});

/* ── THE FOUR FACTS A READER MUST BE ABLE TO TELL APART ─────────────────────
   Requested, awaiting retry, currently removed and prevented from re-entering
   are four different things, and a single "paused" flag conflated all of them.
   This is the shape every read boundary serves them in. */
function disclosure(row) {
  const applied = row?.state === "APPLIED";
  const ev = row?.evidence || {};
  return {
    /* Memberships this command actually took away, now. */
    currentlyRemoved: {
      segments: applied ? (ev.segmentsRemoved || []) : [],
      campaigns: applied ? (ev.campaignsRemoved || []) : [],
    },
    /* The standing exclusion that keeps them out of acquisition built LATER.
       True only when the registered acquisition segments were proved to carry
       the `grav_acquisition_hold != 1` filter and the contact flag was read
       back. */
    futureEnrollmentPrevented: Boolean(applied && ev.holdFieldSet && (ev.exclusionsGuarded || []).length),
    guardedAcquisitionSegments: applied ? (ev.exclusionsGuarded || []) : [],
    /* Owed and not done. Never "will be retried". */
    awaitingRetry: Boolean(row && UNFINISHED_STATES.includes(row.state)),
    retryIsAutomatic: false,
    /* The only true statement that acquisition has stopped. */
    confirmedStopped: applied,
    confirmedAt: applied ? row.confirmedAt : null,
  };
}

/**
 * One command, shaped for a reader.
 *
 * `pausedAt` is null for every state but APPLIED, by construction rather than
 * by the caller remembering to check. A safe failure reason only: a stable code
 * and the operator sentence, never a provider body or a stack.
 */
async function stateFor({ companyId, handoverRef, now = new Date() } = {}) {
  const key = assertKey({ companyId, handoverRef });
  const row = await Hold.findOne(key).lean();
  return { exists: Boolean(row), ...presentHold(row, now) };
}

/**
 * The same read as `stateFor`, for many handovers at once.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The handovers list shows an acquisition state per row, and calling `stateFor`
 * per row is a query per row — the classic N+1, which on a 50-row page is 50
 * round trips for information one query holds. This is one company-scoped read
 * keyed by handover reference.
 *
 * A reference with no command is absent from the map rather than present with a
 * null: "no hold was ever raised" is a real answer and the caller renders it,
 * and a null would invite a reader to treat it as a failed one.
 *
 * @returns {Promise<Map<string, object>>} handoverRef → the same shape stateFor
 *   returns, minus `exists` (a row in this map exists by definition).
 */
async function statesFor({ companyId, handoverRefs = [], now = new Date() } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Acquisition holds cannot be read without a company.");
  }
  const refs = [...new Set((handoverRefs || []).map(str).filter(Boolean))];
  const out = new Map();
  if (!refs.length) return out;

  const rows = await Hold.find({ companyId, handoverRef: { $in: refs } }).lean();
  for (const row of rows) out.set(str(row.handoverRef), presentHold(row, now));
  return out;
}

/* One row, shaped for a reader. Shared by `stateFor` and `statesFor` so the
   single-handover page and the list cannot describe the same command two
   different ways. */
function presentHold(row, now = new Date()) {
  const state = effectiveState(row, now);
  return {
    state,
    storedState: row?.state || "NONE",
    label: SALES_FACING_LABEL[state] || SALES_FACING_LABEL.NONE,
    /* The ONLY place a reader is told acquisition has stopped. */
    pausedAt: row?.state === "APPLIED" ? row.confirmedAt : null,
    requestedAt: row?.requestedAt || null,
    reason: row?.reason || "",
    attempts: Number(row?.attempts) || 0,
    lastAttemptAt: row?.lastAttemptAt || null,
    nextAttemptAt: row?.nextAttemptAt || null,
    /* Translated here because this shape is served inside 200 responses on both
       the Marketing and the Sales handover screens, so it never passes through
       the route-level privacy boundary. */
    failure: row?.activeError
      ? {
        reasonCode: providerPrivacy.publicReasonCode(row.activeError.reasonCode),
        failureClass: row.activeError.failureClass,
        message: providerPrivacy.scrubText(row.activeError.message),
        at: row.activeError.at,
      }
      : null,
    disclosure: disclosure(row),
    supersededBy: row?.supersededBy?.reason
      ? { reason: row.supersededBy.reason, at: row.supersededBy.at, handoverRef: row.supersededBy.handoverRef || "" }
      : null,
    evidence: row
      ? {
        holdFieldSet: Boolean(row.evidence?.holdFieldSet),
        segmentsRemoved: row.evidence?.segmentsRemoved || [],
        campaignsRemoved: row.evidence?.campaignsRemoved || [],
        verifiedAt: row.evidence?.verifiedAt || null,
      }
      : null,
  };
}

/**
 * The operator view: how many commands this company owes, and the oldest one.
 *
 * Grouped by the read-time state so "failed" and "waiting for its backoff" are
 * not one number. No person data — an operator screen joins to the identity for
 * that, and a health row that carried an email would be a second copy of
 * personal data outliving the person's deletion.
 */
async function healthSummary({ companyId, now = new Date() } = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Acquisition-hold health needs a company.");
  }
  const rows = await Hold.find({ companyId }).lean();
  const byState = {};
  let oldestUnfinishedAt = null;
  let dueNow = 0;

  for (const r of rows) {
    const s = effectiveState(r, now);
    byState[s] = (byState[s] || 0) + 1;
    if (UNFINISHED_STATES.includes(r.state)) {
      const at = r.requestedAt ? new Date(r.requestedAt) : null;
      if (at && (!oldestUnfinishedAt || at < oldestUnfinishedAt)) oldestUnfinishedAt = at;
      if (s === "RETRY_DUE" || s === "REQUESTED" || s === "IN_FLIGHT_STALE") dueNow += 1;
    }
  }

  return {
    total: rows.length,
    applied: rows.filter((r) => r.state === "APPLIED").length,
    superseded: rows.filter((r) => r.state === "SUPERSEDED").length,
    unfinished: rows.filter((r) => UNFINISHED_STATES.includes(r.state)).length,
    dueNow,
    oldestUnfinishedAt,
    byState,
  };
}

/** One audit line per transition, on the handover's own audit trail. */
async function audit({ companyId, row, action, at, details }) {
  await MarketingAuditEvent.create({
    companyId,
    handoverRef: row.handoverRef,
    handoverId: row.handoverId || undefined,
    action,
    at,
    /* No Marketing actor: nobody in Marketing decided this. Sales decided, and
       inventing a marketer for the consequence would be a false attribution. */
    previousState: "",
    resultingState: row.state,
    correlationId: `${row.handoverRef}:acquisition-hold`,
    details,
  });
}

module.exports = {
  request,
  apply,
  resolveScope,
  ensureAcquisitionExclusions,
  declaredScope,
  HOLD_EXCLUSION_FILTER,
  SCOPE_ENV,
  resumeUnfinished,
  releaseClaim,
  stateFor,
  statesFor,
  presentHold,
  healthSummary,
  effectiveState,
  backoffMsFor,
  UNFINISHED_STATES,
  HOLD_REASON_FOR_DECISION,
  SALES_FACING_LABEL,
  disclosure,
};
