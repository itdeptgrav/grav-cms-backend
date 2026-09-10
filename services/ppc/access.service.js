// services/ppc/access.service.js
//
// PPC'S OWN AUTHORITY, READ LIVE, AND SEPARATE FROM MERCHANDISING'S.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
// M6 needs somebody in PPC to accept or query a handed-down execution pack.
// The obvious shortcut is to let a Merchandising approver do it — the pack is
// a Merchandising record, the route is next door, and the plumbing already
// works. That shortcut would destroy the entire point of the milestone: the
// exit condition is that Merchandising hands off *while every downstream owner
// retains its authority*, and a Merchandising role that can accept on PPC's
// behalf means PPC has no authority at all, only a screen.
//
// So the receiving decision is gated on a LIVE PPC department grant, read the
// same way every other department's is — `getEffectiveRole` against
// `DepartmentRole`, on every request. A Merchandising grant of any level opens
// nothing here.
//
// ── WHAT IS HONESTLY MISSING ────────────────────────────────────────────────
// There is no PPC application in this repository yet: no `routes/CMS_Routes/PPC`
// before M6, no PPC dashboard, no PPC seat management screen. What exists is
// the shared department-role mechanism every other department already uses, so
// a `ppc` grant is a row somebody with access administration can create today,
// exactly like `merchandiser` or `qc`.
//
// This file therefore introduces the SMALLEST possible PPC surface: one
// department slug, one ladder, one capability, and the receipt route that
// needs it. It deliberately does not invent PPC planning, capacity, line
// allocation or release — those are PPC's application to build, and M6's job
// is only to make sure that when it is built, the decision was already theirs.
//
// ── AND `isAdmin` GRANTS NOTHING ────────────────────────────────────────────
// The same rule Merchandising's access service settled: a platform
// administrator is not a rung on this ladder, because wherever `isAdmin` is a
// bypass it is the bypass that outlives every tightening made around it.
// Neither does a CEO claim, a JWT role string, or being the file's responsible
// merchandiser.
"use strict";

const { getEffectiveRole, roleAtLeast } = require("../departmentRoles");
const { fail, sendError } = require("../storePurchase/errors");

/** The department slug a PPC grant is written against. */
const DEPARTMENT = "ppc";

const ROLE = Object.freeze({
  VIEWER: "viewer",
  EDITOR: "editor",
  APPROVER: "approver",
  OWNER: "owner",
});

/**
 * PPC's capabilities. Two, because M6 needs two.
 *
 * Reading the inbound queue is a viewer's; DECIDING on a pack is an
 * approver's. The split is the same one Merchandising draws between seeing a
 * handover and accepting it, and for the same reason — being able to look at
 * what has arrived is not the same as being able to commit the department to
 * it.
 */
const CAPABILITY = Object.freeze({
  INBOUND_READ: "ppc.inbound.read",
  INBOUND_DECIDE: "ppc.inbound.decide",
});

const MINIMUM_ROLE = Object.freeze({
  [CAPABILITY.INBOUND_READ]: ROLE.VIEWER,
  [CAPABILITY.INBOUND_DECIDE]: ROLE.APPROVER,
});

/** The live grant, read on every request. Never a token claim. */
async function livePpcRole(req) {
  const role = await getEffectiveRole(DEPARTMENT, req);
  return role || null;
}

async function requirePpcCapability(req, capability) {
  const minimumRole = MINIMUM_ROLE[capability];
  if (!minimumRole) {
    throw fail("FORBIDDEN", "That is not a PPC capability.", { capability });
  }
  const role = await livePpcRole(req);
  if (!role || !roleAtLeast(role, minimumRole)) {
    throw fail(
      "FORBIDDEN",
      minimumRole === ROLE.VIEWER
        ? "The PPC inbound queue is PPC's."
        : "Deciding on a handed-down execution pack is PPC's decision, and it needs a PPC role that allows it.",
      { requires: { department: DEPARTMENT, capability, minimumRole } },
    );
  }
  return role;
}

/** The same rule as Express middleware. */
const ppcCapability = (capability) => async (req, res, next) => {
  try {
    req.ppcRole = await requirePpcCapability(req, capability);
    next();
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = {
  DEPARTMENT, ROLE, CAPABILITY, MINIMUM_ROLE,
  livePpcRole, requirePpcCapability, ppcCapability,
};
