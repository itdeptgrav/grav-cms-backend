// services/merchandising/access.service.js
//
// WHO MAY READ AND WHO MAY CHANGE MERCHANDISING'S OWN FACTS.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
// Merchandising's style and BOM endpoints live on the sample-style router,
// behind `salesAuth`. That gate proves a Sales CRM seat — and a Sales seat is
// exactly what it says: authority over customers, enquiries, quotations and the
// journey. It is not authority to approve a packaging component or state what
// development work a style needs, and until now it was being accepted as
// though it were. A salesperson, a CEO login, anybody the Sales allowlist
// admits, could approve a Merchandising selection.
//
// Nor is the JWT's `role` text an answer. It is minted at sign-in and lives for
// seven days; a grant withdrawn five minutes ago still reads the same inside
// it. So nothing here looks at the token beyond identifying the person.
//
// ── WHAT IS ACTUALLY CHECKED, EVERY REQUEST ─────────────────────────────────
// The LIVE `merchandiser` department grant, re-read from the database through
// `services/departmentRoles.js` — the one access system this deployment
// already has. `getRole` returns null for a row whose `isActive` is false, so a
// revoked or disabled grant fails on the very next request rather than when a
// token happens to expire.
//
// This is deliberately NOT a second permission store, and deliberately not the
// capability framework the final plan describes for later chunks. It is the
// existing viewer/editor/approver/owner ladder, applied where it was missing.
//
// ── THE TRANSITIONAL LADDER ─────────────────────────────────────────────────
//   viewer    read Merchandising's own facts
//   editor    make a Merchandising selection or state a requirement
//   approver  decide one — approve or withdraw
//   owner     department administration, where a route explicitly offers it
//
// ── AND `isAdmin` IS NOT A RUNG ON IT ───────────────────────────────────────
// It was. A platform administrator was admitted as `owner` everywhere, on the
// reasoning that this is what every other department shell does and that it is
// how Merchandising opens before its first grant is made.
//
// Both of those are true and neither survives the live-grant model. `isAdmin`
// is a claim carried in the token AND a flag on the account — so the one
// authority that could approve a Merchandising selection, withdraw a component
// and state a development requirement was the one authority nobody had granted
// for Merchandising, that no administrator could see in Access Control, and
// that no revocation of a Merchandising grant could take away. A bypass that
// leaves no trace and cannot be withdrawn is not an exception to the model; it
// is a hole through it.
//
// So every actor needs an explicit, active `merchandiser` grant — a platform
// administrator included. Granting one to themselves takes a moment in Access
// Control, is visible to everybody who looks, and can be removed. That is the
// whole difference.
//
// This is NOT a support-mode bypass by another name, and none is added here:
// audited support access needs an audit trail to be audited BY, and there is
// none yet. When there is, it can be designed against it.
//
// Nothing outside Merchandising changes. `requirePlatformAdmin`, the CEO
// console, Access Control itself and every other department's own admin
// allowance are untouched — what is refused here is `isAdmin` standing in for
// a Merchandising role, and only here.
//
// ── AND BEING NAMED ON A STYLE IS NOT AUTHORITY ─────────────────────────────
// Nothing here reads an assignment, an owner field, a `selectedBy` or a
// `submittedBy`. Whoever a record happens to name has whatever grant they hold
// and nothing more — which is the rule that stops "I made this row" from
// becoming "so I may approve it".
"use strict";

const { getEffectiveRole, roleAtLeast } = require("../departmentRoles");
const { fail, sendError } = require("../storePurchase/errors");

/** Merchandising's own department slug — the one its shell and nav already use. */
const DEPARTMENT = "merchandiser";

/** The ladder, weakest first. Exported so a route names a level, not a string. */
const ROLE = Object.freeze({
  VIEWER: "viewer",
  EDITOR: "editor",
  APPROVER: "approver",
  OWNER: "owner",
});

