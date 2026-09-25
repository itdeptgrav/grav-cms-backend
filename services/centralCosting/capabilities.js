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
 * `sales` is the one department mapped, and it is mapped to ONE capability:
 * the approved commercial output. A Sales grant deliberately does NOT carry
 * cost, supplier prices, margin, draft access or policy — reading a costing
 * they may quote from is not the same authority as seeing what it is built
 * from, and today's Sales screens already work on exactly that basis
 * (services/crmCostVisibility.js rule 1: "Sales does not see cost").
 *
 * `ceo` is the existing board-level authority and holds everything.
 *
 * Every other slug is ABSENT ON PURPOSE, not forgotten. See the header.
 */
const GRANTS = Object.freeze({
  sales: {
    viewer: [C.OUTPUT_READ],
    editor: [C.OUTPUT_READ],
    approver: [C.OUTPUT_READ],
    owner: [C.OUTPUT_READ],
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

  return { capabilities: [...granted].sort(), via: via.sort() };
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
  capabilitiesFromGrants, resolveCapabilities, hasAll, hasAny,
};
