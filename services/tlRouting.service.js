/**
 * services/tlRouting.service.js
 *
 * WHOSE APPROVAL A REQUEST IS WAITING FOR.
 *
 * ── THE RULE, IN ONE SENTENCE ───────────────────────────────────────────────
 * A request waits for the manager stored on the REQUESTER's HR record
 * (`Employee.primaryManager.managerId`) — resolved once, when the request is
 * raised, and written onto the request. Nobody else may take that step: not a
 * finance approver, not another manager in the same department, not the
 * requester.
 *
 * ── WHY THE STORED APPROVER WINS OVER LIVE HR ───────────────────────────────
 * The three request collections used to answer this two different ways. MRF
 * asked "is this request addressed to me" (stored). Intake and SpendRequest
 * asked "do I manage this person TODAY" (live). They agree right up until HR
 * edits a reporting line, and then they disagree about a request that is
 * already in somebody's queue: the manager who was asked can no longer answer,
 * and a manager who was never asked suddenly can.
 *
 * An approval is a record of who was asked. Re-deriving it at decision time
 * makes that record a function of the org chart's current state, which is not
 * what anybody means by "my manager approved it".
 *
 * ── AND WHY LIVE HR IS STILL THE FALLBACK ───────────────────────────────────
 * Requests raised before approver routing existed carry no approver at all.
 * Refusing those outright would strand them: nobody is named, so nobody could
 * ever act. For those — and ONLY those — the live `primaryManager` link
 * answers, exactly as `coworkMrfRoutes.resolveAccess` already does for legacy
 * MRFs. A request that names an approver never falls back.
 *
 * ── PURE ON PURPOSE ─────────────────────────────────────────────────────────
 * No models, no database, no mongoose. The routers hand it what they already
 * read, so the rule can be unit-tested without a connection and so there is
 * exactly one copy of it for three collections.
 */

"use strict";

/** Every id a stored approver could be signed in as. */
function storedApproverIds(request) {
  return [
    ...new Set(
      [request?.approverBiometricId, ...(request?.approverAltIds || [])]
        .filter(Boolean)
        .map(String),
    ),
  ];
}

/** Does this request name who it is waiting for? */
function hasStoredApprover(request) {
  return storedApproverIds(request).length > 0;
}

/**
 * May this viewer take the TL step on this request?
 *
 * @param {object} request  the stored document — needs `approverBiometricId`,
 *                          `approverAltIds`, `approverName`, `requestedById`
 * @param {object} viewer   `{ employeeId, managedIds }` — the caller's own
 *                          cowork id and the ids of their direct reports
 * @param {string} roleWord what the app calls this person on screen. The two
 *                          desks say "manager" and "TL" about the same human,
 *                          and a refusal in the other one's vocabulary reads
 *                          as a different rule.
 * @returns {{can: boolean, via: "stored"|"legacy_hr"|null, reason: string|null}}
 *
 * `via` names WHICH rule answered, so a caller can log or display the
 * difference between "this was addressed to you" and "you manage this person
 * and nobody was ever named".
 */
function tlEntitlement({ request, viewer, roleWord = "manager" } = {}) {
  const me = String(viewer?.employeeId || "");
  const no = (reason) => ({ can: false, via: null, reason });

  /* Nobody decides their own request, at any step and under either rule. That
     is the whole point of asking somebody else, and it is checked before
     entitlement so a self-managed employee cannot answer their own ask. */
  if (me && request?.requestedById && me === String(request.requestedById)) {
    return no("You cannot approve your own request.");
  }

  const stored = storedApproverIds(request);
  if (stored.length) {
    if (me && stored.includes(me)) return { can: true, via: "stored", reason: null };
    /* Named, and not you. Saying WHO is waiting is the difference between a
       refusal somebody can act on and one they read as a bug. */
    const who = request?.approverName || `the requester's ${roleWord}`;
    return no(`This is waiting for ${who}.`);
  }

  /* Nobody was ever named — the legacy case. Live HR answers, and only for
     the viewer's OWN reports. */
  const managed = (viewer?.managedIds || []).map(String);
  if (request?.requestedById && managed.includes(String(request.requestedById))) {
    return { can: true, via: "legacy_hr", reason: null };
  }
  return no(`This is waiting for the requester's ${roleWord}.`);
}

/**
 * The Mongo clause that selects the TL-step rows this viewer may act on.
 *
 * The same rule as `tlEntitlement`, expressed as a query so a queue never
 * lists a row its owner would then be refused on — a queue that shows work
 * somebody cannot do is worse than one that shows none.
 *
 * @param {object} viewer     `{ employeeId, managedIds }`
 * @param {string[]} statuses the statuses that mean "waiting for the TL"
 * @returns {object|null} a query fragment, or null when this viewer can hold
 *                        no TL-step rows at all
 */
function tlQueueClause({ viewer, statuses } = {}) {
  const me = String(viewer?.employeeId || "");
  const managed = (viewer?.managedIds || []).map(String).filter(Boolean);
  const or = [];

  /* Addressed to me. Guarded on a non-empty id: an empty one would match every
     request whose approver field is an empty string, which is every request
     that names nobody. */
  if (me) {
    or.push({ approverBiometricId: me });
    or.push({ approverAltIds: me });
  }

  /* Legacy: nobody named, and the requester reports to me today. */
  if (managed.length) {
    or.push({
      $and: [
        {
          $or: [
            { approverBiometricId: { $in: ["", null] } },
            { approverBiometricId: { $exists: false } },
          ],
        },
        { requestedById: { $in: managed } },
      ],
    });
  }

  if (!or.length) return null;

  const clause = { status: { $in: statuses }, $or: or };
  /* Never your own, at any step — the same rule the decision enforces, applied
     to the list so a request you cannot action never appears in a queue that
     says it is waiting for you. */
  if (me) clause.requestedById = { $ne: me };
  return clause;
}

module.exports = {
  storedApproverIds,
  hasStoredApprover,
  tlEntitlement,
  tlQueueClause,
};
