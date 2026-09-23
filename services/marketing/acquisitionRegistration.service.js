// services/marketing/acquisitionRegistration.service.js
//
// REGISTERING ACQUISITION AUTOMATION IS AN OPERATION, NOT AN EDIT.
//
// ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
// Acquisition scope is declared in two environment variables, and the hold
// application installs the `grav_acquisition_hold != 1` exclusion on every
// registered segment when it runs. That left a window nobody owned: a segment
// added to the variables was REGISTERED as far as configuration was concerned
// and UNGUARDED in Mautic until the next acceptance happened to run. In between,
// a contact GRAV had already held could be enrolled in it, and GRAV would have
// gone on reporting them as stopped.
//
// So editing the variables is not registration. Registration is this operation,
// and it is the only thing entitled to call the scope ready:
//
//   1. resolve every configured segment and campaign against the live instance;
//   2. ensure every acquisition segment excludes held contacts;
//   3. read every filter back;
//   4. verify acquisition campaigns source only from guarded registered
//      segments;
//   5. reconcile existing APPLIED holds against the newly registered scope —
//      a person held last month must be out of a path registered today;
//   6. and only then report ready.
//
// Any step failing means NOT READY, with the reason. A caller that sees
// `ready: false` has a configured scope Mautic does not yet enforce.
//
// ── THE BOUNDARY, STATED PLAINLY ───────────────────────────────────────────
// GRAV guarantees REGISTERED acquisition automation. It cannot stop somebody
// building a campaign in Mautic's own interface and never telling GRAV about it:
// Mautic has no hook that would let an outside application veto that, and
// claiming otherwise would be the same kind of false assurance this whole slice
// exists to remove. Unmanaged automation is configuration drift, and the honest
// treatment is to expose it — `unregisteredAutomation` below lists what exists
// in the instance that nobody has registered, so a health check can say so out
// loud rather than letting it pass for safety.
"use strict";

const mongoose = require("mongoose");

const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const acquisitionHold = require("./acquisitionHold.service");
const { MauticClient } = require("./mauticClient");
const { fail } = require("../storePurchase/errors");
const { ACQUISITION_HOLD_FIELD } = require("../../constants/marketing");

const str = (v) => String(v ?? "").trim();

/**
 * Run the registration operation.
 *
 * Never throws for a configuration or Mautic problem: the answer to "is the
 * scope ready" is a report, and a thrown error would make a not-ready scope
 * indistinguishable from a crash. It throws only for a caller mistake.
 *
 * @returns {Promise<object>} the registration report, including `ready`.
 */