/* ═══ THE CANONICAL CAPABILITY VOCABULARY ═══════════════════════════════════
 *
 * Capabilities are what routes ASK FOR; the viewer/editor/approver/owner
 * ladder is where they COME FROM. There is deliberately no second grant
 * store: the live `merchandiser` DepartmentRole is still the only source of
 * authority, resolved fresh on every request, and each role simply carries a
 * fixed set of capabilities. When later milestones need per-capability
 * grants, the vocabulary is already the one routes speak — only the mapping
 * behind it changes.
 *
 * A name existing here does NOT mean an endpoint exists. Several of these
 * (t&a, export, configuration) are reserved for later milestones and gate
 * nothing yet; implementing an endpoint because its capability has a name
 * would be scope arriving through the back door.
 */
const CAPABILITY = Object.freeze({
  FILE_READ: "merchandising.file.read",
  FILE_MANAGE: "merchandising.file.manage",
  FILE_ASSIGN: "merchandising.file.assign",
  FILE_LIFECYCLE: "merchandising.file.lifecycle",
  BRIEF_REVIEW: "merchandising.brief.review",
  SELECTION_WRITE: "merchandising.selection.write",
  SELECTION_APPROVE: "merchandising.selection.approve",
  REQUIREMENT_WRITE: "merchandising.requirement.write",
  TNA_MANAGE: "merchandising.tna.manage",
  TNA_EXECUTE: "merchandising.tna.execute",
  HANDOVER_SUBMIT: "merchandising.handover.submit",
  CHANGE_COORDINATE: "merchandising.change.coordinate",
  CONFIGURATION_MANAGE: "merchandising.configuration.manage",
  EXPORT: "merchandising.export",
});

/** What each rung of the ladder may do. Cumulative, weakest first. */
const ROLE_CAPABILITIES = (() => {
  const viewer = [CAPABILITY.FILE_READ];
  const editor = [...viewer,
    CAPABILITY.FILE_MANAGE, CAPABILITY.SELECTION_WRITE, CAPABILITY.REQUIREMENT_WRITE,
    CAPABILITY.TNA_EXECUTE, CAPABILITY.CHANGE_COORDINATE,
  ];
  const approver = [...editor,
    CAPABILITY.BRIEF_REVIEW, CAPABILITY.SELECTION_APPROVE, CAPABILITY.TNA_MANAGE,
    CAPABILITY.FILE_LIFECYCLE, CAPABILITY.HANDOVER_SUBMIT,
  ];
  const owner = [...approver,
    CAPABILITY.FILE_ASSIGN, CAPABILITY.CONFIGURATION_MANAGE, CAPABILITY.EXPORT,
  ];
  return Object.freeze({
    [ROLE.VIEWER]: new Set(viewer),
    [ROLE.EDITOR]: new Set(editor),
    [ROLE.APPROVER]: new Set(approver),
    [ROLE.OWNER]: new Set(owner),
  });
})();

/** The weakest role holding a capability — what a refusal names as required. */
function minimumRoleFor(capability) {
  for (const role of [ROLE.VIEWER, ROLE.EDITOR, ROLE.APPROVER, ROLE.OWNER]) {
    if (ROLE_CAPABILITIES[role].has(capability)) return role;
  }
  return ROLE.OWNER;
}

/**
 * The Merchandising role this actor holds RIGHT NOW, or null.
 *
 * Re-read per request and never cached on the request: a caller that asks
 * twice in one request is asking twice about a fact that could have changed,
 * and the cheap lookup is the honest answer.
 *
 * `getEffectiveRole` reads `DepartmentRole` and returns null for a row whose
 * `isActive` is false, so a revoked or disabled grant fails on the very next
 * request. Nothing in the token is consulted beyond the addresses that
 * identify the person — a `role`, an `isAdmin` or any other claim inside it
 * decides nothing, because a claim minted at sign-in cannot know what an
 * administrator did afterwards.
 */
async function liveMerchandisingRole(req) {
  return (await getEffectiveRole(DEPARTMENT, req)) || null;
}

/**
 * Refuse unless this actor holds `minimumRole` in Merchandising, live.
 *
 * @returns {Promise<string>} the role they actually hold, for a route that
 *   wants to report it back to a screen.
 * @throws  a `FORBIDDEN` that names the department and the level required, and
 *   nothing about the record being reached for — a refusal must not become a
 *   way to ask whether something exists.
 */
