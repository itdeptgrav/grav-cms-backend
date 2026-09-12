// lib/operators.js
//
// Resolving a scanned badge to a person's name.
//
// WHY THIS IS NOT A ONE-LINER
// An operator's badge can carry either of two ids and they are not the same
// string. RAKESH BISWAL is identityId "GR045" but his printed badge reads
// biometricId "GR0045" — a leading zero apart. The device sends whatever it
// read, so a lookup on identityId alone leaves those operators displayed as a
// raw code on every screen, which is exactly what happened on SNLS19.
//
// The CMS backend has always done this (`$or: [{identityId}, {biometricId}]`);
// this is the local equivalent, in one place so the rollup, the compat routes
// and the legacy status endpoint cannot drift apart on it.
//
// Note the map is keyed by BOTH ids pointing at the same name, rather than
// querying per operator: at 50 machines a per-miss findOne is dozens of round
// trips per request.

/**
 * Build id -> display-name lookup covering both badge forms.
 * @param {import('mongoose').Model} Employee
 * @returns {Promise<(id: string) => string>} falls back to the id itself
 */
async function buildOperatorNameResolver(Employee) {
  let employees = [];
  try {
    employees = await Employee.find(
      {},
      { identityId: 1, biometricId: 1, firstName: 1, lastName: 1 }
    ).lean();
  } catch {
    // No local employee data yet — every lookup falls back to the raw id,
    // which is still correct, just less readable.
    return (id) => id || "";
  }

  const byId = new Map();
  for (const e of employees) {
    const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
    if (!name) continue;
    // identityId wins where the two collide, since it is the CMS's own key.
    if (e.biometricId && !byId.has(e.biometricId)) byId.set(e.biometricId, name);
    if (e.identityId) byId.set(e.identityId, name);
  }

  return (id) => byId.get(id) || id || "";
}

/**
 * Was this badge recognised at all? Distinct from the name lookup because an
 * unrecognised operator still counts their pieces — it is surfaced on the
 * dashboard as "(not in CMS)", never silently dropped.
 */
async function buildKnownOperatorSet(Employee) {
  try {
    const employees = await Employee.find(
      {},
      { identityId: 1, biometricId: 1 }
    ).lean();
    const set = new Set();
    for (const e of employees) {
      if (e.identityId) set.add(e.identityId);
      if (e.biometricId) set.add(e.biometricId);
    }
    return set;
  } catch {
    return new Set();
  }
}

module.exports = { buildOperatorNameResolver, buildKnownOperatorSet };