async function register({
  companyId, client = null, env = process.env, reconcileHolds = true,
  holdPageSize = 100, holdCursor = null, maxHoldPages = 100,
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Registering acquisition scope needs a company.");
  }
  const mautic = client || new MauticClient({ env });

  const report = {
    ready: false,
    declared: acquisitionHold.declaredScope(env),
    scope: null,
    guardedSegments: [],
    exclusionsAdded: [],
    campaignsVerified: [],
    holdsReconciled: { examined: 0, corrected: 0, alreadyClean: 0, failed: 0, complete: false, nextCursor: null },
    /* ── READY AND COMPLETE ARE THE SAME ANSWER HERE ──────────────────────
       `complete` is false whenever any applicable applied hold was left
       unexamined, and `ready` can never be true while it is. A registration
       that checked the first page of holds and declared the scope enforced was
       exactly the false assurance this operation exists to prevent. */
    complete: false,
    continuation: null,
    unregisteredAutomation: { segments: [], campaigns: [] },
    problems: [],
    at: new Date(),
  };

  /* ── 1 AND 4: RESOLVE, AND PROVE THE INSTANCE IS READABLE ───────────────
     `resolveScope` refuses an unregistered or unresolvable scope and, as a side
     effect, proves both collection reads work — the two endpoints that answer
     403 where the per-contact reads answer a misleading empty 200. */
  let scope;
  try {
    scope = await acquisitionHold.resolveScope({ client: mautic, env });
  } catch (err) {
    report.problems.push({ code: str(err?.code), message: str(err?.message) });
    return report;
  }
  report.scope = {
    segments: scope.segments,
    campaigns: scope.campaigns,
    resolvedAt: scope.resolvedAt,
  };

  /* ── 2, 3 AND 4: INSTALL, READ BACK, AND VERIFY THE CAMPAIGN SOURCES ──── */
  try {
    const exclusions = await acquisitionHold.ensureAcquisitionExclusions({ client: mautic, scope });
    report.guardedSegments = exclusions.guarded;
    report.exclusionsAdded = exclusions.added;
    report.campaignsVerified = scope.campaigns.map((c) => str(c.id));
  } catch (err) {
    report.problems.push({ code: str(err?.code), message: str(err?.message) });
    return report;
  }

  /* ── 5: EXISTING HOLDS AGAINST THE NEW SCOPE ────────────────────────────
     A person held before today's registration may already sit inside a path
     registered today. The standing filter keeps them out of future rebuilds;
     it does not remove a membership they already have. So every APPLIED hold is
     re-checked against the scope as it is now, and a membership that has come
     into scope is removed and recorded. */
  if (reconcileHolds) {
    report.holdsReconciled = await reconcileAppliedHolds({
      companyId, client: mautic, scope, pageSize: holdPageSize, cursor: holdCursor, maxPages: maxHoldPages,
    });
    if (report.holdsReconciled.failed) {
      report.problems.push({
        code: "ACQUISITION_HOLD_RECONCILE_INCOMPLETE",
        message: `${report.holdsReconciled.failed} applied hold(s) could not be reconciled against the newly registered scope.`,
      });
      return report;
    }
    if (!report.holdsReconciled.complete) {
      report.continuation = { holdCursor: report.holdsReconciled.nextCursor };
      report.problems.push({
        code: "ACQUISITION_HOLD_RECONCILE_INCOMPLETE",
        message: `Only ${report.holdsReconciled.examined} applied hold(s) were examined before the scan limit. An unexamined contact may still be enrolled in the newly registered acquisition automation, so the scope is not ready. Re-run with holdCursor "${report.holdsReconciled.nextCursor}".`,
      });
      return report;
    }
  } else {
    /* A caller that skipped the reconciliation has not established anything
       about existing holds, and may not be told the scope is ready. */
    report.problems.push({
      code: "ACQUISITION_HOLD_RECONCILE_SKIPPED",
      message: "Applied holds were not reconciled, so GRAV cannot say whether an already-held contact is inside the newly registered acquisition automation.",
    });
    return report;
  }

  /* ── THE DRIFT REPORT ───────────────────────────────────────────────────
     Not a problem in itself, and not a reason to refuse: GRAV has no way to
     prevent somebody creating automation it was never told about. Listed so a
     health check can show it rather than let it pass unnoticed. */
  report.unregisteredAutomation = await unregisteredAutomation({ client: mautic, scope });

  report.complete = true;
  report.ready = true;
  return report;
}

/**
 * Re-check every applied hold against the scope as it stands now.
 *
 * A hold that was correct under last month's scope can be incomplete under
 * today's. Correcting it keeps the promise the hold already made, which is why
 * `confirmedAt` is left exactly as it was: the stop was confirmed then, and this
 * is the same stop extended over newly registered ground, not a new one.
 */
