// services/rnd/access.service.js
//
// WHO MAY READ AND WHO MAY CHANGE R&D'S OWN FACTS.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
// The technical record was reached through the sample-style router, behind
// `salesAuth` widened to admit an R&D job title. That gate proves a Sales CRM
// seat and reads a job title minted into a token at sign-in; neither is a
// grant, and neither can be withdrawn. So anybody the Sales allowlist admits
// could state what a garment consumes, and a grant revoked five minutes ago
// still read the same inside a seven-day token.
//
// What is checked here instead is the LIVE `research-development` department
// grant, re-read from the database on every request through
// `services/departmentRoles.js` — the one access system this deployment has.
// `getEffectiveRole` returns null for a row whose `isActive` is false, so a
// revoked grant fails on the very next request.
//
// ── THE LADDER, AND WHY R&D'S TOP RUNG IS NOT AN APPROVAL ───────────────────
//   viewer    read the technical record and its history
//   editor    state consumption, specification, allowance and evidence
//   approver  submit a revision to Sales, and send a material back
//   owner     department administration, where a route offers it
//
// There is deliberately no capability here that APPROVES a technical revision.
// R&D produces the record; Sales decides on it. A rung that let R&D approve
// its own submission would make the maker and the checker one desk, which is
// the whole thing the frozen revision exists to prevent.
//
// ── AND `isAdmin` IS NOT A RUNG ON IT ───────────────────────────────────────
// Same rule as Merchandising, for the same reason: a claim carried in a token
// and a flag on an account is authority nobody granted, that no administrator
// can see in Access Control, and that no revocation can take away. A platform
// administrator needs an explicit, active `research-development` grant like
// everybody else — granting one takes a moment and leaves a trace.
"use strict";

const { getEffectiveRole, roleAtLeast } = require("../departmentRoles");
const { fail, sendError } = require("../storePurchase/errors");

/** R&D's own department slug — the one its shell, nav and notifications use. */
const DEPARTMENT = "research-development";

/** The ladder, weakest first. Exported so a route names a level, not a string. */
const ROLE = Object.freeze({
  VIEWER: "viewer",
  EDITOR: "editor",
  APPROVER: "approver",
  OWNER: "owner",
});

/**
 * What routes ASK FOR. The ladder is where the answers COME FROM: there is no
 * second grant store, and a name existing here does not mean an endpoint does.
 */
const CAPABILITY = Object.freeze({
  TECHNICAL_READ: "rnd.technical.read",
  TECHNICAL_WRITE: "rnd.technical.write",
  /* Starting the technical work, and submitting a revision to Sales. Both are
     statements to another department that R&D is ready, which is why they sit
     above ordinary editing. */
  TECHNICAL_SUBMIT: "rnd.technical.submit",
  /* Sending a selected material back to Merchandising. A correction with an
     author, addressed to another department. */
  MATERIAL_RETURN: "rnd.material.return",

  /* ── THE 3D GARMENT WORKSPACE ──────────────────────────────────────────
     A published model is R&D's surface: R&D builds the garment, publishes it
     and marks construction on it. The ladder here is NOT the technical
     record's, and the difference is deliberate — publishing a draft and
     sending it for review is ordinary R&D work an editor does all day, while
     ACCEPTING a model is the decision that makes it the thing IE and Costing
     will read, and that stays with an approver.

     There is no capability that edits somebody else's department's reading of
     the model, and none that lets IE write here. IE consumes an approved
     publication and keeps its operation mapping in its own records. */
  MODEL_READ: "rnd.model.read",
  MODEL_ANNOTATE: "rnd.model.annotate",
  MODEL_PUBLISH: "rnd.model.publish",
  MODEL_SUBMIT: "rnd.model.submit",
  MODEL_APPROVE: "rnd.model.approve",
  /* ── TAKING THE GARMENT AWAY IS ITS OWN PERMISSION ────────────────────
     Reading the workspace and downloading the CLO project are different
     acts. The `.zprj` is the garment: whoever holds it can reproduce the
     style anywhere, with no record that they did. So it is not folded into
     "can see the model" — it is granted on its own, to the rung that answers
     for the style. */
  MODEL_SOURCE_DOWNLOAD: "rnd.model.source.download",
});

/** What each rung may do. Cumulative, weakest first. */
const ROLE_CAPABILITIES = (() => {
  const viewer = [CAPABILITY.TECHNICAL_READ, CAPABILITY.MODEL_READ];
  const editor = [...viewer,
    CAPABILITY.TECHNICAL_WRITE,
    CAPABILITY.MODEL_ANNOTATE, CAPABILITY.MODEL_PUBLISH, CAPABILITY.MODEL_SUBMIT,
  ];
  const approver = [...editor,
    CAPABILITY.TECHNICAL_SUBMIT, CAPABILITY.MATERIAL_RETURN,
    CAPABILITY.MODEL_APPROVE, CAPABILITY.MODEL_SOURCE_DOWNLOAD,
  ];
  const owner = [...approver];
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
 * The R&D role this actor holds RIGHT NOW, or null.
 *
 * Re-read per request and never cached on the request: a caller that asks
 * twice is asking twice about a fact that could have changed.
 */
async function liveRndRole(req) {
  return (await getEffectiveRole(DEPARTMENT, req)) || null;
}

/**
 * Refuse unless this actor's live grant carries `capability`.
 *
 * The refusal names the capability and the weakest role that holds it, and
 * nothing about the record being reached for — a refusal must not become a way
 * to ask whether something exists.
 */
async function requireRndCapability(req, capability) {
  const role = await liveRndRole(req);
  if (!role || !ROLE_CAPABILITIES[role]?.has(capability)) {
    const minimumRole = minimumRoleFor(capability);
    throw fail(
      "FORBIDDEN",
      minimumRole === ROLE.VIEWER
        ? "Technical records are the R&D team's."
        : "That is an R&D decision, and it needs an R&D role that allows it.",
      { requires: { department: DEPARTMENT, capability, minimumRole } },
    );
  }
  return role;
}

/** The same rule as Express middleware. */
const rndCapability = (capability) => async (req, res, next) => {
  try {
    req.rndRole = await requireRndCapability(req, capability);
    next();
  } catch (err) {
    sendError(res, err);
  }
};

/** The same rule as a level on the ladder, for a handler that branches. */
async function requireRnd(req, minimumRole = ROLE.VIEWER) {
  const role = await liveRndRole(req);
  if (!role || !roleAtLeast(role, minimumRole)) {
    throw fail("FORBIDDEN", "Technical records are the R&D team's.",
      { requires: { department: DEPARTMENT, minimumRole } });
  }
  return role;
}

module.exports = {
  DEPARTMENT, ROLE, CAPABILITY, ROLE_CAPABILITIES,
  minimumRoleFor, liveRndRole, requireRndCapability, rndCapability, requireRnd,
};