async function requireMerchandising(req, minimumRole = ROLE.VIEWER) {
  const role = await liveMerchandisingRole(req);
  if (!role || !roleAtLeast(role, minimumRole)) {
    throw fail(
      "FORBIDDEN",
      minimumRole === ROLE.VIEWER
        ? "Merchandising work is the merchandising team's."
        : "That is a Merchandising decision, and it needs a Merchandising role that allows it.",
      { requires: { department: DEPARTMENT, minimumRole } },
    );
  }
  return role;
}

/**
 * The same rule as Express middleware, for a router that gates whole routes
 * rather than branching inside a handler.
 *
 * ── ONE IMPLEMENTATION, NOT TWO ─────────────────────────────────────────────
 * `merchandisingWorkRoute.js` had its own copy of this — its own grant read,
 * its own ladder comparison, its own refusal shape and its own admin bypass.
 * Two implementations of one policy is two places to fix a hole and one place
 * to forget, and the copy is precisely where the `isAdmin` bypass outlived its
 * removal everywhere else. There is one now, and a route that wants the rule
 * asks for it rather than rebuilding it.
 *
 * The resolved role is left on `req.merchandisingRole` for a handler that
 * wants to report it; nothing reads it to decide anything.
 */
const merchandisingRoleAtLeast = (minimumRole = ROLE.VIEWER) => async (req, res, next) => {
  try {
    req.merchandisingRole = await requireMerchandising(req, minimumRole);
    next();
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * Refuse unless this actor's LIVE role carries `capability`.
 *
 * The refusal names the capability AND the weakest role that holds it, so a
 * screen built on either vocabulary can say what is missing — and so every
 * allow/deny outcome of the role-based era is preserved exactly: a capability
 * check is the same live-grant read followed by the same ladder comparison,
 * spelled in the words later milestones will keep using.
 */
async function requireMerchandisingCapability(req, capability) {
  const role = await liveMerchandisingRole(req);
  const allowed = role && ROLE_CAPABILITIES[role]?.has(capability);
  if (!allowed) {
    const minimumRole = minimumRoleFor(capability);
    throw fail(
      "FORBIDDEN",
      minimumRole === ROLE.VIEWER
        ? "Merchandising work is the merchandising team's."
        : "That is a Merchandising decision, and it needs a Merchandising role that allows it.",
      { requires: { department: DEPARTMENT, capability, minimumRole } },
    );
  }
  return role;
}

/** The same rule as Express middleware. */
const merchandisingCapability = (capability) => async (req, res, next) => {
  try {
    req.merchandisingRole = await requireMerchandisingCapability(req, capability);
    next();
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * Which level a packaging-selection change needs.
 *
 * ── APPROVING IS NOT EDITING ────────────────────────────────────────────────
 * Restating a packing instruction is an edit; approving a component or
 * withdrawing one is a DECISION, and the two are different authorities even
 * though they arrive through the same door. A body that does both needs the
 * higher of the two — otherwise an editor could smuggle an approval through by
 * attaching a specification to it.
 *
 * `proposed` is the state a selection is created in, so returning a row to it
 * is a correction rather than a decision, and stays with the editor.
 */
function packagingChangeLevel(body = {}) {
  const status = String(body?.status ?? "").trim();
  return (status === "approved" || status === "withdrawn") ? ROLE.APPROVER : ROLE.EDITOR;
}

/** The capability a packaging-selection change needs — same rule, new words. */
function packagingChangeCapability(body = {}) {
  return packagingChangeLevel(body) === ROLE.APPROVER
    ? CAPABILITY.SELECTION_APPROVE
    : CAPABILITY.SELECTION_WRITE;
}

module.exports = {
  DEPARTMENT, ROLE, CAPABILITY, ROLE_CAPABILITIES, minimumRoleFor,
  liveMerchandisingRole, requireMerchandising, merchandisingRoleAtLeast,
  requireMerchandisingCapability, merchandisingCapability,
  packagingChangeLevel, packagingChangeCapability,
};
