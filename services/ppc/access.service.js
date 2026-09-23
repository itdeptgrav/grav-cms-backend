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

const { roleAtLeast } = require("../departmentRoles");
const { roleForCompany } = require("../companyContext/companyAccess.service");
const { listMembershipCompanies } = require("../companyContext/companyMembership.service");
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

  /* ── PLANNING ────────────────────────────────────────────────────────────
   * Three rungs, because the Order Book draws three genuinely different
   * distinctions and collapsing any two of them would hand somebody authority
   * nobody meant to give.
   *
   * READ is a viewer's: seeing which lines are entering planning, what inputs
   * exist and who owns each line is what a PPC member is in the application to
   * do, and a register somebody cannot open is a register nobody maintains.
   *
   * WRITE is an editor's — a PLANNER's. Creating a planning file and recording
   * PPC's intentions on it is the daily work of the department, and requiring
   * an approver for it would mean either that approvers do the typing or that
   * everybody is an approver.
   *
   * APPROVE is deliberately narrower than "write", and it guards exactly three
   * acts: marking a line PLANNED, placing or lifting a hold, and creating a
   * successor. Each of those is a statement OTHER departments read and act on —
   * "PPC has finished planning this", "PPC is waiting on you", "the plan you
   * were told about has been replaced" — and none of them should be reachable
   * by whoever happened to be editing the notes.
   *
   * There is no configuration capability yet because there is no configuration:
   * `owner` sits above approver on the shared ladder and will carry it when a
   * later chunk introduces something to configure. Minting the capability now
   * would be minting a permission with nothing behind it.
   */
  PLANNING_READ: "ppc.planning.read",
  PLANNING_WRITE: "ppc.planning.write",
  PLANNING_APPROVE: "ppc.planning.approve",

  /* ── CAPACITY ────────────────────────────────────────────────────────────
   * READ is a viewer's — calendars, lines, previews and bookings are what a
   * PPC member plans from, and a preview writes nothing.
   *
   * BOOK is an approver's: taking a line's time commits it, and every other
   * plan competing for that line reads the result.
   *
   * CONFIGURE is an OWNER's, and it is the configuration this ladder reserved
   * `owner` for. Calendars and line headcounts decide the hours every booking
   * is measured against; somebody who could change them could make any booking
   * fit, so the person who books is not, by that fact, the person who sets them.
   */
  CAPACITY_READ: "ppc.capacity.read",
  CAPACITY_BOOK: "ppc.capacity.book",
  CAPACITY_CONFIGURE: "ppc.capacity.configure",
});

const MINIMUM_ROLE = Object.freeze({
  [CAPABILITY.INBOUND_READ]: ROLE.VIEWER,
  [CAPABILITY.INBOUND_DECIDE]: ROLE.APPROVER,
  [CAPABILITY.PLANNING_READ]: ROLE.VIEWER,
  [CAPABILITY.PLANNING_WRITE]: ROLE.EDITOR,
  [CAPABILITY.PLANNING_APPROVE]: ROLE.APPROVER,
  [CAPABILITY.CAPACITY_READ]: ROLE.VIEWER,
  [CAPABILITY.CAPACITY_BOOK]: ROLE.APPROVER,
  [CAPABILITY.CAPACITY_CONFIGURE]: ROLE.OWNER,
});

/** What a refusal says, per capability. One sentence a planner can act on. */
const REFUSAL_WORDS = Object.freeze({
  [CAPABILITY.CAPACITY_READ]: "PPC capacity planning is PPC's.",
  [CAPABILITY.CAPACITY_BOOK]:
    "Booking or releasing a line's capacity commits it, and it needs a PPC approver role.",
  [CAPABILITY.CAPACITY_CONFIGURE]:
    "Capacity calendars and lines decide the hours every booking is measured against, and they are a PPC owner's to set.",
  [CAPABILITY.INBOUND_READ]: "The PPC inbound queue is PPC's.",
  [CAPABILITY.INBOUND_DECIDE]:
    "Deciding on a handed-down execution pack is PPC's decision, and it needs a PPC role that allows it.",
  [CAPABILITY.PLANNING_READ]: "The PPC order book is PPC's.",
  [CAPABILITY.PLANNING_WRITE]:
    "Creating and editing a planning file is a planner's work, and it needs a PPC role that allows it.",
  [CAPABILITY.PLANNING_APPROVE]:
    "Marking a line planned, holding it, or replacing its plan is a statement other departments act on, "
    + "and it needs a PPC role that allows it.",
});

/** The live grant, read on every request. Never a token claim. */
async function livePpcRole(req) {
  const email = req.user?.email;
  const actorId = req.user?.id;
  const companyId = req.merchandising?.companyId;
  if (companyId) return roleForCompany({ companyId, email, actorId });

  // The company picker is reached before one company has been selected. It
  // must be open only if at least one *effective* PPC company grant exists.
  return bestPpcRoleForUser(req.user);
}

async function bestPpcRoleForUser(user) {
  const { companies } = await listMembershipCompanies(user);
  let best = null;
  for (const company of companies) {
    const role = await roleForCompany({ companyId: company.companyId, email: user.email, actorId: user.id });
    if (role && (!best || roleAtLeast(role, best))) best = role;
  }
  return best;
}

async function authorizedPpcCompanies(user) {
  const { companies } = await listMembershipCompanies(user);
  const allowed = [];
  for (const company of companies) {
    if (await roleForCompany({ companyId: company.companyId, email: user.email, actorId: user.id })) {
      allowed.push(company);
    }
  }
  return allowed;
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
      REFUSAL_WORDS[capability] || "That is PPC's, and it needs a PPC role that allows it.",
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
  DEPARTMENT, ROLE, CAPABILITY, MINIMUM_ROLE, REFUSAL_WORDS,
  livePpcRole, bestPpcRoleForUser, authorizedPpcCompanies, requirePpcCapability, ppcCapability,
};
