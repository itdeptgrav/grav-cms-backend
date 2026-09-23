"use strict";
/**
 * services/access/hrAccess.js — "may this account reach HR data at all?"
 *
 * NOW A THIN VIEW OVER THE ONE CONTRACT.
 * --------------------------------------
 * This file used to hold its own copy of the answer: a set of HR department
 * slugs, a set of board slugs, and a map of token roles. That was correct as
 * far as it went, but it was a SECOND opinion — the routes had their own, the
 * write guard had a third, and the three could disagree about the same person.
 *
 * It now delegates to services/access/hrAuthorization.js, so the central GRAV
 * assistant's HR tools and the mounted HR routes reach the same verdict from
 * the same records. What survives is the SHAPE — `{ allowed, via }` — because
 * that is what the assistant and its tests consume, and because "which route
 * did authority arrive by" is genuinely useful in a log line.
 *
 * The important properties are unchanged and are now enforced in one place:
 *   • an HR grant counts even when the person is currently in another app;
 *   • a platform administrator is re-read from the database, never trusted
 *     from the token's own `isAdmin` claim;
 *   • the CEO and HR administrator authenticate against their own department
 *     collections and have no Employee row, so their signed role claim proves
 *     APPLICATION ACCESS — and nothing more;
 *   • an ordinary authenticated employee is refused.
 */

const { resolveHrActor } = require("./hrAuthorization");

/** Department slugs that confer HR-tool access. Kept for existing importers. */
const HR_DEPT_SLUGS = new Set(["hr"]);
const BOARD_DEPT_SLUGS = new Set(["ceo"]); // Chief Executive / board-level

/** Which of the three doors authority came through, in the old vocabulary. */
function viaFor(actor) {
  if (!actor || !actor.hasHrApplicationAccess) return null;
  if (actor.template === "platform_admin") return "admin";
  if (actor.template === "ceo_projection") return "ceo";
  return "hr";
}

/**
 * @param {object} user  the verified req.user ({ id, email, employeeId, role })
 * @returns {Promise<{ allowed: boolean, via: 'admin'|'ceo'|'hr'|null }>}
 */
async function resolveHrAccess(user) {
  if (!user) return { allowed: false, via: null };
  const actor = await resolveHrActor(user);
  const via = viaFor(actor);
  return { allowed: Boolean(via), via };
}

module.exports = { resolveHrAccess, resolveHrActor, HR_DEPT_SLUGS, BOARD_DEPT_SLUGS };