async function reconcileAppliedHolds({
  companyId, client, scope, pageSize = 100, cursor = null, maxPages = 100,
} = {}) {
  if (!companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Reconciling applied holds needs a company.");
  }
  const summary = {
    examined: 0, corrected: 0, alreadyClean: 0, failed: 0, errors: [],
    complete: false, nextCursor: null, pages: 0,
  };
  const page = Math.max(1, Math.min(Number(pageSize) || 100, 500));
  const pageLimit = Math.max(1, Number(maxPages) || 100);

  /* ── WHY THIS PAGES, AND WHY ON `_id` ──────────────────────────────────────
     The first version read one bounded page of applied holds and stopped, and
     `register()` then returned `ready: true`. So with more holds than the page
     size, a contact nobody had looked at could still be sitting in the newly
     registered acquisition path while the registration said it was enforced —
     the same shape of false assurance this whole slice exists to remove.

     Ascending `_id`, not `confirmedAt`: two holds can share a confirmation time
     and a non-unique sort key makes a cursor ambiguous, which is how a page
     boundary starts skipping rows. */
  let after = cursor ? new mongoose.Types.ObjectId(String(cursor)) : null;
  const holds = [];
  let exhausted = false;

  while (summary.pages < pageLimit) {
    const selector = { companyId, state: "APPLIED" };
    if (after) selector._id = { $gt: after };
    const batch = await Hold.find(selector).sort({ _id: 1 }).limit(page).lean();
    summary.pages += 1;
    if (!batch.length) { exhausted = true; break; }
    holds.push(...batch);
    after = batch[batch.length - 1]._id;
    if (batch.length < page) { exhausted = true; break; }
  }
  summary.complete = exhausted;
  summary.nextCursor = exhausted ? null : String(after);

  for (const hold of holds) {
    summary.examined += 1;
    const contactId = str(hold.mauticContactId);
    if (!contactId) { summary.alreadyClean += 1; continue; }

    try {
      const segments = await client.contactSegments(contactId);
      const campaigns = await client.contactCampaigns(contactId);
      const segTargets = segments.filter((x) => scope.segments.some((s) => str(s.id) === str(x.id)));
      const campTargets = campaigns.filter((x) => scope.campaigns.some((c) => str(c.id) === str(x.id)));

      if (!segTargets.length && !campTargets.length) { summary.alreadyClean += 1; continue; }

      for (const x of segTargets) await client.removeContactFromSegment(str(x.id), contactId);
      for (const x of campTargets) await client.removeContactFromCampaign(str(x.id), contactId);

      /* Read back, for the same reason the hold itself does: Mautic answers
         `{"success":1}` to removing a contact that was never a member. */
      const segAfter = (await client.contactSegments(contactId))
        .filter((x) => scope.segments.some((s) => str(s.id) === str(x.id)));
      const campAfter = (await client.contactCampaigns(contactId))
        .filter((x) => scope.campaigns.some((c) => str(c.id) === str(x.id)));
      if (segAfter.length || campAfter.length) {
        throw fail("MAUTIC_REJECTED_WRITE",
          `Mautic accepted the removals but contact ${contactId} is still in ${segAfter.length} registered segment(s) and ${campAfter.length} registered campaign(s).`);
      }

      const now = new Date();
      await Hold.updateOne(
        { companyId, handoverRef: hold.handoverRef },
        {
          $addToSet: {
            "evidence.segmentsRemoved": { $each: segTargets.map((x) => str(x.id)) },
            "evidence.campaignsRemoved": { $each: campTargets.map((x) => str(x.id)) },
          },
          $set: {
            "evidence.verifiedAt": now,
            "evidence.scope.segments": scope.segments,
            "evidence.scope.campaigns": scope.campaigns,
            "evidence.scope.resolvedAt": scope.resolvedAt,
          },
        },
      );

      /* Its own audit action. Not `applied`: the hold was applied when it was
         applied, and relabelling this as that would hide that the scope grew. */
      await MarketingAuditEvent.create({
        companyId,
        handoverRef: hold.handoverRef,
        handoverId: hold.handoverId || undefined,
        action: "handover.acquisition_hold.rescoped",
        at: now,
        previousState: "APPLIED",
        resultingState: "APPLIED",
        correlationId: `${hold.handoverRef}:acquisition-hold`,
        details: {
          segmentsRemoved: segTargets.map((x) => str(x.id)),
          campaignsRemoved: campTargets.map((x) => str(x.id)),
          reason: "newly registered acquisition scope",
        },
      });

      summary.corrected += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${hold.handoverRef}: ${str(err?.message).slice(0, 200)}`);
    }
  }

  return summary;
}

/**
 * What exists in the instance that nobody registered.
 *
 * Identity only, and never treated as a failure. GRAV cannot stop a marketer
 * building a campaign in Mautic's own interface; what it can do is refuse to
 * pretend that automation is covered.
 */
async function unregisteredAutomation({ client, scope }) {
  const segments = await client.listSegments();
  const campaigns = await client.listCampaigns();
  return {
    segments: segments
      .filter((x) => !scope.segments.some((s) => str(s.id) === str(x.id)))
      .map((x) => ({ id: str(x.id), alias: str(x.alias) })),
    campaigns: campaigns
      .filter((x) => !scope.campaigns.some((c) => str(c.id) === str(x.id)))
      .map((x) => ({ id: str(x.id), alias: str(x.alias) })),
  };
}

/**
 * Is the configured acquisition scope enforced in Mautic right now?
 *
 * A read-only check for a health endpoint: it resolves and inspects, and changes
 * nothing. A configured-but-unguarded scope is NOT READY, which is the whole
 * point — the previous arrangement let it read as healthy.
 *
 * @returns {Promise<{configured:boolean, ready:boolean, reason:string, …}>}
 */
async function inspect({ client = null, env = process.env } = {}) {
  const declared = acquisitionHold.declaredScope(env);
  const configured = Boolean(declared.segments.length || declared.campaigns.length);

  if (!configured) {
    return {
      configured: false,
      ready: false,
      reason: "No acquisition scope is registered, so GRAV will refuse to stop acquisition for an accepted Prospect rather than guess which automation is acquisition.",
      declared,
      unguardedSegments: [],
      unregisteredAutomation: { segments: [], campaigns: [] },
    };
  }

  const mautic = client || new MauticClient({ env });
  let scope;
  try {
    scope = await acquisitionHold.resolveScope({ client: mautic, env });
  } catch (err) {
    return {
      configured: true,
      ready: false,
      reason: str(err?.message),
      code: str(err?.code),
      declared,
      unguardedSegments: [],
      unregisteredAutomation: { segments: [], campaigns: [] },
    };
  }

  const unguarded = [];
  for (const seg of scope.segments) {
    const full = await mautic.getSegment(seg.id);
    const guarded = (full?.filters || []).some((f) => str(f?.field) === ACQUISITION_HOLD_FIELD
      && str(f?.operator) === "!=" && String(f?.properties?.filter) === "1");
    if (!guarded) unguarded.push(str(seg.id));
  }

  /* A registered campaign drawing from an unregistered segment is a hole
     whether or not the segments themselves are guarded. */
  const unguardedCampaignSources = [];
  const guardedIds = scope.segments.map((s) => str(s.id));
  for (const camp of scope.campaigns) {
    const full = await mautic.getCampaign(camp.id);
    const sources = (full?.lists || []).map((l) => str(l.id));
    const bad = sources.filter((id) => !guardedIds.includes(id));
    if (bad.length) unguardedCampaignSources.push({ campaignId: str(camp.id), sources: bad });
  }

  const ready = unguarded.length === 0 && unguardedCampaignSources.length === 0;
  return {
    configured: true,
    ready,
    reason: ready
      ? ""
      : "The configured acquisition scope is not enforced in Mautic. Run the registration operation (scripts/marketing/mautic-register-acquisition.js) — editing the environment variables alone does not register anything.",
    declared,
    scope: { segments: scope.segments, campaigns: scope.campaigns },
    unguardedSegments: unguarded,
    unguardedCampaignSources,
    unregisteredAutomation: await unregisteredAutomation({ client: mautic, scope }),
  };
}

module.exports = { register, inspect, reconcileAppliedHolds, unregisteredAutomation };
