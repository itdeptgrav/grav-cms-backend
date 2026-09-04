// services/storePurchase/capabilities.js
//
// Store & Purchase — Chunk 1. WHAT A PERSON MAY DO, BY NAME.
//
// ── WHY CAPABILITY KEYS AND NOT ROLE TESTS ──────────────────────────────────
// Chunk 0 found the authorisation state of this domain exactly: every
// inventory router applies EmployeeAuth and nothing else. A valid token from
// any department can create a purchase order, receive stock against it and
// record a payment. The frontend's RoleGate defaults to OPEN, so it hides
// nothing from a user with no department role.
//
// Replacing that with `if (req.user.role === "store_manager")` scattered
// through twelve routers would be the same mistake in better clothing: the
// check would live in as many places as there are writes, and adding a route
// would mean remembering. A capability key is one name, granted in one table,
// asserted by one middleware.
//
// ── THE MAPPING IS CONSERVATIVE ON PURPOSE ──────────────────────────────────
// It is derived from what people can do TODAY, not from what a designed
// permission model would say. Anyone who can act now still can — with two
// deliberate exceptions, both of which are the point of the chunk:
//   · a user with NO store/ceo grant and no admin flag loses access they
//     technically had, because "authenticated" was never meant to be
//     "authorised";
//   · `sp.quality.accept` is granted to NOBODY, because no route performs
//     quality acceptance and inventing an actor for it would be inventing the
//     step.
//
// Built on the department-grant vocabulary that already exists
// (models/Access/DepartmentRole.js: viewer < editor < approver < owner) and
// resolved the way services/access/fulfilmentAccess.js already resolves it.
"use strict";

const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");

/** Every capability this domain knows. Frozen so a typo is a crash, not a
 *  silently-never-granted permission. */
const CAPABILITIES = Object.freeze({
  READ: "sp.read",
  REQUISITION_REVIEW: "sp.requisition.review",
  /* The Store's work ON a material request: matching a line to the catalogue,
     registering a new item for one, recording availability, deciding how it
     gets fulfilled and closing it as unfulfillable.
     
     A separate key because none of the existing ones fits. It is not stock
     movement (that is STOCK_ISSUE/STOCK_RETURN), not master maintenance (the
     item master is Chunk 2's), and not requisition review (a different
     document). Adding one honest key beats stretching a wrong one. */
  MRF_FULFIL: "sp.mrf.fulfil",
  SOURCING_MANAGE: "sp.sourcing.manage",
  PO_CREATE: "sp.po.create",
  PO_APPROVE: "sp.po.approve",
  PO_ISSUE: "sp.po.issue",
  PO_CANCEL: "sp.po.cancel",
  RECEIPT_RECORD: "sp.receipt.record",
  QUALITY_ACCEPT: "sp.quality.accept",
  STOCK_ISSUE: "sp.stock.issue",
  STOCK_RETURN: "sp.stock.return",
  STOCK_ADJUST: "sp.stock.adjust",
  MASTER_MAINTAIN: "sp.master.maintain",
  CONFIG_MANAGE: "sp.config.manage",
  LEGACY_READ: "sp.legacy.read",
  HISTORY_READ: "sp.history.read",
  POLICY_ADMIN: "sp.policy.admin",
});

const ALL = Object.freeze(Object.values(CAPABILITIES));

const C = CAPABILITIES;

/* Everything except quality acceptance, which no route performs. An
   administrator is not given an authority the business has not defined. */
const ADMIN_SET = ALL.filter((c) => c !== C.QUALITY_ACCEPT);

/**
 * Grant → capabilities, by department slug and ranked role.
 *
 * `store` is the slug the launcher, the shell guard and
 * services/access/fulfilmentAccess.js all already key on — Store & Purchase.
 * `ceo` is board level: it sees everything and decides nothing here, which is
 * why it reads (including legacy) and writes nothing.
 */
const GRANTS = {
  store: {
    viewer: [C.READ, C.HISTORY_READ],
    editor: [
      C.READ, C.HISTORY_READ, C.SOURCING_MANAGE, C.PO_CREATE,
      C.RECEIPT_RECORD, C.STOCK_ISSUE, C.STOCK_RETURN, C.MASTER_MAINTAIN,
      /* Fulfilling material requests is the Store editor's daily job. */
      C.MRF_FULFIL,
    ],
    approver: [
      C.READ, C.HISTORY_READ, C.SOURCING_MANAGE, C.PO_CREATE, C.PO_APPROVE,
      C.PO_ISSUE, C.PO_CANCEL, C.RECEIPT_RECORD, C.STOCK_ISSUE, C.STOCK_RETURN,
      C.STOCK_ADJUST, C.MASTER_MAINTAIN, C.REQUISITION_REVIEW, C.LEGACY_READ,
      C.MRF_FULFIL,
    ],
    owner: ADMIN_SET,
  },
  ceo: {
    viewer: [C.READ, C.HISTORY_READ, C.LEGACY_READ],
    editor: [C.READ, C.HISTORY_READ, C.LEGACY_READ],
    approver: [C.READ, C.HISTORY_READ, C.LEGACY_READ],
    owner: [C.READ, C.HISTORY_READ, C.LEGACY_READ],
  },
};

const RANK = { viewer: 10, editor: 20, approver: 30, owner: 40 };

/**
 * Resolve one actor's capabilities.
 *
 * Reads the database every time rather than trusting the token: a grant
 * removed five minutes ago must not survive in a seven-day JWT. This is the
 * same decision fulfilmentAccess.js documents for the admin flag.
 *
 * @returns {Promise<{capabilities: string[], via: string[], isAdmin: boolean}>}
 */
async function resolveCapabilities({ email, employeeRef, biometricId } = {}) {
  const granted = new Set();
  const via = [];

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
    if (admin) {
      isAdmin = true;
      via.push("admin");
      for (const c of ADMIN_SET) granted.add(c);
    }
  }

  /* Department grants. A person may hold more than one; capabilities union,
     because holding Store as an additional grant is still holding it — the
     bug fulfilmentAccess.js was written to avoid. */
  if (normalisedEmail) {
    const rows = await DepartmentRole.find({
      email: normalisedEmail,
      isActive: true,
      departmentSlug: { $in: Object.keys(GRANTS) },
    })
      .select("departmentSlug role")
      .lean()
      .catch(() => []);

    for (const row of rows) {
      const table = GRANTS[row.departmentSlug];
      if (!table) continue;
      /* Ranked, so a role the table does not name explicitly still resolves
         to the highest rank at or below it rather than to nothing. */
      const roleKey = table[row.role]
        ? row.role
        : Object.keys(table)
            .filter((k) => RANK[k] <= (RANK[row.role] || 0))
            .sort((a, b) => RANK[b] - RANK[a])[0];
      if (!roleKey) continue;
      via.push(`${row.departmentSlug}:${row.role}`);
      for (const c of table[roleKey]) granted.add(c);
    }
  }

  return { capabilities: [...granted].sort(), via: via.sort(), isAdmin };
}

/** Does this capability set include every one of `required`? */
const hasAll = (capabilities, required) => {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  return (Array.isArray(required) ? required : [required]).every((c) => set.has(c));
};

module.exports = { CAPABILITIES, ALL, GRANTS, ADMIN_SET, resolveCapabilities, hasAll };
