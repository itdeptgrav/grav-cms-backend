// services/centralCosting/capabilities.js
//
// Central Costing — Chunk 1. WHAT A PERSON MAY SEE AND DO IN COSTING, BY NAME.
//
// ── WHY COSTING NEEDS ITS OWN NAMES ─────────────────────────────────────────
// Costing exposes three separable secrets, and every existing check in this
// repository collapses at least two of them:
//
//   · `services/crmCostVisibility.js` answers "may you see cost" from a JWT
//     role literal (`admin`/`ceo`), and derives the floor price for everyone
//     else. It cannot express "may see cost, may not see margin".
//   · `services/salesAccess.js` answers "is this a Sales manager", which is
//     a seniority question, not a confidentiality one.
//   · Store's `sp.*` capabilities answer questions about stock and purchase
//     documents. Store owning supplier prices does not make Store the owner
//     of the company's costing.
//
// So costing gets six names, and each one is one decision:
//
//   costing.output.read    the approved commercial number Sales may quote
//   costing.cost.read      the internal build-up: supplier prices, rates
//   costing.draft.write    create and revise draft costing versions
//   costing.approve        approve a version (behaviour lands in a later chunk)
//   costing.margin.read    margin and margin-sensitive output
//   costing.policy.manage  company costing policy (a later chunk)
//
// Holding one grants nothing about the others. In particular OUTPUT does not
// imply COST and COST does not imply MARGIN — that separation is the whole
// reason this file is not a role test.
//
// ── THE MAPPING IS DELIBERATELY EMPTY WHERE THE BUSINESS HAS NOT DECIDED ────
// Chunk 1's instruction is explicit: where an existing role cannot be mapped
// without a business decision, grant NOTHING and record the open decision.
// Store, Merchandising, R&D, Project Management and the accountant module all
// have a plausible claim on some part of costing, and every one of those
// claims is a decision somebody has to make. They are listed as unresolved in
// docs/decisions/central-costing-company-context-and-visibility.md, and until
// they are made those grants resolve to no capabilities at all.
//
// Built on the department-grant vocabulary that already exists
// (models/Access/DepartmentRole.js: viewer < editor < approver < owner) and
// resolved the way services/storePurchase/capabilities.js already resolves it,
// so there is no second login, token role or browser-owned permission map.
"use strict";

const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");

/** Every capability this domain knows. Frozen so a typo is a crash, not a
 *  silently-never-granted permission. */
const CAPABILITIES = Object.freeze({
  OUTPUT_READ: "costing.output.read",
  COST_READ: "costing.cost.read",
  DRAFT_WRITE: "costing.draft.write",
  APPROVE: "costing.approve",
  MARGIN_READ: "costing.margin.read",
  POLICY_MANAGE: "costing.policy.manage",
  /* ── ASKING FOR AN ESTIMATE IS NOT BUILDING ONE ──────────────────────
     May ask Central Costing to assemble the departmental inputs and prepare
     or refresh an estimate for an enquiry this actor may already reach.

     It exists because the alternative was `costing.draft.write`, and that is
     a different authority: it carries `cost.read`, it opens the whole
     internal build-up, and it belongs to the people who maintain costings
     rather than to the people who ask for one. Sales pressing "Prepare
     estimate" is a request; whether it produces a version at all is decided
     by the resolved sources and the fingerprint, not by the person.

     It implies NOTHING. Not cost, not margin, not draft write, not approval,
     not policy. Holding it lets somebody start a calculation whose result
     they may then be shown almost none of — which is exactly right, and is
     why it could not be expressed by reusing an existing name. */
  PREPARE: "costing.prepare",

  /* ── THE COMMERCIAL REVIEW, IN THREE SEPARATE AUTHORITIES ────────────
     Deciding a price is not one job. Asking for a decision, taking an
     ordinary one, and waiving the company's own floor are three, held by
     three different people — so they are three capabilities and never a
     rank test on one of them.

     None implies `cost.read` or `margin.read`. A person may decide whether a
     PRICE may be quoted without being shown what the garment costs, what the
     Board marks it up by, or what a supplier charges — and that separation
     is the whole reason these are not `costing.approve`, which was written
     for the internal Costing workspace and is held by administrators. */

  /* Ask for a prepared estimate to be reviewed commercially. A request, not
     a decision: it commits the company to nothing and changes no price. */
  COMMERCIAL_SUBMIT: "costing.commercial.submit",

  /* Take the ORDINARY decision — approve or return a proposal that is at or
     above the company's own floor. Deliberately cannot clear a below-floor
     price: that is a different decision with a different owner, and letting
     one capability do both would make the floor advisory. */
  COMMERCIAL_APPROVE: "costing.commercial.approve",

  /* Waive the floor. The one authority that may approve a price BELOW what
     management said the company sells at, and only with a stated reason.
     Held by the executive authority, not by whoever happens to run Sales. */
  COMMERCIAL_EXCEPTION: "costing.commercial.exception",
});

