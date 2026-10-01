// services/ceoIsAccountingOwner.service.js
//
// The CEO is an Owner in the accounting module, wherever they are.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Accounting keeps its own roles in `acc_users` (owner / approver / editor /
// viewer), assigned by whoever set the module up. That list is not the company
// hierarchy, and on this database it had drifted from it: `ceo@grav.in` sat at
// `approver`, which grants canEdit / canPostDirectly / canApprove but NOT
// canManageTeam or canManageSettings.
//
// So the CEO could post a voucher and approve it, and then be refused by the
// settings and team screens — "recognised as owner in some places and not
// others", which is exactly how it was reported. Nothing announced the
// difference; the controls were simply absent.
//
// Editing the one row would fix today and not tomorrow: a new CEO account, or
// a second company, lands back where this started. The rule is what wants
// writing down — the CEO holds the top accounting role by virtue of being the
// CEO — so it is resolved per request, from the CEO department itself.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It does not WRITE anything. `acc_users.role` is left exactly as it is, so a
// deliberate assignment is never overwritten and nothing has to be migrated.
// The elevation is in the session, which is where "what may this request do"
// is decided anyway.

"use strict";

/* One lookup per email per five minutes. The CEO roster changes about once a
   company, and an accounting page can easily make a dozen requests. */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // email -> { isCeo, at }

/** Forget a cached answer — call after changing who the CEO is. */
function invalidateCeoIdentity(email) {
  if (email) cache.delete(String(email).trim().toLowerCase());
}

/**
 * Is this email the CEO's?
 *
 * Fails CLOSED (false) when the lookup itself fails: an elevation that happens
 * because the database was briefly unreachable is worse than a CEO seeing the
 * role they were actually assigned until it comes back. Not cached on failure,
 * so the next request tries again.
 *
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isCeoEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return false;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.isCeo;

  try {
    const CEODepartment = require("../models/CEODepartment");
    const found = await CEODepartment.findOne({
      email: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })
      .select("_id isActive")
      .lean();

    // An inactive CEO row is not a CEO. The employment lock elsewhere says the
    // same thing about employees; this is the department-account twin of it.
    const isCeo = Boolean(found) && found.isActive !== false;
    cache.set(key, { isCeo, at: Date.now() });
    return isCeo;
  } catch (err) {
    console.warn("[ceo-owner] CEO lookup failed:", err.message);
    return false;
  }
}

module.exports = { isCeoEmail, invalidateCeoIdentity };
