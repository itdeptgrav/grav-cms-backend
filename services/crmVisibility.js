// services/crmVisibility.js
//
// Server-side protection for restricted commercial fields. The spec is explicit
// that credit information must be enforced on the SERVER, not merely hidden in
// the UI, and must not leak through list endpoints, exports, or payloads. So
// every account leaving a route is passed through stripRestrictedAccountFields,
// and edits to those fields by an unauthorized caller are dropped in the route.
//
// The CRM auth (SalesAuthMiddlewear) admits roles sales | admin | ceo |
// project_manager. Credit/finance data is limited to admin and ceo here; the
// department "approver"/"owner" role (from the write-guard system) also
// qualifies when present on req.user.

"use strict";

// Fields that only finance/commercial-authorized users may see or edit.
// Top-level names, or "a.b" dot-paths for nested fields (currently just the
// Garment Sales Profile's commission reference — the spec calls out
// commission arrangements as permission-controlled alongside credit/tax).
const RESTRICTED_ACCOUNT_FIELDS = [
  "creditLimit",
  "creditStatus",
  "taxRegistrationNumber",
  "garmentSalesProfile.defaultCommissionRef",
];

const CREDIT_AUTHORIZED_ROLES = new Set(["admin", "ceo"]);
const DEPT_AUTHORIZED_ROLES = new Set(["approver", "owner"]);

/**
 * May this caller see/edit restricted commercial fields?
 * Accepts the shape SalesAuthMiddlewear puts on req.user, plus an optional
 * departmentRole the write-guard may have resolved.
 */
function canViewCredit(user = {}) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  if (CREDIT_AUTHORIZED_ROLES.has(user.role)) return true;
  if (user.departmentRole && DEPT_AUTHORIZED_ROLES.has(user.departmentRole)) return true;
  return false;
}

/** Delete a possibly-nested "a.b" path from a plain object, in place. */
function deletePath(obj, path) {
  const parts = path.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor == null || typeof cursor !== "object") return;
    cursor = cursor[parts[i]];
  }
  if (cursor && typeof cursor === "object") delete cursor[parts[parts.length - 1]];
}

/**
 * Return a shallow-ish copy of an account object with restricted fields
 * removed, unless the caller is authorized. Never mutates the input. Safe on
 * a single doc; use stripRestrictedAccountList for arrays. Nested paths get
 * their immediate parent object copied too, so the source object's own
 * nested object is never mutated.
 */
function stripRestrictedAccountFields(account, user) {
  if (!account || canViewCredit(user)) return account;
  const clone = { ...account };
  if (clone.garmentSalesProfile) clone.garmentSalesProfile = { ...clone.garmentSalesProfile };
  for (const f of RESTRICTED_ACCOUNT_FIELDS) deletePath(clone, f);
  return clone;
}

const stripRestrictedAccountList = (accounts, user) =>
  Array.isArray(accounts) ? accounts.map((a) => stripRestrictedAccountFields(a, user)) : accounts;

/**
 * Remove restricted keys from an incoming update body when the caller may not
 * edit them — so an unauthorized PATCH silently no-ops on credit rather than
 * 500-ing or succeeding.
 */
function stripRestrictedUpdates(body, user) {
  if (!body || canViewCredit(user)) return body;
  const clone = { ...body };
  if (clone.garmentSalesProfile) clone.garmentSalesProfile = { ...clone.garmentSalesProfile };
  for (const f of RESTRICTED_ACCOUNT_FIELDS) deletePath(clone, f);
  return clone;
}

/**
 * A Sales Journey's expected/confirmed value is commercial information under
 * the same rule as credit: the server removes it, rather than the client
 * hiding it. A React-only gate still ships the number to the browser, where a
 * network tab or a saved HAR makes it plainly visible.
 *
 * Takes and returns a PLAIN object (call `.toObject()`/`.lean()` first), never
 * mutates the input, and is safe on a DTO that has no value at all.
 */
function stripJourneyCommercial(journey, user) {
  if (!journey || canViewCredit(user)) return journey;
  const { expectedValue, ...rest } = journey;
  return rest;
}

const stripJourneyCommercialList = (journeys, user) =>
  Array.isArray(journeys) ? journeys.map((j) => stripJourneyCommercial(j, user)) : journeys;

module.exports = {
  RESTRICTED_ACCOUNT_FIELDS,
  canViewCredit,
  stripRestrictedAccountFields,
  stripRestrictedAccountList,
  stripRestrictedUpdates,
  stripJourneyCommercial,
  stripJourneyCommercialList,
};