const ALL = Object.freeze(Object.values(CAPABILITIES));

const C = CAPABILITIES;

/* Platform administrators and the CEO authority hold everything. That is the
   conservative default the chunk names, and it is conservative because it
   keeps the set of people who can see margin as small as it already is
   (crmCostVisibility grants cost to exactly `admin` and `ceo` today). */
const ADMIN_SET = Object.freeze([...ALL]);

/**
 * Grant → capabilities, by department slug and ranked role.
 *
 * `sales` carries the approved commercial output at every rank, and from
 * `editor` upward the right to ASK for an estimate. A Sales grant deliberately
 * does NOT carry cost, supplier prices, margin, draft access, approval or
 * policy — reading a costing they may quote from is not the same authority as
 * seeing what it is built from, and today's Sales screens already work on
 * exactly that basis (services/crmCostVisibility.js rule 1: "Sales does not
 * see cost").
 *
 * ── WHY `viewer` STOPS AT READING ──────────────────────────────────────────
 * Preparing an estimate is a WRITE: it can bring a costing and a frozen
 * version into existence, and every one of those is a durable company record
 * somebody may later be asked about. `viewer` is the rank this system gives to
 * people who need to see the work without being answerable for it, and the
 * ranked resolution below means an unnamed rank falls to the highest rank at
 * or below it — so leaving `viewer` at output-only is what keeps a junior or
 * read-only Sales grant from silently acquiring a write.
 *
 * `ceo` is the existing board-level authority and holds everything, which is
 * where the platform administrator and CEO already sit.
 *
 * Every other slug is ABSENT ON PURPOSE, not forgotten. See the header.
 */
const GRANTS = Object.freeze({
  sales: {
    viewer: [C.OUTPUT_READ],
    /* An editor prepares and asks for a decision; they do not take one. */
    editor: [C.OUTPUT_READ, C.PREPARE, C.COMMERCIAL_SUBMIT],
    /* ── AND THE APPROVER DECIDES, WITHIN THE FLOOR ──────────────────
       Approve or return a proposal at or above the floor. NOT
       `COMMERCIAL_EXCEPTION`: waiving the company's own floor is an
       executive act, and a Sales approver who could do it would make the
       floor a suggestion enforced by nobody. */
    approver: [C.OUTPUT_READ, C.PREPARE, C.COMMERCIAL_SUBMIT, C.COMMERCIAL_APPROVE],
    owner: [C.OUTPUT_READ, C.PREPARE, C.COMMERCIAL_SUBMIT, C.COMMERCIAL_APPROVE],
  },
  ceo: {
    viewer: [...ADMIN_SET],
    editor: [...ADMIN_SET],
    approver: [...ADMIN_SET],
    owner: [...ADMIN_SET],
  },
});

const RANK = { viewer: 10, editor: 20, approver: 30, owner: 40 };

/**
 * The pure half: grant rows in, capability names out.
 *
 * Separated from the database lookup so the mapping can be tested without a
 * connection, a token or a request — an access rule that can only be exercised
 * through a route is an access rule nobody checks.
 *
 * @param {{departmentSlug:string, role:string}[]} rows
 * @param {boolean} isAdmin  platform administrator, resolved authoritatively
 * @returns {{capabilities:string[], via:string[]}}
 */
