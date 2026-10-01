// services/integration/tnaSourceDelivery.service.js
//
// CARRYING MERCHANDISING'S OWN APPROVAL EVENTS TO ITS TIME & ACTION PLANS.
//
// The sibling of `salesHandoverDelivery.service.js`, and the same mechanism
// for the same reason — but a shorter hop: producer and receiver are both
// Merchandising, which is exactly why the boundary needs stating rather than
// assuming.
//
// ── WHY A CARRIER AT ALL, WHEN BOTH SIDES ARE ONE APP ───────────────────────
// It would be one line to have `selection.approve` call into the T&A service
// directly. That line is the mistake this file exists to avoid. It would mean
// approving a trim card can FAIL because a schedule is malformed — an
// approval nobody could grant on a Tuesday because a template has a cycle in
// it — and it would put a T&A import inside the selection service, so the
// standing constraint that T&A does not reach into M4 would hold in one
// direction only.
//
// The outbox already exists, the approval already writes to it in its own
// transaction, and the completion is a CONSEQUENCE of the approval rather
// than part of it. So: approve, commit, then carry.
//
// ── WHEN THIS RUNS ──────────────────────────────────────────────────────────
// Called by the selection route immediately after an approval commits, and
// callable again by an operator or a later sweep. No timer, no daemon, no
// queue server. The intake ledger is what makes running it twice harmless,
// and running it late merely late.
//
// ── AND WHAT A FAILURE MEANS ────────────────────────────────────────────────
// Never throws. A merchandiser who has just approved a packaging spec must not
// be told the approval failed because a milestone could not be closed — the
// approval IS the fact; the milestone is bookkeeping about it. The event
// stays unconsumed, the summary says so, and the next call picks it up.
"use strict";

const receiver = require("../merchandising/tnaIntake.service");

const str = (v) => String(v ?? "").trim();

/**
 * Carry whatever Time & Action has not yet consumed.
 *
 * @param {{companyId?:any, limit?:number}} scope
 * @returns {Promise<{considered:number, applied:number, duplicates:number,
 *                    noops:number, failures:Array}>}
 */
async function deliverPending({ companyId, limit = 200 } = {}) {
  try {
    return await receiver.drain({ companyId, limit });
  } catch (err) {
    /* The sweep itself could not run — the database is unreachable, say.
       Reported, never thrown: see the header. */
    return {
      considered: 0,
      applied: 0,
      duplicates: 0,
      noops: 0,
      failures: [{ sourceEventId: null, message: str(err?.message) || "The sweep could not run." }],
    };
  }
}

module.exports = { deliverPending };