function capabilitiesFromGrants(rows = [], isAdmin = false) {
  const granted = new Set();
  const via = [];

  if (isAdmin) {
    via.push("admin");
    for (const c of ADMIN_SET) granted.add(c);
  }

  for (const row of rows) {
    const slug = String(row?.departmentSlug || "").toLowerCase().trim();
    const table = GRANTS[slug];
    if (!table) continue;
    const role = String(row?.role || "").toLowerCase().trim();
    /* Ranked, so a role the table does not name explicitly still resolves to
       the highest rank at or below it rather than to nothing. */
    const roleKey = table[role]
      ? role
      : Object.keys(table)
          .filter((k) => RANK[k] <= (RANK[role] || 0))
          .sort((a, b) => RANK[b] - RANK[a])[0];
    if (!roleKey) continue;
    via.push(`${slug}:${role}`);
    for (const c of table[roleKey]) granted.add(c);
  }

  return { capabilities: applyImplications(granted), via: via.sort() };
}

/**
 * Capabilities that follow from other capabilities.
 *
 * ── THE ONE IMPLICATION, AND WHY IT IS HERE AND NOT IN A COMPONENT ──────────
 * `costing.draft.write` implies `costing.cost.read`. A person cannot
 * professionally edit a costing while being unable to read the inputs they are
 * editing: they would be typing a fabric rate into a form that then refuses to
 * show them what the fabric rate is, and re-costing would mean retyping every
 * line from memory. Chunk 1 kept them strictly separate and recorded the
 * question as open; this closes it.
 *
 * It is resolved HERE, once, rather than in whichever screen noticed the
 * problem — a frontend that grants itself a capability is a frontend that has
 * stopped agreeing with the server, and the server would still strip the block
 * from the payload.
 *
 * ── AND IT IMPLIES NOTHING ELSE ────────────────────────────────────────────
 * Not margin, not approval, not policy. Being able to build a costing is not
 * the same authority as knowing what the company adds on top of it, deciding
 * that a costing is approved, or setting the floor everyone else is measured
 * against. Those remain separate grants, and the tests say so.
 *
 * ── AND `costing.prepare` IMPLIES NOTHING IN EITHER DIRECTION ──────────────
 * It does not grant cost, margin, draft write, approval or policy, and none of
 * those grants it. A holder can start a calculation and then be shown almost
 * none of its result; a person who maintains costings is not thereby somebody
 * Sales has authorised to quote from this enquiry. Adding either implication
 * here would quietly hand Sales the internal build-up, which is the exact
 * outcome this capability was introduced to avoid.
 */
function applyImplications(granted) {
  const out = new Set(granted);
  if (out.has(C.DRAFT_WRITE)) out.add(C.COST_READ);
  return [...out].sort();
}

/**
 * Resolve one actor's costing capabilities.
 *
 * Reads the database every time rather than trusting the token: a grant
 * removed five minutes ago must not survive in a seven-day JWT. Same decision
 * `services/access/fulfilmentAccess.js` documents for the admin flag.
 *
 * @returns {Promise<{capabilities:string[], via:string[], isAdmin:boolean}>}
 */
async function resolveCapabilities({ email, employeeRef, biometricId } = {}) {
  const normalisedEmail = email ? String(email).toLowerCase().trim() : "";

  /* Platform administrator — authoritative and re-read, never from a token. */
  const adminOr = [];
  if (normalisedEmail) adminOr.push({ email: normalisedEmail });
  if (employeeRef) adminOr.push({ employeeRef });
  if (biometricId) adminOr.push({ employeeId: biometricId });

  let isAdmin = false;
  if (adminOr.length) {
    const admin = await DeptUser.findOne({ isAdmin: true, isActive: true, $or: adminOr })
      .select("_id")
      .lean()
      .catch(() => null);
    isAdmin = Boolean(admin);
  }

  let rows = [];
  if (normalisedEmail) {
    rows = await DepartmentRole.find({
      email: normalisedEmail,
      isActive: true,
      departmentSlug: { $in: Object.keys(GRANTS) },
    })
      .select("departmentSlug role")
      .lean()
      .catch(() => []);
  }

  const { capabilities, via } = capabilitiesFromGrants(rows, isAdmin);
  return { capabilities, via, isAdmin };
}

/** Does this capability set include every one of `required`? */
const hasAll = (capabilities, required) => {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  return (Array.isArray(required) ? required : [required]).every((c) => set.has(c));
};

/** Does it include at least one of `any`? */
const hasAny = (capabilities, any) => {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  return (Array.isArray(any) ? any : [any]).some((c) => set.has(c));
};

module.exports = {
  CAPABILITIES, ALL, GRANTS, ADMIN_SET,
  capabilitiesFromGrants, applyImplications, resolveCapabilities, hasAll, hasAny,
};
